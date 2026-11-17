import { describe, expect, it } from 'vitest';

import { CONDENSE_AT, EXPAND_AT, nextCondensed } from './headerScroll';

describe('nextCondensed', () => {
    it('condenses past the threshold', () => {
        expect(nextCondensed(CONDENSE_AT + 1, false)).toBe(true);
        expect(nextCondensed(CONDENSE_AT, false)).toBe(false);
    });

    it('stays condensed until scrolled back near the top', () => {
        expect(nextCondensed(CONDENSE_AT - 5, true)).toBe(true);
        expect(nextCondensed(EXPAND_AT, true)).toBe(false);
    });
});
