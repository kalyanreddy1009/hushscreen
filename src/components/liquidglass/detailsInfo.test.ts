import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const liquidGlassState = vi.hoisted(() => ({ active: true }));

vi.mock('../../themes/liquidglass/isLiquidGlass', () => ({
    isLiquidGlass: () => liquidGlassState.active
}));

vi.mock('../../lib/globalize', () => ({
    default: {
        translate: (key: string) => key
    }
}));

// Faithful subset of scripts/datetime (the real module imports the 'lib/globalize' alias, which vitest cannot resolve).
// parseISO8601Date mirrors the real one: it throws on strings it cannot parse and builds local dates when toLocal is set.
vi.mock('../../scripts/datetime', () => ({
    parseISO8601Date: (s: string) => {
        const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
        if (!match) throw new Error(`Couldn't parse ISO 8601 date string '${s}'`);
        return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    },
    toLocaleDateString: (date: Date, options: Intl.DateTimeFormatOptions) => date.toLocaleDateString('en-US', options)
}));

import {
    applyDetailsExtras,
    formatLongRuntime,
    renderAboutHtml,
    renderCreditsHtml,
    renderLogoHeadingHtml,
    renderSummaryHtml
} from './detailsInfo';

const TICKS_PER_MINUTE = 600000000;

function itemWith(extra: Record<string, unknown> = {}): BaseItemDto {
    return { Name: 'Title', Id: 'item1', ServerId: 'server1', ...extra } as BaseItemDto;
}

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}

describe('formatLongRuntime', () => {
    it('formats hours and minutes', () => {
        expect(formatLongRuntime(126 * TICKS_PER_MINUTE)).toBe('2 hr 6 min');
    });

    it('formats minutes only under an hour', () => {
        expect(formatLongRuntime(45 * TICKS_PER_MINUTE)).toBe('45 min');
    });

    it('formats whole hours without minutes', () => {
        expect(formatLongRuntime(120 * TICKS_PER_MINUTE)).toBe('2 hr');
    });

    it.each([ 0, null, undefined ])('returns empty string for %p', value => {
        expect(formatLongRuntime(value)).toBe('');
    });
});

describe('renderLogoHeadingHtml', () => {
    it('returns empty string without a logo url', () => {
        expect(renderLogoHeadingHtml(itemWith(), null)).toBe('');
    });

    it('renders the logo image with the item name as alt text', () => {
        const html = renderLogoHeadingHtml(itemWith({ Name: 'Dune' }), 'https://srv/logo.png');

        expect(html).toBe(
            '<div class="lg-details-heading"><img class="lg-details-logo" src="https://srv/logo.png" alt="Dune" decoding="async"></div>'
        );
    });
});

describe('renderSummaryHtml', () => {
    it('renders the type label followed by up to three genres', () => {
        const html = renderSummaryHtml(itemWith({
            Type: 'Movie',
            Genres: [ 'Drama', 'Thriller', 'Mystery', 'Romance' ],
            Overview: 'A quiet story.'
        }));

        expect(count(html, '<span>')).toBe(4);
        expect(html).toContain('<span>Movie</span><span>Drama</span><span>Thriller</span><span>Mystery</span>');
        expect(html).not.toContain('Romance');
        expect(html).toContain('<p class="lg-details-overview">A quiet story.</p>');
    });

    it('removes script markup from the overview', () => {
        const html = renderSummaryHtml(itemWith({ Type: 'Movie', Overview: '<script>alert(1)</script>Safe' }));

        expect(html).not.toContain('<script');
        expect(html).not.toContain('alert');
        expect(html).toContain('Safe');
    });

    it('omits the type span for types without a label', () => {
        const html = renderSummaryHtml(itemWith({ Type: 'Video', Genres: [ 'Drama' ] }));

        expect(html).toContain('<p class="lg-details-genres"><span>Drama</span></p>');
    });

    it('returns empty string without type, genres or overview', () => {
        expect(renderSummaryHtml(itemWith({ Type: 'Video' }))).toBe('');
    });
});

describe('renderCreditsHtml', () => {
    const people = [
        { Name: 'Actor One', Id: 'p1', Type: 'Actor' },
        { Name: 'Actor Two', Id: 'p2', Type: 'Actor' },
        { Name: 'Actor Three', Id: 'p3', Type: 'Actor' },
        { Name: 'Actor Four', Id: 'p4', Type: 'Actor' },
        { Name: 'Director One', Id: 'd1', Type: 'Director' }
    ];

    it('links the first three actors and the director with the details href format', () => {
        const html = renderCreditsHtml(itemWith({ People: people }), 'srv1');

        expect(count(html, 'lg-details-credits__link')).toBe(4);
        expect(html).toContain('<a class="lg-details-credits__link" href="#/details?id=p1&amp;serverId=srv1">Actor One</a>');
        expect(html).toContain('<a class="lg-details-credits__link" href="#/details?id=p3&amp;serverId=srv1">Actor Three</a>');
        expect(html).not.toContain('Actor Four');
        expect(html).toContain('<a class="lg-details-credits__link" href="#/details?id=d1&amp;serverId=srv1">Director One</a>');
    });

    it('renders plain text for a person without an id', () => {
        const html = renderCreditsHtml(itemWith({ People: [ { Name: 'Plain Name', Type: 'Actor' } ] }), 'srv1');

        expect(html).toContain('Plain Name');
        expect(html).not.toContain('<a ');
    });

    it('returns empty string without people', () => {
        expect(renderCreditsHtml(itemWith({ People: [] }), 'srv1')).toBe('');
    });
});

function movieStreams() {
    return [
        {
            Type: 'Audio', Index: 1, IsDefault: true,
            DisplayTitle: 'English - Dolby Digital - 5.1 - Default'
        },
        {
            Type: 'Audio', Index: 2, Title: 'Audio Description',
            DisplayTitle: 'English - AAC - Stereo'
        },
        {
            Type: 'Subtitle', Index: 3, IsHearingImpaired: true,
            DisplayTitle: 'English - SDH - SUBRIP'
        }
    ];
}

function movie(extra: Record<string, unknown> = {}): BaseItemDto {
    return itemWith({
        Type: 'Movie',
        PremiereDate: '2020-12-07T12:00:00Z',
        RunTimeTicks: 126 * TICKS_PER_MINUTE,
        OfficialRating: 'PG-13',
        ProductionLocations: [ 'United States', 'Hungary' ],
        Studios: [ { Name: 'Miramax' } ],
        Genres: [ 'Drama' ],
        Taglines: [ 'Some tagline' ],
        Overview: 'An overview.',
        CommunityRating: 8.34,
        CriticRating: 97,
        MediaSources: [ { MediaStreams: movieStreams() } ],
        ...extra
    });
}

describe('renderAboutHtml', () => {
    it('renders the about wrapper and title card with the genre eyebrow and tagline text', () => {
        const html = renderAboutHtml(movie());

        expect(html).toContain('class="lg-details-about verticalSection detailVerticalSection"');
        expect(html).toContain('<h3 class="lg-details-card__title">Title</h3>');
        expect(html).toContain('<p class="lg-details-card__eyebrow">Drama</p>');
        expect(html).toContain('<p class="lg-details-card__text">Some tagline An overview.</p>');
    });

    it('renders ratings from real values', () => {
        const html = renderAboutHtml(movie());

        expect(html).toContain('<span class="lg-badge lg-badge--rating">PG-13</span>');
        expect(html).toContain('<p class="lg-details-card__text">CommunityRating: 8.3</p>');
        expect(html).toContain('<p class="lg-details-card__text">LiquidGlassCritics: 97%</p>');
    });

    it('renders the release date, runtime, rating, regions and studio', () => {
        const html = renderAboutHtml(movie());

        expect(html).toContain('<dt>LiquidGlassReleased</dt><dd>December 7, 2020</dd>');
        expect(html).toContain('<dt>LiquidGlassRunTime</dt><dd>2 hr 6 min</dd>');
        expect(html).toContain('<dt>LiquidGlassRated</dt><dd>PG-13</dd>');
        expect(html).toContain('<dt>LiquidGlassRegionsOfOrigin</dt><dd>United States, Hungary</dd>');
        expect(html).toContain('<dt>Studio</dt><dd>Miramax</dd>');
    });

    it('takes the default audio language from the default audio stream', () => {
        const html = renderAboutHtml(movie());

        expect(html).toContain('<dt>LiquidGlassDefaultAudio</dt><dd>English</dd>');
        expect(html).not.toContain('LiquidGlassOriginalAudio');
    });

    it('lists unique audio and subtitle titles without the Default flag', () => {
        const html = renderAboutHtml(movie());

        expect(html).toContain('<dt>Audio</dt><dd>English - Dolby Digital - 5.1, English - AAC - Stereo</dd>');
        expect(html).toContain('<dt>Subtitles</dt><dd>English - SDH - SUBRIP</dd>');
        expect(html).not.toContain(' - Default');
    });

    it('renders the SDH and AD accessibility rows when the streams flag them', () => {
        const html = renderAboutHtml(movie());

        expect(html).toContain('<dt><span class="lg-badge">SDH</span></dt><dd>LiquidGlassSdhDescription</dd>');
        expect(html).toContain('<dt><span class="lg-badge">AD</span></dt><dd>LiquidGlassAdDescription</dd>');
    });

    it('omits the SDH and AD rows when no stream flags them', () => {
        const html = renderAboutHtml(movie({
            MediaSources: [ { MediaStreams: [ { Type: 'Audio', Index: 1, DisplayTitle: 'English - AAC - Stereo' } ] } ]
        }));

        expect(html).not.toContain('>SDH<');
        expect(html).not.toContain('>AD<');
        expect(html).not.toContain('LiquidGlassAccessibility');
    });
});

describe('renderAboutHtml for a bare item', () => {
    const html = renderAboutHtml(itemWith());

    it('renders the title card', () => {
        expect(html).toContain('<h3 class="lg-details-card__title">Title</h3>');
    });

    it('omits the ratings card', () => {
        expect(html).not.toContain('lg-details-card--ratings');
    });

    it('omits the languages and accessibility columns', () => {
        expect(html).not.toContain('LiquidGlassLanguages');
        expect(html).not.toContain('LiquidGlassAccessibility');
    });

    it('renders no empty dd elements', () => {
        expect(html).not.toContain('<dd></dd>');
    });
});

describe('release date', () => {
    it('keeps the calendar day of a UTC-midnight premiere date', () => {
        const html = renderAboutHtml(itemWith({ PremiereDate: '2020-05-01T00:00:00.0000000Z' }));

        expect(html).toMatch(/<dt>LiquidGlassReleased<\/dt><dd>May 1, 2020<\/dd>/);
    });

    it('falls back to the production year when the premiere date is invalid', () => {
        const html = renderAboutHtml(itemWith({ PremiereDate: 'not-a-date', ProductionYear: 1999 }));

        expect(html).toContain('<dt>LiquidGlassReleased</dt><dd>1999</dd>');
        expect(html).not.toContain('Invalid Date');
    });
});

describe('plain text overview', () => {
    it('strips html and markdown from the overview', () => {
        const html = renderSummaryHtml(itemWith({ Type: 'Movie', Overview: 'Line one<br />Line <i>two</i> *three*' }));

        expect(html).toContain('Line one');
        expect(html).toContain('two');
        expect(html).toContain('three');
        expect(html).not.toContain('<br');
        expect(html).not.toContain('<i>');
        expect(html).not.toContain('*');
    });
});

describe('audio description detection', () => {
    function withAudioTitle(displayTitle: string): BaseItemDto {
        return itemWith({ MediaSources: [ { MediaStreams: [ { Type: 'Audio', Index: 1, DisplayTitle: displayTitle } ] } ] });
    }

    it.each([
        [ 'Audio Description', true ],
        [ 'English AD', true ],
        [ 'Director commentary description', false ],
        [ 'Ad break', false ]
    ])('for title %p shows AD row: %p', (title, expected) => {
        const html = renderAboutHtml(withAudioTitle(title));

        expect(html.includes('<span class="lg-badge">AD</span>')).toBe(expected);
    });
});

describe('applyDetailsExtras', () => {
    function buildPage(): HTMLElement {
        const page = document.createElement('div');
        page.innerHTML = `
            <div class="detailLogo"></div>
            <div class="detailRibbon">
                <div class="infoWrapper"><h1>Existing</h1></div>
                <div class="buttons"></div>
            </div>
            <div class="detailPageContent"><div class="section"></div></div>
        `;
        return page;
    }

    const extrasItem = itemWith({
        Type: 'Movie',
        Overview: 'Overview text.',
        Genres: [ 'Drama' ],
        People: [ { Name: 'Actor One', Id: 'p1', Type: 'Actor' } ]
    });

    beforeEach(() => {
        liquidGlassState.active = true;
    });

    it('inserts the heading first, summary after infoWrapper, credits last and about at the end of the content', () => {
        const page = buildPage();

        applyDetailsExtras(page, extrasItem, 'https://srv/logo.png');

        const ribbon = page.querySelector('.detailRibbon') as HTMLElement;
        expect(ribbon.firstElementChild?.classList.contains('lg-details-heading')).toBe(true);
        expect(ribbon.querySelector('.infoWrapper')?.nextElementSibling?.classList.contains('lg-details-summary')).toBe(true);
        expect(ribbon.lastElementChild?.classList.contains('lg-details-credits')).toBe(true);

        const content = page.querySelector('.detailPageContent') as HTMLElement;
        expect(content.lastElementChild?.classList.contains('lg-details-about')).toBe(true);
    });

    it('removes the logo heading when the logo fails to load', () => {
        const page = buildPage();
        applyDetailsExtras(page, extrasItem, 'https://srv/broken.png');

        const logo = page.querySelector('.lg-details-logo') as HTMLImageElement;
        logo.dispatchEvent(new Event('error'));

        expect(page.querySelector('.lg-details-heading')).toBeNull();
    });

    it('leaves exactly one of each extra when applied twice', () => {
        const page = buildPage();

        applyDetailsExtras(page, extrasItem, 'https://srv/logo.png');
        applyDetailsExtras(page, extrasItem, 'https://srv/logo.png');

        expect(page.querySelectorAll('.lg-details-heading')).toHaveLength(1);
        expect(page.querySelectorAll('.lg-details-summary')).toHaveLength(1);
        expect(page.querySelectorAll('.lg-details-credits')).toHaveLength(1);
        expect(page.querySelectorAll('.lg-details-about')).toHaveLength(1);
    });

    it('removes previous extras and inserts nothing when Liquid Glass is not active', () => {
        const page = buildPage();
        applyDetailsExtras(page, extrasItem, 'https://srv/logo.png');

        liquidGlassState.active = false;
        applyDetailsExtras(page, extrasItem, 'https://srv/logo.png');

        expect(page.querySelector('.lg-details-heading, .lg-details-summary, .lg-details-credits, .lg-details-about')).toBeNull();
        expect(page.querySelector('.detailRibbon')?.children).toHaveLength(2);
    });
});
