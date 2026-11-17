import { EventType } from '../../constants/eventType';
import Events from '../../utils/events';

import { isLiquidGlass } from '../../themes/liquidglass/isLiquidGlass';

export const CONDENSED_CLASS = 'lg-header-condensed';
/** Scroll distance (px) past which the header condenses. */
export const CONDENSE_AT = 24;
/** Scroll distance (px) below which it expands again; the gap prevents flicker at the threshold. */
export const EXPAND_AT = 12;

/** Next condensed state for a scroll offset, with hysteresis around the threshold. */
export function nextCondensed(scrollY: number, current: boolean): boolean {
    if (current) return scrollY > EXPAND_AT;
    return scrollY > CONDENSE_AT;
}

let teardown: (() => void) | undefined;
let initialised = false;

function attach(): void {
    if (teardown) return;
    let condensed = false;
    let frame = 0;

    const apply = () => {
        frame = 0;
        const next = nextCondensed(window.scrollY, condensed);
        if (next === condensed) return;
        condensed = next;
        document.querySelector('.skinHeader')?.classList.toggle(CONDENSED_CLASS, condensed);
    };
    const onScroll = () => {
        if (!frame) frame = window.requestAnimationFrame(apply);
    };

    // Same options object for add and remove: old Chrome reads it as capture=true, which must match
    const listenerOptions: AddEventListenerOptions = { passive: true };
    window.addEventListener('scroll', onScroll, listenerOptions);
    onScroll();

    teardown = () => {
        window.removeEventListener('scroll', onScroll, listenerOptions);
        if (frame) window.cancelAnimationFrame(frame);
        document.querySelector('.skinHeader')?.classList.remove(CONDENSED_CLASS);
        teardown = undefined;
    };
}

function sync(): void {
    if (isLiquidGlass()) attach();
    else teardown?.();
}

/** Condense the floating header on scroll while the Liquid Glass theme is active. Call once. */
export function initHeaderScroll(): void {
    if (initialised) return;
    initialised = true;
    Events.on(document, EventType.THEME_CHANGE, sync);
    sync();
}
