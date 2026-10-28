import type { App } from '../../app.js';
import { sourceHealth, type Source } from '../../repo/sources.js';
import { isHttpUrl } from '../../util/url.js';
import { duration, fmtDate, timeEl } from '../format.js';
import { html, type SafeHtml } from '../html.js';
import { layout } from '../layout.js';

const HEALTH_LABEL = { ok: 'Healthy', pending: 'Not fetched yet', failing: 'Failing', disabled: 'Disabled' } as const;

function externalLink(url: string | null | undefined): SafeHtml {
  if (!url) return html`—`;
  if (!isHttpUrl(url)) return html`${url}`;
  return html`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
}

function healthBadge(s: Source): SafeHtml {
  const h = sourceHealth(s);
  return html`<span class="health health-${h}" title="${s.lastError ?? ''}">${HEALTH_LABEL[h]}${h === 'failing' ? ` (${s.consecutiveFailures}×)` : ''}</span>`;
}

export function sourceForm(app: App, s: Partial<Source> | null, action: string, error?: string | null): SafeHtml {
  const minutes = Math.round((s?.pollIntervalSeconds ?? app.config.feeds.defaultPollSeconds) / 60);
  return html`<form method="post" action="${action}" class="source-form">
    ${error ? html`<p class="error-text">${error}</p>` : null}
    <div class="field grow"><label for="s-url">Feed URL</label>
      <input id="s-url" name="url" type="url" required value="${s?.url ?? ''}" placeholder="https://example.com/feed.xml"></div>
    <div class="field grow"><label for="s-name">Name</label>
      <input id="s-name" name="name" type="text" value="${s?.name ?? ''}" placeholder="Taken from the feed if left empty"></div>
    <div class="field small"><label for="s-poll">Poll every (minutes)</label>
      <input id="s-poll" name="pollMinutes" type="number" min="${Math.round(app.config.feeds.minPollSeconds / 60)}" value="${minutes}"></div>
    <div class="field"><label for="s-tags">Tags</label>
      <input id="s-tags" name="tags" type="text" value="${s?.config?.tags.join(', ') ?? ''}" placeholder="comma-separated"></div>
    <div class="field check"><label><input type="checkbox" name="extractContent" value="1" ${s?.config?.extractContent === false ? null : html`checked`}>
      Fetch full article text when the feed only has a summary</label></div>
    <div class="field check"><label><input type="checkbox" name="enabled" value="1" ${s?.enabled === false ? null : html`checked`}> Enabled</label></div>
    <div class="field actions"><button type="submit">${s?.id ? 'Save changes' : 'Add feed'}</button></div>
  </form>`;
}

export function sourcesPage(app: App, flash?: string | null, error?: string | null, draft?: Partial<Source> | null): SafeHtml {
  const sources = app.sources.list();
  const counts = app.sources.articleCounts();
  const now = Date.now();
  const failing = sources.filter((s) => sourceHealth(s) === 'failing').length;
  const body = html`
    <h1>Sources</h1>
    <p class="muted">${sources.length} feeds · ${sources.filter((s) => s.enabled).length} enabled · ${failing} failing.
      Feeds are polled automatically; failing feeds back off exponentially and keep retrying.</p>
    <details class="panel" ${error ? html`open` : null}>
      <summary><strong>Add a feed</strong></summary>
      ${sourceForm(app, draft ?? null, '/sources', error)}
    </details>
    <div class="table-wrap">
    <table class="sources">
      <thead><tr><th>Name</th><th>Health</th><th>Last success</th><th>Next fetch</th><th>Interval</th><th>Articles (24h)</th><th>Last error</th><th></th></tr></thead>
      <tbody>${sources.map((s) => {
        const c = counts.get(s.id);
        return html`<tr class="${s.enabled ? '' : 'disabled'}">
          <td><a href="/sources/${s.id}">${s.name}</a>
            ${s.siteUrl ? html`<div class="muted small url">${externalLink(s.siteUrl)}</div>` : null}
            <div class="muted small url">${externalLink(s.url)}</div></td>
          <td>${healthBadge(s)}</td>
          <td>${timeEl(s.lastSuccessAt, now)}</td>
          <td>${s.enabled ? timeEl(s.nextFetchAt, now) : '—'}</td>
          <td>${duration(s.pollIntervalSeconds)}</td>
          <td>${c?.total ?? 0} (${c?.last24h ?? 0})</td>
          <td class="err">${s.lastError ? html`<span title="${fmtDate(s.lastErrorAt)}">${s.lastError}</span>` : null}</td>
          <td class="row-actions">
            <form method="post" action="/sources/${s.id}/fetch"><button class="secondary small" ${s.enabled ? null : html`disabled`}>Fetch now</button></form>
            <form method="post" action="/sources/${s.id}/toggle"><button class="secondary small">${s.enabled ? 'Disable' : 'Enable'}</button></form>
          </td></tr>`;
      })}</tbody>
    </table>
    </div>`;
  return layout(app, { title: 'Sources', nav: 'sources', body, flash });
}

export function sourceDetailPage(app: App, s: Source, flash?: string | null, error?: string | null): SafeHtml {
  const fetches = app.sources.recentFetches(s.id, 30);
  const c = app.sources.articleCounts().get(s.id);
  const now = Date.now();
  const body = html`
    <p><a href="/sources">← Sources</a></p>
    <h1>${s.name}</h1>
    <p>${healthBadge(s)} <a href="/articles?source=${s.id}&sort=discovered">${c?.total ?? 0} articles</a> · ${c?.last24h ?? 0} in the last 24h</p>
    <section class="panel">
      <h3>Fetch state</h3>
      <dl class="kv">
        <dt>Feed URL</dt><dd>${externalLink(s.url)}</dd>
        <dt>Site</dt><dd>${externalLink(s.siteUrl)}</dd>
        <dt>Feed title / format</dt><dd>${s.feedTitle ?? '—'} · ${s.feedFormat ?? '—'}</dd>
        <dt>Last fetch</dt><dd>${fmtDate(s.lastFetchAt)} (HTTP ${s.lastHttpStatus ?? '—'})</dd>
        <dt>Last success</dt><dd>${fmtDate(s.lastSuccessAt)}</dd>
        <dt>Next fetch</dt><dd>${s.enabled ? html`${fmtDate(s.nextFetchAt)} (${timeEl(s.nextFetchAt, now)})` : 'disabled'}</dd>
        <dt>Consecutive failures</dt><dd>${s.consecutiveFailures}</dd>
        <dt>Last error</dt><dd class="err">${s.lastError ?? '—'} ${s.lastErrorAt ? html`<span class="muted">(${fmtDate(s.lastErrorAt)})</span>` : null}</dd>
        <dt>Validators</dt><dd class="small">ETag: <code>${s.etag ?? '—'}</code> · Last-Modified: <code>${s.lastModified ?? '—'}</code></dd>
      </dl>
      <div class="row-actions">
        <form method="post" action="/sources/${s.id}/fetch"><button ${s.enabled ? null : html`disabled`}>Fetch now</button></form>
        <form method="post" action="/sources/${s.id}/toggle"><button class="secondary">${s.enabled ? 'Disable' : 'Enable'}</button></form>
        <form method="post" action="/sources/${s.id}/delete" data-confirm="Delete this feed? Its articles are kept.">
          <button class="danger">Delete</button></form>
      </div>
    </section>
    <section class="panel">
      <h3>Edit</h3>
      ${sourceForm(app, s, `/sources/${s.id}`, error)}
    </section>
    <section class="panel">
      <h3>Recent fetches</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Started</th><th>Outcome</th><th>HTTP</th><th>Attempts</th><th>Duration</th><th>Entries</th><th>New</th><th>Updated</th><th>Error</th></tr></thead>
        <tbody>${fetches.map((f) => html`<tr class="outcome-${f.outcome}">
          <td>${fmtDate(f.startedAt)}</td><td>${f.outcome.replace('_', ' ')}</td><td>${f.httpStatus ?? '—'}</td><td>${f.attempts}</td>
          <td>${f.durationMs} ms</td><td>${f.itemsSeen}</td><td>${f.itemsNew}</td><td>${f.itemsUpdated}</td><td class="err">${f.error ?? ''}</td></tr>`)}</tbody>
      </table></div>
    </section>`;
  return layout(app, { title: s.name, nav: 'sources', body, flash });
}
