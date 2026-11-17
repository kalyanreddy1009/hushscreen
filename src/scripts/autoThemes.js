import * as userSettings from './settings/userSettings';
import skinManager from './themeManager';
import { FALLBACK_THEME_ID } from 'hooks/useUserTheme';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { pageClassOn } from 'utils/dashboard';
import Events from 'utils/events.ts';

// Set the default theme when loading
skinManager.setTheme(userSettings.theme())
    /* this keeps the scrollbar always present in all pages, so we avoid clipping while switching between pages
       that need the scrollbar and pages that don't.
     */
    .then(() => document.body.classList.add('force-scroll'));

// set the saved theme once a user authenticates
Events.on(ServerConnections, 'localusersignedin', () => {
    skinManager.setTheme(userSettings.theme());
});

pageClassOn('viewbeforeshow', 'page', function () {
    if (this.classList.contains('type-interior')) {
        // Unset dashboard theme stays on the stock theme (see hooks/useUserTheme)
        skinManager.setTheme(userSettings.dashboardTheme() || FALLBACK_THEME_ID);
    } else {
        skinManager.setTheme(userSettings.theme());
    }
});
