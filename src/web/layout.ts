import type { App } from '../app.js';
import { html, type SafeHtml } from './html.js';

export type NavKey = 'stories' | 'inbox' | 'saved' | 'review' | 'sources' | 'glossary' | 'profile' | 'stats' | 'none';

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

export function layout(app: App, opts: { title: string; nav: NavKey; body: SafeHtml; flash?: string | null }): SafeHtml {
  const status = classifierStatus(app);
  const counts = app.stats.overview();
  const articleNav = opts.nav === 'inbox' || opts.nav === 'saved' || opts.nav === 'review';
  const link = (key: NavKey, href: string, label: string) =>
    html`<a href="${href}" class="${opts.nav === key ? 'active' : ''}">${label}</a>`;
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
<title>${opts.title} · Mimir</title>
<link rel="stylesheet" href="/static/app.css?v=save-2">
<script src="/static/app.js?v=save-2" defer></script>
</head>
<body>
<header class="top">
  <a class="brand" href="/">Mimir</a>
  <nav>
    ${link('stories', '/', 'Stories')}
    ${link('inbox', '/articles', 'Articles')}
    ${link('review', '/articles?sort=rank_asc&status=classified', 'Low scores')}
    ${link('saved', '/articles?saved=1&sort=discovered', 'Saved')}
    ${link('glossary', '/terms', 'Glossary')}
    ${link('sources', '/sources', 'Sources')}
    ${link('profile', '/profile', 'Profile')}
    ${link('stats', '/stats', 'Stats')}
  </nav>
  <form class="search" action="${articleNav ? '/articles' : '/'}" method="get" role="search">
    <input type="search" name="q" placeholder="${articleNav ? 'Search articles' : 'Search stories'}" aria-label="Search">
  </form>
  <span class="cls-status cls-${status.state}" title="${status.message ?? 'Classifier ready'}">
    ${status.state === 'ready' ? 'Classifier ready' : status.state === 'paused' ? 'Classifier paused' : 'Classifier not configured'}
    ${counts.pending ? html` · ${counts.pending} pending` : null}
  </span>
</header>
${banner}
${opts.flash ? html`<div class="banner ok" role="status">${opts.flash}</div>` : null}
<main>${opts.body}</main>
</body>
</html>`;
}
