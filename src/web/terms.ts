import { parseHTML } from 'linkedom';
import type { TermRecord } from '../stories/repository.js';
import { READINGS, type Reading } from '../terms/readings.js';
import { escapeHtml, SafeHtml } from './html.js';

/**
 * How far the weak words of a reading may stand from the name they belong to: a
 * sentence, and the one before it.
 */
const READING_WINDOW = 200;

/** A term of the glossary, as the pages need it. */
export type MarkableTerm = Pick<TermRecord, 'key' | 'name' | 'description' | 'summary'> & {
  /**
   * The news writes this name in lower case most of the time: it is an ordinary word
   * that one story gave a meaning to. It is marked only in the stories that use it that
   * way, and only where the text writes it as it is named.
   */
  ordinary?: boolean;
  /**
   * The name stands for more than one thing, and these are the words that tell the
   * readings apart. The name is marked only where they stand near it.
   */
  reading?: Reading;
  /**
   * The story named this term, and the story knows which of the readings it means.
   * The term is marked there even where the words of the reading are not said.
   */
  scoped?: boolean;
};

interface Segment {
  text: string;
  /** The key of the term, when this piece of text is one. */
  key: string | null;
  title: string | null;
}

/** The longest name first, so that "Open AI" wins over "Open". */
function longestFirst(a: MarkableTerm, b: MarkableTerm): number {
  return b.name.length - a.name.length;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The name of a term, with the words that are too common to be worth marking left out. */
function markable(terms: MarkableTerm[]): MarkableTerm[] {
  return terms.filter((t) => t.name.trim().length >= 2 && !COMMON.has(t.name.trim().toLowerCase()));
}

/**
 * Words that are terms in the glossary and also ordinary words: they would be marked in
 * every sentence that contains them, and the reader would learn nothing.
 */
const COMMON = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'was', 'were', 'are', 'its',
  'ai', 'us', 'uk', 'eu', 'un', 'it', 'in', 'on', 'of', 'to', 'is', 'as', 'at', 'by', 'or', 'be',
]);

/**
 * The terms to mark in a story: the whole glossary, and the ordinary words of this story
 * on top of it. An ordinary word is left out of the glossary's marks — "NEW" is Debian's
 * incoming queue in one story and the opposite of old in all the others — but it is
 * marked in the story that named it, and there only where it is written as it is named.
 *
 * A name with two readings is a third kind: it is marked wherever the words of its
 * reading stand near it, so that "PT" is the Workers' Party where the text says party
 * and the Pacific time zone nowhere else. The story that named it is marked either way.
 */
export function markingTerms(glossary: MarkableTerm[], own: MarkableTerm[]): MarkableTerm[] {
  const named = new Set(own.map((t) => t.key));
  const out: MarkableTerm[] = [];
  const ordinary: MarkableTerm[] = [];
  for (const term of glossary) {
    const reading = READINGS[term.key];
    if (term.ordinary) {
      if (!named.has(term.key)) continue;
      ordinary.push({ ...term, scoped: true, reading });
      continue;
    }
    if (reading) {
      out.push({ ...term, scoped: named.has(term.key), reading });
      continue;
    }
    out.push(term);
  }
  return [...out, ...ordinary];
}

/**
 * The prose of a text: no code, no addresses, no host names. A word inside a code
 * sample says nothing about what the text is about.
 */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * The terms whose reading the whole text is about: the strong words of a reading are
 * words no other reading uses, so a text that has one of them is about that reading
 * throughout. The name is then marked wherever it stands in the text.
 */
function readingsIn(scope: string, terms: MarkableTerm[]): Set<string> {
  const found = new Set<string>();
  if (!scope) return found;
  const text = prose(scope).toLowerCase();
  for (const term of terms) {
    if (!term.reading) continue;
    if (term.reading.strong.some((cue) => text.includes(cue))) found.add(term.key);
  }
  return found;
}

/**
 * Whether the weak words of a reading stand near the name. They are ordinary words —
 * "party", "gpu", "agent" — and they only tell the readings apart when they stand close
 * to the name.
 */
function readingNear(text: string, offset: number, length: number, cues: string[]): boolean {
  const start = Math.max(0, offset - READING_WINDOW);
  const end = Math.min(text.length, offset + length + READING_WINDOW);
  const window = prose(text.slice(start, end)).toLowerCase();
  return cues.some((cue) => window.includes(cue));
}

/**
 * Cut a text into the pieces that are terms and the pieces that are not. A term is only
 * a term when it stands on its own: "OpenAI" in the text is the term, "OpenAI's" is the
 * term with a possessive, and "ReopenAI" is not.
 */
function segment(text: string, terms: MarkableTerm[], present: Set<string>): Segment[] {
  const usable = markable(terms);
  if (!usable.length || !text) return [{ text, key: null, title: null }];
  // Short names are matched as they are written: "AI" would otherwise mark every "ai".
  // The "u" flag is what makes "\p{L}" a letter class at all. Without it the class holds
  // the literal letters p, {, L, } and N, and the word boundary below lets "ice" match
  // inside "office" — which is how the term ICE ended up marked in the middle of a word.
  // An ordinary word is matched as it is named as well: "NEW" is Debian's queue, and
  // "new" is a word about something else.
  const plain = usable.filter((t) => !t.ordinary);
  // A name with two readings is matched as it is written: "PT" is the Workers' Party in
  // capitals, and so is the Pacific time zone, but "pt" is never the party. "Cube" is
  // Roblox's system in capitals, and a solid with six faces in lower case.
  const buckets = [
    { list: plain.filter((t) => t.name.length < 3 || t.reading), flags: 'gu', ordinary: false },
    { list: plain.filter((t) => t.name.length >= 3 && !t.reading), flags: 'giu', ordinary: false },
    { list: usable.filter((t) => t.ordinary), flags: 'gu', ordinary: true },
  ];
  const held = new Map<string, Segment>();
  let work = text;
  for (const bucket of buckets) {
    if (!bucket.list.length) continue;
    // The longest name first, so that "Microsoft Office" wins over "Office".
    const names = bucket.list
      .slice()
      .sort(longestFirst)
      .map((t) => t.name.trim())
      .filter(Boolean);
    if (!names.length) continue;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:${names.map(escapeRegExp).join('|')})(?:['’]s)?(?![\\p{L}\\p{N}])`,
      bucket.flags,
    );
    work = work.replace(pattern, (match, offset: number, whole: string) => {
      // A possessive belongs to the term, but it is not part of its name.
      const possessive = match.match(/['’]s$/)?.[0] ?? '';
      const name = possessive ? match.slice(0, match.length - possessive.length) : match;
      const found = bucket.list.find((t) => t.name.trim().toLowerCase() === name.toLowerCase());
      // An ordinary word that is the first half of a longer name is not the term: "New"
      // in "New York" is the place, not the queue Debian files its packages in.
      if (bucket.ordinary && /^\s+[\p{Lu}]/u.test(whole.slice(offset + match.length))) return match;
      // A name with two readings is a term only where the words of its reading stand
      // near it: "PT" is the Workers' Party where the text says party, and the Pacific
      // time zone everywhere else. A text that is about the reading throughout marks it
      // wherever it stands.
      if (found?.reading && !found.scoped && !present.has(found.key)) {
        if (!readingNear(whole, offset, match.length, found.reading.weak)) return match;
      }
      const id = `\u0000${held.size}\u0000`;
      held.set(id, { text: match, key: found?.key ?? name.toLowerCase(), title: tooltip(found) });
      return id;
    });
  }
  const out: Segment[] = [];
  const pattern = /\u0000(\d+)\u0000/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(work)) !== null) {
    if (match.index > last) out.push({ text: work.slice(last, match.index), key: null, title: null });
    const heldSegment = held.get(match[0]);
    if (heldSegment) out.push(heldSegment);
    last = match.index + match[0].length;
  }
  if (last < work.length) out.push({ text: work.slice(last), key: null, title: null });
  return out;
}

/** The native tooltip: the one thing a reader gets without JavaScript. */
function tooltip(term: MarkableTerm | undefined): string | null {
  if (!term) return null;
  const text = term.description ?? term.summary ?? null;
  if (!text) return null;
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

/** The markup of one term: a button the reader can tap. */
function termButton(segment: Segment): string {
  const title = segment.title ? ` title="${escapeHtml(segment.title)}"` : '';
  return `<button type="button" class="term" data-term-key="${escapeHtml(segment.key ?? '')}"${title}>${escapeHtml(segment.text)}</button>`;
}

/**
 * Mark the terms of a plain text, so that the reader can tap them. The text is escaped
 * here and only here: what comes out of it is markup, never text that was trusted.
 *
 * The scope is the text the reading is decided by: the whole of it by default, and a
 * longer text when the terms are marked in several pieces of one page.
 */
export function markTerms(text: string, terms: MarkableTerm[], scope?: string): SafeHtml {
  const present = readingsIn(scope ?? text, terms);
  const parts = segment(text, terms, present).map((s) => (s.key ? termButton(s) : escapeHtml(s.text)));
  return new SafeHtml(parts.join(''));
}

/** The same, for a text that already is markup: the terms inside it are marked. */
export function markTermsInHtml(input: string, terms: MarkableTerm[]): string {
  const usable = markable(terms);
  if (!usable.length || !input) return input;
  const { document } = parseHTML(`<!doctype html><html><body>${input}</body></html>`);
  const body = document.body as unknown as Node;
  const present = readingsIn((body as unknown as { textContent: string }).textContent ?? '', usable);
  markNodes(body, usable, document as unknown as Document, present);
  return (document.body as unknown as { innerHTML: string }).innerHTML;
}

/** Walk the text of a fragment, and turn the terms in it into buttons. */
function markNodes(node: Node, terms: MarkableTerm[], document: Document, present: Set<string>): void {
  const children = Array.from(node.childNodes);
  for (const child of children) {
    if (child.nodeType === 3) {
      const text = child.textContent ?? '';
      const parts = segment(text, terms, present);
      if (!parts.some((p) => p.key)) continue;
      const fragment = document.createDocumentFragment();
      for (const part of parts) {
        if (!part.key) {
          fragment.appendChild(document.createTextNode(part.text));
          continue;
        }
        const button = document.createElement('button');
        button.setAttribute('type', 'button');
        button.setAttribute('class', 'term');
        button.setAttribute('data-term-key', part.key);
        if (part.title) button.setAttribute('title', part.title);
        button.textContent = part.text;
        fragment.appendChild(button);
      }
      node.replaceChild(fragment, child);
    } else if (child.nodeType === 1) {
      const tag = (child as Element).tagName?.toUpperCase();
      // A link is already something to tap; a term inside it would be a button in a link.
      if (tag === 'A' || tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE') continue;
      markNodes(child, terms, document, present);
    }
  }
}
