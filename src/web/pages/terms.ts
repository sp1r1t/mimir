import type { App } from '../../app.js';
import type { TermKind } from '../../terms/schema.js';
import { fmtDate } from '../format.js';
import { html, type SafeHtml } from '../html.js';
import { layout } from '../layout.js';

const KIND_LABEL: Record<TermKind, string> = {
  organisation: 'Organisations',
  product: 'Products',
  person: 'People',
  project: 'Projects',
  concept: 'Concepts',
  acronym: 'Acronyms',
  other: 'Other terms',
};

const KIND_ORDER: TermKind[] = ['organisation', 'product', 'person', 'project', 'concept', 'acronym', 'other'];

/**
 * The glossary: every term Mimir can explain, and where the explanation came from.
 * A term is explained once, and every story that names it afterwards reuses it.
 */
export function glossaryPage(app: App, flash?: string | null): SafeHtml {
  const terms = app.stories.glossaryWithUse();
  const kinds = KIND_ORDER.filter((k) => terms.some((t) => t.kind === k));
  const body = html`
  <article class="detail glossary-detail">
    <header>
      <h1>Glossary</h1>
      <div class="meta">
        <span class="source">${terms.length} term${terms.length === 1 ? '' : 's'} Mimir can explain</span>
      </div>
      <p class="muted">Names, concepts, and context from your reading. Tap any highlighted term in a story to see its explanation.</p>
    </header>
    ${terms.length ? html`<div class="glossary-tools">
      <label class="sr-only" for="glossary-search">Find a term</label>
      <input id="glossary-search" type="search" placeholder="Find a name, concept, or explanation" data-glossary-search>
      <p class="result-count" data-glossary-count role="status">${terms.length} terms</p>
    </div><p class="empty" data-glossary-empty hidden>No terms match your search.</p>` : null}
    ${terms.length
      ? kinds.map((kind) => html`<section class="panel glossary-section">
          <h3>${KIND_LABEL[kind]}</h3>
          <ul class="term-list">${terms.filter((t) => t.kind === kind).map((t) => html`<li class="term-entry">
            <span class="term-name">${t.name}</span>
            ${t.ordinary ? html`<span class="muted small">an ordinary word: this is what it means in the stories that use it that way</span>` : null}
            ${t.description ? html`<div class="term-desc">${t.description}</div>` : null}
            ${t.summary ? html`<div class="term-summary">${t.summary}</div>` : null}
            <div class="meta">
              ${t.sourceUrl && /^https:\/\//i.test(t.sourceUrl)
                ? html`<a class="term-source" href="${t.sourceUrl}" target="_blank" rel="noopener noreferrer">${t.sourceName ?? 'Source'}</a>`
                : html`<span class="muted small">${t.sourceName ?? 'from the articles'}</span>`}
              <span class="muted small">in ${t.stories} stor${t.stories === 1 ? 'y' : 'ies'}</span>
              <span class="muted small">added ${fmtDate(t.createdAt)}</span>
            </div>
          </li>`)}</ul>
        </section>`)
      : html`<section class="panel"><p class="muted">No glossary entries yet. Open a story and choose Explain the terms.</p></section>`}
  </article>`;
  return layout(app, { title: 'Glossary', nav: 'glossary', body, flash });
}
