import globalize from '../../lib/globalize';

/** How long the user must stay on one title before its trailer starts. */
export const DEFAULT_DELAY_MS = 7000;
/**
 * After PLAYING, the layer stays hidden this long so YouTube's title card and first-frame flicker pass unseen.
 * The reveal then fades in over the artwork.
 */
export const REVEAL_DELAY_MS = 3000;
/** Start offset so the trailer skips the rating and studio cards at the top of the video. */
export const TRAILER_START_SECONDS = 10;
/** Matches the `.lg-trailer` opacity transition in _trailer.scss; the player is destroyed after the fade. */
const FADE_OUT_MS = 1600;
/** How long ENDED or BUFFERING may last before the layer fades back to the artwork. */
const STALL_FADE_MS = 2000;
/** Longest wait for window.YT.Player after the IFrame API script is requested. */
const API_READY_TIMEOUT_MS = 8000;
const API_POLL_MS = 250;
/** Longest wait after onStart for the player to report PLAYING before the trailer gives up. */
const START_TIMEOUT_MS = 10000;
// The layout uses container query units (cqw/cqh); engines without them cannot size the video, so do not autoplay.
const CONTAINER_UNITS_PROBE = { property: 'width', value: '1cqw' } as const;
const API_URL = 'https://www.youtube.com/iframe_api';
const EMBED_HOST = 'https://www.youtube-nocookie.com';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const YOUTUBE_ID_PATTERN = /^[\w-]{11}$/;
// Splits an http(s) URL into host, path and query. Hand-parsed because `URL` is flagged by the compat lint rule.
const URL_PARTS_PATTERN = /^https?:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?/i;
// YouTube's parameter names are snake_case; a constant key keeps the naming rule satisfied.
const IV_LOAD_POLICY_PARAM = 'iv_load_policy';
const YOUTUBE_HOSTS = new Set([ 'youtube.com', 'www.youtube.com', 'm.youtube.com' ]);
const NOCOOKIE_HOSTS = new Set([ 'youtube-nocookie.com', 'www.youtube-nocookie.com' ]);
const YT_PLAYER_STATE_ENDED = 0;
const YT_PLAYER_STATE_PLAYING = 1;
const YT_PLAYER_STATE_PAUSED = 2;
const YT_PLAYER_STATE_BUFFERING = 3;
const PLAYING_CLASS = 'lg-trailer--playing';
const MUTE_VISIBLE_CLASS = 'lg-trailer__mute--visible';
// Elements a previous instance leaves in the host while its fade-out runs.
const LEFTOVER_SELECTOR = '.lg-trailer, .lg-trailer__mute';
// Where keyboard focus goes when the mute button is hidden under it.
const FOCUS_FALLBACK_SELECTOR = '[tabindex], .itemDetailPage, .lg-hero__slide';

interface YouTubePlayer {
    mute(): void;
    unMute(): void;
    isMuted(): boolean;
    playVideo(): void;
    destroy(): void;
}

interface YouTubePlayerEvents {
    onReady: () => void;
    onStateChange: (event: { data: number }) => void;
    onError: (event: { data: number }) => void;
}

interface YouTubeGlobal {
    Player?: new (element: HTMLElement, options: Record<string, unknown>) => YouTubePlayer;
}

interface YouTubeWindow {
    YT?: YouTubeGlobal;
    onYouTubeIframeAPIReady?: () => void;
}

interface ConnectionInfo {
    saveData?: boolean;
}

interface MuteControl {
    button: HTMLButtonElement;
    icon: HTMLElement;
}

interface TrailerElements {
    overlay: HTMLElement;
    frame: HTMLElement;
    mute?: MuteControl;
}

export interface TrailerBackdropOptions {
    host: HTMLElement;
    videoId: string;
    delayMs?: number;
    /** Set false when the host has no room or pointer for a mute toggle (for example a TV card). Defaults to true. */
    showMuteButton?: boolean;
    /** Called once when the delay has elapsed and the trailer is about to load. Autoplay is allowed at this point. */
    onStart?: () => void;
    /** Called once on teardown if onStart fired, whether or not the trailer reached PLAYING. */
    onStop?: () => void;
    onPlaying?: () => void;
}

export interface TrailerBackdrop {
    cancel(): void;
    destroy(): void;
    readonly playing: boolean;
}

/** The shared IFrame API load while in flight or after it resolved. Cleared on failure so a later arm waits again. */
let apiLoad: Promise<void> | undefined;
/** Set once the IFrame API script tag has been added. The tag is never added again, even after a failed load. */
let apiScriptInjected = false;

function youTubeWindow(): YouTubeWindow {
    return window as unknown as YouTubeWindow;
}

/** Extracts the 11-character video ID from a YouTube URL, or null when the URL is not a YouTube video link. */
export function getYouTubeId(url: string | null | undefined): string | null {
    if (!url) return null;
    const id = idFromUrl(url.trim());
    return id && YOUTUBE_ID_PATTERN.test(id) ? id : null;
}

function idFromUrl(url: string): string | null {
    const parts = URL_PARTS_PATTERN.exec(url);
    if (!parts) return null;
    const host = (parts[1] ?? '').toLowerCase();
    const segments = (parts[2] ?? '').split('/').filter(Boolean);
    if (host === 'youtu.be') return segments.length === 1 ? segments[0] ?? null : null;
    if (YOUTUBE_HOSTS.has(host)) return idFromYouTubePath(parts[3], segments);
    if (NOCOOKIE_HOSTS.has(host) && segments.length === 2 && segments[0] === 'embed') return segments[1] ?? null;
    return null;
}

function idFromYouTubePath(query: string | undefined, segments: string[]): string | null {
    if (segments.length === 1 && segments[0] === 'watch') return queryParam(query, 'v');
    if (segments.length === 2 && (segments[0] === 'embed' || segments[0] === 'shorts')) return segments[1] ?? null;
    return null;
}

function queryParam(query: string | undefined, name: string): string | null {
    for (const pair of (query ?? '').split('&')) {
        const [key, value] = pair.split('=');
        if (key === name) return value ?? null;
    }
    return null;
}

/** The first trailer in the item that points at a valid YouTube video, or null. */
export function getTrailerVideoId(item: { RemoteTrailers?: { Url?: string | null }[] | null }): string | null {
    for (const trailer of item.RemoteTrailers ?? []) {
        const id = getYouTubeId(trailer.Url);
        if (id) return id;
    }
    return null;
}

/** False when the user prefers reduced motion, asked to save data, or the page is in the background. */
export function canAutoplayTrailers(): boolean {
    if (document.hidden) return false;
    if (typeof CSS !== 'undefined' && !CSS.supports(CONTAINER_UNITS_PROBE.property, CONTAINER_UNITS_PROBE.value)) return false;
    if (window.matchMedia(REDUCED_MOTION_QUERY).matches) return false;
    const connection = (navigator as Navigator & { connection?: ConnectionInfo }).connection;
    return connection?.saveData !== true;
}

function injectApiScript(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const win = youTubeWindow();
        const previous = win.onYouTubeIframeAPIReady;
        win.onYouTubeIframeAPIReady = () => {
            previous?.();
            resolve();
        };
        const script = document.createElement('script');
        script.src = API_URL;
        script.async = true;
        script.onerror = () => reject(new Error('YouTube IFrame API script failed to load'));
        document.head.appendChild(script);
    });
}

/**
 * Resolves once window.YT.Player exists, polled because other code may overwrite onYouTubeIframeAPIReady.
 * Rejects after API_READY_TIMEOUT_MS so a blocked script cannot leave the trailer waiting forever.
 */
function waitForPlayer(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
            if (!youTubeWindow().YT?.Player) return;
            clearInterval(poll);
            clearTimeout(timeout);
            resolve();
        }, API_POLL_MS);
        const timeout = setTimeout(() => {
            clearInterval(poll);
            reject(new Error('YouTube IFrame API did not become ready'));
        }, API_READY_TIMEOUT_MS);
    });
}

/** Adds the script on the first call only. Later calls just wait for window.YT.Player. */
function startApiLoad(): Promise<void> {
    if (apiScriptInjected) return waitForPlayer();
    apiScriptInjected = true;
    return Promise.race([ injectApiScript(), waitForPlayer() ]);
}

function ensureYouTubeApi(): Promise<void> {
    if (youTubeWindow().YT?.Player) return Promise.resolve();
    // A failed load is not kept, so a later arm waits again. The script tag itself is never re-added.
    apiLoad ??= startApiLoad().catch((err: unknown) => {
        apiLoad = undefined;
        throw err;
    });
    return apiLoad;
}

/** A hidden mute button stays out of the tab order and the accessibility tree until the trailer is playing. */
function setMuteFocusable(button: HTMLButtonElement, focusable: boolean): void {
    if (focusable) {
        button.removeAttribute('tabindex');
        button.removeAttribute('aria-hidden');
    } else {
        button.setAttribute('tabindex', '-1');
        button.setAttribute('aria-hidden', 'true');
    }
}

function setMuteVisible(mute: MuteControl | undefined, visible: boolean): void {
    if (!mute) return;
    mute.button.classList.toggle(MUTE_VISIBLE_CLASS, visible);
    setMuteFocusable(mute.button, visible);
}

function buildMuteControl(): MuteControl {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lg-trailer__mute';
    const icon = document.createElement('span');
    icon.className = 'material-icons volume_off';
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);
    setMuteFocusable(button, false);
    return { button, icon };
}

function buildElements(withMute: boolean): TrailerElements {
    const overlay = document.createElement('div');
    overlay.className = 'lg-trailer';
    overlay.setAttribute('aria-hidden', 'true');
    const frame = document.createElement('div');
    frame.className = 'lg-trailer__frame';
    overlay.appendChild(frame);
    return { overlay, frame, mute: withMute ? buildMuteControl() : undefined };
}

/** Moves focus off the mute button before it is hidden, to the nearest focusable ancestor when there is one. */
function releaseMuteFocus(host: HTMLElement, mute: MuteControl | undefined): void {
    if (!mute || document.activeElement !== mute.button) return;
    host.closest<HTMLElement>(FOCUS_FALLBACK_SELECTOR)?.focus();
}

function renderMuteState(mute: MuteControl, muted: boolean): void {
    const label = muted ? 'LiquidGlassUnmuteTrailer' : 'LiquidGlassMuteTrailer';
    // The label is the single source of mute state; aria-pressed would duplicate it.
    mute.button.setAttribute('aria-label', globalize.translate(label));
    mute.icon.classList.toggle('volume_off', muted);
    mute.icon.classList.toggle('volume_up', !muted);
}

function createPlayer(frame: HTMLElement, videoId: string, events: YouTubePlayerEvents): YouTubePlayer {
    const Player = youTubeWindow().YT?.Player;
    if (!Player) throw new Error('YouTube IFrame API is not available');
    return new Player(frame, {
        host: EMBED_HOST,
        videoId,
        playerVars: {
            autoplay: 1,
            mute: 1,
            controls: 0,
            disablekb: 1,
            fs: 0,
            [IV_LOAD_POLICY_PARAM]: 3,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            start: TRAILER_START_SECONDS,
            origin: window.location.origin
        },
        events
    });
}

/**
 * Plays a muted YouTube trailer behind the artwork after `delayMs` on the same title.
 * The trailer fades in over the artwork and has a mute toggle. Nothing is shown when autoplay is not allowed
 * or the IFrame API cannot load. Call cancel() when the user leaves the title, and destroy() to tear down.
 */
export function armTrailerBackdrop(options: TrailerBackdropOptions): TrailerBackdrop {
    const { host, videoId, delayMs = DEFAULT_DELAY_MS, showMuteButton = true, onStart, onPlaying, onStop } = options;
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    let fadeTimer: ReturnType<typeof setTimeout> | undefined;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let elements: TrailerElements | undefined;
    let player: YouTubePlayer | undefined;
    let cancelled = false;
    let destroyed = false;
    let playing = false;
    let started = false;
    let muted = true;

    function removeVisibilityListener(): void {
        document.removeEventListener('visibilitychange', onVisibilityChange);
    }

    function clearRevealTimers(): void {
        clearTimeout(revealTimer);
        clearTimeout(stallTimer);
        revealTimer = undefined;
        stallTimer = undefined;
    }

    /** Fades the layer in or out, together with the mute control. */
    function setLayerShown(shown: boolean): void {
        if (!elements) return;
        if (!shown) releaseMuteFocus(host, elements.mute);
        elements.overlay.classList.toggle(PLAYING_CLASS, shown);
        setMuteVisible(elements.mute, shown);
    }

    function destroyPlayer(): void {
        if (!player) return;
        try {
            player.destroy();
        } catch (err) {
            console.warn('[trailer] player destroy failed', err);
        }
        player = undefined;
    }

    function destroy(): void {
        if (destroyed) return;
        destroyed = true;
        clearTimeout(delayTimer);
        clearTimeout(fadeTimer);
        clearTimeout(startTimer);
        clearRevealTimers();
        removeVisibilityListener();
        destroyPlayer();
        releaseMuteFocus(host, elements?.mute);
        elements?.overlay.remove();
        elements?.mute?.button.remove();
        elements = undefined;
        const wasStarted = started;
        started = false;
        playing = false;
        if (wasStarted) onStop?.();
    }

    function cancel(): void {
        if (cancelled || destroyed) return;
        cancelled = true;
        clearTimeout(delayTimer);
        clearTimeout(startTimer);
        clearRevealTimers();
        removeVisibilityListener();
        if (!elements) {
            destroy();
            return;
        }
        setLayerShown(false);
        fadeTimer = setTimeout(destroy, FADE_OUT_MS);
    }

    function onVisibilityChange(): void {
        if (document.hidden) cancel();
    }

    function reveal(): void {
        revealTimer = undefined;
        if (cancelled || destroyed) return;
        playing = true;
        setLayerShown(true);
        onPlaying?.();
    }

    function onPlayingState(): void {
        clearTimeout(startTimer);
        clearTimeout(stallTimer);
        stallTimer = undefined;
        if (playing) {
            // Resumed after a stall: the layer was faded back, so show it again at once.
            setLayerShown(true);
            return;
        }
        if (!revealTimer) revealTimer = setTimeout(reveal, REVEAL_DELAY_MS);
    }

    function onStalledState(): void {
        // A stall before the first reveal restarts the wait for PLAYING.
        clearTimeout(revealTimer);
        revealTimer = undefined;
        if (stallTimer) return;
        stallTimer = setTimeout(() => {
            stallTimer = undefined;
            setLayerShown(false);
        }, STALL_FADE_MS);
    }

    function onStateChange(state: number): void {
        if (cancelled || destroyed || !elements) return;
        if (state === YT_PLAYER_STATE_PLAYING) {
            onPlayingState();
        } else if (state === YT_PLAYER_STATE_BUFFERING || state === YT_PLAYER_STATE_PAUSED) {
            // A pause fades back to the artwork like a stall, so a frozen frame never stays on screen.
            onStalledState();
        } else if (state === YT_PLAYER_STATE_ENDED) {
            // The trailer plays once; cancel fades it back to the artwork and then tears it down.
            cancel();
        }
    }

    function onPlayerError(code: number): void {
        console.warn('[trailer] player error', code);
        destroy();
    }

    function toggleMute(event: MouseEvent, mute: MuteControl): void {
        event.stopPropagation();
        if (!player) return;
        const wasMuted = player.isMuted();
        if (wasMuted) player.unMute();
        else player.mute();
        muted = !wasMuted;
        renderMuteState(mute, muted);
    }

    function mount(): void {
        // Leftovers from an earlier instance on this host are still fading out; remove them so only one trailer shows.
        for (const child of Array.from(host.children)) {
            if (child.matches(LEFTOVER_SELECTOR)) child.remove();
        }
        const created = buildElements(showMuteButton);
        elements = created;
        host.appendChild(created.overlay);
        const mute = created.mute;
        if (mute) {
            renderMuteState(mute, muted);
            host.appendChild(mute.button);
            mute.button.addEventListener('click', event => toggleMute(event, mute));
        }
        const events: YouTubePlayerEvents = {
            onReady: () => {
                player?.mute();
                player?.playVideo();
            },
            onStateChange: event => onStateChange(event.data),
            onError: event => onPlayerError(event.data)
        };
        try {
            player = createPlayer(created.frame, videoId, events);
        } catch (err) {
            console.warn('[trailer] player failed', err);
            destroy();
        }
    }

    function onStartTimeout(): void {
        console.warn('[trailer] start timeout');
        destroy();
    }

    function start(): void {
        if (!canAutoplayTrailers()) return;
        started = true;
        onStart?.();
        startTimer = setTimeout(onStartTimeout, START_TIMEOUT_MS);
        ensureYouTubeApi().then(() => {
            if (cancelled || destroyed) return;
            mount();
        }, (err: unknown) => {
            console.warn('[trailer] api failed', err);
            destroy();
        });
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    delayTimer = setTimeout(() => {
        delayTimer = undefined;
        start();
    }, delayMs);

    return {
        cancel,
        destroy,
        get playing() {
            return playing;
        }
    };
}
