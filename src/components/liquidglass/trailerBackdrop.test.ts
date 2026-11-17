import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('../../lib/globalize', () => ({
    default: {
        translate: (key: string) => key
    }
}));

type TrailerModule = typeof import('./trailerBackdrop');

const API_URL = 'https://www.youtube.com/iframe_api';
const VIDEO_ID = 'dQw4w9WgXcQ';
const DELAY_MS = 7000;
const silenceWarnings = (): undefined => undefined;
const FADE_OUT_MS = 1600;
const REVEAL_DELAY_MS = 3000;
const TRAILER_START_SECONDS = 10;
const STALL_FADE_MS = 2000;
const PLAYING_STATE = 1;
const ENDED_STATE = 0;
const BUFFERING_STATE = 3;
const PAUSED_STATE = 2;
const PLAYING_CLASS = 'lg-trailer--playing';
const MUTE_VISIBLE_CLASS = 'lg-trailer__mute--visible';
const API_READY_TIMEOUT_MS = 8000;
const START_TIMEOUT_MS = 10000;
const POLL_MS = 250;

interface FakePlayerEvents {
    onReady: () => void;
    onStateChange: (event: { data: number }) => void;
    onError: (event: { data: number }) => void;
}

interface FakePlayerOptions {
    host: string;
    videoId: string;
    playerVars: Record<string, unknown>;
    events: FakePlayerEvents;
}

const createdPlayers: FakePlayer[] = [];

class FakePlayer {
    readonly element: Element;
    readonly options: FakePlayerOptions;
    muted = true;
    readonly mute = vi.fn(() => { this.muted = true; });
    readonly unMute = vi.fn(() => { this.muted = false; });
    readonly playVideo = vi.fn();
    readonly destroy = vi.fn();
    readonly isMuted = vi.fn(() => this.muted);

    constructor(element: Element, options: FakePlayerOptions) {
        this.element = element;
        this.options = options;
        createdPlayers.push(this);
    }
}

const globalWindow = window as unknown as {
    YT?: { Player: typeof FakePlayer };
    onYouTubeIframeAPIReady?: () => void;
};

const globalDocument = document as unknown as { hidden?: boolean };

let mod: TrailerModule;
let host: HTMLElement;

function latestPlayer(): FakePlayer {
    const player = createdPlayers[createdPlayers.length - 1];
    if (!player) throw new Error('no player was created');
    return player;
}

function overlayOf(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>('.lg-trailer');
}

function muteButtonOf(container: HTMLElement): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>('.lg-trailer__mute');
    if (!button) throw new Error('mute button missing');
    return button;
}

function iconOf(button: HTMLElement): HTMLElement {
    const icon = button.querySelector<HTMLElement>('.material-icons');
    if (!icon) throw new Error('mute icon missing');
    return icon;
}

function setDocumentHidden(value: boolean): void {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
}

// Lets the promise chain inside the module run before assertions.
async function flushPromises(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function advanceBy(ms: number): Promise<void> {
    vi.advanceTimersByTime(ms);
    await flushPromises();
}

function apiScripts(): HTMLScriptElement[] {
    return Array.from(document.querySelectorAll<HTMLScriptElement>(`script[src="${API_URL}"]`));
}

function removeYouTubeApi(): void {
    delete globalWindow.YT;
}

describe('trailerBackdrop', () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        mod = await import('./trailerBackdrop');

        reduced.value = false;
        vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
            media: query,
            matches: query.includes('prefers-reduced-motion') && reduced.value,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn()
        }) as unknown as MediaQueryList);

        globalWindow.YT = { Player: FakePlayer };
        createdPlayers.length = 0;
        host = document.createElement('div');
        document.body.appendChild(host);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
        for (const script of apiScripts()) {
            script.remove();
        }
        delete globalWindow.YT;
        delete globalWindow.onYouTubeIframeAPIReady;
        delete (navigator as unknown as { connection?: unknown }).connection;
        delete globalDocument.hidden;
        vi.unstubAllGlobals();
    });

    describe('getYouTubeId', () => {
        it.each([
            ['watch URL', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
            ['watch URL with v after other params', 'https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ'],
            ['mobile watch URL with extra params', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=10s'],
            ['short youtu.be URL', 'https://youtu.be/dQw4w9WgXcQ'],
            ['embed URL', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
            ['shorts URL', 'https://www.youtube.com/shorts/dQw4w9WgXcQ'],
            ['no-cookie embed URL', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ']
        ])('accepts a %s', (_label, url) => {
            expect(mod.getYouTubeId(url)).toBe(VIDEO_ID);
        });

        it('rejects a URL from a host other than YouTube', () => {
            expect(mod.getYouTubeId('https://vimeo.com/watch?v=dQw4w9WgXcQ')).toBeNull();
        });

        it('rejects a lookalike host that only contains youtube.com', () => {
            expect(mod.getYouTubeId('https://youtube.com.example.org/watch?v=dQw4w9WgXcQ')).toBeNull();
        });

        it('rejects an ID that is too short', () => {
            expect(mod.getYouTubeId('https://www.youtube.com/watch?v=short')).toBeNull();
        });

        it('rejects an ID that is too long', () => {
            expect(mod.getYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQextra')).toBeNull();
        });

        it('rejects a watch URL without a v parameter', () => {
            expect(mod.getYouTubeId('https://www.youtube.com/watch')).toBeNull();
        });

        it('rejects a shorts path on the no-cookie host', () => {
            expect(mod.getYouTubeId('https://www.youtube-nocookie.com/shorts/dQw4w9WgXcQ')).toBeNull();
        });

        it.each([
            ['null', null],
            ['undefined', undefined],
            ['an empty string', ''],
            ['text that is not a URL', 'not a url']
        ])('returns null for %s', (_label, url) => {
            expect(mod.getYouTubeId(url)).toBeNull();
        });
    });

    describe('getTrailerVideoId', () => {
        it('picks the first trailer that yields a valid YouTube ID', () => {
            const id = mod.getTrailerVideoId({
                RemoteTrailers: [
                    { Url: 'https://vimeo.com/123' },
                    { Url: null },
                    { Url: 'https://youtu.be/dQw4w9WgXcQ' },
                    { Url: 'https://youtu.be/aaaaaaaaaaa' }
                ]
            });
            expect(id).toBe(VIDEO_ID);
        });

        it.each([
            ['RemoteTrailers is missing', {}],
            ['RemoteTrailers is null', { RemoteTrailers: null }],
            ['RemoteTrailers is empty', { RemoteTrailers: [] }],
            ['no trailer has a valid ID', { RemoteTrailers: [{ Url: 'https://vimeo.com/123' }] }]
        ])('returns null when %s', (_label, item) => {
            expect(mod.getTrailerVideoId(item)).toBeNull();
        });
    });

    describe('canAutoplayTrailers', () => {
        it('allows autoplay by default', () => {
            expect(mod.canAutoplayTrailers()).toBe(true);
        });

        it('refuses autoplay when the user prefers reduced motion', () => {
            reduced.value = true;
            expect(mod.canAutoplayTrailers()).toBe(false);
        });

        it('refuses autoplay when the connection asks to save data', () => {
            Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } });
            expect(mod.canAutoplayTrailers()).toBe(false);
        });

        it('refuses autoplay when the engine cannot parse container query units', () => {
            const supports = vi.fn(() => false);
            vi.stubGlobal('CSS', { supports });

            expect(mod.canAutoplayTrailers()).toBe(false);
            expect(supports).toHaveBeenCalledWith('width', '1cqw');
        });

        it('refuses autoplay while the document is hidden', () => {
            setDocumentHidden(true);
            expect(mod.canAutoplayTrailers()).toBe(false);
        });
    });

    describe('armTrailerBackdrop', () => {
        it('creates nothing before the delay elapses', async () => {
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            await advanceBy(DELAY_MS - 1);

            expect(createdPlayers).toHaveLength(0);
            expect(host.children).toHaveLength(0);
        });

        it('creates a muted, looping no-cookie player after 7000 ms', async () => {
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            await advanceBy(DELAY_MS);

            expect(createdPlayers).toHaveLength(1);
            const { options, element } = latestPlayer();
            expect(options.host).toBe('https://www.youtube-nocookie.com');
            expect(options.videoId).toBe(VIDEO_ID);
            expect(options.playerVars).toMatchObject({
                autoplay: 1,
                mute: 1,
                start: TRAILER_START_SECONDS,
                controls: 0,
                origin: window.location.origin
            });
            expect(options.playerVars).not.toHaveProperty('loop');
            expect(options.playerVars).not.toHaveProperty('playlist');
            expect(element.classList.contains('lg-trailer__frame')).toBe(true);
        });

        it('honours a custom delayMs', async () => {
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, delayMs: 2000 });
            await advanceBy(2000);

            expect(createdPlayers).toHaveLength(1);
        });

        it('mounts the aria-hidden overlay and a sibling mute button with the expected markup', async () => {
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            await advanceBy(DELAY_MS);

            const overlay = overlayOf(host);
            expect(overlay?.getAttribute('aria-hidden')).toBe('true');
            const button = muteButtonOf(host);
            expect(button.parentElement).toBe(host);
            expect(overlay?.contains(button)).toBe(false);
            expect(button.type).toBe('button');
            expect(button.hasAttribute('aria-pressed')).toBe(false);
            expect(button.getAttribute('aria-label')).toBe('LiquidGlassUnmuteTrailer');
            expect(iconOf(button).classList.contains('volume_off')).toBe(true);
        });

        it('loads the IFrame API script exactly once across several arms', async () => {
            removeYouTubeApi();
            const hosts = [0, 1, 2].map(() => {
                const element = document.createElement('div');
                host.appendChild(element);
                return element;
            });
            for (const element of hosts) mod.armTrailerBackdrop({ host: element, videoId: VIDEO_ID });
            await advanceBy(DELAY_MS);

            expect(apiScripts()).toHaveLength(1);
            expect(createdPlayers).toHaveLength(0);

            globalWindow.YT = { Player: FakePlayer };
            globalWindow.onYouTubeIframeAPIReady?.();
            await flushPromises();

            expect(createdPlayers).toHaveLength(3);
        });

        it('calls a previously assigned onYouTubeIframeAPIReady handler as well', async () => {
            removeYouTubeApi();
            const previous = vi.fn();
            globalWindow.onYouTubeIframeAPIReady = previous;
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            await advanceBy(DELAY_MS);

            globalWindow.YT = { Player: FakePlayer };
            globalWindow.onYouTubeIframeAPIReady?.();
            await flushPromises();

            expect(previous).toHaveBeenCalledTimes(1);
            expect(createdPlayers).toHaveLength(1);
        });

        it('shows nothing and logs a warning when the IFrame API script fails to load', async () => {
            removeYouTubeApi();
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            await advanceBy(DELAY_MS);

            const [script] = apiScripts();
            if (!script) throw new Error('API script was not injected');
            script.dispatchEvent(new Event('error'));
            await flushPromises();

            expect(warn).toHaveBeenCalledWith('[trailer] api failed', expect.any(Error));
            expect(createdPlayers).toHaveLength(0);
            expect(host.children).toHaveLength(0);
        });

        it('reveals the overlay and calls onPlaying once, 1500 ms after the player reports PLAYING', async () => {
            const onPlaying = vi.fn();
            const trailer = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onPlaying });
            await advanceBy(DELAY_MS);

            latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
            latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
            await advanceBy(REVEAL_DELAY_MS - 1);

            expect(overlayOf(host)?.classList.contains(PLAYING_CLASS)).toBe(false);
            expect(muteButtonOf(host).classList.contains(MUTE_VISIBLE_CLASS)).toBe(false);
            expect(onPlaying).not.toHaveBeenCalled();
            expect(trailer.playing).toBe(false);

            await advanceBy(1);

            expect(overlayOf(host)?.classList.contains(PLAYING_CLASS)).toBe(true);
            expect(muteButtonOf(host).classList.contains(MUTE_VISIBLE_CLASS)).toBe(true);
            expect(onPlaying).toHaveBeenCalledTimes(1);
            expect(trailer.playing).toBe(true);
        });

        it('shows nothing when cancelled during the reveal wait', async () => {
            const onPlaying = vi.fn();
            const trailer = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onPlaying });
            await advanceBy(DELAY_MS);
            latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
            await advanceBy(REVEAL_DELAY_MS - 500);

            trailer.cancel();
            await advanceBy(REVEAL_DELAY_MS + FADE_OUT_MS);

            expect(overlayOf(host)?.classList.contains(PLAYING_CLASS) ?? false).toBe(false);
            expect(onPlaying).not.toHaveBeenCalled();
            expect(trailer.playing).toBe(false);
        });

        it('fades back to the artwork when buffering lasts more than 2 s, and restores on PLAYING', async () => {
            const onPlaying = vi.fn();
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onPlaying });
            await advanceBy(DELAY_MS);
            latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
            await advanceBy(REVEAL_DELAY_MS);

            latestPlayer().options.events.onStateChange({ data: BUFFERING_STATE });
            await advanceBy(STALL_FADE_MS - 1);
            expect(overlayOf(host)?.classList.contains(PLAYING_CLASS)).toBe(true);

            await advanceBy(1);
            expect(overlayOf(host)?.classList.contains(PLAYING_CLASS)).toBe(false);
            expect(muteButtonOf(host).classList.contains(MUTE_VISIBLE_CLASS)).toBe(false);

            latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });

            expect(overlayOf(host)?.classList.contains(PLAYING_CLASS)).toBe(true);
            expect(muteButtonOf(host).classList.contains(MUTE_VISIBLE_CLASS)).toBe(true);
            expect(onPlaying).toHaveBeenCalledTimes(1);
        });

        it('keeps the overlay when buffering ends within 2 s', async () => {
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            await advanceBy(DELAY_MS);
            latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
            await advanceBy(REVEAL_DELAY_MS);

            latestPlayer().options.events.onStateChange({ data: BUFFERING_STATE });
            await advanceBy(STALL_FADE_MS - 1);
            latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
            await advanceBy(STALL_FADE_MS);

            expect(overlayOf(host)?.classList.contains(PLAYING_CLASS)).toBe(true);
        });

        it('fades back to the artwork when the player pauses, the same as a stall', async () => {
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            await advanceBy(DELAY_MS);
            latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
            await advanceBy(REVEAL_DELAY_MS);
            expect(overlayOf(host)?.classList.contains(PLAYING_CLASS)).toBe(true);

            latestPlayer().options.events.onStateChange({ data: PAUSED_STATE });
            await advanceBy(STALL_FADE_MS);

            expect(overlayOf(host)?.classList.contains(PLAYING_CLASS)).toBe(false);
            expect(muteButtonOf(host).classList.contains(MUTE_VISIBLE_CLASS)).toBe(false);
        });

        it('removes leftover overlay and mute button from an earlier instance on the same host', async () => {
            const first = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            await advanceBy(DELAY_MS);
            first.cancel();

            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, delayMs: 0 });
            await advanceBy(1);

            expect(host.querySelectorAll('.lg-trailer')).toHaveLength(1);
            expect(host.querySelectorAll('.lg-trailer__mute')).toHaveLength(1);
        });

        it('moves focus off the mute button before it is hidden', async () => {
            const container = document.createElement('div');
            container.tabIndex = -1;
            document.body.appendChild(container);
            container.appendChild(host);
            const trailer = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            await advanceBy(DELAY_MS);
            latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
            await advanceBy(REVEAL_DELAY_MS);
            const button = muteButtonOf(host);
            button.focus();
            expect(document.activeElement).toBe(button);

            trailer.cancel();
            expect(document.activeElement).toBe(container);

            vi.advanceTimersByTime(FADE_OUT_MS);
            expect(document.activeElement).not.toBe(button);
        });

        it('fades out, destroys the player and reports stop when the video ends (plays once)', async () => {
            const onStop = vi.fn();
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onStart: vi.fn(), onStop });
            await advanceBy(DELAY_MS);
            latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
            await advanceBy(REVEAL_DELAY_MS);

            latestPlayer().options.events.onStateChange({ data: ENDED_STATE });

            expect(overlayOf(host)?.classList.contains(PLAYING_CLASS)).toBe(false);
            expect(muteButtonOf(host).classList.contains(MUTE_VISIBLE_CLASS)).toBe(false);
            vi.advanceTimersByTime(FADE_OUT_MS - 1);
            expect(latestPlayer().destroy).not.toHaveBeenCalled();

            vi.advanceTimersByTime(1);
            expect(latestPlayer().destroy).toHaveBeenCalledTimes(1);
            expect(onStop).toHaveBeenCalledTimes(1);
        });

        it('mutes and starts playback when the player is ready', async () => {
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            await advanceBy(DELAY_MS);

            latestPlayer().options.events.onReady();

            expect(latestPlayer().mute).toHaveBeenCalledTimes(1);
            expect(latestPlayer().playVideo).toHaveBeenCalledTimes(1);
        });

        it('removes the elements when the player reports an error', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            const onStop = vi.fn();
            const trailer = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onStop });
            await advanceBy(DELAY_MS);

            latestPlayer().options.events.onError({ data: 150 });

            expect(host.children).toHaveLength(0);
            expect(latestPlayer().destroy).toHaveBeenCalledTimes(1);
            expect(trailer.playing).toBe(false);
            expect(onStop).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith('[trailer] player error', 150);
        });

        it('creates nothing when cancelled before the delay', async () => {
            const trailer = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            trailer.cancel();
            await advanceBy(DELAY_MS);

            expect(createdPlayers).toHaveLength(0);
            expect(host.children).toHaveLength(0);
        });

        it('removes the playing class, then destroys the player after the fade-out and reports stop', async () => {
            const onStop = vi.fn();
            const trailer = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onStop });
            await advanceBy(DELAY_MS);
            latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
            await advanceBy(REVEAL_DELAY_MS);

            trailer.cancel();

            expect(overlayOf(host)?.classList.contains(PLAYING_CLASS)).toBe(false);
            expect(overlayOf(host)).not.toBeNull();
            vi.advanceTimersByTime(FADE_OUT_MS - 1);
            expect(latestPlayer().destroy).not.toHaveBeenCalled();

            vi.advanceTimersByTime(1);
            expect(latestPlayer().destroy).toHaveBeenCalledTimes(1);
            expect(host.children).toHaveLength(0);
            expect(onStop).toHaveBeenCalledTimes(1);
            expect(trailer.playing).toBe(false);
        });

        it('keeps cancel and destroy idempotent', async () => {
            const onStop = vi.fn();
            const trailer = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onStop });
            await advanceBy(DELAY_MS);
            latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });

            trailer.cancel();
            trailer.cancel();
            vi.advanceTimersByTime(FADE_OUT_MS);
            trailer.destroy();
            trailer.destroy();

            expect(latestPlayer().destroy).toHaveBeenCalledTimes(1);
            expect(onStop).toHaveBeenCalledTimes(1);
        });

        it('does nothing when the user prefers reduced motion', async () => {
            reduced.value = true;
            const onPlaying = vi.fn();
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onPlaying });
            await advanceBy(DELAY_MS);

            expect(createdPlayers).toHaveLength(0);
            expect(host.children).toHaveLength(0);
            expect(onPlaying).not.toHaveBeenCalled();
        });

        it('flips the label and icon on each mute click and calls unMute or mute', async () => {
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            await advanceBy(DELAY_MS);
            latestPlayer().options.events.onReady();
            const player = latestPlayer();
            const button = muteButtonOf(host);

            button.click();

            expect(player.unMute).toHaveBeenCalledTimes(1);
            expect(button.hasAttribute('aria-pressed')).toBe(false);
            expect(button.getAttribute('aria-label')).toBe('LiquidGlassMuteTrailer');
            expect(iconOf(button).classList.contains('volume_up')).toBe(true);
            expect(iconOf(button).classList.contains('volume_off')).toBe(false);

            button.click();

            expect(player.mute).toHaveBeenCalledTimes(2);
            expect(button.hasAttribute('aria-pressed')).toBe(false);
            expect(button.getAttribute('aria-label')).toBe('LiquidGlassUnmuteTrailer');
            expect(iconOf(button).classList.contains('volume_off')).toBe(true);
            expect(iconOf(button).classList.contains('volume_up')).toBe(false);
        });

        it('stops mute button clicks from bubbling to the host', async () => {
            const hostClick = vi.fn();
            host.addEventListener('click', hostClick);
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            await advanceBy(DELAY_MS);

            muteButtonOf(host).click();

            expect(hostClick).not.toHaveBeenCalled();
        });

        it('cancels when the page becomes hidden before the delay elapses', async () => {
            mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            setDocumentHidden(true);
            document.dispatchEvent(new Event('visibilitychange'));
            await advanceBy(DELAY_MS);

            expect(createdPlayers).toHaveLength(0);
        });

        it('removes the visibilitychange listener on cancel', () => {
            const removeSpy = vi.spyOn(document, 'removeEventListener');
            const trailer = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
            trailer.cancel();

            expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        });

        describe('IFrame API readiness', () => {
            it('gives up with a warning when the IFrame API never becomes ready, then calls onStop', async () => {
                removeYouTubeApi();
                const warn = vi.spyOn(console, 'warn').mockImplementation(silenceWarnings);
                const onStop = vi.fn();
                const trailer = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onStart: vi.fn(), onStop });
                await advanceBy(DELAY_MS + API_READY_TIMEOUT_MS);

                expect(warn).toHaveBeenCalledWith('[trailer] api failed', expect.any(Error));
                expect(onStop).toHaveBeenCalledTimes(1);
                expect(host.children).toHaveLength(0);
                expect(trailer.playing).toBe(false);
            });

            it('resolves as soon as the player appears, without the ready callback', async () => {
                removeYouTubeApi();
                mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
                await advanceBy(DELAY_MS);

                globalWindow.YT = { Player: FakePlayer };
                await advanceBy(POLL_MS);

                expect(createdPlayers).toHaveLength(1);
            });

            it('waits again on a later arm after a failed load, without injecting a second script', async () => {
                removeYouTubeApi();
                vi.spyOn(console, 'warn').mockImplementation(silenceWarnings);
                mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
                await advanceBy(DELAY_MS + API_READY_TIMEOUT_MS);

                mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
                await advanceBy(DELAY_MS);
                expect(apiScripts()).toHaveLength(1);

                globalWindow.YT = { Player: FakePlayer };
                await advanceBy(POLL_MS);
                expect(createdPlayers).toHaveLength(1);
            });

            it('does not wrap onYouTubeIframeAPIReady again after a timed-out load', async () => {
                removeYouTubeApi();
                vi.spyOn(console, 'warn').mockImplementation(silenceWarnings);
                mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
                await advanceBy(DELAY_MS + API_READY_TIMEOUT_MS);
                const readyHandler = globalWindow.onYouTubeIframeAPIReady;

                mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
                await advanceBy(DELAY_MS);

                expect(apiScripts()).toHaveLength(1);
                expect(globalWindow.onYouTubeIframeAPIReady).toBe(readyHandler);
            });
        });

        describe('start timeout', () => {
            it('warns and destroys the trailer when PLAYING is not reached within 10 s of onStart', async () => {
                const warn = vi.spyOn(console, 'warn').mockImplementation(silenceWarnings);
                const onStop = vi.fn();
                mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onStart: vi.fn(), onStop });
                await advanceBy(DELAY_MS);
                expect(createdPlayers).toHaveLength(1);

                await advanceBy(START_TIMEOUT_MS);

                expect(warn).toHaveBeenCalledWith('[trailer] start timeout');
                expect(onStop).toHaveBeenCalledTimes(1);
                expect(host.children).toHaveLength(0);
            });

            it('does not warn when PLAYING arrives within 10 s of onStart', async () => {
                const warn = vi.spyOn(console, 'warn').mockImplementation(silenceWarnings);
                mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onStart: vi.fn() });
                await advanceBy(DELAY_MS);
                await advanceBy(5000);
                latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
                await advanceBy(START_TIMEOUT_MS);

                expect(warn).not.toHaveBeenCalledWith('[trailer] start timeout');
                expect(latestPlayer().destroy).not.toHaveBeenCalled();
            });
        });

        describe('onStart and onStop', () => {
            it('calls onStart once the delay elapses, before the API loads', async () => {
                const onStart = vi.fn();
                removeYouTubeApi();
                mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onStart });
                await advanceBy(DELAY_MS - 1);
                expect(onStart).not.toHaveBeenCalled();

                await advanceBy(1);
                expect(onStart).toHaveBeenCalledTimes(1);
                expect(apiScripts()).toHaveLength(1);
            });

            it('does not call onStart when autoplay is not allowed', async () => {
                reduced.value = true;
                const onStart = vi.fn();
                mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onStart });
                await advanceBy(DELAY_MS);

                expect(onStart).not.toHaveBeenCalled();
            });

            it('calls onStop after onStart even when the trailer never reached PLAYING', async () => {
                vi.spyOn(console, 'warn').mockImplementation(silenceWarnings);
                removeYouTubeApi();
                const onStart = vi.fn();
                const onStop = vi.fn();
                const trailer = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onStart, onStop });
                await advanceBy(DELAY_MS);

                const [script] = apiScripts();
                if (!script) throw new Error('API script was not injected');
                script.dispatchEvent(new Event('error'));
                await flushPromises();

                expect(onStart).toHaveBeenCalledTimes(1);
                expect(onStop).toHaveBeenCalledTimes(1);
                expect(trailer.playing).toBe(false);
            });

            it('does not call onStop when cancelled before the delay', async () => {
                const onStart = vi.fn();
                const onStop = vi.fn();
                const trailer = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onStart, onStop });
                trailer.cancel();
                await advanceBy(DELAY_MS);

                expect(onStart).not.toHaveBeenCalled();
                expect(onStop).not.toHaveBeenCalled();
            });

            it('calls onStop once when cancelled after onStart without PLAYING', async () => {
                removeYouTubeApi();
                const onStop = vi.fn();
                const trailer = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, onStart: vi.fn(), onStop });
                await advanceBy(DELAY_MS);

                trailer.cancel();
                vi.advanceTimersByTime(FADE_OUT_MS);

                expect(onStop).toHaveBeenCalledTimes(1);
            });
        });

        describe('showMuteButton', () => {
            it('creates no mute button when showMuteButton is false', async () => {
                mod.armTrailerBackdrop({ host, videoId: VIDEO_ID, showMuteButton: false });
                await advanceBy(DELAY_MS);
                latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
                await advanceBy(REVEAL_DELAY_MS);

                expect(overlayOf(host)?.classList.contains(PLAYING_CLASS)).toBe(true);
                expect(host.querySelector('.lg-trailer__mute')).toBeNull();
            });

            it('keeps the mute button out of the tab order and the accessibility tree until playing', async () => {
                mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
                await advanceBy(DELAY_MS);

                const button = muteButtonOf(host);
                expect(button.getAttribute('tabindex')).toBe('-1');
                expect(button.getAttribute('aria-hidden')).toBe('true');
            });

            it('makes the mute button focusable and visible to assistive tech once the trailer plays', async () => {
                mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
                await advanceBy(DELAY_MS);
                latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
                await advanceBy(REVEAL_DELAY_MS);

                const button = muteButtonOf(host);
                expect(button.hasAttribute('tabindex')).toBe(false);
                expect(button.hasAttribute('aria-hidden')).toBe(false);
            });

            it('restores the hidden focus state when cancelled after playing', async () => {
                const trailer = mod.armTrailerBackdrop({ host, videoId: VIDEO_ID });
                await advanceBy(DELAY_MS);
                latestPlayer().options.events.onStateChange({ data: PLAYING_STATE });
                await advanceBy(REVEAL_DELAY_MS);

                trailer.cancel();

                const button = muteButtonOf(host);
                expect(button.getAttribute('tabindex')).toBe('-1');
                expect(button.getAttribute('aria-hidden')).toBe('true');
            });
        });
    });
});
