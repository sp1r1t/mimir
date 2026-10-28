import type { App } from '../../app.js';
import { ARTICLE_TYPES } from '../../classification/jev.js';
import { SORT_KEYS, type ArticleFilters, type ArticleListItem, type SortKey } from '../../repo/articles.js';
import { timeEl } from '../format.js';
import { html, type SafeHtml } from '../html.js';
import { layout, type NavKey } from '../layout.js';
import { articleLinks, discoveredVia } from '../provenance.js';

type Query = Record<string, string | undefined>;

function num(v: string | undefined): number | undefined {
  if (v == null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function dateParam(v: string | undefined, endOfDay = false): string | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Date(d.getTime() + (endOfDay ? 86_400_000 : 0)).toISOString();
}

/** Number of filter and sort parameters set in a list URL (paging and flash messages excluded). */
export function activeFilterCount(q: Query): number {
  return Object.entries(q).filter(([k, v]) => v != null && v !== '' && !['page', 'size', 'flash', 'view'].includes(k)).length;
}

export function parseFilters(q: Query): ArticleFilters {
  const sort = SORT_KEYS.includes(q.sort as SortKey) ? (q.sort as SortKey) : undefined;
  const minRel = num(q.min);
  const maxRel = num(q.max);
  return {
    q: q.q?.trim() || undefined,
    sourceId: num(q.source),
    category: q.category || undefined,
    minRelevance: minRel != null ? minRel / 100 : undefined,
    maxRelevance: maxRel != null ? maxRel / 100 : undefined,
    dateField: q.date === 'published' ? 'published' : 'discovered',
    from: dateParam(q.from),
    to: dateParam(q.to, true),
    status: (['all', 'classified', 'pending', 'failed'] as const).find((s) => s === q.status) ?? 'all',
    saved: q.saved === '1',
    feedback: (['any', 'none', 'relevant', 'not_relevant', 'more', 'less'] as const).find((s) => s === q.feedback),
    articleType: q.type || undefined,
    sort,
    page: num(q.page),
    pageSize: num(q.size) ?? 50,
  };
}

export function scoreCell(label: string, value: number | null, kind: string): SafeHtml {
  const v = value == null ? null : Math.round(value * 100);
  return html`<div class="score score-${kind}" title="${label}: ${v ?? 'not classified'}${v != null ? ' / 100' : ''}">
    <span class="score-label">${label}</span>
    <span class="score-value">${v ?? '—'}</span>
    <span class="meter" aria-hidden="true"><span style="width:${v ?? 0}%"></span></span>
  </div>`;
}

export function feedbackControls(a: Pick<ArticleListItem, 'id' | 'savedAt'>): SafeHtml {
  const btn = (type: string, clear: string, active: boolean, icon: string, label: string, help: string) => html`
    <button type="submit" name="type" value="${active ? clear : type}" class="fb ${active ? 'on' : ''}"
      data-type="${type}" data-clear="${clear}" data-help="${help}" aria-label="${label}" aria-pressed="${active ? 'true' : 'false'}" title="${help}">
      <span class="fb-icon" aria-hidden="true">${icon}</span> <span class="fb-label">${label}</span></button>`;
  return html`<form class="feedback article-save" method="post" action="/articles/${a.id}/feedback" data-article="${a.id}" aria-label="Save article">
    ${btn('save', 'unsave', !!a.savedAt, a.savedAt ? '★' : '☆', a.savedAt ? 'Saved' : 'Save', 'Save for later. Tap again to unsave.')}
  </form>`;
}

export function statusBadge(a: ArticleListItem, classifierReady: boolean): SafeHtml | null {
  if (a.classificationStatus === 'pending') {
    return html`<span class="badge pending" title="Waiting for classification">${classifierReady ? 'Classification queued' : 'Pending configuration'}</span>`;
  }
  if (a.classificationStatus === 'failed') {
    return html`<span class="badge failed" title="${a.classificationError ?? ''}">Classification failed</span>`;
  }
  return null;
}

function articleCard(a: ArticleListItem, classifierReady: boolean, now: number): SafeHtml {
  const assigned = a.categories.filter((c) => c.assigned).sort((x, y) => y.probability - x.probability);
  return html`<article class="card ${a.classificationStatus}">
    <div class="card-main">
      <h2><a href="/articles/${a.id}">${a.title ?? '(untitled)'}</a></h2>
      <div class="meta">
        ${discoveredVia(a.provenance, a.sourceName)}
        <span title="Published (as claimed by the source)">Published ${timeEl(a.publishedAt, now)}</span>
        <span title="First seen by Mimir">Discovered ${timeEl(a.discoveredAt, now)}</span>
        ${a.classifiedAt ? html`<span title="Classified with profile v${a.profileVersion}">Classified ${timeEl(a.classifiedAt, now)}</span>` : null}
        ${articleLinks(a.id, a.url, a.provenance)}
      </div>
      ${a.summaryText ? html`<p class="summary">${a.summaryText.slice(0, 280)}${a.summaryText.length > 280 ? '…' : ''}</p>` : null}
      <div class="tags">
        ${statusBadge(a, classifierReady)}
        ${assigned.map((c) => html`<a class="chip" href="/articles?category=${c.id}" title="P = ${Math.round(c.probability * 100)}%">${c.label}</a>`)}
        ${a.articleType ? html`<span class="badge type">${a.articleType.replace(/_/g, ' ')}</span>` : null}
        ${a.investigate != null && a.investigate >= 0.5 ? html`<span class="badge investigate" title="Worth investigating: ${Math.round(a.investigate * 100)}%">Worth investigating</span>` : null}
        ${a.promotional != null && a.promotional >= 0.5 ? html`<span class="badge promo" title="Promotional: ${Math.round(a.promotional * 100)}%">Promotional</span>` : null}
      </div>
      ${feedbackControls(a)}
    </div>
    <div class="scores">
      ${scoreCell('Rank', a.rankScore, 'rank')}
      ${scoreCell('Relevance', a.personalRelevance, 'relevance')}
      ${scoreCell('Significance', a.significance, 'significance')}
      ${scoreCell('Urgency', a.urgency, 'urgency')}
    </div>
  </article>`;
}

export function select(name: string, current: string | undefined, options: [string, string][]): SafeHtml {
  return html`<select name="${name}" id="f-${name}">
    ${options.map(([v, l]) => html`<option value="${v}" ${v === (current ?? '') ? html`selected` : null}>${l}</option>`)}
  </select>`;
}

export function inboxPage(app: App, query: Query, flash?: string | null): SafeHtml {
  const f = parseFilters(query);
  const result = app.articles.list(f);
  const sources = app.sources.list();
  const profile = app.profiles.active();
  const classifierReady = app.classifier.isConfigured();
  const now = Date.now();

  const nav: NavKey = query.saved === '1' ? 'saved' : query.sort === 'rank_asc' ? 'review' : 'inbox';
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const pageLink = (p: number) => {
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '') as [string, string][]);
    params.set('page', String(p));
    return `/articles?${params.toString()}`;
  };
  const defaultSort = f.q ? 'match' : 'rank';

  const filters = html`<form class="filters" method="get" action="/articles">
    <div class="field grow"><label for="f-q">Search</label><input id="f-q" type="search" name="q" value="${query.q ?? ''}" placeholder="Words in title or text"></div>
    <div class="field"><label for="f-sort">Sort</label>${select('sort', query.sort ?? defaultSort, [
      ['rank', 'Rank (high → low)'],
      ['rank_asc', 'Rank (low → high)'],
      ['relevance', 'Personal relevance'],
      ['significance', 'Significance'],
      ['urgency', 'Urgency'],
      ['published', 'Publication date'],
      ['discovered', 'Discovery date'],
      ['match', 'Search match'],
    ])}</div>
    <div class="field"><label for="f-source">Source</label>${select('source', query.source, [
      ['', 'All sources'],
      ...sources.map((s) => [String(s.id), s.name] as [string, string]),
    ])}</div>
    <div class="field"><label for="f-category">Category</label>${select('category', query.category, [
      ['', 'All categories'],
      ...profile.definition.topics.map((t) => [t.id, t.label] as [string, string]),
    ])}</div>
    <div class="field small"><label for="f-min">Relevance ≥</label><input id="f-min" type="number" min="0" max="100" name="min" value="${query.min ?? ''}" placeholder="0"></div>
    <div class="field small"><label for="f-max">Relevance ≤</label><input id="f-max" type="number" min="0" max="100" name="max" value="${query.max ?? ''}" placeholder="100"></div>
    <div class="field"><label for="f-date">Date</label>${select('date', query.date, [
      ['discovered', 'Discovered'],
      ['published', 'Published'],
    ])}</div>
    <div class="field"><label for="f-from">From</label><input id="f-from" type="date" name="from" value="${query.from ?? ''}"></div>
    <div class="field"><label for="f-to">To</label><input id="f-to" type="date" name="to" value="${query.to ?? ''}"></div>
    <div class="field"><label for="f-status">Classification</label>${select('status', query.status, [
      ['all', 'Any'],
      ['classified', 'Classified'],
      ['pending', 'Pending'],
      ['failed', 'Failed'],
    ])}</div>
    <div class="field"><label for="f-type">Type</label>${select('type', query.type, [
      ['', 'Any type'],
      ...Object.keys(ARTICLE_TYPES).map((t) => [t, t.replace(/_/g, ' ')] as [string, string]),
    ])}</div>
    <div class="field"><label for="f-feedback">Feedback</label>${select('feedback', query.feedback, [
      ['', 'Any'],
      ['none', 'No feedback yet'],
      ['any', 'Has feedback'],
      ['relevant', 'Marked relevant'],
      ['not_relevant', 'Marked not relevant'],
      ['more', 'More like this'],
      ['less', 'Less like this'],
    ])}</div>
    ${query.saved === '1' ? html`<input type="hidden" name="saved" value="1">` : null}
    <div class="field actions"><button type="submit">Apply</button> <a href="/articles" class="button secondary">Reset</a></div>
  </form>`;

  const body = html`
    <details class="filters-wrap">
      <summary>Filters${activeFilterCount(query) ? html` <span class="muted">&middot; ${activeFilterCount(query)} active</span>` : null}</summary>
      ${filters}
    </details>
    <p class="result-count">${result.total} article${result.total === 1 ? '' : 's'}
      ${f.minRelevance == null && f.maxRelevance == null && f.status === 'all' ? ' · all scores shown, including low-scoring and unclassified' : null}
      · <a href="/articles?sort=rank_asc&status=classified">Review the lowest-ranked</a></p>
    <div class="list">
      ${result.items.length ? result.items.map((a) => articleCard(a, classifierReady, now)) : html`<p class="empty">No articles match these filters yet.</p>`}
    </div>
    ${pages > 1
      ? html`<nav class="pager">
          ${result.page > 1 ? html`<a href="${pageLink(result.page - 1)}">← Previous</a>` : null}
          <span>Page ${result.page} of ${pages}</span>
          ${result.page < pages ? html`<a href="${pageLink(result.page + 1)}">Next →</a>` : null}
        </nav>`
      : null}`;
  const title = f.q ? `Search: ${f.q}` : nav === 'saved' ? 'Saved' : nav === 'review' ? 'Low scores' : 'Inbox';
  return layout(app, { title, nav, body, flash });
}
