import type { App } from '../app.js';
import { html, type SafeHtml } from './html.js';

export type NavKey = 'stories' | 'world' | 'inbox' | 'saved' | 'review' | 'sources' | 'glossary' | 'profile' | 'stats' | 'none';

export interface ClassifierStatus {
  state: 'ready' | 'unconfigured' | 'paused';
  message: string | null;
}

export function classifierStatus(app: App): ClassifierStatus {
  if (!app.classifier.isConfigured()) {
    return { state: 'unconfigured', message: app.classifier.configurationHint() };
  }
  const paused = app.pipeline.breaker.pausedReason();
  if (paused) return { state: 'paused', message: `Classification ${paused}` };
  return { state: 'ready', message: null };
}

export function pageHeading(title: string, description?: string): SafeHtml {
  return html`<header class="page-heading"><h1>${title}</h1>${description ? html`<p>${description}</p>` : null}</header>`;
}

export function layout(app: App, opts: { title: string; nav: NavKey; body: SafeHtml; flash?: string | null }): SafeHtml {
  const status = classifierStatus(app);
  const counts = app.stats.overview();
  const articleNav = opts.nav === 'inbox' || opts.nav === 'saved' || opts.nav === 'review';
  const moreActive = ['sources', 'profile', 'stats', 'review'].includes(opts.nav);
  // The kind of list this page shows, and the digest it was drawn from: the page watches it.
  const liveKind = opts.nav === 'stories' ? 'stories' : articleNav ? 'articles' : opts.nav === 'glossary' ? 'terms' : null;
  const liveVersion = liveKind ? app.stories.liveVersions()[liveKind] : '';
  const link = (key: NavKey, href: string, label: string) =>
    html`<a href="${href}" class="${opts.nav === key ? 'active' : ''}" ${opts.nav === key ? html`aria-current="page"` : null}>${label}</a>`;
  const banner =
    status.state === 'unconfigured'
      ? html`<div class="banner warn" role="status"><strong>Classification pending configuration.</strong>
          Articles are being collected and queued (${counts.pending} pending). ${status.message}
          Pending articles are processed automatically once the key is set and Mimir restarts.</div>`
      : status.state === 'paused'
        ? html`<div class="banner error" role="status"><strong>Classifier unavailable.</strong> ${status.message}.
            Feed collection continues; queued articles will be retried.</div>`
        : null;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#121211" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f6f6f4" media="(prefers-color-scheme: light)">
<title>${opts.title} · Mimir</title>
<link rel="stylesheet" href="/static/app.css?v=reader-system-14">
<script>try{var f=+localStorage.getItem('mimir-font-size');if(f>=12&&f<=22)document.documentElement.style.fontSize=f+'px'}catch(e){}</script>
<script src="/static/app.js?v=reader-system-14" defer></script>
</head>
<body class="view-${opts.nav}" ${liveKind ? html`data-live="${liveKind}" data-live-version="${liveVersion}"` : null}>
<a class="skip-link" href="#main-content">Skip to content</a>
<header class="top">
  <div class="top-inner">
    <a class="brand" href="/" aria-label="Mimir home"><svg class="brand-mark" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18V6l9 8 9-8v12M3 6l9 5 9-5"/></svg><span>Mimir</span></a>
    <nav class="primary-nav" aria-label="Main navigation">
      ${link('stories', '/', 'Stories')}
      ${link('world', '/world', 'World')}
      ${link('inbox', '/articles', 'Articles')}
      ${link('saved', '/articles?saved=1&sort=discovered', 'Saved')}
      ${link('glossary', '/terms', 'Glossary')}
    </nav>
    <form class="search" action="${articleNav ? '/articles' : '/'}" method="get" role="search">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
      <input type="search" name="q" placeholder="${articleNav ? 'Search articles' : 'Search stories'}" aria-label="${articleNav ? 'Search articles' : 'Search stories'}">
    </form>
    <details class="workspace-menu ${moreActive ? 'current' : ''}">
      <summary aria-label="More navigation"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg><span class="menu-label">More</span></summary>
      <div class="workspace-popover">
        <span class="menu-heading">Your reader</span>
        <nav aria-label="Reader settings">
          ${link('sources', '/sources', 'Sources')}
          ${link('profile', '/profile', 'Interest profile')}
          ${link('stats', '/stats', 'Statistics')}
          ${link('review', '/articles?sort=rank_asc&status=classified', 'Review low scores')}
        </nav>
        <div class="font-setting">
          <label for="font-size"><span>Font size</span><span data-font-size-value>15px</span></label>
          <input type="range" id="font-size" data-font-size min="12" max="22" step="1" value="15">
          <button type="button" class="small" data-font-size-reset>Reset</button>
        </div>
        <div class="reader-status cls-${status.state}"><span class="status-dot" aria-hidden="true"></span><div>${status.state === 'ready' ? 'Classifier ready' : status.state === 'paused' ? 'Classifier paused' : 'Classifier not configured'}${counts.pending ? html`<small>${counts.pending} articles waiting</small>` : null}</div></div>
      </div>
    </details>
  </div>
</header>
${banner}
${opts.flash ? html`<div class="banner ok" role="status">${opts.flash}</div>` : null}
<main id="main-content" tabindex="-1">${opts.body}</main>
</body>
</html>`;
}
