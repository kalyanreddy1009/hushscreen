import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { MediaStream } from '@jellyfin/sdk/lib/generated-client/models/media-stream';
import escapeHtml from 'escape-html';

import { getResolutionText } from '../mediainfo/mediainfo';

export interface QualityBadge {
    id: string;
    /** Short visible text. Product names are not translated. */
    label: string;
    /** Accessible full name. */
    title: string;
    /** Official logo file base name in themes/liquidglass/badges. Omitted when there is no logo. */
    logo?: string;
}

const IMDB_ID_PATTERN = /^tt\d+$/;
const HD_RESOLUTIONS = new Set([ '720p', '1080p', '1440p' ]);
const CHANNELS_7_1 = 8;
const CHANNELS_5_1 = 6;
const CHANNELS_5_1_MAX = 7;
const NON_DOVI_RANGE_TYPES = new Set([ 'DOVIWithSDR', 'DOVIInvalid' ]);

const badge = (id: string, label: string, title = label, logo?: string): QualityBadge => (
    logo ? { id, label, title, logo } : { id, label, title }
);

function getStreams(item: BaseItemDto): MediaStream[] {
    const source = item.MediaSources?.[0];
    return source?.MediaStreams ?? item.MediaStreams ?? [];
}

function getResolutionBadge(video: MediaStream | undefined): QualityBadge[] {
    if (!video) return [];
    const resolution = getResolutionText(video) as string | null;
    if (resolution === '4K') return [ badge('4k', '4K') ];
    if (resolution && HD_RESOLUTIONS.has(resolution)) return [ badge('hd', 'HD', 'High definition') ];
    return [];
}

function getHdrBadge(video: MediaStream | undefined): QualityBadge[] {
    if (!video) return [];
    const type = String(video.VideoRangeType ?? '');
    if (type.startsWith('DOVI') && !NON_DOVI_RANGE_TYPES.has(type)) return [ badge('hdr', 'Dolby Vision', 'Dolby Vision', 'dolby-vision') ];
    if (type === 'HDR10Plus') return [ badge('hdr', 'HDR10+') ];
    if (type === 'HDR10') return [ badge('hdr', 'HDR10') ];
    if (type === 'HLG') return [ badge('hdr', 'HLG', 'Hybrid Log-Gamma') ];
    if (video.VideoRange === 'HDR') return [ badge('hdr', 'HDR', 'High dynamic range') ];
    return [];
}

/** Audio format badges in display order. Each format appears at most once. */
const AUDIO_FORMAT_BADGES: Record<string, QualityBadge> = {
    atmos: badge('atmos', 'Dolby Atmos', 'Dolby Atmos', 'dolby-atmos'),
    dtsx: badge('dtsx', 'DTS:X'),
    truehd: badge('truehd', 'TrueHD', 'Dolby TrueHD', 'dolby-truehd'),
    dtshdma: badge('dtshdma', 'DTS-HD MA', 'DTS-HD Master Audio', 'dts-hd-ma'),
    dtshd: badge('dtshd', 'DTS-HD', 'DTS-HD High Resolution Audio'),
    dts: badge('dts', 'DTS', 'DTS', 'dts'),
    ddp: badge('ddp', 'Dolby Digital+', 'Dolby Digital Plus', 'dolby-digital-plus'),
    dd: badge('dd', 'Dolby Digital', 'Dolby Digital', 'dolby-digital')
};
const AUDIO_FORMAT_ORDER = [ 'atmos', 'dtsx', 'truehd', 'dtshdma', 'dtshd', 'dts', 'ddp', 'dd' ];

/** Classifies one audio track into exactly one format id, or null when it gets no badge. */
function classifyAudioFormat(audio: MediaStream): string | null {
    const codec = (audio.Codec ?? '').toLowerCase();
    const text = [ audio.Profile, audio.DisplayTitle, audio.Title ].filter(Boolean).join(' ');

    if (/atmos/i.test(text)) return 'atmos';
    if (/dts[:-]x/i.test(text)) return 'dtsx';
    if (codec === 'truehd') return 'truehd';
    if (codec === 'dts' && /\bMA\b|master audio/i.test(text)) return 'dtshdma';
    if (codec === 'dts' && /\bHRA\b|high resolution/i.test(text)) return 'dtshd';
    if (codec === 'dts') return 'dts';
    if (codec === 'eac3') return 'ddp';
    if (codec === 'ac3') return 'dd';
    return null;
}

function getAudioFormatBadges(streams: MediaStream[]): QualityBadge[] {
    const found = new Set(streams.filter(s => s.Type === 'Audio').map(classifyAudioFormat));
    return AUDIO_FORMAT_ORDER.filter(id => found.has(id)).map(id => AUDIO_FORMAT_BADGES[id]);
}

/** One channel badge from the largest channel count on any audio track. */
function getChannelBadge(streams: MediaStream[]): QualityBadge[] {
    const channels = Math.max(0, ...streams.filter(s => s.Type === 'Audio').map(s => s.Channels ?? 0));
    if (channels >= CHANNELS_7_1) return [ badge('ch71', '7.1', '7.1 surround sound') ];
    if (channels >= CHANNELS_5_1 && channels <= CHANNELS_5_1_MAX) return [ badge('ch51', '5.1', '5.1 surround sound') ];
    return [];
}

// The 10.11 MediaStream type has no audio-description flag, so no AD badge is derived.
function getAccessibilityBadges(item: BaseItemDto, streams: MediaStream[]): QualityBadge[] {
    const subtitles = streams.filter(s => s.Type === 'Subtitle');
    if (subtitles.some(s => s.IsHearingImpaired)) {
        return [ badge('sdh', 'SDH', 'Subtitles for the deaf and hard of hearing') ];
    }
    if (item.HasSubtitles || subtitles.length) return [ badge('cc', 'CC', 'Closed captions') ];
    return [];
}

/** Quality/accessibility badges from real stream data, in display order. */
export function getQualityBadges(item: BaseItemDto): QualityBadge[] {
    const streams = getStreams(item);
    const video = streams.find(s => s.Type === 'Video');

    return [
        ...getResolutionBadge(video),
        ...getHdrBadge(video),
        ...getAudioFormatBadges(streams),
        ...getChannelBadge(streams),
        ...getAccessibilityBadges(item, streams)
    ];
}

export function getImdbUrl(item: BaseItemDto): string | null {
    const id = item.ProviderIds?.Imdb;
    return id && IMDB_ID_PATTERN.test(id) ? `https://www.imdb.com/title/${id}/` : null;
}

/** Badge markup for the info line. Empty string when there is nothing to show. */
export function renderInfoBadgesHtml(item: BaseItemDto): string {
    const badges = getQualityBadges(item).map(b => {
        const title = escapeHtml(b.title);
        const classes = b.logo ? `lg-badge lg-badge--logo lg-badge--logo-${b.logo}` : 'lg-badge';
        return `<span class="${classes}" role="img" title="${title}" aria-label="${title}">${escapeHtml(b.label)}</span>`;
    });

    const imdbUrl = getImdbUrl(item);
    if (imdbUrl) {
        badges.push(`<a class="lg-badge lg-badge--link" href="${escapeHtml(imdbUrl)}" target="_blank" rel="noopener noreferrer" title="IMDb" aria-label="IMDb">IMDb</a>`);
    }

    return badges.join('');
}
