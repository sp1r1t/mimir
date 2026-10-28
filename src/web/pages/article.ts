import sanitizeHtml from 'sanitize-html';
import type { App } from '../../app.js';
import { stripBoilerplateHtml } from '../../extraction/clean.js';
import type { ArticleDetail, ClassificationRecord } from '../../repo/articles.js';
import { fmtDate, pct, timeEl } from '../format.js';
import { html, raw, type SafeHtml } from '../html.js';
import { layout } from '../layout.js';
import { feedbackControls, statusBadge } from './inbox.js';
import { articleLinks, discoveredVia } from '../provenance.js';

/** Untrusted feed/page HTML → safe markup. Remote images and embeds are dropped (no third-party requests). */
export function sanitize(input: string): string {
  return sanitizeHtml(stripBoilerplateHtml(input), {
    allowedTags: [
      'p', 'br', 'a', 'strong', 'b', 'em', 'i', 'u', 's', 'blockquote', 'q', 'code', 'pre', 'kbd', 'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption', 'hr', 'sup', 'sub', 'dl', 'dt', 'dd',
    ],
    allowedAttributes: { a: ['href', 'title'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }),
      h1: 'h4', h2: 'h4', h3: 'h5',
    },
  });
}

function contentSummary(a: ArticleDetail): string {
  const quality = a.contentQuality === 'full' ? 'full text' : a.contentQuality === 'partial' ? 'partial text' : '';
  const error = a.extractionError ? ` (${a.extractionError})` : '';
  return `Source: ${a.contentSource.replace(/_/g, ' ')} · extraction: ${a.extractionStatus.replace(/_/g, ' ')}${quality ? ` · ${quality}` : ''}${error}`;
}

function paragraphs(text: string): SafeHtml {
  return html`${text.split(/\n{2,}/).map((p) => html`<p>${p}</p>`)}`;
}

function json(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

function scoreRow(label: string, value: number | null, confidence?: number | null, help?: string): SafeHtml {
  const v = value == null ? null : Math.round(value * 100);
  return html`<div class="big-score" title="${help ?? ''}">
    <div class="label">${label}</div>
    <div class="value">${v ?? '—'}</div>
    <span class="meter" aria-hidden="true"><span style="width:${v ?? 0}%"></span></span>
    ${confidence != null ? html`<div class="conf">confidence ${pct(confidence)}%</div>` : null}
  </div>`;
}

function classificationView(c: ClassificationRecord): SafeHtml {
  const conf = (c.signals.confidence ?? {}) as Record<string, number | null>;
  const cats = [...c.categories].sort((a, b) => b.probability - a.probability);
  return html`
    <div class="score-grid">
      ${scoreRow('Rank', c.rankScore, null, `Composite score (${c.rankFormula}) from the assessments below and the profile's ranking weights`)}
      ${scoreRow('Personal relevance', c.personalRelevance, conf.personalRelevance, 'How relevant to you, per your interest profile')}
      ${scoreRow('General significance', c.significance, conf.significance, 'How significant regardless of any particular reader')}
      ${scoreRow('Urgency', c.urgency, conf.urgency, 'How time-sensitive')}
    </div>
    <dl class="kv">
      <dt>Worth investigating</dt><dd>${pct(c.investigate)}%</dd>
      <dt>Promotional</dt><dd>${pct(c.promotional)}${c.promotional != null ? '%' : ''}</dd>
      <dt>Matches an exclusion</dt><dd>${pct(c.exclusion)}${c.exclusion != null ? '%' : ''}</dd>
      <dt>Article type</dt><dd>${c.articleType?.replace(/_/g, ' ') ?? '—'}${conf.articleType != null ? html` <span class="muted">(confidence ${pct(conf.articleType)}%)</span>` : null}</dd>
    </dl>
    <h4>Topic categories</h4>
    <table class="cats">
      <thead><tr><th>Topic</th><th>Probability</th><th>Assigned</th></tr></thead>
      <tbody>${cats.map((t) => html`<tr class="${t.assigned ? 'assigned' : ''}">
        <td><a href="/articles?category=${t.id}">${t.label}</a></td>
        <td><span class="meter inline"><span style="width:${Math.round(t.probability * 100)}%"></span></span> ${pct(t.probability)}%</td>
        <td>${t.assigned ? 'yes' : 'no'}</td></tr>`)}</tbody>
    </table>
    <dl class="kv small">
      <dt>Classified</dt><dd>${fmtDate(c.createdAt)}</dd>
      <dt>Classifier</dt><dd>${c.classifier} · ${c.classifierVersion}</dd>
      <dt>Model</dt><dd>${c.model}</dd>
      <dt>Interest profile</dt><dd><a href="/profile/versions/${c.profileVersion}">version ${c.profileVersion}</a></dd>
      <dt>Tokens</dt><dd>${c.inputTokens ?? '—'} in / ${c.outputTokens ?? '—'} out</dd>
      <dt>Duration</dt><dd>${c.durationMs != null ? `${c.durationMs} ms` : '—'}</dd>
      <dt>Input hash</dt><dd><code>${c.inputHash.slice(0, 16)}…</code></dd>
    </dl>
    <details><summary>Raw request</summary><pre>${json(c.rawRequest)}</pre></details>
    <details><summary>Raw response</summary><pre>${json(c.rawResponse)}</pre></details>`;
}

export function articlePage(app: App, a: ArticleDetail, flash?: string | null): SafeHtml {
  const now = Date.now();
  const current = a.classifications.find((c) => c.id === a.classificationId) ?? null;
  const older = a.classifications.filter((c) => c.id !== a.classificationId);
  const story = app.stories.forArticle(a.id);
  const content =
    a.contentSource === 'extracted' && a.contentText
      ? html`<div class="content">${paragraphs(a.contentText)}</div>`
      : a.contentHtml
        ? html`<div class="content">${raw(sanitize(a.contentHtml))}</div>`
        : a.description
          ? html`<div class="content">${raw(sanitize(a.description))}</div>`
          : html`<p class="muted">No content was provided by the feed.</p>`;

  const body = html`
  <article class="detail">
    <header>
      <h1>${a.title ?? '(untitled)'}</h1>
      <div class="meta">
        ${discoveredVia(a.provenance, a.sourceName)}
        ${a.author ? html`<span>by ${a.author}</span>` : null}
        ${articleLinks(a.id, a.url, a.provenance)}
      </div>
      ${feedbackControls(a)}
      ${story ? html`<p class="story-link">Part of <a href="/stories/${story.storyId}">${story.headline}</a>
        <span class="muted">(${story.role === 'origin' ? 'first report' : story.role}, ${story.articleCount} article${story.articleCount === 1 ? '' : 's'})</span></p>` : null}
    </header>

    <section class="panel">
      <h3>Classification</h3>
      ${statusBadge(a, app.classifier.isConfigured())}
      ${a.classificationError ? html`<p class="error-text">Last error: ${a.classificationError}</p>` : null}
      ${current ? classificationView(current) : html`<p class="muted">Not classified yet.</p>`}
      <form method="post" action="/articles/${a.id}/reclassify" class="inline">
        <button type="submit" class="secondary">Reclassify with active profile</button>
      </form>
      ${older.length
        ? html`<h4>Classification history</h4>
          <table class="history">
            <thead><tr><th>When</th><th>Profile</th><th>Model</th><th>Rank</th><th>Relevance</th><th>Significance</th><th>Urgency</th><th>Categories</th></tr></thead>
            <tbody>${older.map((c) => html`<tr>
              <td>${fmtDate(c.createdAt)}</td><td>v${c.profileVersion}</td><td>${c.model}<br><span class="muted">${c.classifierVersion}</span></td>
              <td>${pct(c.rankScore)}</td><td>${pct(c.personalRelevance)}</td><td>${pct(c.significance)}</td><td>${pct(c.urgency)}</td>
              <td>${c.categories.filter((x) => x.assigned).map((x) => x.label).join(', ') || '—'}</td></tr>`)}</tbody>
          </table>`
        : null}
    </section>

    <section class="panel">
      <h3>Timeline</h3>
      <dl class="kv">
        <dt>Published</dt><dd>${fmtDate(a.publishedAt)} <span class="muted">(as claimed by the source)</span></dd>
        <dt>Updated by source</dt><dd>${fmtDate(a.sourceUpdatedAt)}</dd>
        <dt>Discovered</dt><dd>${fmtDate(a.discoveredAt)} <span class="muted">(${timeEl(a.discoveredAt, now)})</span></dd>
        <dt>Stored</dt><dd>${fmtDate(a.ingestedAt)}</dd>
        <dt>Content changed</dt><dd>${fmtDate(a.contentUpdatedAt)}</dd>
        <dt>Text extracted</dt><dd>${fmtDate(a.extractedAt)}</dd>
        <dt>Classified</dt><dd>${fmtDate(a.classifiedAt)}</dd>
        <dt>First viewed</dt><dd>${fmtDate(a.firstViewedAt)}</dd>
      </dl>
    </section>

    <section class="panel">
      <h3>Content</h3>
      <p class="muted">${contentSummary(a)}</p>
      ${content}
    </section>

    <section class="panel">
      <h3>Metadata</h3>
      <dl class="kv small">
        <dt>Original URL</dt><dd>${a.url ? html`<a href="${a.url}" rel="noopener noreferrer" target="_blank">${a.url}</a>` : '—'}</dd>
        <dt>Canonical URL</dt><dd>${a.canonicalUrl ?? '—'}</dd>
        ${a.declaredCanonicalUrl ? html`<dt>Declared canonical</dt><dd>${a.declaredCanonicalUrl}</dd>` : null}
        <dt>GUID</dt><dd>${a.guid ?? '—'}</dd>
        <dt>Language</dt><dd>${a.language ?? '—'}</dd>
        <dt>Source tags</dt><dd>${a.feedCategories.join(', ') || '—'}</dd>
        <dt>Article id</dt><dd>${a.id}</dd>
      </dl>
      <h4>Seen in feeds</h4>
      ${a.entries.map((e) => html`<details class="entry"><summary>${e.sourceName ?? 'deleted source'} · first seen ${fmtDate(e.firstSeenAt)} · last seen ${fmtDate(e.lastSeenAt)} (${e.feedFormat ?? '?'})</summary>
        <p class="muted">Entry key: <code>${e.entryKey}</code></p>
        <pre>${json(e.rawFirst)}</pre>
        ${e.rawLatest ? html`<p>Latest version:</p><pre>${json(e.rawLatest)}</pre>` : null}
      </details>`)}
    </section>

    ${a.feedbackEvents.length
      ? html`<section class="panel"><h3>Your feedback and interactions</h3>
        <table><thead><tr><th>When</th><th>Event</th><th>Profile</th><th>Rank shown</th></tr></thead>
        <tbody>${a.feedbackEvents.map((e) => html`<tr><td>${fmtDate(e.createdAt)}</td><td>${e.eventType.replace(/_/g, ' ')}</td>
          <td>${e.profileVersion != null ? `v${e.profileVersion}` : '—'}</td><td>${pct(e.rankScore)}</td></tr>`)}</tbody></table></section>`
      : null}
  </article>`;
  return layout(app, { title: a.title ?? 'Article', nav: 'none', body, flash });
}
