import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import escapeHtml from 'escape-html';
import type { ApiClient } from 'jellyfin-apiclient';

import layoutManager from '../../layoutManager';
import { playbackManager } from '../../playback/playbackmanager';
import { appRouter } from '../../router/appRouter';
import { EventType } from '../../../constants/eventType';
import globalize from '../../../lib/globalize';
import { renderInfoBadgesHtml } from '../../liquidglass/qualityBadges';
import { armTrailerBackdrop, DEFAULT_DELAY_MS, getTrailerVideoId, type TrailerBackdrop } from '../../liquidglass/trailerBackdrop';
import { isLiquidGlass, prefersReducedMotion } from '../../../themes/liquidglass/isLiquidGlass';
import Events from '../../../utils/events';

import { selectHeroItems } from './selectHeroItems';

const AUTO_ADVANCE_MS = 8000;
const SOURCE_LIMIT = 5;
const BACKDROP_MAX_WIDTH = 1920;
const MOBILE_BACKDROP_MAX_WIDTH = 1280;
const LOGO_MAX_WIDTH = 600;
const FIRST_IMAGE_TIMEOUT_MS = 1500;
const IMAGE_TIMEOUT_MS = 2500;
const TICKS_PER_MINUTE = 600000000;
const MAX_GENRES = 2;
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

/**
 * Width to request. getScaledImageUrl multiplies by devicePixelRatio, so divide it out to keep the
 * final request at the cap (the server resizes on the fly and can be slow).
 */
function getImageWidth(cap: number): number {
    const ratio = window.devicePixelRatio || 1;
    return Math.floor(cap / ratio);
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

function getLogoUrl(apiClient: ApiClient, item: BaseItemDto): string | undefined {
    const options = { type: 'Logo', maxWidth: getImageWidth(LOGO_MAX_WIDTH), quality: 80 };
    if (item.ImageTags?.Logo && item.Id) {
        return apiClient.getScaledImageUrl(item.Id, { ...options, tag: item.ImageTags.Logo });
    }
    if (item.ParentLogoImageTag && item.ParentLogoItemId) {
        return apiClient.getScaledImageUrl(item.ParentLogoItemId, { ...options, tag: item.ParentLogoImageTag });
    }
    return undefined;
}

export function formatRuntime(ticks: number | null | undefined): string {
    const minutes = Math.round((ticks ?? 0) / TICKS_PER_MINUTE);
    if (minutes <= 0) return '';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest}m`;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function getResumeTicks(item: BaseItemDto): number {
    return item.UserData?.PlaybackPositionTicks ?? 0;
}

function getProgressPercent(item: BaseItemDto): number {
    const total = item.RunTimeTicks ?? 0;
    const position = getResumeTicks(item);
    if (!total || position <= 0) return 0;
    return Math.min(100, Math.max(0, (position / total) * 100));
}

const TYPE_KEYS: Record<string, string> = { Movie: 'Movie', Series: 'Series', Episode: 'Episode' };
const FRESH_CRITIC_RATING = 60;

/** Line one: type and genres ("Movie · Sci-Fi · Adventure"). */
function renderTypeLine(item: BaseItemDto): string {
    const typeKey = item.Type ? TYPE_KEYS[item.Type] : undefined;
    const parts = [
        typeKey ? globalize.translate(typeKey) : '',
        ...(item.Genres ?? []).slice(0, MAX_GENRES)
    ].filter(Boolean);
    return parts.map(part => `<span>${escapeHtml(part)}</span>`).join('');
}

/** Line two: year, runtime, ratings, then the official rating and quality badges. */
function renderInfoLine(item: BaseItemDto): string {
    const items: string[] = [];
    if (item.ProductionYear) items.push(escapeHtml(String(item.ProductionYear)));
    const runtime = formatRuntime(item.RunTimeTicks);
    if (runtime) items.push(escapeHtml(runtime));
    if (item.CommunityRating) {
        items.push(`<span class="lg-hero__star"><span aria-hidden="true">★</span> ${item.CommunityRating.toFixed(1)}</span>`);
    }
    if (item.CriticRating) {
        const state = item.CriticRating >= FRESH_CRITIC_RATING ? 'fresh' : 'rotten';
        items.push(`<span class="lg-hero__critic lg-hero__critic--${state}" title="Rotten Tomatoes">RT ${Math.round(item.CriticRating)}%</span>`);
    }

    const rating = item.OfficialRating ? `<span class="lg-badge lg-badge--rating">${escapeHtml(item.OfficialRating)}</span>` : '';
    const badges = rating + renderInfoBadgesHtml(item);

    return items.map(html => `<span class="lg-hero__info-item">${html}</span>`).join('')
        + (badges ? `<span class="lg-hero__info-item lg-hero__badges">${badges}</span>` : '');
}

function iconButton(action: string, icon: string, label: string, extraClass = '', extraAttrs = ''): string {
    const safe = escapeHtml(label);
    return `<button type="button" class="lg-hero__btn lg-hero__btn--circle focusable ${extraClass}" data-action="${action}" aria-label="${safe}" title="${safe}" ${extraAttrs}><span class="material-icons ${icon}" aria-hidden="true"></span></button>`;
}

function renderTitle(apiClient: ApiClient, item: BaseItemDto): string {
    const logoUrl = getLogoUrl(apiClient, item);
    const title = escapeHtml(item.SeriesName || item.Name || '');
    const heading = logoUrl ?
        `<img class="lg-hero__logo" src="${escapeHtml(logoUrl)}" alt="${title}" decoding="async">` :
        `<span class="lg-hero__title lg-type-display">${title}</span>`;
    const subtitle = item.SeriesName ? `<span class="lg-hero__subtitle">${escapeHtml(item.Name || '')}</span>` : '';
    return `<h2 class="lg-hero__heading">${heading}${subtitle}</h2>`;
}

function renderFavoriteButton(item: BaseItemDto): string {
    const isFavorite = Boolean(item.UserData?.IsFavorite);
    const label = globalize.translate(isFavorite ? 'Favorite' : 'AddToFavorites');
    const icon = isFavorite ? 'favorite' : 'favorite_border';
    return iconButton('favorite', icon, label, 'lg-hero__fav', `aria-pressed="${isFavorite}"`);
}

function renderSlide(apiClient: ApiClient, item: BaseItemDto, index: number): string {
    const progress = getProgressPercent(item);
    const isResume = progress > 0;
    const playLabel = escapeHtml(globalize.translate(isResume ? 'ButtonResume' : 'Play'));
    const infoLabel = escapeHtml(globalize.translate('ButtonInfo'));

    return `<section class="lg-hero__slide" data-index="${index}" data-id="${escapeHtml(item.Id || '')}">
    <img class="lg-hero__backdrop" alt="" decoding="async"${index === 0 ? ' fetchpriority="high"' : ''}>
    <div class="lg-hero__content">
        ${renderTitle(apiClient, item)}
        <div class="lg-hero__meta">${renderTypeLine(item)}</div>
        ${item.Overview ? `<p class="lg-hero__overview">${escapeHtml(item.Overview)}</p>` : ''}
        <div class="lg-hero__info">${renderInfoLine(item)}</div>
        ${isResume ? `<div class="lg-hero__progress" aria-hidden="true"><span style="width:${progress.toFixed(1)}%"></span></div>` : ''}
        <div class="lg-hero__actions">
            <button type="button" class="lg-hero__btn lg-hero__btn--primary focusable" data-action="play"><span class="material-icons play_arrow" aria-hidden="true"></span><span>${playLabel}</span></button>
            <button type="button" class="lg-hero__btn lg-hero__btn--info focusable" data-action="info">${infoLabel}</button>
            ${renderFavoriteButton(item)}
        </div>
    </div>
</section>`;
}

function renderControls(count: number): string {
    if (count < 2) return '';
    const dots = Array.from({ length: count }, (_, i) =>
        `<button type="button" class="lg-hero__dot focusable" data-action="goto" data-index="${i}" aria-label="${i + 1} / ${count}"><span></span></button>`
    ).join('');
    return `<div class="lg-hero__controls">
        ${iconButton('prev', 'chevron_left', globalize.translate('Previous'), 'lg-hero__nav lg-hero__nav--prev')}
        ${iconButton('next', 'chevron_right', globalize.translate('Next'), 'lg-hero__nav lg-hero__nav--next')}
        <div class="lg-hero__dots">${dots}</div>
    </div>`;
}

class Hero implements HeroController {
    private readonly root: HTMLElement;
    private readonly slides: HTMLElement[];
    private current = 0;
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
        this.root.innerHTML = `<div class="lg-hero__slides">${items.map((item, i) => renderSlide(apiClient, item, i)).join('')}</div>${renderControls(items.length)}`;
        this.slides = Array.from(this.root.querySelectorAll<HTMLElement>('.lg-hero__slide'));
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
        // TV uses spatial navigation; the focusable pager controls are enough there.
        if (!layoutManager.tv) this.root.addEventListener('keydown', this.onKeyDown);
        this.root.addEventListener('mouseenter', this.onEnter);
        this.root.addEventListener('mouseleave', this.onLeave);
        this.root.addEventListener('focusin', this.onFocusIn);
        this.root.addEventListener('focusout', this.onFocusOut);
        document.addEventListener('visibilitychange', this.updateTimer);
        Events.on(document, EventType.THEME_CHANGE, this.onThemeChange);
        Events.on(playbackManager, 'playbackstart', this.onPlaybackStart);
        this.markAutofocus();
        void this.show(0);
    }

    destroy = (): void => {
        if (this.destroyed) return;
        this.destroyed = true;
        this.stopTimer();
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
        document.removeEventListener('visibilitychange', this.updateTimer);
        Events.off(document, EventType.THEME_CHANGE, this.onThemeChange);
        this.root.remove();
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

    private async show(index: number): Promise<void> {
        const count = this.slides.length;
        const target = (index + count) % count;
        // A newer show() supersedes this one; stale awaits are ignored via the token.
        const token = ++this.showToken;
        this.stopTimer();
        this.cancelTrailer();
        // Freeze the progress dot while the next backdrop loads; updateTimer clears this once the slide is shown.
        this.root.classList.add('lg-hero--paused');
        await this.waitForBackdrop(target, this.hasShown ? IMAGE_TIMEOUT_MS : FIRST_IMAGE_TIMEOUT_MS);
        if (token !== this.showToken || this.destroyed) return;

        this.hasShown = true;
        this.root.classList.remove('lg-hero--pending');
        this.current = target;
        // Preload only the next backdrop so the crossfade never waits on the network.
        if (count > 1) this.loadImage((this.current + 1) % count);

        this.slides.forEach((slide, i) => {
            const active = i === this.current;
            slide.classList.toggle('is-active', active);
            slide.setAttribute('aria-hidden', String(!active));
            // Hidden slides must not hold tab stops or be reachable by remote focus. `inert` is not
            // supported on old TV browsers, so tabindex and CSS visibility back it up.
            if (active) slide.removeAttribute('inert');
            else slide.setAttribute('inert', '');
            // focusManager's spatial-nav query matches any `.focusable` whatever its tabindex, and hidden
            // slides overlap the active one, so their controls must drop the class too.
            slide.querySelectorAll('button, a').forEach(control => {
                control.classList.toggle('focusable', active);
                if (active) control.removeAttribute('tabindex');
                else control.setAttribute('tabindex', '-1');
            });
        });
        this.root.querySelectorAll('.lg-hero__dot').forEach((dot, i) => {
            if (i === this.current) dot.setAttribute('aria-current', 'true');
            else dot.removeAttribute('aria-current');
        });
        this.updateTimer();
        this.armTrailer();
        this.markAutofocus();
    }

    private readonly updateTimer = (): void => {
        this.stopTimer();
        const eligible = this.items.length > 1 && !prefersReducedMotion() && !this.destroyed;
        // document.hidden is universally available on supported browsers; the compat rule is over-strict here.
        // eslint-disable-next-line compat/compat
        const canRun = eligible && !document.hidden && !this.hovered && !this.focused && !this.paused && !this.trailerHolding;
        if (canRun) {
            this.root.classList.remove('lg-hero--paused');
            // Removing and re-adding the class after a reflow restarts the CSS progress animation in step with the timer.
            this.root.classList.remove('lg-hero--running');
            // Reading layout forces the reflow that restarts the CSS animation.
            this.root.getBoundingClientRect();
            this.root.classList.add('lg-hero--running');
            this.timer = setInterval(() => {
                void this.show(this.current + 1);
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

    /** Arms the active slide's trailer, if the item has one. It starts only after the user stays on the slide. */
    private armTrailer(): void {
        this.cancelTrailer();
        const item = this.items[this.current];
        const videoId = item ? getTrailerVideoId(item) : null;
        const host = this.slides[this.current];
        if (!videoId || !host || this.destroyed || this.paused || document.hidden) return;
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

    private readonly onKeyDown = (e: KeyboardEvent): void => {
        if (this.items.length < 2 || e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        // Only the pager and prev/next controls handle arrows; Play/Info/Favorite keep spatial navigation.
        const target = e.target as HTMLElement | null;
        if (!target?.closest('.lg-hero__dot, .lg-hero__nav')) return;
        e.preventDefault();
        void this.show(this.current + (e.key === 'ArrowLeft' ? -1 : 1));
    };

    private readonly onClick = (e: MouseEvent): void => {
        const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
        if (!button) return;
        const item = this.items[this.current];

        switch (button.dataset.action) {
            case 'prev':
                void this.show(this.current - 1);
                break;
            case 'next':
                void this.show(this.current + 1);
                break;
            case 'goto':
                void this.show(Number(button.dataset.index));
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
        void playbackManager.play({
            ids: [item.Id],
            startPositionTicks: getResumeTicks(item),
            serverId: item.ServerId || this.apiClient.serverId()
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
