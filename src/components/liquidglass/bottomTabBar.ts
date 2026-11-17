import { EventType } from '../../constants/eventType';
import globalize from '../../lib/globalize';
import Events from '../../utils/events';
import layoutManager from '../../components/layoutManager';

import { isLiquidGlass } from '../../themes/liquidglass/isLiquidGlass';

export type TabId = 'home' | 'search' | 'favorites' | 'libraries' | 'profile';

interface TabDef {
    id: TabId
    icon: string
    labelKey: string
    /** Hash route; absent for the item that opens the library drawer. */
    href?: string
}

export const TABS: readonly TabDef[] = [
    { id: 'home', icon: 'home', labelKey: 'Home', href: '#/home' },
    { id: 'search', icon: 'search', labelKey: 'Search', href: '#/search' },
    // The stable home view has two tabs: 0 = Home, 1 = Favorites (controllers/home.js)
    { id: 'favorites', icon: 'favorite', labelKey: 'Favorites', href: '#/home?tab=1' },
    // No route: opens the main nav drawer, which lists the user's libraries
    { id: 'libraries', icon: 'video_library', labelKey: 'HeaderLibraries' },
    { id: 'profile', icon: 'account_circle', labelKey: 'Profile', href: '#/mypreferencesmenu' }
];

const LIBRARY_ROUTES = [ 'movies', 'tv', 'music', 'livetv', 'list', 'books', 'homevideos', 'musicvideos', 'mixed' ];

export const BAR_CLASS = 'lg-tabbar';
export const ROOT_CLASS = 'lg-has-tabbar';

/** Which tab a location hash belongs to, or null when none applies. */
export function getActiveTab(hash: string): TabId | null {
    const match = /^#!?\/?([^?/]*)(?:\/[^?]*)?(?:\?(.*))?$/.exec(hash);
    if (!match) return null;
    const route = match[1].toLowerCase();
    const query = match[2] ?? '';

    if (route === 'home') return /(^|&)tab=1(&|$)/.test(query) ? 'favorites' : 'home';
    if (route === 'search') return 'search';
    if (route.startsWith('mypreferences')) return 'profile';
    if (LIBRARY_ROUTES.includes(route)) return 'libraries';
    return null;
}

/** Build the tab bar. Pure: no listeners, so it can be rendered in tests. */
export function renderTabBar(active: TabId | null, translate: (key: string) => string): HTMLElement {
    const nav = document.createElement('nav');
    nav.className = BAR_CLASS;
    nav.setAttribute('aria-label', translate('Menu'));

    for (const tab of TABS) {
        const label = translate(tab.labelKey);
        const item = document.createElement(tab.href ? 'a' : 'button');
        item.className = 'lg-tabbar-item';
        item.dataset.tab = tab.id;
        item.setAttribute('aria-label', label);
        if (tab.href) {
            item.setAttribute('href', tab.href);
        } else {
            item.setAttribute('type', 'button');
            // Opens the nav drawer
            item.setAttribute('aria-haspopup', 'true');
        }
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

export interface TabBarOptions {
    /** Opens the main nav drawer (library list). Supplied by libraryMenu to avoid a circular import. */
    openLibraries: () => void
}

let bar: HTMLElement | undefined;
let observer: MutationObserver | undefined;
let removeListeners: (() => void) | undefined;
let observedHeader: Element | undefined;
let currentOptions: TabBarOptions | undefined;

// React renders .skinHeader after this module loads, so it is observed lazily on first sight
function observeHeader(): void {
    const header = document.querySelector('.skinHeader');
    if (!observer || !header || header === observedHeader) return;
    observedHeader = header;
    observer.observe(header, { attributes: true, attributeFilter: [ 'class' ] });
}

function update(): void {
    if (!bar) return;
    observeHeader();
    const visible = shouldShowBar();
    bar.hidden = !visible;
    document.documentElement.classList.toggle(ROOT_CLASS, visible);

    const active = getActiveTab(window.location.hash);
    bar.querySelectorAll<HTMLElement>('.lg-tabbar-item').forEach(item => {
        if (active && item.dataset.tab === active) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
    });
}

function onClick(e: Event): void {
    const item = (e.target as Element).closest<HTMLElement>('.lg-tabbar-item');
    if (!item) return;

    if (item.dataset.tab === 'libraries') {
        currentOptions?.openLibraries();
        return;
    }
    if (item.dataset.tab === 'favorites' && getActiveTab(window.location.hash) === 'home') {
        // Already on home: the tab strip is live, so switch tabs rather than re-route to the same view
        const tabButton = document.querySelector<HTMLElement>('.headerTabs .emby-tab-button[data-index="1"]');
        if (tabButton) {
            e.preventDefault();
            tabButton.click();
            window.setTimeout(update, 0);
        }
    }
}

function mount(): void {
    if (bar) return;

    bar = renderTabBar(getActiveTab(window.location.hash), key => globalize.translate(key));
    bar.addEventListener('click', onClick);
    document.body.append(bar);

    const onNav = () => update();
    window.addEventListener('hashchange', onNav);
    document.addEventListener('viewshow', onNav, true);
    removeListeners = () => {
        window.removeEventListener('hashchange', onNav);
        document.removeEventListener('viewshow', onNav, true);
    };

    // libraryMenu and the video OSD toggle these classes; observing them avoids depending on event order
    observer = new MutationObserver(update);
    observer.observe(document.body, { attributes: true, attributeFilter: [ 'class' ] });
    update();
}

function unmount(): void {
    observer?.disconnect();
    removeListeners?.();
    bar?.remove();
    document.documentElement.classList.remove(ROOT_CLASS);
    bar = undefined;
    observer = undefined;
    observedHeader = undefined;
    removeListeners = undefined;
}

function sync(): void {
    if (isLiquidGlass() && layoutManager.mobile) mount();
    else unmount();
}

/** Show the mobile bottom tab bar while the Liquid Glass theme is active. Call once. */
export function initBottomTabBar(options: TabBarOptions): void {
    currentOptions = options;
    Events.on(document, EventType.THEME_CHANGE, sync);
    // Layout can switch at runtime (e.g. rotating a tablet); sync is idempotent
    Events.on(layoutManager, 'modechange', sync);
    sync();
}
