import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const play = vi.hoisted(() => vi.fn());
const showItem = vi.hoisted(() => vi.fn());
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
    prefersReducedMotion: () => false
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
