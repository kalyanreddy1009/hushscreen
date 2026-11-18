import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Events from '../../utils/events';
import { EventType } from '../../constants/eventType';
import { buildTargets, FALLBACK_TARGETS, getActiveTab, initBottomTabBar, renderTabBar, shouldShowBar, TABS, type TabTargets } from './bottomTabBar';

const apiMock = vi.hoisted(() => ({
    layout: { tv: false, mobile: true },
    userId: 'user-1' as string | null,
    views: [] as { Id: string, CollectionType: string }[],
    getUserViews: vi.fn()
}));

vi.mock('../../components/layoutManager', () => ({
    default: {
        get tv() {
            return apiMock.layout.tv;
        },
        get mobile() {
            return apiMock.layout.mobile;
        }
    }
}));
vi.mock('../../lib/globalize', () => ({ default: { translate: (k: string) => k } }));
vi.mock('../../lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        getCurrentApiClientAsync: async () => ({
            serverId: () => 'server-1',
            getCurrentUserId: () => apiMock.userId,
            getUserViews: apiMock.getUserViews
        })
    }
}));

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

const TARGETS: TabTargets = {
    movies: { href: '#/movies?topParentId=m1&collectionType=movies', libraryIds: [ 'm1' ] },
    shows: { href: '#/tv?topParentId=s1&collectionType=tvshows', libraryIds: [ 's1' ] }
};

describe('getActiveTab', () => {
    it.each([
        [ '#/home', 'home' ],
        [ '#/home?tab=0', 'home' ],
        [ '#/home?tab=1', 'favorites' ],
        [ '#/home?x=2&tab=1', 'favorites' ],
        [ '#/home?tab=10', 'home' ],
        [ '#/details?id=1', null ],
        [ '#/search?query=x', null ],
        [ '#/mypreferencesmenu', null ],
        [ '', null ]
    ])('maps %s to %s', (hash, expected) => {
        expect(getActiveTab(hash, TARGETS)).toBe(expected);
    });

    it.each([
        [ '#/movies?topParentId=m1', 'movies' ],
        [ '#/movies?topParentId=other', null ],
        [ '#/tv?topParentId=s1', 'shows' ],
        [ '#/tv?topParentId=m1', null ],
        [ '#/list?type=Movie', 'movies' ],
        [ '#/list?type=Series', 'shows' ],
        [ '#/list?type=Movie&parentId=m1', null ],
        [ '#/list?type=Audio', null ]
    ])('maps library and combined routes %s to %s', (hash, expected) => {
        expect(getActiveTab(hash, TARGETS)).toBe(expected);
    });

    it('has no library matches before the libraries load', () => {
        expect(getActiveTab('#/movies?topParentId=m1')).toBeNull();
    });
});

describe('buildTargets', () => {
    it('links to Home when the user has no library of the kind', () => {
        expect(buildTargets([])).toEqual({
            movies: { href: '#/home', libraryIds: [] },
            shows: { href: '#/home', libraryIds: [] }
        });
    });

    it('links one library to its library page', () => {
        const targets = buildTargets([
            { Id: 'm1', CollectionType: 'movies' },
            { Id: 's1', CollectionType: 'tvshows' }
        ]);
        expect(targets.movies).toEqual({ href: '#/movies?topParentId=m1&collectionType=movies', libraryIds: [ 'm1' ] });
        expect(targets.shows).toEqual({ href: '#/tv?topParentId=s1&collectionType=tvshows', libraryIds: [ 's1' ] });
    });

    it('links several libraries to the cross-library list and keeps every id', () => {
        const targets = buildTargets([
            { Id: 'm1', CollectionType: 'movies' },
            { Id: 'm2', CollectionType: 'movies' },
            { Id: 's1', CollectionType: 'tvshows' },
            { Id: 's2', CollectionType: 'tvshows' },
            { Id: 'h1', CollectionType: 'homevideos' }
        ]);
        expect(targets.movies).toEqual({ href: '#/list?type=Movie', libraryIds: [ 'm1', 'm2' ] });
        expect(targets.shows).toEqual({ href: '#/list?type=Series', libraryIds: [ 's1', 's2' ] });
    });
});

describe('renderTabBar', () => {
    it('renders the four tabs in order as links with real destinations', () => {
        const bar = renderTabBar('home', k => k, TARGETS);
        const items = bar.querySelectorAll<HTMLAnchorElement>('.lg-tabbar-item');

        expect([ ...items ].map(item => item.dataset.tab)).toEqual([ 'home', 'movies', 'shows', 'favorites' ]);
        for (const item of items) expect(item.getAttribute('aria-label')).toBeTruthy();
        expect(items[0].getAttribute('href')).toBe('#/home');
        expect(items[1].getAttribute('href')).toBe(TARGETS.movies.href);
        expect(items[2].getAttribute('href')).toBe(TARGETS.shows.href);
        expect(items[3].getAttribute('href')).toBe('#/home?tab=1');
    });

    it('uses the fallback targets when none are given', () => {
        const bar = renderTabBar(null, k => k);
        expect(bar.querySelector('[data-tab="movies"]')?.getAttribute('href')).toBe('#/home');
        expect(bar.querySelector('[data-tab="shows"]')?.getAttribute('href')).toBe('#/home');
    });

    it('marks only the active item with aria-current=page', () => {
        const bar = renderTabBar('favorites', k => k, TARGETS);
        const current = bar.querySelectorAll<HTMLElement>('[aria-current="page"]');

        expect(current).toHaveLength(1);
        expect(current[0].dataset.tab).toBe('favorites');
    });

    it('has no search, libraries or profile items', () => {
        const bar = renderTabBar(null, k => k, TARGETS);
        expect(bar.querySelector('[data-tab="search"], [data-tab="libraries"], [data-tab="profile"]')).toBeNull();
        expect(TABS.map(tab => tab.id)).toEqual([ 'home', 'movies', 'shows', 'favorites' ]);
    });
});

describe('shouldShowBar', () => {
    beforeEach(() => {
        document.body.className = '';
        document.body.innerHTML = '<div class="skinHeader"></div>';
    });

    it('is hidden outside library pages', () => {
        expect(shouldShowBar()).toBe(false);
    });

    it('is shown on library pages and hidden in the video OSD', () => {
        document.body.classList.add('libraryDocument');
        expect(shouldShowBar()).toBe(true);
        document.querySelector('.skinHeader')?.classList.add('osdHeader');
        expect(shouldShowBar()).toBe(false);
    });
});

describe('initBottomTabBar', () => {
    const options = { openLibraries: vi.fn() };

    /** Unmounts any bar from a previous test: sync() removes it once the theme is no longer Liquid Glass. */
    function resetBar(): void {
        document.documentElement.removeAttribute('data-jf-theme');
        Events.trigger(document, EventType.THEME_CHANGE);
        document.documentElement.setAttribute('data-jf-theme', 'liquidglass');
        document.body.className = 'libraryDocument';
        document.body.innerHTML = '';
    }

    beforeEach(() => {
        resetBar();
        apiMock.layout.tv = false;
        apiMock.layout.mobile = true;
        apiMock.userId = 'user-1';
        apiMock.views = [];
        apiMock.getUserViews.mockReset();
        apiMock.getUserViews.mockImplementation(async () => ({ Items: apiMock.views }));
    });

    it('observes a skinHeader rendered after init and hides the bar for the OSD', async () => {
        initBottomTabBar(options);

        const bar = document.querySelector<HTMLElement>('.lg-tabbar');
        expect(bar?.hidden).toBe(false);

        const header = document.createElement('div');
        header.className = 'skinHeader';
        document.body.append(header);
        window.dispatchEvent(new Event('hashchange'));
        header.classList.add('osdHeader');
        await flushPromises();

        expect(bar?.hidden).toBe(true);
    });

    it('mounts on phone layouts', () => {
        apiMock.layout.mobile = true;
        initBottomTabBar(options);
        expect(document.querySelector('.lg-tabbar')).not.toBeNull();
    });

    it('mounts on desktop layouts', () => {
        apiMock.layout.mobile = false;
        initBottomTabBar(options);
        expect(document.querySelector('.lg-tabbar')).not.toBeNull();
    });

    it('does not mount on TV layouts', () => {
        apiMock.layout.tv = true;
        initBottomTabBar(options);
        expect(document.querySelector('.lg-tabbar')).toBeNull();
    });

    it('does not mount outside the Liquid Glass theme', () => {
        document.documentElement.removeAttribute('data-jf-theme');
        initBottomTabBar(options);
        expect(document.querySelector('.lg-tabbar')).toBeNull();
    });

    it('resolves the Movies and Shows hrefs from the user libraries', async () => {
        apiMock.userId = 'user-links';
        apiMock.views = [
            { Id: 'm1', CollectionType: 'movies' },
            { Id: 's1', CollectionType: 'tvshows' }
        ];
        initBottomTabBar(options);
        await flushPromises();

        expect(document.querySelector('[data-tab="movies"]')?.getAttribute('href')).toBe('#/movies?topParentId=m1&collectionType=movies');
        expect(document.querySelector('[data-tab="shows"]')?.getAttribute('href')).toBe('#/tv?topParentId=s1&collectionType=tvshows');
    });

    it('fetches the views once per user and not again on re-sync', async () => {
        apiMock.userId = 'user-cache';
        apiMock.views = [ { Id: 'm1', CollectionType: 'movies' } ];
        initBottomTabBar(options);
        await flushPromises();
        Events.trigger(document, EventType.THEME_CHANGE);
        Events.trigger(document, EventType.THEME_CHANGE);
        await flushPromises();

        expect(apiMock.getUserViews).toHaveBeenCalledTimes(1);
    });

    it('falls back to Home for Movies and Shows when the views cannot be loaded', async () => {
        apiMock.userId = 'user-failing';
        apiMock.getUserViews.mockRejectedValue(new Error('offline'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        initBottomTabBar(options);
        await flushPromises();

        expect(document.querySelector('[data-tab="movies"]')?.getAttribute('href')).toBe(FALLBACK_TARGETS.movies.href);
        expect(document.querySelector('[data-tab="shows"]')?.getAttribute('href')).toBe('#/home');
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('does not fetch or warn before a user is signed in, and links Movies and Shows to Home', async () => {
        apiMock.userId = null;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        initBottomTabBar(options);
        await flushPromises();

        expect(apiMock.getUserViews).not.toHaveBeenCalled();
        expect(document.querySelector('[data-tab="movies"]')?.getAttribute('href')).toBe('#/home');
        expect(document.querySelector('[data-tab="shows"]')?.getAttribute('href')).toBe('#/home');
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('loads the libraries on the next navigation once the user is signed in', async () => {
        apiMock.userId = null;
        initBottomTabBar(options);
        await flushPromises();

        apiMock.userId = 'user-late';
        apiMock.views = [ { Id: 'm1', CollectionType: 'movies' } ];
        document.dispatchEvent(new Event('viewshow'));
        await flushPromises();

        expect(apiMock.getUserViews).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[data-tab="movies"]')?.getAttribute('href')).toBe('#/movies?topParentId=m1&collectionType=movies');
    });

    it('does not refetch the views on a navigation for the same user', async () => {
        apiMock.userId = 'user-nav';
        apiMock.views = [ { Id: 'm1', CollectionType: 'movies' } ];
        initBottomTabBar(options);
        await flushPromises();
        document.dispatchEvent(new Event('viewshow'));
        await flushPromises();

        expect(apiMock.getUserViews).toHaveBeenCalledTimes(1);
    });

    describe('failed loads', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('skips the retry and the warning for a navigation within 30 seconds of a failure', async () => {
            apiMock.userId = 'user-throttle';
            apiMock.getUserViews.mockRejectedValue(new Error('server down'));
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            initBottomTabBar(options);
            await flushPromises();

            document.dispatchEvent(new Event('viewshow'));
            await flushPromises();
            document.dispatchEvent(new Event('viewshow'));
            await flushPromises();

            expect(apiMock.getUserViews).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(document.querySelector('[data-tab="movies"]')?.getAttribute('href')).toBe('#/home');
            warn.mockRestore();
        });

        it('retries after 30 seconds and still warns only once for the key', async () => {
            vi.useFakeTimers({ toFake: [ 'Date' ] });
            vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
            apiMock.userId = 'user-retry';
            apiMock.getUserViews.mockRejectedValue(new Error('server down'));
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            initBottomTabBar(options);
            await flushPromises();

            vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
            document.dispatchEvent(new Event('viewshow'));
            await flushPromises();

            expect(apiMock.getUserViews).toHaveBeenCalledTimes(2);
            expect(warn).toHaveBeenCalledTimes(1);
            warn.mockRestore();
        });
    });

    it('refetches the views when the user changes', async () => {
        apiMock.userId = 'user-first';
        apiMock.views = [ { Id: 'm1', CollectionType: 'movies' } ];
        initBottomTabBar(options);
        await flushPromises();

        apiMock.userId = 'user-second';
        apiMock.views = [ { Id: 'm2', CollectionType: 'movies' } ];
        document.dispatchEvent(new Event('viewshow'));
        await flushPromises();

        expect(apiMock.getUserViews).toHaveBeenCalledTimes(2);
        expect(document.querySelector('[data-tab="movies"]')?.getAttribute('href')).toBe('#/movies?topParentId=m2&collectionType=movies');
    });
});
