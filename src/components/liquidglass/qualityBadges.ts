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
}

const IMDB_ID_PATTERN = /^tt\d+$/;
const HD_RESOLUTIONS = new Set([ '720p', '1080p', '1440p' ]);
const CHANNELS_7_1 = 8;
const CHANNELS_5_1 = 6;
const NON_DOVI_RANGE_TYPES = new Set([ 'DOVIWithSDR', 'DOVIInvalid' ]);

const badge = (id: string, label: string, title = label): QualityBadge => ({ id, label, title });

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
    if (type.startsWith('DOVI') && !NON_DOVI_RANGE_TYPES.has(type)) return [ badge('hdr', 'Dolby Vision') ];
    if (type === 'HDR10Plus') return [ badge('hdr', 'HDR10+') ];
    if (type === 'HDR10') return [ badge('hdr', 'HDR10') ];
    if (type === 'HLG') return [ badge('hdr', 'HLG', 'Hybrid Log-Gamma') ];
    if (video.VideoRange === 'HDR') return [ badge('hdr', 'HDR', 'High dynamic range') ];
    return [];
}

function getDefaultAudio(item: BaseItemDto, streams: MediaStream[]): MediaStream | undefined {
    const defaultIndex = item.MediaSources?.[0]?.DefaultAudioStreamIndex;
    return streams.find(s => s.Type === 'Audio' && (s.Index === defaultIndex || defaultIndex == null));
}

function getAudioBadges(audio: MediaStream | undefined): QualityBadge[] {
    if (!audio) return [];
    const text = [ audio.Profile, audio.DisplayTitle, audio.Title ].filter(Boolean).join(' ');
    const badges: QualityBadge[] = [];

    if (/atmos/i.test(text)) badges.push(badge('atmos', 'Dolby Atmos'));
    else if (/dts[:-]x/i.test(text)) badges.push(badge('dtsx', 'DTS:X'));

    if (audio.Channels === CHANNELS_7_1) badges.push(badge('ch71', '7.1', '7.1 surround sound'));
    else if (audio.Channels === CHANNELS_5_1) badges.push(badge('ch51', '5.1', '5.1 surround sound'));
    return badges;
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
        ...getAudioBadges(getDefaultAudio(item, streams)),
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
        return `<span class="lg-badge" role="img" title="${title}" aria-label="${title}">${escapeHtml(b.label)}</span>`;
    });

    const imdbUrl = getImdbUrl(item);
    if (imdbUrl) {
        badges.push(`<a class="lg-badge lg-badge--link" href="${escapeHtml(imdbUrl)}" target="_blank" rel="noopener noreferrer" title="IMDb" aria-label="IMDb">IMDb</a>`);
    }

    return badges.join('');
}
