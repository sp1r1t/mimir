import type { App } from '../../app.js';
import { PRIORITIES, slugify, type InterestProfile, type ProfileDefinition, type Topic } from '../../profile/schema.js';
import { fmtDate } from '../format.js';
import { html, type SafeHtml } from '../html.js';
import { layout } from '../layout.js';

type Body = Record<string, string | string[] | undefined>;

function str(body: Body, key: string): string {
  const v = body[key];
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
}

function lines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function numField(body: Body, key: string, fallback: number): number {
  const n = Number(str(body, key));
  return str(body, key) !== '' && Number.isFinite(n) ? n : fallback;
}

/** Build a profile definition from the form, keeping unedited sections (inferred interests) from the current version. */
export function definitionFromForm(body: Body, current: ProfileDefinition): unknown {
  const indices = new Set<number>();
  for (const k of Object.keys(body)) {
    const m = /^t\.(\d+)\./.exec(k);
    if (m) indices.add(Number(m[1]));
  }
  const usedIds = new Set<string>();
  const topics: Partial<Topic>[] = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    const label = str(body, `t.${i}.label`);
    if (!label || str(body, `t.${i}.remove`)) continue;
    let id = str(body, `t.${i}.id`) || slugify(label);
    while (usedIds.has(id)) id = `${id}-2`;
    usedIds.add(id);
    topics.push({
      id,
      label,
      description: str(body, `t.${i}.description`),
      priority: (PRIORITIES as readonly string[]).includes(str(body, `t.${i}.priority`)) ? (str(body, `t.${i}.priority`) as Topic['priority']) : 'normal',
      enabled: !!str(body, `t.${i}.enabled`),
    });
  }
  const exclusionIds = new Set<string>();
  const exclusions = lines(str(body, 'exclusions')).map((description) => {
    const existing = current.exclusions.find((x) => x.description === description);
    let id = existing?.id ?? slugify(description.split(/\s+/).slice(0, 4).join(' '));
    while (exclusionIds.has(id)) id = `${id}-2`;
    exclusionIds.add(id);
    return { id, description };
  });
  const r = current.ranking;
  const sr = current.storyRanking;
  return {
    schemaVersion: 1,
    summary: str(body, 'summary'),
    topics,
    exclusions,
    editorialPreferences: lines(str(body, 'editorialPreferences')),
    inferred: current.inferred,
    ranking: {
      categoryThreshold: numField(body, 'r.categoryThreshold', r.categoryThreshold),
      weights: {
        relevance: numField(body, 'r.w.relevance', r.weights.relevance),
        significance: numField(body, 'r.w.significance', r.weights.significance),
        urgency: numField(body, 'r.w.urgency', r.weights.urgency),
        topicMatch: numField(body, 'r.w.topicMatch', r.weights.topicMatch),
      },
      priorityWeights: {
        core: numField(body, 'r.p.core', r.priorityWeights.core),
        high: numField(body, 'r.p.high', r.priorityWeights.high),
        normal: numField(body, 'r.p.normal', r.priorityWeights.normal),
        low: numField(body, 'r.p.low', r.priorityWeights.low),
      },
      promotionalPenalty: numField(body, 'r.promotionalPenalty', r.promotionalPenalty),
      exclusionPenalty: numField(body, 'r.exclusionPenalty', r.exclusionPenalty),
    },
    storyRanking: {
      weights: {
        relevance: numField(body, 's.w.relevance', sr.weights.relevance),
        significance: numField(body, 's.w.significance', sr.weights.significance),
        urgency: numField(body, 's.w.urgency', sr.weights.urgency),
        coverage: numField(body, 's.w.coverage', sr.weights.coverage),
        recency: numField(body, 's.w.recency', sr.weights.recency),
      },
      recencyHalfLifeHours: numField(body, 's.recencyHalfLifeHours', sr.recencyHalfLifeHours),
    },
  };
}

function topicRow(t: Partial<Topic>, i: number): SafeHtml {
  const prio = t.priority ?? 'normal';
  return html`<fieldset class="topic-row" data-index="${i}">
    <input type="hidden" name="t.${i}.id" value="${t.id ?? ''}">
    <div class="field grow"><label>Topic</label><input name="t.${i}.label" value="${t.label ?? ''}" placeholder="New topic name"></div>
    <div class="field"><label>Priority</label><select name="t.${i}.priority">
      ${PRIORITIES.map((p) => html`<option value="${p}" ${p === prio ? html`selected` : null}>${p}</option>`)}
    </select></div>
    <div class="field check"><label><input type="checkbox" name="t.${i}.enabled" value="1" ${t.enabled === false ? null : html`checked`}> Enabled</label></div>
    ${t.id ? html`<div class="field check"><label><input type="checkbox" name="t.${i}.remove" value="1"> Remove</label></div>` : null}
    <div class="field full"><label>Description (what counts as this topic)</label>
      <textarea name="t.${i}.description" rows="2">${t.description ?? ''}</textarea></div>
    ${t.id ? html`<div class="muted small">Category id: <code>${t.id}</code></div>` : null}
  </fieldset>`;
}

export function profilePage(app: App, flash?: string | null, error?: string | null): SafeHtml {
  const active = app.profiles.active();
  const versions = app.profiles.list();
  const d = active.definition;
  const r = d.ranking;
  const sr = d.storyRanking;
  const outdated = app.articles.idsForReclassification({ onlyOutdatedVersion: active.version }).length;
  const body = html`
    <h1>Interest profile <span class="muted">version ${active.version}</span></h1>
    <p class="muted">Saving creates a new version. Classifications record the version they used. New articles use the active
      version; existing articles can be reclassified below. These are starting preferences for the classifier, not fixed rules.</p>
    ${error ? html`<p class="error-text">${error}</p>` : null}

    <section class="panel">
      <h3>Reclassify</h3>
      <p>${outdated} article${outdated === 1 ? ' is' : 's are'} not yet classified with version ${active.version}.</p>
      <form method="post" action="/profile/reclassify" class="inline-form">
        <label for="rc-scope">Scope</label>
        <select id="rc-scope" name="scope">
          <option value="outdated-1">Last 24 hours, not yet on v${active.version}</option>
          <option value="outdated-7" selected>Last 7 days, not yet on v${active.version}</option>
          <option value="outdated-30">Last 30 days, not yet on v${active.version}</option>
          <option value="outdated-all">All articles not yet on v${active.version}</option>
          <option value="all-7">All of the last 7 days (re-run)</option>
        </select>
        <button type="submit">Queue reclassification</button>
      </form>
    </section>

    <form method="post" action="/profile" class="profile-form">
      <section class="panel">
        <h3>About you</h3>
        <div class="field full"><label for="p-summary">Short description given to the classifier as context</label>
          <textarea id="p-summary" name="summary" rows="3">${d.summary}</textarea></div>
      </section>
      <section class="panel">
        <h3>Interests and topic priorities</h3>
        <p class="muted small">Each enabled topic becomes a category that articles are checked against. Priority affects ranking.</p>
        <div id="topics">
          ${d.topics.map((t, i) => topicRow(t, i))}
          ${topicRow({}, d.topics.length)}
        </div>
        <button type="button" class="secondary" data-add-topic>Add another topic</button>
        <template id="topic-template">${topicRow({}, 9999)}</template>
      </section>
      <section class="panel">
        <h3>Exclusions</h3>
        <div class="field full"><label for="p-excl">Content you do not want ranked highly, one per line</label>
          <textarea id="p-excl" name="exclusions" rows="4">${d.exclusions.map((x) => x.description).join('\n')}</textarea></div>
      </section>
      <section class="panel">
        <h3>Editorial preferences</h3>
        <div class="field full"><label for="p-edit">How you prefer content to be judged, one per line</label>
          <textarea id="p-edit" name="editorialPreferences" rows="4">${d.editorialPreferences.join('\n')}</textarea></div>
      </section>
      <details class="panel">
        <summary><strong>Ranking weights</strong></summary>
        <p class="muted small">Rank = weighted mean of relevance, significance, urgency, and best topic match (topic probability × priority weight),
          reduced by the promotional and exclusion penalties.</p>
        <div class="grid">
          <div class="field"><label>Relevance weight</label><input name="r.w.relevance" type="number" step="0.05" min="0" value="${r.weights.relevance}"></div>
          <div class="field"><label>Significance weight</label><input name="r.w.significance" type="number" step="0.05" min="0" value="${r.weights.significance}"></div>
          <div class="field"><label>Urgency weight</label><input name="r.w.urgency" type="number" step="0.05" min="0" value="${r.weights.urgency}"></div>
          <div class="field"><label>Topic match weight</label><input name="r.w.topicMatch" type="number" step="0.05" min="0" value="${r.weights.topicMatch}"></div>
          ${PRIORITIES.map((p) => html`<div class="field"><label>Priority “${p}”</label><input name="r.p.${p}" type="number" step="0.05" min="0" max="1" value="${r.priorityWeights[p]}"></div>`)}
          <div class="field"><label>Promotional penalty</label><input name="r.promotionalPenalty" type="number" step="0.05" min="0" max="1" value="${r.promotionalPenalty}"></div>
          <div class="field"><label>Exclusion penalty</label><input name="r.exclusionPenalty" type="number" step="0.05" min="0" max="1" value="${r.exclusionPenalty}"></div>
          <div class="field"><label>Category threshold</label><input name="r.categoryThreshold" type="number" step="0.05" min="0" max="1" value="${r.categoryThreshold}"></div>
        </div>
      </details>
      <details class="panel">
        <summary><strong>Story priority weights</strong></summary>
        <p class="muted small">Story priority = weighted mean of the strongest report's relevance and significance, urgency around the latest
          development, coverage by independent publishers, and recency of the latest development. Promotional reports and
          further reports from the same publisher do not raise coverage.</p>
        <div class="grid">
          <div class="field"><label>Relevance weight</label><input name="s.w.relevance" type="number" step="0.05" min="0" value="${sr.weights.relevance}"></div>
          <div class="field"><label>Significance weight</label><input name="s.w.significance" type="number" step="0.05" min="0" value="${sr.weights.significance}"></div>
          <div class="field"><label>Urgency weight</label><input name="s.w.urgency" type="number" step="0.05" min="0" value="${sr.weights.urgency}"></div>
          <div class="field"><label>Coverage weight</label><input name="s.w.coverage" type="number" step="0.05" min="0" value="${sr.weights.coverage}"></div>
          <div class="field"><label>Recency weight</label><input name="s.w.recency" type="number" step="0.05" min="0" value="${sr.weights.recency}"></div>
          <div class="field"><label>Recency half-life (hours)</label><input name="s.recencyHalfLifeHours" type="number" step="1" min="1" value="${sr.recencyHalfLifeHours}"></div>
        </div>
      </details>
      <div class="panel save-bar">
        <div class="field grow"><label for="p-note">Change note (optional)</label><input id="p-note" name="changeNote" placeholder="What changed and why"></div>
        <button type="submit">Save as version ${versions[0]!.version + 1}</button>
      </div>
    </form>

    <details class="panel">
      <summary><strong>Edit as JSON</strong></summary>
      <p class="muted small">The full definition, including the reserved <code>inferred</code> section for future behavioural learning.</p>
      <form method="post" action="/profile/json">
        <textarea name="definition" rows="24" class="mono">${JSON.stringify(d, null, 2)}</textarea>
        <div class="field grow"><label>Change note</label><input name="changeNote"></div>
        <button type="submit">Save JSON as new version</button>
      </form>
    </details>

    <section class="panel">
      <h3>Version history</h3>
      <table>
        <thead><tr><th>Version</th><th>Created</th><th>Author</th><th>Note</th><th>Topics</th><th></th></tr></thead>
        <tbody>${versions.map((v) => versionRow(v))}</tbody>
      </table>
    </section>`;
  return layout(app, { title: 'Interest profile', nav: 'profile', body, flash });
}

function versionRow(v: InterestProfile): SafeHtml {
  return html`<tr class="${v.isActive ? 'active-row' : ''}">
    <td><a href="/profile/versions/${v.version}">v${v.version}</a>${v.isActive ? html` <span class="badge">active</span>` : null}</td>
    <td>${fmtDate(v.createdAt)}</td><td>${v.author}</td><td>${v.changeNote ?? ''}</td>
    <td>${v.definition.topics.filter((t) => t.enabled).length}</td>
    <td>${v.isActive ? null : html`<form method="post" action="/profile/versions/${v.version}/activate"><button class="secondary small">Activate</button></form>`}</td>
  </tr>`;
}

export function profileVersionPage(app: App, v: InterestProfile): SafeHtml {
  const body = html`<p><a href="/profile">← Profile</a></p>
    <h1>Profile version ${v.version} ${v.isActive ? html`<span class="badge">active</span>` : null}</h1>
    <p class="muted">Created ${fmtDate(v.createdAt)} by ${v.author}. ${v.changeNote ?? ''}</p>
    <pre>${JSON.stringify(v.definition, null, 2)}</pre>`;
  return layout(app, { title: `Profile v${v.version}`, nav: 'profile', body });
}
