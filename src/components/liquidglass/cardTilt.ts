import layoutManager from '../layoutManager';
import { isLiquidGlass } from '../../themes/liquidglass/isLiquidGlass';

/** Maximum tilt (deg) on either axis when the pointer is at a card edge. */
export const MAX_TILT_DEG = 6;

const HOVER_QUERY = '(hover: hover) and (pointer: fine)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const TILT_X = '--lg-tilt-x';
const TILT_Y = '--lg-tilt-y';
const SHEEN_X = '--lg-sheen-x';
const SHEEN_Y = '--lg-sheen-y';
const PROPERTIES = [ TILT_X, TILT_Y, SHEEN_X, SHEEN_Y ];
const TILTING_CLASS = 'lg-tilting';

let teardown: (() => void) | undefined;

/** Pointer position inside the target, normalised to [-0.5, 0.5] on each axis (0 is the centre). */
interface PointerOffset {
    target: HTMLElement;
    px: number;
    py: number;
}

function clampOffset(value: number): number {
    return Math.min(0.5, Math.max(-0.5, value));
}

/** The element that tilts for a pointer target: the card's visual box, or its scalable box. */
function findTiltTarget(node: EventTarget | null): HTMLElement | null {
    if (!(node instanceof Element)) return null;
    const card = node.closest('.card');
    if (!card) return null;
    return card.querySelector<HTMLElement>('.cardBox.visualCardBox')
        ?? card.querySelector<HTMLElement>('.cardBox .cardScalable');
}

function canTilt(e: PointerEvent, hoverQuery: MediaQueryList, reducedQuery: MediaQueryList): boolean {
    return e.pointerType === 'mouse'
        && isLiquidGlass()
        && !reducedQuery.matches
        && !layoutManager.tv
        && hoverQuery.matches;
}

function measure(e: PointerEvent, target: HTMLElement, rect: DOMRect): PointerOffset | null {
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
        target,
        px: clampOffset((e.clientX - rect.left) / rect.width - 0.5),
        py: clampOffset((e.clientY - rect.top) / rect.height - 0.5)
    };
}

function writeOffset({ target, px, py }: PointerOffset): void {
    target.style.setProperty(TILT_X, `${(-py * 2 * MAX_TILT_DEG).toFixed(2)}deg`);
    target.style.setProperty(TILT_Y, `${(px * 2 * MAX_TILT_DEG).toFixed(2)}deg`);
    target.style.setProperty(SHEEN_X, `${((px + 0.5) * 100).toFixed(1)}%`);
    target.style.setProperty(SHEEN_Y, `${((py + 0.5) * 100).toFixed(1)}%`);
    target.classList.add(TILTING_CLASS);
}

function clearOffset(target: HTMLElement): void {
    for (const property of PROPERTIES) target.style.removeProperty(property);
    target.classList.remove(TILTING_CLASS);
}

/**
 * Tilt the card under a mouse pointer and move its sheen with the pointer while the Liquid Glass theme is
 * active. Uses one delegated listener pair on document. Call once; the returned cleanup detaches everything.
 * A second call before cleanup returns the existing cleanup instead of attaching again.
 */
export function initCardTilt(): () => void {
    if (teardown) return teardown;

    const hoverQuery = window.matchMedia(HOVER_QUERY);
    const reducedQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    let current: HTMLElement | undefined;
    // Measured once per hovered target, so the CSS transform on the card does not feed back into the offset.
    let currentRect: DOMRect | undefined;
    let frame = 0;
    let pending: PointerOffset | undefined;

    const cancelFrame = (): void => {
        if (frame) window.cancelAnimationFrame(frame);
        frame = 0;
        pending = undefined;
    };

    const release = (): void => {
        cancelFrame();
        if (current) clearOffset(current);
        current = undefined;
        currentRect = undefined;
    };

    const flush = (): void => {
        frame = 0;
        if (pending) writeOffset(pending);
    };

    const onPointerMove = (e: PointerEvent): void => {
        if (!canTilt(e, hoverQuery, reducedQuery)) {
            release();
            return;
        }
        const target = findTiltTarget(e.target);
        if (!target) {
            release();
            return;
        }
        if (target !== current) {
            release();
            current = target;
            currentRect = target.getBoundingClientRect();
        }
        const offset = currentRect ? measure(e, target, currentRect) : null;
        if (!offset) {
            release();
            return;
        }
        // Coalesce: one frame per burst of moves, always drawing the latest pointer position.
        pending = offset;
        if (!frame) frame = window.requestAnimationFrame(flush);
    };

    const onPointerOut = (e: PointerEvent): void => {
        if (!current) return;
        const card = current.closest('.card');
        if (e.relatedTarget instanceof Node && card?.contains(e.relatedTarget)) return;
        release();
    };

    const onReducedMotionChange = (): void => {
        if (reducedQuery.matches) release();
    };

    // Same options object for add and remove: old Chrome reads it as capture=true, which must match
    const listenerOptions: AddEventListenerOptions = { passive: true };
    document.addEventListener('pointermove', onPointerMove as EventListener, listenerOptions);
    document.addEventListener('pointerout', onPointerOut as EventListener, listenerOptions);
    reducedQuery.addEventListener('change', onReducedMotionChange);

    teardown = () => {
        document.removeEventListener('pointermove', onPointerMove as EventListener, listenerOptions);
        document.removeEventListener('pointerout', onPointerOut as EventListener, listenerOptions);
        reducedQuery.removeEventListener('change', onReducedMotionChange);
        release();
        teardown = undefined;
    };

    return teardown;
}
