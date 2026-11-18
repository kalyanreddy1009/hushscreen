import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../../lib/globalize', () => ({
    default: {
        translate: (key: string, ...args: string[]) => {
            const strings: Record<string, string> = {
                LiquidGlassBecauseYouWatched: `Because You Watched ${args[0]}`,
                LiquidGlassBecauseYouLiked: `Because You Liked ${args[0]}`,
                LiquidGlassTopPicks: 'Top Picks for You',
                LiquidGlassHighlyRated: 'Highly Rated, Not Yet Watched',
                LiquidGlassNewInYourGenres: 'New in Your Genres'
            };
            return strings[key] ?? key;
        }
    }
}));

vi.mock('../../cardbuilder/cardBuilder', () => ({
    default: {
        getCardsHtml: (options: { items: BaseItemDto[] }) => options.items.map(item => `<card data-id="${item.Id}"></card>`).join('')
    }
}));

const glassApiClient = vi.hoisted(() => ({
    getScaledImageUrl: (itemId: string, options: { type: string }) => `https://example.test/${itemId}/${options.type}`
}));

vi.mock('../../../lib/jellyfin-apiclient', () => ({
    ServerConnections: { getApiClient: () => glassApiClient }
}));

vi.mock('../../playback/playbackmanager', () => ({ playbackManager: { play: vi.fn() } }));

vi.mock('../../liquidglass/glassTile', async importOriginal => ({
    ...await importOriginal<typeof import('../../liquidglass/glassTile')>(),
    bindGlassTiles: vi.fn(() => vi.fn())
}));

import { bindGlassTiles } from '../../liquidglass/glassTile';
import {
    dedupeRows,
    getTopGenres,
    loadRecommendationRows,
    orderSimilarItems,
    pickBaselines,
    resumeRecommendationRows,
    startLatestRequest,
    type TasteLists
} from './recommendations';

/** A random source that keeps shuffles in their original order. */
const keepOrder = () => 0.999;

function movie(id: string, genres: string[] = []): BaseItemDto {
    return { Id: id, Name: `Movie ${id}`, Type: 'Movie', Genres: genres } as BaseItemDto;
}

function movies(prefix: string, count: number, genres: string[] = []): BaseItemDto[] {
    return Array.from({ length: count }, (_, i) => movie(`${prefix}${i + 1}`, genres));
}

function named(id: string, name: string, year: number): BaseItemDto {
    return { Id: id, Name: name, ProductionYear: year, Type: 'Movie' } as BaseItemDto;
}

function queryResult(items: BaseItemDto[]) {
    return Promise.resolve({ Items: items, TotalRecordCount: items.length });
}

function taste(parts: Partial<TasteLists> = {}): TasteLists {
    return { resumable: [], played: [], favourites: [], ...parts };
}

type Handler = () => Promise<unknown>;

type RouteName = 'played' | 'favourites' | 'resumable' | 'highly' | 'top' | 'new';

/**
 * Fake client. Similar-items requests go to similar[id] when set; otherwise a baseline with
 * id 'p1' gets five movies with ids 'sp11'..'sp15'. Any other unexpected URL rejects.
 */
function fakeApiClient(
    handlers: Partial<Record<RouteName, Handler>> = {},
    similar: Record<string, Handler | undefined> = {}
) {
    const routes: Record<RouteName, Handler> = {
        played: () => queryResult(movies('p', 6, [ 'Drama', 'Comedy' ])),
        favourites: () => queryResult([]),
        resumable: () => queryResult([]),
        highly: () => queryResult(movies('h', 4)),
        top: () => queryResult(movies('t', 4)),
        new: () => queryResult(movies('n', 4)),
        ...handlers
    };

    const getItems = vi.fn((_userId: string, options: Record<string, unknown>) => {
        if (options.IsPlayed === true) return routes.played();
        if (options.IsFavorite === true) return routes.favourites();
        if (options.Filters === 'IsResumable') return routes.resumable();
        if (options.Genres === undefined) return routes.highly();
        return options.SortBy === 'DateCreated' ? routes.new() : routes.top();
    });
    const getUrl = vi.fn((name: string, params: Record<string, unknown>) => {
        const query = Object.entries(params).map(([ key, value ]) => `${key}=${value}`).join('&');
        return `${name}?${query}`;
    });
    const getJSON = vi.fn((url: string) => {
        const id = /^Items\/([^/]+)\/Similar\?/.exec(url)?.[1];
        if (!id) return Promise.reject(new Error(`unexpected request ${url}`));
        const handler = similar[id] ?? (() => queryResult(movies(`s${id}`, 5)));
        return handler();
    });

    return { getItems, getJSON, getUrl };
}

type RowContainer = HTMLElement & {
    fetchData: () => Promise<BaseItemDto[]>;
    getItemsHtml: (items: BaseItemDto[]) => string;
};

describe('getTopGenres', () => {
    it('returns genres ordered by how many played items carry them', () => {
        const played = [
            movie('1', [ 'Drama', 'Comedy' ]),
            movie('2', [ 'Drama' ]),
            movie('3', [ 'Action', 'Comedy' ]),
            movie('4', [ 'Drama' ])
        ];

        expect(getTopGenres(played, 2)).toEqual([ 'Drama', 'Comedy' ]);
    });

    it('breaks ties by name ascending', () => {
        const played = [ movie('1', [ 'Horror' ]), movie('2', [ 'Action' ]), movie('3', [ 'Comedy' ]) ];

        expect(getTopGenres(played, 2)).toEqual([ 'Action', 'Comedy' ]);
    });

    it('defaults to three genres', () => {
        const played = [ movie('1', [ 'A', 'B', 'C', 'D' ]) ];

        expect(getTopGenres(played)).toEqual([ 'A', 'B', 'C' ]);
    });

    it('ignores items without genres and returns an empty list when none have genres', () => {
        expect(getTopGenres([ { Id: 'x' } as BaseItemDto ])).toEqual([]);
    });

    it('does not mutate its input', () => {
        const played = [ movie('1', [ 'Drama', 'Comedy' ]), movie('2', [ 'Action' ]) ];
        const snapshot = JSON.stringify(played);

        getTopGenres(played);

        expect(JSON.stringify(played)).toBe(snapshot);
    });
});

describe('pickBaselines', () => {
    it('takes watched baselines from resumable before played, deduped by Id, and fills from watched without favourites', () => {
        const picks = pickBaselines(taste({
            resumable: [ movie('r1') ],
            played: [ movie('r1'), movie('p1'), movie('p2') ]
        }), 2, keepOrder);

        expect(picks.map(pick => [ pick.item.Id, pick.kind ])).toEqual([
            [ 'r1', 'watched' ],
            [ 'p1', 'watched' ]
        ]);
    });

    it('lists watched baselines before liked ones, with half the slots watched', () => {
        const picks = pickBaselines(taste({
            played: movies('p', 4),
            favourites: movies('f', 4)
        }), 4, keepOrder);

        expect(picks.map(pick => [ pick.item.Id, pick.kind ])).toEqual([
            [ 'p1', 'watched' ],
            [ 'p2', 'watched' ],
            [ 'f1', 'liked' ],
            [ 'f2', 'liked' ]
        ]);
    });

    it('chooses favourites with the injected random source', () => {
        const favourites = movies('f', 5);

        const lowRandom = pickBaselines(taste({ favourites }), 2, () => 0);
        const highRandom = pickBaselines(taste({ favourites }), 2, keepOrder);

        expect(lowRandom.map(pick => pick.item.Id)).toEqual([ 'f2', 'f3' ]);
        expect(highRandom.map(pick => pick.item.Id)).toEqual([ 'f1', 'f2' ]);
    });

    it('does not use a favourite that is also a watched baseline', () => {
        const picks = pickBaselines(taste({
            resumable: [ movie('r1') ],
            favourites: [ movie('r1'), movie('f1') ]
        }), 2, keepOrder);

        expect(picks.map(pick => [ pick.item.Id, pick.kind ])).toEqual([
            [ 'r1', 'watched' ],
            [ 'f1', 'liked' ]
        ]);
    });

    it('returns no more baselines than max', () => {
        const picks = pickBaselines(taste({ played: movies('p', 6), favourites: movies('f', 6) }), 3, keepOrder);

        expect(picks).toHaveLength(3);
    });

    it('does not mutate the taste lists', () => {
        const lists = taste({ resumable: [ movie('r1') ], played: movies('p', 3), favourites: movies('f', 3) });
        const snapshot = JSON.stringify(lists);

        pickBaselines(lists, 4, () => 0);

        expect(JSON.stringify(lists)).toBe(snapshot);
    });
});

describe('orderSimilarItems', () => {
    it('puts unwatched items first, then sorts by community rating descending', () => {
        const items = [
            { Id: 'a', CommunityRating: 9, UserData: { Played: true } },
            { Id: 'b', CommunityRating: 6 },
            { Id: 'c', CommunityRating: 8, UserData: { Played: false } },
            { Id: 'd', CommunityRating: 7 },
            { Id: 'e', UserData: { Played: true } }
        ] as BaseItemDto[];

        expect(orderSimilarItems(items).map(item => item.Id)).toEqual([ 'c', 'd', 'b', 'a', 'e' ]);
    });

    it('treats a missing rating as zero', () => {
        const items = [ { Id: 'norating' }, { Id: 'rated', CommunityRating: 3 } ] as BaseItemDto[];

        expect(orderSimilarItems(items).map(item => item.Id)).toEqual([ 'rated', 'norating' ]);
    });

    it('keeps the original order for equal ratings', () => {
        const items = [ { Id: 'first', CommunityRating: 5 }, { Id: 'second', CommunityRating: 5 } ] as BaseItemDto[];

        expect(orderSimilarItems(items).map(item => item.Id)).toEqual([ 'first', 'second' ]);
    });

    it('returns a new array and does not mutate its input', () => {
        const items = [ { Id: 'low', CommunityRating: 1 }, { Id: 'high', CommunityRating: 9 } ] as BaseItemDto[];
        const snapshot = JSON.stringify(items);

        const ordered = orderSimilarItems(items);

        expect(ordered).not.toBe(items);
        expect(JSON.stringify(items)).toBe(snapshot);
    });
});

describe('dedupeRows', () => {
    it('removes items already shown in an earlier row and drops rows left below the minimum', () => {
        const rows = [
            { title: 'First', items: movies('x', 4) },
            { title: 'Second', items: [ movie('x3'), movie('x4'), movie('y5'), movie('y6'), movie('y7'), movie('y8') ] },
            { title: 'Third', items: [ movie('x1'), movie('y5'), movie('z1') ] }
        ];

        const result = dedupeRows(rows);

        expect(result.map(row => row.title)).toEqual([ 'First', 'Second' ]);
        expect(result[1].items.map(item => item.Id)).toEqual([ 'y5', 'y6', 'y7', 'y8' ]);
    });

    it('honours a custom minimum', () => {
        const rows = [ { items: movies('a', 2) }, { items: movies('b', 3) } ];

        expect(dedupeRows(rows, 3)).toHaveLength(1);
        expect(dedupeRows(rows, 2)).toHaveLength(2);
    });

    it('treats items with the same normalised name and year as duplicates within a row', () => {
        const rows = [ {
            title: 'Row',
            items: [ named('a1', 'Heat', 1995), named('a2', '  heat ', 1995), named('a3', 'Other', 2001), named('a4', 'Third', 2002), named('a5', 'Fourth', 2003) ]
        } ];

        const result = dedupeRows(rows);

        expect(result[0].items.map(item => item.Id)).toEqual([ 'a1', 'a3', 'a4', 'a5' ]);
    });

    it('treats an item with the same normalised name and year in a later row as a duplicate', () => {
        const rows = [
            { title: 'First', items: [ named('a1', 'Heat', 1995), named('a2', 'Other', 2001), named('a3', 'Third', 2002), named('a4', 'Fourth', 2003) ] },
            { title: 'Second', items: [ named('b1', 'HEAT', 1995), named('b2', 'Fifth', 2004), named('b3', 'Sixth', 2005), named('b4', 'Seventh', 2006), named('b5', 'Eighth', 2007) ] }
        ];

        const result = dedupeRows(rows);

        expect(result[1].items.map(item => item.Id)).toEqual([ 'b2', 'b3', 'b4', 'b5' ]);
    });

    it('keeps items with the same name but a different year', () => {
        const rows = [ {
            title: 'Row',
            items: [ named('a1', 'Heat', 1995), named('a2', 'Heat', 2005), named('a3', 'Other', 2001), named('a4', 'Third', 2002) ]
        } ];

        expect(dedupeRows(rows)[0].items).toHaveLength(4);
    });

    it('does not mutate its input', () => {
        const rows = [ { title: 'First', items: movies('x', 4) }, { title: 'Second', items: movies('x', 5) } ];
        const snapshot = JSON.stringify(rows);

        dedupeRows(rows);

        expect(JSON.stringify(rows)).toBe(snapshot);
    });
});

describe('loadRecommendationRows', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** Loads rows with a deterministic random source unless the test overrides it. */
    function load(api: ReturnType<typeof fakeApiClient>, options: { maxSimilarRows?: number; random?: () => number } = {}) {
        return loadRecommendationRows(container, api as never, 'user1', { random: keepOrder, ...options });
    }

    function titles(): string[] {
        return Array.from(container.querySelectorAll('.lg-rec-section h2')).map(h => h.textContent ?? '');
    }

    function rowContainer(title: string): RowContainer | undefined {
        const section = Array.from(container.querySelectorAll('.lg-rec-section'))
            .find(row => row.querySelector('h2')?.textContent === title);
        return section?.querySelector<RowContainer>('.itemsContainer') ?? undefined;
    }

    async function rowIds(title: string): Promise<string[] | undefined> {
        const items = await rowContainer(title)?.fetchData();
        return items?.map(item => item.Id ?? '');
    }

    it('requests taste lists, similar items and the movie rows with exact parameters', async () => {
        const api = fakeApiClient();

        await load(api);

        expect(api.getItems).toHaveBeenCalledWith('user1', {
            Recursive: true,
            IncludeItemTypes: 'Movie',
            IsPlayed: true,
            Fields: 'Genres',
            SortBy: 'DatePlayed',
            SortOrder: 'Descending',
            Limit: 100
        });
        expect(api.getItems).toHaveBeenCalledWith('user1', {
            Recursive: true,
            IncludeItemTypes: 'Movie',
            IsFavorite: true,
            Fields: 'Genres',
            SortBy: 'DateCreated',
            SortOrder: 'Descending',
            Limit: 100
        });
        expect(api.getItems).toHaveBeenCalledWith('user1', {
            Recursive: true,
            IncludeItemTypes: 'Movie',
            Filters: 'IsResumable',
            Fields: 'Genres',
            SortBy: 'DatePlayed',
            SortOrder: 'Descending',
            Limit: 20
        });
        expect(api.getItems).toHaveBeenCalledWith('user1', {
            Recursive: true,
            IncludeItemTypes: 'Movie',
            IsPlayed: false,
            Genres: 'Comedy|Drama',
            SortBy: 'CommunityRating,CriticRating',
            SortOrder: 'Descending',
            Limit: 40,
            Fields: 'PrimaryImageAspectRatio',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Thumb'
        });
        expect(api.getItems).toHaveBeenCalledWith('user1', {
            Recursive: true,
            IncludeItemTypes: 'Movie',
            IsPlayed: false,
            SortBy: 'CriticRating,CommunityRating',
            SortOrder: 'Descending',
            Limit: 16,
            Fields: 'PrimaryImageAspectRatio',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Thumb'
        });
        expect(api.getItems).toHaveBeenCalledWith('user1', expect.objectContaining({
            Genres: 'Comedy|Drama',
            SortBy: 'DateCreated',
            IsPlayed: false
        }));
    });

    it('requests similar items for each watched baseline with exact parameters and never asks for Movies/Recommendations', async () => {
        const api = fakeApiClient();

        await load(api);

        expect(api.getUrl).toHaveBeenCalledWith('Items/p1/Similar', {
            userId: 'user1',
            limit: 20,
            fields: 'PrimaryImageAspectRatio'
        });
        expect(api.getUrl).toHaveBeenCalledWith('Items/p2/Similar', expect.any(Object));
        expect(api.getUrl).not.toHaveBeenCalledWith('Movies/Recommendations', expect.anything());
        expect(api.getJSON).not.toHaveBeenCalledWith(expect.stringContaining('Movies/Recommendations'));
    });

    it('renders similar rows first, then top picks, highly rated and new in genres', async () => {
        const api = fakeApiClient();

        await load(api);

        expect(titles()).toEqual([
            'Because You Watched Movie p1',
            'Because You Watched Movie p2',
            'Top Picks for You',
            'Highly Rated, Not Yet Watched',
            'New in Your Genres'
        ]);
    });

    it('labels a liked baseline row as Because You Liked and a resumed baseline as Because You Watched', async () => {
        const api = fakeApiClient({
            resumable: () => queryResult([ named('r1', 'Resumed', 2020) ]),
            played: () => queryResult([]),
            favourites: () => queryResult([ named('f1', 'Loved', 2010) ])
        });

        await load(api);

        expect(titles().slice(0, 2)).toEqual([ 'Because You Watched Resumed', 'Because You Liked Loved' ]);
    });

    it('excludes the baseline from its own similar row', async () => {
        const api = fakeApiClient({
            resumable: () => queryResult([ named('r1', 'Resumed', 2020) ]),
            played: () => queryResult([])
        }, {
            r1: () => queryResult([ named('r1', 'Resumed', 2020), named('a1', 'A One', 2001), named('a2', 'A Two', 2002), named('a3', 'A Three', 2003), named('a4', 'A Four', 2004) ])
        });

        await load(api);

        expect(await rowIds('Because You Watched Resumed')).toEqual([ 'a1', 'a2', 'a3', 'a4' ]);
    });

    it('orders a similar row with unwatched items first and highest rated first', async () => {
        const api = fakeApiClient({
            played: () => queryResult([ named('p1', 'Heat', 1995) ])
        }, {
            p1: () => queryResult([
                { Id: 'watched', Name: 'Watched', ProductionYear: 2000, CommunityRating: 9, UserData: { Played: true } },
                { Id: 'low', Name: 'Low', ProductionYear: 2001, CommunityRating: 5 },
                { Id: 'top', Name: 'Top', ProductionYear: 2002, CommunityRating: 8 },
                { Id: 'mid', Name: 'Mid', ProductionYear: 2003, CommunityRating: 7 },
                { Id: 'none', Name: 'None', ProductionYear: 2004 }
            ] as BaseItemDto[])
        });

        await load(api);

        expect(await rowIds('Because You Watched Heat')).toEqual([ 'top', 'mid', 'low', 'none', 'watched' ]);
    });

    it('chooses liked baselines with the injected random source', async () => {
        const favourites = movies('f', 5);
        const api = fakeApiClient({ played: () => queryResult([]), favourites: () => queryResult(favourites) });

        await load(api, { random: () => 0 });

        expect(titles().slice(0, 2)).toEqual([ 'Because You Liked Movie f2', 'Because You Liked Movie f3' ]);
        expect(api.getUrl).toHaveBeenCalledWith('Items/f2/Similar', expect.any(Object));
        expect(api.getUrl).toHaveBeenCalledWith('Items/f3/Similar', expect.any(Object));
    });

    it('shows at most two similar rows by default and up to maxSimilarRows when given', async () => {
        const defaultApi = fakeApiClient();
        await load(defaultApi);
        expect(titles().filter(title => title.startsWith('Because You Watched'))).toHaveLength(2);

        container = document.createElement('div');
        const sixApi = fakeApiClient();
        await load(sixApi, { maxSimilarRows: 6 });
        expect(titles().filter(title => title.startsWith('Because You Watched'))).toHaveLength(6);
        expect(sixApi.getUrl).toHaveBeenCalledWith('Items/p6/Similar', expect.any(Object));
    });

    it('drops only the similar row whose request rejects and logs the failure', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const failure = new Error('boom');
        const api = fakeApiClient({}, { p1: () => Promise.reject(failure) });

        await load(api);

        expect(titles()).toEqual([
            'Because You Watched Movie p2',
            'Top Picks for You',
            'Highly Rated, Not Yet Watched',
            'New in Your Genres'
        ]);
        expect(consoleError).toHaveBeenCalledWith('[recommendations] similar p1 failed', failure);
    });

    it('shows only the highly rated row and makes no similar requests when there is no taste signal', async () => {
        const api = fakeApiClient({ played: () => queryResult([]) });

        await load(api);

        expect(api.getJSON).not.toHaveBeenCalled();
        expect(api.getItems).toHaveBeenCalledTimes(4);
        expect(titles()).toEqual([ 'Highly Rated, Not Yet Watched' ]);
    });

    it('shows liked baseline rows and all other rows for a user whose only signal is favourites', async () => {
        const api = fakeApiClient({
            played: () => queryResult([]),
            favourites: () => queryResult(movies('f', 6, [ 'Drama', 'Comedy' ]))
        });

        await load(api);

        expect(titles()).toEqual([
            'Because You Liked Movie f1',
            'Because You Liked Movie f2',
            'Top Picks for You',
            'Highly Rated, Not Yet Watched',
            'New in Your Genres'
        ]);
    });

    it('merges taste lists by Id before counting genres, so duplicates are not double counted', async () => {
        const api = fakeApiClient({
            played: () => queryResult([ movie('x', [ 'Drama' ]), movie('w', [ 'Horror' ]) ]),
            favourites: () => queryResult([ movie('x', [ 'Drama' ]), movie('y', [ 'Action' ]) ])
        });

        await load(api);

        expect(api.getItems).toHaveBeenCalledWith('user1', expect.objectContaining({
            Genres: 'Action|Drama|Horror',
            SortBy: 'DateCreated'
        }));
    });

    it('drops only the row whose request rejects and logs the failure', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const failure = new Error('boom');
        const api = fakeApiClient({ top: () => Promise.reject(failure) });

        await load(api);

        expect(titles()).toEqual([
            'Because You Watched Movie p1',
            'Because You Watched Movie p2',
            'Highly Rated, Not Yet Watched',
            'New in Your Genres'
        ]);
        expect(consoleError).toHaveBeenCalledWith('[recommendations] top picks failed', failure);
    });

    it('wires each row with its items so a refresh renders the cards', async () => {
        const api = fakeApiClient();

        await load(api);

        const highly = rowContainer('Highly Rated, Not Yet Watched');
        const items = await highly?.fetchData();

        expect(container.querySelectorAll('.lg-rec-section .itemsContainer')).toHaveLength(5);
        expect(items?.map(item => item.Id)).toEqual([ 'h1', 'h2', 'h3', 'h4' ]);
        expect(highly?.getItemsHtml(movies('h', 2))).toBe('<card data-id="h1"></card><card data-id="h2"></card>');
    });

    it('filters favourites out of Top picks client-side and shows at most sixteen', async () => {
        const favourites = [ 'f1', 'f2' ].map(id => ({ ...movie(id), UserData: { IsFavorite: true } }) as BaseItemDto);
        const api = fakeApiClient({ top: () => queryResult([ ...favourites, ...movies('t', 18) ]) });

        await load(api);

        const topCall = api.getItems.mock.calls.find(([ , options ]) => options.SortBy === 'CommunityRating,CriticRating');
        expect(topCall?.[1]).toEqual(expect.objectContaining({ Limit: 40 }));
        expect(topCall?.[1]).not.toHaveProperty('IsFavorite');

        const ids = await rowIds('Top Picks for You');

        expect(ids).toEqual(Array.from({ length: 16 }, (_, i) => `t${i + 1}`));
    });

    it('escapes row titles before inserting them into the DOM', async () => {
        const api = fakeApiClient({ played: () => queryResult([ named('p1', '<img src=x>', 2000) ]) });

        await load(api);

        expect(container.querySelector('img')).toBeNull();
        expect(titles()[0]).toBe('Because You Watched <img src=x>');
    });
});

describe('resumeRecommendationRows', () => {
    type ResumableRow = HTMLElement & { resume: (options: { refresh: boolean }) => Promise<unknown> };

    function rowsRoot(): { root: HTMLElement; rows: ResumableRow[]; outside: ResumableRow } {
        const root = document.createElement('div');
        root.innerHTML = '<div class="lg-rec-section"><div class="itemsContainer"></div></div>'
            + '<div class="lg-rec-section"><div class="itemsContainer"></div></div>'
            + '<div class="itemsContainer"></div>';
        const all = Array.from(root.querySelectorAll<ResumableRow>('.itemsContainer'));
        for (const element of all) {
            element.resume = vi.fn(() => Promise.resolve());
        }
        return { root, rows: all.slice(0, 2), outside: all[2] };
    }

    it('resumes each row item container with a refresh and leaves other containers alone', async () => {
        const { root, rows, outside } = rowsRoot();

        await resumeRecommendationRows(root);

        expect(rows[0].resume).toHaveBeenCalledWith({ refresh: true });
        expect(rows[1].resume).toHaveBeenCalledWith({ refresh: true });
        expect(outside.resume).not.toHaveBeenCalled();
    });

    it('rejects when a row fails to resume so the caller can log it', async () => {
        const { root, rows } = rowsRoot();
        rows[1].resume = vi.fn(() => Promise.reject(new Error('boom')));

        await expect(resumeRecommendationRows(root)).rejects.toThrow('boom');
    });
});

describe('startLatestRequest', () => {
    it('reports only the most recent request for an owner as latest', () => {
        const owner = document.createElement('div');

        const first = startLatestRequest(owner);
        const second = startLatestRequest(owner);

        expect(first()).toBe(false);
        expect(second()).toBe(true);
    });

    it('tracks each owner independently', () => {
        const ownerA = document.createElement('div');
        const ownerB = document.createElement('div');

        const firstA = startLatestRequest(ownerA);
        startLatestRequest(ownerB);

        expect(firstA()).toBe(true);
    });
});

describe('loadRecommendationRows on Liquid Glass', () => {
    let container: HTMLElement;

    beforeEach(() => {
        document.documentElement.setAttribute('data-jf-theme', 'liquidglass');
        vi.mocked(bindGlassTiles).mockClear();
        container = document.createElement('div');
    });

    afterEach(() => {
        document.documentElement.removeAttribute('data-jf-theme');
    });

    function rowFor(title: string): RowContainer | undefined {
        const heading = Array.from(container.querySelectorAll('.lg-rec-section h2')).find(h => h.textContent === title);
        return heading?.closest('.lg-rec-section')?.querySelector<RowContainer>('.itemsContainer') ?? undefined;
    }

    it('renders every row as glass tiles, landscape only for Top Picks', async () => {
        const api = fakeApiClient();

        await loadRecommendationRows(container, api as never, 'user1', { random: keepOrder });

        const sample = movies('x', 1);
        expect(rowFor('Because You Watched Movie p1')?.getItemsHtml(sample)).toContain('lg-tile--portrait');
        expect(rowFor('Top Picks for You')?.getItemsHtml(sample)).toContain('lg-tile--landscape');
        expect(rowFor('Highly Rated, Not Yet Watched')?.getItemsHtml(sample)).toContain('lg-tile--portrait');
        expect(rowFor('New in Your Genres')?.getItemsHtml(sample)).toContain('lg-tile--portrait');
        expect(rowFor('New in Your Genres')?.getItemsHtml(sample)).not.toContain('<card');
    });

    it('marks each row items container so the tiles lay out in one line', async () => {
        const api = fakeApiClient();

        await loadRecommendationRows(container, api as never, 'user1', { random: keepOrder });

        expect(rowFor('Top Picks for You')?.classList.contains('lg-tiles-row')).toBe(true);
        expect(rowFor('Highly Rated, Not Yet Watched')?.classList.contains('lg-tiles-row')).toBe(true);
    });

    it('requests Genres and Overview for every row drawn as tiles and keeps the taste lists unchanged', async () => {
        const api = fakeApiClient();

        await loadRecommendationRows(container, api as never, 'user1', { random: keepOrder });

        const tileFields = 'PrimaryImageAspectRatio,Genres,Overview';
        expect(api.getItems).toHaveBeenCalledWith('user1', expect.objectContaining({ IsPlayed: true, Fields: 'Genres' }));
        expect(api.getItems).toHaveBeenCalledWith('user1', expect.objectContaining({ SortBy: 'CommunityRating,CriticRating', Fields: tileFields }));
        expect(api.getItems).toHaveBeenCalledWith('user1', expect.objectContaining({ SortBy: 'CriticRating,CommunityRating', Fields: tileFields }));
        expect(api.getItems).toHaveBeenCalledWith('user1', expect.objectContaining({ SortBy: 'DateCreated', IsPlayed: false, Fields: tileFields }));
        expect(api.getUrl).toHaveBeenCalledWith('Items/p1/Similar', { userId: 'user1', limit: 20, fields: tileFields });
    });

    it('binds each row once per render and unbinds the previous wiring on re-render', async () => {
        const api = fakeApiClient();
        await loadRecommendationRows(container, api as never, 'user1', { random: keepOrder });
        const row = rowFor('Highly Rated, Not Yet Watched');

        row?.getItemsHtml(movies('h', 2));

        expect(bindGlassTiles).toHaveBeenCalledTimes(1);
        expect(bindGlassTiles).toHaveBeenCalledWith(row, api);
        const firstUnbind = vi.mocked(bindGlassTiles).mock.results[0].value as Mock;
        expect(firstUnbind).not.toHaveBeenCalled();

        row?.getItemsHtml(movies('h', 3));

        expect(bindGlassTiles).toHaveBeenCalledTimes(2);
        expect(firstUnbind).toHaveBeenCalledTimes(1);
        const secondUnbind = vi.mocked(bindGlassTiles).mock.results[1].value as Mock;
        expect(secondUnbind).not.toHaveBeenCalled();
    });

    it('keeps the card path and never binds tiles on a stock theme', async () => {
        document.documentElement.removeAttribute('data-jf-theme');
        const api = fakeApiClient();

        await loadRecommendationRows(container, api as never, 'user1', { random: keepOrder });

        const row = rowFor('Highly Rated, Not Yet Watched');
        expect(row?.getItemsHtml(movies('h', 1))).toBe('<card data-id="h1"></card>');
        expect(row?.classList.contains('lg-tiles-row')).toBe(false);
        expect(bindGlassTiles).not.toHaveBeenCalled();
        expect(api.getItems).toHaveBeenCalledWith('user1', expect.objectContaining({
            SortBy: 'CriticRating,CommunityRating',
            Fields: 'PrimaryImageAspectRatio'
        }));
    });
});
