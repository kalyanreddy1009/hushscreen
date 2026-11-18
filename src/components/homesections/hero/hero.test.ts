import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const play = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
const showItem = vi.hoisted(() => vi.fn());
const motion = vi.hoisted(() => ({ reduced: false }));
const arm = vi.hoisted(() => vi.fn<(options: unknown) => { cancel: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; playing: boolean }>(() => ({ cancel: vi.fn(), destroy: vi.fn(), playing: false })));

vi.mock('../../playback/playbackmanager', () => ({ playbackManager: { play } }));
vi.mock('../../liquidglass/trailerBackdrop', async importOriginal => ({
    ...(await importOriginal<typeof import('../../liquidglass/trailerBackdrop')>()),
    armTrailerBackdrop: arm
}));
vi.mock('../../router/appRouter', () => ({ appRouter: { showItem } }));
vi.mock('../../layoutManager', () => ({ default: { tv: false, mobile: false } }));
vi.mock('../../mediainfo/mediainfo', () => ({
    getResolutionText: (s: { Width?: number }) => (s.Width && s.Width >= 3800 ? '4K' : null)
}));
vi.mock('../../../lib/globalize', () => ({ default: { translate: (key: string) => key } }));
vi.mock('../../../themes/liquidglass/isLiquidGlass', () => ({
    isLiquidGlass: () => true,
    prefersReducedMotion: () => motion.reduced
}));

import layoutManager from '../../layoutManager';
import Events from '../../../utils/events';
import { playbackManager } from '../../playback/playbackmanager';

import { destroyHero, mountHero, pauseHero } from './hero';

interface ArmOptions {
    host: HTMLElement;
    videoId: string;
    delayMs: number;
    showMuteButton: boolean;
    onStart: () => void;
    onPlaying: () => void;
    onStop: () => void;
}

function flush(): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, 0);
    });
}

function makeItem(id: string, extra: Partial<BaseItemDto> = {}): BaseItemDto {
    return { Id: id, Name: `Item ${id}`, BackdropImageTags: ['t'], ...extra };
}

function makeClient(latest: BaseItemDto[], resume: BaseItemDto[] = []) {
    return {
        getCurrentUserId: () => 'u',
        serverId: () => 's',
        getScaledImageUrl: (id: string) => `/img/${id}`,
        getResumableItems: vi.fn().mockResolvedValue({ Items: resume }),
        getNextUpEpisodes: vi.fn().mockResolvedValue({ Items: [] }),
        getLatestItems: vi.fn().mockResolvedValue(latest),
        updateFavoriteStatus: vi.fn().mockResolvedValue({ IsFavorite: true })
    } as never;
}

describe('hero', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(() => {
        destroyHero(container);
        container.remove();
        vi.useRealTimers();
        vi.clearAllMocks();
        motion.reduced = false;
    });

    it('renders nothing with zero items', async () => {
        await mountHero(container, makeClient([]));
        expect(container.querySelector('.lg-hero')).toBeNull();
    });

    it('escapes HTML in Name and Overview', async () => {
        const item = makeItem('a', { Name: '<img src=x onerror=alert(1)>', Overview: '<script>bad()</script>' });
        await mountHero(container, makeClient([item]));
        expect(container.querySelector('.lg-hero img[onerror]')).toBeNull();
        expect(container.querySelector('.lg-hero script')).toBeNull();
        expect(container.querySelector('.lg-hero__title')?.textContent).toBe('<img src=x onerror=alert(1)>');
    });

    it('renders a type/genres line and an info line with real data', async () => {
        const item = makeItem('m', {
            Type: 'Movie',
            Genres: ['Sci-Fi', 'Adventure', 'Drama'],
            ProductionYear: 2014,
            RunTimeTicks: 169 * 600000000,
            CommunityRating: 8.67,
            CriticRating: 73,
            OfficialRating: 'PG-13',
            ProviderIds: { Imdb: 'tt0816692' },
            MediaSources: [{ MediaStreams: [{ Type: 'Video', Width: 3840, Height: 2160, VideoRangeType: 'HDR10' }] }]
        } as Partial<BaseItemDto>);
        await mountHero(container, makeClient([item]));

        const meta = Array.from(container.querySelectorAll('.lg-hero__meta > span')).map(n => n.textContent);
        expect(meta).toEqual(['Movie', 'Sci-Fi', 'Adventure']);

        const info = container.querySelector('.lg-hero__info');
        expect(info?.textContent).toContain('2014');
        expect(info?.textContent).toContain('2h 49m');
        expect(info?.textContent).toContain('8.7');
        expect(info?.textContent).toContain('RT 73%');
        expect(info?.querySelector('.lg-badge--rating')?.textContent).toBe('PG-13');
        const badges = Array.from(info?.querySelectorAll('.lg-badge:not(.lg-badge--rating):not(.lg-badge--link)') ?? []).map(n => n.textContent);
        expect(badges).toEqual(['4K', 'HDR10']);
        expect(info?.querySelector('a.lg-badge--link')?.getAttribute('href')).toBe('https://www.imdb.com/title/tt0816692/');
    });

    it('omits the info line contents that have no data', async () => {
        await mountHero(container, makeClient([makeItem('bare')]));
        expect(container.querySelector('.lg-hero__info')?.children).toHaveLength(0);
        expect(container.querySelector('.lg-badge')).toBeNull();
    });

    it('requests the fields the info line needs', async () => {
        const client = makeClient([makeItem('a')]) as unknown as { getLatestItems: ReturnType<typeof vi.fn> };
        await mountHero(container, client as never);
        const fields = client.getLatestItems.mock.calls[0][0].Fields as string;
        for (const field of ['MediaSources', 'HasSubtitles', 'CriticRating', 'ProviderIds']) {
            expect(fields).toContain(field);
        }
        expect(client.getLatestItems.mock.calls[0][0].Limit).toBeLessThanOrEqual(5);
    });

    it('keeps hidden slides out of spatial navigation (no .focusable, tabindex -1)', async () => {
        // focusManager's candidate query includes every `.focusable`, regardless of tabindex. Hidden slides
        // sit at the same coordinates, so a stray `.focusable` there swallows remote left/right presses.
        vi.useFakeTimers();
        await mountHero(container, makeClient([], [ makeItem('one'), makeItem('two') ]));
        await vi.advanceTimersByTimeAsync(10000);
        const slides = Array.from(container.querySelectorAll<HTMLElement>('.lg-hero__slide'));
        const active = slides.filter(slide => slide.classList.contains('is-active'));
        const hidden = slides.filter(slide => !slide.classList.contains('is-active'));
        expect(active).toHaveLength(1);
        expect(hidden.length).toBeGreaterThan(0);
        for (const control of active[0].querySelectorAll('button')) {
            expect(control.classList.contains('focusable')).toBe(true);
            expect(control.hasAttribute('tabindex')).toBe(false);
        }
        for (const slide of hidden) {
            for (const control of slide.querySelectorAll('button, a')) {
                expect(control.classList.contains('focusable')).toBe(false);
                expect(control.getAttribute('tabindex')).toBe('-1');
            }
        }
    });

    it('exposes the auto-advance interval as --lg-hero-interval', async () => {
        await mountHero(container, makeClient([makeItem('a'), makeItem('b')]));
        const hero = container.querySelector<HTMLElement>('.lg-hero');
        expect(hero?.style.getPropertyValue('--lg-hero-interval')).toBe('8000ms');
    });

    it('marks the hero as running while auto-advance runs and stops on hover', async () => {
        vi.useFakeTimers();
        const mounted = mountHero(container, makeClient([makeItem('a'), makeItem('b')]));
        await vi.advanceTimersByTimeAsync(0);
        await mounted;
        // Let the first backdrop wait resolve (timeout), which starts auto-advance.
        await vi.advanceTimersByTimeAsync(1500);

        const hero = container.querySelector<HTMLElement>('.lg-hero');
        expect(hero?.classList.contains('lg-hero--running')).toBe(true);

        // Hover keeps the progress animation in place (paused) so the active dot does not snap to full.
        hero?.dispatchEvent(new Event('mouseenter'));
        expect(hero?.classList.contains('lg-hero--running')).toBe(true);
        expect(hero?.classList.contains('lg-hero--paused')).toBe(true);

        hero?.dispatchEvent(new Event('mouseleave'));
        expect(hero?.classList.contains('lg-hero--paused')).toBe(false);
        expect(hero?.classList.contains('lg-hero--running')).toBe(true);
    });

    it('plays resume items from the saved position', async () => {
        const item = makeItem('r', { RunTimeTicks: 1000, UserData: { PlaybackPositionTicks: 400 } });
        await mountHero(container, makeClient([], [item]));
        container.querySelector<HTMLElement>('[data-action="play"]')?.click();
        expect(play).toHaveBeenCalledWith({ ids: ['r'], startPositionTicks: 400, serverId: 's' });
    });

    it('updates aria-pressed when favoriting', async () => {
        await mountHero(container, makeClient([makeItem('f')]));
        const button = container.querySelector<HTMLElement>('[data-action="favorite"]');
        expect(button?.getAttribute('aria-pressed')).toBe('false');
        button?.click();
        await flush();
        expect(button?.getAttribute('aria-pressed')).toBe('true');
    });

    it('clears timers and removes the hero on destroy', async () => {
        vi.useFakeTimers();
        const client = makeClient([makeItem('a'), makeItem('b')]);
        const mounted = mountHero(container, client);
        await vi.advanceTimersByTimeAsync(0);
        await mounted;
        expect(container.querySelector('.lg-hero')).not.toBeNull();
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        destroyHero(container);
        expect(vi.getTimerCount()).toBe(0);
        expect(container.querySelector('.lg-hero')).toBeNull();
    });

    it('does not render a stale mount that finished after destroy', async () => {
        const pending = mountHero(container, makeClient([makeItem('a')]));
        destroyHero(container);
        await pending;
        expect(container.querySelector('.lg-hero')).toBeNull();
    });

    it('lets the newest overlapping mount win', async () => {
        const first = mountHero(container, makeClient([makeItem('old')]));
        const second = mountHero(container, makeClient([makeItem('new')]));
        await Promise.all([first, second]);
        const slides = container.querySelectorAll('.lg-hero__slide');
        expect(slides).toHaveLength(1);
        expect(slides[0].getAttribute('data-id')).toBe('new');
    });
});

describe('hero backdrop readiness', () => {
    interface Decode {
        resolve: () => void;
        reject: () => void;
    }

    let container: HTMLElement;
    let decodes: Map<string, Decode>;

    function registerDecode(src: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            decodes.set(src, { resolve, reject: () => reject(new Error('broken')) });
        });
    }

    function activeId(): string | null | undefined {
        return container.querySelector('.lg-hero__slide.is-active')?.getAttribute('data-id');
    }

    function click(selector: string): void {
        container.querySelector<HTMLElement>(selector)?.click();
    }

    async function mountReady(ids: string[]): Promise<void> {
        await mountHero(container, makeClient(ids.map(id => makeItem(id))));
        decodes.get(`/img/${ids[0]}`)?.resolve();
        await flush();
    }

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        decodes = new Map();
        Object.defineProperty(HTMLImageElement.prototype, 'decode', {
            configurable: true,
            value(this: HTMLImageElement) {
                return registerDecode(this.getAttribute('src') ?? '');
            }
        });
    });

    afterEach(() => {
        destroyHero(container);
        container.remove();
        Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('keeps the pending class until the first backdrop is ready', async () => {
        await mountHero(container, makeClient([makeItem('a')]));
        const hero = container.querySelector('.lg-hero');
        expect(hero?.classList.contains('lg-hero--pending')).toBe(true);

        decodes.get('/img/a')?.resolve();
        await flush();

        expect(hero?.classList.contains('lg-hero--pending')).toBe(false);
        expect(activeId()).toBe('a');
    });

    it('removes the pending class after the first-image timeout', async () => {
        vi.useFakeTimers();
        const mounted = mountHero(container, makeClient([makeItem('a')]));
        await vi.advanceTimersByTimeAsync(0);
        await mounted;
        await vi.advanceTimersByTimeAsync(1500);

        expect(container.querySelector('.lg-hero--pending')).toBeNull();
    });

    it('waits for the incoming backdrop to decode before switching', async () => {
        await mountReady(['a', 'b']);
        click('[data-action="next"]');
        await flush();
        expect(activeId()).toBe('a');

        decodes.get('/img/b')?.resolve();
        await flush();
        expect(activeId()).toBe('b');
    });

    it('shows the slide anyway after the timeout', async () => {
        vi.useFakeTimers();
        const mounted = mountHero(container, makeClient([makeItem('a'), makeItem('b')]));
        await vi.advanceTimersByTimeAsync(0);
        await mounted;
        decodes.get('/img/a')?.resolve();
        await vi.advanceTimersByTimeAsync(0);

        click('[data-action="next"]');
        await vi.advanceTimersByTimeAsync(2000);
        expect(activeId()).toBe('a');
        await vi.advanceTimersByTimeAsync(600);
        expect(activeId()).toBe('b');
    });

    it('treats a failed image as ready', async () => {
        await mountReady(['a', 'b']);
        click('[data-action="next"]');
        await flush();

        decodes.get('/img/b')?.reject();
        await flush();
        expect(activeId()).toBe('b');
    });

    it('ignores a stale show when a newer one was requested', async () => {
        await mountReady(['a', 'b', 'c']);
        click('[data-action="next"]');
        await flush();
        click('[data-action="goto"][data-index="2"]');
        await flush();

        decodes.get('/img/b')?.resolve();
        await flush();
        expect(activeId()).toBe('a');

        decodes.get('/img/c')?.resolve();
        await flush();
        expect(activeId()).toBe('c');
    });
});

describe('hero trailer and TV focus', () => {
    const TRAILER_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const VIDEO_ID = 'dQw4w9WgXcQ';
    const TRAILER_DELAY_MS = 7000;
    const AUTO_ADVANCE_MS = 8000;
    let container: HTMLElement;

    function trailerItem(id: string): BaseItemDto {
        return makeItem(id, { RemoteTrailers: [{ Url: TRAILER_URL }] });
    }

    function activeSlide(): HTMLElement {
        const slide = container.querySelector<HTMLElement>('.lg-hero__slide.is-active');
        if (!slide) throw new Error('no active slide');
        return slide;
    }

    function armOptions(index = 0): ArmOptions {
        const options = arm.mock.calls[index]?.[0] as ArmOptions | undefined;
        if (!options) throw new Error('armTrailerBackdrop was not called');
        return options;
    }

    function trailerAt(index = 0): { cancel: ReturnType<typeof vi.fn> } {
        const trailer = arm.mock.results[index]?.value;
        if (!trailer) throw new Error('no trailer was armed');
        return trailer;
    }

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        Object.defineProperty(HTMLImageElement.prototype, 'decode', {
            configurable: true,
            value: () => Promise.resolve()
        });
        layoutManager.tv = false;
    });

    afterEach(() => {
        destroyHero(container);
        container.remove();
        Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
        layoutManager.tv = false;
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('requests RemoteTrailers so a trailer can be found', async () => {
        const client = makeClient([makeItem('a')]) as unknown as { getLatestItems: ReturnType<typeof vi.fn> };
        await mountHero(container, client as never);
        expect(client.getLatestItems.mock.calls[0][0].Fields).toContain('RemoteTrailers');
    });

    it('arms a 7 second trailer on the active slide when the item has a YouTube trailer', async () => {
        await mountHero(container, makeClient([trailerItem('a')]));
        await flush();

        expect(arm).toHaveBeenCalledTimes(1);
        const options = armOptions();
        expect(options.host).toBe(activeSlide());
        expect(options.videoId).toBe(VIDEO_ID);
        expect(options.delayMs).toBe(TRAILER_DELAY_MS);
        expect(options.showMuteButton).toBe(true);
    });

    it('does not arm a trailer when the item has no YouTube trailer', async () => {
        await mountHero(container, makeClient([makeItem('a', { RemoteTrailers: [{ Url: 'https://vimeo.com/1' }] })]));
        await flush();

        expect(arm).not.toHaveBeenCalled();
    });

    it('cancels the trailer and arms the new slide when the slide changes', async () => {
        await mountHero(container, makeClient([trailerItem('a'), trailerItem('b')]));
        await flush();
        container.querySelector<HTMLElement>('[data-action="next"]')?.click();
        await flush();

        expect(trailerAt(0).cancel).toHaveBeenCalled();
        expect(arm).toHaveBeenCalledTimes(2);
        expect(armOptions(1).host).toBe(activeSlide());
    });

    it('holds auto-advance from the trailer start, marks the hero once it plays, and resumes when it stops', async () => {
        vi.useFakeTimers();
        const mounted = mountHero(container, makeClient([trailerItem('a'), makeItem('b')]));
        await vi.advanceTimersByTimeAsync(0);
        await mounted;
        await vi.advanceTimersByTimeAsync(0);
        expect(activeSlide().dataset.id).toBe('a');
        const hero = container.querySelector<HTMLElement>('.lg-hero');

        armOptions().onStart();
        await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS);
        expect(activeSlide().dataset.id).toBe('a');
        expect(hero?.classList.contains('lg-hero--paused')).toBe(true);
        expect(hero?.classList.contains('lg-hero--trailer')).toBe(false);

        armOptions().onPlaying();
        expect(hero?.classList.contains('lg-hero--trailer')).toBe(true);

        armOptions().onStop();
        expect(hero?.classList.contains('lg-hero--trailer')).toBe(false);
        await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS);
        expect(activeSlide().dataset.id).toBe('b');
    });

    it('resumes auto-advance when the trailer stops before it plays', async () => {
        vi.useFakeTimers();
        const mounted = mountHero(container, makeClient([trailerItem('a'), makeItem('b')]));
        await vi.advanceTimersByTimeAsync(0);
        await mounted;
        await vi.advanceTimersByTimeAsync(0);

        armOptions().onStart();
        armOptions().onStop();
        await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS);

        expect(activeSlide().dataset.id).toBe('b');
    });

    it('cancels the trailer before Play starts playback', async () => {
        await mountHero(container, makeClient([trailerItem('a')]));
        await flush();
        container.querySelector<HTMLElement>('[data-action="play"]')?.click();

        const cancelOrder = trailerAt().cancel.mock.invocationCallOrder[0];
        expect(cancelOrder).toBeLessThan(play.mock.invocationCallOrder[0]);
    });

    it('cancels the trailer before Info opens the item', async () => {
        await mountHero(container, makeClient([trailerItem('a')]));
        await flush();
        container.querySelector<HTMLElement>('[data-action="info"]')?.click();

        const cancelOrder = trailerAt().cancel.mock.invocationCallOrder[0];
        expect(cancelOrder).toBeLessThan(showItem.mock.invocationCallOrder[0]);
    });

    it('cancels the trailer when playback starts', async () => {
        await mountHero(container, makeClient([trailerItem('a')]));
        await flush();
        Events.trigger(playbackManager, 'playbackstart', []);

        expect(trailerAt().cancel).toHaveBeenCalled();
    });

    it('cancels the trailer when the hero is paused', async () => {
        await mountHero(container, makeClient([trailerItem('a')]));
        await flush();
        pauseHero(container);

        expect(trailerAt().cancel).toHaveBeenCalled();
    });

    it('cancels the trailer on destroy and stops listening for playback', async () => {
        await mountHero(container, makeClient([trailerItem('a')]));
        await flush();
        const offSpy = vi.spyOn(Events, 'off');
        destroyHero(container);

        expect(trailerAt().cancel).toHaveBeenCalled();
        expect(offSpy).toHaveBeenCalledWith(playbackManager, 'playbackstart', expect.any(Function));
    });

    it('marks only the active slide Play button autofocus on TV', async () => {
        layoutManager.tv = true;
        await mountHero(container, makeClient([makeItem('a'), makeItem('b')]));
        await flush();

        const primaries = Array.from(container.querySelectorAll<HTMLElement>('.lg-hero__btn--primary'));
        expect(primaries[0].hasAttribute('autofocus')).toBe(true);
        expect(primaries[1].hasAttribute('autofocus')).toBe(false);
        expect(activeSlide().querySelector('.lg-hero__btn--primary')).toBe(primaries[0]);
    });

    it('moves autofocus to the new active Play button when the slide changes on TV', async () => {
        layoutManager.tv = true;
        await mountHero(container, makeClient([makeItem('a'), makeItem('b')]));
        await flush();
        container.querySelector<HTMLElement>('[data-action="next"]')?.click();
        await flush();

        const primaries = Array.from(container.querySelectorAll<HTMLElement>('.lg-hero__btn--primary'));
        expect(primaries[0].hasAttribute('autofocus')).toBe(false);
        expect(primaries[1].hasAttribute('autofocus')).toBe(true);
    });

    it('sets no autofocus when not on TV', async () => {
        await mountHero(container, makeClient([makeItem('a'), makeItem('b')]));
        await flush();

        expect(container.querySelector('[autofocus]')).toBeNull();
    });
});

describe('hero carousel', () => {
    const SLIDE_WIDTH_PX = 800;
    const AUTO_ADVANCE_MS = 8000;
    const TRAILER_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    type Change = { itemId: string; backdropUrl: string } | null;
    let container: HTMLElement;
    let changes: Change[];

    const recordChange = (event: Event): void => {
        changes.push((event as CustomEvent<Change>).detail);
    };

    function slides(): HTMLElement[] {
        return Array.from(container.querySelectorAll<HTMLElement>('.lg-hero__slide'));
    }

    function activeId(): string | undefined {
        return container.querySelector<HTMLElement>('.lg-hero__slide.is-active')?.dataset.id;
    }

    function activeControl(action: string): HTMLElement {
        const control = container.querySelector<HTMLElement>(`.lg-hero__slide.is-active [data-action="${action}"]`);
        if (!control) throw new Error(`no active ${action} control`);
        return control;
    }

    function key(target: Element, name: string): void {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    }

    function clickAction(action: string, index?: number): void {
        const selector = index === undefined ? `[data-action="${action}"]` : `[data-action="${action}"][data-index="${index}"]`;
        container.querySelector<HTMLElement>(selector)?.click();
    }

    let clock = 0;
    function pointer(type: string, x: number, y: number, time: number): void {
        const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
        Object.defineProperty(event, 'pointerId', { value: 1 });
        Object.defineProperty(event, 'isPrimary', { value: true });
        Object.defineProperty(event, 'timeStamp', { value: time });
        container.querySelector('.lg-hero__track')?.dispatchEvent(event);
    }

    /** A press, eight moves 40ms apart (about 1.2k px/s for 400px), and a release while the pointer is still moving. */
    function swipe(fromX: number, toX: number, fromY = 0, toY = 0): void {
        const steps = 8;
        clock += 1000;
        pointer('pointerdown', fromX, fromY, clock);
        for (let i = 1; i <= steps; i += 1) {
            clock += 40;
            pointer('pointermove', fromX + ((toX - fromX) * i) / steps, fromY + ((toY - fromY) * i) / steps, clock);
        }
        pointer('pointerup', toX, toY, clock);
    }

    async function mountReady(ids: string[], extras: Array<Partial<BaseItemDto>> = []): Promise<void> {
        await mountHero(container, makeClient(ids.map((id, i) => makeItem(id, extras[i]))));
        await flush();
    }

    async function mountWithFakeTimers(ids: string[]): Promise<void> {
        vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame' ] });
        const mounted = mountHero(container, makeClient(ids.map(id => makeItem(id))));
        await vi.advanceTimersByTimeAsync(0);
        await mounted;
        await vi.advanceTimersByTimeAsync(1500);
    }

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        changes = [];
        document.addEventListener('lg:herochange', recordChange);
        Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: () => Promise.resolve() });
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => SLIDE_WIDTH_PX });
        layoutManager.tv = false;
    });

    afterEach(() => {
        destroyHero(container);
        container.remove();
        document.removeEventListener('lg:herochange', recordChange);
        Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
        Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
        motion.reduced = false;
        layoutManager.tv = false;
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    describe('lg:herochange', () => {
        it('fires on the first show with the item id and the backdrop URL the slide uses', async () => {
            await mountReady([ 'a', 'b' ]);

            expect(changes).toEqual([{ itemId: 'a', backdropUrl: '/img/a' }]);
            expect(container.querySelector('.lg-hero__slide.is-active .lg-hero__backdrop')?.getAttribute('src')).toBe('/img/a');
        });

        it('fires on every slide change, and not when the same slide is chosen again', async () => {
            await mountReady([ 'a', 'b', 'c' ]);
            clickAction('next');
            await flush();
            clickAction('goto', 1);
            await flush();
            clickAction('prev');
            await flush();

            expect(changes.map(change => change?.itemId)).toEqual([ 'a', 'b', 'a' ]);
        });

        it('fires with a null detail when the hero is removed, once', async () => {
            await mountReady([ 'a', 'b' ]);
            destroyHero(container);
            destroyHero(container);

            expect(changes).toHaveLength(2);
            expect(changes[1]).toBeNull();
        });
    });

    describe('keyboard and neighbours', () => {
        it('ArrowRight and ArrowLeft inside the hero change the slide, wrapping round', async () => {
            await mountReady([ 'a', 'b', 'c' ]);

            key(activeControl('play'), 'ArrowRight');
            await flush();
            expect(activeId()).toBe('b');

            key(activeControl('play'), 'ArrowLeft');
            await flush();
            expect(activeId()).toBe('a');

            key(activeControl('play'), 'ArrowLeft');
            await flush();
            expect(activeId()).toBe('c');
        });

        it('keeps keyboard focus in the hero when the focused slide changes', async () => {
            await mountReady([ 'a', 'b' ]);
            const playButton = activeControl('play');
            playButton.focus();
            key(playButton, 'ArrowRight');
            await flush();

            expect(activeId()).toBe('b');
            expect(document.activeElement).toBe(activeControl('play'));
        });

        it('on TV, arrows move between Play, Info and Favorite and only change slide past the row ends', async () => {
            layoutManager.tv = true;
            await mountReady([ 'a', 'b' ]);

            key(activeControl('play'), 'ArrowRight');
            await flush();
            expect(activeId()).toBe('a');

            key(activeControl('favorite'), 'ArrowRight');
            await flush();
            expect(activeId()).toBe('b');
        });

        it('brings a clicked neighbour to the centre', async () => {
            await mountReady([ 'a', 'b', 'c' ]);
            const neighbour = slides()[2];
            expect(neighbour.classList.contains('is-active')).toBe(false);
            neighbour.click();
            await flush();

            expect(activeId()).toBe('c');
        });

        it('makes neighbours aria-hidden with inert, unfocusable controls, and leaves the centre slide reachable', async () => {
            await mountReady([ 'a', 'b', 'c' ]);
            const [ centre, ...others ] = slides();

            expect(centre.getAttribute('aria-hidden')).toBe('false');
            expect(centre.querySelector('.lg-hero__content')?.hasAttribute('inert')).toBe(false);
            expect(others).toHaveLength(2);
            for (const neighbour of others) {
                expect(neighbour.getAttribute('aria-hidden')).toBe('true');
                expect(neighbour.querySelector('.lg-hero__content')?.hasAttribute('inert')).toBe(true);
                for (const control of neighbour.querySelectorAll('button, a')) {
                    expect(control.getAttribute('tabindex')).toBe('-1');
                    expect(control.classList.contains('focusable')).toBe(false);
                }
            }
        });

        it('labels the carousel, each slide, and marks the current dot', async () => {
            await mountReady([ 'a', 'b', 'c' ]);
            const hero = container.querySelector('.lg-hero');

            expect(hero?.getAttribute('aria-roledescription')).toBe('carousel');
            expect(slides().map(slide => slide.getAttribute('aria-label'))).toEqual([ '1 / 3', '2 / 3', '3 / 3' ]);
            expect(slides().every(slide => slide.getAttribute('role') === 'group' && slide.getAttribute('aria-roledescription') === 'slide')).toBe(true);
            const dots = Array.from(container.querySelectorAll('.lg-hero__dot'));
            expect(dots.map(dot => dot.getAttribute('aria-label'))).toEqual([ '1 / 3', '2 / 3', '3 / 3' ]);
            expect(dots.map(dot => dot.getAttribute('aria-current'))).toEqual([ 'true', null, null ]);
        });

        it('announces politely after a person navigates and stays silent on auto-advance', async () => {
            await mountWithFakeTimers([ 'a', 'b', 'c' ]);
            const track = container.querySelector('.lg-hero__track');
            expect(track?.getAttribute('aria-live')).toBe('off');

            await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS);
            expect(activeId()).toBe('b');
            expect(track?.getAttribute('aria-live')).toBe('off');

            clickAction('next');
            await vi.advanceTimersByTimeAsync(100);
            expect(track?.getAttribute('aria-live')).toBe('polite');
        });
    });

    describe('trailer', () => {
        const trailer = { RemoteTrailers: [{ Url: TRAILER_URL }] };

        it('is armed only on the centre slide, with that slide as host', async () => {
            await mountReady([ 'a', 'b', 'c' ], [ trailer, trailer, trailer ]);

            expect(arm).toHaveBeenCalledTimes(1);
            expect((arm.mock.calls[0][0] as ArmOptions).host).toBe(slides()[0]);
        });

        it('is cancelled on every slide change and re-armed on the new centre slide', async () => {
            await mountReady([ 'a', 'b' ], [ trailer, trailer ]);
            const first = arm.mock.results[0].value;
            clickAction('next');
            await flush();

            expect(first.cancel).toHaveBeenCalled();
            expect(arm).toHaveBeenCalledTimes(2);
            expect((arm.mock.calls[1][0] as ArmOptions).host).toBe(slides()[1]);
        });

        it('is cancelled when a drag starts, not before the threshold', async () => {
            await mountReady([ 'a', 'b', 'c' ], [ trailer, trailer, trailer ]);
            const first = arm.mock.results[0].value;
            clock += 1000;
            pointer('pointerdown', 400, 0, clock);
            pointer('pointermove', 395, 0, clock + 8);
            expect(first.cancel).not.toHaveBeenCalled();

            pointer('pointermove', 300, 0, clock + 16);
            expect(first.cancel).toHaveBeenCalled();
            expect(container.querySelector('.lg-hero--dragging')).not.toBeNull();
        });
    });

    describe('drag', () => {
        it('moves to the next slide after a quick leftward swipe, positioning every card from one value', async () => {
            await mountReady([ 'a', 'b', 'c' ]);
            swipe(700, 300);
            await flush();

            expect(activeId()).toBe('b');
            expect(container.querySelector('.lg-hero--dragging')).toBeNull();
            const transforms = slides().map(slide => slide.style.transform);
            expect(transforms.every(transform => transform.includes('translate3d'))).toBe(true);
            expect(new Set(transforms).size).toBe(3);
        });

        it('goes back after a rightward swipe, wrapping to the last slide', async () => {
            await mountReady([ 'a', 'b', 'c' ]);
            swipe(300, 700);
            await flush();

            expect(activeId()).toBe('c');
        });

        it('stays on the slide for a tiny movement and still lets the click through', async () => {
            await mountReady([ 'a', 'b' ]);
            swipe(500, 495);
            await flush();
            activeControl('play').click();

            expect(activeId()).toBe('a');
            expect(play).toHaveBeenCalledTimes(1);
        });

        it('leaves a mostly vertical gesture to page scroll', async () => {
            await mountReady([ 'a', 'b' ]);
            swipe(500, 440, 0, 200);
            await flush();

            expect(activeId()).toBe('a');
            expect(container.querySelector('.lg-hero--dragging')).toBeNull();
        });

        it('swallows the click that ends a drag', async () => {
            await mountReady([ 'a', 'b' ]);
            swipe(700, 300);
            await flush();
            container.querySelector<HTMLElement>('[data-action="play"]')?.click();

            expect(play).not.toHaveBeenCalled();
        });

        it('pauses auto-advance while dragging', async () => {
            await mountWithFakeTimers([ 'a', 'b', 'c' ]);
            pointer('pointerdown', 700, 0, 1);
            pointer('pointermove', 650, 0, 9);
            await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS * 2);

            expect(activeId()).toBe('a');
            expect(container.querySelector('.lg-hero')?.classList.contains('lg-hero--paused')).toBe(true);
        });

        it('lets the spring settle every card on a whole position', async () => {
            await mountWithFakeTimers([ 'a', 'b', 'c' ]);
            clickAction('next');
            await vi.advanceTimersByTimeAsync(3000);

            const [ first, second, third ] = slides();
            expect(second.style.transform).toBe('translate3d(-50%, 0, 0) translate3d(0px, 0, 0) scale(1)');
            expect(second.style.opacity).toBe('1');
            expect(first.style.transform).toContain('scale(0.86)');
            expect(first.style.opacity).toBe('0.5');
            expect(third.style.opacity).toBe('0.5');
        });
    });

    describe('reduced motion', () => {
        it('cross-fades with no inline transforms and no sliding', async () => {
            motion.reduced = true;
            await mountReady([ 'a', 'b', 'c' ]);

            expect(container.querySelector('.lg-hero')?.classList.contains('lg-hero--crossfade')).toBe(true);
            expect(slides().every(slide => slide.style.transform === '')).toBe(true);

            clickAction('next');
            await flush();
            expect(activeId()).toBe('b');
            expect(slides().every(slide => slide.style.transform === '' && slide.style.opacity === '')).toBe(true);
        });

        it('keeps auto-advance off', async () => {
            motion.reduced = true;
            await mountWithFakeTimers([ 'a', 'b' ]);
            await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS * 2);

            expect(activeId()).toBe('a');
        });

        it('treats a swipe as a plain slide change', async () => {
            motion.reduced = true;
            await mountReady([ 'a', 'b', 'c' ]);
            swipe(700, 300);
            await flush();

            expect(activeId()).toBe('b');
            expect(slides().every(slide => slide.style.transform === '')).toBe(true);
        });

        it('does not use the cross-fade class in normal mode', async () => {
            await mountReady([ 'a', 'b' ]);

            expect(container.querySelector('.lg-hero')?.classList.contains('lg-hero--crossfade')).toBe(false);
        });
    });
});
