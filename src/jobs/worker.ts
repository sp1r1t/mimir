import type { Logger } from '../logger.js';
import { sleep } from '../util/backoff.js';
import type { Job, JobQueue } from './queue.js';

/** Outcome a handler can signal by throwing. Any other error is treated as retryable. */
export class JobError extends Error {
  constructor(
    message: string,
    readonly opts: {
      /** false: fail immediately without further attempts. */
      retryable: boolean;
      /** Delay before the next attempt; defaults to the worker's backoff. */
      delayMs?: number;
      /** true: re-queue without consuming an attempt (service paused, not a job failure). */
      defer?: boolean;
    },
  ) {
    super(message);
    this.name = 'JobError';
  }
}

export interface WorkerOptions<P> {
  kind: string;
  concurrency: number;
  pollMs: number;
  handler: (job: Job<P>, signal: AbortSignal) => Promise<void>;
  /** When it returns a reason string, the worker does not claim new jobs. */
  pausedReason?: () => string | null;
  backoff: (attempt: number) => number;
  onFinalFailure?: (job: Job<P>, error: string) => void;
}

export interface WorkerStats {
  kind: string;
  running: number;
  processed: number;
  failed: number;
  retried: number;
  lastError: string | null;
  lastErrorAt: string | null;
  pausedReason: string | null;
}

/** Polls the queue for one job kind and runs handlers with bounded concurrency. */
export class JobWorker<P = Record<string, unknown>> {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  readonly stats: WorkerStats;

  constructor(
    private readonly queue: JobQueue,
    private readonly opts: WorkerOptions<P>,
    private readonly log: Logger,
  ) {
    this.stats = {
      kind: opts.kind,
      running: 0,
      processed: 0,
      failed: 0,
      retried: 0,
      lastError: null,
      lastErrorAt: null,
      pausedReason: null,
    };
  }

  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  /** Nudge the worker to poll immediately (e.g. after enqueueing). */
  notify(): void {
    this.wakeUp?.();
  }

  /** Stop claiming new jobs and wait for in-flight jobs (bounded by `timeoutMs`). */
  async stop(timeoutMs = 15000): Promise<void> {
    this.abort.abort();
    this.notify();
    await this.loop;
    const pending = Promise.allSettled([...this.inFlight]);
    await Promise.race([pending, sleep(timeoutMs)]);
  }

  private async run(): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      try {
        this.tick();
      } catch (err) {
        this.log.error({ err, kind: this.opts.kind }, 'job worker tick failed');
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.opts.pollMs);
        this.wakeUp = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wakeUp = null;
    }
  }

  private tick(): void {
    const paused = this.opts.pausedReason?.() ?? null;
    this.stats.pausedReason = paused;
    if (paused) return;
    const free = this.opts.concurrency - this.inFlight.size;
    if (free <= 0) return;
    for (const job of this.queue.claim<P>(this.opts.kind, free)) {
      const p = this.execute(job).finally(() => {
        this.inFlight.delete(p);
        this.stats.running = this.inFlight.size;
        this.notify();
      });
      this.inFlight.add(p);
      this.stats.running = this.inFlight.size;
    }
  }

  private async execute(job: Job<P>): Promise<void> {
    const log = this.log.child({ kind: job.kind, jobId: job.id, attempt: job.attempts });
    const started = Date.now();
    try {
      await this.opts.handler(job, this.abort.signal);
      this.queue.complete(job.id);
      this.stats.processed++;
      log.debug({ ms: Date.now() - started }, 'job done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.abort.signal.aborted) {
        // Interrupted by shutdown: not the job's fault.
        this.queue.defer(job.id, 0);
        log.info('job interrupted by shutdown; re-queued');
        return;
      }
      this.stats.lastError = message;
      this.stats.lastErrorAt = new Date().toISOString();
      if (err instanceof JobError && err.opts.defer) {
        this.queue.defer(job.id, err.opts.delayMs ?? this.opts.backoff(1), message);
        log.debug({ reason: message }, 'job deferred');
        return;
      }
      const retryable = !(err instanceof JobError) || err.opts.retryable;
      if (!retryable) {
        this.queue.fail(job.id, message);
        this.stats.failed++;
        log.warn({ error: message }, 'job failed permanently');
        this.opts.onFinalFailure?.(job, message);
        return;
      }
      const delay = (err instanceof JobError ? err.opts.delayMs : undefined) ?? this.opts.backoff(job.attempts);
      const status = this.queue.retryOrFail(job.id, message, delay);
      if (status === 'failed') {
        this.stats.failed++;
        log.warn({ error: message }, 'job failed after max attempts');
        this.opts.onFinalFailure?.(job, message);
      } else {
        this.stats.retried++;
        log.info({ error: message, retryInMs: delay }, 'job will be retried');
      }
    }
  }
}
