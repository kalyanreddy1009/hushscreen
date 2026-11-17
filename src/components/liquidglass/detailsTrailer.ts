import { armTrailerBackdrop, getTrailerVideoId, type TrailerBackdrop } from './trailerBackdrop';

export const DETAILS_TRAILER_DELAY_MS = 7000;

export interface DetailsTrailerItem {
    RemoteTrailers?: { Url?: string | null }[] | null;
}

export interface DetailsTrailer {
    /** Cancels any previous trailer, then arms one for item when enabled, the host is displayed and a trailer exists. */
    arm(host: HTMLElement | null, item: DetailsTrailerItem | null | undefined, enabled: boolean): void;
    cancel(): void;
    /** Cancels the trailer and removes the playback start subscription. */
    dispose(): void;
}

/**
 * Owns the background trailer on the item details banner for one page instance.
 * listenPlaybackStart subscribes a listener to playbackstart and returns the unsubscribe function.
 */
export function createDetailsTrailer(listenPlaybackStart: (listener: () => void) => () => void): DetailsTrailer {
    let active: TrailerBackdrop | undefined;
    let activeHost: HTMLElement | undefined;
    let activeVideoId: string | undefined;

    function cancel(): void {
        active?.cancel();
        active = undefined;
        activeHost = undefined;
        activeVideoId = undefined;
    }

    const unsubscribe = listenPlaybackStart(cancel);

    return {
        arm(host, item, enabled) {
            const videoId = enabled && host && item && host.offsetParent !== null ? getTrailerVideoId(item) : null;
            // Re-rendering the same banner must not restart a trailer that is already armed or playing.
            if (active && host && videoId && host === activeHost && videoId === activeVideoId) return;
            cancel();
            if (!host || !videoId) return;

            activeHost = host;
            activeVideoId = videoId;
            active = armTrailerBackdrop({ host, videoId, delayMs: DETAILS_TRAILER_DELAY_MS, showMuteButton: true });
        },
        cancel,
        dispose() {
            cancel();
            unsubscribe();
        }
    };
}
