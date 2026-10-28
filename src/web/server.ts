import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import formbody from '@fastify/formbody';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { App } from '../app.js';
import { PUBLIC_DIR } from '../paths.js';
import { isEventType } from '../repo/feedback.js';
import type { Source } from '../repo/sources.js';
import { STORY_RELEVANCE_EVENTS, type StoryRelevanceEvent } from '../stories/repository.js';
import { isHttpUrl } from '../util/url.js';
import { discoverFeed } from './discover.js';
import { SafeHtml } from './html.js';
import { classifierStatus } from './layout.js';
import { metricsText } from './metrics.js';
import { articlePage } from './pages/article.js';
import { inboxPage, parseFilters } from './pages/inbox.js';
import { definitionFromForm, profilePage, profileVersionPage } from './pages/profile.js';
import { sourceDetailPage, sourcesPage } from './pages/sources.js';
import { statsPage } from './pages/stats.js';
import { parseStoryFilters, relevantNewCount, resolveStoryQuery, storiesPage, storyPage } from './pages/stories.js';
import { glossaryPage } from './pages/terms.js';

type Body = Record<string, string | string[] | undefined>;
type Query = Record<string, string | undefined>;

/** What may be served from the public directory, and as what. */
const STATIC_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function send(reply: FastifyReply, page: SafeHtml, status = 200): FastifyReply {
  return reply.code(status).type('text/html; charset=utf-8').send(page.value);
}

function redirect(reply: FastifyReply, to: string, flash?: string): FastifyReply {
  const sep = to.includes('?') ? '&' : '?';
  return reply.redirect(flash ? `${to}${sep}flash=${encodeURIComponent(flash)}` : to, 303);
}

function str(body: Body | undefined, key: string): string {
  const v = body?.[key];
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
}

function zodMessage(err: unknown): string {
  if (err instanceof ZodError) return err.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
  return err instanceof Error ? err.message : String(err);
}

function wantsJson(req: FastifyRequest): boolean {
  return (req.headers.accept ?? '').includes('application/json') || req.url.startsWith('/api/');
}

function idParam(req: FastifyRequest): number {
  const id = Number((req.params as { id: string }).id);
  return Number.isInteger(id) && id > 0 ? id : -1;
}

export function buildServer(app: App): FastifyInstance {
  const server = Fastify({
    loggerInstance: app.log.child({ component: 'http' }) as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });
  server.register(formbody);

  // Optional HTTP basic auth (health endpoints stay open for container orchestration).
  const auth = app.config.basicAuth;
  server.addHook('onRequest', async (req, reply) => {
    if (!auth || req.url === '/healthz' || req.url === '/readyz') return;
    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    let ok = false;
    if (scheme === 'Basic' && encoded) {
      const expected = Buffer.from(`${auth.user}:${auth.password}`);
      const given = Buffer.from(Buffer.from(encoded, 'base64').toString('utf8'));
      ok = given.length === expected.length && timingSafeEqual(given, expected);
    }
    if (!ok) return reply.code(401).header('WWW-Authenticate', 'Basic realm="Mimir"').send('Authentication required');
  });

  // Reject cross-site form posts.
  server.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.origin;
    if (!origin) return;
    try {
      if (new URL(origin).host !== req.headers.host) return reply.code(403).send('Cross-origin request rejected');
    } catch {
      return reply.code(403).send('Invalid origin');
    }
  });

  server.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/static/') || req.url === '/healthz') return;
    req.log.debug({ method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
  });

  server.setErrorHandler((err, req, reply) => {
    req.log.error({ err, url: req.url }, 'request failed');
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (wantsJson(req)) return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    return reply.code(status).type('text/plain').send(`Error: ${err instanceof Error ? err.message : String(err)}`);
  });

  const staticCache = new Map<string, Buffer>();
  server.get('/static/*', async (req, reply) => {
    const file = (req.params as { '*': string })['*'];
    const type = STATIC_TYPES[extname(file).toLowerCase()];
    if (!type) return reply.code(404).send('Not found');
    const path = join(PUBLIC_DIR, file);
    const inside = relative(PUBLIC_DIR, path);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return reply.code(404).send('Not found');
    let body = staticCache.get(file);
    if (!body) {
      try {
        body = readFileSync(path);
      } catch {
        return reply.code(404).send('Not found');
      }
      staticCache.set(file, body);
    }
    return reply.type(type).header('Cache-Control', 'public, max-age=300').send(body);
  });

  // ---- Health & metrics ----------------------------------------------------
  server.get('/healthz', async (_req, reply) => {
    try {
      app.db.prepare('SELECT 1').get();
      return reply.send({ status: 'ok' });
    } catch (err) {
      return reply.code(503).send({ status: 'error', error: String(err) });
    }
  });
  server.get('/readyz', async (_req, reply) => reply.send(health(app)));
  server.get('/api/health', async (_req, reply) => reply.send(health(app)));
  server.get('/metrics', async (_req, reply) => reply.type('text/plain; version=0.0.4').send(metricsText(app)));

  // ---- Stories ---------------------------------------------------------------
  server.get('/', async (req, reply) => {
    const q = req.query as Query;
    return send(reply, storiesPage(app, resolveStoryQuery(q), q.flash));
  });

  server.get('/stories/:id', async (req, reply) => {
    const id = idParam(req);
    const target = app.stories.resolve(id);
    if (target == null) return reply.code(404).send('Story not found');
    if (target !== id) return reply.redirect(`/stories/${target}`, 301);
    const q = req.query as Query;
    return send(reply, storyPage(app, app.stories.get(id)!, q.flash, q.map === '1'));
  });

  /**
   * The page watches its story. The server sends an event whenever something the page
   * shows has changed — a brief written, places found, an article that joined the story
   * — and the page puts the new content in place by itself.
   */
  const openStreams = new Set<ServerResponse>();
  // The streams have to end before the server closes: a connection that is still open
  // would keep it waiting for a reader that has gone.
  server.addHook('preClose', async () => {
    for (const res of openStreams) {
      try {
        res.end();
      } catch {
        // The reader is gone already.
      }
    }
    openStreams.clear();
  });

  server.get('/api/stories/:id/events', async (req, reply) => {
    const id = app.stories.resolve(idParam(req));
    if (id == null) return reply.code(404).send({ error: 'Story not found' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      // A proxy that buffers would hold the events back until the stream ends.
      'X-Accel-Buffering': 'no',
    });
    openStreams.add(res);
    let version = app.stories.storyVersion(id);
    const stop = () => {
      clearInterval(watch);
      clearInterval(beat);
      openStreams.delete(res);
      if (!res.writableEnded) res.end();
    };
    const send = (data: { version: string }) => {
      try {
        res.write(`event: change\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        stop();
      }
    };
    const watch = setInterval(() => {
      const now = app.stories.storyVersion(id);
      if (now === version) return;
      version = now;
      send({ version });
    }, 1000);
    // A comment now and then keeps the connection alive through the quiet moments.
    const beat = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        stop();
      }
    }, 20_000);
    res.on('error', stop);
    req.raw.on('close', stop);
    res.write('retry: 3000\n\n');
    send({ version });
    return reply;
  });

  /** The same watch, for a browser that cannot hold an event stream open. */
  server.get('/api/stories/:id/state', async (req, reply) => {
    const id = app.stories.resolve(idParam(req));
    if (id == null) return reply.code(404).send({ error: 'Story not found' });
    return reply.send({ version: app.stories.storyVersion(id) });
  });

  const seenHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = app.stories.resolve(idParam(req));
    if (id == null) return reply.code(404).send({ error: 'Story not found' });
    const body = (req.body ?? {}) as Body & { state?: string };
    const state = (typeof body.state === 'string' ? body.state : str(body, 'state')) === 'unseen' ? 'unseen' : 'seen';
    if (state === 'seen') app.stories.markSeen(id);
    else app.stories.markUnseen(id);
    if (wantsJson(req)) {
      return reply.send({ ok: true, unseen: app.stories.item(id)!.unseen, relevantNew: relevantNewCount(app) });
    }
    return reply.redirect(req.headers.referer ?? `/stories/${id}`, 303);
  };
  server.post('/stories/:id/seen', seenHandler);
  server.post('/api/stories/:id/seen', seenHandler);

  const storyFeedbackHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = app.stories.resolve(idParam(req));
    if (id == null) return reply.code(404).send({ error: 'Story not found' });
    const type = str((req.body ?? {}) as Body, 'type');
    if (!STORY_RELEVANCE_EVENTS.includes(type as StoryRelevanceEvent)) return reply.code(400).send({ error: 'Unknown story feedback type' });
    app.stories.recordRelevance(id, type as StoryRelevanceEvent, { via: wantsJson(req) ? 'api' : 'form' });
    if (wantsJson(req)) return reply.send({ ok: true, state: { relevanceLabel: app.stories.item(id)!.relevanceLabel } });
    return reply.redirect(`/stories/${id}`, 303);
  };
  server.post('/stories/:id/feedback', storyFeedbackHandler);
  server.post('/api/stories/:id/feedback', storyFeedbackHandler);

  server.post('/stories/seen-all', async (req, reply) => {
    const params = new URLSearchParams(str((req.body ?? {}) as Body, 'query'));
    const n = app.stories.markSeenMatching(parseStoryFilters(Object.fromEntries(params)));
    const back = params.toString();
    return redirect(reply, back ? `/?${back}` : '/?view=all', `Marked ${n} ${n === 1 ? 'story' : 'stories'} as seen.`);
  });

  const summaryHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = app.stories.resolve(idParam(req));
    if (id == null) return reply.code(404).send({ error: 'Story not found' });
    if (!app.summaries.isConfigured()) return reply.code(409).send({ error: app.summaries.configurationHint() });
    const res = app.storyPipeline.requestSummary(id);
    if (wantsJson(req)) return reply.code(res.queued ? 202 : 200).send(res);
    return redirect(reply, `/stories/${id}`, res.message);
  };
  server.post('/stories/:id/summary', summaryHandler);
  server.post('/api/stories/:id/summary', summaryHandler);

  const placesHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = app.stories.resolve(idParam(req));
    if (id == null) return reply.code(404).send({ error: 'Story not found' });
    const res = app.storyPipeline.requestPlaces(id);
    if (wantsJson(req)) return reply.code(res.queued ? 202 : 200).send(res);
    return redirect(reply, `/stories/${id}?map=1`, res.message);
  };
  server.post('/stories/:id/places', placesHandler);
  server.post('/api/stories/:id/places', placesHandler);

  server.get('/api/stories/:id/places', async (req, reply) => {
    const id = app.stories.resolve(idParam(req));
    if (id == null) return reply.code(404).send({ error: 'Story not found' });
    const state = app.stories.placesState(id);
    return reply.send({ state: state.state, error: state.error, places: app.stories.places(id) });
  });

  // ---- Terms ----------------------------------------------------------------
  // The reader asks for the glossary of a story; the terms are then looked up in the
  // encyclopedia, and a term Mimir already knows is not looked up again.

  const termsHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = app.stories.resolve(idParam(req));
    if (id == null) return reply.code(404).send({ error: 'Story not found' });
    const res = app.storyPipeline.requestTerms(id);
    if (wantsJson(req)) return reply.code(res.queued ? 202 : 200).send(res);
    return redirect(reply, `/stories/${id}`, res.message);
  };
  server.post('/stories/:id/terms', termsHandler);
  server.post('/api/stories/:id/terms', termsHandler);

  server.get('/api/stories/:id/terms', async (req, reply) => {
    const id = app.stories.resolve(idParam(req));
    if (id == null) return reply.code(404).send({ error: 'Story not found' });
    const state = app.stories.termsState(id);
    return reply.send({ state: state.state, error: state.error, terms: app.stories.termsOf(id) });
  });

  /** One term of the glossary: what the reader sees when a term is tapped. */
  server.get('/api/terms/:key', async (req, reply) => {
    const key = decodeURIComponent((req.params as { key: string }).key ?? '');
    const term = app.stories.termByKey(key);
    if (!term) return reply.code(404).send({ error: 'Term not found' });
    return reply.send({
      key: term.key,
      name: term.name,
      kind: term.kind,
      summary: term.summary,
      description: term.description,
      sourceName: term.sourceName,
      sourceUrl: term.sourceUrl,
      status: term.status,
    });
  });

  server.get('/terms', async (_req, reply) => send(reply, glossaryPage(app)));

  server.post('/stories/:id/reassess', async (req, reply) => {
    const id = app.stories.resolve(idParam(req));
    if (id == null) return reply.code(404).send('Story not found');
    app.storyPipeline.enqueueAssess(id);
    return redirect(reply, `/stories/${id}`, 'Recalculation queued.');
  });

  server.post('/stories/:id/merge', async (req, reply) => {
    const id = idParam(req);
    const body = (req.body ?? {}) as Body;
    const target = Number(str(body, 'targetId') || str(body, 'target'));
    if (!Number.isInteger(target) || target <= 0) return redirect(reply, `/stories/${id}`, 'Choose a story to merge into.');
    try {
      app.storyPipeline.merge(id, target);
    } catch (err) {
      return redirect(reply, `/stories/${id}`, `Not merged: ${zodMessage(err)}`);
    }
    return redirect(reply, `/stories/${app.stories.resolve(target)}`, `Merged story ${id} into this story.`);
  });

  server.post('/stories/:id/split', async (req, reply) => {
    const id = idParam(req);
    const raw = ((req.body ?? {}) as Body).articleIds;
    const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return redirect(reply, `/stories/${id}`, 'Select the articles to move.');
    try {
      const created = app.storyPipeline.split(id, ids);
      return redirect(reply, `/stories/${created}`, `Moved ${ids.length} article${ids.length === 1 ? '' : 's'} out of story ${id}.`);
    } catch (err) {
      return redirect(reply, `/stories/${id}`, `Not split: ${zodMessage(err)}`);
    }
  });

  server.get('/api/stories', async (req, reply) => reply.send(app.stories.list(parseStoryFilters(req.query as Query))));
  server.get('/api/stories/:id', async (req, reply) => {
    const id = app.stories.resolve(idParam(req));
    const s = id == null ? null : app.stories.get(id);
    return s ? reply.send(s) : reply.code(404).send({ error: 'Story not found' });
  });

  // ---- Articles --------------------------------------------------------------
  server.get('/articles', async (req, reply) => {
    const q = req.query as Query;
    return send(reply, inboxPage(app, q, q.flash));
  });

  server.get('/articles/:id', async (req, reply) => {
    const id = idParam(req);
    const a = app.articles.get(id);
    if (!a) return reply.code(404).send('Article not found');
    app.feedback.record(id, 'view');
    return send(reply, articlePage(app, a, (req.query as Query).flash));
  });

  server.get('/go/:id', async (req, reply) => {
    const id = idParam(req);
    const a = app.articles.get(id);
    if (!a?.url || !isHttpUrl(a.url)) return reply.code(404).send('No original URL');
    app.feedback.record(id, 'open_original');
    return reply.redirect(a.url, 302);
  });

  const feedbackHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = idParam(req);
    const body = (req.body ?? {}) as Body & { type?: string; context?: Record<string, unknown> };
    const type = typeof body.type === 'string' ? body.type : str(body, 'type');
    if (!isEventType(type)) return reply.code(400).send({ error: `Unknown feedback type "${type}"` });
    if (!app.articles.exists(id)) return reply.code(404).send({ error: 'Article not found' });
    app.feedback.record(id, type, typeof body.context === 'object' && body.context ? body.context : { via: wantsJson(req) ? 'api' : 'form' });
    const a = app.articles.get(id)!;
    if (wantsJson(req)) {
      return reply.send({ ok: true, state: { relevanceLabel: a.relevanceLabel, preference: a.preference, savedAt: a.savedAt } });
    }
    return reply.redirect(req.headers.referer ?? `/articles/${id}`, 303);
  };
  server.post('/articles/:id/feedback', feedbackHandler);
  server.post('/api/articles/:id/feedback', feedbackHandler);

  server.post('/articles/:id/reclassify', async (req, reply) => {
    const id = idParam(req);
    if (!app.articles.exists(id)) return reply.code(404).send('Article not found');
    const n = app.pipeline.reclassify({ articleIds: [id], force: true });
    return redirect(reply, `/articles/${id}`, n ? 'Reclassification queued.' : 'Already queued.');
  });

  // ---- Sources -------------------------------------------------------------
  server.get('/sources', async (req, reply) => send(reply, sourcesPage(app, (req.query as Query).flash)));

  server.post('/sources', async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const result = await createOrUpdateSource(app, body, null);
    if ('error' in result) return send(reply, sourcesPage(app, null, result.error, result.draft), 400);
    app.scheduler.fetchNow(result.source).catch(() => {});
    return redirect(reply, `/sources/${result.source.id}`, `Added “${result.source.name}”. First fetch started.`);
  });

  server.get('/sources/:id', async (req, reply) => {
    const s = app.sources.get(idParam(req));
    if (!s) return reply.code(404).send('Source not found');
    return send(reply, sourceDetailPage(app, s, (req.query as Query).flash));
  });

  server.post('/sources/:id', async (req, reply) => {
    const s = app.sources.get(idParam(req));
    if (!s) return reply.code(404).send('Source not found');
    const result = await createOrUpdateSource(app, (req.body ?? {}) as Body, s);
    if ('error' in result) return send(reply, sourceDetailPage(app, s, null, result.error), 400);
    return redirect(reply, `/sources/${s.id}`, 'Saved.');
  });

  server.post('/sources/:id/toggle', async (req, reply) => {
    const s = app.sources.get(idParam(req));
    if (!s) return reply.code(404).send('Source not found');
    app.sources.setEnabled(s.id, !s.enabled);
    return redirect(reply, req.headers.referer?.includes(`/sources/${s.id}`) ? `/sources/${s.id}` : '/sources', `${s.name} ${s.enabled ? 'disabled' : 'enabled'}.`);
  });

  server.post('/sources/:id/fetch', async (req, reply) => {
    const s = app.sources.get(idParam(req));
    if (!s) return reply.code(404).send('Source not found');
    const outcome = await app.scheduler.fetchNow(s);
    const msg =
      outcome.outcome === 'ok'
        ? `Fetched: ${outcome.result?.seen ?? 0} entries, ${outcome.result?.created.length ?? 0} new.`
        : outcome.outcome === 'not_modified'
          ? 'Feed not modified since last fetch.'
          : `Fetch failed: ${outcome.error}`;
    return redirect(reply, req.headers.referer?.includes(`/sources/${s.id}`) ? `/sources/${s.id}` : '/sources', msg);
  });

  server.post('/sources/:id/delete', async (req, reply) => {
    const s = app.sources.get(idParam(req));
    if (!s) return reply.code(404).send('Source not found');
    app.sources.delete(s.id);
    return redirect(reply, '/sources', `Deleted “${s.name}”. Its articles were kept.`);
  });

  server.get('/api/sources', async (_req, reply) => reply.send(app.sources.list()));
  server.post('/api/sources', async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const result = await createOrUpdateSource(app, body, null);
    if ('error' in result) return reply.code(400).send({ error: result.error });
    app.scheduler.fetchNow(result.source).catch(() => {});
    return reply.code(201).send(result.source);
  });

  // ---- Profile ---------------------------------------------------------------
  server.get('/profile', async (req, reply) => send(reply, profilePage(app, (req.query as Query).flash)));

  server.post('/profile', async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    try {
      const def = definitionFromForm(body, app.profiles.active().definition);
      const { profile, changed } = app.profiles.createVersion(def, { changeNote: str(body, 'changeNote') || undefined, author: 'user' });
      return redirect(reply, '/profile', changed ? `Saved as version ${profile.version}. Reclassify below to apply it to existing articles.` : 'No changes.');
    } catch (err) {
      return send(reply, profilePage(app, null, `Not saved: ${zodMessage(err)}`), 400);
    }
  });

  server.post('/profile/json', async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    try {
      const parsed = JSON.parse(str(body, 'definition'));
      const { profile, changed } = app.profiles.createVersion(parsed, { changeNote: str(body, 'changeNote') || undefined, author: 'user' });
      return redirect(reply, '/profile', changed ? `Saved as version ${profile.version}.` : 'No changes.');
    } catch (err) {
      return send(reply, profilePage(app, null, `Not saved: ${zodMessage(err)}`), 400);
    }
  });

  server.get('/profile/versions/:version', async (req, reply) => {
    const v = app.profiles.byVersion(Number((req.params as { version: string }).version));
    if (!v) return reply.code(404).send('Version not found');
    return send(reply, profileVersionPage(app, v));
  });

  server.post('/profile/versions/:version/activate', async (req, reply) => {
    try {
      const v = app.profiles.activate(Number((req.params as { version: string }).version));
      return redirect(reply, '/profile', `Version ${v.version} is active.`);
    } catch (err) {
      return redirect(reply, '/profile', zodMessage(err));
    }
  });

  server.post('/profile/reclassify', async (req, reply) => {
    const scope = str((req.body ?? {}) as Body, 'scope');
    const [mode, range] = scope.split('-');
    const days = range === 'all' ? undefined : Number(range) || 7;
    const n = app.pipeline.reclassify({ days, onlyOutdated: mode === 'outdated', force: mode === 'all' });
    const note = app.classifier.isConfigured() ? '' : ' They will run once the classifier is configured.';
    return redirect(reply, '/profile', `Queued ${n} article${n === 1 ? '' : 's'} for reclassification.${note}`);
  });

  server.get('/api/profile', async (_req, reply) => reply.send(app.profiles.active()));
  server.get('/api/profile/versions', async (_req, reply) => reply.send(app.profiles.list()));
  /** Replace the profile definition (creates a new version). Intended for scripts and future agents. */
  server.put('/api/profile', async (req, reply) => {
    const body = (req.body ?? {}) as { definition?: unknown; changeNote?: string; author?: 'user' | 'agent' };
    try {
      const res = app.profiles.createVersion(body.definition, {
        changeNote: body.changeNote,
        author: body.author === 'agent' ? 'agent' : 'user',
      });
      return reply.send(res);
    } catch (err) {
      return reply.code(400).send({ error: zodMessage(err) });
    }
  });
  server.post('/api/reclassify', async (req, reply) => {
    const body = (req.body ?? {}) as { days?: number; onlyOutdated?: boolean; articleIds?: number[]; force?: boolean };
    return reply.send({ queued: app.pipeline.reclassify(body) });
  });

  // ---- Stats & jobs ----------------------------------------------------------
  server.get('/stats', async (req, reply) => send(reply, statsPage(app, (req.query as Query).flash)));
  server.post('/jobs/retry-failed', async (_req, reply) => {
    const n = app.pipeline.retryFailed();
    app.storyPipeline.resumeAfterRetry();
    return redirect(reply, '/stats', `Re-queued ${n} failed job${n === 1 ? '' : 's'}.`);
  });

  // ---- JSON API: articles --------------------------------------------------
  server.get('/api/articles', async (req, reply) => reply.send(app.articles.list(parseFilters(req.query as Query))));
  server.get('/api/articles/:id', async (req, reply) => {
    const a = app.articles.get(idParam(req));
    return a ? reply.send(a) : reply.code(404).send({ error: 'Article not found' });
  });
  server.get('/api/stats', async (_req, reply) =>
    reply.send({
      overview: app.stats.overview(),
      daily: app.stats.daily(14),
      relevanceHistogram: app.stats.relevanceHistogram(),
      categories: app.stats.categoryCounts(),
      feedbackAgreement: app.stats.feedbackAgreement(),
      storyFeedbackAgreement: app.stats.storyFeedbackAgreement(),
      jobs: app.queue.counts(),
    }),
  );

  return server;
}

export function health(app: App) {
  const status = classifierStatus(app);
  const o = app.stats.overview();
  return {
    status: 'ok',
    startedAt: app.startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - app.startedAt.getTime()) / 1000),
    feeds: {
      sources: o.sources,
      enabled: o.sourcesEnabled,
      failing: o.sourcesFailing,
      lastSchedulerTick: app.scheduler.stats.lastTickAt,
      inFlight: app.scheduler.stats.inFlight,
    },
    classifier: {
      name: app.classifier.name,
      version: app.classifier.version,
      state: status.state,
      message: status.message,
      pending: o.pending,
      failed: o.failed,
    },
    articles: o.articles,
    stories: app.stories.counts(),
    summaries: {
      provider: app.summaries.name,
      model: app.summaries.model,
      paused: app.storyPipeline.summaryPausedReason(),
      allowance: app.summaries.allowance(),
    },
    jobs: app.queue.counts(),
  };
}

async function createOrUpdateSource(
  app: App,
  body: Body,
  existing: Source | null,
): Promise<{ source: Source } | { error: string; draft: Partial<Source> }> {
  let url = str(body, 'url');
  const minutes = Number(str(body, 'pollMinutes')) || app.config.feeds.defaultPollSeconds / 60;
  const pollIntervalSeconds = Math.max(Math.round(minutes * 60), app.config.feeds.minPollSeconds);
  const config = {
    extractContent: !!str(body, 'extractContent'),
    tags: str(body, 'tags')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  };
  const enabled = existing ? !!str(body, 'enabled') : str(body, 'enabled') !== '' || body.enabled === undefined;
  let name = str(body, 'name');
  const draft: Partial<Source> = { url, name, pollIntervalSeconds, enabled, config: { ...config, notes: '' } };

  if (!isHttpUrl(url)) return { error: 'Enter a valid http(s) feed URL.', draft };
  if (!existing || existing.url !== url) {
    try {
      const found = await discoverFeed(url, { userAgent: app.config.userAgent, timeoutMs: app.config.feeds.timeoutMs, maxBytes: app.config.feeds.maxBytes });
      url = found.url;
      if (!name) name = found.feed.title ?? new URL(url).hostname;
    } catch (err) {
      return { error: `Could not read a feed at this URL: ${err instanceof Error ? err.message : String(err)}`, draft };
    }
    const dup = app.sources.byUrl(url);
    if (dup && dup.id !== existing?.id) return { error: `This feed is already subscribed as “${dup.name}”.`, draft };
  }
  if (!name) name = existing?.name ?? new URL(url).hostname;
  const input = { name, url, pollIntervalSeconds, enabled, config };
  const source = existing ? app.sources.update(existing.id, input) : app.sources.create(input);
  return { source };
}
