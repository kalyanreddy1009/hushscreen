import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

export const MAX_HERO_ITEMS = 5;

/** Whether the item has a backdrop of its own or inherited from its parent (series, collection). */
export function hasUsableBackdrop(item: BaseItemDto): boolean {
    if (item.BackdropImageTags?.length) return true;
    return Boolean(item.ParentBackdropImageTags?.length && item.ParentBackdropItemId);
}

/**
 * Pick up to five unique, backdrop-bearing items for the home hero.
 * Priority is resume, then next up, then latest. Duplicates are dropped by Id and by SeriesId
 * so one show never appears twice.
 */
export function selectHeroItems(
    resume: readonly BaseItemDto[] | null | undefined,
    nextUp: readonly BaseItemDto[] | null | undefined,
    latest: readonly BaseItemDto[] | null | undefined
): BaseItemDto[] {
    const seenIds = new Set<string>();
    const seenSeries = new Set<string>();
    const selected: BaseItemDto[] = [];

    for (const item of [...(resume ?? []), ...(nextUp ?? []), ...(latest ?? [])]) {
        if (selected.length >= MAX_HERO_ITEMS) break;
        if (!item?.Id || seenIds.has(item.Id)) continue;
        if (item.SeriesId && seenSeries.has(item.SeriesId)) continue;
        if (!hasUsableBackdrop(item)) continue;

        seenIds.add(item.Id);
        if (item.SeriesId) seenSeries.add(item.SeriesId);
        selected.push(item);
    }

    return selected;
}
