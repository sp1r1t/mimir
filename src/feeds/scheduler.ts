import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { Source, SourceRepository } from '../repo/sources.js';
import { backoffMs } from '../util/backoff.js';
import { addMs, iso, systemClock, type Clock } from '../util/time.js';
import { fetchFeed, FeedFetchError } from './fetcher.js';
import type { FeedIngestor, IngestResult } from './ingest.js';
import { FeedParseError, parseFeedDocument } from './parser.js';

export interface FetchOutcome {
  sourceId: number;
  outcome: 'ok' | 'not_modified' | 'error';
  result?: IngestResult;
  error?: string;
}

export interface SchedulerStats {
  fetches: number;
  failures: number;
  notModified: number;
  articlesCreated: number;
  lastTickAt: string | null;
  inFlight: number;
}

/**
 * Polls due sources with bounded concurrency. Scheduling state (next_fetch_at,
 * failure count, validators) lives in the database, so it survives restarts.
 */
export class FeedScheduler {
  private readonly inFlight = new Map<number, Promise<FetchOutcome>>();
  private readonly waiting = new Map<number, { promise: Promise<FetchOutcome>; resolve: (outcome: FetchOutcome) => void }>();
  private readonly abort = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  readonly stats: SchedulerStats = { fetches: 0, failures: 0, notModified: 0, articlesCreated: 0, lastTickAt: null, inFlight: 0 };

  constructor(
    private readonly sources: SourceRepository,
    private readonly ingestor: FeedIngestor,
    private readonly cfg: AppConfig['feeds'] & { userAgent: string },
    private readonly log: Logger,
    private readonly clock: Clock = systemClock,
    /** Called after a fetch stored new articles. */
    private readonly onNewArticles: () => void = () => {},
  ) {}

  start(): void {
    if (this.timer) return;
    const loop = () => {
      this.tick();
      if (!this.abort.signal.aborted) this.timer = setTimeout(loop, this.cfg.tickMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  async stop(timeoutMs = 15000): Promise<void> {
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    for (const [sourceId, request] of this.waiting) {
      request.resolve({ sourceId, outcome: 'error', error: 'interrupted by shutdown' });
    }
    this.waiting.clear();
    await Promise.race([Promise.allSettled([...this.inFlight.values()]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /** Start fetches for due sources, up to the concurrency limit. */
  tick(): void {
    this.stats.lastTickAt = iso(this.clock());
    const free = this.cfg.concurrency - this.inFlight.size;
    if (free <= 0 || this.abort.signal.aborted) return;
    let due: Source[];
    try {
      due = this.sources.due(free, [...this.inFlight.keys()]);
    } catch (err) {
      this.log.error({ err }, 'failed to query due sources');
      return;
    }
    for (const s of due) this.launch(s);
  }

  /** Fetch one source now (used by "fetch now" and tests). Reuses an in-flight fetch if there is one. */
  fetchNow(source: Source): Promise<FetchOutcome> {
    if (this.abort.signal.aborted) {
      return Promise.resolve({ sourceId: source.id, outcome: 'error', error: 'interrupted by shutdown' });
    }
    const existing = this.inFlight.get(source.id) ?? this.waiting.get(source.id)?.promise;
    if (existing) return existing;
    let resolve!: (outcome: FetchOutcome) => void;
    const promise = new Promise<FetchOutcome>((done) => { resolve = done; });
    this.waiting.set(source.id, { promise, resolve });
    this.drainWaiting();
    return promise;
  }

  private drainWaiting(): void {
    while (!this.abort.signal.aborted && this.inFlight.size < this.cfg.concurrency && this.waiting.size) {
      const [id, request] = this.waiting.entries().next().value!;
      this.waiting.delete(id);
      const source = this.sources.get(id);
      if (!source) {
        request.resolve({ sourceId: id, outcome: 'error', error: 'Source was deleted' });
        continue;
      }
      void this.launch(source).then(request.resolve);
    }
  }

  private launch(source: Source): Promise<FetchOutcome> {
    const p = this.fetchSource(source).finally(() => {
      this.inFlight.delete(source.id);
      this.stats.inFlight = this.inFlight.size;
      this.drainWaiting();
    });
    this.inFlight.set(source.id, p);
    this.stats.inFlight = this.inFlight.size;
    return p;
  }

  private nextSuccessAt(s: Source, from: Date): string {
    const interval = Math.max(s.pollIntervalSeconds, this.cfg.minPollSeconds) * 1000;
    const jitter = Math.round(interval * 0.05 * Math.random());
    return iso(addMs(from, interval + jitter));
  }

  private nextFailureAt(s: Source, from: Date, retryAfterMs: number | null): string {
    const failures = s.consecutiveFailures + 1;
    const interval = Math.max(s.pollIntervalSeconds, this.cfg.minPollSeconds) * 1000;
    const base = Math.min(interval, 15 * 60_000);
    const cap = Math.max(this.cfg.maxBackoffSeconds * 1000, interval);
    const delay = Math.max(backoffMs(failures, base, cap), retryAfterMs ?? 0);
    return iso(addMs(from, delay));
  }

  private async fetchSource(source: Source): Promise<FetchOutcome> {
    const started = this.clock();
    const log = this.log.child({ sourceId: source.id, source: source.name });
    let httpStatus: number | null = null;
    let attempts = 1;
    let bytes: number | null = null;
    try {
      const res = await fetchFeed(
        source.url,
        { etag: source.etag, lastModified: source.lastModified },
        {
          userAgent: this.cfg.userAgent,
          timeoutMs: this.cfg.timeoutMs,
          maxBytes: this.cfg.maxBytes,
          retries: this.cfg.retries,
          signal: this.abort.signal,
        },
      );
      httpStatus = res.status;
      attempts = res.attempts;
      const finished = this.clock();
      if (res.kind === 'not_modified') {
        this.sources.recordSuccess(source.id, { fetchedAt: iso(started), nextFetchAt: this.nextSuccessAt(source, finished), httpStatus: 304 });
        this.sources.logFetch(source.id, this.record(started, finished, 'not_modified', 304, attempts, null, undefined, null));
        this.stats.fetches++;
        this.stats.notModified++;
        log.debug('feed not modified');
        return { sourceId: source.id, outcome: 'not_modified' };
      }
      bytes = res.bytes;
      const feed = parseFeedDocument(res.body);
      const result = this.ingestor.ingest(feed, {
        sourceId: source.id,
        sourceName: source.name,
        feedUrl: res.finalUrl || source.url,
        fetchedAt: started,
      });
      const done = this.clock();
      this.sources.recordSuccess(source.id, {
        fetchedAt: iso(started),
        nextFetchAt: this.nextSuccessAt(source, done),
        httpStatus: res.status,
        etag: res.etag,
        lastModified: res.lastModified,
        feed: {
          format: feed.format,
          title: feed.title,
          siteUrl: feed.siteUrl,
          metadata: { ...feed.metadata, _fetch: { finalUrl: res.finalUrl, language: feed.language } },
        },
      });
      this.sources.logFetch(source.id, this.record(started, done, 'ok', res.status, attempts, bytes, result, null));
      this.stats.fetches++;
      this.stats.articlesCreated += result.created.length;
      if (result.created.length) this.onNewArticles();
      log.info(
        { status: res.status, entries: result.seen, new: result.created.length, updated: result.updated, linked: result.linked },
        'feed fetched',
      );
      return { sourceId: source.id, outcome: 'ok', result };
    } catch (err) {
      const done = this.clock();
      let message: string;
      let retryAfter: number | null = null;
      if (err instanceof FeedFetchError) {
        message = err.message;
        httpStatus = err.status;
        attempts = err.attempts;
        retryAfter = err.retryAfterMs;
      } else if (err instanceof FeedParseError) {
        message = err.message;
      } else {
        message = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
        log.error({ err }, 'unexpected error while fetching feed');
      }
      if (this.abort.signal.aborted) {
        // Shutdown interrupted the fetch: leave the source due so it is fetched after restart.
        return { sourceId: source.id, outcome: 'error', error: 'interrupted by shutdown' };
      }
      try {
        this.sources.recordFailure(source.id, {
          fetchedAt: iso(started),
          nextFetchAt: this.nextFailureAt(source, done, retryAfter),
          httpStatus,
          error: message,
        });
        this.sources.logFetch(source.id, this.record(started, done, 'error', httpStatus, attempts, bytes, undefined, message));
      } catch (dbErr) {
        log.error({ err: dbErr }, 'failed to record feed failure');
      }
      this.stats.fetches++;
      this.stats.failures++;
      log.warn({ status: httpStatus, error: message, failures: source.consecutiveFailures + 1 }, 'feed fetch failed');
      return { sourceId: source.id, outcome: 'error', error: message };
    }
  }

  private record(
    started: Date,
    finished: Date,
    outcome: 'ok' | 'not_modified' | 'error',
    httpStatus: number | null,
    attempts: number,
    bytes: number | null,
    result: IngestResult | undefined,
    error: string | null,
  ) {
    return {
      startedAt: iso(started),
      finishedAt: iso(finished),
      durationMs: finished.getTime() - started.getTime(),
      outcome,
      httpStatus,
      attempts,
      bytes,
      itemsSeen: result?.seen ?? 0,
      itemsNew: result?.created.length ?? 0,
      itemsUpdated: result?.updated ?? 0,
      error,
    };
  }
}
