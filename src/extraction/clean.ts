import { parseHTML } from 'linkedom';
import { htmlToText, isExplicitlyHidden, normalizeWhitespace } from '../util/text.js';

/** Plain text kept for classification and search. */
export const MAX_CONTENT_TEXT = 200_000;
/** Selected article HTML kept beside that text. */
export const MAX_CONTENT_HTML = 500_000;

export type StoredQuality = 'unknown' | 'full' | 'partial';
export type ExtractionQuality = 'full' | 'partial' | 'suspect';

/** Compact widgets identified by their own class or id, not by publisher or sentence. */
const CHROME = /(^|[^a-z])(cookies?|consent|gdpr|newsletter|paywall|modal|popup|ad-?block(?:er)?|sponsor)([^a-z]|$)/i;
const UI_PHRASE_SOURCE = '\\b(accept all|reject all|cookies?|consent|ad-?blockers?|newsletter|sign in|log in|manage preferences|subscribe)\\b';
const CHROME_TEXT_LIMIT = 800;
const PARAGRAPH_CHARS = 60;
const LONG_PARAGRAPH_CHARS = 120;

export interface CleanedContent {
  html: string;
  text: string;
  quality: ExtractionQuality;
  reasons: string[];
  /** Hidden or widget nodes removed from this fragment. */
  removed: number;
  /** Plain text that those nodes contained. */
  removedText: string;
}

/**
 * Readability treats class and id as boilerplate signals and does not exempt `<html>`.
 * A site-wide class such as `dst-header` therefore deletes the document root before
 * any article node is scored. The body fallback then keeps hidden text via `textContent`.
 */
export function protectDocumentRoots(document: Document): void {
  const root = document.documentElement;
  if (!root) return;
  root.removeAttribute('class');
  root.removeAttribute('id');
}

function isChromeWidget(el: Element): boolean {
  const tag = el.tagName;
  if (tag === 'HTML' || tag === 'BODY' || tag === 'ARTICLE' || tag === 'MAIN') return false;
  const marker = `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`;
  if (!CHROME.test(marker)) return false;
  return (el.textContent ?? '').length <= CHROME_TEXT_LIMIT;
}

function removeMatching(root: ParentNode, match: (el: Element) => boolean): { removed: number; text: string } {
  const nodes = [...root.querySelectorAll('*')];
  const parts: string[] = [];
  let removed = 0;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const el = nodes[i];
    if (!el?.isConnected || !match(el)) continue;
    parts.push(el.textContent ?? '');
    el.remove();
    removed++;
  }
  return { removed, text: normalizeWhitespace(parts.join('\n')) };
}

export function removeHiddenElements(root: ParentNode): number {
  return removeMatching(root, isExplicitlyHidden).removed;
}

export function removeChromeWidgets(root: ParentNode): number {
  return removeMatching(root, isChromeWidget).removed;
}

/** Prepare a fetched document for Readability without discarding the article tree. */
export function prepareDocument(document: Document): void {
  protectDocumentRoots(document);
  if (!document.body) return;
  removeHiddenElements(document.body);
  removeChromeWidgets(document.body);
}

export function cleanExtractedHtml(html: string): CleanedContent {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const hidden = removeMatching(document.body, isExplicitlyHidden);
  const chrome = removeMatching(document.body, isChromeWidget);
  const text = htmlToText(document.body.innerHTML);
  const assessment = assessText(text, blockStats(document.body, text));
  return {
    html: document.body.innerHTML.slice(0, MAX_CONTENT_HTML),
    text: text.slice(0, MAX_CONTENT_TEXT),
    quality: assessment.quality,
    reasons: assessment.reasons,
    removed: hidden.removed + chrome.removed,
    removedText: normalizeWhitespace([hidden.text, chrome.text].filter(Boolean).join('\n')),
  };
}

function flat(s: string): string {
  return normalizeWhitespace(s).replace(/\s+/g, ' ');
}

/** True when saved plain text still contains a real span of the discarded boilerplate. */
export function textContainsRemoved(stored: string, removedText: string): boolean {
  const removed = flat(removedText);
  const haystack = flat(stored);
  if (removed.length < 20) return false;
  const probes = [removed.slice(0, 80)];
  if (removed.length > 160) probes.push(removed.slice(Math.floor(removed.length / 2), Math.floor(removed.length / 2) + 80));
  return probes.some((probe) => probe.length >= 20 && haystack.includes(probe));
}

interface BlockStats {
  paragraphs: number;
  longParagraphs: number;
  linkDensity: number;
}

function blockStats(root: ParentNode, text: string): BlockStats {
  const blocks = [...root.querySelectorAll('p, li, blockquote')];
  let paragraphs = 0;
  let longParagraphs = 0;
  for (const el of blocks) {
    if (el.parentElement?.closest('p, li, blockquote')) continue;
    const blockText = normalizeWhitespace(el.textContent ?? '');
    const linkChars = [...el.querySelectorAll('a')].reduce((n, a) => n + (a.textContent?.length ?? 0), 0);
    const density = blockText.length ? linkChars / blockText.length : 0;
    if (blockText.length >= PARAGRAPH_CHARS && density < 0.5) {
      paragraphs++;
      if (blockText.length >= LONG_PARAGRAPH_CHARS) longParagraphs++;
    }
  }
  if (paragraphs === 0) {
    const chunks = text.split(/\n{2,}/).map((s) => s.trim()).filter((s) => s.length >= PARAGRAPH_CHARS);
    paragraphs = chunks.length;
    longParagraphs = chunks.filter((s) => s.length >= LONG_PARAGRAPH_CHARS).length;
  }
  const linkChars = [...root.querySelectorAll('a')].reduce((n, a) => n + (a.textContent?.length ?? 0), 0);
  const linkDensity = text.length ? linkChars / text.length : 1;
  return { paragraphs, longParagraphs, linkDensity };
}

function assessText(text: string, stats: BlockStats): { quality: ExtractionQuality; reasons: string[] } {
  const hits = text.match(new RegExp(UI_PHRASE_SOURCE, 'gi'))?.length ?? 0;
  const uiDominated = stats.paragraphs < 2 && hits >= 2 && text.length < 1200;
  const linkHeavy = stats.linkDensity > 0.55 && stats.paragraphs < 2;
  const reasons: string[] = [];
  if (text.length < 80) reasons.push('too short');
  if (uiDominated) reasons.push('interface text');
  if (linkHeavy) reasons.push('mostly links');
  if (stats.paragraphs < 1 && text.length < 300) reasons.push('no article paragraphs');

  let quality: ExtractionQuality;
  if (!text || text.length < 80 || uiDominated || linkHeavy) quality = 'suspect';
  else if (stats.paragraphs >= 2 || stats.longParagraphs >= 1 || text.length >= 1500) quality = 'full';
  else if (stats.paragraphs >= 1 || text.length >= 120) quality = 'partial';
  else quality = 'suspect';
  if (quality === 'suspect' && reasons.length === 0) reasons.push('no article paragraphs');
  return { quality, reasons };
}

/** Quality of feed plain text, used when no page extraction is kept. A single summary sentence stays partial. */
export function textQuality(text: string): StoredQuality {
  const t = normalizeWhitespace(text);
  if (!t) return 'unknown';
  const chunks = t.split(/\n{2,}/).map((s) => s.trim()).filter((s) => s.length >= PARAGRAPH_CHARS);
  const hits = t.match(new RegExp(UI_PHRASE_SOURCE, 'gi'))?.length ?? 0;
  const uiDominated = chunks.length < 2 && hits >= 2 && t.length < 1200;
  if (!uiDominated && (chunks.length >= 2 || t.length >= 1500)) return 'full';
  return 'partial';
}

/** Drop hidden and compact widget markup before display sanitizing unwraps those elements. */
export function stripBoilerplateHtml(html: string): string {
  if (!/hidden|display\s*:|aria-hidden|cookie|consent|gdpr|newsletter|paywall|modal|popup|ad-?block|sponsor/i.test(html)) {
    return html;
  }
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  removeHiddenElements(document.body);
  removeChromeWidgets(document.body);
  return document.body.innerHTML;
}

/**
 * Whether page text should replace feed text.
 * A shorter clean article can win; a longer blob of boilerplate cannot.
 * `feedLength` is the feed's text, not a previous extraction.
 */
export function preferExtracted(quality: ExtractionQuality, extractedLength: number, feedLength: number): boolean {
  if (quality === 'suspect' || extractedLength < 80) return false;
  if (quality === 'partial') return extractedLength >= 120 && extractedLength > feedLength;
  if (extractedLength >= feedLength) return true;
  return feedLength < 1500 && extractedLength >= 300;
}
