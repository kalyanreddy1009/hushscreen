import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { MediaStream } from '@jellyfin/sdk/lib/generated-client/models/media-stream';
import { PersonKind } from '@jellyfin/sdk/lib/generated-client/models/person-kind';
import DOMPurify from 'dompurify';
import escapeHtml from 'escape-html';
import markdownIt from 'markdown-it';

import globalize from '../../lib/globalize';
import { parseISO8601Date, toLocaleDateString } from '../../scripts/datetime';
import { isLiquidGlass } from '../../themes/liquidglass/isLiquidGlass';

const TICKS_PER_MINUTE = 600000000;
const MINUTES_PER_HOUR = 60;
const MAX_GENRES = 3;
const MAX_STARRING = 3;
const MAX_DIRECTORS = 2;
const SDH_PATTERN = /\bSDH\b/i;
const AD_DESCRIPTION_PATTERN = /audio description|descriptive audio|described video/i;
const AD_ABBREVIATION_PATTERN = /\bAD\b/;
const DATE_OPTIONS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' };
const EXTRAS_SELECTOR = '.lg-details-heading, .lg-details-summary, .lg-details-credits, .lg-details-about';
const AUDIO_JUNK_PATTERN = /^(ISO Media file produced by [^-]*[^-\s]|Lavf[\d.]*|SoundHandler|Core Media Audio)\s*-\s*/i;
const TAGS_CLAMP_CLASS = 'lg-tags--clamped';
const TAGS_MORE_CLASS = 'lg-tags__more';
const HIDE_CLASS = 'hide';

const TYPE_LABEL_KEYS = new Map<string, string>([
    [ 'Movie', 'Movie' ],
    [ 'Series', 'Series' ],
    [ 'Episode', 'Episode' ]
]);

type Person = NonNullable<BaseItemDto['People']>[number];

/** Runtime as "2 hr 6 min", "45 min" or "2 hr". Empty string when there is no runtime. */
export function formatLongRuntime(ticks: number | null | undefined): string {
    if (!ticks || ticks <= 0) return '';

    const totalMinutes = Math.round(ticks / TICKS_PER_MINUTE);
    const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
    const minutes = totalMinutes % MINUTES_PER_HOUR;

    if (hours === 0) return minutes > 0 ? `${minutes} min` : '';
    if (minutes === 0) return `${hours} hr`;
    return `${hours} hr ${minutes} min`;
}

/** Overview text as plain text, using the same sanitising markdown pipeline as the stock details page. */
export function toPlainText(text: string): string {
    // eslint-disable-next-line sonarjs/disabled-auto-escaping
    const sanitized = DOMPurify.sanitize(markdownIt({ html: true }).render(text));
    // DOMParser builds an inert, detached document, so nothing in the sanitized markup executes or loads.
    const doc = new DOMParser().parseFromString(sanitized, 'text/html');
    for (const lineBreak of doc.body.querySelectorAll('br')) {
        lineBreak.replaceWith(' ');
    }
    return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function renderLogoHeadingHtml(item: BaseItemDto, logoUrl: string | null): string {
    if (!logoUrl) return '';

    return `<div class="lg-details-heading"><img class="lg-details-logo" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(item.Name ?? '')}" decoding="async"></div>`;
}

function getTypeLabel(item: BaseItemDto): string | null {
    const key = item.Type ? TYPE_LABEL_KEYS.get(item.Type) : undefined;
    return key ? globalize.translate(key) : null;
}

export function renderSummaryHtml(item: BaseItemDto): string {
    const spans: string[] = [];
    const typeLabel = getTypeLabel(item);
    if (typeLabel) spans.push(`<span>${escapeHtml(typeLabel)}</span>`);

    for (const genre of (item.Genres ?? []).slice(0, MAX_GENRES)) {
        spans.push(`<span>${escapeHtml(genre)}</span>`);
    }

    const parts: string[] = [];
    if (spans.length) {
        parts.push(`<p class="lg-details-genres">${spans.join('')}</p>`);
    }
    const overview = item.Overview ? toPlainText(item.Overview) : '';
    if (overview) {
        parts.push(`<p class="lg-details-overview">${escapeHtml(overview)}</p>`);
    }

    if (!parts.length) return '';
    return `<div class="lg-details-summary">${parts.join('')}</div>`;
}

function renderPersonHtml(person: Person, serverId: string): string {
    const name = escapeHtml(person.Name ?? '');
    if (!person.Id) return name;

    const href = `#/details?id=${encodeURIComponent(person.Id)}&amp;serverId=${encodeURIComponent(serverId)}`;
    return `<a class="lg-details-credits__link" href="${href}">${name}</a>`;
}

function renderCreditRow(label: string, people: Person[], serverId: string): string {
    if (!people.length) return '';

    const links = people.map(person => renderPersonHtml(person, serverId)).join(', ');
    return `<div><dt>${escapeHtml(label)}</dt><dd>${links}</dd></div>`;
}

export function renderCreditsHtml(item: BaseItemDto, serverId: string): string {
    const people = item.People ?? [];
    const starring = people.filter(p => p.Type === PersonKind.Actor).slice(0, MAX_STARRING);
    const directors = people.filter(p => p.Type === PersonKind.Director).slice(0, MAX_DIRECTORS);

    const rows = [
        renderCreditRow(globalize.translate('LiquidGlassStarring'), starring, serverId),
        renderCreditRow(globalize.translate(directors.length > 1 ? 'Directors' : 'Director'), directors, serverId)
    ].filter(Boolean);

    if (!rows.length) return '';
    return `<dl class="lg-details-credits">${rows.join('')}</dl>`;
}

function getStreams(item: BaseItemDto): MediaStream[] {
    return item.MediaSources?.[0]?.MediaStreams ?? [];
}

function getFlagWords(): Set<string> {
    return new Set([ 'Default', 'Forced', globalize.translate('Default'), globalize.translate('Forced') ]);
}

/** Display title without trailing " - Default" / " - Forced" segments. */
function cleanDisplayTitle(displayTitle: string, flagWords: Set<string>): string {
    return displayTitle.split(' - ').filter(segment => !flagWords.has(segment)).join(' - ');
}

function getLanguagePart(stream: MediaStream): string {
    const first = stream.DisplayTitle?.split(' - ')[0];
    return first || (stream.Language ?? '').toUpperCase();
}

function getUniqueTitles(streams: MediaStream[]): string {
    const flagWords = getFlagWords();
    const titles = streams
        .map(s => cleanDisplayTitle(s.DisplayTitle ?? '', flagWords))
        .filter(Boolean);
    return [ ...new Set(titles) ].join(', ');
}

/** Local calendar date of an ISO premiere date, or null when it cannot be parsed. */
function parsePremiereDate(value: string): Date | null {
    try {
        const date = parseISO8601Date(value, true);
        return Number.isNaN(date.getTime()) ? null : date;
    } catch {
        return null;
    }
}

function formatReleaseDate(item: BaseItemDto): string {
    const premiere = item.PremiereDate ? parsePremiereDate(item.PremiereDate) : null;
    if (premiere) {
        return toLocaleDateString(premiere, DATE_OPTIONS);
    }
    return item.ProductionYear ? String(item.ProductionYear) : '';
}

function renderInfoRow(label: string, value: string): string {
    if (!value) return '';
    return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function renderInfoColumn(title: string, rows: string[]): string {
    const filled = rows.filter(Boolean);
    if (!filled.length) return '';

    return `<section class="lg-details-info__col"><h3 class="lg-details-info__title">${escapeHtml(title)}</h3><dl>${filled.join('')}</dl></section>`;
}

function renderInformationColumn(item: BaseItemDto): string {
    const studios = (item.Studios ?? []).map(s => s.Name).filter(Boolean);
    const studioLabel = globalize.translate(studios.length > 1 ? 'Studios' : 'Studio');

    return renderInfoColumn(globalize.translate('LiquidGlassInformation'), [
        renderInfoRow(globalize.translate('LiquidGlassReleased'), formatReleaseDate(item)),
        renderInfoRow(globalize.translate('LiquidGlassRunTime'), formatLongRuntime(item.RunTimeTicks)),
        renderInfoRow(globalize.translate('LiquidGlassRated'), item.OfficialRating ?? ''),
        renderInfoRow(globalize.translate('LiquidGlassRegionsOfOrigin'), (item.ProductionLocations ?? []).join(', ')),
        renderInfoRow(studioLabel, studios.join(', '))
    ]);
}

function renderLanguagesColumn(streams: MediaStream[]): string {
    const audio = streams.filter(s => s.Type === 'Audio');
    const subtitles = streams.filter(s => s.Type === 'Subtitle');
    const defaultAudio = audio.find(s => s.IsDefault) ?? audio[0];

    return renderInfoColumn(globalize.translate('LiquidGlassLanguages'), [
        renderInfoRow(globalize.translate('LiquidGlassDefaultAudio'), defaultAudio ? getLanguagePart(defaultAudio) : ''),
        renderInfoRow(globalize.translate('Audio'), getUniqueTitles(audio)),
        renderInfoRow(globalize.translate('Subtitles'), getUniqueTitles(subtitles))
    ]);
}

function renderBadgeRow(badge: string, description: string): string {
    return `<div><dt><span class="lg-badge">${escapeHtml(badge)}</span></dt><dd>${escapeHtml(description)}</dd></div>`;
}

function isAudioDescriptionTitle(title: string | null | undefined): boolean {
    if (!title) return false;
    return AD_DESCRIPTION_PATTERN.test(title) || AD_ABBREVIATION_PATTERN.test(title);
}

function renderAccessibilityColumn(streams: MediaStream[]): string {
    const audio = streams.filter(s => s.Type === 'Audio');
    const subtitles = streams.filter(s => s.Type === 'Subtitle');

    const hasSdh = subtitles.some(s => s.IsHearingImpaired === true
        || SDH_PATTERN.test(s.DisplayTitle ?? '')
        || SDH_PATTERN.test(s.Title ?? ''));
    const hasAd = audio.some(s => [ s.Title, s.DisplayTitle ].some(isAudioDescriptionTitle));

    return renderInfoColumn(globalize.translate('LiquidGlassAccessibility'), [
        hasSdh ? renderBadgeRow('SDH', globalize.translate('LiquidGlassSdhDescription')) : '',
        hasAd ? renderBadgeRow('AD', globalize.translate('LiquidGlassAdDescription')) : ''
    ]);
}

function renderTitleCard(item: BaseItemDto): string {
    const genre = item.Genres?.[0];
    const text = [ item.Taglines?.[0], item.Overview ]
        .filter(Boolean)
        .map(part => toPlainText(part as string))
        .filter(Boolean)
        .join(' ');

    const parts = [
        item.Name ? `<h3 class="lg-details-card__title">${escapeHtml(item.Name)}</h3>` : '',
        genre ? `<p class="lg-details-card__eyebrow">${escapeHtml(genre)}</p>` : '',
        text ? `<p class="lg-details-card__text">${escapeHtml(text)}</p>` : ''
    ].filter(Boolean);

    if (!parts.length) return '';
    return `<article class="lg-details-card">${parts.join('')}</article>`;
}

function renderRatingsCard(item: BaseItemDto): string {
    const parts: string[] = [];

    if (item.OfficialRating) {
        parts.push(`<div class="lg-details-card__row"><span class="lg-badge lg-badge--rating">${escapeHtml(item.OfficialRating)}</span></div>`);
    }
    if (typeof item.CommunityRating === 'number') {
        const text = `${globalize.translate('CommunityRating')}: ${item.CommunityRating.toFixed(1)}`;
        parts.push(`<p class="lg-details-card__text">${escapeHtml(text)}</p>`);
    }
    if (typeof item.CriticRating === 'number') {
        const text = `${globalize.translate('LiquidGlassCritics')}: ${item.CriticRating}%`;
        parts.push(`<p class="lg-details-card__text">${escapeHtml(text)}</p>`);
    }

    if (!parts.length) return '';
    return `<article class="lg-details-card lg-details-card--ratings">${parts.join('')}</article>`;
}

/** Apple TV style About block: title and ratings cards, then Information, Languages and Accessibility columns. */
export function renderAboutHtml(item: BaseItemDto): string {
    const streams = getStreams(item);
    const cards = [ renderTitleCard(item), renderRatingsCard(item) ].filter(Boolean).join('');
    const columns = [
        renderInformationColumn(item),
        renderLanguagesColumn(streams),
        renderAccessibilityColumn(streams)
    ].filter(Boolean).join('');

    if (!cards && !columns) return '';

    const cardsHtml = cards ? `<div class="lg-details-about__cards">${cards}</div>` : '';
    const infoHtml = columns ? `<div class="lg-details-info">${columns}</div>` : '';

    return `<div class="lg-details-about verticalSection detailVerticalSection"><h2 class="sectionTitle sectionTitle-cards">${escapeHtml(globalize.translate('LiquidGlassAbout'))}</h2>${cardsHtml}${infoHtml}</div>`;
}

/** Audio track label prefixes written by encoders and players, e.g. "ISO Media file produced by Google Inc. - AAC". */
function cleanAudioOptions(select: HTMLSelectElement): void {
    for (const option of select.querySelectorAll('option')) {
        const label = option.textContent ?? '';
        const cleaned = label.replace(AUDIO_JUNK_PATTERN, '');
        if (cleaned !== label) option.textContent = cleaned;
    }
}

let tagsIdCounter = 0;

function expandTags(tags: HTMLElement, moreButton: HTMLElement): void {
    moreButton.setAttribute('aria-expanded', 'true');
    tags.classList.remove(TAGS_CLAMP_CLASS);
    moreButton.remove();
    tags.focus();
}

/** Clamps the tag line to one line when it wraps, and adds a button that shows all of it. Safe to re-run. */
function syncTagsClamp(page: HTMLElement): void {
    const tags = page.querySelector<HTMLElement>('.itemTags');
    if (!tags) return;

    const previousButton = tags.nextElementSibling;
    if (previousButton?.classList.contains(TAGS_MORE_CLASS)) previousButton.remove();
    tags.classList.remove(TAGS_CLAMP_CLASS);
    tags.removeAttribute('tabindex');

    // A hidden view measures 0. Never clamp then; the ResizeObserver re-runs this once the view has a size.
    if (tags.clientHeight === 0) return;

    tags.classList.add(TAGS_CLAMP_CLASS);
    if (tags.scrollHeight <= tags.clientHeight) {
        tags.classList.remove(TAGS_CLAMP_CLASS);
        return;
    }

    if (!tags.id) tags.id = `lg-tags-${++tagsIdCounter}`;
    const moreButton = document.createElement('button');
    moreButton.type = 'button';
    moreButton.className = TAGS_MORE_CLASS;
    moreButton.textContent = globalize.translate('ShowMore');
    moreButton.setAttribute('aria-expanded', 'false');
    moreButton.setAttribute('aria-controls', tags.id);
    moreButton.addEventListener('click', () => expandTags(tags, moreButton));

    // The button sits after the clamped line, so the line-clamp cannot hide it
    tags.tabIndex = -1;
    tags.insertAdjacentElement('afterend', moreButton);
}

/** Measures after the view has laid out, so a view still being shown is not measured at 0. */
function scheduleTagsClamp(page: HTMLElement): void {
    requestAnimationFrame(() => syncTagsClamp(page));
}

/** Re-syncs the clamp only when the tag line changes width. The clamp changes height, so height changes would loop. */
function observeTagsWidth(tags: HTMLElement, sync: () => void): ResizeObserver {
    let lastWidth = -1;
    const observer = new ResizeObserver(entries => {
        const width = entries[0]?.contentRect.width ?? 0;
        if (width === lastWidth) return;
        lastWidth = width;
        sync();
    });
    observer.observe(tags);
    return observer;
}

/** The play-from-beginning button shares the Resume state: only label it while it is shown. */
function syncPlayFromBeginningLabel(replayButton: HTMLElement): void {
    if (replayButton.classList.contains(HIDE_CLASS)) return;

    const label = globalize.translate('PlayFromBeginning');
    replayButton.title = label;
    replayButton.setAttribute('aria-label', label);
}

function observeChanges(target: Element, options: MutationObserverInit, sync: () => void): MutationObserver {
    const observer = new MutationObserver(sync);
    observer.observe(target, options);
    return observer;
}

type DetailsObserver = MutationObserver | ResizeObserver;

const detailsObservers = new WeakMap<HTMLElement, DetailsObserver[]>();
const hookedPages = new WeakSet<HTMLElement>();

function disconnectDetailsObservers(page: HTMLElement): void {
    for (const observer of detailsObservers.get(page) ?? []) {
        observer.disconnect();
    }
    detailsObservers.delete(page);
}

/**
 * Keeps the audio labels, the play-from-beginning label and the tag clamp right while stock code repopulates or toggles them.
 * Cached views are restored without applyDetailsExtras, so the viewshow listener below calls this again.
 */
function watchDetailsControls(page: HTMLElement): void {
    disconnectDetailsObservers(page);
    const observers: DetailsObserver[] = [];

    const select = page.querySelector<HTMLSelectElement>('.selectAudio');
    if (select) {
        const syncAudio = () => cleanAudioOptions(select);
        syncAudio();
        observers.push(observeChanges(select, { childList: true }, syncAudio));
    }

    const replayButton = page.querySelector<HTMLElement>('.btnReplay');
    if (replayButton) {
        const syncReplay = () => syncPlayFromBeginningLabel(replayButton);
        syncReplay();
        observers.push(observeChanges(replayButton, { attributes: true, attributeFilter: [ 'class' ] }, syncReplay));
    }

    const tags = page.querySelector<HTMLElement>('.itemTags');
    if (tags) {
        scheduleTagsClamp(page);
        if (typeof ResizeObserver !== 'undefined') {
            observers.push(observeTagsWidth(tags, () => syncTagsClamp(page)));
        }
    }

    detailsObservers.set(page, observers);

    if (!hookedPages.has(page)) {
        hookedPages.add(page);
        page.addEventListener('viewbeforehide', () => disconnectDetailsObservers(page));
        page.addEventListener('viewshow', () => watchDetailsControls(page));
    }
}

/** Replaces the Liquid Glass details extras on the page. Stock theme gets no extras. */
export function applyDetailsExtras(page: HTMLElement, item: BaseItemDto, logoUrl: string | null): void {
    for (const element of page.querySelectorAll(EXTRAS_SELECTOR)) {
        element.remove();
    }

    if (!isLiquidGlass()) return;

    watchDetailsControls(page);

    const ribbon = page.querySelector('.detailRibbon');
    if (ribbon) {
        ribbon.insertAdjacentHTML('afterbegin', renderLogoHeadingHtml(item, logoUrl));
        const logo = ribbon.querySelector('.lg-details-logo');
        if (logo) {
            logo.addEventListener('error', () => {
                logo.closest('.lg-details-heading')?.remove();
            }, { once: true });
        }
        ribbon.querySelector('.infoWrapper')?.insertAdjacentHTML('afterend', renderSummaryHtml(item));
        ribbon.insertAdjacentHTML('beforeend', renderCreditsHtml(item, item.ServerId ?? ''));
    }

    page.querySelector('.detailPageContent')?.insertAdjacentHTML('beforeend', renderAboutHtml(item));
}
