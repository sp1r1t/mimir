/**
 * Does an encyclopedia article explain a term the way the story uses it?
 *
 * A name is often two things. "Dawn" is the hour before sunrise and Chromium's WebGPU
 * implementation; "A2A" is an Italian utility and Google's protocol for agents to talk
 * to each other; "Okta" is a scale for cloud cover and a company that sells logins.
 * The encyclopedia answers with the article whose title matches the name, and the reader
 * is then told something that has nothing to do with the story.
 *
 * The story knows which of the two it means: every term the model names comes with a
 * note about what it is in these articles ("Chromium's WebGPU implementation"). The
 * article has to agree with that note, or it is not an answer.
 */

/** The words that carry the meaning of a text: no "the", no "of", no "and". */
const STOP = new Set(
  [
    'the', 'and', 'that', 'this', 'these', 'those', 'there', 'their', 'they', 'them',
    'for', 'from', 'with', 'without', 'within', 'into', 'onto', 'over', 'under', 'about',
    'which', 'while', 'whose', 'whom', 'whose', 'when', 'where', 'what', 'who', 'how',
    'was', 'were', 'are', 'is', 'be', 'been', 'being', 'has', 'have', 'had', 'did',
    'does', 'do', 'not', 'but', 'and', 'also', 'its', 'it', 'his', 'her', 'our', 'your',
    'their', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'such', 'some', 'any', 'all', 'each', 'every', 'more', 'most', 'less', 'least',
    'than', 'then', 'so', 'as', 'at', 'by', 'in', 'of', 'on', 'to', 'or', 'if', 'up',
    'out', 'off', 'over', 'own', 'same', 'other', 'another', 'used', 'using', 'use',
    'known', 'known', 'includes', 'including', 'include', 'based', 'called', 'means',
    'refers', 'known', 'given', 'made', 'makes', 'make', 'used', 'often', 'usually',
    'became', 'becomes', 'remain', 'remains', 'part', 'parts', 'kind', 'sort', 'type',
  ].map((w) => w.toLowerCase()),
);

/**
 * English function words. A note written in another language cannot be compared with
 * an English article, so the comparison is only made when both are in English.
 */
const ENGLISH_MARKERS = new Set(
  ['the', 'of', 'and', 'for', 'whose', 'with', 'that', 'this', 'from', 'into', 'a', 'an',
    'in', 'on', 'to', 'by', 'as', 'at', 'or', 'is', 'are', 'was', 'were', 'be', 'been',
    'has', 'have', 'its', 'it', 'which', 'while', 'when', 'where', 'their', 'they',
    'used', 'using', 'called', 'based', 'part', 'known', 'one', 'also', 'not', 'but'],
);

/** The words of a text that carry its meaning. */
export function contentWords(text: string | null | undefined): string[] {
  if (!text) return [];
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const word of words) {
    if (word.length < 3) continue;
    if (STOP.has(word)) continue;
    out.push(stem(word));
  }
  return out;
}

/** A word without its plural ending, so that "agent" and "agents" are one word. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Whether a text reads as English: it uses the English function words. */
export function readsEnglish(text: string | null | undefined): boolean {
  if (!text) return false;
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const word of words) if (ENGLISH_MARKERS.has(word)) return true;
  return false;
}

/**
 * Whether an article agrees with the note the story made about the term.
 *
 * A note in another language, or no note at all, says nothing: the article is taken as
 * it is. An English note and an English article that share no word mean two different
 * things: the article is not an answer to this term.
 */
export function fitsRole(
  article: { description?: string | null; extract?: string | null } | null,
  role: string | null | undefined,
): boolean {
  if (!article) return false;
  const note = (role ?? '').trim();
  if (!note) return true;
  if (!readsEnglish(note)) return true;
  const wanted = new Set(contentWords(note));
  if (!wanted.size) return true;
  const has = new Set(contentWords(`${article.description ?? ''} ${article.extract ?? ''}`));
  for (const word of has) if (wanted.has(word)) return true;
  return false;
}

/**
 * Whether the article agrees with the note so plainly that the encyclopedia may answer
 * on its own.
 *
 * Nothing in common means the article is about another thing altogether. One shared
 * word is not agreement either, when the note says more: "Cube root" and "Roblox's
 * generative AI system" both talk about a system, and a reader told that a solid with
 * six faces is Roblox's model learns nothing at all. Two shared words are agreement
 * enough; anything less is put to the model, which has read the articles and knows
 * which of the two the story means.
 */
export function clearFit(
  article: { description?: string | null; extract?: string | null } | null,
  role: string | null | undefined,
): boolean {
  if (!article) return false;
  const note = (role ?? '').trim();
  if (!note) return true;
  if (!readsEnglish(note)) return true;
  const wanted = new Set(contentWords(note));
  const has = new Set(contentWords(`${article.description ?? ''} ${article.extract ?? ''}`));
  let shared = 0;
  for (const word of wanted) if (has.has(word)) shared++;
  // The article and the note do not even touch.
  if (!shared) return false;
  // A note of one word says too little to compare: the article stands.
  if (wanted.size < 2) return true;
  return shared >= 2;
}
