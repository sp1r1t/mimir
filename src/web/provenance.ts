import type { ArticleProvenance } from '../repo/provenance.js';
import { html, type SafeHtml } from './html.js';

export function discoveredVia(entries: ArticleProvenance[], fallback: string | null): SafeHtml {
  return html`<span class="discovery">Discovered via ${entries.length ? entries.map((e, i) => html`${i ? ', ' : ''}${e.sourceId != null
    ? html`<a href="/sources/${e.sourceId}">${e.sourceName ?? 'feed'}</a>`
    : e.sourceName ?? 'deleted source'}`) : fallback ?? 'deleted source'}</span>`;
}

export function articleLinks(id: number, url: string | null, entries: ArticleProvenance[]): SafeHtml {
  const discussions = entries.filter((e, i) => e.discussionUrl && entries.findIndex((other) => other.discussionUrl === e.discussionUrl) === i);
  return html`<span class="article-links">
    ${url ? html`<a href="/go/${id}" target="_blank" rel="noopener noreferrer" class="ext">Original ↗</a>` : null}
    ${discussions.map((e) => html`<a href="${e.discussionUrl}" target="_blank" rel="noopener noreferrer" class="ext"
      aria-label="${e.sourceName ?? 'Source'} discussion" title="Discussion via ${e.sourceName ?? 'source'}">${discussions.length > 1 ? `${e.sourceName ?? 'Source'} discussion` : 'Discussion'} ↗</a>`)}
  </span>`;
}
