// HushScreen brand mark: a glass doorway. This file is the single source of truth for the artwork;
// scripts/brand/render_brand.mjs imports it to write src/assets/img/brand/mark.svg, icon.svg and the PNGs.
// Animation and layout CSS live in src/themes/liquidglass/_brand.scss (and a splash copy in styles/site.scss).

/** Wordmark text next to the mark. */
export const BRAND_NAME = 'HushScreen';

const VIEW_BOX = 512;
const CHAMPAGNE = '#D8C3A5';
const CHAMPAGNE_LIGHT = '#E8D6BC';
const CHAMPAGNE_HOT = '#F3E4CC';
const LIGHT = '#F2D9B5';

// Doorway geometry in the 512 viewBox: two doors swung wide open toward the viewer. Each inner face is a
// foreshortened trapezoid hinged at the opening (x 208 / 304) and taller at the near edge; the outer sliver is the
// slab thickness on the near edge; the lintel spans the near tops.
const LEFT_OUTER = '131,82 140,76 124,446 115,440';
const LEFT_INNER = '140,76 208,114 208,404 124,446';
const RIGHT_OUTER = '381,82 372,76 388,446 397,440';
const RIGHT_INNER = '304,114 372,76 388,446 304,404';
const LINTEL = '140,76 372,76 304,114 208,114';
const OPENING = '208,114 304,114 304,404 208,404';

export interface BrandMarkOptions {
    size: number;
    animated?: boolean;
    idPrefix?: string;
    /** Small-size variant: no floor reflection on the glass, thicker rims. Used for 16 and 32 px favicons. */
    simple?: boolean;
}

export interface BrandLockupOptions {
    markSize: number;
    animated?: boolean;
    idPrefix?: string;
}

type Stop = readonly [number, string, number];

function stops(list: ReadonlyArray<Stop>): string {
    return list.map(([offset, color, opacity]) =>
        `<stop offset="${offset}" stop-color="${color}" stop-opacity="${opacity}"/>`
    ).join('');
}

function vertical(id: string, list: ReadonlyArray<Stop>): string {
    return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops(list)}</linearGradient>`;
}

function horizontal(id: string, list: ReadonlyArray<Stop>): string {
    return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${stops(list)}</linearGradient>`;
}

function defs(p: string): string {
    return '<defs>'
        + vertical(`${p}-outer`, [[0, '#766B64', 0.94], [1, '#443D39', 0.96]])
        + vertical(`${p}-inner`, [[0, '#D6C8BB', 0.66], [0.5, '#D3BFA6', 0.74], [1, '#E4CDAA', 0.9]])
        + horizontal(`${p}-sheenl`, [[0, '#FFFFFF', 0.02], [0.7, '#FFF4E2', 0.16], [1, '#FFF1DA', 0.42]])
        + horizontal(`${p}-sheenr`, [[0, '#FFF1DA', 0.42], [0.3, '#FFF4E2', 0.16], [1, '#FFFFFF', 0.02]])
        + horizontal(`${p}-spilll`, [[0, LIGHT, 0], [1, LIGHT, 0.4]])
        + horizontal(`${p}-spillr`, [[0, LIGHT, 0.4], [1, LIGHT, 0]])
        + vertical(`${p}-refl`, [[0.3, LIGHT, 0], [0.75, LIGHT, 0.4], [1, LIGHT, 0.7]])
        + vertical(`${p}-lintel`, [[0, '#8A7C70', 0.85], [1, '#3A322E', 0.92]])
        + vertical(`${p}-gloss`, [[0, '#FFFFFF', 0.3], [1, '#FFFFFF', 0]])
        + vertical(`${p}-open`, [[0, '#2B2420', 1], [1, '#3B2F26', 1]])
        + vertical(`${p}-glow`, [[0, LIGHT, 0], [0.35, LIGHT, 0.12], [0.7, LIGHT, 0.55], [1, LIGHT, 1]])
        + `<radialGradient id="${p}-pool" cx="0.5" cy="0.5" r="0.5">`
        + stops([[0, LIGHT, 0.9], [0.45, LIGHT, 0.42], [1, LIGHT, 0]]) + '</radialGradient>'
        + `<filter id="${p}-blur6" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7"/></filter>`
        + `<filter id="${p}-blur3" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>`
        + `<filter id="${p}-frost" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7"/>`
        + '<feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 0.96  0 0 0 0 0.9  0 0 0 0.9 -0.38"/><feComposite in2="SourceGraphic" operator="in"/></filter>'
        + `<clipPath id="${p}-clip"><polygon points="${OPENING}"/></clipPath>`
        + '</defs>';
}

function slab(p: string, side: 'l' | 'r', outer: string, inner: string, simple: boolean): string {
    const reflection = simple ? '' : `<polygon points="${inner}" fill="url(#${p}-refl)"/><polygon points="${inner}" fill="url(#${p}-spill${side})"/>`;
    const frost = simple ? '' : `<polygon points="${inner}" fill="#FFFFFF" fill-opacity="0.5" filter="url(#${p}-frost)"/>`;
    return `<g class="hs-slab hs-slab-${side}">`
        + `<polygon points="${outer}" fill="url(#${p}-outer)"/>`
        + `<polygon points="${inner}" fill="url(#${p}-inner)"/>`
        + `<polygon points="${inner}" fill="url(#${p}-sheen${side})"/>`
        + frost
        + reflection
        + '</g>';
}

function rims(p: string, k: number): string {
    const w = (n: number) => (n * k).toFixed(2);
    const line = (d: string, width: number, color: string, opacity: number) =>
        `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w(width)}" stroke-opacity="${opacity}" stroke-linejoin="round" stroke-linecap="round"/>`;
    const outlines = [
        'M140,76 L208,114 L208,404 L124,446 Z',
        'M372,76 L304,114 L304,404 L388,446 Z'
    ];
    const edges = [
        'M131,82 L140,76 L124,446 L115,440 Z',
        'M381,82 L372,76 L388,446 L397,440 Z'
    ];
    const innerEdges = 'M208,114 L208,404 M304,114 L304,404';
    const glowPaths = `${outlines.join(' ')} ${innerEdges}`;
    return '<g class="hs-rim">'
        + `<path d="${glowPaths}" fill="none" stroke="${LIGHT}" stroke-width="${w(5)}" stroke-opacity="0.45" filter="url(#${p}-blur3)"/>`
        + edges.map((d) => line(d, 1.5, '#D2BEA2', 0.85)).join('')
        + outlines.map((d) => line(d, 1.7, CHAMPAGNE, 0.9)).join('')
        + line('M140,76 L372,76', 1.9, CHAMPAGNE_LIGHT, 0.95)
        + line('M208,114 L304,114', 1.2, CHAMPAGNE, 0.55)
        + line(innerEdges, 2.8, CHAMPAGNE_HOT, 1)
        + '</g>';
}

/** Mark artwork without the outer svg element: defs plus layers, back to front. */
export function renderBrandMarkBody(idPrefix = 'hs', simple = false): string {
    const p = idPrefix;
    return defs(p)
        + `<polygon points="${OPENING}" fill="url(#${p}-open)"/>`
        + `<g class="hs-light"><g class="hs-light-fx hs-glow" clip-path="url(#${p}-clip)">`
        + `<rect x="198" y="106" width="116" height="304" fill="url(#${p}-glow)" filter="url(#${p}-blur6)"/>`
        + `<ellipse cx="256" cy="398" rx="44" ry="86" fill="url(#${p}-pool)" filter="url(#${p}-blur6)"/>`
        + '</g></g>'
        + slab(p, 'l', LEFT_OUTER, LEFT_INNER, simple)
        + slab(p, 'r', RIGHT_OUTER, RIGHT_INNER, simple)
        + '<g class="hs-lintel">'
        + `<polygon points="${LINTEL}" fill="url(#${p}-lintel)"/>`
        + `<polygon points="${LINTEL}" fill="url(#${p}-gloss)"/>`
        + '</g>'
        + '<g class="hs-light"><g class="hs-light-fx hs-pool">'
        + `<ellipse cx="256" cy="432" rx="186" ry="36" fill="url(#${p}-pool)"/>`
        + `<ellipse cx="256" cy="418" rx="96" ry="14" fill="${LIGHT}" fill-opacity="0.75" filter="url(#${p}-blur3)"/>`
        + '</g></g>'
        + rims(p, simple ? 1.9 : 1);
}

export function renderBrandMark(opts: BrandMarkOptions): string {
    const { size, animated = false, idPrefix = 'hs', simple = false } = opts;
    const cls = animated ? 'hs-mark hs-animate' : 'hs-mark';
    return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_BOX} ${VIEW_BOX}" `
        + `width="${size}" height="${size}" aria-hidden="true" focusable="false">`
        + renderBrandMarkBody(idPrefix, simple)
        + '</svg>';
}

export function renderBrandLockup(opts: BrandLockupOptions): string {
    const { markSize, animated = false, idPrefix = 'hs' } = opts;
    const cls = animated ? 'hs-lockup hs-animate' : 'hs-lockup';
    return `<span class="${cls}" style="--hs-mark:${markSize}px">`
        + renderBrandMark({ size: markSize, animated, idPrefix })
        + `<span class="hs-wordmark">${BRAND_NAME}</span>`
        + '</span>';
}
