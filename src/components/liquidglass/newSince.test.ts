import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventType } from '../../constants/eventType';
import Events from '../../utils/events';

const api = vi.hoisted(() => ({
    userId: 'user-1' as string | undefined,
    latest: vi.fn(),
    scaledImage: vi.fn((id: string) => `https://img.test/${id}.jpg`)
}));
const layout = vi.hoisted(() => ({ tv: false }));
const router = vi.hoisted(() => ({ showItem: vi.fn() }));
const settings = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock('../layoutManager', () => ({
    default: {
        get tv() {
            return layout.tv;
        }
    }
}));
vi.mock('../router/appRouter', () => ({ appRouter: router }));
vi.mock('../../lib/globalize', () => ({
    default: {
        translate: (key: string, ...args: unknown[]) => (args.length > 0 ? `${key}:${args.join(',')}` : key)
    }
}));
vi.mock('../../lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        getCurrentApiClientAsync: async () => ({
            serverId: () => 'server-1',
            getCurrentUserId: () => api.userId,
            getLatestItems: api.latest,
            getScaledImageUrl: api.scaledImage
        })
    }
}));
vi.mock('../../scripts/settings/userSettings', () => ({
    currentSettings: {
        get: (name: string) => settings.store.get(name) ?? null,
        set: (name: string, value: string) => {
            settings.store.set(name, value);
        }
    }
}));

import { initNewSince } from './newSince';

const SEEN_KEY = 'lgNewSinceSeen-server-1|user-1';
const seenKeyFor = (userId: string): string => `lgNewSinceSeen-server-1|${userId}`;
const MINUTE = 60_000;
const START = Date.parse('2026-11-18T12:00:00Z');
let clock = START;

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const minutesAgo = (minutes: number): string => new Date(clock - minutes * MINUTE).toISOString();

function item(id: string, createdMinutesAgo: number, overrides: Partial<BaseItemDto> = {}): BaseItemDto {
    return {
        Id: id,
        Name: `Title ${id}`,
        Type: 'Movie',
        DateCreated: minutesAgo(createdMinutesAgo),
        ...overrides
    } as BaseItemDto;
}

const bellButton = () => document.querySelector<HTMLButtonElement>('.lg-bell');
const dotOf = () => document.querySelector<HTMLElement>('.lg-bell__dot');
const popoverOf = () => document.querySelector<HTMLElement>('.lg-new-since');
const slotOf = () => document.querySelector<HTMLElement>('.lg-header-bell');
const rowsOf = () => document.querySelectorAll<HTMLAnchorElement>('.lg-new-since__row');

interface StartOptions {
    items?: BaseItemDto[];
    fetchError?: Error;
    seen?: number;
    theme?: string;
}

/** Applies the options, then mounts through the same theme-change event the app uses. */
async function start(options: StartOptions = {}): Promise<void> {
    const { items = [], fetchError, seen, theme = 'liquidglass' } = options;
    if (seen !== undefined) settings.store.set(SEEN_KEY, String(seen));
    if (fetchError) api.latest.mockRejectedValue(fetchError);
    else api.latest.mockResolvedValue(items);
    document.documentElement.setAttribute('data-jf-theme', theme);
    Events.trigger(document, EventType.THEME_CHANGE);
    await flush();
}

function header(): void {
    document.body.innerHTML = '<div class="skinHeader"><div class="headerRight"><div class="lg-header-bell" hidden></div></div></div>';
}

/** Unmounts the last test's bell so its observer does not run after the DOM is gone. */
function unmountBell(): void {
    document.documentElement.removeAttribute('data-jf-theme');
    Events.trigger(document, EventType.THEME_CHANGE);
}

beforeAll(() => {
    initNewSince();
});

afterAll(() => {
    unmountBell();
});

beforeEach(() => {
    // Unmount the previous test's bell before the DOM is reset
    unmountBell();
    header();
    // Each test starts well past the fetch throttle
    clock += 10 * MINUTE;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    settings.store.clear();
    api.userId = 'user-1';
    layout.tv = false;
    vi.clearAllMocks();
});

describe('new since last visit bell', () => {
    it('sets the visit time on first run and shows no dot', async () => {
        await start({ items: [ item('a', 5) ] });

        expect(settings.store.get(SEEN_KEY)).toBe(String(clock));
        expect(dotOf()?.hidden).toBe(true);
        expect(bellButton()?.getAttribute('aria-label')).toBe('LiquidGlassNewSinceLastVisit');
    });

    it('shows a dot and the count for titles added since the last visit', async () => {
        await start({ items: [ item('a', 10), item('b', 20), item('c', 180) ], seen: clock - 60 * MINUTE });

        expect(dotOf()?.hidden).toBe(false);
        expect(bellButton()?.getAttribute('aria-label')).toBe('LiquidGlassNewSinceLastVisit, LiquidGlassNewTitlesCount:2');
    });

    it('ignores titles added before the last visit', async () => {
        await start({ items: [ item('c', 180) ], seen: clock - 60 * MINUTE });

        expect(dotOf()?.hidden).toBe(true);
        expect(bellButton()?.getAttribute('aria-label')).toBe('LiquidGlassNewSinceLastVisit');
    });

    it('opening the list sets the visit time, clears the dot and keeps the fetched rows', async () => {
        await start({ items: [ item('a', 10), item('b', 20) ], seen: clock - 60 * MINUTE });

        bellButton()?.click();

        expect(settings.store.get(SEEN_KEY)).toBe(String(clock));
        expect(dotOf()?.hidden).toBe(true);
        expect(popoverOf()?.classList.contains('is-open')).toBe(true);
        expect(rowsOf()).toHaveLength(2);
    });

    it('lists the new titles, with the series as title for episodes', async () => {
        const episode = item('e1', 5, { Type: 'Episode', SeriesName: 'Series One', Name: 'Pilot' });
        await start({ items: [ episode ], seen: clock - 60 * MINUTE });

        bellButton()?.click();

        expect(rowsOf()[0].querySelector('.lg-new-since__name')?.textContent).toBe('Series One');
        expect(rowsOf()[0].querySelector('.lg-new-since__subtitle')?.textContent).toBe('Pilot');
    });

    it('shows the empty state when nothing is new', async () => {
        await start({ items: [ item('c', 180) ], seen: clock - 60 * MINUTE });

        bellButton()?.click();

        expect(popoverOf()?.textContent).toContain('LiquidGlassNothingNew');
        expect(rowsOf()).toHaveLength(0);
    });

    it('closes on Escape and returns focus to the bell', async () => {
        await start({ items: [ item('a', 10) ], seen: clock - 60 * MINUTE });
        bellButton()?.click();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(popoverOf()?.classList.contains('is-open')).toBe(false);
        expect(bellButton()?.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(bellButton());
    });

    it('closes on an outside click without returning focus to the bell', async () => {
        await start({ items: [ item('a', 10) ], seen: clock - 60 * MINUTE });
        bellButton()?.click();

        document.body.click();

        expect(popoverOf()?.classList.contains('is-open')).toBe(false);
        expect(document.activeElement).not.toBe(bellButton());
    });

    it('opens the item and closes when a row is chosen', async () => {
        const recent = item('a', 10);
        await start({ items: [ recent ], seen: clock - 60 * MINUTE });
        bellButton()?.click();

        rowsOf()[0].click();

        expect(router.showItem).toHaveBeenCalledWith(recent);
        expect(popoverOf()?.classList.contains('is-open')).toBe(false);
    });

    it('warns and shows no dot when the fetch fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await start({ fetchError: new Error('offline'), seen: clock - 60 * MINUTE });

        expect(warn).toHaveBeenCalled();
        expect(bellButton()).not.toBeNull();
        expect(dotOf()?.hidden).toBe(true);
        warn.mockRestore();
    });

    it('is not mounted on TV', async () => {
        layout.tv = true;

        await start({ items: [ item('a', 10) ], seen: clock - 60 * MINUTE });

        expect(bellButton()).toBeNull();
        expect(slotOf()?.hidden).toBe(true);
        expect(api.latest).not.toHaveBeenCalled();
    });

    it('is not mounted outside the Liquid Glass theme', async () => {
        await start({ items: [ item('a', 10) ], seen: clock - 60 * MINUTE, theme: 'dark' });

        expect(bellButton()).toBeNull();
        expect(slotOf()?.hidden).toBe(true);
        expect(api.latest).not.toHaveBeenCalled();
    });

    it('stays hidden when no user is signed in', async () => {
        api.userId = undefined;

        await start({ items: [ item('a', 10) ], seen: clock - 60 * MINUTE });

        expect(bellButton()).toBeNull();
        expect(slotOf()?.hidden).toBe(true);
    });

    it('re-attaches to a re-rendered header without duplicate listeners', async () => {
        await start({ items: [ item('a', 10) ], seen: clock - 60 * MINUTE });

        const headerRight = document.querySelector<HTMLElement>('.headerRight');
        if (!headerRight) throw new Error('header slot missing from the test fixture');
        headerRight.innerHTML = '<div class="lg-header-bell" hidden></div>';
        await flush();

        expect(document.querySelectorAll('.lg-bell')).toHaveLength(1);
        expect(slotOf()?.hidden).toBe(false);
        expect(dotOf()?.hidden).toBe(false);

        // A duplicated click listener would toggle the popover open and closed again
        bellButton()?.click();
        expect(popoverOf()?.classList.contains('is-open')).toBe(true);
    });

    it('does not refetch within five minutes of the last fetch', async () => {
        await start({ items: [ item('a', 10) ], seen: clock - 60 * MINUTE });
        expect(api.latest).toHaveBeenCalledTimes(1);

        window.location.hash = '#/home';
        document.dispatchEvent(new Event('viewshow'));
        await flush();
        expect(api.latest).toHaveBeenCalledTimes(1);

        clock += 5 * MINUTE;
        document.dispatchEvent(new Event('viewshow'));
        await flush();
        expect(api.latest).toHaveBeenCalledTimes(2);
    });

    it('refetches when the page was hidden for five minutes', async () => {
        await start({ items: [ item('a', 10) ], seen: clock - 60 * MINUTE });

        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        clock += 5 * MINUTE;
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
        await flush();

        expect(api.latest).toHaveBeenCalledTimes(2);
    });

    it('does not show the previous user titles after a sign-in switch', async () => {
        window.location.hash = '#/home';
        await start({ items: [ item('a', 10) ], seen: clock - 60 * MINUTE });
        expect(api.latest).toHaveBeenCalledTimes(1);

        // Same five-minute window: the switch alone must trigger a fetch
        api.userId = 'user-2';
        settings.store.set(seenKeyFor('user-2'), String(clock - 60 * MINUTE));
        api.latest.mockResolvedValue([ item('b', 5) ]);
        document.dispatchEvent(new Event('viewshow'));
        await flush();

        expect(api.latest).toHaveBeenCalledTimes(2);
        bellButton()?.click();
        expect(Array.from(rowsOf()).map(row => row.dataset.id)).toEqual([ 'b' ]);
    });

    it('refetches on the next viewshow after a failed fetch', async () => {
        window.location.hash = '#/home';
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await start({ fetchError: new Error('offline'), seen: clock - 60 * MINUTE });
        expect(api.latest).toHaveBeenCalledTimes(1);

        api.latest.mockResolvedValue([ item('a', 5) ]);
        document.dispatchEvent(new Event('viewshow'));
        await flush();

        expect(api.latest).toHaveBeenCalledTimes(2);
        expect(dotOf()?.hidden).toBe(false);
        warn.mockRestore();
    });
});
