import { parseHTML } from 'linkedom';
import { z } from 'zod';

const BLOCK = new Set([
  'P', 'DIV', 'BR', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE',
  'TABLE', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION', 'HR', 'DD', 'DT',
]);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME']);

/** True when the element is explicitly not part of the visible article. */
export function isExplicitlyHidden(el: Element): boolean {
  const tag = el.tagName;
  if (tag === 'HTML' || tag === 'BODY') return false;
  if (el.hasAttribute('hidden')) return true;
  if ((el.getAttribute('aria-hidden') ?? '').toLowerCase() === 'true') return true;
  const style = el.getAttribute('style') ?? '';
  return /display\s*:\s*none/i.test(style) || /visibility\s*:\s*(hidden|collapse)/i.test(style);
}

/** Convert an HTML fragment (or plain text) to readable plain text with paragraph breaks. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  if (!/[<&]/.test(html)) return normalizeWhitespace(html);
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const parts: string[] = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        parts.push(child.textContent ?? '');
      } else if (child.nodeType === 1) {
        const el = child as Element;
        const tag = el.tagName.toUpperCase();
        if (SKIP.has(tag) || isExplicitlyHidden(el)) continue;
        const block = BLOCK.has(tag);
        if (block) parts.push('\n');
        walk(child);
        if (block) parts.push('\n');
      }
    }
  };
  walk(document.body);
  return normalizeWhitespace(parts.join(''));
}

export function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.8 ? lastSpace : max)}…`;
}

/** A field the model may leave empty; an empty string means "not stated". */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null))
    .catch(null);
