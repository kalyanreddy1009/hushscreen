import { useThemes } from './useThemes';
import { useUserSettings } from './useUserSettings';

export const FALLBACK_THEME_ID = 'dark';

export function useUserTheme() {
    const { theme, dashboardTheme } = useUserSettings();
    const { defaultTheme } = useThemes();

    return {
        theme: theme || defaultTheme?.id || FALLBACK_THEME_ID,
        // The dashboard keeps the stock theme unless the user picks one: the default user theme
        // (Liquid Glass) is designed for library browsing, not admin screens.
        dashboardTheme: dashboardTheme || FALLBACK_THEME_ID
    };
}
