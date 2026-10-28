import type { DB } from '../db/database.js';
import { addMs, iso, systemClock, type Clock } from '../util/time.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Job<P = Record<string, unknown>> {
  id: number;
  kind: string;
  dedupeKey: string;
  payload: P;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lastError: string | null;
  createdAt: string;
}

interface JobRow {
  id: number;
  kind: string;
  dedupe_key: string;
  payload: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: string;
  last_error: string | null;
  created_at: string;
}

function toJob<P>(r: JobRow): Job<P> {
  return {
    id: r.id,
    kind: r.kind,
    dedupeKey: r.dedupe_key,
    payload: JSON.parse(r.payload) as P,
    status: r.status,
    priority: r.priority,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    runAfter: r.run_after,
    lastError: r.last_error,
    createdAt: r.created_at,
  };
}

export interface EnqueueOptions {
  priority?: number;
  maxAttempts?: number;
  delayMs?: number;
  /** If the same job is running, run it once more after it completes (its input changed meanwhile). */
  rerunIfRunning?: boolean;
}

/**
 * SQLite-backed job queue. A (kind, dedupe_key) pair can have at most one active
 * (pending or running) job, which makes enqueueing idempotent.
 */
export class JobQueue {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Returns true if the work will run (new job or rerun requested), false if an active job already covers it. */
  enqueue(kind: string, dedupeKey: string, payload: object, opts: EnqueueOptions = {}): boolean {
    const now = this.clock();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (kind, dedupe_key, payload, priority, max_attempts, run_after, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        kind,
        dedupeKey,
        JSON.stringify(payload),
        opts.priority ?? 0,
        opts.maxAttempts ?? 5,
        iso(addMs(now, opts.delayMs ?? 0)),
        iso(now),
        iso(now),
      );
    if (res.changes > 0) return true;
    if (!opts.rerunIfRunning) return false;
    return (
      this.db.prepare(`UPDATE jobs SET rerun = 1 WHERE kind = ? AND dedupe_key = ? AND status = 'running' AND rerun = 0`).run(kind, dedupeKey).changes > 0
    );
  }

  /** Atomically claim up to `limit` due jobs of a kind, incrementing their attempt counter. */
  claim<P>(kind: string, limit: number): Job<P>[] {
    if (limit <= 0) return [];
    const now = iso(this.clock());
    const rows = this.db
      .prepare(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = @now, updated_at = @now
         WHERE id IN (
           SELECT id FROM jobs WHERE kind = @kind AND status = 'pending' AND run_after <= @now
           ORDER BY priority DESC, run_after, id LIMIT @limit
         )
         RETURNING *`,
      )
      .all({ kind, now, limit }) as JobRow[];
    return rows.map((r) => toJob<P>(r)).sort((a, b) => b.priority - a.priority || a.id - b.id);
  }

  /** Mark done, or pending again with fresh attempts when a rerun was requested while it ran. */
  complete(id: number): void {
    const now = iso(this.clock());
    this.db
      .prepare(
        `UPDATE jobs SET status = CASE WHEN rerun = 1 THEN 'pending' ELSE 'done' END,
           attempts = CASE WHEN rerun = 1 THEN 0 ELSE attempts END,
           run_after = CASE WHEN rerun = 1 THEN @now ELSE run_after END,
           finished_at = CASE WHEN rerun = 1 THEN NULL ELSE @now END,
           rerun = 0, locked_at = NULL, last_error = NULL, updated_at = @now
         WHERE id = @id`,
      )
      .run({ now, id });
  }

  /** Schedule another attempt, or mark failed when attempts are exhausted. Returns the new status. */
  retryOrFail(id: number, error: string, delayMs: number): JobStatus {
    const now = this.clock();
    const row = this.db.prepare('SELECT attempts, max_attempts FROM jobs WHERE id = ?').get(id) as
      | { attempts: number; max_attempts: number }
      | undefined;
    if (!row) return 'failed';
    if (row.attempts >= row.max_attempts) {
      this.fail(id, error);
      return 'failed';
    }
    this.db
      .prepare(`UPDATE jobs SET status = 'pending', rerun = 0, locked_at = NULL, last_error = ?, run_after = ?, updated_at = ? WHERE id = ?`)
      .run(error, iso(addMs(now, delayMs)), iso(now), id);
    return 'pending';
  }

  /** Put a job back without consuming an attempt (e.g. the downstream service is paused). */
  defer(id: number, delayMs: number, note?: string): void {
    const now = this.clock();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'pending', rerun = 0, attempts = MAX(attempts - 1, 0), locked_at = NULL,
         last_error = COALESCE(?, last_error), run_after = ?, updated_at = ? WHERE id = ?`,
      )
      .run(note ?? null, iso(addMs(now, delayMs)), iso(now), id);
  }

  fail(id: number, error: string): void {
    const now = iso(this.clock());
    this.db
      .prepare(`UPDATE jobs SET status = 'failed', rerun = 0, locked_at = NULL, last_error = ?, updated_at = ?, finished_at = ? WHERE id = ?`)
      .run(error, now, now, id);
  }

  /** On startup: jobs left 'running' by a crashed or killed process become pending again. */
  recoverInterrupted(): number {
    const now = iso(this.clock());
    return this.db
      .prepare(`UPDATE jobs SET status = 'pending', rerun = 0, locked_at = NULL, updated_at = ? WHERE status = 'running'`)
      .run(now).changes;
  }

  /** Re-queue failed jobs of a kind with a fresh attempt budget. */
  retryFailed(kind?: string): number {
    const now = iso(this.clock());
    const sql = `UPDATE OR IGNORE jobs SET status = 'pending', attempts = 0, run_after = @now, updated_at = @now, finished_at = NULL
                 WHERE status = 'failed' ${kind ? 'AND kind = @kind' : ''}`;
    return this.db.prepare(sql).run({ now, kind }).changes;
  }

  /** Explicit request: promote pending work, clear its error and reset the attempt budget. Never changes running work. */
  promote(kind: string, dedupeKey: string, priority: number, payload: object): boolean {
    const now = iso(this.clock());
    return (
      this.db
        .prepare(
          `UPDATE jobs SET priority = MAX(priority, ?), payload = ?, run_after = MIN(run_after, ?), updated_at = ?, attempts = 0, last_error = NULL
           WHERE kind = ? AND dedupe_key = ? AND status = 'pending'`,
        )
        .run(priority, JSON.stringify(payload), now, now, kind, dedupeKey).changes > 0
    );
  }

  /** Active (pending or running) jobs of a kind whose payload has the given top-level field values. */
  countActive(kind: string, payloadMatch: Record<string, string | number | boolean> = {}): number {
    const conds = Object.keys(payloadMatch).map((k, i) => `json_extract(payload, '$.${k.replace(/[^A-Za-z0-9_]/g, '')}') = @v${i}`);
    const params: Record<string, unknown> = { kind };
    Object.values(payloadMatch).forEach((v, i) => (params[`v${i}`] = typeof v === 'boolean' ? Number(v) : v));
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = @kind AND status IN ('pending', 'running') ${conds.map((c) => `AND ${c}`).join(' ')}`)
        .get(params) as { n: number }
    ).n;
  }

  hasActive(kind: string, dedupeKey: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM jobs WHERE kind = ? AND dedupe_key = ? AND status IN ('pending', 'running')`)
      .get(kind, dedupeKey);
  }

  nextRunAfter(kind: string): string | null {
    const row = this.db
      .prepare(`SELECT MIN(run_after) AS t FROM jobs WHERE kind = ? AND status = 'pending'`)
      .get(kind) as { t: string | null };
    return row.t;
  }

  counts(): { kind: string; status: JobStatus; count: number }[] {
    return this.db
      .prepare('SELECT kind, status, COUNT(*) AS count FROM jobs GROUP BY kind, status ORDER BY kind, status')
      .all() as { kind: string; status: JobStatus; count: number }[];
  }

  recentFailures(limit = 20): Job[] {
    return (
      this.db
        .prepare(`SELECT * FROM jobs WHERE status = 'failed' ORDER BY finished_at DESC LIMIT ?`)
        .all(limit) as JobRow[]
    ).map((r) => toJob(r));
  }

  /** Delete finished jobs older than the retention window. Failed jobs are kept while their article exists. */
  prune(olderThanDays: number): number {
    const cutoff = iso(addMs(this.clock(), -olderThanDays * 86_400_000));
    return this.db.prepare(`DELETE FROM jobs WHERE status = 'done' AND finished_at < ?`).run(cutoff).changes;
  }
}
