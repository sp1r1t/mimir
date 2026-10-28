import type { App } from '../../app.js';
import { recency } from '../../stories/assessment.js';
import type { Priority } from '../../profile/schema.js';
import {
  STORY_SORTS,
  type PlacesState,
  type StoryDetail,
  type StoryFilters,
  type StoryListItem,
  type StoryMember,
  type StoryPlace,
  type StorySort,
  type SummaryState,
  type TermsState,
  type StoryTerm,
} from '../../stories/repository.js';
import {
  CLAIM_SECTIONS,
  isBrief,
  LEGACY_CLAIM_SECTIONS,
  type LegacySummaryContent,
  type SummaryClaim,
} from '../../summaries/summary.js';
import type { TermKind } from '../../terms/schema.js';
import { fmtDate, pct, relative, timeEl } from '../format.js';
import { html, raw, type SafeHtml } from '../html.js';
import { layout } from '../layout.js';
import { articleLinks, discoveredVia } from '../provenance.js';
import { markTerms } from '../terms.js';
import { feedbackControls, scoreCell, select, activeFilterCount } from './inbox.js';

type Query = Record<string, string | undefined>;

function num(v: string | undefined): number | undefined {
  if (v == null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseStoryFilters(q: Query): StoryFilters {
  const minRel = num(q.min);
  const minSig = num(q.sig);
  return {
    q: q.q?.trim() || undefined,
    category: q.category || undefined,
    minRelevance: minRel != null ? minRel / 100 : undefined,
    minSignificance: minSig != null ? minSig / 100 : undefined,
    minPublishers: num(q.publishers),
    days: num(q.days),
    state: q.state === 'new' || q.state === 'developing' ? q.state : undefined,
    summary: (['ready', 'stale', 'none', 'pending', 'failed'] as const).find((s) => s === q.summary),
    seen: q.seen === 'unseen' || q.seen === 'seen' ? q.seen : undefined,
    saved: q.saved === 'saved' || q.saved === 'unsaved' ? q.saved : undefined,
    sort: STORY_SORTS.includes(q.sort as StorySort) ? (q.sort as StorySort) : undefined,
    page: num(q.page),
    pageSize: num(q.size) ?? 30,
  };
}

/** Quick views: each is a plain set of filter parameters, so the filter box shows and adjusts it. */
export const RELEVANT_NEW: Query = { min: '70', sort: 'latest', seen: 'unseen', days: '7' };
export const SEEN_VIEW: Query = { seen: 'seen', sort: 'latest' };
export const SAVED_VIEW: Query = { saved: 'saved', sort: 'latest' };
const NON_FILTER_KEYS = new Set(['page', 'size', 'flash', 'view']);

function filterEntries(q: Query): [string, string][] {
  return Object.entries(q).filter(([k, v]) => v != null && v !== '' && !NON_FILTER_KEYS.has(k)) as [string, string][];
}

/** The start page shows relevant new stories; any explicit filter, or view=all, replaces that default. */
export function resolveStoryQuery(q: Query): Query {
  if (filterEntries(q).length || q.view === 'all') return q;
  return { ...q, ...RELEVANT_NEW };
}

function activeView(q: Query): 'relevant' | 'all' | 'seen' | 'saved' | null {
  const entries = filterEntries(q);
  const matches = (preset: Query) => entries.length === Object.keys(preset).length && entries.every(([k, v]) => preset[k] === v);
  if (matches(RELEVANT_NEW)) return 'relevant';
  if (matches(SEEN_VIEW)) return 'seen';
  if (matches(SAVED_VIEW)) return 'saved';
  return entries.length === 0 && q.view === 'all' ? 'all' : null;
}

/** Stories matching the "relevant new" quick view; shown as the count on its tab. */
export function relevantNewCount(app: App): number {
  return app.stories.list({ ...parseStoryFilters(RELEVANT_NEW), pageSize: 1 }).total;
}

/** A check mark pinned to the top-right corner of its card or header. */
function seenButton(s: Pick<StoryListItem, 'id' | 'unseen'>): SafeHtml {
  const seen = !s.unseen;
  return html`<form class="seen-form seen-corner" method="post" action="/stories/${s.id}/seen" data-story="${s.id}">
    <button type="submit" name="state" value="${seen ? 'unseen' : 'seen'}" class="seen-btn ${seen ? 'on' : ''}" aria-pressed="${seen ? 'true' : 'false'}"
      title="${seen ? 'Seen. Click to mark it as unseen.' : 'Mark as seen. It comes back as new if the story develops.'}">
      <span class="seen-icon" aria-hidden="true">&#10003;</span><span class="seen-label sr-only">${seen ? 'Seen' : 'Mark seen'}</span>
    </button>
  </form>`;
}

function storyFeedback(s: StoryDetail): SafeHtml {
  const button = (type: 'relevant' | 'not_relevant', icon: string, label: string) => {
    const active = s.relevanceLabel === type;
    const help = `Mark this story as ${label.toLowerCase()} to you. Tap again to clear.`;
    return html`<button type="submit" name="type" value="${active ? 'clear_relevance' : type}" class="fb ${active ? 'on' : ''}"
      data-type="${type}" data-clear="clear_relevance" data-help="${help}" title="${help}" aria-label="${label}" aria-pressed="${active ? 'true' : 'false'}">
      <span class="fb-icon" aria-hidden="true">${icon}</span><span class="fb-label">${label}</span></button>`;
  };
  return html`<form class="feedback feedback-compact story-feedback" method="post" action="/stories/${s.id}/feedback" data-story="${s.id}" aria-label="Story relevance">
    ${button('relevant', '✓', 'Relevant')}${button('not_relevant', '✗', 'Not relevant')}
  </form>`;
}

/**
 * The star that keeps a story with the reader. The same button works on a card and on the
 * story page; the label is only shown where there is room for it.
 */
const SAVED_HELP = 'Saved. Tap to let it go.';
const UNSAVED_HELP = 'Save this story so you can find it again.';

function storySave(s: Pick<StoryListItem, 'id' | 'savedAt'>, labelled = false): SafeHtml {
  const saved = !!s.savedAt;
  const help = saved ? SAVED_HELP : UNSAVED_HELP;
  return html`<form class="feedback feedback-compact story-save ${labelled ? 'labelled' : ''}" method="post" action="/stories/${s.id}/save"
    data-story="${s.id}" aria-label="Save story">
    <button type="submit" name="type" value="${saved ? 'unsave' : 'save'}" class="fb ${saved ? 'on' : ''}"
      data-type="save" data-clear="unsave" data-help="${help}" data-help-saved="${SAVED_HELP}" data-help-unsaved="${UNSAVED_HELP}"
      title="${help}" aria-label="${saved ? 'Saved' : 'Save'}" aria-pressed="${saved ? 'true' : 'false'}">
      <span class="fb-icon" aria-hidden="true">${saved ? '★' : '☆'}</span><span class="fb-label">${saved ? 'Saved' : 'Save'}</span></button>
  </form>`;
}

const SUMMARY_BADGE: Record<SummaryState, [string, string] | null> = {
  none: null,
  pending: ['pending', 'Brief queued'],
  running: ['pending', 'Writing the brief'],
  ready: ['investigate', 'Brief'],
  stale: ['pending', 'Brief outdated'],
  failed: ['failed', 'Brief failed'],
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** New: one development, first reported within a day. Developing: an update within two days. */
function lifecycle(s: StoryListItem, now: number): 'new' | 'developing' | null {
  if (s.developmentCount === 1 && s.firstPublishedAt && now - Date.parse(s.firstPublishedAt) < 86_400_000) return 'new';
  if (s.developmentCount > 1 && s.latestDevelopmentAt && now - Date.parse(s.latestDevelopmentAt) < 2 * 86_400_000) return 'developing';
  return null;
}

function storyBadges(s: StoryListItem, now: number): SafeHtml {
  const life = lifecycle(s, now);
  const summary = SUMMARY_BADGE[s.summaryState];
  return html`${s.unseen && s.seenAt ? html`<span class="badge developing" data-new-dev title="You marked this story seen before its latest development">New development</span>` : null}
    ${life === 'new' ? html`<span class="badge new">New</span>` : life === 'developing' ? html`<span class="badge developing">Developing</span>` : null}
    ${summary ? html`<span class="badge ${summary[0]}" title="${s.summaryError ?? ''}">${summary[1]}</span>` : null}`;
}

/** How important each topic is to the reader, from the active profile's topic priorities and ranking weights. */
interface TopicImportance {
  priority(id: string): Priority;
  weight(id: string): number;
}

function topicImportance(app: App): TopicImportance {
  const profile = app.profiles.active().definition;
  const priorities = new Map(profile.topics.map((t) => [t.id, t.priority]));
  return {
    priority: (id) => priorities.get(id) ?? 'normal',
    weight: (id) => profile.ranking.priorityWeights[priorities.get(id) ?? 'normal'],
  };
}

/** One scrolling line: status badges first, then topics ordered by probability times the topic's priority in the profile. */
function tagRow(s: StoryListItem, now: number, topics: TopicImportance): SafeHtml {
  const cats = s.categories
    .map((c) => ({ ...c, prio: topics.priority(c.id), score: c.probability * topics.weight(c.id) }))
    .sort((a, b) => b.score - a.score);
  return html`<div class="chip-row tags-row">
    ${storyBadges(s, now)}
    ${s.priority == null ? html`<span class="badge pending">Awaiting classification</span>` : null}
    ${cats.map((c) => html`<a class="chip prio-${c.prio}" href="/?category=${c.id}" title="${c.label}: ${pct(c.probability)}% match, ${c.prio} priority in your profile">${c.label}</a>`)}
  </div>`;
}

/** One scrolling line of publishers: who reported it first, then who else covers it, most recent first. */
function publisherRow(s: StoryListItem, now: number): SafeHtml | null {
  if (!s.publishers.length) return null;
  return html`<div class="chip-row pubs" aria-label="Publishers">
    ${s.publishers.map((p) => html`<a class="pub ${p.origin ? 'origin' : ''}" href="/stories/${s.id}#a-${p.articleId}"
      title="${p.origin ? 'First report' : 'Also reported'}: ${p.publisher}${p.articles > 1 ? `, ${p.articles} articles` : ''}, latest ${relative(p.latestAt, now)}">${p.publisher}${p.articles > 1 ? html`<span class="n">&times;${p.articles}</span>` : null}</a>`)}
  </div>`;
}

function storyCard(s: StoryListItem, now: number, topics: TopicImportance): SafeHtml {
  return html`<article class="card story ${s.unseen ? 'unseen' : 'seen'}" data-story="${s.id}">
    ${seenButton(s)}
    <div class="card-main">
      <h2><a href="/stories/${s.id}">${s.summaryHeadline ?? s.headline}</a></h2>
      <div class="meta">
        ${storySave(s)}
        <span title="Earliest publication in this story">First reported ${timeEl(s.firstPublishedAt, now)}</span>
        ${s.developmentCount > 1 ? html`<span title="Publication of the latest meaningful update">Updated ${timeEl(s.latestDevelopmentAt, now)}</span>` : null}
        ${s.latestPublishedAt !== s.latestDevelopmentAt ? html`<span title="Most recent article in this story">Latest coverage ${timeEl(s.latestPublishedAt, now)}</span>` : null}
      </div>
      ${publisherRow(s, now)}
      ${s.leadSummary ? html`<p class="summary">${s.leadSummary.slice(0, 280)}${s.leadSummary.length > 280 ? '...' : ''}</p>` : null}
      ${tagRow(s, now, topics)}
    </div>
    <div class="scores">
      ${scoreCell('Priority', s.priority, 'rank')}
      ${scoreCell('Relevance', s.personalRelevance, 'relevance')}
      ${scoreCell('Significance', s.significance, 'significance')}
      ${scoreCell('Urgency', s.urgency, 'urgency')}
    </div>
  </article>`;
}

export function storiesPage(app: App, query: Query, flash?: string | null): SafeHtml {
  const f = parseStoryFilters(query);
  const result = app.stories.list(f);
  const profile = app.profiles.active();
  const counts = app.stories.counts();
  const now = Date.now();
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const pageLink = (p: number) => {
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '') as [string, string][]);
    params.set('page', String(p));
    return `/?${params.toString()}`;
  };

  const filters = html`<form class="filters" method="get" action="/">
    <div class="field grow"><label for="f-q">Search</label><input id="f-q" type="search" name="q" value="${query.q ?? ''}" placeholder="Words in any article of the story"></div>
    <div class="field"><label for="f-sort">Sort</label>${select('sort', query.sort ?? 'priority', [
      ['priority', 'Priority'],
      ['relevance', 'Personal relevance'],
      ['significance', 'Significance'],
      ['urgency', 'Urgency'],
      ['latest', 'Latest development'],
      ['newest', 'First reported'],
      ['coverage', 'Publishers'],
    ])}</div>
    <div class="field"><label for="f-days">Period</label>${select('days', query.days, [
      ['', 'Any time'],
      ['1', 'Last 24 hours'],
      ['3', 'Last 3 days'],
      ['7', 'Last 7 days'],
      ['30', 'Last 30 days'],
    ])}</div>
    <div class="field"><label for="f-seen">Seen</label>${select('seen', query.seen, [
      ['', 'Any'],
      ['unseen', 'Unseen or updated'],
      ['seen', 'Seen'],
    ])}</div>
    <div class="field"><label for="f-saved">Saved</label>${select('saved', query.saved, [
      ['', 'Any'],
      ['saved', 'Saved'],
      ['unsaved', 'Not saved'],
    ])}</div>
    <div class="field"><label for="f-state">Status</label>${select('state', query.state, [
      ['', 'Any'],
      ['new', 'New'],
      ['developing', 'Developing'],
    ])}</div>
    <div class="field"><label for="f-category">Category</label>${select('category', query.category, [
      ['', 'All categories'],
      ...profile.definition.topics.map((t) => [t.id, t.label] as [string, string]),
    ])}</div>
    <div class="field small"><label for="f-min">Relevance &gt;=</label><input id="f-min" type="number" min="0" max="100" name="min" value="${query.min ?? ''}" placeholder="0"></div>
    <div class="field small"><label for="f-sig">Significance &gt;=</label><input id="f-sig" type="number" min="0" max="100" name="sig" value="${query.sig ?? ''}" placeholder="0"></div>
    <div class="field"><label for="f-publishers">Publishers</label>${select('publishers', query.publishers, [
      ['', 'Any'],
      ['2', '2 or more'],
      ['3', '3 or more'],
      ['5', '5 or more'],
    ])}</div>
    <div class="field"><label for="f-summary">Brief</label>${select('summary', query.summary, [
      ['', 'Any'],
      ['ready', 'Available'],
      ['stale', 'Outdated'],
      ['pending', 'Queued or generating'],
      ['failed', 'Failed'],
      ['none', 'None'],
    ])}</div>
    <div class="field actions"><button type="submit">Apply</button> <a href="/" class="button secondary">Reset</a></div>
  </form>`;

  const topics = topicImportance(app);
  const view = activeView(query);
  const tab = (key: 'relevant' | 'all' | 'seen' | 'saved', href: string, label: string, count?: number) =>
    html`<a href="${href}" class="qv ${view === key ? 'active' : ''}" ${view === key ? html`aria-current="page"` : null}>${label}${count != null ? html` <span class="count" data-qv-count="${key}">${count}</span>` : null}</a>`;
  const body = html`
    <nav class="quick-views" aria-label="Quick views">
      ${tab('relevant', '/', 'Relevant new', relevantNewCount(app))}
      ${tab('all', '/?view=all', 'All stories')}
      ${tab('seen', `/?${new URLSearchParams(SEEN_VIEW as Record<string, string>)}`, 'Seen')}
      ${tab('saved', `/?${new URLSearchParams(SAVED_VIEW as Record<string, string>)}`, 'Saved stories', app.stories.list({ ...parseStoryFilters(SAVED_VIEW), pageSize: 1 }).total)}
    </nav>
    <details class="filters-wrap">
      <summary>Filters${activeFilterCount(query) ? html` <span class="muted">&middot; ${activeFilterCount(query)} active</span>` : null}</summary>
      ${filters}
    </details>
    <p class="result-count"><span data-total>${result.total}</span> <span data-total-noun>${result.total === 1 ? 'story' : 'stories'}</span>${counts.unassigned ? html` &middot; ${counts.unassigned} articles not yet grouped` : null}</p>
    ${f.seen === 'unseen' && result.total > 1
      ? html`<form method="post" action="/stories/seen-all" class="mark-all" data-confirm="Mark all ${result.total} stories matching these filters as seen?">
          <input type="hidden" name="query" value="${new URLSearchParams(filterEntries(query)).toString()}">
          <button type="submit" class="secondary small">Mark all ${result.total} as seen</button>
        </form>`
      : null}
    <div class="list" data-seen-filter="${f.seen ?? ''}" data-saved-filter="${f.saved ?? ''}">
      ${result.items.length
        ? result.items.map((s) => storyCard(s, now, topics))
        : f.seen === 'unseen'
          ? html`<p class="empty">You're all caught up. <a href="/?view=all">Browse all stories</a></p>`
          : f.seen === 'seen'
            ? html`<p class="empty">No stories marked as seen.</p>`
            : f.saved === 'saved'
              ? html`<p class="empty">No stories saved yet. Tap the star on a story to keep it here.</p>`
              : html`<p class="empty">No stories match these filters yet.</p>`}
    </div>
    ${pages > 1
      ? html`<nav class="pager">
          ${result.page > 1 ? html`<a href="${pageLink(result.page - 1)}">Previous</a>` : null}
          <span>Page ${result.page} of ${pages}</span>
          ${result.page < pages ? html`<a href="${pageLink(result.page + 1)}">Next</a>` : null}
        </nav>`
      : null}`;
  return layout(app, { title: f.q ? `Stories: ${f.q}` : 'Stories', nav: 'stories', body, flash });
}

// ---- Detail ----------------------------------------------------------------------------

const STATUS_LABEL: Record<SummaryClaim['status'], string> = {
  established: 'Established',
  reported: 'Single report',
  claimed: 'Unverified claim',
  disputed: 'Disputed',
};

const SECTION_TITLE: Record<(typeof CLAIM_SECTIONS)[number], string> = {
  gist: 'The gist',
  new_since: "What's new",
  key_developments: 'Key developments',
  context_significance: 'Context and significance',
  perspectives: 'Perspectives and disagreements',
  whats_next: "What's next",
};

const LEGACY_SECTION_TITLE: Record<(typeof LEGACY_CLAIM_SECTIONS)[number], string> = {
  what_happened: 'What happened',
  why_it_matters: 'Why it matters',
  key_facts: 'Key facts',
  developments: 'Developments',
  implications: 'Implications',
};

function cite(ids: number[], index: Map<number, number>): SafeHtml {
  return html`${ids.map((id) => html`<a class="cite" href="#a-${id}" title="Article ${id}">[${index.get(id) ?? id}]</a>`)}`;
}

/** The numbers the citations use: the timeline's own, in publish order. */
function timelineIndex(s: StoryDetail): Map<number, number> {
  return new Map(s.members.map((m, i) => [m.articleId, i + 1]));
}

/**
 * How long ago something happened, in the words the counter shows: "42s", "1m 05s",
 * "1h 03m".
 */
export function elapsedLabel(since: string | null, now: number): string | null {
  if (!since) return null;
  const ms = now - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/**
 * The seconds counter next to the writing badge. The start time comes from the server,
 * so the count stays right when the page puts a fresh story in place of the old one;
 * the browser counts the seconds from there.
 */
function writeCounter(since: string | null, now: number, what: string): SafeHtml | null {
  const label = elapsedLabel(since, now);
  if (label == null) return null;
  return html`<span class="write-counter" data-elapsed-since="${since}" data-elapsed-now="${new Date(now).toISOString()}" data-elapsed-what="${what}">${label}</span>`;
}

function summaryPanel(app: App, s: StoryDetail, now: number): SafeHtml {
  const provider = app.summaries;
  const configured = provider.isConfigured();
  const running = s.summaryState === 'running';
  const waiting = s.summaryState === 'pending';
  const glossary = app.stories.glossary();
  const budget = app.storyPipeline.automaticSummaryBudget();
  const appLimited = waiting && (s.summaryError === 'Daily limit for automatic summaries reached'
    || s.summaryError?.startsWith('Mimir automatic-summary limit reached'));
  const waitReason = appLimited
    ? `Mimir's automatic-summary limit is reached (${budget.used}/${budget.limit} provider attempts in the past 24 hours, including retries). This is separate from the MiniMax plan allowance.`
    : s.summaryError;
  const action = html`<form method="post" action="/stories/${s.id}/summary" class="inline" data-story-action="summary">
    <button type="submit" class="${s.summary ? 'secondary' : ''}" ${configured && !running ? null : html`disabled`}>${running ? 'Writing…' : waiting ? 'Write now' : s.summaryState === 'failed' ? 'Retry the brief' : s.summary ? 'Rewrite the brief' : 'Write the brief'}</button>
  </form>`;
  const status =
    s.summaryState === 'pending'
      ? html`<p class="badge-line"><span class="badge pending">Queued</span> ${writeCounter(s.summaryRequestedAt, now, 'Waiting for the model')} ${waitReason ? html`<span class="muted">${waitReason}</span>` : null}</p>
          ${appLimited && budget.resumesAt ? html`<p class="muted small">Automatic capacity begins returning ${timeEl(budget.resumesAt, now)} (${fmtDate(budget.resumesAt)}).</p>` : null}
          <p class="muted small">Write now moves this request to the front and bypasses Mimir's automatic limit. Provider allowance checks still apply.</p>`
      : s.summaryState === 'running'
        ? html`<p class="badge-line"><span class="badge pending">Writing</span> ${writeCounter(s.summaryStartedAt, now, 'Writing the brief')}</p>`
        : s.summaryState === 'failed'
          ? html`<p class="error-text">Writing failed: ${s.summaryError ?? 'unknown error'}</p>`
          : s.summaryState === 'stale'
            ? html`<p class="badge-line"><span class="badge pending">Outdated</span> <span class="muted">The story has developed since this brief was written.</span></p>`
            : null;
  if (!s.summary) {
    return html`<section class="panel">
      <h3>Story Intelligence Brief</h3>
      ${status}
      ${configured ? null : html`<p class="muted">${provider.configurationHint()}</p>`}
      ${action}
    </section>`;
  }
  const sum = s.summary;
  const index = timelineIndex(s);
  const used = new Set(sum.articles.map((a) => a.articleId));
  // The articles that came into the story since the brief before this one.
  const previousRevision = s.summaryRevisions.find((r) => r.revision === sum.revision - 1);
  const previousArticles = new Set(previousRevision?.articleIds ?? []);
  const added = previousRevision ? s.members.filter((m) => !previousArticles.has(m.articleId)).length : 0;
  const basis = sum.articles.reduce<Record<string, number>>((acc, a) => ((acc[a.basis] = (acc[a.basis] ?? 0) + 1), acc), {});
  const claims = (title: string, items: SummaryClaim[]) =>
    items.length
      ? html`<h4>${title}</h4><ul class="claims">${items.map(
          (c) => html`<li><span class="claim-status st-${c.status}" title="${STATUS_LABEL[c.status]}">${STATUS_LABEL[c.status]}</span> ${markTerms(c.text, glossary)} ${cite(c.sources, index)}</li>`,
        )}</ul>`
      : null;
  const written = html`<p class="brief-meta">Written ${fmtDate(sum.createdAt)} (${timeEl(sum.createdAt, now)}) &middot; revision ${sum.revision} &middot; ${sum.trigger === 'auto' ? 'written automatically' : 'written on request'}</p>`;
  const meta = html`<dl class="kv small">
      <dt>Based on</dt><dd>${plural(sum.articles.length, 'article')}: ${Object.entries(basis).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')}${added ? html` &middot; <strong>${plural(added, 'article')} added since the previous brief</strong>` : null}</dd>
      <dt>Model</dt><dd>${sum.provider} &middot; ${sum.model} &middot; ${sum.promptVersion}</dd>
      <dt>Tokens</dt><dd>${sum.inputTokens ?? '-'} in / ${sum.outputTokens ?? '-'} out${sum.durationMs != null ? `, ${Math.round(sum.durationMs / 1000)} s` : ''}</dd>
    </dl>`;
  const revisions = s.summaryRevisions.length > 1
    ? html`<details><summary>Earlier revisions</summary><table><thead><tr><th>Revision</th><th>Written</th><th>Trigger</th><th>Model</th></tr></thead>
        <tbody>${s.summaryRevisions.map((r) => html`<tr><td>${r.revision}</td><td>${fmtDate(r.createdAt)}</td><td>${r.trigger}</td><td>${r.model}</td></tr>`)}</tbody></table></details>`
    : null;

  if (isBrief(sum.content)) {
    const brief = sum.content;
    const newTitle = previousRevision ? `What's new since the brief of ${fmtDate(previousRevision.createdAt)}` : SECTION_TITLE.new_since;
    return html`<section class="panel summary-panel">
      <h3>Story Intelligence Brief</h3>
      ${status}
      ${written}
      <p class="brief-gist">${brief.gist.map((c, i) => html`${i ? ' ' : ''}${markTerms(c.text, glossary)} ${cite(c.sources, index)}`)}</p>
      ${claims(newTitle, brief.new_since)}
      ${claims(SECTION_TITLE.key_developments, brief.key_developments)}
      ${claims(SECTION_TITLE.context_significance, brief.context_significance)}
      ${claims(SECTION_TITLE.perspectives, brief.perspectives)}
      ${claims(SECTION_TITLE.whats_next, brief.whats_next)}
      ${meta}
      ${revisions}
      ${action}
    </section>`;
  }

  // An executive summary from before the brief: it still reads, and its citations point
  // at the same numbered timeline.
  const legacy = sum.content as LegacySummaryContent;
  return html`<section class="panel summary-panel">
    <h3>Story Intelligence Brief</h3>
    ${status}
    ${written}
    ${LEGACY_CLAIM_SECTIONS.map((k) => claims(LEGACY_SECTION_TITLE[k], legacy[k]))}
    ${legacy.uncertainties.length
      ? html`<h4>Uncertainties and open questions</h4><ul class="claims">${legacy.uncertainties.map(
          (u) => html`<li>${markTerms(u.text, glossary)} ${cite(u.sources, index)}</li>`,
        )}</ul>`
      : null}
    ${meta}
    ${revisions}
    ${action}
  </section>`;
}

function bigScore(label: string, value: number | null, note?: SafeHtml | string | null, help?: string): SafeHtml {
  const v = value == null ? null : Math.round(value * 100);
  return html`<div class="big-score" title="${help ?? ''}">
    <div class="label">${label}</div>
    <div class="value">${v ?? '-'}</div>
    <span class="meter" aria-hidden="true"><span style="width:${v ?? 0}%"></span></span>
    ${note ? html`<div class="conf">${note}</div>` : null}
  </div>`;
}

function assessmentPanel(s: StoryDetail, now: number): SafeHtml {
  const current = s.assessments[0] ?? null;
  const ev = current?.evidence;
  const from = (e: { articleId: number } | null | undefined) => (e ? html`from <a href="#a-${e.articleId}">article ${e.articleId}</a>` : null);
  const rec = s.recencyHalfLifeHours != null ? recency(s.latestDevelopmentAt, now, s.recencyHalfLifeHours) : null;
  return html`<section class="panel">
    <h3>Assessment</h3>
    <div class="score-grid">
      ${bigScore('Priority', s.priority, current ? `${current.formula}, profile v${current.profileVersion}` : 'awaiting classification')}
      ${bigScore('Personal relevance', s.personalRelevance, from(ev?.personalRelevance), 'Strongest substantive report; promotion and exclusions discount an article')}
      ${bigScore('Significance', s.significance, from(ev?.significance), 'Strongest substantive report')}
      ${bigScore('Urgency', s.urgency, from(ev?.urgency), 'Reports around the latest development')}
      ${bigScore('Coverage', s.coverage, ev ? `${plural(ev.independentPublishers.length, 'independent publisher')}` : null, 'Distinct publishers, excluding promotional articles, with diminishing returns')}
      ${bigScore('Recency', rec, s.recencyHalfLifeHours != null ? `half-life ${s.recencyHalfLifeHours} h` : null, 'Decays from the latest development')}
    </div>
    ${ev
      ? html`<p class="muted small">${ev.classifiedArticles} of ${ev.classifiedArticles + ev.unclassifiedArticles} articles classified.
          ${ev.promotionalArticles.length ? `${plural(ev.promotionalArticles.length, 'promotional article')} not counted as coverage.` : ''}
          Publishers: ${ev.independentPublishers.join(', ') || '-'}.</p>`
      : null}
    ${s.categories.length ? html`<div class="tags">${s.categories.map((c) => html`<a class="chip" href="/?category=${c.id}">${c.label} ${pct(c.probability)}%</a>`)}</div>` : null}
    ${s.assessments.length > 1
      ? html`<details><summary>Assessment history</summary>
          <table><thead><tr><th>When</th><th>Profile</th><th>Static priority</th><th>Relevance</th><th>Significance</th><th>Urgency</th><th>Coverage</th></tr></thead>
          <tbody>${s.assessments.map((a) => html`<tr><td>${fmtDate(a.createdAt)}</td><td>v${a.profileVersion}</td><td>${pct(a.priorityStatic)}</td>
            <td>${pct(a.personalRelevance)}</td><td>${pct(a.significance)}</td><td>${pct(a.urgency)}</td><td>${pct(a.coverage)}</td></tr>`)}</tbody></table>
        </details>`
      : null}
    <form method="post" action="/stories/${s.id}/reassess" class="inline"><button type="submit" class="secondary">Recalculate</button></form>
  </section>`;
}

function matchNote(m: StoryMember, storyId: number): string {
  if (m.assignedBy === 'user') return 'Moved here by you';
  if (m.matchMethod === 'title_match') return 'Same headline as another report';
  if (m.matchMethod === 'no_candidates') return m.role === 'origin' ? 'No earlier story matched' : '';
  const own = m.matchCandidates?.find((c) => c.storyId === storyId);
  if (m.role === 'origin') return 'Started this story';
  if (!own?.same) return m.matchModel ? `Matched by ${m.matchModel}` : '';
  const conf = own.same.confidence != null ? `, confidence ${pct(own.same.confidence)}%` : '';
  return `Same story ${own.same.score.toFixed(2)}/2${conf}; adds ${own.update?.score.toFixed(2) ?? '-'}/2 (${m.matchModel ?? 'matcher'})`;
}

const ROLE_LABEL: Record<StoryMember['role'], string> = { origin: 'First report', update: 'Update', coverage: 'Coverage' };

function timelinePanel(app: App, s: StoryDetail, now: number): SafeHtml {
  // The newest entry comes first: the reader wants to see what happened last. The
  // number of an entry is its place in the story's publish order, and stays that way
  // when the reader flips the order.
  const glossary = app.stories.glossary();
  const numbered = s.members.map((m, i) => ({ member: m, number: i + 1 })).reverse();
  return html`<section class="panel">
    <div class="timeline-head">
      <h3>Timeline</h3>
      <button type="button" class="timeline-order" data-timeline-order>Oldest first</button>
    </div>
    <ol class="timeline" data-order="newest">${numbered.map(({ member: m, number: n }) => html`<li id="a-${m.articleId}" class="timeline-entry role-${m.role}" data-order="${n}">
      <div class="timeline-meta"><span class="entry-number" aria-label="Article ${n}">${n}</span>
        <span class="when">${timeEl(m.occurredAt, now)}</span>
        <span class="badge role-${m.role}">${ROLE_LABEL[m.role]}</span></div>
      <h4 class="entry-title"><a href="/articles/${m.articleId}">${markTerms(m.title ?? '(untitled)', glossary)}</a></h4>
      <div class="meta">${discoveredVia(m.provenance, m.sourceName ?? m.publisher)}</div>
      ${articleLinks(m.articleId, m.url, m.provenance)}
      <dl class="article-scores"><div><dt>Relevance</dt><dd>${pct(m.personalRelevance)}</dd></div>
        <div><dt>Significance</dt><dd>${pct(m.significance)}</dd></div></dl>
      ${feedbackControls({ id: m.articleId, savedAt: m.savedAt })}
      ${matchNote(m, s.id) ? html`<details class="match-details"><summary>Why grouped</summary><p>${matchNote(m, s.id)}</p></details>` : null}
    </li>`)}</ol>
    <details class="story-dates"><summary>Story dates</summary><dl class="kv small">
      <dt>Story created</dt><dd>${fmtDate(s.createdAt)}</dd>
      <dt>First published</dt><dd>${fmtDate(s.firstPublishedAt)}</dd>
      <dt>Latest article</dt><dd>${fmtDate(s.latestPublishedAt)}</dd>
      <dt>Latest development</dt><dd>${fmtDate(s.latestDevelopmentAt)}</dd>
    </dl></details>
    ${s.members.length > 1 ? html`<details class="story-membership"><summary>Manage articles</summary>
      <form method="post" action="/stories/${s.id}/split" data-confirm="Move the selected articles into a new story? This story's summary becomes outdated.">
        <p class="muted small">Select articles to move into a separate story.</p>
        <ul class="membership-list">${s.members.map((m) => html`<li><label><input type="checkbox" name="articleIds" value="${m.articleId}">
          <span>${m.title ?? '(untitled)'}</span></label></li>`)}</ul>
        <button type="submit" class="secondary">Move selected to a new story</button>
      </form>
    </details>` : null}
  </section>`;
}

function mergePanel(app: App, s: StoryDetail): SafeHtml {
  const similar = app.stories.similarStories(s.id);
  return html`<section class="panel">
    <h3>Merge into another story</h3>
    <form method="post" action="/stories/${s.id}/merge" class="merge-form"
      data-confirm="Merge this story into the selected one? Its ${plural(s.articleCount, 'article')} move there, this story closes, and the target's summary becomes outdated.">
      ${similar.length
        ? html`<ul class="plain">${similar.map((c) => html`<li><label><input type="radio" name="target" value="${c.storyId}">
            <a href="/stories/${c.storyId}">${c.headline}</a> <span class="muted">${plural(c.articleCount, 'article')} &middot; similarity ${pct(c.similarity)}%</span></label></li>`)}</ul>`
        : null}
      <div class="inline-form">
        <label for="merge-id">Story id</label><input id="merge-id" name="targetId" type="number" min="1" placeholder="e.g. 123">
        <button type="submit" class="secondary">Merge</button>
      </div>
    </form>
  </section>`;
}

const PLACES_BADGE: Record<PlacesState, [string, string] | null> = {
  none: null,
  pending: ['pending', 'Places queued'],
  running: ['pending', 'Looking for places'],
  ready: ['investigate', 'Places'],
  stale: ['pending', 'Places outdated'],
  failed: ['failed', 'Places lookup failed'],
};

const PLACE_KIND_LABEL: Record<StoryPlace['kind'], string> = {
  city: 'city',
  town: 'town',
  country: 'country',
  region: 'region',
  other: 'place',
};

/** Opens and closes the map card. Without JavaScript the link opens the page with it open. */
function mapButton(s: StoryDetail, open: boolean): SafeHtml {
  const n = s.places.length;
  return html`<a class="map-toggle" href="/stories/${s.id}${open ? '' : '?map=1'}" data-map-toggle
      aria-expanded="${open ? 'true' : 'false'}" aria-controls="story-map">
    <span class="map-pin" aria-hidden="true"></span>${n ? `Map · ${n}` : 'Map'}</a>`;
}

/** The map card: the map itself, and the places it shows as a list. */
function mapPanel(app: App, s: StoryDetail, open: boolean): SafeHtml {
  const state = s.placesState;
  const waiting = state === 'pending' || state === 'running';
  const located = s.places.filter((p) => p.status === 'located' && p.lat != null && p.lon != null);
  const index = new Map(s.members.map((m, i) => [m.articleId, i + 1]));
  const titles = new Map(s.members.map((m) => [m.articleId, m.title ?? `Article ${m.articleId}`]));
  const badge = PLACES_BADGE[state];
  const status =
    state === 'pending'
      ? html`<p class="badge-line"><span class="badge pending">Queued</span> <span class="muted">The places of this story are being looked up.</span></p>`
      : state === 'running'
        ? html`<p class="badge-line"><span class="badge pending">Looking</span> <span class="muted">Looking each place up in the gazetteer.</span></p>`
        : state === 'failed'
          ? html`<p class="error-text">The lookup failed: ${s.placesError ?? 'unknown error'}</p>`
          : state === 'stale'
            ? html`<p class="badge-line"><span class="badge pending">Outdated</span> <span class="muted">The story has developed since these places were found.</span></p>`
            : null;
  const data = raw(
    JSON.stringify({
      tileUrl: app.config.places.tileUrl,
      attribution: app.config.places.tileAttribution,
      places: located.map((p) => ({
        name: p.name,
        kind: p.kind,
        label: p.label,
        role: p.role,
        lat: p.lat,
        lon: p.lon,
        sources: p.sources.map((id) => ({ id, title: titles.get(id) ?? `Article ${id}`, number: index.get(id) ?? null })),
      })),
    }).replace(/</g, '\\u003c'),
  );
  const action = html`<form method="post" action="/stories/${s.id}/places" class="inline" data-story-action="places">
    <button type="submit" class="secondary" ${waiting ? html`disabled` : null}>${s.places.length ? 'Look again' : 'Find places'}</button>
  </form>`;
  return html`<section class="panel map-panel" id="story-map"${open ? '' : html` hidden`}>
    <div class="map-head">
      <h3>Map</h3>
      ${located.length ? html`<button type="button" class="map-expand" data-map-fullscreen aria-pressed="false">Full screen</button>` : null}
    </div>
    ${badge && !status ? html`<p class="badge-line"><span class="badge ${badge[0]}">${badge[1]}</span></p>` : null}
    ${status}
    ${located.length
      ? html`<div class="map-canvas" data-map-canvas aria-label="Map of the places this story is about"></div>
          <script type="application/json" data-map-data>${data}</script>`
      : null}
    ${s.places.length
      ? html`<ol class="map-places">${s.places.map((p) => html`<li class="place place-${p.status}">
          <span class="place-name">${p.name}</span>
          <span class="muted small">${PLACE_KIND_LABEL[p.kind]}${p.country ? ` · ${p.country}` : ''}</span>
          ${p.role ? html`<span class="muted small">${p.role}</span>` : null}
          ${p.status === 'located' && p.lat != null && p.lon != null
            ? html`<span class="muted small">${p.lat.toFixed(4)}, ${p.lon!.toFixed(4)}${p.label && p.label !== p.name ? ` · ${p.label}` : ''}</span>`
            : html`<span class="muted small">not located</span>`}
          ${p.sources.length ? cite(p.sources, index) : null}
        </li>`)}</ol>`
      : html`<p class="muted">No place is named in this story yet.</p>`}
    ${s.placesError && state !== 'failed' ? html`<p class="muted small">${s.placesError}</p>` : null}
    ${action}
  </section>`;
}

const TERMS_BADGE: Record<TermsState, [string, string] | null> = {
  none: null,
  pending: ['pending', 'Terms queued'],
  running: ['pending', 'Explaining terms'],
  ready: ['investigate', 'Terms'],
  stale: ['pending', 'Terms outdated'],
  failed: ['failed', 'Term lookup failed'],
};

const TERM_KIND_LABEL: Record<TermKind, string> = {
  organisation: 'organisation',
  product: 'product',
  person: 'person',
  project: 'project',
  concept: 'concept',
  acronym: 'acronym',
  other: 'term',
};

/** Where the explanation came from, when it came from a link that is safe to follow. */
function termSource(t: StoryTerm): { name: string; url: string } | null {
  if (!t.sourceUrl || !/^https:\/\//i.test(t.sourceUrl)) return null;
  return { name: t.sourceName ?? 'Source', url: t.sourceUrl };
}

/**
 * The glossary of this story: the names the reader may not know, and what they are.
 * The reader can also tap a term in the brief itself.
 */
function termsPanel(s: StoryDetail): SafeHtml {
  const state = s.termsState;
  const waiting = state === 'pending' || state === 'running';
  const index = new Map(s.members.map((m, i) => [m.articleId, i + 1]));
  const badge = TERMS_BADGE[state];
  const status =
    state === 'pending'
      ? html`<p class="badge-line"><span class="badge pending">Queued</span> <span class="muted">The terms of this story are being looked up.</span></p>`
      : state === 'running'
        ? html`<p class="badge-line"><span class="badge pending">Looking</span> <span class="muted">Looking each term up in the encyclopedia.</span></p>`
        : state === 'failed'
          ? html`<p class="error-text">The lookup failed: ${s.termsError ?? 'unknown error'}</p>`
          : state === 'stale'
            ? html`<p class="badge-line"><span class="badge pending">Outdated</span> <span class="muted">The story has developed since these terms were explained.</span></p>`
            : null;
  const action = html`<form method="post" action="/stories/${s.id}/terms" class="inline" data-story-action="terms">
    <button type="submit" class="secondary" ${waiting ? html`disabled` : null}>${s.terms.length ? 'Explain again' : 'Explain the terms'}</button>
  </form>`;
  return html`<section class="panel terms-panel">
    <h3>Terms</h3>
    ${badge && !status ? html`<p class="badge-line"><span class="badge ${badge[0]}">${badge[1]}</span></p>` : null}
    ${status}
    ${s.terms.length
      ? html`<ul class="term-list">${s.terms.map((t) => {
          const source = termSource(t);
          return html`<li class="term-entry">
            <span class="term-name">${t.name}</span>
            <span class="muted small">${TERM_KIND_LABEL[t.kind]}${t.role ? ` · ${t.role}` : ''}</span>
            ${t.description ? html`<div class="term-desc">${t.description}</div>` : null}
            ${t.summary ? html`<div class="term-summary">${t.summary}</div>` : null}
            ${source ? html`<a class="term-source" href="${source.url}" target="_blank" rel="noopener noreferrer">${source.name}</a>` : null}
            ${t.status === 'unknown' ? html`<span class="muted small">not explained</span>` : null}
            ${t.sources.length ? cite(t.sources, index) : null}
          </li>`;
        })}</ul>`
      : html`<p class="muted">No term of this story has been explained yet.</p>`}
    ${s.termsError && state !== 'failed' ? html`<p class="muted small">${s.termsError}</p>` : null}
    ${action}
  </section>`;
}

export function storyPage(app: App, s: StoryDetail, flash?: string | null, mapOpen = false): SafeHtml {
  const now = Date.now();
  const glossary = app.stories.glossary();
  const body = html`
  <article class="detail story-detail" data-story-id="${s.id}" data-version="${app.stories.storyVersion(s.id)}">
    <header>
      ${seenButton(s)}
      <h1>${markTerms(s.summary?.content.headline ?? s.headline, glossary)}</h1>
      ${s.summary && s.summary.content.headline !== s.headline ? html`<p class="muted">First report: ${s.headline}</p>` : null}
      <div class="meta">
        <span class="source">${plural(s.articleCount, 'article')} &middot; ${plural(s.publisherCount, 'publisher')} &middot; ${plural(s.developmentCount, 'development')}</span>
        <span>First reported ${timeEl(s.firstPublishedAt, now)}</span>
        <span>Latest development ${timeEl(s.latestDevelopmentAt, now)}</span>
        <span class="muted">Story ${s.id}</span>
      </div>
      <div class="tags">${storyBadges(s, now)}</div>
      ${publisherRow(s, now)}
      <div class="story-actions">${storyFeedback(s)}${storySave(s, true)}${mapButton(s, mapOpen)}</div>
    </header>
    ${mapPanel(app, s, mapOpen)}
    ${summaryPanel(app, s, now)}
    ${termsPanel(s)}
    ${assessmentPanel(s, now)}
    ${timelinePanel(app, s, now)}
    ${mergePanel(app, s)}
    ${s.events.length
      ? html`<section class="panel"><h3>Changes</h3><table><tbody>${s.events.map((e) => html`<tr><td>${fmtDate(e.createdAt)}</td><td>${eventText(e)}</td></tr>`)}</tbody></table></section>`
      : null}
  </article>`;
  return layout(app, { title: s.headline, nav: 'stories', body, flash });
}

function eventText(e: StoryDetail['events'][number]): SafeHtml {
  const d = e.details as { storyId?: number; articleIds?: number[]; headline?: string; articles?: number };
  const link = d.storyId ? html`<a href="/stories/${d.storyId}">story ${d.storyId}</a>` : null;
  switch (e.eventType) {
    case 'merged_into':
      return html`Merged into ${link}`;
    case 'absorbed':
      return html`Absorbed ${link} (${d.headline ?? ''}, ${plural(d.articles ?? 0, 'article')})`;
    case 'split_out':
      return html`${plural(d.articleIds?.length ?? 0, 'article')} moved to ${link}`;
    case 'split_from':
      return html`Created from ${plural(d.articleIds?.length ?? 0, 'article')} of ${link}`;
    default:
      return html`${e.eventType}`;
  }
}
