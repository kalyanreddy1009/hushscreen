import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getActiveTab, initBottomTabBar, renderTabBar, shouldShowBar, TABS } from './bottomTabBar';

vi.mock('../../components/layoutManager', () => ({ default: { mobile: true } }));
vi.mock('../../lib/globalize', () => ({ default: { translate: (k: string) => k } }));

describe('getActiveTab', () => {
    it.each([
        [ '#/home', 'home' ],
        [ '#/home?tab=0', 'home' ],
        [ '#/home?tab=1', 'favorites' ],
        [ '#/home?x=2&tab=1', 'favorites' ],
        [ '#/home?tab=10', 'home' ],
        [ '#/search?query=x', 'search' ],
        [ '#/mypreferencesmenu', 'profile' ],
        [ '#/mypreferencesdisplay?userId=1', 'profile' ],
        [ '#/movies?topParentId=1', 'libraries' ],
        [ '#/details?id=1', null ],
        [ '', null ]
    ])('maps %s to %s', (hash, expected) => {
        expect(getActiveTab(hash)).toBe(expected);
    });
});

describe('renderTabBar', () => {
    it('renders five labelled items with real destinations', () => {
        const bar = renderTabBar('search', k => k);
        const items = bar.querySelectorAll<HTMLElement>('.lg-tabbar-item');

        expect(items).toHaveLength(5);
        for (const item of items) expect(item.getAttribute('aria-label')).toBeTruthy();
        expect(TABS.filter(t => t.href).every(t => bar.querySelector(`a[href="${t.href}"]`))).toBe(true);
        expect(bar.querySelector('button[data-tab="libraries"]')).not.toBeNull();
    });

    it('marks only the active item with aria-current=page', () => {
        const bar = renderTabBar('favorites', k => k);
        const current = bar.querySelectorAll<HTMLElement>('[aria-current="page"]');

        expect(current).toHaveLength(1);
        expect(current[0].dataset.tab).toBe('favorites');
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
    it('observes a skinHeader rendered after init and hides the bar for the OSD', async () => {
        document.documentElement.setAttribute('data-jf-theme', 'liquidglass');
        document.body.className = 'libraryDocument';
        document.body.innerHTML = '';
        initBottomTabBar({ openLibraries: vi.fn() });

        const bar = document.querySelector<HTMLElement>('.lg-tabbar');
        expect(bar?.hidden).toBe(false);

        const header = document.createElement('div');
        header.className = 'skinHeader';
        document.body.append(header);
        window.dispatchEvent(new Event('hashchange'));
        header.classList.add('osdHeader');
        await Promise.resolve();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(bar?.hidden).toBe(true);
    });
});
