import type { AppConfig } from '../config.js';
import type { Job, JobQueue } from '../jobs/queue.js';
import { JobError, JobWorker } from '../jobs/worker.js';
import type { Logger } from '../logger.js';
import { backoffMs } from '../util/backoff.js';
import { iso, systemClock, type Clock } from '../util/time.js';
import { mapCountries } from './countries.js';
import { WorldFetcher, type WorldCountryRef } from './fetch.js';
import type { WorldRepository } from './repository.js';
import type { WikidataReader } from './wikidata.js';

export const WORLD_FETCH = 'world_fetch';

export interface WorldFetchPayload {
  /** true when a person asked for the fetch rather than the schedule. */
  manual?: boolean;
}

export interface WorldPipelineDeps {
  config: AppConfig;
  queue: JobQueue;
  world: WorldRepository;
  wikidata: WikidataReader;
  /** The countries the map draws; the fetcher asks Wikidata about each of them. */
  countries?: WorldCountryRef[];
  log: Logger;
  clock?: Clock;
}

/**
 * The world snapshot, read as a job.
 *
 * Wikidata is a public service that asks to be treated politely, so the reading
 * is slow: it asks for the countries, then for their governments, then for the
 * parties, then for where those parties stand, then for the elections. Doing it
 * as a job means a restart does not lose it and a failure is retried without
 * anyone watching.
 */
export class WorldPipeline {
  readonly fetchWorker: JobWorker<WorldFetchPayload>;
  private readonly clock: Clock;
  private readonly countries: WorldCountryRef[];

  constructor(private readonly d: WorldPipelineDeps) {
    this.clock = d.clock ?? systemClock;
    this.countries = d.countries ?? mapCountries();
    this.fetchWorker = new JobWorker<WorldFetchPayload>(
      d.queue,
      {
        kind: WORLD_FETCH,
        // One at a time: two readings of the world at once would fight over the rows.
        concurrency: 1,
        pollMs: d.config.jobs.pollMs,
        handler: (job, signal) => this.handleFetch(job, signal),
        backoff: (attempt) => backoffMs(attempt, 10 * 60_000, 6 * 60 * 60_000),
        onFinalFailure: (job, error) => {
          // The rows are the last good ones, and they are old now.
          const marked = d.world.markStale();
          d.log.warn({ error, marked }, 'the world snapshot could not be read');
        },
      },
      d.log.child({ worker: WORLD_FETCH }),
    );
  }

  start(): void {
    this.fetchWorker.start();
  }

  async stop(): Promise<void> {
    await this.fetchWorker.stop();
  }

  notify(): void {
    this.fetchWorker.notify();
  }

  /** Ask for a reading of the world. Returns false when one is already on its way. */
  enqueue(opts: { manual?: boolean; priority?: number } = {}): boolean {
    const payload: WorldFetchPayload = opts.manual ? { manual: true } : {};
    const created = this.d.queue.enqueue(WORLD_FETCH, 'world', payload, {
      priority: opts.priority ?? 0,
      maxAttempts: 3,
    });
    if (created) this.fetchWorker.notify();
    return created;
  }

  private async handleFetch(job: Job<WorldFetchPayload>, signal: AbortSignal): Promise<void> {
    const started = this.clock();
    const fetcher = new WorldFetcher({
      wikidata: this.d.wikidata,
      countries: this.countries,
      now: started,
      log: {
        info: (msg, extra) => this.d.log.info(extra ?? {}, msg),
        warn: (msg, extra) => this.d.log.warn(extra ?? {}, msg),
      },
    });
    let result;
    try {
      result = await fetcher.run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.d.world.recordFetch({ startedAt: iso(started), finishedAt: iso(this.clock()), error: message });
      throw new JobError(message, { retryable: true });
    }
    if (signal.aborted) throw new JobError('the world fetch was interrupted', { retryable: true, defer: true, delayMs: 0 });
    const written = this.d.world.saveSnapshots(result.snapshots);
    this.d.world.recordFetch({
      startedAt: iso(started),
      finishedAt: iso(this.clock()),
      countries: written,
      unmapped: result.unmapped,
    });
    this.d.log.info(
      {
        countries: written,
        unmapped: result.unmapped.length,
        ms: this.clock().getTime() - started.getTime(),
        fetchedAt: iso(this.clock()),
      },
      'read the world snapshot',
    );
  }
}
