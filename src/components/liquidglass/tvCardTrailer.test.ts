import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { arm, getItem, getApiClient, layout } = vi.hoisted(() => ({
    arm: vi.fn<(options: unknown) => { cancel: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; playing: boolean }>(() => ({ cancel: vi.fn(), destroy: vi.fn(), playing: false })),
    getItem: vi.fn(),
    getApiClient: vi.fn(),
    layout: { tv: true, liquidGlass: true }
}));

vi.mock('../layoutManager', () => ({
    default: {
        get tv() {
            return layout.tv;
        }
    }
}));
vi.mock('../../themes/liquidglass/isLiquidGlass', () => ({
    isLiquidGlass: () => layout.liquidGlass
}));
vi.mock('../../lib/jellyfin-apiclient', () => ({
    ServerConnections: { getApiClient }
}));
vi.mock('../playback/playbackmanager', () => ({ playbackManager: {} }));
vi.mock('../../lib/globalize', () => ({
    default: {
        translate: (key: string) => key
    }
}));
vi.mock('./trailerBackdrop', async importOriginal => ({
    ...(await importOriginal<typeof import('./trailerBackdrop')>()),
    armTrailerBackdrop: arm
}));

import Events from '../../utils/events';
import { playbackManager } from '../playback/playbackmanager';

import { initTvCardTrailer } from './tvCardTrailer';

const VIDEO_ID = 'dQw4w9WgXcQ';
const TRAILER_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const DELAY_MS = 7000;
const FETCH_AFTER_MS = 5000;

const disposers: (() => void)[] = [];

function init(): () => void {
    const dispose = initTvCardTrailer();
    disposers.push(dispose);
    return dispose;
}

function addCard(id: string, type = 'Movie', serverId = 'srv'): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = id;
    card.dataset.type = type;
    card.dataset.serverid = serverId;
    const cardBox = document.createElement('div');
    cardBox.className = 'cardBox';
    const cardScalable = document.createElement('div');
    cardScalable.className = 'cardScalable';
    cardBox.appendChild(cardScalable);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'focusable';
    button.textContent = 'Play';
    card.append(cardBox, button);
    document.body.append(card);
    return card;
}

function buttonOf(card: HTMLElement): HTMLElement {
    const button = card.querySelector<HTMLElement>('button');
    if (!button) throw new Error('card has no button');
    return button;
}

function focusIn(target: Element): void {
    target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}

function focusOut(target: Element, relatedTarget: EventTarget | null = null): void {
    target.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget }));
}

function trailerAt(index = 0): { cancel: ReturnType<typeof vi.fn> } {
    const trailer = arm.mock.results[index]?.value;
    if (!trailer) throw new Error('no trailer was armed');
    return trailer;
}

// Lets the chained promises inside the module settle; timers are faked, so only microtasks run here.
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

// Holds focus on a card for the dwell time that starts the item fetch.
async function dwell(ms = FETCH_AFTER_MS): Promise<void> {
    vi.advanceTimersByTime(ms);
    await settle();
}

function deferredItem(): { promise: Promise<BaseItemDto>; resolve: (item: BaseItemDto) => void } {
    let resolve: (item: BaseItemDto) => void = () => undefined;
    const promise = new Promise<BaseItemDto>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('initTvCardTrailer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        layout.tv = true;
        layout.liquidGlass = true;
        getItem.mockReset();
        getItem.mockResolvedValue({ Id: 'm1', RemoteTrailers: [{ Url: TRAILER_URL }] });
        getApiClient.mockReset();
        getApiClient.mockReturnValue({ getCurrentUserId: () => 'u', getItem });
        arm.mockClear();
    });

    afterEach(() => {
        for (const dispose of disposers.splice(0)) dispose();
        document.body.innerHTML = '';
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does not arm when the layout is not TV', async () => {
        layout.tv = false;
        init();
        const card = addCard('m1');
        focusIn(buttonOf(card));
        await dwell();

        expect(getItem).not.toHaveBeenCalled();
        expect(arm).not.toHaveBeenCalled();
    });

    it('does not arm when the Liquid Glass theme is not active', async () => {
        layout.liquidGlass = false;
        init();
        const card = addCard('m1');
        focusIn(buttonOf(card));
        await dwell();

        expect(arm).not.toHaveBeenCalled();
    });

    it('arms when the theme becomes Liquid Glass after init', async () => {
        layout.liquidGlass = false;
        init();
        layout.liquidGlass = true;
        const card = addCard('m1');
        focusIn(buttonOf(card));
        await dwell();

        expect(arm).toHaveBeenCalledTimes(1);
    });

    it('fetches a focused movie after 5 s of dwell and arms its trailer on the card artwork', async () => {
        init();
        const card = addCard('m1');
        focusIn(buttonOf(card));
        await settle();
        expect(getItem).not.toHaveBeenCalled();

        await dwell();

        expect(getApiClient).toHaveBeenCalledWith('srv');
        expect(getItem).toHaveBeenCalledWith('u', 'm1');
        expect(arm).toHaveBeenCalledTimes(1);
        const options = arm.mock.calls[0]?.[0] as { host: HTMLElement; videoId: string; delayMs: number; showMuteButton: boolean };
        expect(options.host).toBe(card.querySelector('.cardScalable'));
        expect(options.videoId).toBe(VIDEO_ID);
        expect(options.delayMs).toBe(DELAY_MS - FETCH_AFTER_MS);
        expect(options.showMuteButton).toBe(false);
    });

    it('arms with the delay left after the 5 s dwell, measured from the focus', async () => {
        init();
        const card = addCard('m1');
        focusIn(buttonOf(card));
        await dwell();

        expect(arm.mock.calls[0]?.[0]).toMatchObject({ delayMs: 2000 });
    });

    it('arms with no delay when the fetch resolves after 7 s from the focus', async () => {
        const pending = deferredItem();
        getItem.mockReturnValueOnce(pending.promise);
        init();
        const card = addCard('m1');
        focusIn(buttonOf(card));
        await dwell();
        await dwell(3000);
        pending.resolve({ Id: 'm1', RemoteTrailers: [{ Url: TRAILER_URL }] } as BaseItemDto);
        await settle();

        expect(arm.mock.calls[0]?.[0]).toMatchObject({ delayMs: 0 });
    });

    it('ignores cards that are not movies', async () => {
        init();
        const card = addCard('s1', 'Series');
        focusIn(buttonOf(card));
        await dwell();

        expect(getItem).not.toHaveBeenCalled();
        expect(arm).not.toHaveBeenCalled();
    });

    it('does not fetch when focus leaves the card before the 5 s dwell ends', async () => {
        init();
        const card = addCard('m1');
        const button = buttonOf(card);
        focusIn(button);
        await dwell(3000);
        focusOut(button);
        await dwell();

        expect(getItem).not.toHaveBeenCalled();
    });

    it('does not fetch a card that was removed before its dwell ended', async () => {
        init();
        const card = addCard('m1');
        focusIn(buttonOf(card));
        card.remove();
        await dwell();

        expect(getItem).not.toHaveBeenCalled();
    });

    it('reuses the cached video ID when the same movie is focused again', async () => {
        init();
        const card = addCard('m1');
        const button = buttonOf(card);
        focusIn(button);
        await dwell();
        focusOut(button);
        focusIn(button);
        await dwell();

        expect(getItem).toHaveBeenCalledTimes(1);
        expect(arm).toHaveBeenCalledTimes(2);
    });

    it('shares one in-flight fetch between focuses of the same item', async () => {
        const pending = deferredItem();
        getItem.mockReturnValueOnce(pending.promise);
        init();
        const card = addCard('m1');
        const button = buttonOf(card);
        focusIn(button);
        await dwell();
        focusOut(button);
        focusIn(button);
        await dwell();
        pending.resolve({ Id: 'm1', RemoteTrailers: [{ Url: TRAILER_URL }] } as BaseItemDto);
        await settle();

        expect(getItem).toHaveBeenCalledTimes(1);
        expect(arm).toHaveBeenCalledTimes(1);
    });

    it('does not arm when the item has no YouTube trailer', async () => {
        getItem.mockResolvedValueOnce({ Id: 'm1', RemoteTrailers: [{ Url: 'https://vimeo.com/1' }] });
        init();
        const card = addCard('m1');
        focusIn(buttonOf(card));
        await dwell();

        expect(arm).not.toHaveBeenCalled();
    });

    it('cancels the trailer when focus leaves the card', async () => {
        init();
        const card = addCard('m1');
        const button = buttonOf(card);
        focusIn(button);
        await dwell();

        focusOut(button, document.body);

        expect(trailerAt().cancel).toHaveBeenCalledTimes(1);
    });

    it('keeps the trailer when focus moves to another element inside the same card', async () => {
        init();
        const card = addCard('m1');
        const button = buttonOf(card);
        focusIn(button);
        await dwell();

        focusOut(button, card.querySelector('.cardBox'));

        expect(trailerAt().cancel).not.toHaveBeenCalled();
    });

    it('keeps the trailer on an arrow key, so edge-of-row keys do not kill it', async () => {
        init();
        const card = addCard('m1');
        focusIn(buttonOf(card));
        await dwell();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));

        expect(trailerAt().cancel).not.toHaveBeenCalled();
    });

    it('cancels the trailer when focus moves to another card', async () => {
        init();
        const first = addCard('m1');
        focusIn(buttonOf(first));
        await dwell();
        const second = addCard('m2');
        focusOut(buttonOf(first), buttonOf(second));
        focusIn(buttonOf(second));

        expect(trailerAt().cancel).toHaveBeenCalledTimes(1);
    });

    it('cancels the trailer on hashchange', async () => {
        init();
        const card = addCard('m1');
        focusIn(buttonOf(card));
        await dwell();

        window.dispatchEvent(new Event('hashchange'));

        expect(trailerAt().cancel).toHaveBeenCalledTimes(1);
    });

    it('cancels the trailer when playback starts', async () => {
        init();
        const card = addCard('m1');
        focusIn(buttonOf(card));
        await dwell();

        Events.trigger(playbackManager, 'playbackstart', []);

        expect(trailerAt().cancel).toHaveBeenCalledTimes(1);
    });

    it('cancels the trailer when it starts playing and the card has left the page', async () => {
        init();
        const card = addCard('m1');
        focusIn(buttonOf(card));
        await dwell();
        card.remove();

        const options = arm.mock.calls[0]?.[0] as { onPlaying?: () => void };
        options.onPlaying?.();

        expect(trailerAt().cancel).toHaveBeenCalledTimes(1);
    });

    it('does not arm a card whose focus left while its item was loading', async () => {
        const pending = deferredItem();
        getItem.mockReturnValueOnce(pending.promise);
        init();
        const card = addCard('m1');
        const button = buttonOf(card);
        focusIn(button);
        await dwell();
        focusOut(button);
        pending.resolve({ Id: 'm1', RemoteTrailers: [{ Url: TRAILER_URL }] } as BaseItemDto);
        await settle();

        expect(arm).not.toHaveBeenCalled();
    });

    it('warns on a failed fetch, does not arm, and fetches again on the next focus', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const error = new Error('offline');
        getItem.mockRejectedValueOnce(error);
        init();
        const card = addCard('m1');
        const button = buttonOf(card);
        focusIn(button);
        await dwell();

        expect(warn).toHaveBeenCalledWith('[tv-trailer] item fetch failed', error);
        expect(arm).not.toHaveBeenCalled();

        focusOut(button);
        focusIn(button);
        await dwell();

        expect(getItem).toHaveBeenCalledTimes(2);
        expect(arm).toHaveBeenCalledTimes(1);
    });

    it('caches a successful fetch with no trailer, so a refocus does not fetch again', async () => {
        getItem.mockResolvedValueOnce({ Id: 'm1', RemoteTrailers: [] });
        init();
        const card = addCard('m1');
        const button = buttonOf(card);
        focusIn(button);
        await dwell();
        focusOut(button);
        focusIn(button);
        await dwell();

        expect(getItem).toHaveBeenCalledTimes(1);
        expect(arm).not.toHaveBeenCalled();
    });

    it('drops the oldest cached item once more than 200 items have been fetched', async () => {
        init();
        for (let i = 0; i <= 200; i += 1) {
            const card = addCard(`m${i}`);
            focusIn(buttonOf(card));
            await dwell();
        }
        expect(getItem).toHaveBeenCalledTimes(201);

        const newest = document.querySelector<HTMLElement>('.card[data-id="m200"]');
        if (!newest) throw new Error('newest card missing');
        focusOut(buttonOf(newest));
        focusIn(buttonOf(newest));
        await dwell();
        expect(getItem).toHaveBeenCalledTimes(201);

        const oldest = document.querySelector<HTMLElement>('.card[data-id="m0"]');
        if (!oldest) throw new Error('oldest card missing');
        focusIn(buttonOf(oldest));
        await dwell();
        expect(getItem).toHaveBeenCalledTimes(202);
    });

    it('removes every listener and cancels the trailer when disposed', async () => {
        const dispose = init();
        const card = addCard('m1');
        const button = buttonOf(card);
        focusIn(button);
        await dwell();
        const trailer = trailerAt();
        const removeSpy = vi.spyOn(document, 'removeEventListener');
        const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');
        const offSpy = vi.spyOn(Events, 'off');

        dispose();

        expect(trailer.cancel).toHaveBeenCalled();
        expect(removeSpy).toHaveBeenCalledWith('focusin', expect.any(Function));
        expect(removeSpy).toHaveBeenCalledWith('focusout', expect.any(Function));
        expect(windowRemoveSpy).toHaveBeenCalledWith('hashchange', expect.any(Function));
        expect(offSpy).toHaveBeenCalledWith(playbackManager, 'playbackstart', expect.any(Function));

        focusOut(button);
        focusIn(button);
        await dwell();
        expect(arm).toHaveBeenCalledTimes(1);
    });
});
