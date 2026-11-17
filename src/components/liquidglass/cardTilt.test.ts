import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('../../themes/liquidglass/isLiquidGlass', () => ({
    isLiquidGlass: () => true,
    prefersReducedMotion: () => reduced.value
}));
vi.mock('../layoutManager', () => ({ default: { tv: false } }));

import { initCardTilt } from './cardTilt';

const PROPERTIES = ['--lg-tilt-x', '--lg-tilt-y', '--lg-sheen-x', '--lg-sheen-y'];
const TILTING_CLASS = 'lg-tilting';

function rect(left: number, top: number, width: number, height: number): DOMRect {
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function pointer(
    type: 'pointermove' | 'pointerout',
    target: Element,
    init: { clientX?: number; clientY?: number; pointerType?: string; relatedTarget?: Element | null } = {}
): void {
    const event = new MouseEvent(type, {
        bubbles: true,
        clientX: init.clientX ?? 0,
        clientY: init.clientY ?? 0,
        relatedTarget: init.relatedTarget ?? null
    });
    Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' });
    target.dispatchEvent(event);
}

describe('initCardTilt', () => {
    let frames: FrameRequestCallback[];
    let rafCalls: number;
    let changeListeners: Array<() => void>;
    let cleanup: (() => void) | undefined;

    // The reduced-motion query reads the live `reduced.value`; the hover query always matches.
    function fakeMediaQuery(query: string): MediaQueryList {
        return {
            media: query,
            get matches() {
                return query.includes('prefers-reduced-motion') ? reduced.value : true;
            },
            addEventListener: (_type: string, listener: () => void) => { changeListeners.push(listener); },
            removeEventListener: (_type: string, listener: () => void) => {
                changeListeners = changeListeners.filter(item => item !== listener);
            }
        } as unknown as MediaQueryList;
    }

    function flushFrames(): void {
        const queued = frames.splice(0);
        for (const callback of queued) callback(0);
    }

    function cardBox(id: string): HTMLElement {
        return document.querySelector<HTMLElement>(`#${id} .cardBox`) as HTMLElement;
    }

    beforeEach(() => {
        reduced.value = false;
        document.body.innerHTML = `
            <div class="card" id="a"><div class="cardBox visualCardBox"></div></div>
            <div class="card" id="b"><div class="cardBox visualCardBox"></div></div>`;
        changeListeners = [];
        vi.spyOn(window, 'matchMedia').mockImplementation(query => fakeMediaQuery(query));
        frames = [];
        rafCalls = 0;
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            rafCalls += 1;
            frames.push(callback);
            return frames.length;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
        vi.spyOn(cardBox('a'), 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 300));
        vi.spyOn(cardBox('b'), 'getBoundingClientRect').mockReturnValue(rect(300, 0, 200, 300));
    });

    afterEach(() => {
        cleanup?.();
        cleanup = undefined;
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('sets the tilt and sheen properties for a mouse pointer at the top-left corner', () => {
        cleanup = initCardTilt();
        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0 });
        flushFrames();

        const style = cardBox('a').style;
        expect(style.getPropertyValue('--lg-tilt-x')).toBe('6.00deg');
        expect(style.getPropertyValue('--lg-tilt-y')).toBe('-6.00deg');
        expect(style.getPropertyValue('--lg-sheen-x')).toBe('0.0%');
        expect(style.getPropertyValue('--lg-sheen-y')).toBe('0.0%');
    });

    it('ignores touch pointers', () => {
        cleanup = initCardTilt();
        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0, pointerType: 'touch' });
        flushFrames();

        expect(cardBox('a').style.getPropertyValue('--lg-tilt-x')).toBe('');
        expect(rafCalls).toBe(0);
    });

    it('ignores pointer moves while the user prefers reduced motion', () => {
        reduced.value = true;
        cleanup = initCardTilt();
        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0 });
        flushFrames();

        expect(cardBox('a').style.getPropertyValue('--lg-tilt-x')).toBe('');
        expect(rafCalls).toBe(0);
    });

    it('clears the properties from the previous card when the pointer moves to another card', () => {
        cleanup = initCardTilt();
        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0 });
        flushFrames();
        pointer('pointermove', cardBox('b'), { clientX: 300, clientY: 0 });
        flushFrames();

        for (const property of PROPERTIES) {
            expect(cardBox('a').style.getPropertyValue(property)).toBe('');
        }
        expect(cardBox('b').style.getPropertyValue('--lg-tilt-x')).not.toBe('');
    });

    it('clears the properties when the pointer leaves the card to the outside', () => {
        cleanup = initCardTilt();
        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0 });
        flushFrames();
        pointer('pointerout', cardBox('a'), { relatedTarget: document.body });

        for (const property of PROPERTIES) {
            expect(cardBox('a').style.getPropertyValue(property)).toBe('');
        }
    });

    it('keeps the tilt while the pointer moves to another element inside the same card', () => {
        cleanup = initCardTilt();
        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0 });
        flushFrames();
        const insideCard = document.querySelector<HTMLElement>('#a') as HTMLElement;
        pointer('pointerout', cardBox('a'), { relatedTarget: insideCard });

        expect(cardBox('a').style.getPropertyValue('--lg-tilt-x')).toBe('6.00deg');
    });

    it('removes its listeners and clears properties on cleanup', () => {
        cleanup = initCardTilt();
        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0 });
        flushFrames();

        cleanup();
        cleanup = undefined;
        expect(cardBox('a').style.getPropertyValue('--lg-tilt-x')).toBe('');

        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0 });
        flushFrames();
        expect(cardBox('a').style.getPropertyValue('--lg-tilt-x')).toBe('');
    });

    it('attaches only once when called twice and returns the same cleanup', () => {
        const first = initCardTilt();
        const second = initCardTilt();
        cleanup = first;
        expect(second).toBe(first);

        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0 });
        expect(rafCalls).toBe(1);
    });

    it('measures the card once per hover and reuses the rect for later moves', () => {
        const rectSpy = vi.spyOn(cardBox('a'), 'getBoundingClientRect');
        cleanup = initCardTilt();
        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0 });
        flushFrames();
        pointer('pointermove', cardBox('a'), { clientX: 100, clientY: 150 });
        flushFrames();

        expect(rectSpy).toHaveBeenCalledTimes(1);
        expect(cardBox('a').style.getPropertyValue('--lg-sheen-x')).toBe('50.0%');
    });

    it('reads the media queries once at setup, not once per pointer move', () => {
        cleanup = initCardTilt();
        const queryCalls = vi.mocked(window.matchMedia).mock.calls.length;
        for (let i = 0; i < 5; i += 1) {
            pointer('pointermove', cardBox('a'), { clientX: i, clientY: i });
            flushFrames();
        }

        expect(vi.mocked(window.matchMedia).mock.calls.length).toBe(queryCalls);
    });

    it('releases the tilt when a non-mouse pointer arrives mid-hover', () => {
        cleanup = initCardTilt();
        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0 });
        flushFrames();
        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0, pointerType: 'touch' });

        expect(cardBox('a').style.getPropertyValue('--lg-tilt-x')).toBe('');
        expect(cardBox('a').classList.contains(TILTING_CLASS)).toBe(false);
    });

    it('releases the tilt when reduced motion starts matching mid-hover', () => {
        cleanup = initCardTilt();
        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0 });
        flushFrames();

        reduced.value = true;
        for (const listener of changeListeners) listener();

        expect(cardBox('a').style.getPropertyValue('--lg-tilt-x')).toBe('');
    });

    it('removes the reduced-motion listener on cleanup', () => {
        cleanup = initCardTilt();
        expect(changeListeners).toHaveLength(1);

        cleanup();
        cleanup = undefined;
        expect(changeListeners).toHaveLength(0);
    });

    it('marks the tilting card with lg-tilting while tilted and removes it on leave', () => {
        cleanup = initCardTilt();
        pointer('pointermove', cardBox('a'), { clientX: 0, clientY: 0 });
        flushFrames();
        expect(cardBox('a').classList.contains(TILTING_CLASS)).toBe(true);

        pointer('pointerout', cardBox('a'), { relatedTarget: document.body });
        expect(cardBox('a').classList.contains(TILTING_CLASS)).toBe(false);
    });
});
