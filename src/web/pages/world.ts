import type { App } from '../../app.js';
import type { Clock } from '../../util/time.js';
import { iso } from '../../util/time.js';
import {
  daysUntil,
  electionStanding,
  POSITION_LABEL,
  RAMP,
  VIEW_LABEL,
  type CountrySnapshot,
  type WorldView,
} from '../../world/schema.js';
import type { CountryStory, CountrySummary, WorldRepository } from '../../world/repository.js';
import { html, raw, type SafeHtml } from '../html.js';
import { layout, pageHeading } from '../layout.js';

/** How many days of news the activity mode counts. */
const ACTIVITY_DAYS = 30;
/** How far ahead an election counts as "soon" on the moving list. */
const SOON_DAYS = 30;

export function parseWorldView(value: string | undefined): WorldView {
  return value === 'activity' || value === 'elections' ? value : 'politics';
}

function positionChip(snapshot: CountrySnapshot): SafeHtml {
  if (snapshot.position === 'not-on-axis') {
    return html`<span class="chip world-chip"><span class="swatch world-not-on-axis"></span>not on the axis</span>`;
  }
  if (snapshot.position === 'unknown') {
    return html`<span class="chip world-chip"><span class="swatch world-unknown"></span>unknown</span>`;
  }
  return html`<span class="chip world-chip"><span class="swatch world-${snapshot.position}"></span>${POSITION_LABEL[snapshot.position]}</span>`;
}

function sourceLine(snapshot: CountrySnapshot): SafeHtml {
  const source = snapshot.ideologySource ?? 'unknown source';
  const when = snapshot.fetchedAt ? snapshot.fetchedAt.slice(0, 10) : 'unknown date';
  if (snapshot.sourceUrl) {
    return html`<span class="muted small">${source} · read ${when} · <a href="${snapshot.sourceUrl}" rel="noreferrer noopener">source</a></span>`;
  }
  return html`<span class="muted small">${source} · read ${when}</span>`;
}

/** The legend of the map. Every mark in it carries one meaning, and it is named. */
function legend(view: WorldView): SafeHtml {
  if (view === 'politics') {
    return html`<div class="world-legend" role="group" aria-label="Legend">
      <span class="legend-title">Position of the government</span>
      <span class="legend-row">
        ${RAMP.map(
          (stop) => html`<span class="legend-item"><span class="swatch world-${stop.position}"></span>${stop.label}</span>`,
        )}
        <span class="legend-item"><span class="swatch world-not-on-axis"></span>not on the axis</span>
        <span class="legend-item"><span class="swatch world-unknown"></span>unknown</span>
      </span>
    </div>`;
  }
  if (view === 'activity') {
    return html`<div class="world-legend" role="group" aria-label="Legend">
      <span class="legend-title">Stories in the last ${ACTIVITY_DAYS} days</span>
      <span class="legend-row">
        <span class="legend-item"><span class="swatch world-ink-1"></span>1–2</span>
        <span class="legend-item"><span class="swatch world-ink-2"></span>3–5</span>
        <span class="legend-item"><span class="swatch world-ink-3"></span>6–10</span>
        <span class="legend-item"><span class="swatch world-ink-4"></span>11 or more</span>
        <span class="legend-item"><span class="swatch world-unknown"></span>none</span>
      </span>
    </div>`;
  }
  return html`<div class="world-legend" role="group" aria-label="Legend">
    <span class="legend-title">Next election</span>
    <span class="legend-row">
      <span class="legend-item"><span class="swatch world-election-now"></span>now</span>
      <span class="legend-item"><span class="swatch world-election-planned"></span>scheduled</span>
      <span class="legend-item"><span class="swatch world-unknown"></span>none known</span>
    </span>
  </div>`;
}

function viewSwitch(view: WorldView): SafeHtml {
  const views: WorldView[] = ['politics', 'activity', 'elections'];
  return html`<nav class="world-views" aria-label="Colour the map by">
    ${views.map(
      (v) => html`<a href="/world?view=${v}" class="${v === view ? 'active' : ''}" ${v === view ? html`aria-current="page"` : null}>${VIEW_LABEL[v]}</a>`,
    )}
  </nav>`;
}

/** The data the browser needs to draw the map. */
function mapData(world: WorldRepository, view: WorldView, focus: string | null): SafeHtml {
  const activity = world.activity(ACTIVITY_DAYS);
  const countries: Record<string, unknown> = {};
  for (const snapshot of world.list()) {
    const act = activity.get(snapshot.iso2);
    countries[snapshot.iso2] = {
      name: snapshot.name,
      position: snapshot.position,
      score: snapshot.score,
      state: snapshot.state,
      stories: act?.stories ?? 0,
      developments: act?.developments ?? 0,
      nextElection: snapshot.nextElectionDate,
      electionKind: snapshot.nextElectionKind,
    };
  }
  const payload = {
    countriesUrl: '/static/vendor/world/countries.json',
    view,
    focus,
    countries,
  };
  return raw(JSON.stringify(payload).replace(/</g, '\\u003c'));
}

/** Where the shapes of the map come from. */
function credit(): SafeHtml {
  return html`<p class="muted small world-credit">Shapes: Natural Earth, 110m countries (public domain).</p>`;
}

/** One row of the moving list. */
function movingRow(summary: CountrySummary, now: Date): SafeHtml {
  const s = summary.snapshot!;
  const standing = electionStanding(s.nextElectionDate, now);
  const days = daysUntil(s.nextElectionDate, now);
  const badges: SafeHtml[] = [];
  if (standing === 'now') badges.push(html`<span class="badge world-badge election-now">Election now</span>`);
  else if (standing === 'soon' && days != null && days <= SOON_DAYS)
    badges.push(html`<span class="badge world-badge election-soon">Election in ${days} days</span>`);
  if (s.state === 'stale') badges.push(html`<span class="badge world-badge outdated">May be out of date</span>`);
  if (s.position === 'not-on-axis') badges.push(html`<span class="badge world-badge off-axis">Not on the axis</span>`);
  return html`<a class="card country-row" href="/world/${s.iso2.toLowerCase()}">
    <div class="country-row-head">
      <span class="country-name">${s.name}</span>
      ${badges.length ? html`<span class="badge-line">${badges}</span>` : null}
    </div>
    <div class="country-row-body">
      <span class="country-gov">${s.headOfGovernment ?? s.headOfState ?? 'Government unknown'}</span>
      ${s.party ? html`<span class="muted small">${s.party}</span>` : null}
      ${positionChip(s)}
    </div>
    <div class="country-row-foot">
      ${s.nextElectionDate ? html`<span class="muted small">Next election ${s.nextElectionDate}</span>` : html`<span class="muted small">No election date known</span>`}
      ${summary.activity.stories ? html`<span class="muted small">${summary.activity.stories} ${summary.activity.stories === 1 ? 'story' : 'stories'} · ${summary.activity.developments} developments</span>` : null}
    </div>
  </a>`;
}

/** The list of every country Mimir has a row for. */
function countryTable(countries: CountrySnapshot[], now: Date): SafeHtml {
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Country</th><th>Government</th><th>Party</th><th>Position</th><th>Next election</th></tr></thead>
    <tbody>${countries.map(
      (c) => html`<tr>
        <td><a href="/world/${c.iso2.toLowerCase()}">${c.name}</a></td>
        <td>${c.headOfGovernment ?? c.headOfState ?? '—'}</td>
        <td>${c.party ?? '—'}</td>
        <td>${POSITION_LABEL[c.position]}</td>
        <td>${c.nextElectionDate ? html`${c.nextElectionDate}${c.state === 'stale' ? html` <span class="muted small">(may be out of date)</span>` : null}` : '—'}</td>
      </tr>`,
    )}</tbody>
  </table></div>`;
}

export function worldPage(app: App, view: WorldView, now: Date): SafeHtml {
  const world = app.world;
  const countries = world.list();
  const moving = world.moving(now);
  const freshness = world.freshness();
  const placeholder = countries.length > 0 && countries.every((c) => c.ideologySource === 'placeholder');
  const body = html`${pageHeading(
    'World',
    'Who governs each country, and where the news is moving.',
  )}
  ${placeholder
    ? html`<p class="badge-line"><span class="badge promo">Placeholder data</span>
        <span class="muted">These rows are scaffolding. They are replaced by the fetch job, which has not run yet.</span></p>`
    : null}
  <p class="muted small">${countries.length} countries · snapshot read ${freshness.updatedAt ? freshness.updatedAt.slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}</p>

  <section class="panel map-panel world-panel" id="world-map">
    <div class="map-head">
      <h3>Map</h3>
      ${viewSwitch(view)}
      <button type="button" class="map-expand" data-map-fullscreen aria-pressed="false">Full screen</button>
    </div>
    <div class="map-canvas" data-map-canvas data-map-kind="world" aria-label="World map of governments and news"></div>
    <script type="application/json" data-map-data>${mapData(world, view, null)}</script>
    <div class="world-zoom">
      <button type="button" data-world-frame="news">Your news</button>
      <button type="button" data-world-frame="all">All world</button>
    </div>
    ${legend(view)}
    ${credit()}
  </section>

  <section class="world-moving">
    <h3>Moving now</h3>
    ${moving.length
      ? html`<div class="country-list">${moving.map((m) => movingRow(m, now))}</div>`
      : html`<p class="empty">Nothing is moving that Mimir knows of.</p>`}
  </section>

  <details class="panel">
    <summary><span class="panel-head"><h3>All countries</h3><span class="muted small">${countries.length}</span></span></summary>
    ${countryTable(countries, now)}
  </details>`;
  return layout(app, { title: 'World', nav: 'world', body });
}

/** The stories of one country, as a plain list. */
function storyList(stories: CountryStory[], now: Date): SafeHtml {
  return html`<ol class="map-places">${stories.map(
    (s) => html`<li class="place">
      <a class="place-name" href="/stories/${s.id}">${s.headline}</a>
      <span class="muted small">${s.publisherCount} ${s.publisherCount === 1 ? 'publisher' : 'publishers'} · ${s.latestAt ? html`<time datetime="${s.latestAt}">${relativeTo(s.latestAt, now)}</time>` : '—'}</span>
    </li>`,
  )}</ol>`;
}

function relativeTo(isoStr: string, now: Date): string {
  const diff = (now.getTime() - Date.parse(isoStr)) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export function countryPage(app: App, iso2: string, now: Date): SafeHtml {
  const world = app.world;
  const snapshot = world.get(iso2);
  const name = snapshot?.name ?? iso2.toUpperCase();
  const stories = world.storiesFor(iso2, 12);
  const total = world.storyCount(iso2);
  const activity = world.activity(ACTIVITY_DAYS).get(iso2.toUpperCase());
  const days = daysUntil(snapshot?.nextElectionDate ?? null, now);
  const standing = electionStanding(snapshot?.nextElectionDate ?? null, now);
  const body = html`<p class="world-back"><a href="/world">← World</a></p>
  ${pageHeading(name, snapshot?.headOfGovernment ? `Government: ${snapshot.headOfGovernment}` : undefined)}

  <section class="panel map-panel world-panel">
    <div class="map-head"><h3>Where it is</h3></div>
    <div class="map-canvas country-canvas" data-map-canvas data-map-kind="country" aria-label="Map of ${name}"></div>
    <script type="application/json" data-map-data>${mapData(world, 'politics', iso2.toUpperCase())}</script>
    ${credit()}
  </section>

  ${snapshot
    ? html`<section class="panel">
        <h3>Government</h3>
        ${snapshot.headOfState ? html`<p><span class="muted small">Head of state</span><br>${snapshot.headOfState}</p>` : null}
        ${snapshot.headOfGovernment ? html`<p><span class="muted small">Head of government</span><br>${snapshot.headOfGovernment}</p>` : null}
        ${snapshot.party ? html`<p><span class="muted small">Ruling party</span><br>${snapshot.party}${snapshot.coalition.length ? html` <span class="muted small">with ${snapshot.coalition.join(', ')}</span>` : null}</p>` : null}
        <p class="badge-line">${positionChip(snapshot)}${snapshot.ideology ? html`<span class="muted small">${snapshot.ideology}</span>` : null}</p>
        ${sourceLine(snapshot)}
        ${snapshot.note ? html`<p class="muted small">${snapshot.note}</p>` : null}
      </section>`
    : html`<section class="panel">
        <h3>Government</h3>
        <p class="muted">Mimir has no snapshot of this country yet.</p>
      </section>`}

  ${snapshot?.nextElectionDate
    ? html`<section class="panel">
        <h3>Election</h3>
        <p>${standing === 'now' ? html`<span class="badge world-badge election-now">Happening now</span>` : null}
          ${snapshot.nextElectionDate}
          <span class="muted small">${snapshot.nextElectionKind ?? 'election'}${days != null ? ` · in ${days} days` : ''}</span></p>
        ${snapshot.electionSource ? html`<p class="muted small">${snapshot.electionSource}</p>` : null}
      </section>`
    : null}

  ${snapshot?.state === 'stale'
    ? html`<section class="panel world-warning">
        <h3>Mimir noticed something</h3>
        <p class="muted">The news says this government may have changed. The snapshot above may be out of date.</p>
        ${stories.length ? html`<p class="muted small">${stories.length} ${stories.length === 1 ? 'story mentions' : 'stories mention'} this country.</p>` : null}
      </section>`
    : null}

  <section class="panel">
    <h3>Your news${activity && activity.stories ? html` <span class="muted small">${activity.stories} in the last ${ACTIVITY_DAYS} days</span>` : null}</h3>
    ${stories.length
      ? html`${storyList(stories, now)}
          <p class="muted small"><a href="/?q=${encodeURIComponent(name)}">All ${total} ${total === 1 ? 'story' : 'stories'} that name ${name} →</a></p>`
      : html`<p class="muted">No story names a place in ${name} yet.</p>`}
  </section>`;
  return layout(app, { title: name, nav: 'world', body });
}
