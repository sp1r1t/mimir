import type { AppConfig } from './config.js';
import { RANK_FORMULA, rankScore } from './classification/ranking.js';
import { ClassifierError, type Classifier } from './classification/types.js';
import type { DB } from './db/database.js';
import { HostBusyError, TransientExtractionError, type ArticleExtractor } from './extraction/extractor.js';
import type { JobQueue, Job } from './jobs/queue.js';
import { JobError, JobWorker } from './jobs/worker.js';
import type { Logger } from './logger.js';
import type { ProfileRepository } from './profile/repository.js';
import type { ArticleRepository } from './repo/articles.js';
import { SourceConfigSchema, type SourceRepository } from './repo/sources.js';
import { backoffMs } from './util/backoff.js';
import { htmlToText } from './util/text.js';
import { iso, systemClock, type Clock } from './util/time.js';

export const EXTRACT = 'extract';
export const CLASSIFY = 'classify';

export interface ExtractPayload {
  articleId: number;
  force?: boolean;
}
export interface ClassifyPayload {
  articleId: number;
  /** Pin to a profile version (reclassification); otherwise the active profile at run time. */
  profileVersion?: number;
  force?: boolean;
}

/** Pauses calls to a failing downstream service so an outage does not burn job attempts. */
export class CircuitBreaker {
  private failures = 0;
  private pausedUntil = 0;
  lastError: string | null = null;
  lastErrorAt: string | null = null;

  constructor(
    private readonly threshold = 3,
    private readonly baseMs = 30_000,
    private readonly maxMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  pausedReason(): string | null {
    if (this.now() < this.pausedUntil) {
      return `paused until ${new Date(this.pausedUntil).toISOString()} after errors: ${this.lastError ?? 'unknown'}`;
    }
    return null;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  failure(message: string, minPauseMs = 0): void {
    this.failures++;
    this.lastError = message;
    this.lastErrorAt = new Date(this.now()).toISOString();
    if (this.failures >= this.threshold || minPauseMs > 0) {
      const pause = Math.max(minPauseMs, Math.min(this.maxMs, this.baseMs * 2 ** Math.max(0, this.failures - this.threshold)));
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + pause);
    }
  }

  success(): void {
    this.failures = 0;
    this.pausedUntil = 0;
  }
}

export interface PipelineDeps {
  db: DB;
  config: AppConfig;
  queue: JobQueue;
  articles: ArticleRepository;
  sources: SourceRepository;
  profiles: ProfileRepository;
  classifier: Classifier;
  extractor: ArticleExtractor;
  log: Logger;
  clock?: Clock;
  /** An article's current classification was set or replaced. */
  onClassified?: (articleId: number) => void;
}

/**
 * Post-ingestion processing: optional full-text extraction, then classification.
 * Both run as persistent jobs, independent of feed collection.
 */
export class Pipeline {
  readonly breaker = new CircuitBreaker();
  readonly extractWorker: JobWorker<ExtractPayload>;
  readonly classifyWorker: JobWorker<ClassifyPayload>;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private readonly clock: Clock;

  constructor(private readonly d: PipelineDeps) {
    this.clock = d.clock ?? systemClock;
    this.extractWorker = new JobWorker<ExtractPayload>(
      d.queue,
      {
        kind: EXTRACT,
        concurrency: d.config.extraction.concurrency,
        pollMs: d.config.jobs.pollMs,
        handler: (job, signal) => this.handleExtract(job, signal),
        backoff: (attempt) => backoffMs(attempt, 60_000, 30 * 60_000),
        onFinalFailure: (job, error) => {
          d.articles.setExtractionStatus(job.payload.articleId, 'failed', error);
          this.enqueueClassify(job.payload.articleId, { priority: job.priority });
        },
      },
      d.log.child({ worker: EXTRACT }),
    );
    this.classifyWorker = new JobWorker<ClassifyPayload>(
      d.queue,
      {
        kind: CLASSIFY,
        concurrency: d.config.classification.concurrency,
        pollMs: d.config.jobs.pollMs,
        handler: (job, signal) => this.handleClassify(job, signal),
        pausedReason: () =>
          d.classifier.isConfigured() ? this.breaker.pausedReason() : (d.classifier.configurationHint() ?? 'classifier not configured'),
        backoff: (attempt) => backoffMs(attempt, 30_000, 30 * 60_000),
        onFinalFailure: (job, error) => d.articles.markClassificationFailed(job.payload.articleId, error),
      },
      d.log.child({ worker: CLASSIFY }),
    );
  }

  start(): void {
    const recovered = this.d.queue.recoverInterrupted();
    if (recovered) this.d.log.info({ recovered }, 're-queued jobs interrupted by previous shutdown');
    this.reconcile();
    this.extractWorker.start();
    this.classifyWorker.start();
    this.reconcileTimer = setInterval(() => this.reconcile(), this.d.config.jobs.reconcileIntervalMs);
    this.reconcileTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await Promise.all([this.extractWorker.stop(), this.classifyWorker.stop()]);
  }

  /** Called inside the ingestion transaction for each new article. */
  onNewArticle(articleId: number): void {
    const a = this.d.articles.forExtraction(articleId);
    if (!a) return;
    const sourceCfg = SourceConfigSchema.parse(a.sourceConfig ? JSON.parse(a.sourceConfig) : {});
    const ex = this.d.config.extraction;
    const priority = recencyPriority(a.publishedAt, this.clock());
    let status: string | null = null;
    if (!ex.enabled || !sourceCfg.extractContent) status = 'disabled';
    else if (!a.url) status = 'unavailable';
    else if (a.textLength >= ex.minFeedChars) status = 'not_needed';
    if (status) {
      this.d.articles.setExtractionStatus(articleId, status, status === 'unavailable' ? 'No article URL' : null);
      this.enqueueClassify(articleId, { priority });
    } else {
      this.d.queue.enqueue(EXTRACT, `article:${articleId}`, { articleId }, { priority, maxAttempts: 3 });
    }
  }

  enqueueClassify(articleId: number, opts: { profileVersion?: number; force?: boolean; priority?: number } = {}): boolean {
    const key = opts.profileVersion != null ? `article:${articleId}:v${opts.profileVersion}` : `article:${articleId}`;
    const payload: ClassifyPayload = { articleId, ...(opts.profileVersion != null ? { profileVersion: opts.profileVersion } : {}), ...(opts.force ? { force: true } : {}) };
    const created = this.d.queue.enqueue(CLASSIFY, key, payload, {
      priority: opts.priority ?? 10,
      maxAttempts: this.d.config.classification.maxAttempts,
    });
    return created;
  }

  /** Queue reclassification against the active profile version. */
  reclassify(scope: { days?: number; onlyOutdated?: boolean; articleIds?: number[]; force?: boolean }): number {
    const profile = this.d.profiles.active();
    const ids =
      scope.articleIds ??
      this.d.articles.idsForReclassification({
        sinceIso: scope.days ? iso(new Date(this.clock().getTime() - scope.days * 86_400_000)) : undefined,
        onlyOutdatedVersion: scope.onlyOutdated ? profile.version : undefined,
      });
    let queued = 0;
    this.d.db.transaction(() => {
      for (const id of ids) {
        if (this.enqueueClassify(id, { profileVersion: profile.version, force: scope.force, priority: scope.articleIds ? 20 : 0 })) queued++;
      }
    })();
    this.d.log.info({ queued, version: profile.version, scope }, 'reclassification queued');
    this.classifyWorker.notify();
    return queued;
  }

  /** Re-queue failed classification and extraction jobs. */
  retryFailed(): number {
    const n = this.d.queue.retryFailed();
    this.d.db
      .prepare(`UPDATE article_state SET classification_status = 'pending' WHERE classification_status = 'failed'`)
      .run();
    this.breaker.success();
    this.classifyWorker.notify();
    this.extractWorker.notify();
    return n;
  }

  /** Repair lost work (e.g. after a crash) and prune old records. */
  reconcile(): void {
    try {
      const ids = this.d.articles.unclassifiedWithoutJob(1000);
      if (ids.length) {
        this.d.db.transaction(() => {
          for (const id of ids) {
            const a = this.d.articles.forExtraction(id);
            if (a?.extractionStatus === 'pending') this.onNewArticle(id);
            else this.enqueueClassify(id);
          }
        })();
        this.d.log.info({ count: ids.length }, 'reconciler queued unprocessed articles');
      }
      const prunedJobs = this.d.queue.prune(this.d.config.retention.jobsDays);
      const prunedFetches = this.d.sources.pruneFetchLog(this.d.config.retention.fetchLogDays);
      if (prunedJobs || prunedFetches) this.d.log.debug({ prunedJobs, prunedFetches }, 'pruned old records');
    } catch (err) {
      this.d.log.error({ err }, 'reconcile failed');
    }
  }

  notify(): void {
    this.extractWorker.notify();
    this.classifyWorker.notify();
  }

  private async handleExtract(job: Job<ExtractPayload>, signal: AbortSignal): Promise<void> {
    const { articleId, force } = job.payload;
    const a = this.d.articles.forExtraction(articleId);
    if (!a) return; // article deleted
    if (a.extractionStatus === 'pending' || force) {
      if (!a.url) {
        this.d.articles.setExtractionStatus(articleId, 'unavailable', 'No article URL');
      } else {
        try {
          const outcome = await this.d.extractor.extract(a.url, feedTextLength(a), signal);
          this.d.articles.applyExtraction(articleId, outcome);
        } catch (err) {
          if (err instanceof HostBusyError) {
            throw new JobError(err.message, { retryable: true, defer: true, delayMs: err.waitMs });
          }
          if (err instanceof TransientExtractionError) {
            throw new JobError(err.message, { retryable: true, delayMs: err.retryAfterMs ?? undefined });
          }
          throw err;
        }
      }
    }
    this.enqueueClassify(articleId, { priority: job.priority });
    this.classifyWorker.notify();
  }

  private async handleClassify(job: Job<ClassifyPayload>, signal: AbortSignal): Promise<void> {
    const { articleId, profileVersion, force } = job.payload;
    const article = this.d.articles.forClassification(articleId);
    if (!article) return;
    const profile = (profileVersion != null ? this.d.profiles.byVersion(profileVersion) : null) ?? this.d.profiles.active();
    const classifier = this.d.classifier;

    const hash = classifier.inputHash(article, profile);
    const prev = this.d.articles.latestClassificationFor(articleId, profile.version, classifier.version);
    if (prev && prev.inputHash === hash && !force) {
      this.setCurrent(articleId, prev.id);
      this.d.onClassified?.(articleId);
      return; // idempotent: identical input already classified
    }

    let result;
    try {
      result = await classifier.classify(article, profile, signal);
    } catch (err) {
      if (!(err instanceof ClassifierError)) throw err;
      switch (err.kind) {
        case 'auth':
          this.breaker.failure(err.message, 10 * 60_000);
          throw new JobError(err.message, { retryable: true, defer: true, delayMs: 60_000 });
        case 'unavailable':
          this.breaker.failure(err.message, err.retryAfterMs ?? 0);
          throw new JobError(err.message, { retryable: true, delayMs: err.retryAfterMs ?? undefined });
        case 'invalid_input':
          throw new JobError(err.message, { retryable: false });
        case 'bad_response':
          throw new JobError(err.message, { retryable: true });
      }
    }
    this.breaker.success();
    const topics = profile.definition.topics;
    const score = rankScore(
      {
        personalRelevance: result.personalRelevance,
        significance: result.significance,
        urgency: result.urgency,
        promotional: result.promotional,
        exclusion: result.exclusion,
        topics: result.categories.flatMap((c) => {
          const topic = topics.find((t) => t.id === c.id);
          return topic ? [{ topic, probability: c.probability }] : [];
        }),
      },
      profile.definition.ranking,
    );
    this.d.articles.saveClassification(articleId, profile, result, { score, formula: RANK_FORMULA });
    this.d.onClassified?.(articleId);
  }

  private setCurrent(articleId: number, classificationId: number): void {
    this.d.db
      .prepare(
        `UPDATE article_state SET current_classification_id = @cid, classification_status = 'classified', classification_error = NULL,
           rank_score = (SELECT rank_score FROM classifications WHERE id = @cid) WHERE article_id = @aid`,
      )
      .run({ cid: classificationId, aid: articleId });
  }
}

/** Recent articles are processed before backlog from newly added feeds. */
export function recencyPriority(publishedAt: string | null, now: Date): number {
  if (!publishedAt) return 5;
  const ageDays = (now.getTime() - Date.parse(publishedAt)) / 86_400_000;
  return ageDays <= 2 ? 10 : ageDays <= 14 ? 5 : 1;
}

/** Length of the feed text an extraction is allowed to replace, not a previous extraction. */
function feedTextLength(a: {
  contentSource: string;
  textLength: number;
  summaryText: string | null;
  contentHtml: string | null;
}): number {
  if (a.contentSource !== 'extracted') return a.textLength;
  return Math.max(a.summaryText?.length ?? 0, htmlToText(a.contentHtml).length);
}
