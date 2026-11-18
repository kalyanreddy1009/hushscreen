import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventType } from '../../constants/eventType';
import Events from '../../utils/events';
import { LIQUID_GLASS_THEME_ID, THEME_ID_ATTRIBUTE } from '../../themes/liquidglass/isLiquidGlass';

import { averageRgb, initAmbient } from './ambient';

const HERO_EVENT = 'lg:herochange';
const URL_A = 'https://server/Items/a/Images/Backdrop/0';
const URL_B = 'https://server/Items/b/Images/Backdrop/0';

/** Records every requested image so tests can finish or fail each load by hand. */
class FakeImage {
    static readonly instances: FakeImage[] = [];

    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = '';

    constructor() {
        FakeImage.instances.push(this);
    }
}

function requestedImage(url: string): FakeImage {
    const matches = FakeImage.instances.filter(image => image.src === url);
    const image = matches[matches.length - 1];
    if (!image) throw new Error(`no image requested for ${url}`);
    return image;
}

function heroChange(detail: { itemId: string, backdropUrl: string | undefined } | null): void {
    document.dispatchEvent(new CustomEvent(HERO_EVENT, { detail }));
}

function backdrop(url: string): void {
    heroChange({ itemId: url, backdropUrl: url });
    vi.advanceTimersByTime(150);
}

function layersOf(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.lg-ambient__layer'));
}

function visibleLayers(): HTMLElement[] {
    return layersOf().filter(layer => layer.classList.contains('is-visible'));
}

/** Makes getImageData return the given RGBA bytes for every sampled image. */
function stubCanvas(pixels: number[]): void {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(pixels) }))
    } as unknown as never);
}

describe('initAmbient', () => {
    it('attaches the hero listener once when called twice', () => {
        const spy = vi.spyOn(document, 'addEventListener');

        initAmbient();
        initAmbient();

        const heroListeners = spy.mock.calls.filter(([ type ]) => type === HERO_EVENT);
        expect(heroListeners).toHaveLength(1);
    });
});

describe('ambient background', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('Image', FakeImage);
        FakeImage.instances.length = 0;
        stubCanvas([ 100, 50, 0, 255, 200, 150, 100, 255 ]);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'debug').mockImplementation(() => undefined);

        // Reset module state through its public theme-change path, then enter Liquid Glass on home
        document.documentElement.setAttribute(THEME_ID_ATTRIBUTE, 'dark');
        Events.trigger(document, EventType.THEME_CHANGE);
        document.documentElement.setAttribute(THEME_ID_ATTRIBUTE, LIQUID_GLASS_THEME_ID);
        window.location.hash = '#/home';

        initAmbient();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('creates the layer as the first child of body and shows a layer after the image loads', () => {
        backdrop(URL_A);
        requestedImage(URL_A).onload?.();

        const ambient = document.body.firstElementChild as HTMLElement;
        expect(ambient.classList.contains('lg-ambient')).toBe(true);
        expect(ambient.getAttribute('aria-hidden')).toBe('true');
        expect(visibleLayers()).toHaveLength(1);
        expect(layersOf()[1].classList.contains('is-visible')).toBe(true);
    });

    it('ignores a repeat of the same url', () => {
        backdrop(URL_A);
        requestedImage(URL_A).onload?.();

        backdrop(URL_A);

        expect(FakeImage.instances.filter(image => image.src === URL_A)).toHaveLength(1);
    });

    it('debounces rapid changes to the last one', () => {
        heroChange({ itemId: 'a', backdropUrl: URL_A });
        vi.advanceTimersByTime(100);
        heroChange({ itemId: 'b', backdropUrl: URL_B });
        vi.advanceTimersByTime(100);

        expect(FakeImage.instances).toHaveLength(0);

        vi.advanceTimersByTime(50);

        expect(FakeImage.instances.map(image => image.src)).toEqual([ URL_B ]);
    });

    it('keeps the previous backdrop and warns when a load fails', () => {
        backdrop(URL_A);
        requestedImage(URL_A).onload?.();
        const shown = visibleLayers();

        backdrop(URL_B);
        requestedImage(URL_B).onerror?.();

        expect(console.warn).toHaveBeenCalled();
        expect(visibleLayers()).toEqual(shown);
    });

    it('hides the layer and resets the colour on a null detail', () => {
        backdrop(URL_A);
        requestedImage(URL_A).onload?.();
        expect(document.documentElement.style.getPropertyValue('--lg-ambient')).toBe('90, 60, 30');

        heroChange(null);

        expect(visibleLayers()).toHaveLength(0);
        expect(document.documentElement.style.getPropertyValue('--lg-ambient')).toBe('');
    });

    it('hides the layer instead of requesting "undefined" when the detail has no backdrop', () => {
        backdrop(URL_A);
        requestedImage(URL_A).onload?.();
        expect(visibleLayers()).toHaveLength(1);

        heroChange({ itemId: 'x', backdropUrl: undefined });
        vi.advanceTimersByTime(150);

        expect(FakeImage.instances.some(image => image.src === 'undefined')).toBe(false);
        expect(visibleLayers()).toHaveLength(0);
        expect(document.documentElement.style.getPropertyValue('--lg-ambient')).toBe('');
    });

    it('hides the layer when the route leaves home and shows it again on return', () => {
        backdrop(URL_A);
        requestedImage(URL_A).onload?.();
        const ambient = document.querySelector<HTMLElement>('.lg-ambient');

        window.location.hash = '#/details?id=1';
        window.dispatchEvent(new Event('hashchange'));
        expect(ambient?.hidden).toBe(true);

        window.location.hash = '#/home';
        window.dispatchEvent(new Event('hashchange'));
        expect(ambient?.hidden).toBe(false);
    });

    it('does nothing outside the Liquid Glass theme', () => {
        document.documentElement.setAttribute(THEME_ID_ATTRIBUTE, 'dark');

        backdrop(URL_A);

        expect(FakeImage.instances).toHaveLength(0);
        expect(document.querySelector('.lg-ambient')).toBeNull();
    });

    it('removes the layer and colour when the theme changes away', () => {
        backdrop(URL_A);
        requestedImage(URL_A).onload?.();

        document.documentElement.setAttribute(THEME_ID_ATTRIBUTE, 'dark');
        Events.trigger(document, EventType.THEME_CHANGE);

        expect(document.querySelector('.lg-ambient')).toBeNull();
        expect(document.documentElement.style.getPropertyValue('--lg-ambient')).toBe('');
    });

    it('falls back to the default colour without throwing when the canvas is tainted', () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
            drawImage: vi.fn(),
            getImageData: vi.fn(() => {
                throw new DOMException('tainted', 'SecurityError');
            })
        } as unknown as never);

        backdrop(URL_A);

        expect(() => requestedImage(URL_A).onload?.()).not.toThrow();
        expect(console.debug).toHaveBeenCalledTimes(1);
        expect(document.documentElement.style.getPropertyValue('--lg-ambient')).toBe('');
        expect(visibleLayers()).toHaveLength(1);
    });
});

describe('averageRgb', () => {
    it('returns the mean of each channel, ignoring alpha', () => {
        expect(averageRgb(new Uint8ClampedArray([ 100, 50, 0, 255, 200, 150, 100, 0 ]))).toEqual([ 150, 100, 50 ]);
    });

    it('rounds to whole channel values', () => {
        expect(averageRgb(new Uint8ClampedArray([ 1, 2, 3, 255, 2, 3, 4, 255 ]))).toEqual([ 2, 3, 4 ]);
    });

    it('returns black for empty pixel data', () => {
        expect(averageRgb(new Uint8ClampedArray([]))).toEqual([ 0, 0, 0 ]);
    });
});
