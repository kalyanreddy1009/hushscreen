import { ServerConnections } from '../../lib/jellyfin-apiclient';
import layoutManager from '../layoutManager';
import { playbackManager } from '../playback/playbackmanager';
import { isLiquidGlass } from '../../themes/liquidglass/isLiquidGlass';
import Events from '../../utils/events';

import { armTrailerBackdrop, DEFAULT_DELAY_MS, getTrailerVideoId, type TrailerBackdrop } from './trailerBackdrop';

const CARD_SELECTOR = '.card[data-id]';
const CARD_HOST_SELECTOR = '.cardScalable';
const MOVIE_TYPE = 'Movie';
/** Focus must rest on a card this long before its item is fetched, so fast scrolling costs no requests. */
const FETCH_AFTER_MS = 5000;
/** Most item IDs kept in the trailer cache; the oldest entry is dropped first. */
const MAX_CACHED_ITEMS = 200;

interface FocusedCard {
    card: HTMLElement;
    focusedAt: number;
    fetchTimer?: ReturnType<typeof setTimeout>;
}

function cardOf(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>(CARD_SELECTOR) : null;
}

/**
 * TV only: after the user rests on a focused movie card for 5 seconds, fetches its trailer and plays it
 * behind the card artwork once the card has been focused for 7 seconds in total.
 * Listeners attach at init; the TV layout and Liquid Glass theme are checked on each focus, because the
 * theme is applied after startup. Returns a disposer that removes every listener and cancels any trailer.
 */
export function initTvCardTrailer(): () => void {
    // Item ID to its trailer video ID (or null). The promise is cached while in flight, so each item is fetched once.
    const videoIds = new Map<string, Promise<string | null>>();
    let focused: FocusedCard | undefined;
    let trailer: TrailerBackdrop | undefined;

    const cancelTrailer = (): void => {
        trailer?.cancel();
        trailer = undefined;
    };

    // Clearing the focus record also drops any pending fetch timer for it.
    const leaveCard = (): void => {
        clearTimeout(focused?.fetchTimer);
        cancelTrailer();
        focused = undefined;
    };

    const fetchVideoId = async (serverId: string, itemId: string): Promise<string | null> => {
        try {
            const apiClient = ServerConnections.getApiClient(serverId);
            const item = await apiClient.getItem(apiClient.getCurrentUserId(), itemId);
            return getTrailerVideoId(item);
        } catch (err) {
            console.warn('[tv-trailer] item fetch failed', err);
            throw err;
        }
    };

    const resolveVideoId = (serverId: string, itemId: string): Promise<string | null> => {
        const cached = videoIds.get(itemId);
        if (cached) return cached;
        const oldest = videoIds.keys().next();
        if (videoIds.size >= MAX_CACHED_ITEMS && !oldest.done) videoIds.delete(oldest.value);
        // A failed fetch is dropped from the cache so the next focus retries it; a successful null is kept.
        const pending = fetchVideoId(serverId, itemId).catch((): null => {
            videoIds.delete(itemId);
            return null;
        });
        videoIds.set(itemId, pending);
        return pending;
    };

    const armCard = async (entry: FocusedCard): Promise<void> => {
        const { card } = entry;
        const videoId = await resolveVideoId(card.dataset.serverid ?? '', card.dataset.id ?? '');
        const host = card.querySelector<HTMLElement>(CARD_HOST_SELECTOR);
        if (!videoId || !host || focused !== entry || !card.isConnected) return;
        const elapsed = Date.now() - entry.focusedAt;
        trailer = armTrailerBackdrop({
            host,
            videoId,
            delayMs: Math.max(0, DEFAULT_DELAY_MS - elapsed),
            showMuteButton: false,
            onPlaying: () => {
                if (!card.isConnected) leaveCard();
            }
        });
    };

    const onFocusIn = (e: FocusEvent): void => {
        const card = cardOf(e.target);
        if (card && focused?.card === card) return;
        leaveCard();
        if (!card || !layoutManager.tv || !isLiquidGlass() || card.dataset.type !== MOVIE_TYPE) return;
        const entry: FocusedCard = { card, focusedAt: Date.now() };
        entry.fetchTimer = setTimeout(() => {
            entry.fetchTimer = undefined;
            if (!entry.card.isConnected) {
                leaveCard();
                return;
            }
            void armCard(entry);
        }, FETCH_AFTER_MS);
        focused = entry;
    };

    const onFocusOut = (e: FocusEvent): void => {
        if (!focused) return;
        if (e.relatedTarget instanceof Node && focused.card.contains(e.relatedTarget)) return;
        leaveCard();
    };

    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    window.addEventListener('hashchange', leaveCard);
    Events.on(playbackManager, 'playbackstart', leaveCard);

    return () => {
        document.removeEventListener('focusin', onFocusIn);
        document.removeEventListener('focusout', onFocusOut);
        window.removeEventListener('hashchange', leaveCard);
        Events.off(playbackManager, 'playbackstart', leaveCard);
        leaveCard();
    };
}
