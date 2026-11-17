import { afterEach, describe, expect, it } from 'vitest';

import { isLiquidGlass, LIQUID_GLASS_THEME_ID, THEME_ID_ATTRIBUTE } from './isLiquidGlass';

describe('isLiquidGlass', () => {
    const root = document.documentElement;

    afterEach(() => {
        root.removeAttribute(THEME_ID_ATTRIBUTE);
        root.removeAttribute('data-theme');
    });

    it('is true when the theme manager applied liquidglass, even after MUI rewrites data-theme', () => {
        root.setAttribute(THEME_ID_ATTRIBUTE, LIQUID_GLASS_THEME_ID);
        root.setAttribute('data-theme', 'dark');

        expect(isLiquidGlass()).toBe(true);
    });

    it('is false for any other applied theme', () => {
        root.setAttribute(THEME_ID_ATTRIBUTE, 'dark');
        root.setAttribute('data-theme', LIQUID_GLASS_THEME_ID);

        expect(isLiquidGlass()).toBe(false);
    });

    it('is false before any theme has been applied', () => {
        expect(isLiquidGlass()).toBe(false);
    });
});
