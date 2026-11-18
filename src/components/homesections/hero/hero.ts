import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { ApiClient } from 'jellyfin-apiclient';

import layoutManager from '../../layoutManager';
import { playbackManager } from '../../playback/playbackmanager';
import { appRouter } from '../../router/appRouter';
import { EventType } from '../../../constants/eventType';
import globalize from '../../../lib/globalize';
import { armTrailerBackdrop, DEFAULT_DELAY_MS, getTrailerVideoId, type TrailerBackdrop } from '../../liquidglass/trailerBackdrop';
import { isLiquidGlass, prefersReducedMotion } from '../../../themes/liquidglass/isLiquidGlass';
import Events from '../../../utils/events';

import {
    DAMPING_DEFAULT,
    SLIDE_GAP_PX,
    SPRING_RESPONSE_S,
    STRIDE_FRACTION,
    DragGesture,
    SpringAnimator,
    canLoop,
    constrainPosition,
    dampingForRelease,
    mod,
    pickSnapIndex,
    slideStyle,
    wrapDistance
} from './carouselPhysics';
import { formatRuntime, getImageWidth, getResumeTicks, renderDots, renderNav, renderSlide } from './heroMarkup';
import { selectHeroItems } from './selectHeroItems';

export { formatRuntime };

const AUTO_ADVANCE_MS = 8000;
const SOURCE_LIMIT = 5;
const BACKDROP_MAX_WIDTH = 1920;
const MOBILE_BACKDROP_MAX_WIDTH = 1280;
const FIRST_IMAGE_TIMEOUT_MS = 1500;
const IMAGE_TIMEOUT_MS = 2500;
/** Fired on every active-slide change; `detail` is null once the hero is removed. */
export const HERO_CHANGE_EVENT = 'lg:herochange';
/** Card width assumed when layout is not measurable. */
const FALLBACK_SLIDE_WIDTH_PX = 800;
const HERO_FIELDS = 'Overview,Genres,ProductionYear,RunTimeTicks,OfficialRating,CommunityRating,'
    + 'ParentBackdropImageTags,ParentBackdropItemId,ParentLogoImageTag,ParentLogoItemId,'
    + 'MediaSources,HasSubtitles,CriticRating,ProviderIds,RemoteTrailers';

export interface HeroController {
    destroy: () => void;
}

const controllers = new WeakMap<HTMLElement, Hero>();
const generations = new WeakMap<HTMLElement, number>();

/** Run one source fetch; a failing source is skipped so the hero and the rest of home keep working. */
async function fetchSource(request: () => Promise<BaseItemDto[] | undefined>): Promise<BaseItemDto[]> {
    try {
        return (await request()) ?? [];
    } catch {
        // Degrade silently: this source simply contributes no hero items.
        return [];
    }
}

export async function fetchHeroItems(apiClient: ApiClient): Promise<BaseItemDto[]> {
    const userId = apiClient.getCurrentUserId();
    const common = {
        Limit: SOURCE_LIMIT,
        Fields: HERO_FIELDS,
        ImageTypeLimit: 1,
        EnableImageTypes: 'Primary,Backdrop,Logo',
        EnableTotalRecordCount: false
    };

    const [ resume, nextUp, latest ] = await Promise.all([
        fetchSource(async () => (await apiClient.getResumableItems(userId, { ...common, Recursive: true, MediaTypes: 'Video' })).Items),
        fetchSource(async () => (await apiClient.getNextUpEpisodes({ ...common, UserId: userId })).Items),
        fetchSource(() => apiClient.getLatestItems({ ...common, IncludeItemTypes: 'Movie,Series' }))
    ]);

    return selectHeroItems(resume, nextUp, latest);
}

export function getBackdropUrl(apiClient: ApiClient, item: BaseItemDto): string | undefined {
    const options = { type: 'Backdrop', maxWidth: getImageWidth(layoutManager.mobile ? MOBILE_BACKDROP_MAX_WIDTH : BACKDROP_MAX_WIDTH), quality: 80 };
    if (item.BackdropImageTags?.length && item.Id) {
        return apiClient.getScaledImageUrl(item.Id, { ...options, tag: item.BackdropImageTags[0] });
    }
    if (item.ParentBackdropImageTags?.length && item.ParentBackdropItemId) {
        return apiClient.getScaledImageUrl(item.ParentBackdropItemId, { ...options, tag: item.ParentBackdropImageTags[0] });
    }
    return undefined;
}

interface ShowOptions {
    /** Skip waiting for the backdrop: the card is already on screen (drag release). */
    immediate?: boolean;
    /** A person asked for this change: announce it politely to assistive tech. */
    user?: boolean;
    /** Release velocity handed to the spring, in slides per second. */
    velocity?: number;
    damping?: number;
}

export interface HeroChangeDetail {
    itemId: string | undefined;
    backdropUrl: string | undefined;
}

class Hero implements HeroController {
    private readonly root: HTMLElement;
    private readonly track: HTMLElement;
    private readonly slides: HTMLElement[];
    private readonly contents: HTMLElement[];
    // The committed slide: `anchor` is its unwrapped position (so the spring takes the short way round), `current` its index.
    private current = 0;
    private anchor = 0;
    // Live on-screen position in slide units, unwrapped. Every card's transform derives from this one value.
    private pos = 0;
    private readonly animator = new SpringAnimator(value => this.onSpringUpdate(value), target => this.settle(target));
    private crossfade = false;
    private drag: DragGesture | undefined;
    private dragging = false;
    private suppressClick = false;
    private timer: ReturnType<typeof setInterval> | undefined;
    private hovered = false;
    private focused = false;
    private destroyed = false;
    private paused = false;
    private showToken = 0;
    private hasShown = false;
    private readonly pendingWaits = new Set<() => void>();
    private trailer: TrailerBackdrop | undefined;
    // True from the moment a trailer is about to load until it stops: holds auto-advance so a failed load can resume.
    private trailerHolding = false;
    // Bumped whenever the trailer is cancelled, so a late onPlaying/onStop from an old trailer is ignored.
    private trailerToken = 0;

    constructor(
        private readonly apiClient: ApiClient,
        private readonly items: BaseItemDto[]
    ) {
        this.root = document.createElement('section');
        this.root.className = 'lg-hero lg-hero--pending';
        this.root.setAttribute('aria-roledescription', 'carousel');
        this.root.setAttribute('aria-label', globalize.translate('Home'));
        this.root.style.setProperty('--lg-hero-interval', `${AUTO_ADVANCE_MS}ms`);
        const slides = items.map((item, i) => renderSlide(apiClient, item, i, items.length)).join('');
        this.root.innerHTML = `<div class="lg-hero__viewport"><div class="lg-hero__track" aria-live="off">${slides}</div>${renderNav(items.length)}</div>${renderDots(items.length)}`;
        this.track = this.root.querySelector<HTMLElement>('.lg-hero__track') as HTMLElement;
        this.slides = Array.from(this.root.querySelectorAll<HTMLElement>('.lg-hero__slide'));
        this.contents = this.slides.map(slide => slide.querySelector<HTMLElement>('.lg-hero__content') as HTMLElement);
    }

    setPaused(paused: boolean): void {
        this.paused = paused;
        this.updateTimer();
        // A trailer must not keep playing while the home view is hidden; it is armed again on resume.
        if (paused) this.cancelTrailer();
        else this.armTrailer();
    }

    get element(): HTMLElement {
        return this.root;
    }

    start(): void {
        this.root.addEventListener('click', this.onClick);
        this.root.addEventListener('keydown', this.onKeyDown);
        this.root.addEventListener('mouseenter', this.onEnter);
        this.root.addEventListener('mouseleave', this.onLeave);
        this.root.addEventListener('focusin', this.onFocusIn);
        this.root.addEventListener('focusout', this.onFocusOut);
        if (this.slides.length > 1) {
            this.track.addEventListener('pointerdown', this.onPointerDown);
            this.track.addEventListener('pointermove', this.onPointerMove);
            this.track.addEventListener('pointerup', this.onPointerUp);
            this.track.addEventListener('pointercancel', this.onPointerCancel);
        }
        document.addEventListener('visibilitychange', this.updateTimer);
        Events.on(document, EventType.THEME_CHANGE, this.onThemeChange);
        Events.on(playbackManager, 'playbackstart', this.onPlaybackStart);
        this.syncMotionMode();
        this.render();
        this.markAutofocus();
        void this.show(() => 0);
    }

    destroy = (): void => {
        if (this.destroyed) return;
        this.destroyed = true;
        this.stopTimer();
        this.animator.stop();
        this.cancelTrailer();
        Events.off(playbackManager, 'playbackstart', this.onPlaybackStart);
        // Release every pending image wait (clears its timer and listeners).
        for (const finish of [...this.pendingWaits]) finish();
        this.root.removeEventListener('click', this.onClick);
        this.root.removeEventListener('keydown', this.onKeyDown);
        this.root.removeEventListener('mouseenter', this.onEnter);
        this.root.removeEventListener('mouseleave', this.onLeave);
        this.root.removeEventListener('focusin', this.onFocusIn);
        this.root.removeEventListener('focusout', this.onFocusOut);
        this.track.removeEventListener('pointerdown', this.onPointerDown);
        this.track.removeEventListener('pointermove', this.onPointerMove);
        this.track.removeEventListener('pointerup', this.onPointerUp);
        this.track.removeEventListener('pointercancel', this.onPointerCancel);
        document.removeEventListener('visibilitychange', this.updateTimer);
        Events.off(document, EventType.THEME_CHANGE, this.onThemeChange);
        this.root.remove();
        document.dispatchEvent(new CustomEvent<HeroChangeDetail | null>(HERO_CHANGE_EVENT, { detail: null }));
    };

    private loadImage(index: number): void {
        const img = this.slides[index]?.querySelector<HTMLImageElement>('.lg-hero__backdrop');
        const url = getBackdropUrl(this.apiClient, this.items[index]);
        if (img && url && !img.getAttribute('src')) img.src = url;
    }

    /**
     * Resolve once the slide's backdrop is decoded/loaded, failed (a broken image never blocks), or the
     * timeout passes, whichever comes first.
     */
    private waitForBackdrop(index: number, timeoutMs: number): Promise<void> {
        this.loadImage(index);
        const img = this.slides[index]?.querySelector<HTMLImageElement>('.lg-hero__backdrop');
        if (!img?.getAttribute('src')) return Promise.resolve();

        return new Promise<void>(resolve => {
            const finish = (): void => {
                if (!this.pendingWaits.delete(finish)) return;
                clearTimeout(timer);
                img.removeEventListener('load', finish);
                img.removeEventListener('error', finish);
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            this.pendingWaits.add(finish);

            if (typeof img.decode === 'function') {
                img.decode().then(finish, finish);
            } else if (img.complete && img.naturalWidth > 0) {
                finish();
            } else {
                img.addEventListener('load', finish);
                img.addEventListener('error', finish);
            }
        });
    }

    /**
     * Make the slide chosen by `plan` the active one. `plan` receives the current unwrapped anchor and is
     * evaluated after the backdrop wait, because the anchor can be re-based while the spring rests.
     */
    private async show(plan: (anchor: number) => number, options: ShowOptions = {}): Promise<void> {
        const count = this.slides.length;
        // A newer show() supersedes this one; stale awaits are ignored via the token.
        const token = ++this.showToken;
        this.stopTimer();
        this.cancelTrailer();
        // Polite while a person is navigating; silent while the carousel advances itself.
        this.track.setAttribute('aria-live', options.user ? 'polite' : 'off');
        // Freeze the progress dot while the next backdrop loads; updateTimer clears this once the slide is shown.
        this.root.classList.add('lg-hero--paused');
        if (!options.immediate) {
            const timeout = this.hasShown ? IMAGE_TIMEOUT_MS : FIRST_IMAGE_TIMEOUT_MS;
            await this.waitForBackdrop(mod(plan(this.anchor), count), timeout);
        }
        if (token !== this.showToken || this.destroyed) return;

        this.syncMotionMode();
        const target = canLoop(count) ? plan(this.anchor) : mod(plan(this.anchor), count);
        const previous = this.current;
        const firstShow = !this.hasShown;
        this.hasShown = true;
        this.root.classList.remove('lg-hero--pending');
        this.anchor = target;
        this.current = mod(target, count);
        this.preloadImages();
        this.applyActiveState();
        this.moveTo(target, options.velocity, options.damping);
        if (firstShow || this.current !== previous) this.dispatchChange();
        this.updateTimer();
        this.armTrailer();
        this.markAutofocus();
    }

    private step(delta: number, user = true): void {
        void this.show(anchor => anchor + delta, { user });
    }

    private goToIndex(index: number): void {
        const count = this.slides.length;
        void this.show(anchor => anchor + wrapDistance(index - mod(anchor, count), count), { user: true });
    }

    /** Backdrops are small and few; load them all so the peeking neighbours show artwork, not blanks. */
    private preloadImages(): void {
        for (let i = 0; i < this.slides.length; i += 1) this.loadImage(i);
    }

    private dispatchChange(): void {
        const item = this.items[this.current];
        const detail: HeroChangeDetail = { itemId: item?.Id, backdropUrl: item ? getBackdropUrl(this.apiClient, item) : undefined };
        document.dispatchEvent(new CustomEvent<HeroChangeDetail>(HERO_CHANGE_EVENT, { detail }));
    }

    /** Mark the centre card active and take every other card out of the accessibility tree, tab order and spatial navigation. */
    private applyActiveState(): void {
        const previous = this.slides.find(slide => slide.classList.contains('is-active'));
        // Focus inside a card that is about to become inert would be dropped by the browser; carry it over instead.
        const hadFocus = Boolean(previous?.contains(document.activeElement));

        this.slides.forEach((slide, i) => {
            const active = i === this.current;
            const content = this.contents[i];
            slide.classList.toggle('is-active', active);
            slide.setAttribute('aria-hidden', String(!active));
            // The copy and controls of a neighbour are inert; the card itself stays clickable to bring it to the centre.
            // `inert` is not supported on old TV browsers, so tabindex and the focusable class back it up.
            if (active) content.removeAttribute('inert');
            else content.setAttribute('inert', '');
            // focusManager's spatial-nav query matches any `.focusable` whatever its tabindex, so hidden controls drop the class too.
            content.querySelectorAll('button, a').forEach(control => {
                control.classList.toggle('focusable', active);
                if (active) control.removeAttribute('tabindex');
                else control.setAttribute('tabindex', '-1');
            });
        });
        this.root.querySelectorAll('.lg-hero__dot').forEach((dot, i) => {
            if (i === this.current) dot.setAttribute('aria-current', 'true');
            else dot.removeAttribute('aria-current');
        });

        const active = this.slides[this.current];
        if (hadFocus && previous !== active) {
            active?.querySelector<HTMLElement>('.lg-hero__btn--primary')?.focus({ preventScroll: true });
        }
    }

    // ----- Motion: one position value, a spring, and per-card visuals derived from it -----

    /** Reduced motion swaps sliding for a short cross-fade; the inline transforms are dropped. */
    private syncMotionMode(): void {
        const reduced = prefersReducedMotion();
        if (reduced === this.crossfade) return;
        this.crossfade = reduced;
        this.root.classList.toggle('lg-hero--crossfade', reduced);
        this.animator.stop();
        this.pos = this.anchor;
        if (reduced) this.clearInlineStyles();
        else this.render();
    }

    private clearInlineStyles(): void {
        this.slides.forEach((slide, i) => {
            slide.style.removeProperty('transform');
            slide.style.removeProperty('opacity');
            slide.style.removeProperty('z-index');
            slide.style.removeProperty('pointer-events');
            this.contents[i].style.removeProperty('opacity');
        });
    }

    /** Write every card's transform and opacity from the single position value. */
    private render(): void {
        if (this.crossfade) return;
        const count = this.slides.length;
        const loop = canLoop(count);
        this.slides.forEach((slide, i) => {
            const style = slideStyle(wrapDistance(i - this.pos, count, loop));
            slide.style.transform = style.transform;
            slide.style.opacity = style.opacity;
            slide.style.zIndex = style.zIndex;
            slide.style.pointerEvents = style.pointerEvents;
            if (style.contentOpacity === null) this.contents[i].style.removeProperty('opacity');
            else this.contents[i].style.opacity = style.contentOpacity;
        });
    }

    /**
     * Animate to `target` from the live on-screen value. Without a handed-over velocity the spring keeps
     * the velocity it already had, so re-targeting mid-flight does not hit a wall.
     */
    private moveTo(target: number, velocity?: number, damping = DAMPING_DEFAULT): void {
        const liveVelocity = this.animator.velocity;
        this.animator.stop();
        if (this.crossfade) {
            this.settle(target);
            return;
        }
        this.animator.start(this.pos, target, velocity ?? liveVelocity, { damping, response: SPRING_RESPONSE_S });
    }

    private onSpringUpdate(value: number): void {
        this.pos = value;
        this.render();
    }

    /** Land exactly on the target and re-base the unwrapped position so it never grows without bound. */
    private settle(target: number): void {
        const count = this.slides.length;
        const shift = canLoop(count) ? Math.floor(target / count) * count : 0;
        this.anchor = target - shift;
        this.pos = this.anchor;
        this.render();
    }

    // ----- Pointer: 1:1 drag with a hysteresis threshold, then a projected, velocity-carrying release -----

    private slideStride(): number {
        const width = this.slides[this.current]?.offsetWidth || FALLBACK_SLIDE_WIDTH_PX;
        return width * STRIDE_FRACTION + SLIDE_GAP_PX;
    }

    private readonly onPointerDown = (e: PointerEvent): void => {
        if (!e.isPrimary || e.button !== 0 || this.destroyed || this.drag?.isDragging) return;
        this.suppressClick = false;
        this.syncMotionMode();
        // Grab the card where it is on screen, even mid-flight.
        const interrupted = this.animator.running;
        this.animator.stop();
        this.drag = new DragGesture(e.pointerId, e.clientX, e.clientY, this.pos, this.slideStride(), interrupted);
    };

    private readonly onPointerMove = (e: PointerEvent): void => {
        const drag = this.drag;
        if (!drag || e.pointerId !== drag.pointerId) return;
        const update = drag.move(e.clientX, e.clientY, e.timeStamp, this.pos);
        if (update === 'pending') return;
        if (update === 'abandon') {
            // Vertical intent: leave the gesture to page scroll.
            this.drag = undefined;
            if (drag.interrupted) this.moveTo(this.anchor);
            return;
        }
        if (update === 'start') this.onDragStart(e.pointerId);
        this.pos = constrainPosition(drag.positionAt(e.clientX), drag.stride, this.slides.length);
        this.render();
    };

    private onDragStart(pointerId: number): void {
        if (typeof this.track.setPointerCapture === 'function') this.track.setPointerCapture(pointerId);
        this.dragging = true;
        this.root.classList.add('lg-hero--dragging');
        this.cancelTrailer();
        this.updateTimer();
    }

    private readonly onPointerUp = (e: PointerEvent): void => {
        this.endDrag(e, true);
    };

    private readonly onPointerCancel = (e: PointerEvent): void => {
        this.endDrag(e, false);
    };

    private endDrag(e: PointerEvent, withMomentum: boolean): void {
        const drag = this.drag;
        if (!drag || e.pointerId !== drag.pointerId) return;
        this.drag = undefined;
        if (!drag.isDragging) {
            // A plain press: if it caught a moving card, let that card carry on.
            if (drag.interrupted) this.moveTo(this.anchor);
            return;
        }

        if (typeof this.track.hasPointerCapture === 'function' && this.track.hasPointerCapture(e.pointerId)) {
            this.track.releasePointerCapture(e.pointerId);
        }
        this.dragging = false;
        this.root.classList.remove('lg-hero--dragging');
        // The click that follows a drag must not press a button or pick a neighbour.
        this.suppressClick = true;

        const velocity = withMomentum ? drag.releaseVelocity(e.timeStamp) : 0;
        const offsetPx = (this.anchor - this.pos) * drag.stride;
        const target = pickSnapIndex(this.anchor, offsetPx, velocity, drag.stride, this.slides.length);
        void this.show(() => target, {
            immediate: true,
            user: true,
            velocity: -velocity / drag.stride,
            damping: dampingForRelease(velocity)
        });
    }

    private readonly updateTimer = (): void => {
        this.stopTimer();
        const eligible = this.items.length > 1 && !prefersReducedMotion() && !this.destroyed;
        // document.hidden is universally available on supported browsers; the compat rule is over-strict here.
        // eslint-disable-next-line compat/compat
        const canRun = eligible && !document.hidden && !this.hovered && !this.focused && !this.paused && !this.trailerHolding && !this.dragging;
        if (canRun) {
            this.root.classList.remove('lg-hero--paused');
            // Removing and re-adding the class after a reflow restarts the CSS progress animation in step with the timer.
            this.root.classList.remove('lg-hero--running');
            // Reading layout forces the reflow that restarts the CSS animation.
            this.root.getBoundingClientRect();
            this.root.classList.add('lg-hero--running');
            this.timer = setInterval(() => {
                this.step(1, false);
            }, AUTO_ADVANCE_MS);
        } else if (eligible) {
            // Stopped by hover, focus, hidden page or pause: keep the progress dot where it is.
            this.root.classList.add('lg-hero--paused');
        } else {
            this.root.classList.remove('lg-hero--running', 'lg-hero--paused');
        }
    };

    private stopTimer(): void {
        if (this.timer !== undefined) clearInterval(this.timer);
        this.timer = undefined;
    }

    /** Arms the centre card's trailer, if the item has one. The card is the host, so its radius clips the overlay. */
    private armTrailer(): void {
        this.cancelTrailer();
        const item = this.items[this.current];
        const videoId = item ? getTrailerVideoId(item) : null;
        const host = this.slides[this.current];
        if (!videoId || !host || this.destroyed || this.paused || this.dragging || document.hidden) return;
        const token = this.trailerToken;
        this.trailer = armTrailerBackdrop({
            host,
            videoId,
            delayMs: DEFAULT_DELAY_MS,
            showMuteButton: true,
            onStart: () => this.onTrailerStart(token),
            onPlaying: () => this.onTrailerPlaying(token),
            onStop: () => this.onTrailerStop(token)
        });
    }

    private cancelTrailer(): void {
        this.trailerToken += 1;
        this.trailer?.cancel();
        this.trailer = undefined;
        this.trailerHolding = false;
        this.root.classList.remove('lg-hero--trailer');
    }

    private onTrailerStart(token: number): void {
        if (token !== this.trailerToken) return;
        this.trailerHolding = true;
        this.updateTimer();
    }

    private onTrailerPlaying(token: number): void {
        if (token !== this.trailerToken) return;
        this.root.classList.add('lg-hero--trailer');
    }

    private onTrailerStop(token: number): void {
        if (token !== this.trailerToken) return;
        this.trailerHolding = false;
        this.root.classList.remove('lg-hero--trailer');
        this.updateTimer();
    }

    private readonly onPlaybackStart = (): void => {
        this.cancelTrailer();
        this.updateTimer();
    };

    /** On TV, the active slide's Play button carries autofocus so focusManager.autoFocus lands on it. */
    private markAutofocus(): void {
        this.slides.forEach((slide, i) => {
            const primary = slide.querySelector<HTMLElement>('.lg-hero__btn--primary');
            if (!primary) return;
            if (layoutManager.tv && i === this.current) primary.setAttribute('autofocus', '');
            else primary.removeAttribute('autofocus');
        });
    }

    private readonly onEnter = (): void => {
        this.hovered = true;
        this.updateTimer();
    };

    private readonly onLeave = (): void => {
        this.hovered = false;
        this.updateTimer();
    };

    private readonly onFocusIn = (): void => {
        this.focused = true;
        this.updateTimer();
    };

    private readonly onFocusOut = (e: FocusEvent): void => {
        if (e.relatedTarget instanceof Node && this.root.contains(e.relatedTarget)) return;
        this.focused = false;
        this.updateTimer();
    };

    private readonly onThemeChange = (): void => {
        if (!isLiquidGlass()) this.destroy();
    };

    /** On TV the d-pad moves focus between Play, Info and Favorite first; only past the row's ends does it change slide. */
    private leavesToSpatialNav(target: HTMLElement | null, direction: number): boolean {
        if (!layoutManager.tv) return false;
        const button = target?.closest('.lg-hero__actions > button');
        if (!button) return false;
        return Boolean(direction < 0 ? button.previousElementSibling : button.nextElementSibling);
    }

    private readonly onKeyDown = (e: KeyboardEvent): void => {
        this.suppressClick = false;
        if (this.items.length < 2 || e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const direction = e.key === 'ArrowLeft' ? -1 : 1;
        if (this.leavesToSpatialNav(e.target as HTMLElement | null, direction)) return;
        e.preventDefault();
        this.step(direction);
    };

    private readonly onClick = (e: MouseEvent): void => {
        if (this.suppressClick) {
            this.suppressClick = false;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        const target = e.target as HTMLElement;
        const button = target.closest<HTMLElement>('[data-action]');
        if (!button) {
            // A peeking neighbour comes to the centre when tapped.
            const slide = target.closest<HTMLElement>('.lg-hero__slide');
            if (slide && !slide.classList.contains('is-active')) this.goToIndex(Number(slide.dataset.index));
            return;
        }
        const item = this.items[this.current];

        switch (button.dataset.action) {
            case 'prev':
                this.step(-1);
                break;
            case 'next':
                this.step(1);
                break;
            case 'goto':
                this.goToIndex(Number(button.dataset.index));
                break;
            case 'play':
                this.cancelTrailer();
                this.play(item);
                break;
            case 'info':
                this.cancelTrailer();
                appRouter.showItem(item);
                break;
            case 'favorite':
                void this.toggleFavorite(item, button);
                break;
            default: break;
        }
    };

    private play(item: BaseItemDto): void {
        if (!item.Id) return;
        playbackManager.play({
            ids: [item.Id],
            startPositionTicks: getResumeTicks(item),
            serverId: item.ServerId || this.apiClient.serverId()
        }).catch((error: unknown) => {
            console.error('[Hero] Playback failed to start', error);
        });
    }

    private async toggleFavorite(item: BaseItemDto, button: HTMLElement): Promise<void> {
        if (!item.Id) return;
        const next = !item.UserData?.IsFavorite;
        try {
            const data = await this.apiClient.updateFavoriteStatus(this.apiClient.getCurrentUserId(), item.Id, next);
            const isFavorite = Boolean(data?.IsFavorite ?? next);
            item.UserData = { ...item.UserData, IsFavorite: isFavorite } as BaseItemDto['UserData'];
            const label = globalize.translate(isFavorite ? 'Favorite' : 'AddToFavorites');
            button.setAttribute('aria-pressed', String(isFavorite));
            button.setAttribute('aria-label', label);
            button.setAttribute('title', label);
            const icon = button.querySelector('.material-icons');
            icon?.classList.toggle('favorite', isFavorite);
            icon?.classList.toggle('favorite_border', !isFavorite);
        } catch {
            // Leave the button state unchanged; the server rejected the toggle and the user can retry.
        }
    }
}

/** Remove the hero previously mounted into this container, if any. */
export function destroyHero(container: HTMLElement): void {
    generations.set(container, (generations.get(container) ?? 0) + 1);
    controllers.get(container)?.destroy();
    controllers.delete(container);
}

/** Stop auto-advance while the home view is paused (cached DOM). */
export function pauseHero(container: HTMLElement): void {
    controllers.get(container)?.setPaused(true);
}

export function resumeHero(container: HTMLElement): void {
    controllers.get(container)?.setPaused(false);
}

/**
 * Mount the home hero as the first child of `container`. Renders nothing when no item qualifies.
 * Never rejects: hero failure must not affect the home sections.
 */
export async function mountHero(container: HTMLElement, apiClient: ApiClient): Promise<void> {
    destroyHero(container);
    const generation = generations.get(container);
    let items: BaseItemDto[] = [];
    try {
        items = await fetchHeroItems(apiClient);
    } catch {
        // Hero is decorative; skip it on any unexpected failure.
        return;
    }
    // The container may have been torn down or the theme changed while fetching.
    // Newest mount wins: bail if another mount or destroy happened while fetching.
    if (generations.get(container) !== generation) return;
    if (!items.length || !container.isConnected || !isLiquidGlass()) return;

    const hero = new Hero(apiClient, items);
    container.insertAdjacentElement('afterbegin', hero.element);
    hero.start();
    controllers.set(container, hero);
}
