/** The theme id registered in src/config.json and src/themes/themes.ts. */
export const LIQUID_GLASS_THEME_ID = 'liquidglass';

/**
 * Attribute on <html> holding the theme id applied by themeManager.setTheme.
 * Not `data-theme`: MUI's ThemeProvider also writes `data-theme` (colorSchemeSelector) and, when it mounts
 * after themeManager has run, overwrites it with its default scheme ('dark') until the next theme change.
 */
export const THEME_ID_ATTRIBUTE = 'data-jf-theme';

/**
 * Whether the Liquid Glass theme is the active theme on this page.
 * New behaviour (hero, bottom tab bar, header scroll) must check this so stock themes are untouched.
 */
export function isLiquidGlass(root: HTMLElement = document.documentElement): boolean {
    return root.getAttribute(THEME_ID_ATTRIBUTE) === LIQUID_GLASS_THEME_ID;
}

/** Whether the user asked the system to reduce motion. */
export function prefersReducedMotion(): boolean {
    return typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
