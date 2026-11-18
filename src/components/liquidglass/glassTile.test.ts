import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const play = vi.hoisted(() => vi.fn());
const getScaledImageUrl = vi.hoisted(() => vi.fn((itemId: string, options: { type: string; maxWidth?: number; tag?: string }) => `https://example.test/${itemId}/${options.type}?maxWidth=${options.maxWidth}&tag=${options.tag}`));
const updateFavoriteStatus = vi.hoisted(() => vi.fn());
const getCurrentUserId = vi.hoisted(() => vi.fn(() => 'user-1'));
const apiClient = vi.hoisted(() => ({ getScaledImageUrl, updateFavoriteStatus, getCurrentUserId }));

vi.mock('../playback/playbackmanager', () => ({ playbackManager: { play } }));
vi.mock('../../lib/jellyfin-apiclient', () => ({
    ServerConnections: { getApiClient: () => apiClient }
}));
vi.mock('../../lib/globalize', () => ({
    default: { translate: (key: string) => key }
}));

import { bindGlassTiles, renderGlassTiles } from './glassTile';

const SERVER_ID = 'server-1';

function movie(overrides: Partial<BaseItemDto> = {}): BaseItemDto {
    return {
        Id: 'movie-1',
        Name: 'Blade Runner',
        Type: 'Movie',
        ServerId: SERVER_ID,
        Genres: [ 'Science Fiction', 'Thriller' ],
        Overview: 'A detective hunts replicants.',
        BackdropImageTags: [ 'backdrop-tag' ],
        ImageTags: { Primary: 'primary-tag' },
        UserData: { IsFavorite: false },
        ...overrides
    } as BaseItemDto;
}

function mount(html: string): HTMLDivElement {
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    return container;
}

describe('renderGlassTiles', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        vi.clearAllMocks();
    });

    it('renders title, genre chip and overview for a full item', () => {
        const container = mount(renderGlassTiles([ movie() ], { shape: 'landscape' }));

        expect(container.querySelector('.lg-tile__title')?.textContent).toBe('Blade Runner');
        expect(container.querySelector('.lg-tile__chip')?.textContent).toBe('Science Fiction');
        expect(container.querySelector('.lg-tile__desc')?.textContent).toBe('A detective hunts replicants.');
    });

    it('omits the genre chip and description when the item has none', () => {
        const container = mount(renderGlassTiles([ movie({ Genres: [], Overview: '' }) ], { shape: 'landscape' }));

        expect(container.querySelector('.lg-tile__chip')).toBeNull();
        expect(container.querySelector('.lg-tile__desc')).toBeNull();
        expect(container.querySelector('.lg-tile__title')?.textContent).toBe('Blade Runner');
    });

    it('carries the card data attributes and item-action hooks on the tile root', () => {
        const container = mount(renderGlassTiles([ movie() ], { shape: 'landscape' }));
        const tile = container.querySelector<HTMLElement>('.lg-tile');

        expect(tile?.classList.contains('itemAction')).toBe(true);
        expect(tile?.getAttribute('data-action')).toBe('link');
        expect(tile?.getAttribute('data-id')).toBe('movie-1');
        expect(tile?.getAttribute('data-serverid')).toBe(SERVER_ID);
        expect(tile?.getAttribute('data-type')).toBe('Movie');
        expect(tile?.getAttribute('data-isfolder')).toBe('false');
    });

    it('makes the tile root focusable for remote and keyboard focus, labelled by its title', () => {
        const container = mount(renderGlassTiles([ movie() ], { shape: 'landscape' }));
        const tile = container.querySelector('.lg-tile');

        expect(tile?.getAttribute('tabindex')).toBe('0');
        expect(tile?.getAttribute('role')).toBeNull();
        expect(tile?.getAttribute('aria-label')).toBe('Blade Runner');
        expect(tile?.classList.contains('focusable')).toBe(true);
    });

    it('labels episode tiles with the series title, matching the visible title', () => {
        const container = mount(renderGlassTiles([ movie({ Id: 'ep-1', Type: 'Episode', Name: 'Pilot', SeriesName: 'The Show' }) ], { shape: 'landscape' }));

        expect(container.querySelector('.lg-tile')?.getAttribute('aria-label')).toBe('The Show');
    });

    it('escapes HTML in Name and Overview', () => {
        const hostile = movie({ Name: '<img src=x onerror=alert(1)>', Overview: '<b>bold</b> & "quoted"' });
        const html = renderGlassTiles([ hostile ], { shape: 'landscape' });
        const container = mount(html);

        expect(container.querySelector('img[onerror]')).toBeNull();
        expect(container.querySelector('b')).toBeNull();
        expect(container.querySelector('.lg-tile__title')?.textContent).toBe('<img src=x onerror=alert(1)>');
        expect(container.querySelector('.lg-tile__desc')?.textContent).toBe('<b>bold</b> & "quoted"');
    });

    it('uses the backdrop for landscape tiles and the primary image for portrait tiles', () => {
        const landscape = mount(renderGlassTiles([ movie() ], { shape: 'landscape' }));
        const portrait = mount(renderGlassTiles([ movie() ], { shape: 'portrait' }));

        expect(getScaledImageUrl).toHaveBeenCalledWith('movie-1', { type: 'Backdrop', maxWidth: 640, tag: 'backdrop-tag' });
        expect(getScaledImageUrl).toHaveBeenCalledWith('movie-1', { type: 'Primary', maxWidth: 400, tag: 'primary-tag' });
        expect(landscape.querySelector('img.lg-tile__image')?.getAttribute('src')).toContain('Backdrop');
        expect(portrait.querySelector('img.lg-tile__image')?.getAttribute('src')).toContain('Primary');
    });

    it('falls back to the primary image for landscape tiles without a backdrop or thumb', () => {
        const container = mount(renderGlassTiles([ movie({ BackdropImageTags: [] }) ], { shape: 'landscape' }));

        expect(getScaledImageUrl).toHaveBeenCalledWith('movie-1', { type: 'Primary', maxWidth: 640, tag: 'primary-tag' });
        expect(container.querySelector('img.lg-tile__image')?.getAttribute('src')).toContain('Primary');
    });

    it('lazy-loads the image with empty alt text', () => {
        const container = mount(renderGlassTiles([ movie() ], { shape: 'landscape' }));
        const img = container.querySelector('img.lg-tile__image');

        expect(img?.getAttribute('loading')).toBe('lazy');
        expect(img?.getAttribute('alt')).toBe('');
    });

    it('shows the series as title and the episode name as description fallback for episodes', () => {
        const episode = movie({
            Id: 'ep-1',
            Type: 'Episode',
            Name: 'Pilot',
            SeriesName: 'The Show',
            Overview: ''
        });
        const container = mount(renderGlassTiles([ episode ], { shape: 'landscape' }));

        expect(container.querySelector('.lg-tile__title')?.textContent).toBe('The Show');
        expect(container.querySelector('.lg-tile__desc')?.textContent).toBe('Pilot');
    });

    it('reflects UserData.IsFavorite in the heart aria-pressed state and icon', () => {
        const favorite = mount(renderGlassTiles([ movie({ UserData: { IsFavorite: true } }) ], { shape: 'landscape' }));
        const plain = mount(renderGlassTiles([ movie({ UserData: { IsFavorite: false } }) ], { shape: 'landscape' }));

        const pressed = favorite.querySelector<HTMLButtonElement>('.lg-tile__fav');
        const unpressed = plain.querySelector<HTMLButtonElement>('.lg-tile__fav');

        expect(pressed?.getAttribute('aria-pressed')).toBe('true');
        expect(pressed?.getAttribute('aria-label')).toBe('Favorite');
        expect(pressed?.dataset.id).toBe('movie-1');
        expect(pressed?.querySelector('.material-icons')?.textContent).toBe('favorite');
        expect(unpressed?.getAttribute('aria-pressed')).toBe('false');
        expect(unpressed?.querySelector('.material-icons')?.textContent).toBe('favorite_border');
    });

    it('labels the play button with the item name', () => {
        const container = mount(renderGlassTiles([ movie() ], { shape: 'landscape' }));

        expect(container.querySelector('.lg-tile__play')?.getAttribute('aria-label')).toBe('Play Blade Runner');
    });
});

describe('bindGlassTiles', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        container = mount(renderGlassTiles([ movie() ], { shape: 'landscape' }));
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    function heart(): HTMLButtonElement {
        return container.querySelector<HTMLButtonElement>('.lg-tile__fav') as HTMLButtonElement;
    }

    function flush(): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, 0));
    }

    it('flips favourite status on heart click and updates state on success', async () => {
        updateFavoriteStatus.mockResolvedValueOnce({ IsFavorite: true });
        const unbind = bindGlassTiles(container, apiClient as never);

        heart().click();
        await flush();

        expect(updateFavoriteStatus).toHaveBeenCalledWith('user-1', 'movie-1', true);
        expect(heart().getAttribute('aria-pressed')).toBe('true');
        expect(heart().querySelector('.material-icons')?.textContent).toBe('favorite');
        expect(heart().hasAttribute('aria-busy')).toBe(false);
        expect(heart().disabled).toBe(false);
        unbind();
    });

    it('ignores a second heart click while the first update is in flight', async () => {
        let resolveUpdate!: (value: unknown) => void;
        const pending = new Promise<unknown>(resolve => {
            resolveUpdate = resolve;
        });
        updateFavoriteStatus.mockReturnValueOnce(pending);
        const unbind = bindGlassTiles(container, apiClient as never);

        heart().click();
        expect(heart().getAttribute('aria-busy')).toBe('true');
        heart().click();
        expect(updateFavoriteStatus).toHaveBeenCalledTimes(1);

        resolveUpdate({ IsFavorite: true });
        await flush();

        expect(heart().hasAttribute('aria-busy')).toBe(false);
        expect(heart().getAttribute('aria-pressed')).toBe('true');
        unbind();
    });

    it('opens the tile on Enter when the tile itself has focus, but not from the heart', () => {
        const onClick = vi.fn();
        container.addEventListener('click', onClick);
        const unbind = bindGlassTiles(container, apiClient as never);
        const tile = container.querySelector<HTMLElement>('.lg-tile') as HTMLElement;

        tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(onClick).toHaveBeenCalledTimes(1);

        heart().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(onClick).toHaveBeenCalledTimes(1);
        unbind();
    });

    it('keeps the heart state and warns when the favourite update is rejected', async () => {
        const failure = new Error('server down');
        updateFavoriteStatus.mockRejectedValueOnce(failure);
        const unbind = bindGlassTiles(container, apiClient as never);

        heart().click();
        await flush();

        expect(updateFavoriteStatus).toHaveBeenCalledWith('user-1', 'movie-1', true);
        expect(heart().getAttribute('aria-pressed')).toBe('false');
        expect(heart().querySelector('.material-icons')?.textContent).toBe('favorite_border');
        expect(heart().hasAttribute('aria-busy')).toBe(false);
        expect(heart().disabled).toBe(false);
        expect(console.warn).toHaveBeenCalledWith(expect.any(String), failure);
        unbind();
    });

    it('does not let a heart click reach the tile body (item navigation)', () => {
        updateFavoriteStatus.mockResolvedValueOnce({ IsFavorite: true });
        const navigate = vi.fn();
        container.addEventListener('click', navigate);
        const unbind = bindGlassTiles(container, apiClient as never);

        heart().click();

        expect(updateFavoriteStatus).toHaveBeenCalledWith('user-1', 'movie-1', true);
        expect(navigate).not.toHaveBeenCalled();
        container.removeEventListener('click', navigate);
        unbind();
    });

    it('plays the item when the play button is clicked, without reaching item navigation', () => {
        play.mockResolvedValueOnce(undefined);
        const navigate = vi.fn();
        container.addEventListener('click', navigate);
        const unbind = bindGlassTiles(container, apiClient as never);

        container.querySelector<HTMLButtonElement>('.lg-tile__play')?.click();

        expect(play).toHaveBeenCalledWith({ ids: [ 'movie-1' ], serverId: SERVER_ID });
        expect(navigate).not.toHaveBeenCalled();
        container.removeEventListener('click', navigate);
        unbind();
    });

    it('lets a tile body click reach item navigation', () => {
        const navigate = vi.fn();
        container.addEventListener('click', navigate);
        const unbind = bindGlassTiles(container, apiClient as never);

        container.querySelector<HTMLElement>('.lg-tile__title')?.click();

        expect(navigate).toHaveBeenCalledTimes(1);
        expect(updateFavoriteStatus).not.toHaveBeenCalled();
        expect(play).not.toHaveBeenCalled();
        container.removeEventListener('click', navigate);
        unbind();
    });

    it('stops listening after unbind', () => {
        const unbind = bindGlassTiles(container, apiClient as never);
        unbind();

        heart().click();
        container.querySelector<HTMLButtonElement>('.lg-tile__play')?.click();

        expect(updateFavoriteStatus).not.toHaveBeenCalled();
        expect(play).not.toHaveBeenCalled();
    });
});
