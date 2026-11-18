import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import escapeHtml from 'escape-html';
import type { ApiClient } from 'jellyfin-apiclient';

import cardBuilder from '../../cardbuilder/cardBuilder';
import { bindGlassTiles, renderGlassTiles, type GlassTileShape } from '../../liquidglass/glassTile';
import globalize from '../../../lib/globalize';
import { isLiquidGlass } from '../../../themes/liquidglass/isLiquidGlass';
import { getBackdropShape, getPortraitShape } from '../../../utils/card';

import type { SectionContainerElement } from './section';

const MIN_ROW_ITEMS = 4;
const TOP_GENRE_COUNT = 3;
const MAX_SIMILAR_ROWS = 2;
const PLAYED_HISTORY_LIMIT = 100;
const FAVOURITES_LIMIT = 100;
const RESUMABLE_LIMIT = 20;
const ROW_LIMIT = 16;
const TOP_PICKS_FETCH_LIMIT = 40;
const SIMILAR_FETCH_LIMIT = 20;
const TILE_IMAGE_FIELDS = 'PrimaryImageAspectRatio';
const TILE_IMAGE_TYPES = 'Primary,Backdrop,Thumb';
const GLASS_TILE_FIELDS = 'Genres,Overview';
const glassRowUnbinds = new WeakMap<Element, () => void>();

export interface RecommendationRow {
    title: string;
    items: BaseItemDto[];
    landscape?: boolean;
}

export interface RecommendationRowsOptions {
    maxSimilarRows?: number;
    random?: () => number;
}

/** The user's taste signals: what they resumed, played and favourited (each most recent first). */
export interface TasteLists {
    resumable: BaseItemDto[];
    played: BaseItemDto[];
    favourites: BaseItemDto[];
}

/** A movie to build a similar-items row from: watched (resumed or played) or liked (favourited). */
export interface SimilarBaseline {
    item: BaseItemDto;
    kind: 'watched' | 'liked';
}

interface PlayedMoviesResult {
    Items?: BaseItemDto[];
}

interface SimilarItemsResult {
    Items?: BaseItemDto[];
}

/** Returns the most common genres across the given items, most frequent first, ties broken by name. */
export function getTopGenres(played: BaseItemDto[], count = TOP_GENRE_COUNT): string[] {
    const counts = new Map<string, number>();
    for (const item of played) {
        for (const genre of item.Genres ?? []) {
            counts.set(genre, (counts.get(genre) ?? 0) + 1);
        }
    }

    return [ ...counts.entries() ]
        .sort(([ nameA, countA ], [ nameB, countB ]) => countB - countA || nameA.localeCompare(nameB))
        .slice(0, count)
        .map(([ name ]) => name);
}

/**
 * Orders items for display without mutating the input: unwatched first, then by community rating
 * descending (missing rating counts as 0). Equal items keep their original order.
 */
export function orderSimilarItems(items: BaseItemDto[]): BaseItemDto[] {
    return [ ...items ].sort((a, b) => {
        const watchedDiff = Number(a.UserData?.Played === true) - Number(b.UserData?.Played === true);
        return watchedDiff || (b.CommunityRating ?? 0) - (a.CommunityRating ?? 0);
    });
}

/** Returns a shuffled copy (Fisher-Yates) using the injected random source; the input is not changed. */
function shuffle<T>(items: T[], random: () => number): T[] {
    const copy = [ ...items ];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [ copy[i], copy[j] ] = [ copy[j], copy[i] ];
    }
    return copy;
}

/**
 * Chooses up to max similar-row baselines. Watched movies come first (up to ceil(max / 2), most recent
 * first); the rest are random favourites. If there are too few favourites, spare slots take more watched movies.
 */
export function pickBaselines(
    taste: TasteLists,
    max = MAX_SIMILAR_ROWS,
    random: () => number = Math.random
): SimilarBaseline[] {
    const watched = mergeById([ taste.resumable, taste.played ]);
    const watchedIds = new Set(watched.map(item => item.Id));
    const liked = mergeById([ taste.favourites ]).filter(item => !watchedIds.has(item.Id));

    const watchedQuota = Math.ceil(max / 2);
    const watchedPicks = watched.slice(0, watchedQuota);
    const likedPicks = shuffle(liked, random).slice(0, max - watchedPicks.length);
    const spare = max - watchedPicks.length - likedPicks.length;
    const extraWatched = watched.slice(watchedPicks.length, watchedPicks.length + spare);

    return [
        ...[ ...watchedPicks, ...extraWatched ].map(item => ({ item, kind: 'watched' as const })),
        ...likedPicks.map(item => ({ item, kind: 'liked' as const }))
    ];
}

/** Removes items already shown in an earlier row and drops rows left with fewer than minItems. */
export function dedupeRows<T extends { items: BaseItemDto[] }>(rows: T[], minItems = MIN_ROW_ITEMS): T[] {
    const shown = new Set<string>();

    return rows.reduce<T[]>((kept, row) => {
        const rowKeys = new Set<string>();
        const items = row.items.filter(item => {
            const keys = dedupeKeys(item);
            if (keys.some(key => shown.has(key) || rowKeys.has(key))) return false;
            for (const key of keys) rowKeys.add(key);
            return true;
        });

        if (items.length < minItems) return kept;
        for (const key of rowKeys) shown.add(key);
        return [ ...kept, { ...row, items } ];
    }, []);
}

/** Keys identifying a movie: its Id, and its normalised name with year (library copies can have different Ids). */
function dedupeKeys(item: BaseItemDto): string[] {
    const keys: string[] = [];
    if (item.Id) keys.push(`id:${item.Id}`);
    const name = item.Name?.trim().toLowerCase();
    if (name) keys.push(`title:${name}|${item.ProductionYear ?? ''}`);
    return keys;
}

function renderRowHtml(row: RecommendationRow): string {
    let html = '';
    html += '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">';
    html += '<h2 class="sectionTitle sectionTitle-cards">' + escapeHtml(row.title) + '</h2>';
    html += '</div>';
    html += '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">';
    html += '<div is="emby-itemscontainer" class="itemsContainer scrollSlider focuscontainer-x"></div>';
    html += '</div>';
    return html;
}

function getRowCardsHtml(row: RecommendationRow, items: BaseItemDto[]): string {
    return cardBuilder.getCardsHtml({
        items: items,
        shape: row.landscape ? getBackdropShape(true) : getPortraitShape(true),
        preferThumb: row.landscape ? true : undefined,
        showTitle: true,
        showYear: true,
        centerText: true,
        overlayPlayButton: true,
        lazy: true,
        context: 'movies',
        lines: 2
    });
}

/** Adds the Liquid Glass tile fields to a Fields list. Stock themes get the list back unchanged. */
export function withGlassTileFields(fields: string): string {
    return isLiquidGlass() ? `${fields},${GLASS_TILE_FIELDS}` : fields;
}

/**
 * Renders a row as glass tiles and wires their clicks to the row container. Each render replaces the
 * wiring of the previous render, so a refreshed row never stacks listeners.
 */
export function renderGlassRow(
    container: Element,
    apiClient: ApiClient,
    items: BaseItemDto[],
    shape: GlassTileShape
): string {
    glassRowUnbinds.get(container)?.();
    glassRowUnbinds.set(container, bindGlassTiles(container as HTMLElement, apiClient));
    return renderGlassTiles(items, { shape });
}

function appendRow(container: HTMLElement, row: RecommendationRow, apiClient: ApiClient): void {
    const section = document.createElement('div');
    section.classList.add('verticalSection', 'lg-rec-section');
    section.innerHTML = renderRowHtml(row);

    const itemsContainer: SectionContainerElement | null = section.querySelector('.itemsContainer');
    if (!itemsContainer) return;

    itemsContainer.fetchData = () => Promise.resolve(row.items);
    if (isLiquidGlass()) {
        itemsContainer.classList.add('lg-tiles-row');
        itemsContainer.getItemsHtml = items => renderGlassRow(itemsContainer, apiClient, items, row.landscape ? 'landscape' : 'portrait');
    } else {
        itemsContainer.getItemsHtml = items => getRowCardsHtml(row, items);
    }
    itemsContainer.parentContainer = section;
    container.appendChild(section);
}

/** Awaits one row's request; a rejection drops only that row and is logged. */
async function settleRow<T>(name: string, request: Promise<T>): Promise<T | undefined> {
    try {
        return await request;
    } catch (err) {
        console.error(`[recommendations] ${name} failed`, err);
        return undefined;
    }
}

/** Merges movie lists in order, keeping the first occurrence of each Id. */
function mergeById(lists: BaseItemDto[][]): BaseItemDto[] {
    const seen = new Set<string>();
    const merged: BaseItemDto[] = [];
    for (const list of lists) {
        for (const item of list) {
            if (item.Id && seen.has(item.Id)) continue;
            if (item.Id) seen.add(item.Id);
            merged.push(item);
        }
    }
    return merged;
}

/** Movies that show the user's taste: resumable, played and favourite movies, kept apart. */
function getTasteLists(apiClient: ApiClient, userId: string): Promise<TasteLists> {
    const base = { Recursive: true, IncludeItemTypes: 'Movie', Fields: 'Genres', SortOrder: 'Descending' };
    return Promise.all([
        settleRow('played', apiClient.getItems(userId, {
            ...base,
            IsPlayed: true,
            SortBy: 'DatePlayed',
            Limit: PLAYED_HISTORY_LIMIT
        }) as Promise<PlayedMoviesResult>),
        settleRow('favourites', apiClient.getItems(userId, {
            ...base,
            IsFavorite: true,
            SortBy: 'DateCreated',
            Limit: FAVOURITES_LIMIT
        }) as Promise<PlayedMoviesResult>),
        settleRow('resumable', apiClient.getItems(userId, {
            ...base,
            Filters: 'IsResumable',
            SortBy: 'DatePlayed',
            Limit: RESUMABLE_LIMIT
        }) as Promise<PlayedMoviesResult>)
    ]).then(([ played, favourites, resumable ]) => ({
        played: played?.Items ?? [],
        favourites: favourites?.Items ?? [],
        resumable: resumable?.Items ?? []
    }));
}

function getUnwatchedMovies(
    apiClient: ApiClient,
    userId: string,
    options: Record<string, unknown>
): Promise<BaseItemDto[]> {
    return apiClient.getItems(userId, {
        Recursive: true,
        IncludeItemTypes: 'Movie',
        IsPlayed: false,
        SortOrder: 'Descending',
        Limit: ROW_LIMIT,
        Fields: withGlassTileFields(TILE_IMAGE_FIELDS),
        ImageTypeLimit: 1,
        EnableImageTypes: TILE_IMAGE_TYPES,
        ...options
    }).then((result: PlayedMoviesResult) => result.Items ?? []);
}

/** Fetches the movies similar to one baseline movie, without the baseline itself, ordered for display. */
function getSimilarItems(apiClient: ApiClient, userId: string, baseline: BaseItemDto): Promise<BaseItemDto[]> {
    const url = apiClient.getUrl('Items/' + baseline.Id + '/Similar', {
        userId,
        limit: SIMILAR_FETCH_LIMIT,
        fields: withGlassTileFields(TILE_IMAGE_FIELDS)
    });
    return (apiClient.getJSON(url) as Promise<SimilarItemsResult>)
        .then(result => (Array.isArray(result?.Items) ? result.Items : []));
}

/** One similar-items row per baseline, fetched in parallel. A failed request yields an empty row, which dedupeRows drops. */
async function loadSimilarRows(
    apiClient: ApiClient,
    userId: string,
    baselines: SimilarBaseline[]
): Promise<RecommendationRow[]> {
    const results = await Promise.all(baselines.map(({ item }) =>
        settleRow(`similar ${item.Id}`, getSimilarItems(apiClient, userId, item))
    ));

    return baselines.map(({ item, kind }, index) => ({
        title: globalize.translate(
            kind === 'watched' ? 'LiquidGlassBecauseYouWatched' : 'LiquidGlassBecauseYouLiked',
            item.Name ?? ''
        ),
        items: orderSimilarItems((results[index] ?? []).filter(similar => similar.Id !== item.Id)).slice(0, ROW_LIMIT)
    }));
}

interface ResumableRowContainer extends HTMLElement {
    resume: (options: { refresh: boolean }) => Promise<unknown> | void;
}

/** Refreshes every recommendation row inside root. A rejected row rejects the result so the caller can log it. */
export function resumeRecommendationRows(root: ParentNode): Promise<unknown[]> {
    const rowContainers = Array.from(root.querySelectorAll<ResumableRowContainer>('.lg-rec-section .itemsContainer'));
    return Promise.all(rowContainers.map(rowContainer => rowContainer.resume({ refresh: true })));
}

const latestRequestIds = new WeakMap<Element, number>();

/**
 * Starts a request for owner and returns a check that is true only while no newer request has started for it.
 * Used to discard late completions when the same view is loaded again.
 */
export function startLatestRequest(owner: Element): () => boolean {
    const requestId = (latestRequestIds.get(owner) ?? 0) + 1;
    latestRequestIds.set(owner, requestId);
    return () => latestRequestIds.get(owner) === requestId;
}

/**
 * Fetches the Liquid Glass recommendation rows and appends them to container.
 * Each row is a `.lg-rec-section` holding one `.itemsContainer`; callers that need the rows loaded
 * (for example the Suggestions tab) query `.lg-rec-section .itemsContainer` and call resume({ refresh: true }).
 * options.maxSimilarRows caps the similar-items rows (default 2); options.random picks the liked baselines (default Math.random).
 */
export async function loadRecommendationRows(
    container: HTMLElement,
    apiClient: ApiClient,
    userId: string,
    options: RecommendationRowsOptions = {}
): Promise<void> {
    const taste = await getTasteLists(apiClient, userId);
    const tasteMovies = mergeById([ taste.played, taste.favourites, taste.resumable ]);
    const topGenres = getTopGenres(tasteMovies);
    const hasHistory = topGenres.length > 0;
    const genreFilter = topGenres.join('|');
    const baselines = pickBaselines(taste, options.maxSimilarRows, options.random);

    const [ similarRows, topPicks, highlyRated, newInGenres ] = await Promise.all([
        loadSimilarRows(apiClient, userId, baselines),
        hasHistory ? settleRow('top picks', getUnwatchedMovies(apiClient, userId, {
            Genres: genreFilter,
            SortBy: 'CommunityRating,CriticRating',
            Limit: TOP_PICKS_FETCH_LIMIT
        }).then(items => items.filter(item => item.UserData?.IsFavorite !== true).slice(0, ROW_LIMIT))) : Promise.resolve(undefined),
        settleRow('highly rated', getUnwatchedMovies(apiClient, userId, {
            SortBy: 'CriticRating,CommunityRating'
        })),
        hasHistory ? settleRow('new in your genres', getUnwatchedMovies(apiClient, userId, {
            Genres: genreFilter,
            SortBy: 'DateCreated'
        })) : Promise.resolve(undefined)
    ]);

    const rows: RecommendationRow[] = [
        ...similarRows,
        { title: globalize.translate('LiquidGlassTopPicks'), items: topPicks ?? [], landscape: true },
        { title: globalize.translate('LiquidGlassHighlyRated'), items: highlyRated ?? [] },
        { title: globalize.translate('LiquidGlassNewInYourGenres'), items: newInGenres ?? [] }
    ];

    for (const row of dedupeRows(rows)) {
        appendRow(container, row, apiClient);
    }
}
