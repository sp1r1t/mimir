import type { App } from '../../app.js';
import { fmtDate, pct } from '../format.js';
import { html, type SafeHtml } from '../html.js';
import { classifierStatus, layout } from '../layout.js';

/** Single-series column chart: one hue, thin columns, value on hover/focus, table fallback. */
function columnChart(title: string, rows: { label: string; value: number; tip: string }[], axisNote: string): SafeHtml {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return html`<figure class="viz">
    <figcaption>${title}</figcaption>
    <div class="cols" role="img" aria-label="${title}">
      <span class="ymax">${max}</span>
      ${rows.map((r) => html`<div class="col" tabindex="0" data-tip="${r.tip}">
        <span class="bar" style="height:${(r.value / max) * 100}%"></span>
        <span class="x">${r.label}</span>
      </div>`)}
    </div>
    <div class="axis-note">${axisNote}</div>
    <details><summary>Table</summary>
      <table><tbody>${rows.map((r) => html`<tr><td>${r.label}</td><td>${r.value}</td></tr>`)}</tbody></table>
    </details>
  </figure>`;
}

function tile(label: string, value: string | number, sub?: string): SafeHtml {
  return html`<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${sub ? html`<div class="tile-sub">${sub}</div>` : null}</div>`;
}

function jobSubject(payload: unknown): SafeHtml | null {
  const p = payload as { articleId?: number; storyId?: number };
  if (p.articleId != null) return html`<a href="/articles/${p.articleId}">article ${p.articleId}</a>`;
  if (p.storyId != null) return html`<a href="/stories/${p.storyId}">story ${p.storyId}</a>`;
  return null;
}

export function statsPage(app: App, flash?: string | null): SafeHtml {
  const o = app.stats.overview();
  const daily = app.stats.daily(14);
  const hist = app.stats.relevanceHistogram();
  const cats = app.stats.categoryCounts();
  const labels = new Map(app.profiles.active().definition.topics.map((t) => [t.id, t.label]));
  const types = app.stats.articleTypeCounts();
  const agreement = app.stats.storyFeedbackAgreement();
  const usage = app.stats.classifierUsage(7);
  const extraction = app.stats.extractionCounts();
  const fetches = app.stats.fetchSummary(24);
  const fetchErrors = app.stats.recentFetchErrors(15);
  const jobs = app.queue.counts();
  const failedJobs = app.queue.recentFailures(15);
  const status = classifierStatus(app);
  const sp = app.storyPipeline;
  const workers = [app.pipeline.extractWorker.stats, app.pipeline.classifyWorker.stats, sp.matchWorker.stats, sp.assessWorker.stats, sp.summaryWorker.stats];
  const storyCounts = app.stories.counts();
  const matchUsage = app.stories.matchUsage(7);
  const summaryUsage = app.stories.summaryUsage(7);
  const allowance = app.summaries.allowance();
  const summaryPaused = sp.summaryPausedReason();
  const automaticBudget = sp.automaticSummaryBudget();

  const body = html`
    <h1>Statistics</h1>
    <div class="tiles">
      ${tile('Articles', o.articles, `${o.articlesLast24h} in the last 24h`)}
      ${tile('Classified', o.classified, `${o.classificationsLast24h} classifications in 24h`)}
      ${tile('Pending classification', o.pending, status.state === 'ready' ? 'queued' : status.state === 'paused' ? 'classifier paused' : 'classifier not configured')}
      ${tile('Classification failed', o.failed)}
      ${tile('Sources', `${o.sourcesEnabled}/${o.sources}`, `${o.sourcesFailing} failing`)}
      ${tile('Saved', o.saved)}
      ${tile('Stories', storyCounts.active, `${storyCounts.multiArticle} with several articles${storyCounts.unassigned ? `, ${storyCounts.unassigned} articles not yet grouped` : ''}`)}
      ${tile('Summaries', storyCounts.summaries.ready + storyCounts.summaries.stale, `${storyCounts.summaries.stale} outdated, ${storyCounts.summaries.pending + storyCounts.summaries.running} queued`)}
    </div>

    <div class="charts">
      ${columnChart(
        'Articles discovered per day (UTC, last 14 days)',
        daily.map((d) => ({ label: d.day.slice(5), value: d.discovered, tip: `${d.day}: ${d.discovered} discovered, ${d.classified} classified` })),
        'Count of new articles by discovery date',
      )}
      ${columnChart(
        'Current personal relevance distribution',
        hist.map((h) => ({ label: `${h.bucket * 10}`, value: h.count, tip: `Relevance ${h.bucket * 10}–${h.bucket * 10 + 9 + (h.bucket === 9 ? 1 : 0)}: ${h.count} articles` })),
        'Articles per relevance band (0–100); low bands are where misclassifications hide',
      )}
    </div>

    <div class="two-col">
      <section class="panel">
        <h3>Classifier vs. your feedback</h3>
        <p class="muted small">Average scores of stories you labelled. Large overlap between “relevant” and “not relevant” suggests the profile or classifier needs adjustment.</p>
        ${agreement.length
          ? html`<table><thead><tr><th>Feedback</th><th>Stories</th><th>Avg relevance</th><th>Avg significance</th></tr></thead>
            <tbody>${agreement.map((a) => html`<tr><td>${a.label.replace(/_/g, ' ')}</td><td>${a.count}</td><td>${pct(a.avgRelevance)}</td><td>${pct(a.avgSignificance)}</td></tr>`)}</tbody></table>`
          : html`<p class="muted">No feedback yet.</p>`}
      </section>
      <section class="panel">
        <h3>Assigned categories</h3>
        ${cats.length
          ? html`<table><thead><tr><th>Category</th><th>Articles</th><th>Avg probability</th></tr></thead>
            <tbody>${cats.map((c) => html`<tr><td><a href="/articles?category=${c.categoryId}">${labels.get(c.categoryId) ?? c.categoryId}</a></td><td>${c.count}</td><td>${pct(c.avgProbability)}</td></tr>`)}</tbody></table>`
          : html`<p class="muted">No classifications yet.</p>`}
      </section>
      <section class="panel">
        <h3>Article types</h3>
        ${types.length
          ? html`<table><tbody>${types.map((t) => html`<tr><td><a href="/articles?type=${t.articleType}">${t.articleType.replace(/_/g, ' ')}</a></td><td>${t.count}</td></tr>`)}</tbody></table>`
          : html`<p class="muted">No classifications yet.</p>`}
      </section>
      <section class="panel">
        <h3>Classifier usage (7 days)</h3>
        ${usage.length
          ? html`<table><thead><tr><th>Model</th><th>Question set</th><th>Calls</th><th>Input tokens</th><th>Avg latency</th></tr></thead>
            <tbody>${usage.map((u) => html`<tr><td>${u.model}</td><td>${u.classifierVersion}</td><td>${u.count}</td><td>${u.inputTokens}</td><td>${u.avgMs != null ? `${Math.round(u.avgMs)} ms` : '—'}</td></tr>`)}</tbody></table>`
          : html`<p class="muted">No classifications in the last 7 days.</p>`}
        <p class="small">Status: <strong>${status.state}</strong> ${status.message ? html`— ${status.message}` : null}</p>
      </section>
      <section class="panel">
        <h3>Executive summaries (7 days)</h3>
        <p class="muted small">Mimir automatic-summary budget: <strong>${automaticBudget.used} / ${automaticBudget.limit}</strong> provider attempts in the past 24 hours, including retries.
          This app limit is separate from the provider allowance. Manual requests bypass it.
          ${automaticBudget.resumesAt ? html`Capacity begins returning ${fmtDate(automaticBudget.resumesAt)}.` : null}</p>
        <p class="small">Provider: <strong>${app.summaries.name}</strong> &middot; ${app.summaries.model}
          ${summaryPaused ? html`<br><span class="error-text">Paused: ${summaryPaused}</span>` : null}</p>
        ${allowance
          ? html`<table><thead><tr><th>Plan allowance</th><th>Remaining</th><th>Resets</th></tr></thead>
            <tbody>${allowance.windows.map((w) => html`<tr><td>${w.label}</td><td>${w.remainingPercent != null ? `${Math.round(w.remainingPercent)}%` : '-'}</td><td>${fmtDate(w.resetsAt)}</td></tr>`)}</tbody></table>
            <p class="muted small">Checked ${fmtDate(allowance.checkedAt)}${allowance.error ? html`, <span class="error-text">${allowance.error}</span>` : null}.
              Automatic summaries stop at ${app.config.minimax.autoReservePercent}% remaining, manual ones at ${app.config.minimax.minRemainingPercent}%.</p>`
          : null}
        ${summaryUsage.length
          ? html`<table><thead><tr><th>Trigger</th><th>Outcome</th><th>Calls</th><th>Tokens in / out</th><th>Avg duration</th></tr></thead>
            <tbody>${summaryUsage.map((u) => html`<tr><td>${u.trigger}</td><td>${u.outcome.replace(/_/g, ' ')}</td><td>${u.count}</td><td>${u.inputTokens} / ${u.outputTokens}</td><td>${u.avgMs != null ? `${Math.round(u.avgMs / 1000)} s` : '-'}</td></tr>`)}</tbody></table>`
          : html`<p class="muted">No summary requests in the last 7 days.</p>`}
        <h4>Story matching</h4>
        ${matchUsage.length
          ? html`<table><thead><tr><th>Decision</th><th>Outcome</th><th>Articles</th><th>Input tokens</th><th>Avg latency</th></tr></thead>
            <tbody>${matchUsage.map((u) => html`<tr><td>${u.method.replace(/_/g, ' ')}</td><td>${u.outcome.replace(/_/g, ' ')}</td><td>${u.count}</td><td>${u.inputTokens}</td><td>${u.avgMs != null ? `${Math.round(u.avgMs)} ms` : '-'}</td></tr>`)}</tbody></table>`
          : html`<p class="muted">No articles matched in the last 7 days.</p>`}
      </section>
      <section class="panel">
        <h3>Feed fetches (24h)</h3>
        <table><thead><tr><th>Outcome</th><th>Count</th><th>Avg duration</th></tr></thead>
          <tbody>${fetches.map((f) => html`<tr><td>${f.outcome.replace('_', ' ')}</td><td>${f.count}</td><td>${f.avgMs != null ? `${Math.round(f.avgMs)} ms` : '—'}</td></tr>`)}</tbody></table>
        <h4>Content extraction</h4>
        <table><tbody>${extraction.map((e) => html`<tr><td>${e.status.replace(/_/g, ' ')}</td><td>${e.count}</td></tr>`)}</tbody></table>
      </section>
      <section class="panel">
        <h3>Job queue</h3>
        <table><thead><tr><th>Kind</th><th>Status</th><th>Jobs</th></tr></thead>
          <tbody>${jobs.map((j) => html`<tr><td>${j.kind}</td><td>${j.status}</td><td>${j.count}</td></tr>`)}</tbody></table>
        <table class="small"><thead><tr><th>Worker</th><th>Running</th><th>Done</th><th>Retried</th><th>Failed</th><th>Paused</th></tr></thead>
          <tbody>${workers.map((w) => html`<tr><td>${w.kind}</td><td>${w.running}</td><td>${w.processed}</td><td>${w.retried}</td><td>${w.failed}</td><td>${w.pausedReason ? html`<span title="${w.pausedReason}">yes</span>` : 'no'}</td></tr>`)}</tbody></table>
        <p class="muted small">Worker counters reset on restart.</p>
        <form method="post" action="/jobs/retry-failed"><button class="secondary" ${failedJobs.length ? null : html`disabled`}>Retry failed jobs</button></form>
      </section>
    </div>

    <section class="panel">
      <h3>Recent errors</h3>
      <h4>Feeds</h4>
      ${fetchErrors.length
        ? html`<table><thead><tr><th>When</th><th>Source</th><th>HTTP</th><th>Error</th></tr></thead>
          <tbody>${fetchErrors.map((e) => html`<tr><td>${fmtDate(e.startedAt)}</td><td><a href="/sources/${e.sourceId}">${e.sourceName}</a></td><td>${e.httpStatus ?? '—'}</td><td class="err">${e.error}</td></tr>`)}</tbody></table>`
        : html`<p class="muted">None.</p>`}
      <h4>Failed jobs</h4>
      ${failedJobs.length
        ? html`<table><thead><tr><th>Job</th><th>Subject</th><th>Attempts</th><th>Error</th></tr></thead>
          <tbody>${failedJobs.map((j) => html`<tr><td>${j.kind} #${j.id}</td><td>${jobSubject(j.payload)}</td><td>${j.attempts}/${j.maxAttempts}</td><td class="err">${j.lastError}</td></tr>`)}</tbody></table>`
        : html`<p class="muted">None.</p>`}
    </section>`;
  return layout(app, { title: 'Statistics', nav: 'stats', body, flash });
}
