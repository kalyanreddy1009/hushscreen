import { EventType } from '../../constants/eventType';
import Events from '../../utils/events';

import { isLiquidGlass } from '../../themes/liquidglass/isLiquidGlass';

import type { HeroChangeDetail } from '../homesections/hero/hero';

/** Dispatched on document by the hero: detail is the item backdrop, or null when the hero is gone. Must equal hero's HERO_CHANGE_EVENT. */
export const HERO_CHANGE_EVENT = 'lg:herochange';

const AMBIENT_CLASS = 'lg-ambient';
const LAYER_CLASS = 'lg-ambient__layer';
const VISIBLE_CLASS = 'is-visible';
const COLOUR_PROPERTY = '--lg-ambient';
const SCRIM_PROPERTY = '--lg-ambient-scrim';
const DEBOUNCE_MS = 150;
const SAMPLE_SIZE = 16;
const RGBA_STRIDE = 4;
/** Darkens the sampled artwork colour so glass and text stay readable over it. */
const DARKEN_FACTOR = 0.6;
/** Relative luminance the backdrop is brought down to: leaves room for a 0.08 white glass fill and keeps white text above 4.5:1. */
const TARGET_LUMINANCE = 0.09;
const SCRIM_MIN = 0.12;
const SCRIM_MAX = 0.7;
const SCRIM_SEARCH_ITERATIONS = 24;
const SCRIM_DECIMALS = 1000;
const LINEAR_THRESHOLD = 0.04045;
const LINEAR_DIVISOR = 12.92;
const GAMMA_OFFSET = 0.055;
const GAMMA_SCALE = 1.055;
const GAMMA_EXPONENT = 2.4;
const MAX_CHANNEL = 255;
/** Session key holding the last shown artwork, so a refresh off home keeps the backdrop. */
const STORAGE_KEY = 'lg-ambient-url';
const TV_LAYOUT_CLASS = 'layout-tv';
/** Routes where the full-screen blur is not shown. */
const EXCLUDED_ROUTE_PREFIXES = [
    '/dashboard',
    '/configurationpage',
    '/video',
    '/login',
    '/selectserver',
    '/addserver',
    '/forgotpassword',
    '/wizard'
];
/** Sign-in and setup routes: the stored artwork is dropped so it never shows to another user. */
const AUTH_ROUTE_PREFIXES = [
    '/login',
    '/selectserver',
    '/addserver',
    '/forgotpassword',
    '/wizard'
];

let initialised = false;
let root: HTMLElement | undefined;
let layers: [HTMLElement, HTMLElement] | undefined;
let activeIndex = 0;
let shownUrl: string | undefined;
let requestedUrl: string | undefined;
let debounceTimer: number | undefined;
/** Bumped to discard image loads that a newer change has superseded. */
let loadToken = 0;
let taintReported = false;
let storageReported = false;

/** Mean red, green and blue of RGBA pixel data, each rounded to an integer. */
export function averageRgb(data: Uint8ClampedArray): [number, number, number] {
    const pixelCount = Math.floor(data.length / RGBA_STRIDE);
    if (pixelCount === 0) return [ 0, 0, 0 ];

    let red = 0;
    let green = 0;
    let blue = 0;
    for (let i = 0; i < pixelCount; i++) {
        const offset = i * RGBA_STRIDE;
        red += data[offset];
        green += data[offset + 1];
        blue += data[offset + 2];
    }
    return [
        Math.round(red / pixelCount),
        Math.round(green / pixelCount),
        Math.round(blue / pixelCount)
    ];
}

function srgbToLinear(channel: number): number {
    const value = channel / MAX_CHANNEL;
    if (value <= LINEAR_THRESHOLD) return value / LINEAR_DIVISOR;
    return ((value + GAMMA_OFFSET) / GAMMA_SCALE) ** GAMMA_EXPONENT;
}

function relativeLuminance(rgb: readonly [number, number, number], multiplier: number): number {
    const [ red, green, blue ] = rgb.map(channel => srgbToLinear(channel * multiplier));
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Scrim alpha that darkens the colour until white text on it keeps at least 4.5:1 contrast. */
export function scrimAlphaFor(rgb: readonly [number, number, number]): number {
    let multiplier = 1;
    if (relativeLuminance(rgb, 1) > TARGET_LUMINANCE) {
        let low = 0;
        let high = 1;
        for (let i = 0; i < SCRIM_SEARCH_ITERATIONS; i++) {
            const middle = (low + high) / 2;
            if (relativeLuminance(rgb, middle) <= TARGET_LUMINANCE) {
                low = middle;
            } else {
                high = middle;
            }
        }
        multiplier = low;
    }
    const alpha = Math.min(SCRIM_MAX, Math.max(SCRIM_MIN, 1 - multiplier));
    return Math.round(alpha * SCRIM_DECIMALS) / SCRIM_DECIMALS;
}

/** Hash route without the leading "#" or "#!", and without the query string. */
function currentRoutePath(): string {
    const hash = window.location.hash.replace(/^#!?/, '');
    const queryStart = hash.indexOf('?');
    const path = queryStart === -1 ? hash : hash.slice(0, queryStart);
    return path.toLowerCase();
}

/** Segment-aware prefix match: "/video" matches "/video" and "/video/1", not "/videos". */
function matchesPrefix(path: string, prefix: string): boolean {
    if (prefix === '/forgotpassword' || prefix === '/wizard') return path.startsWith(prefix);
    return path === prefix || path.startsWith(`${prefix}/`);
}

function isHomeRoute(): boolean {
    const path = currentRoutePath();
    return path === '' || path === '/' || path === '/home' || path.startsWith('/home');
}

function isAmbientRoute(): boolean {
    if (document.documentElement.classList.contains(TV_LAYOUT_CLASS)) return isHomeRoute();
    const path = currentRoutePath();
    return !EXCLUDED_ROUTE_PREFIXES.some(prefix => matchesPrefix(path, prefix));
}

function isAuthRoute(): boolean {
    const path = currentRoutePath();
    return AUTH_ROUTE_PREFIXES.some(prefix => matchesPrefix(path, prefix));
}

function reportStorageUnavailable(error: unknown): void {
    if (storageReported) return;
    storageReported = true;
    console.debug('[ambient] session storage unavailable', error);
}

function readStored(): string | null {
    try {
        return sessionStorage.getItem(STORAGE_KEY);
    } catch (error) {
        reportStorageUnavailable(error);
        return null;
    }
}

function writeStored(url: string): void {
    try {
        sessionStorage.setItem(STORAGE_KEY, url);
    } catch (error) {
        reportStorageUnavailable(error);
    }
}

function removeStored(): void {
    try {
        sessionStorage.removeItem(STORAGE_KEY);
    } catch (error) {
        reportStorageUnavailable(error);
    }
}

function createLayer(): HTMLElement {
    const layer = document.createElement('div');
    layer.className = LAYER_CLASS;
    return layer;
}

function ensureLayers(): [HTMLElement, HTMLElement] {
    if (root && layers) return layers;

    const element = document.createElement('div');
    element.className = AMBIENT_CLASS;
    element.setAttribute('aria-hidden', 'true');
    layers = [ createLayer(), createLayer() ];
    element.append(...layers);
    document.body.prepend(element);
    root = element;
    syncRouteVisibility();
    return layers;
}

function clearColour(): void {
    document.documentElement.style.removeProperty(COLOUR_PROPERTY);
    document.documentElement.style.removeProperty(SCRIM_PROPERTY);
}

function cancelPending(): void {
    window.clearTimeout(debounceTimer);
    debounceTimer = undefined;
    loadToken++;
}

function fadeOut(): void {
    for (const layer of layers ?? []) {
        layer.classList.remove(VISIBLE_CLASS);
    }
    shownUrl = undefined;
    requestedUrl = undefined;
    clearColour();
}

/** Samples the loaded image and sets the darkened average colour; falls back to the default on failure. */
function applyColour(image: HTMLImageElement): void {
    let average: [number, number, number];
    try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const context = canvas.getContext('2d');
        if (!context) {
            clearColour();
            return;
        }
        context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        average = averageRgb(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
    } catch (error) {
        // A tainted canvas (cross-origin artwork) is expected in some setups; the default tint still applies
        if (!taintReported) {
            taintReported = true;
            console.debug('[ambient] Could not sample artwork colour, using default', error);
        }
        clearColour();
        return;
    }
    const [ red, green, blue ] = average.map(channel => Math.round(channel * DARKEN_FACTOR));
    document.documentElement.style.setProperty(COLOUR_PROPERTY, `${red}, ${green}, ${blue}`);
    document.documentElement.style.setProperty(SCRIM_PROPERTY, String(scrimAlphaFor(average)));
}

function escapeCssUrl(url: string): string {
    return url.replace(/["\\]/g, '\\$&');
}

function showLoaded(url: string, image: HTMLImageElement, index: number): void {
    if (isAuthRoute()) return;
    const pair = ensureLayers();
    pair.forEach((layer, i) => {
        layer.classList.toggle(VISIBLE_CLASS, i === index);
    });
    pair[index].style.backgroundImage = `url("${escapeCssUrl(url)}")`;
    activeIndex = index;
    shownUrl = url;
    applyColour(image);
    writeStored(url);
}

function show(url: string): void {
    // Create layers first: creating them re-runs route visibility, which may restore a stored url
    ensureLayers();
    if (url === requestedUrl) return;
    requestedUrl = url;
    const token = ++loadToken;
    // Load into the hidden layer; it becomes visible only once the image has arrived
    const hiddenIndex = activeIndex === 0 ? 1 : 0;

    const image = new Image();
    image.onload = () => {
        if (token === loadToken) showLoaded(url, image, hiddenIndex);
    };
    image.onerror = () => {
        console.warn('[ambient] Could not load backdrop, keeping the previous one', url);
        if (token === loadToken) requestedUrl = shownUrl;
    };
    image.src = url;
}

/** Shows the artwork for the current route's stored url, if any, without waiting for the debounce. */
function restoreStored(): void {
    if (!isLiquidGlass() || requestedUrl !== undefined || !isAmbientRoute()) return;
    const stored = readStored();
    if (stored) show(stored);
}

/** On sign-in routes, drops the stored url and all artwork so it never shows to another user. Returns true when it purged. */
function purgeForAuthRoute(): boolean {
    if (!isAuthRoute()) return false;
    removeStored();
    cancelPending();
    fadeOut();
    for (const layer of layers ?? []) {
        layer.style.backgroundImage = '';
    }
    return true;
}

function syncRouteVisibility(): void {
    if (root) root.hidden = !isAmbientRoute();
    if (purgeForAuthRoute()) return;
    restoreStored();
}

/** Shows the artwork for a url once the debounce has settled. Empty urls keep the current artwork. */
export function setAmbientBackdrop(url: string | undefined): void {
    if (!isLiquidGlass()) return;
    if (!url) return;
    if (isAuthRoute()) return;

    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
        debounceTimer = undefined;
        if (isAuthRoute()) return;
        show(url);
    }, DEBOUNCE_MS);
}

function onHeroChange(event: Event): void {
    if (!isLiquidGlass()) return;

    const detail = (event as CustomEvent<HeroChangeDetail | null>).detail;
    const url = detail?.backdropUrl;
    if (!url) {
        cancelPending();
        return;
    }

    setAmbientBackdrop(url);
}

function teardown(): void {
    cancelPending();
    root?.remove();
    root = undefined;
    layers = undefined;
    activeIndex = 0;
    shownUrl = undefined;
    requestedUrl = undefined;
    clearColour();
}

function onThemeChange(): void {
    if (!isLiquidGlass()) {
        teardown();
        return;
    }
    // The theme loads after initAmbient runs, so a stored backdrop is restored here
    if (purgeForAuthRoute()) return;
    restoreStored();
}

/** Start following hero backdrops while Liquid Glass is active. Safe to call more than once. */
export function initAmbient(): void {
    if (initialised) return;
    initialised = true;
    document.addEventListener(HERO_CHANGE_EVENT, onHeroChange);
    window.addEventListener('hashchange', syncRouteVisibility);
    Events.on(document, EventType.THEME_CHANGE, onThemeChange);
    // A cold load on a sign-in route must not keep a stored backdrop
    // The theme is often applied before this runs (its change event already fired), so restore here too
    if (!purgeForAuthRoute()) restoreStored();
}
