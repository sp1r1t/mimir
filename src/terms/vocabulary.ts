import type { DB } from '../db/database.js';

/** How often a word occurs in the news, and how often it is written in lower case. */
export interface WordCount {
  total: number;
  lower: number;
}

/** A name has to be seen this often before the news can say what kind of word it is. */
export const ORDINARY_MIN_OCCURRENCES = 10;
/** The share of the occurrences that are written in lower case. */
export const ORDINARY_LOWER_SHARE = 0.5;
/**
 * A name of one or two letters is never an ordinary word. "AI", "X" and "PT" are
 * names, and a letter of the alphabet is not a word the news writes about.
 */
export const ORDINARY_MIN_LENGTH = 3;

/**
 * The prose of the news: no code, no addresses, no host names. A word inside a code
 * sample is not a word of the news — "return_tensors=pt" says nothing about the
 * Brazilian Workers' Party.
 */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, ' ')
    .replace(/\b[\w-]+\.(?:com|org|net|io|dev|ai|co|gov|edu|info|me|app)\b/gi, ' ');
}

/** Every text of a stored brief, whatever shape it has. */
function textsOf(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => textsOf(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => textsOf(v, out));
}

/**
 * Count the words of the news: the headlines, the teasers the feeds carry, and the
 * briefs Mimir wrote. The full text of an article is left out on purpose: it holds code
 * samples and shell transcripts, where every word is written in lower case.
 */
export function countWords(db: DB): Map<string, WordCount> {
  const counts = new Map<string, WordCount>();
  const bump = (key: string, lower: boolean): void => {
    const c = counts.get(key) ?? { total: 0, lower: 0 };
    c.total += 1;
    if (lower) c.lower += 1;
    counts.set(key, c);
  };
  const scan = (text: string): void => {
    const words = prose(text).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
    for (let i = 0; i < words.length; i++) {
      const word = words[i] as string;
      const low = word.toLowerCase();
      bump(low, word === low);
      const next = words[i + 1];
      if (next !== undefined) {
        bump(`${low} ${next.toLowerCase()}`, word === low && next === next.toLowerCase());
      }
    }
  };
  for (const a of db.prepare('SELECT title, summary_text FROM articles').all() as {
    title: string | null;
    summary_text: string | null;
  }[]) {
    scan(`${a.title ?? ''}\n${a.summary_text ?? ''}`);
  }
  for (const row of db.prepare('SELECT content FROM story_summaries').all() as { content: string }[]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.content);
    } catch {
      continue;
    }
    const texts: string[] = [];
    textsOf(parsed, texts);
    for (const text of texts) scan(text);
  }
  return counts;
}

/**
 * The names that are ordinary words in this news: the news writes them in lower case
 * most of the time, so they are words and not names. "NEW" is Debian's incoming queue
 * in one story and the opposite of old in all the others; "Office" is Microsoft Office
 * in one story and a room in all the others.
 *
 * A name of two letters or fewer is never one of them.
 */
export function ordinaryNames(counts: Map<string, WordCount>, names: { key: string; name: string }[]): Set<string> {
  const out = new Set<string>();
  for (const term of names) {
    const name = term.name.trim();
    if (name.length < ORDINARY_MIN_LENGTH) continue;
    const key = name.toLowerCase().replace(/\s+/g, ' ');
    const count = counts.get(key);
    if (!count || count.total < ORDINARY_MIN_OCCURRENCES) continue;
    if (count.lower >= count.total * ORDINARY_LOWER_SHARE) out.add(term.key);
  }
  return out;
}
