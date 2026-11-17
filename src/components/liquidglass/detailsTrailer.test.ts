import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./trailerBackdrop', () => ({
    armTrailerBackdrop: vi.fn(),
    getTrailerVideoId: vi.fn()
}));

import { armTrailerBackdrop, getTrailerVideoId, type TrailerBackdrop } from './trailerBackdrop';
import { createDetailsTrailer, DETAILS_TRAILER_DELAY_MS } from './detailsTrailer';

const item = { Id: 'movie1', RemoteTrailers: [ { Url: 'https://www.youtube.com/watch?v=abc12345678' } ] };

function handle(): TrailerBackdrop & { cancel: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } {
    return { cancel: vi.fn(), destroy: vi.fn(), playing: false } as never;
}

/** A host that counts as displayed: jsdom has no layout, so offsetParent is stubbed. */
function visibleHost(): HTMLElement {
    const host = document.createElement('div');
    Object.defineProperty(host, 'offsetParent', { value: document.body });
    return host;
}

function hiddenHost(): HTMLElement {
    return document.createElement('div');
}

describe('createDetailsTrailer', () => {
    let playbackStartListener: (() => void) | undefined;
    let unsubscribe: ReturnType<typeof vi.fn>;
    let subscribe: (listener: () => void) => () => void;

    beforeEach(() => {
        vi.clearAllMocks();
        playbackStartListener = undefined;
        unsubscribe = vi.fn();
        subscribe = vi.fn((listener: () => void) => {
            playbackStartListener = listener;
            return unsubscribe;
        });
        vi.mocked(getTrailerVideoId).mockReturnValue('abc12345678');
        vi.mocked(armTrailerBackdrop).mockImplementation(() => handle());
    });

    it('arms a trailer with the item video, a 7 second delay and the mute button when the host is visible', () => {
        const trailer = createDetailsTrailer(subscribe);
        const host = visibleHost();

        trailer.arm(host, item, true);

        expect(DETAILS_TRAILER_DELAY_MS).toBe(7000);
        expect(armTrailerBackdrop).toHaveBeenCalledWith({
            host,
            videoId: 'abc12345678',
            delayMs: 7000,
            showMuteButton: true
        });
    });

    it('leaves a trailer already armed for the same host and video running', () => {
        const trailer = createDetailsTrailer(subscribe);
        const host = visibleHost();

        trailer.arm(host, item, true);
        trailer.arm(host, item, true);

        expect(armTrailerBackdrop).toHaveBeenCalledTimes(1);
    });

    it('cancels the old trailer and arms again when the video changes', () => {
        const first = handle();
        const second = handle();
        vi.mocked(armTrailerBackdrop).mockReturnValueOnce(first).mockReturnValueOnce(second);
        const trailer = createDetailsTrailer(subscribe);
        const host = visibleHost();

        trailer.arm(host, item, true);
        vi.mocked(getTrailerVideoId).mockReturnValue('zzz12345678');
        trailer.arm(host, item, true);

        expect(first.cancel).toHaveBeenCalledTimes(1);
        expect(armTrailerBackdrop).toHaveBeenCalledTimes(2);
    });

    it('does not arm when the item has no trailer video', () => {
        vi.mocked(getTrailerVideoId).mockReturnValue(null);
        const trailer = createDetailsTrailer(subscribe);

        trailer.arm(visibleHost(), item, true);

        expect(armTrailerBackdrop).not.toHaveBeenCalled();
    });

    it('does not arm when the host is missing or not displayed', () => {
        const trailer = createDetailsTrailer(subscribe);

        trailer.arm(null, item, true);
        trailer.arm(hiddenHost(), item, true);

        expect(armTrailerBackdrop).not.toHaveBeenCalled();
    });

    it('does not arm when the banner is not enabled for this page', () => {
        const trailer = createDetailsTrailer(subscribe);

        trailer.arm(visibleHost(), item, false);

        expect(armTrailerBackdrop).not.toHaveBeenCalled();
    });

    it('cancels the active trailer when cancel is called', () => {
        const active = handle();
        vi.mocked(armTrailerBackdrop).mockReturnValueOnce(active);
        const trailer = createDetailsTrailer(subscribe);
        trailer.arm(visibleHost(), item, true);

        trailer.cancel();

        expect(active.cancel).toHaveBeenCalledTimes(1);
    });

    it('cancels the previous trailer when the page re-arms for another render', () => {
        const first = handle();
        const second = handle();
        vi.mocked(armTrailerBackdrop).mockReturnValueOnce(first).mockReturnValueOnce(second);
        const trailer = createDetailsTrailer(subscribe);

        trailer.arm(visibleHost(), item, true);
        trailer.arm(visibleHost(), item, true);

        expect(first.cancel).toHaveBeenCalledTimes(1);
        expect(second.cancel).not.toHaveBeenCalled();
        expect(armTrailerBackdrop).toHaveBeenCalledTimes(2);
    });

    it('cancels without arming when re-rendered with no trailer', () => {
        const active = handle();
        vi.mocked(armTrailerBackdrop).mockReturnValueOnce(active);
        const trailer = createDetailsTrailer(subscribe);
        trailer.arm(visibleHost(), item, true);

        trailer.arm(visibleHost(), item, false);

        expect(active.cancel).toHaveBeenCalledTimes(1);
        expect(armTrailerBackdrop).toHaveBeenCalledTimes(1);
    });

    it('cancels the active trailer when playback starts', () => {
        const active = handle();
        vi.mocked(armTrailerBackdrop).mockReturnValueOnce(active);
        const trailer = createDetailsTrailer(subscribe);
        trailer.arm(visibleHost(), item, true);

        playbackStartListener?.();

        expect(active.cancel).toHaveBeenCalledTimes(1);
    });

    it('subscribes to playback start once when created', () => {
        createDetailsTrailer(subscribe);

        expect(subscribe).toHaveBeenCalledTimes(1);
    });

    it('removes the playback start subscription and cancels the active trailer on dispose', () => {
        const active = handle();
        vi.mocked(armTrailerBackdrop).mockReturnValueOnce(active);
        const trailer = createDetailsTrailer(subscribe);
        trailer.arm(visibleHost(), item, true);

        trailer.dispose();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(active.cancel).toHaveBeenCalledTimes(1);
    });
});
