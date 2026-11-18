import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import { EventType } from '../../constants/eventType';
import globalize from '../../lib/globalize';
import { ServerConnections } from '../../lib/jellyfin-apiclient';
import Events from '../../utils/events';
import layoutManager from '../../components/layoutManager';

import { isLiquidGlass } from '../../themes/liquidglass/isLiquidGlass';

export type LibraryKind = 'movies' | 'shows';
export type TabId = 'home' | LibraryKind | 'favorites';

interface TabDef {
    id: TabId
    icon: string
    labelKey: string
    /** Fixed hash route. */
    href?: string
    /** Resolved from the user's libraries of this kind (see buildTargets). */
    library?: LibraryKind
}

export const TABS: readonly TabDef[] = [
    { id: 'home', icon: 'home', labelKey: 'Home', href: '#/home' },
    { id: 'movies', icon: 'movie', labelKey: 'Movies', library: 'movies' },
    { id: 'shows', icon: 'tv', labelKey: 'Shows', library: 'shows' },
    // The stable home view has two tabs: 0 = Home, 1 = Favorites (controllers/home.js)
    { id: 'favorites', icon: 'favorite', labelKey: 'Favorites', href: '#/home?tab=1' }
];

export interface LibraryTarget {
    /** Where the Movies or Shows tab links. */
    href: string
    /** Ids of every library of this kind. A library page for any of them keeps the tab active. */
    libraryIds: readonly string[]
}

export type TabTargets = Readonly<Record<LibraryKind, LibraryTarget>>;

const HOME_TARGET: LibraryTarget = { href: '#/home', libraryIds: [] };
/** Used until the libraries load, and when they cannot be loaded. */
export const FALLBACK_TARGETS: TabTargets = { movies: HOME_TARGET, shows: HOME_TARGET };

const COLLECTION_TYPE: Record<LibraryKind, CollectionType> = {
    movies: CollectionType.Movies,
    shows: CollectionType.Tvshows
};
const LIBRARY_ROUTE: Record<LibraryKind, string> = { movies: 'movies', shows: 'tv' };
/** Cross-library list (controllers/list.js with no parent): every item of this type on the server. */
const COMBINED_ITEM_TYPE: Record<LibraryKind, string> = { movies: 'Movie', shows: 'Series' };
/** Route params that scope list.js to one item; without them the list spans all libraries. */
const LIST_SCOPE_PARAMS = [ 'genreId', 'musicGenreId', 'studioId', 'personId', 'parentId' ];
const LIBRARY_ROUTE_KINDS: Record<string, LibraryKind> = { movies: 'movies', tv: 'shows' };

export const BAR_CLASS = 'lg-tabbar';
export const ROOT_CLASS = 'lg-has-tabbar';
/** Root class on TV, where the bar sits at the top and only on the home page. */
export const TV_ROOT_CLASS = 'lg-has-topbar';
export const TOP_BAR_CLASS = 'lg-tabbar--top';
export const AWAY_CLASS = 'lg-tabbar--away';
/** TV: scrolling the page past this many pixels slides the bar out of the way. */
const TV_SCROLL_AWAY_PX = 40;

/** Raw value of one query parameter (ids and types are not percent-encoded), or null when absent. */
function queryValue(query: string, key: string): string | null {
    for (const pair of query.split('&')) {
        const [ name, value = '' ] = pair.split('=');
        if (name === key) return value;
    }
    return null;
}

/** Which tab a location hash belongs to, or null when none applies. */
export function getActiveTab(hash: string, targets: TabTargets = FALLBACK_TARGETS): TabId | null {
    const match = /^#!?\/?([^?/]*)(?:\/[^?]*)?(?:\?(.*))?$/.exec(hash);
    if (!match) return null;
    const route = match[1].toLowerCase();
    const query = match[2] ?? '';

    if (route === 'home') return queryValue(query, 'tab') === '1' ? 'favorites' : 'home';

    const libraryKind = LIBRARY_ROUTE_KINDS[route];
    if (libraryKind) {
        const topParentId = queryValue(query, 'topParentId') ?? '';
        return targets[libraryKind].libraryIds.includes(topParentId) ? libraryKind : null;
    }

    if (route === 'list' && !LIST_SCOPE_PARAMS.some(key => queryValue(query, key) !== null)) {
        const type = queryValue(query, 'type');
        if (type === COMBINED_ITEM_TYPE.movies) return 'movies';
        if (type === COMBINED_ITEM_TYPE.shows) return 'shows';
    }
    return null;
}

type ViewSummary = Pick<BaseItemDto, 'Id' | 'CollectionType'>;

function targetFor(kind: LibraryKind, libraryIds: string[]): LibraryTarget {
    if (libraryIds.length === 0) return HOME_TARGET;
    if (libraryIds.length > 1) {
        return { href: `#/list?type=${COMBINED_ITEM_TYPE[kind]}`, libraryIds };
    }
    const [ id ] = libraryIds;
    const href = `#/${LIBRARY_ROUTE[kind]}?topParentId=${encodeURIComponent(id)}&collectionType=${COLLECTION_TYPE[kind]}`;
    return { href, libraryIds };
}

/**
 * Movies/Shows targets from the user's views. One library links to its page; several link to the
 * cross-library list; none falls back to Home (the tab stays visible).
 */
export function buildTargets(views: readonly ViewSummary[]): TabTargets {
    const idsOf = (kind: LibraryKind): string[] => views.flatMap(view => (
        view.CollectionType === COLLECTION_TYPE[kind] && view.Id ? [ view.Id ] : []
    ));
    return {
        movies: targetFor('movies', idsOf('movies')),
        shows: targetFor('shows', idsOf('shows'))
    };
}

function hrefOf(tab: TabDef, targets: TabTargets): string {
    if (tab.library) return targets[tab.library].href;
    return tab.href ?? HOME_TARGET.href;
}

/** Build the tab bar. Pure: no listeners, so it can be rendered in tests. */
export function renderTabBar(
    active: TabId | null,
    translate: (key: string) => string,
    targets: TabTargets = FALLBACK_TARGETS
): HTMLElement {
    const nav = document.createElement('nav');
    nav.className = BAR_CLASS;
    nav.setAttribute('aria-label', translate('Menu'));

    for (const tab of TABS) {
        const label = translate(tab.labelKey);
        const item = document.createElement('a');
        item.className = 'lg-tabbar-item focusable';
        item.dataset.tab = tab.id;
        item.setAttribute('aria-label', label);
        item.setAttribute('href', hrefOf(tab, targets));
        if (tab.id === active) item.setAttribute('aria-current', 'page');

        const icon = document.createElement('span');
        icon.className = 'material-icons lg-tabbar-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = tab.icon;
        const text = document.createElement('span');
        text.className = 'lg-tabbar-label';
        text.textContent = label;
        item.append(icon, text);
        nav.append(item);
    }
    return nav;
}

/** Whether the bar belongs on the current page (library pages only; not in the video OSD). */
export function shouldShowBar(doc: Document = document): boolean {
    const header = doc.querySelector('.skinHeader');
    return doc.body.classList.contains('libraryDocument')
        && !header?.classList.contains('osdHeader')
        && !header?.classList.contains('hiddenViewMenuBar')
        && !doc.documentElement.classList.contains('hiddenViewMenuBar')
        && !doc.querySelector('.videoPlayerContainer');
}

/** Kept so the libraryMenu call site compiles. The bar no longer opens the library drawer. */
export interface TabBarOptions {
    openLibraries: () => void
}

let bar: HTMLElement | undefined;
let observer: MutationObserver | undefined;
let removeListeners: (() => void) | undefined;
let observedHeader: Element | undefined;
let targets: TabTargets = FALLBACK_TARGETS;
let cachedTargets: { key: string, promise: Promise<TabTargets> } | undefined;
/** The last failed load. Its key is not retried until RETRY_DELAY_MS has passed. */
let lastFailure: { key: string, failedAt: number } | undefined;
let warnedKey: string | undefined;
const RETRY_DELAY_MS = 30_000;

// React renders .skinHeader after this module loads, so it is observed lazily on first sight
function observeHeader(): void {
    const header = document.querySelector('.skinHeader');
    if (!observer || !header || header === observedHeader) return;
    observedHeader = header;
    observer.observe(header, { attributes: true, attributeFilter: [ 'class' ] });
}

function updateScrollState(): void {
    if (!bar) return;
    if (!layoutManager.tv) {
        // Phone and desktop never slide the bar away; clear a stale state after a layout switch
        if (bar.classList.contains(AWAY_CLASS)) bar.classList.remove(AWAY_CLASS);
        return;
    }
    bar.classList.toggle(AWAY_CLASS, window.scrollY > TV_SCROLL_AWAY_PX);
}

function update(): void {
    if (!bar) return;
    observeHeader();
    const tv = Boolean(layoutManager.tv);
    const active = getActiveTab(window.location.hash, targets);
    // TV: top-level sections live in a top bar on the root (home) screen only; Back returns there
    const visible = shouldShowBar() && (!tv || active === 'home' || active === 'favorites');
    bar.hidden = !visible;
    bar.classList.toggle(TOP_BAR_CLASS, tv);
    document.documentElement.classList.toggle(ROOT_CLASS, visible && !tv);
    document.documentElement.classList.toggle(TV_ROOT_CLASS, visible && tv);
    updateScrollState();

    bar.querySelectorAll<HTMLElement>('.lg-tabbar-item').forEach(item => {
        if (active && item.dataset.tab === active) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
    });
}

function applyTargets(nav: HTMLElement, resolved: TabTargets): void {
    nav.querySelectorAll<HTMLAnchorElement>('.lg-tabbar-item').forEach(item => {
        const tab = TABS.find(candidate => candidate.id === item.dataset.tab);
        if (tab) item.setAttribute('href', hrefOf(tab, resolved));
    });
}

type ApiClient = Awaited<ReturnType<typeof ServerConnections.getCurrentApiClientAsync>>;

async function fetchTargets(apiClient: ApiClient, userId: string): Promise<TabTargets> {
    const result = await apiClient.getUserViews({}, userId);
    return buildTargets(result.Items ?? []);
}

/**
 * Resolves the Movies/Shows targets once per server and user. The cache entry keeps the key it was
 * resolved for, so a navigation under the same key reuses it. A failed load is not cached. Without a
 * signed-in user nothing is fetched or cached, and the fallback targets are returned. A key that failed
 * is retried only after RETRY_DELAY_MS, and warns once.
 */
async function loadTargets(): Promise<TabTargets> {
    let key = '';
    try {
        const apiClient = await ServerConnections.getCurrentApiClientAsync();
        const userId = apiClient.getCurrentUserId();
        if (!userId) return FALLBACK_TARGETS;

        key = `${apiClient.serverId()}|${userId}`;
        if (lastFailure?.key === key && Date.now() - lastFailure.failedAt < RETRY_DELAY_MS) return FALLBACK_TARGETS;

        const entry = cachedTargets?.key === key ? cachedTargets : { key, promise: fetchTargets(apiClient, userId) };
        cachedTargets = entry;
        const resolved = await entry.promise;
        lastFailure = undefined;
        return resolved;
    } catch (error) {
        cachedTargets = undefined;
        lastFailure = { key, failedAt: Date.now() };
        if (warnedKey !== key) {
            warnedKey = key;
            console.warn('[BottomTabBar] Could not load libraries; Movies and Shows link to Home.', error);
        }
        return FALLBACK_TARGETS;
    }
}

/** Re-resolves the targets. Cheap when the key is already resolved: loadTargets reuses the cache. */
function refreshTargets(): void {
    const mounted = bar;
    if (!mounted) return;
    void loadTargets().then(resolved => {
        if (bar !== mounted) return;
        targets = resolved;
        applyTargets(mounted, resolved);
        update();
    });
}

function onClick(e: Event): void {
    const item = (e.target as Element).closest<HTMLElement>('.lg-tabbar-item');
    if (!item) return;

    if (item.dataset.tab === 'favorites' && getActiveTab(window.location.hash, targets) === 'home') {
        // Already on home: the tab strip is live, so switch tabs rather than re-route to the same view
        const tabButton = document.querySelector<HTMLElement>('.headerTabs .emby-tab-button[data-index="1"]');
        if (tabButton) {
            e.preventDefault();
            tabButton.click();
            window.setTimeout(update, 0);
        }
    }
}

/** TV: the bar sits over the page top, so moving focus up into it returns the page to the top instead of covering the hero. */
function onTopBarFocus(): void {
    if (layoutManager.tv && window.scrollY > 0) window.scrollTo({ top: 0 });
}

function mount(): void {
    if (bar) return;

    bar = renderTabBar(getActiveTab(window.location.hash, targets), key => globalize.translate(key), targets);
    bar.addEventListener('click', onClick);
    bar.addEventListener('focusin', onTopBarFocus);
    document.body.append(bar);

    // The user may sign in after mount, so each navigation re-checks the targets (cached once resolved)
    const onNav = () => {
        update();
        refreshTargets();
    };
    window.addEventListener('hashchange', onNav);
    document.addEventListener('viewshow', onNav, true);
    window.addEventListener('scroll', updateScrollState, { passive: true });
    removeListeners = () => {
        window.removeEventListener('hashchange', onNav);
        document.removeEventListener('viewshow', onNav, true);
        window.removeEventListener('scroll', updateScrollState);
    };

    // libraryMenu and the video OSD toggle these classes; observing them avoids depending on event order
    observer = new MutationObserver(update);
    observer.observe(document.body, { attributes: true, attributeFilter: [ 'class' ] });
    update();
    refreshTargets();
}

function unmount(): void {
    observer?.disconnect();
    removeListeners?.();
    bar?.remove();
    document.documentElement.classList.remove(ROOT_CLASS, TV_ROOT_CLASS);
    bar = undefined;
    observer = undefined;
    observedHeader = undefined;
    removeListeners = undefined;
}

function sync(): void {
    if (isLiquidGlass()) {
        mount();
        // mount() is a no-op once mounted; re-run update so a layout switch refreshes the classes
        update();
    } else {
        unmount();
    }
}

/** Show the tab bar while the Liquid Glass theme is active: bottom on phone and desktop, top (home only) on TV. Call once. */
// libraryMenu passes openLibraries; the bar no longer uses it, so the parameter is kept only for that call site
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function initBottomTabBar(_options: TabBarOptions): void {
    Events.on(document, EventType.THEME_CHANGE, sync);
    // Layout can switch at runtime (e.g. rotating a tablet); sync is idempotent
    Events.on(layoutManager, 'modechange', sync);
    sync();
}
