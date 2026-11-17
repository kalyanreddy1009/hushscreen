import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { MediaStream } from '@jellyfin/sdk/lib/generated-client/models/media-stream';
import { describe, expect, it, vi } from 'vitest';

// Faithful subset of mediainfo.getResolutionText (the real module pulls in the whole UI stack).
vi.mock('../mediainfo/mediainfo', () => ({
    getResolutionText: (s: { Width?: number; Height?: number }) => {
        if (!s.Width || !s.Height) return null;
        if (s.Width >= 3800 || s.Height >= 2000) return '4K';
        if (s.Width >= 2500 || s.Height >= 1400) return '1440p';
        if (s.Width >= 1800 || s.Height >= 1000) return '1080p';
        if (s.Width >= 1200 || s.Height >= 700) return '720p';
        return '480p';
    }
}));

import { getImdbUrl, getQualityBadges, renderInfoBadgesHtml } from './qualityBadges';

function video(extra: Partial<MediaStream> = {}): MediaStream {
    return { Type: 'Video', Index: 0, Width: 1920, Height: 1080, ...extra } as MediaStream;
}

function audio(extra: Partial<MediaStream> = {}): MediaStream {
    return { Type: 'Audio', Index: 1, Channels: 2, ...extra } as MediaStream;
}

function sub(extra: Partial<MediaStream> = {}): MediaStream {
    return { Type: 'Subtitle', Index: 2, ...extra } as MediaStream;
}

function itemWith(streams: MediaStream[], extra: Partial<BaseItemDto> = {}): BaseItemDto {
    return { MediaSources: [{ MediaStreams: streams }], ...extra } as BaseItemDto;
}

function ids(item: BaseItemDto): string[] {
    return getQualityBadges(item).map(b => b.id);
}

describe('getQualityBadges', () => {
    it('returns nothing without streams', () => {
        expect(getQualityBadges({})).toEqual([]);
        expect(getQualityBadges({ MediaSources: [] })).toEqual([]);
    });

    it('labels 4K', () => {
        expect(getQualityBadges(itemWith([ video({ Width: 3840, Height: 2160 }) ]))[0]).toMatchObject({ id: '4k', label: '4K' });
    });

    it.each([[1280, 720], [1920, 1080], [2560, 1440]])('labels %ix%i as HD', (Width, Height) => {
        expect(getQualityBadges(itemWith([ video({ Width, Height }) ]))[0]).toMatchObject({ id: 'hd', label: 'HD' });
    });

    it('omits resolution badge for SD', () => {
        expect(ids(itemWith([ video({ Width: 720, Height: 480 }) ]))).toEqual([]);
    });

    it.each([
        ['DOVI', 'Dolby Vision'],
        ['DOVIWithHDR10', 'Dolby Vision'],
        ['DOVIWithHLG', 'Dolby Vision'],
        ['DOVIWithEL', 'Dolby Vision'],
        ['DOVIWithHDR10Plus', 'Dolby Vision'],
        ['HDR10Plus', 'HDR10+'],
        ['HDR10', 'HDR10'],
        ['HLG', 'HLG']
    ])('maps VideoRangeType %s to %s', (VideoRangeType, label) => {
        const badges = getQualityBadges(itemWith([ video({ VideoRangeType } as Partial<MediaStream>) ]));
        expect(badges.filter(b => b.id.startsWith('hdr')).map(b => b.label)).toEqual([label]);
    });

    it('does not badge DOVIWithSDR, DOVIInvalid or SDR', () => {
        for (const VideoRangeType of [ 'DOVIWithSDR', 'DOVIInvalid', 'SDR' ]) {
            expect(ids(itemWith([ video({ VideoRangeType, VideoRange: 'SDR' } as Partial<MediaStream>) ]))).toEqual([ 'hd' ]);
        }
    });

    it('falls back to a generic HDR badge from VideoRange', () => {
        const badges = getQualityBadges(itemWith([ video({ VideoRange: 'HDR', VideoRangeType: 'Unknown' } as Partial<MediaStream>) ]));
        expect(badges.map(b => b.label)).toContain('HDR');
    });

    it('shows Atmos and 7.1 together', () => {
        const badges = getQualityBadges(itemWith([ audio({ Channels: 8, DisplayTitle: 'TrueHD Atmos 7.1' }) ]));
        expect(badges.map(b => b.label)).toEqual([ 'Dolby Atmos', '7.1' ]);
    });

    it('detects Atmos case-insensitively in Profile or Title', () => {
        expect(ids(itemWith([ audio({ Profile: 'Dolby ATMOS' }) ]))).toEqual([ 'atmos' ]);
        expect(ids(itemWith([ audio({ Title: 'eac3 atmos' }) ]))).toEqual([ 'atmos' ]);
    });

    it('detects DTS:X and does not also claim Atmos', () => {
        expect(getQualityBadges(itemWith([ audio({ Channels: 6, Profile: 'DTS:X' }) ])).map(b => b.label)).toEqual([ 'DTS:X', '5.1' ]);
        expect(ids(itemWith([ audio({ Title: 'DTS-X MA' }) ]))).toEqual([ 'dtsx' ]);
    });

    it('maps 6 channels to 5.1 and ignores stereo/mono', () => {
        expect(ids(itemWith([ audio({ Channels: 6 }) ]))).toEqual([ 'ch51' ]);
        expect(ids(itemWith([ audio({ Channels: 2 }) ]))).toEqual([]);
        expect(ids(itemWith([ audio({ Channels: 1 }) ]))).toEqual([]);
    });

    it('uses the default audio stream', () => {
        const item = {
            MediaSources: [{
                DefaultAudioStreamIndex: 3,
                MediaStreams: [ audio({ Index: 1, Channels: 2 }), audio({ Index: 3, Channels: 6 }) ]
            }]
        } as BaseItemDto;
        expect(ids(item)).toEqual([ 'ch51' ]);
    });

    it('prefers SDH over CC', () => {
        const badges = getQualityBadges(itemWith([ sub({ IsHearingImpaired: true }), sub({ Index: 3 }) ], { HasSubtitles: true }));
        expect(badges.map(b => b.label)).toEqual([ 'SDH' ]);
        expect(badges[0].title).toBe('Subtitles for the deaf and hard of hearing');
    });

    it('shows CC for plain subtitles or HasSubtitles', () => {
        expect(ids(itemWith([ sub() ]))).toEqual([ 'cc' ]);
        expect(ids(itemWith([ video({ Width: 640, Height: 360 }) ], { HasSubtitles: true }))).toEqual([ 'cc' ]);
    });

    it('falls back to item.MediaStreams when there are no sources', () => {
        expect(ids({ MediaStreams: [ video({ Width: 3840, Height: 2160 }) ] })).toEqual([ '4k' ]);
    });

    it('keeps the documented order', () => {
        const item = itemWith([
            video({ Width: 3840, Height: 2160, VideoRangeType: 'DOVI' } as Partial<MediaStream>),
            audio({ Channels: 8, Title: 'Atmos' }),
            sub({ IsHearingImpaired: true })
        ]);
        expect(ids(item)).toEqual([ '4k', 'hdr', 'atmos', 'ch71', 'sdh' ]);
    });
});

describe('getImdbUrl', () => {
    it('builds a url for a valid id', () => {
        expect(getImdbUrl({ ProviderIds: { Imdb: 'tt0816692' } })).toBe('https://www.imdb.com/title/tt0816692/');
    });

    it.each([ 'nm0000093', 'tt', 'tt12a', '../evil', 'tt1"><script>', '' ])('rejects %j', Imdb => {
        expect(getImdbUrl({ ProviderIds: { Imdb } })).toBeNull();
    });

    it('returns null when there is no id', () => {
        expect(getImdbUrl({})).toBeNull();
    });
});

describe('renderInfoBadgesHtml', () => {
    function parse(html: string): HTMLElement {
        const root = document.createElement('div');
        root.innerHTML = html;
        return root;
    }

    it('returns an empty string when there is nothing to show', () => {
        expect(renderInfoBadgesHtml({})).toBe('');
    });

    it('renders badges whose full name is announced (role img + aria-label)', () => {
        const root = parse(renderInfoBadgesHtml(itemWith([ video({ Width: 3840, Height: 2160 }) ])));
        const badge = root.querySelector('.lg-badge');
        expect(badge?.textContent).toBe('4K');
        expect(badge?.getAttribute('title')).toBe('4K');
        // aria-label on a role-less span is ignored by screen readers
        expect(badge?.getAttribute('role')).toBe('img');
        expect(badge?.getAttribute('aria-label')).toBe('4K');
    });

    it('renders a safe IMDb link chip', () => {
        const link = parse(renderInfoBadgesHtml({ ProviderIds: { Imdb: 'tt0816692' } })).querySelector('a.lg-badge--link');
        expect(link?.getAttribute('href')).toBe('https://www.imdb.com/title/tt0816692/');
        expect(link?.getAttribute('target')).toBe('_blank');
        expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link?.textContent).toBe('IMDb');
    });

    it('never renders an invalid IMDb id', () => {
        const html = renderInfoBadgesHtml({ ProviderIds: { Imdb: 'tt1"><img src=x onerror=alert(1)>' } });
        expect(html).toBe('');
    });

    it('never echoes server-provided stream text into the markup', () => {
        const html = renderInfoBadgesHtml(itemWith([ audio({ Channels: 6, Title: '<b onclick=x>Atmos</b>' }) ]));
        expect(html).not.toContain('<b');
        expect(html).not.toContain('onclick');
        expect(parse(html).querySelectorAll('b')).toHaveLength(0);
    });
});
