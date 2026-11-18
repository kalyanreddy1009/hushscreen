import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BRAND_NAME, renderBrandLockup, renderBrandMark } from './brandMark';

const MARK_SVG = resolve(__dirname, '../../assets/img/brand/mark.svg');

function ids(markup: string): string[] {
    return Array.from(markup.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);
}

describe('renderBrandMark', () => {
    it('returns a single svg at the requested size', () => {
        const markup = renderBrandMark({ size: 96 });

        expect(markup.match(/<svg\b/g)).toHaveLength(1);
        expect(markup).toContain('width="96"');
        expect(markup).toContain('height="96"');
        expect(markup).toContain('viewBox="0 0 512 512"');
    });

    it('gives two marks with different prefixes no shared id', () => {
        const first = ids(renderBrandMark({ size: 40, idPrefix: 'a' }));
        const second = ids(renderBrandMark({ size: 40, idPrefix: 'b' }));

        expect(first.length).toBeGreaterThan(0);
        expect(first.filter((id) => second.includes(id))).toEqual([]);
        expect(new Set(first).size).toBe(first.length);
    });

    it('references only ids it defines', () => {
        const markup = renderBrandMark({ size: 40, idPrefix: 'x' });
        const defined = ids(markup);
        const used = Array.from(markup.matchAll(/url\(#([^)]+)\)/g), (match) => match[1]);

        expect(used.every((id) => defined.includes(id))).toBe(true);
    });

    it('adds hs-animate only when animated', () => {
        expect(renderBrandMark({ size: 40 })).not.toContain('hs-animate');
        expect(renderBrandMark({ size: 40, animated: false })).not.toContain('hs-animate');
        expect(renderBrandMark({ size: 40, animated: true })).toContain('hs-animate');
    });

    it('drops the floor reflection in the simple variant', () => {
        expect(renderBrandMark({ size: 16 })).toContain('-refl)');
        expect(renderBrandMark({ size: 16, simple: true })).not.toContain('-refl)');
    });

    it('matches the geometry of src/assets/img/brand/mark.svg', () => {
        const file = readFileSync(MARK_SVG, 'utf8').trim();

        expect(file).toBe(renderBrandMark({ size: 512, idPrefix: 'hs' }));
        for (const points of ['140,76 372,76 304,114 208,114', '131,82 140,76 124,446 115,440', '304,114 372,76 388,446 304,404']) {
            expect(file).toContain(`points="${points}"`);
        }
    });
});

describe('renderBrandLockup', () => {
    it('wraps the mark and the wordmark in hs-lockup', () => {
        const markup = renderBrandLockup({ markSize: 64 });

        expect(markup.startsWith('<span class="hs-lockup"')).toBe(true);
        expect(markup).toContain(`<span class="hs-wordmark">${BRAND_NAME}</span>`);
        expect(BRAND_NAME).toBe('HushScreen');
        expect(markup.match(/<svg\b/g)).toHaveLength(1);
        expect(markup).toContain('width="64"');
    });

    it('animates both lockup and mark only when asked', () => {
        expect(renderBrandLockup({ markSize: 64 })).not.toContain('hs-animate');
        expect(renderBrandLockup({ markSize: 64, animated: true }).match(/hs-animate/g)).toHaveLength(2);
    });

    it('forwards idPrefix to the mark', () => {
        expect(ids(renderBrandLockup({ markSize: 64, idPrefix: 'splash' })).every((id) => id.startsWith('splash-'))).toBe(true);
    });
});
