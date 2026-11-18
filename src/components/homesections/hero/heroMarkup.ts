import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import escapeHtml from 'escape-html';
import type { ApiClient } from 'jellyfin-apiclient';

import globalize from '../../../lib/globalize';
import { renderInfoBadgesHtml } from '../../liquidglass/qualityBadges';

// Pure markup and item-formatting helpers for the hero carousel (no DOM state, no events).

const LOGO_MAX_WIDTH = 600;
const TICKS_PER_MINUTE = 600000000;
const MAX_GENRES = 2;

/**
 * Width to request. getScaledImageUrl multiplies by devicePixelRatio, so divide it out to keep the
 * final request at the cap (the server resizes on the fly and can be slow).
 */
export function getImageWidth(cap: number): number {
    const ratio = window.devicePixelRatio || 1;
    return Math.floor(cap / ratio);
}

function getLogoUrl(apiClient: ApiClient, item: BaseItemDto): string | undefined {
    const options = { type: 'Logo', maxWidth: getImageWidth(LOGO_MAX_WIDTH), quality: 80 };
    if (item.ImageTags?.Logo && item.Id) {
        return apiClient.getScaledImageUrl(item.Id, { ...options, tag: item.ImageTags.Logo });
    }
    if (item.ParentLogoImageTag && item.ParentLogoItemId) {
        return apiClient.getScaledImageUrl(item.ParentLogoItemId, { ...options, tag: item.ParentLogoImageTag });
    }
    return undefined;
}

export function formatRuntime(ticks: number | null | undefined): string {
    const minutes = Math.round((ticks ?? 0) / TICKS_PER_MINUTE);
    if (minutes <= 0) return '';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest}m`;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function getResumeTicks(item: BaseItemDto): number {
    return item.UserData?.PlaybackPositionTicks ?? 0;
}

function getProgressPercent(item: BaseItemDto): number {
    const total = item.RunTimeTicks ?? 0;
    const position = getResumeTicks(item);
    if (!total || position <= 0) return 0;
    return Math.min(100, Math.max(0, (position / total) * 100));
}

const TYPE_KEYS: Record<string, string> = { Movie: 'Movie', Series: 'Series', Episode: 'Episode' };
const FRESH_CRITIC_RATING = 60;

/** Line one: type and genres ("Movie · Sci-Fi · Adventure"). */
function renderTypeLine(item: BaseItemDto): string {
    const typeKey = item.Type ? TYPE_KEYS[item.Type] : undefined;
    const parts = [
        typeKey ? globalize.translate(typeKey) : '',
        ...(item.Genres ?? []).slice(0, MAX_GENRES)
    ].filter(Boolean);
    return parts.map(part => `<span>${escapeHtml(part)}</span>`).join('');
}

/** Line two: year, runtime, ratings, then the official rating and quality badges. */
function renderInfoLine(item: BaseItemDto): string {
    const items: string[] = [];
    if (item.ProductionYear) items.push(escapeHtml(String(item.ProductionYear)));
    const runtime = formatRuntime(item.RunTimeTicks);
    if (runtime) items.push(escapeHtml(runtime));
    if (item.CommunityRating) {
        items.push(`<span class="lg-hero__star"><span aria-hidden="true">★</span> ${item.CommunityRating.toFixed(1)}</span>`);
    }
    if (item.CriticRating) {
        const state = item.CriticRating >= FRESH_CRITIC_RATING ? 'fresh' : 'rotten';
        items.push(`<span class="lg-hero__critic lg-hero__critic--${state}" title="Rotten Tomatoes">RT ${Math.round(item.CriticRating)}%</span>`);
    }

    const rating = item.OfficialRating ? `<span class="lg-badge lg-badge--rating">${escapeHtml(item.OfficialRating)}</span>` : '';
    const badges = rating + renderInfoBadgesHtml(item);

    return items.map(html => `<span class="lg-hero__info-item">${html}</span>`).join('')
        + (badges ? `<span class="lg-hero__info-item lg-hero__badges">${badges}</span>` : '');
}

function iconButton(action: string, icon: string, label: string, extraClass = '', extraAttrs = ''): string {
    const safe = escapeHtml(label);
    return `<button type="button" class="lg-hero__btn lg-hero__btn--circle focusable ${extraClass}" data-action="${action}" aria-label="${safe}" title="${safe}" ${extraAttrs}><span class="material-icons ${icon}" aria-hidden="true"></span></button>`;
}

function renderTitle(apiClient: ApiClient, item: BaseItemDto): string {
    const logoUrl = getLogoUrl(apiClient, item);
    const title = escapeHtml(item.SeriesName || item.Name || '');
    const heading = logoUrl ?
        `<img class="lg-hero__logo" src="${escapeHtml(logoUrl)}" alt="${title}" decoding="async">` :
        `<span class="lg-hero__title lg-type-display">${title}</span>`;
    const subtitle = item.SeriesName ? `<span class="lg-hero__subtitle">${escapeHtml(item.Name || '')}</span>` : '';
    return `<h2 class="lg-hero__heading">${heading}${subtitle}</h2>`;
}

function renderFavoriteButton(item: BaseItemDto): string {
    const isFavorite = Boolean(item.UserData?.IsFavorite);
    const label = globalize.translate(isFavorite ? 'Favorite' : 'AddToFavorites');
    const icon = isFavorite ? 'favorite' : 'favorite_border';
    return iconButton('favorite', icon, label, 'lg-hero__fav', `aria-pressed="${isFavorite}"`);
}

export function renderSlide(apiClient: ApiClient, item: BaseItemDto, index: number, count: number): string {
    const progress = getProgressPercent(item);
    const isResume = progress > 0;
    const playLabel = escapeHtml(globalize.translate(isResume ? 'ButtonResume' : 'Play'));
    const infoLabel = escapeHtml(globalize.translate('ButtonInfo'));

    return `<div class="lg-hero__slide" role="group" aria-roledescription="slide" aria-label="${index + 1} / ${count}" data-index="${index}" data-id="${escapeHtml(item.Id || '')}">
    <img class="lg-hero__backdrop" alt="" decoding="async" draggable="false"${index === 0 ? ' fetchpriority="high"' : ''}>
    <div class="lg-hero__content">
        ${renderTitle(apiClient, item)}
        <div class="lg-hero__meta">${renderTypeLine(item)}</div>
        ${item.Overview ? `<p class="lg-hero__overview">${escapeHtml(item.Overview)}</p>` : ''}
        <div class="lg-hero__info">${renderInfoLine(item)}</div>
        ${isResume ? `<div class="lg-hero__progress" aria-hidden="true"><span style="width:${progress.toFixed(1)}%"></span></div>` : ''}
        <div class="lg-hero__actions">
            <button type="button" class="lg-hero__btn lg-hero__btn--primary focusable" data-action="play"><span class="material-icons play_arrow" aria-hidden="true"></span><span>${playLabel}</span></button>
            <button type="button" class="lg-hero__btn lg-hero__btn--info focusable" data-action="info">${infoLabel}</button>
            ${renderFavoriteButton(item)}
        </div>
    </div>
</div>`;
}

export function renderNav(count: number): string {
    if (count < 2) return '';
    return iconButton('prev', 'chevron_left', globalize.translate('Previous'), 'lg-hero__nav lg-hero__nav--prev')
        + iconButton('next', 'chevron_right', globalize.translate('Next'), 'lg-hero__nav lg-hero__nav--next');
}

export function renderDots(count: number): string {
    if (count < 2) return '';
    const dots = Array.from({ length: count }, (_, i) =>
        `<button type="button" class="lg-hero__dot focusable" data-action="goto" data-index="${i}" aria-label="${i + 1} / ${count}"><span></span></button>`
    ).join('');
    return `<div class="lg-hero__controls"><div class="lg-hero__dots">${dots}</div></div>`;
}
