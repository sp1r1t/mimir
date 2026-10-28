/**
 * Term handling for story candidate retrieval. Normalization mirrors the FTS5
 * `unicode61 remove_diacritics 2` tokenizer so terms can be looked up in articles_fts_vocab.
 */

const STOPWORDS = new Set(
  (
    // English
    'the and for are but not you all any can had her was one our out has have him his how its may new now old see two who boy did ' +
    'man men get got let put say she too use way about above after again against also among because been before being below ' +
    'between both could does doing down during each from further here into just more most much must only other over same should ' +
    'some such than that their them then there these they this those through under until very were what when where which while ' +
    'will with would your yours says said year years week weeks today first last next back make made makes like into amid ' +
    'news report reports update updates live latest new via how why what video watch read podcast episode ' +
    // German
    'der die das den dem des ein eine einer eines einem einen und oder aber nicht mit von vom zum zur bei aus auf für fur ' +
    'ist sind war wird werden wurde hat haben nach über uber unter vor wie als auch noch nur sich sie ihr ihre sein seine ' +
    'dass mehr beim durch gegen ohne heute jahr jahre neue neuer neues'
  ).split(/\s+/),
);

/** Lowercase, strip diacritics, split on anything that is not a letter or digit. */
export function rawTerms(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Content terms: no stopwords, no one- or two-letter words (short numbers and versions are kept). */
export function contentTerms(text: string | null | undefined): string[] {
  return rawTerms(text).filter((t) => (t.length >= 3 || (/\d/.test(t) && t.length >= 2)) && !STOPWORDS.has(t));
}

/** Title fingerprint for exact-duplicate detection across publishers. */
export function titleKey(title: string | null | undefined): string {
  return contentTerms(title).join(' ');
}

/** FTS5 query matching any of the terms in title or summary. Terms are quoted, so input cannot inject syntax. */
export function anyTermQuery(terms: string[]): string | null {
  if (!terms.length) return null;
  return `{title summary_text} : (${terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')})`;
}

/** Publisher identity for distinct-publisher counts: the article host without common prefixes. */
export function publisherOf(url: string | null, fallback: string | null): string {
  if (url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host.replace(/^(www\d*|m|amp|mobile|feeds?|rss)\./, '');
    } catch {
      // fall through
    }
  }
  return (fallback ?? 'unknown').toLowerCase();
}
