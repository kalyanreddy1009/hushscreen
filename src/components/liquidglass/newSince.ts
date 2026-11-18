import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import escapeHtml from 'escape-html';
import type { ApiClient } from 'jellyfin-apiclient';

import { EventType } from '../../constants/eventType';
import globalize from '../../lib/globalize';
import { ServerConnections } from '../../lib/jellyfin-apiclient';
import { currentSettings } from '../../scripts/settings/userSettings';
import { isLiquidGlass } from '../../themes/liquidglass/isLiquidGlass';
import Events from '../../utils/events';
import layoutManager from '../layoutManager';
import { appRouter } from '../router/appRouter';

const SLOT_SELECTOR = '.lg-header-bell';
const HEADER_SELECTOR = '.skinHeader';
const BELL_CLASS = 'lg-bell';
const DOT_CLASS = 'lg-bell__dot';
const POPOVER_CLASS = 'lg-new-since';
const POPOVER_OPEN_CLASS = 'is-open';
const ROW_SELECTOR = '.lg-new-since__row';
const FETCH_LIMIT = 30;
const FETCH_FIELDS = 'DateCreated,PrimaryImageAspectRatio';
const FETCH_IMAGE_TYPES = 'Primary,Thumb,Backdrop';
const THUMB_MAX_WIDTH = 160;
const FETCH_THROTTLE_MS = 5 * 60 * 1000;
/** Matches the popover close transition in _bell.scss. */
const CLOSE_MS = 180;
const POPOVER_GAP_PX = 8;
const SEEN_SETTING_PREFIX = 'lgNewSinceSeen-';
const HOME_ROUTE = /^#!?\/?home(?:[?/]|$)/i;

interface ThumbSource {
    type: 'Primary' | 'Thumb' | 'Backdrop';
    tag: string | undefined;
}

// Module state: one bell and one popover per page; listeners are added on mount and removed on unmount
let bell: HTMLButtonElement | undefined;
let popover: HTMLElement | undefined;
let observer: MutationObserver | undefined;
let observedHeader: Element | undefined;
let removeListeners: (() => void) | undefined;
let closeTimer: number | undefined;
let open = false;
let signedIn = false;
let apiClient: ApiClient | undefined;
/** Server and user the cached titles belong to: `${serverId}|${userId}`. */
let fetchedKey: string | undefined;
let seenAt: number | undefined;
let lastFetchOk = false;
let items: BaseItemDto[] = [];
/** Items shown in the popover while it is open; the list does not change until it closes. */
let shown: BaseItemDto[] = [];
let lastFetchAt: number | undefined;
let hiddenAt: number | undefined;

function attr(value: string | null | undefined): string {
    return escapeHtml(value ?? '');
}

function seenKey(key: string): string {
    return `${SEEN_SETTING_PREFIX}${key}`;
}

function readSeen(key: string): number | undefined {
    const raw = currentSettings.get(seenKey(key), false);
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

function writeSeen(key: string, time: number): void {
    currentSettings.set(seenKey(key), String(time), false);
}

function isNewer(item: BaseItemDto, since: number): boolean {
    const created = Date.parse(item.DateCreated ?? '');
    return Number.isFinite(created) && created > since;
}

/** Items added after the last visit. Empty until a last visit is known. */
function newItems(): BaseItemDto[] {
    if (seenAt === undefined) return [];
    const since = seenAt;
    return items.filter(item => isNewer(item, since));
}

function canShow(): boolean {
    return isLiquidGlass() && !layoutManager.tv && signedIn;
}

function updateBell(): void {
    if (!bell) return;
    const count = newItems().length;
    const title = globalize.translate('LiquidGlassNewSinceLastVisit');
    const label = count > 0 ?
        `${title}, ${globalize.translate('LiquidGlassNewTitlesCount', count)}` :
        title;
    bell.setAttribute('aria-label', label);
    const dot = bell.querySelector<HTMLElement>(`.${DOT_CLASS}`);
    if (dot) dot.hidden = count === 0;
}

function createBell(slot: HTMLElement): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BELL_CLASS;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = `<span class="material-icons lg-bell__icon" aria-hidden="true">notifications</span><span class="${DOT_CLASS}" aria-hidden="true" hidden></span>`;
    button.addEventListener('click', onBellClick);
    slot.innerHTML = '';
    slot.append(button);
    return button;
}

function createPopover(): HTMLElement {
    const element = document.createElement('div');
    element.className = POPOVER_CLASS;
    element.hidden = true;
    element.tabIndex = -1;
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', globalize.translate('LiquidGlassNewSinceLastVisit'));
    element.addEventListener('click', onListClick);
    document.body.append(element);
    return element;
}

/** Title for the item: episodes show the series, with the episode name as the secondary line. */
function describeItem(item: BaseItemDto): { title: string, subtitle: string } {
    const isEpisode = item.Type === 'Episode' && Boolean(item.SeriesName);
    if (isEpisode) return { title: item.SeriesName ?? '', subtitle: item.Name ?? '' };
    return { title: item.Name ?? '', subtitle: '' };
}

function thumbUrl(item: BaseItemDto): string | undefined {
    if (!apiClient || !item.Id) return undefined;
    const sources: ThumbSource[] = [
        { type: 'Primary', tag: item.ImageTags?.Primary },
        { type: 'Thumb', tag: item.ImageTags?.Thumb },
        { type: 'Backdrop', tag: item.BackdropImageTags?.[0] }
    ];
    const source = sources.find(candidate => candidate.tag);
    if (!source?.tag) return undefined;
    return apiClient.getScaledImageUrl(item.Id, { type: source.type, maxWidth: THUMB_MAX_WIDTH, tag: source.tag });
}

function rowHtml(item: BaseItemDto): string {
    const { title, subtitle } = describeItem(item);
    const src = thumbUrl(item);
    const thumb = src ?
        `<img class="lg-new-since__thumb" src="${attr(src)}" alt="" loading="lazy">` :
        '<span class="lg-new-since__thumb lg-new-since__thumb--empty" aria-hidden="true"></span>';
    const secondary = subtitle ? `<span class="lg-new-since__subtitle">${attr(subtitle)}</span>` : '';
    const href = `#/details?id=${encodeURIComponent(item.Id ?? '')}`;
    return `<li><a class="lg-new-since__row" href="${attr(href)}" data-id="${attr(item.Id)}">${thumb}<span class="lg-new-since__text"><span class="lg-new-since__name">${attr(title)}</span>${secondary}</span></a></li>`;
}

function renderPopoverBody(list: BaseItemDto[]): void {
    if (!popover) return;
    const heading = `<div class="lg-new-since__heading">${attr(globalize.translate('LiquidGlassNewSinceLastVisit'))}</div>`;
    const body = list.length > 0 ?
        `<ul class="lg-new-since__list">${list.map(rowHtml).join('')}</ul>` :
        `<p class="lg-new-since__empty">${attr(globalize.translate('LiquidGlassNothingNew'))}</p>`;
    popover.innerHTML = heading + body;
}

function positionPopover(anchor: HTMLElement): void {
    if (!popover) return;
    const rect = anchor.getBoundingClientRect();
    popover.style.top = `${rect.bottom + POPOVER_GAP_PX}px`;
    popover.style.right = `${Math.max(0, window.innerWidth - rect.right)}px`;
}

function focusables(): HTMLElement[] {
    if (!popover) return [];
    return Array.from(popover.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
}

/** Records the visit: items added up to now stop counting as new. Only after a successful fetch. */
function markSeen(): void {
    if (!fetchedKey || !lastFetchOk) return;
    const now = Date.now();
    seenAt = now;
    writeSeen(fetchedKey, now);
    updateBell();
}

function openPopover(): void {
    if (!popover || !bell || open) return;
    // A page that rebuilt <body> can drop the popover; put it back before showing it
    if (!popover.isConnected) document.body.append(popover);
    shown = newItems();
    renderPopoverBody(shown);
    markSeen();
    positionPopover(bell);
    popover.hidden = false;
    window.clearTimeout(closeTimer);
    // Force a style flush so the open state transitions from the closed state
    popover.getBoundingClientRect();
    popover.classList.add(POPOVER_OPEN_CLASS);
    open = true;
    bell.setAttribute('aria-expanded', 'true');
    const [ first ] = focusables();
    (first ?? popover).focus();
}

/** Closes the popover. Focus returns to the bell only when asked (Escape). */
function closePopover(restoreFocus: boolean): void {
    if (!popover || !open) return;
    open = false;
    popover.classList.remove(POPOVER_OPEN_CLASS);
    bell?.setAttribute('aria-expanded', 'false');
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
        if (popover && !open) popover.hidden = true;
    }, CLOSE_MS);
    if (restoreFocus) bell?.focus();
}

function onBellClick(): void {
    if (open) closePopover(true);
    else openPopover();
}

function onListClick(event: MouseEvent): void {
    if (!(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLAnchorElement>(ROW_SELECTOR);
    if (!row || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const item = shown.find(candidate => candidate.Id === row.dataset.id);
    if (!item) return;
    event.preventDefault();
    closePopover(false);
    appRouter.showItem(item);
}

/** Keeps Tab inside the open popover. */
function trapFocus(event: KeyboardEvent): void {
    if (!popover) return;
    const stops = focusables();
    const active = document.activeElement;
    if (stops.length === 0) {
        event.preventDefault();
        popover.focus();
        return;
    }
    const first = stops[0];
    const last = stops[stops.length - 1];
    const inside = active instanceof HTMLElement && popover.contains(active);
    if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
    }
}

function onKeydown(event: KeyboardEvent): void {
    if (!open) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        closePopover(true);
    } else if (event.key === 'Tab') {
        trapFocus(event);
    }
}

function onDocumentClick(event: MouseEvent): void {
    if (!open || !(event.target instanceof Node)) return;
    if (popover?.contains(event.target) || bell?.contains(event.target)) return;
    closePopover(false);
}

function onHashChange(): void {
    closePopover(false);
}

/** Drops the previous server's or user's titles and visit time when the signed-in key changes. */
function switchTo(key: string): void {
    fetchedKey = key;
    lastFetchAt = 0;
    items = [];
    lastFetchOk = false;
    seenAt = undefined;
}

/** Fetches at most once per FETCH_THROTTLE_MS for each server and user. */
async function refreshIfStale(): Promise<void> {
    let client: ApiClient;
    try {
        client = await ServerConnections.getCurrentApiClientAsync();
    } catch (error) {
        console.warn('[NewSince] No server connection; the bell stays hidden.', error);
        signedIn = false;
        syncSlot();
        return;
    }

    const key = `${client.serverId()}|${client.getCurrentUserId()}`;
    if (key !== fetchedKey) switchTo(key);
    if (lastFetchAt !== undefined && Date.now() - lastFetchAt < FETCH_THROTTLE_MS) return;
    // Set before the fetch starts so a second call during it is throttled too
    lastFetchAt = Date.now();
    await refresh(client, key);
}

function onViewShow(): void {
    closePopover(false);
    if (HOME_ROUTE.test(window.location.hash)) void refreshIfStale();
}

function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
    }
    if (hiddenAt !== undefined && Date.now() - hiddenAt >= FETCH_THROTTLE_MS) void refreshIfStale();
    hiddenAt = undefined;
}

/** Reads the visit time for this server and user, starting one on first run so old titles are not flagged. */
function initialiseSeen(key: string): void {
    const stored = readSeen(key);
    if (stored !== undefined) {
        seenAt = stored;
        return;
    }
    seenAt = Date.now();
    writeSeen(key, seenAt);
}

async function fetchLatest(client: ApiClient): Promise<BaseItemDto[]> {
    const latest = await client.getLatestItems({
        Limit: FETCH_LIMIT,
        Fields: FETCH_FIELDS,
        GroupItems: true,
        EnableImageTypes: FETCH_IMAGE_TYPES
    });
    return latest ?? [];
}

async function refresh(client: ApiClient, key: string): Promise<void> {
    const userId = client.getCurrentUserId();
    signedIn = Boolean(userId);
    apiClient = client;
    if (!signedIn) {
        items = [];
        syncSlot();
        return;
    }

    initialiseSeen(key);
    try {
        const latest = await fetchLatest(client);
        // A response for a server or user that is no longer current is dropped
        if (key !== fetchedKey) return;
        items = latest;
        lastFetchOk = true;
    } catch (error) {
        if (key !== fetchedKey) return;
        console.warn('[NewSince] Could not load recent titles; the bell shows no new items.', error);
        items = [];
        lastFetchOk = false;
        // Lets the next viewshow retry instead of waiting out the throttle
        lastFetchAt = 0;
    }
    syncSlot();
}

/** Shows or hides the slot and keeps one bell in it. Runs on mount, unmount and every header re-render. */
function syncSlot(): void {
    const slot = document.querySelector<HTMLElement>(SLOT_SELECTOR);
    if (!slot) {
        closePopover(false);
        bell = undefined;
        return;
    }

    if (!canShow()) {
        closePopover(false);
        bell?.remove();
        bell = undefined;
        slot.hidden = true;
        return;
    }

    slot.hidden = false;
    if (bell && slot.contains(bell)) {
        updateBell();
        return;
    }
    closePopover(false);
    bell = createBell(slot);
    updateBell();
}

/**
 * Watches the header subtree, where the slot lives. Until the header exists, watches the direct
 * children of body so the header is picked up when it appears.
 */
function observeHeader(): void {
    if (!observer) return;
    const header = document.querySelector<HTMLElement>(HEADER_SELECTOR);
    if (header && header === observedHeader) return;
    observer.disconnect();
    if (header) {
        observer.observe(header, { childList: true, subtree: true });
        observedHeader = header;
    } else {
        observer.observe(document.body, { childList: true });
        observedHeader = undefined;
    }
}

function onDomChange(): void {
    observeHeader();
    syncSlot();
}

function mount(): void {
    if (removeListeners) {
        syncSlot();
        return;
    }
    popover ??= createPopover();

    document.addEventListener('keydown', onKeydown);
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('viewshow', onViewShow, true);
    window.addEventListener('hashchange', onHashChange);
    // The header is re-rendered by libraryMenu, so the slot is looked up again on every header change
    observer = new MutationObserver(onDomChange);
    observeHeader();
    removeListeners = () => {
        document.removeEventListener('keydown', onKeydown);
        document.removeEventListener('click', onDocumentClick);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        document.removeEventListener('viewshow', onViewShow, true);
        window.removeEventListener('hashchange', onHashChange);
    };

    syncSlot();
    void refreshIfStale();
}

function unmount(): void {
    window.clearTimeout(closeTimer);
    open = false;
    observer?.disconnect();
    observer = undefined;
    observedHeader = undefined;
    removeListeners?.();
    removeListeners = undefined;
    bell?.remove();
    bell = undefined;
    popover?.remove();
    popover = undefined;
    syncSlot();
}

function sync(): void {
    if (isLiquidGlass() && !layoutManager.tv) mount();
    else unmount();
}

/** Show the "New since your last visit" bell in the Liquid Glass header (not on TV). Call once. */
export function initNewSince(): void {
    Events.on(document, EventType.THEME_CHANGE, sync);
    // Layout can switch at runtime (e.g. rotating a tablet); sync is idempotent
    Events.on(layoutManager, 'modechange', sync);
    sync();
}
