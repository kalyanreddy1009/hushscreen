import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { describe, expect, it } from 'vitest';

import { selectHeroItems } from './selectHeroItems';

const make = (id: string, extra: Partial<BaseItemDto> = {}): BaseItemDto => ({
    Id: id,
    BackdropImageTags: ['tag'],
    ...extra
});

describe('selectHeroItems', () => {
    it('returns an empty array for empty or missing inputs', () => {
        expect(selectHeroItems([], [], [])).toEqual([]);
        expect(selectHeroItems(null, undefined, null)).toEqual([]);
    });

    it('orders resume, then next up, then latest', () => {
        const result = selectHeroItems([make('r')], [make('n')], [make('l')]);
        expect(result.map(i => i.Id)).toEqual([ 'r', 'n', 'l' ]);
    });

    it('dedupes by Id', () => {
        const result = selectHeroItems([make('a')], [make('a')], [make('a'), make('b')]);
        expect(result.map(i => i.Id)).toEqual([ 'a', 'b' ]);
    });

    it('dedupes by SeriesId, keeping the highest priority item', () => {
        const result = selectHeroItems(
            [make('ep1', { SeriesId: 's' })],
            [make('ep2', { SeriesId: 's' })],
            [make('m')]
        );
        expect(result.map(i => i.Id)).toEqual([ 'ep1', 'm' ]);
    });

    it('drops items without a usable backdrop', () => {
        const result = selectHeroItems(
            [{ Id: 'none' }, { Id: 'parentTagOnly', ParentBackdropImageTags: ['t'] }],
            [{ Id: 'parent', ParentBackdropImageTags: ['t'], ParentBackdropItemId: 'p' }],
            [make('own')]
        );
        expect(result.map(i => i.Id)).toEqual([ 'parent', 'own' ]);
    });

    it('caps the result at five items', () => {
        const latest = Array.from({ length: 12 }, (_, i) => make(`l${i}`));
        expect(selectHeroItems([], [], latest)).toHaveLength(5);
    });
});
