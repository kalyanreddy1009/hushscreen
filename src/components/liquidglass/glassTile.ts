import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import escapeHtml from 'escape-html';
import type { ApiClient } from 'jellyfin-apiclient';

import globalize from '../../lib/globalize';
import { ServerConnections } from '../../lib/jellyfin-apiclient';
import { playbackManager } from '../playback/playbackmanager';

export type GlassTileShape = 'landscape' | 'portrait';

export interface GlassTileOptions {
    shape: GlassTileShape;
}

const LANDSCAPE_MAX_WIDTH = 640;
const PORTRAIT_MAX_WIDTH = 400;
const TILE_CLASS = 'lg-tile';
const FAVORITE_CLASS = 'lg-tile__fav';
const PLAY_CLASS = 'lg-tile__play';
const ICON_FILLED = 'favorite';
const ICON_OUTLINE = 'favorite_border';
const ICON_PLAY = 'play_arrow';
const IMAGE_CLASS = 'lg-tile__image';
const IMAGE_LOADED_CLASS = 'is-loaded';
const IMAGE_FAILED_CLASS = 'is-failed';
const PLACEHOLDER_CLASS = 'lg-tile__placeholder';

interface ImageSource {
    url: string;
}

function attr(value: string | null | undefined): string {
    return escapeHtml(value ?? '');
}

/** Landscape prefers the item backdrop, then the parent's backdrop (episodes), then the thumb, then the primary image. */
function getLandscapeImage(item: BaseItemDto, apiClient: ApiClient): ImageSource | undefined {
    const backdropTag = item.BackdropImageTags?.[0];
    if (backdropTag) {
        return { url: apiClient.getScaledImageUrl(item.Id ?? '', { type: 'Backdrop', maxWidth: LANDSCAPE_MAX_WIDTH, tag: backdropTag }) };
    }

    const parentTag = item.ParentBackdropImageTags?.[0];
    if (parentTag && item.ParentBackdropItemId) {
        return { url: apiClient.getScaledImageUrl(item.ParentBackdropItemId, { type: 'Backdrop', maxWidth: LANDSCAPE_MAX_WIDTH, tag: parentTag }) };
    }

    const thumbTag = item.ImageTags?.Thumb;
    if (thumbTag) {
        return { url: apiClient.getScaledImageUrl(item.Id ?? '', { type: 'Thumb', maxWidth: LANDSCAPE_MAX_WIDTH, tag: thumbTag }) };
    }

    return getPrimaryImage(item, apiClient, LANDSCAPE_MAX_WIDTH);
}

function getPrimaryImage(item: BaseItemDto, apiClient: ApiClient, maxWidth: number): ImageSource | undefined {
    const primaryTag = item.ImageTags?.Primary;
    if (!primaryTag) return undefined;
    return { url: apiClient.getScaledImageUrl(item.Id ?? '', { type: 'Primary', maxWidth, tag: primaryTag }) };
}

function getImage(item: BaseItemDto, shape: GlassTileShape): ImageSource | undefined {
    const apiClient = ServerConnections.getApiClient(item.ServerId ?? undefined);
    if (shape === 'landscape') return getLandscapeImage(item, apiClient);
    return getPrimaryImage(item, apiClient, PORTRAIT_MAX_WIDTH);
}

function renderImageHtml(item: BaseItemDto, shape: GlassTileShape): string {
    const image = getImage(item, shape);
    const placeholder = `<span class="${PLACEHOLDER_CLASS}" aria-hidden="true">${attr(getTitleAndDescription(item).title)}</span>`;
    const chipGenre = item.Genres?.[0];
    const chip = chipGenre ? `<span class="lg-tile__chip">${attr(chipGenre)}</span>` : '';
    const img = image ? `<img class="${IMAGE_CLASS}" src="${attr(image.url)}" loading="lazy" alt="">` : '';
    const pressed = Boolean(item.UserData?.IsFavorite);
    const favorite = `<button type="button" class="${FAVORITE_CLASS}" aria-label="${attr(globalize.translate('Favorite'))}" aria-pressed="${pressed}" data-id="${attr(item.Id)}"><span class="material-icons lg-tile__icon" aria-hidden="true">${pressed ? ICON_FILLED : ICON_OUTLINE}</span></button>`;

    return `<div class="lg-tile__media">${placeholder}${img}${chip}${favorite}</div>`;
}

/** Episodes show the series as title and the episode name as the description fallback. */
function getTitleAndDescription(item: BaseItemDto): { title: string; description: string } {
    const isEpisode = item.Type === 'Episode' && Boolean(item.SeriesName);
    const title = isEpisode ? item.SeriesName ?? '' : item.Name ?? '';
    const description = item.Overview || (isEpisode ? item.Name ?? '' : '');
    return { title, description };
}

function renderTextHtml(item: BaseItemDto): string {
    const { title, description } = getTitleAndDescription(item);
    const desc = description ? `<div class="lg-tile__desc">${attr(description)}</div>` : '';
    const playLabel = `${globalize.translate('Play')} ${item.Name ?? ''}`;
    const play = `<button type="button" class="${PLAY_CLASS}" aria-label="${attr(playLabel)}"><span class="material-icons lg-tile__icon" aria-hidden="true">${ICON_PLAY}</span></button>`;

    return `<div class="lg-tile__body"><div class="lg-tile__text"><div class="lg-tile__title">${attr(title)}</div>${desc}</div>${play}</div>`;
}

function renderTile(item: BaseItemDto, shape: GlassTileShape): string {
    const attributes = [
        `data-id="${attr(item.Id)}"`,
        `data-serverid="${attr(item.ServerId)}"`,
        `data-type="${attr(item.Type)}"`,
        `data-isfolder="${Boolean(item.IsFolder)}"`,
        `aria-label="${attr(getTitleAndDescription(item).title)}"`
    ].join(' ');

    return `<div class="${TILE_CLASS} ${TILE_CLASS}--${shape} itemAction focusable" data-action="link" tabindex="0" ${attributes}>${renderImageHtml(item, shape)}${renderTextHtml(item)}</div>`;
}

/** Markup for a row of glass tiles. Each tile carries the same data attributes as a card so item shortcuts open it. */
export function renderGlassTiles(items: BaseItemDto[], opts: GlassTileOptions): string {
    return items.map(item => renderTile(item, opts.shape)).join('');
}

function setFavoriteState(button: HTMLElement, pressed: boolean): void {
    const label = globalize.translate('Favorite');
    button.setAttribute('aria-pressed', String(pressed));
    button.setAttribute('aria-label', label);
    const icon = button.querySelector('.material-icons');
    if (icon) icon.textContent = pressed ? ICON_FILLED : ICON_OUTLINE;
}

async function toggleFavorite(button: HTMLButtonElement, apiClient: ApiClient): Promise<void> {
    const id = button.dataset.id;
    if (!id) return;

    if (button.getAttribute('aria-busy') === 'true') return;

    const wasPressed = button.getAttribute('aria-pressed') === 'true';
    button.setAttribute('aria-busy', 'true');
    try {
        await apiClient.updateFavoriteStatus(apiClient.getCurrentUserId(), id, !wasPressed);
        setFavoriteState(button, !wasPressed);
    } catch (error) {
        console.warn('[GlassTile] Failed to update favorite status', error);
    } finally {
        button.removeAttribute('aria-busy');
    }
}

function playTile(button: HTMLButtonElement): void {
    const tile = button.closest(`.${TILE_CLASS}`);
    const id = tile?.getAttribute('data-id');
    if (!id) return;

    const serverId = tile?.getAttribute('data-serverid') || undefined;
    playbackManager.play({ ids: [id], serverId }).catch((error: unknown) => {
        console.warn('[GlassTile] Failed to start playback', error);
    });
}

function markImageLoaded(img: HTMLImageElement): void {
    img.classList.add(IMAGE_LOADED_CLASS);
}

// A failed image keeps the title on a still fill: the shimmer would otherwise promise art that never comes.
function markImageFailed(img: HTMLImageElement): void {
    img.classList.add(IMAGE_FAILED_CLASS);
}

/** Delegated handler: image load/error events do not bubble, so the container listens in the capture phase. */
function onTileImageEvent(event: Event): void {
    if (!(event.target instanceof HTMLImageElement) || !event.target.classList.contains(IMAGE_CLASS)) return;

    if (event.type === 'load') {
        markImageLoaded(event.target);
    } else {
        markImageFailed(event.target);
    }
}

/** Marks images that finished loading before their listener existed (cached), skipping ones already marked. */
function markCompleteImages(container: HTMLElement): void {
    container.querySelectorAll<HTMLImageElement>(`img.${IMAGE_CLASS}`).forEach(img => {
        const hasState = img.classList.contains(IMAGE_LOADED_CLASS) || img.classList.contains(IMAGE_FAILED_CLASS);
        if (!img.complete || hasState) return;

        if (img.naturalWidth > 0) {
            markImageLoaded(img);
        } else {
            markImageFailed(img);
        }
    });
}

/**
 * Wires click handling for tiles rendered inside the container.
 * Heart and play clicks stop propagation so the tile body (item navigation) does not also fire.
 * Also fades in tile images as they load.
 * Returns a function that removes the listeners.
 */
export function bindGlassTiles(container: HTMLElement, apiClient: ApiClient): () => void {
    const onClick = (event: Event): void => {
        if (!(event.target instanceof Element)) return;

        const favorite = event.target.closest<HTMLButtonElement>(`.${FAVORITE_CLASS}`);
        if (favorite && container.contains(favorite)) {
            event.preventDefault();
            event.stopPropagation();
            void toggleFavorite(favorite, apiClient);
            return;
        }

        const play = event.target.closest<HTMLButtonElement>(`.${PLAY_CLASS}`);
        if (play && container.contains(play)) {
            event.stopPropagation();
            playTile(play);
        }
    };

    // A div is not activated by Enter natively; a remote's OK/Enter on the focused tile opens it like a click.
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Enter' || event.defaultPrevented) return;
        if (!(event.target instanceof HTMLElement) || !event.target.classList.contains(TILE_CLASS)) return;
        if (!container.contains(event.target)) return;

        event.preventDefault();
        event.target.click();
    };

    // Capture phase so this runs before the item-navigation listener on the same container (bubble phase).
    container.addEventListener('click', onClick, true);
    container.addEventListener('keydown', onKeyDown);
    container.addEventListener('load', onTileImageEvent, true);
    container.addEventListener('error', onTileImageEvent, true);
    // Runs after the caller's synchronous innerHTML assignment, so cached images in the new markup are seen
    const frame = requestAnimationFrame(() => markCompleteImages(container));
    return () => {
        container.removeEventListener('click', onClick, true);
        container.removeEventListener('keydown', onKeyDown);
        container.removeEventListener('load', onTileImageEvent, true);
        container.removeEventListener('error', onTileImageEvent, true);
        cancelAnimationFrame(frame);
    };
}
