/**
 * Render the HushScreen brand assets (glass doorway mark, app icons, banners) into src/assets/img/brand/.
 *
 * The artwork lives in src/components/liquidglass/brandMark.ts (single source of truth, imported here through
 * Node's built-in TypeScript type stripping, so Node 22.18+ is required). This script:
 *   1. writes mark.svg and icon.svg,
 *   2. screenshots inline-SVG pages with a locally installed Chromium browser (headless, transparent background,
 *      exact pixel sizes) to produce every PNG, plus favicon-16/32/48 sources in a temp directory,
 *   3. rewrites the splash markup in src/index.html so it matches the artwork.
 * The wordmark is Noto Sans 500 (SIL OFL 1.1) from node_modules/@fontsource/noto-sans, embedded in each page.
 *
 * Usage (from the repository root, after `npm ci`):
 *   node scripts/brand/render_brand.mjs                      render everything
 *   node scripts/brand/render_brand.mjs --preview <dir>      also write splash animation frames (PNG) into <dir>
 *   node scripts/brand/render_brand.mjs --only icon,banner   limit to groups: icon, touch, favicon, banner (each
 *                                                            browser launch takes ~10 s on some machines)
 * Add --disable-warning=MODULE_TYPELESS_PACKAGE_JSON after `node` to silence the .ts import notice.
 *   python scripts/brand/pack_favicon.py                     then pack favicon.ico from the temp favicon PNGs
 *
 * Browser lookup: env CHROME_PATH, then Chrome/Chromium, then Edge, at their usual install paths. (Edge's
 * headless --screenshot can silently write nothing on some Windows setups; Chrome is preferred for that reason.)
 * No npm or pip dependencies are added; `sass` is already a project dependency (it compiles the lockup CSS).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as sass from 'sass';

import { BRAND_NAME, renderBrandLockup, renderBrandMark, renderBrandMarkBody } from '../../src/components/liquidglass/brandMark.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'src', 'assets', 'img', 'brand');
const FONT = join(ROOT, 'node_modules', '@fontsource', 'noto-sans', 'files', 'noto-sans-latin-500-normal.woff');
const FAVICON_DIR = join(tmpdir(), 'hushscreen-brand-favicon');

const TILE_TOP_LEFT = '#5E544D';
const TILE_BOTTOM_RIGHT = '#2E2723';
const TILE_RADIUS = 0.22;
const MARK_SCALE = 0.853; // mark art is 360 of 512 tall: 0.853 makes it ~60% of the tile
const FAVICON_MARK_SCALE = { 16: 1, 32: 0.92, 48: 0.8 };
const WORDMARK_LIGHT = '#F3EDE4';
const WORDMARK_DARK = '#1F1B18';
const BANNER = { width: 1302, height: 378, markSize: 376 };
const SPLASH_MARK = 160;

const BROWSERS = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].filter(Boolean);

function findBrowser() {
    const found = BROWSERS.find((p) => existsSync(p));
    if (!found) {
        throw new Error(`No Chromium browser found. Set CHROME_PATH to chrome/msedge/chromium. Looked in:\n  ${BROWSERS.join('\n  ')}`);
    }
    return found;
}

const browser = findBrowser();
const workDir = mkdtempSync(join(tmpdir(), 'hushscreen-brand-'));
let pageCount = 0;

function fontFace() {
    const data = readFileSync(FONT).toString('base64');
    return `@font-face{font-family:'Noto Sans';font-weight:500;src:url(data:font/woff;base64,${data}) format('woff')}`;
}

function compile(scssPath) {
    return sass.compile(join(ROOT, scssPath), { style: 'compressed', loadPaths: [join(ROOT, 'src')] }).css;
}

function page(body, { css = '', script = '' } = {}) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>${fontFace()}
html,body{margin:0;padding:0;background:transparent;overflow:hidden}${css}</style></head><body>${body}${script}</body></html>`;
}

/** Screenshot an HTML string at exactly width x height (CSS px, device scale 1) with a transparent background. */
function shoot(html, width, height, outFile) {
    const file = join(workDir, `page-${pageCount++}.html`);
    writeFileSync(file, html);
    mkdirSync(dirname(outFile), { recursive: true });
    if (existsSync(outFile)) rmSync(outFile);
    const result = spawnSync(browser, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        '--default-background-color=00000000', `--window-size=${width},${height}`,
        '--virtual-time-budget=1500', `--user-data-dir=${join(workDir, 'profile')}`,
        `--screenshot=${outFile}`, pathToFileURL(file).href
    ], { encoding: 'utf8', timeout: 60000 });
    if (!existsSync(outFile) || statSync(outFile).size === 0) {
        throw new Error(`Browser produced no screenshot for ${outFile} (exit ${result.status}): ${result.stderr}`);
    }
}

/** Rounded square with continuous-looking corners: each corner is a quarter superellipse, walked clockwise. */
function squirclePath(size, inset, radiusRatio) {
    const lo = inset;
    const hi = size - inset;
    const e = size * radiusRatio * 1.25 - inset;
    const exponent = 2 / 3.2;
    const steps = 28;
    const signedPow = (v) => Math.sign(v) * Math.abs(v) ** exponent;
    const corners = [
        [hi - e, lo + e, -Math.PI / 2],
        [hi - e, hi - e, 0],
        [lo + e, hi - e, Math.PI / 2],
        [lo + e, lo + e, Math.PI]
    ];
    const pts = corners.flatMap(([cx, cy, start]) => Array.from({ length: steps + 1 }, (_, i) => {
        const t = start + (i / steps) * (Math.PI / 2);
        return [cx + e * signedPow(Math.cos(t)), cy + e * signedPow(Math.sin(t))];
    }));
    const coords = pts.map(([x, y]) => x.toFixed(2) + ',' + y.toFixed(2));
    return 'M' + coords.join(' L') + ' Z';
}

/** Icon artwork on a 512 viewBox. `rounded` = tile with rim and shadow on transparent; otherwise full-bleed opaque. */
function iconSvg({ rounded, markScale = MARK_SCALE, simple = false }) {
    const p = 'hi';
    const tile = squirclePath(512, 0, TILE_RADIUS);
    const rim = squirclePath(512, 1.5, TILE_RADIUS);
    const mark = `<g transform="translate(256 256) scale(${markScale}) translate(-256 -256)">${renderBrandMarkBody(p, simple)}</g>`;
    const grad = `<linearGradient id="${p}-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${TILE_TOP_LEFT}"/><stop offset="1" stop-color="${TILE_BOTTOM_RIGHT}"/></linearGradient>`;
    if (!rounded) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><defs>${grad}</defs>`
            + `<rect width="512" height="512" fill="url(#${p}-tile)"/>${mark}</svg>`;
    }
    const rimWidth = simple ? 14 : 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><defs>${grad}`
        + `<linearGradient id="${p}-rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E8D6BC" stop-opacity="1"/><stop offset="0.35" stop-color="#D8C3A5" stop-opacity="0.9"/><stop offset="1" stop-color="#D8C3A5" stop-opacity="0.85"/></linearGradient>`
        + `<radialGradient id="${p}-sheen" cx="0.3" cy="0" r="0.9"><stop offset="0" stop-color="#FFF4E2" stop-opacity="0.14"/><stop offset="1" stop-color="#FFF4E2" stop-opacity="0"/></radialGradient>`
        + `<filter id="${p}-shadow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${simple ? 6 : 12}"/></filter>`
        + `<clipPath id="${p}-clip"><path d="${tile}"/></clipPath></defs>`
        + `<path d="${tile}" fill="url(#${p}-tile)"/>`
        + `<g clip-path="url(#${p}-clip)"><path d="${tile}" fill="url(#${p}-sheen)"/>`
        + `<path d="${tile}" fill="none" stroke="#000" stroke-opacity="0.4" stroke-width="30" transform="translate(0 6)" filter="url(#${p}-shadow)"/></g>`
        + `${mark}<path d="${rim}" fill="none" stroke="url(#${p}-rim)" stroke-width="${rimWidth}"/></svg>`;
}

function iconPage(svg, size) {
    return page(svg.replace('width="512" height="512"', `width="${size}" height="${size}"`));
}

function bannerPage(wordmarkColor, css) {
    const lockup = renderBrandLockup({ markSize: BANNER.markSize, idPrefix: 'hb' });
    return page(
        `<div class="stage">${lockup}</div>`,
        { css: `${css}.stage{width:${BANNER.width}px;height:${BANNER.height}px;display:flex;align-items:center;justify-content:center}.hs-lockup{color:${wordmarkColor}}` }
    );
}

function splashBlock() {
    const lockup = renderBrandLockup({ markSize: SPLASH_MARK, animated: true, idPrefix: 'hss' });
    return `<div class="splashLogo" role="img" aria-label="${BRAND_NAME}">${lockup}</div>`;
}

function syncSplash() {
    const file = join(ROOT, 'src', 'index.html');
    const html = readFileSync(file, 'utf8');
    const pattern = /<div class="splashLogo"[^>]*>[\s\S]*?<\/div>/;
    if (!pattern.test(html)) throw new Error('splash markup not found in src/index.html');
    const next = html.replace(pattern, () => splashBlock());
    if (next !== html) writeFileSync(file, next);
}

function previewFrames(dir) {
    const css = compile('src/styles/site.scss');
    const frames = [0, 200, 450, 800, 1100, 1700];
    const viewports = [['desktop', 1280, 720], ['phone', 500, 844]];
    for (const [name, w, h] of viewports) {
        for (const t of frames) {
            const script = `<script>document.addEventListener('DOMContentLoaded',()=>{document.getAnimations().forEach(a=>{a.pause();a.currentTime=${t}})})</script>`;
            shoot(page(splashBlock(), { css, script }), w, h, join(dir, `splash-${name}-${String(t).padStart(4, '0')}.png`));
        }
    }
}

function main() {
    const previewIdx = process.argv.indexOf('--preview');
    const previewDir = previewIdx > -1 ? resolve(process.argv[previewIdx + 1] ?? '') : null;
    if (previewIdx > -1 && !process.argv[previewIdx + 1]) throw new Error('--preview needs a directory');
    const onlyIdx = process.argv.indexOf('--only');
    const only = onlyIdx > -1 ? (process.argv[onlyIdx + 1] ?? '').split(',') : null;
    const want = (group) => !only || only.includes(group);

    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'mark.svg'), `${renderBrandMark({ size: 512, idPrefix: 'hs' })}
`);
    const rounded = iconSvg({ rounded: true });
    writeFileSync(join(OUT, 'icon.svg'), `${rounded}
`);

    if (want('icon')) shoot(iconPage(rounded, 512), 512, 512, join(OUT, 'icon-transparent.png'));
    if (want('touch')) {
        const bleed = iconSvg({ rounded: false });
        for (const [file, size] of [['touchicon.png', 180], ['touchicon72.png', 72], ['touchicon114.png', 114], ['touchicon144.png', 144], ['touchicon512.png', 512]]) {
            shoot(iconPage(bleed, size), size, size, join(OUT, file));
        }
    }
    if (want('favicon')) {
        mkdirSync(FAVICON_DIR, { recursive: true });
        for (const size of [16, 32, 48]) {
            const svg = iconSvg({ rounded: true, markScale: FAVICON_MARK_SCALE[size], simple: size < 48 });
            shoot(iconPage(svg, size), size, size, join(FAVICON_DIR, `favicon-${size}.png`));
        }
    }
    if (want('banner')) {
        const css = compile('src/themes/liquidglass/_brand.scss');
        shoot(bannerPage(WORDMARK_LIGHT, css), BANNER.width, BANNER.height, join(OUT, 'banner-light.png'));
        shoot(bannerPage(WORDMARK_DARK, css), BANNER.width, BANNER.height, join(OUT, 'banner-dark.png'));
    }

    syncSplash();
    if (previewDir) previewFrames(previewDir);
    rmSync(workDir, { recursive: true, force: true });
    console.log(`Brand assets rendered with ${browser}`);
}

try {
    main();
} catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
