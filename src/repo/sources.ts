import { z } from 'zod';
import type { DB } from '../db/database.js';
import { iso, systemClock, type Clock } from '../util/time.js';

export const SourceConfigSchema = z.object({
  /** Fetch article pages to extract full text when the feed only has a summary. */
  extractContent: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  notes: z.string().default(''),
});
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export interface Source {
  id: number;
  name: string;
  url: string;
  type: 'feed';
  siteUrl: string | null;
  config: SourceConfig;
  pollIntervalSeconds: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  etag: string | null;
  lastModified: string | null;
  nextFetchAt: string | null;
  lastFetchAt: string | null;
  lastSuccessAt: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  feedFormat: string | null;
  feedTitle: string | null;
}

export type SourceHealth = 'ok' | 'pending' | 'failing' | 'disabled';

export function sourceHealth(s: Source): SourceHealth {
  if (!s.enabled) return 'disabled';
  if (s.consecutiveFailures > 0) return 'failing';
  if (!s.lastSuccessAt) return 'pending';
  return 'ok';
}

interface SourceRow {
  id: number;
  name: string;
  url: string;
  type: 'feed';
  site_url: string | null;
  config: string;
  poll_interval_seconds: number;
  enabled: number;
  created_at: string;
  updated_at: string;
  etag: string | null;
  last_modified: string | null;
  next_fetch_at: string | null;
  last_fetch_at: string | null;
  last_success_at: string | null;
  last_http_status: number | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  feed_format: string | null;
  feed_title: string | null;
}

function toSource(r: SourceRow): Source {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    type: r.type,
    siteUrl: r.site_url,
    config: SourceConfigSchema.parse(JSON.parse(r.config)),
    pollIntervalSeconds: r.poll_interval_seconds,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    etag: r.etag,
    lastModified: r.last_modified,
    nextFetchAt: r.next_fetch_at,
    lastFetchAt: r.last_fetch_at,
    lastSuccessAt: r.last_success_at,
    lastHttpStatus: r.last_http_status,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    consecutiveFailures: r.consecutive_failures,
    feedFormat: r.feed_format,
    feedTitle: r.feed_title,
  };
}

export interface SourceInput {
  name: string;
  url: string;
  pollIntervalSeconds: number;
  enabled?: boolean;
  config?: Partial<SourceConfig>;
}

export interface FetchRecord {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: 'ok' | 'not_modified' | 'error';
  httpStatus: number | null;
  attempts: number;
  bytes: number | null;
  itemsSeen: number;
  itemsNew: number;
  itemsUpdated: number;
  error: string | null;
}

export class SourceRepository {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock = systemClock,
  ) {}

  list(): Source[] {
    return (this.db.prepare('SELECT * FROM sources ORDER BY name COLLATE NOCASE').all() as SourceRow[]).map(toSource);
  }

  get(id: number): Source | null {
    const r = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
    return r ? toSource(r) : null;
  }

  byUrl(url: string): Source | null {
    const r = this.db.prepare('SELECT * FROM sources WHERE url = ?').get(url) as SourceRow | undefined;
    return r ? toSource(r) : null;
  }

  create(input: SourceInput): Source {
    const now = iso(this.clock());
    const config = SourceConfigSchema.parse(input.config ?? {});
    const res = this.db
      .prepare(
        `INSERT INTO sources (name, url, config, poll_interval_seconds, enabled, created_at, updated_at, next_fetch_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.name, input.url, JSON.stringify(config), input.pollIntervalSeconds, input.enabled === false ? 0 : 1, now, now, now);
    return this.get(Number(res.lastInsertRowid))!;
  }

  update(id: number, input: SourceInput): Source {
    const existing = this.get(id);
    if (!existing) throw new Error(`Source ${id} not found`);
    const config = SourceConfigSchema.parse({ ...existing.config, ...(input.config ?? {}) });
    const urlChanged = existing.url !== input.url;
    this.db
      .prepare(
        `UPDATE sources SET name = @name, url = @url, config = @config, poll_interval_seconds = @poll, enabled = @enabled, updated_at = @now
           ${urlChanged ? ", etag = NULL, last_modified = NULL, next_fetch_at = @now, consecutive_failures = 0" : ''}
         WHERE id = @id`,
      )
      .run({
        name: input.name,
        url: input.url,
        config: JSON.stringify(config),
        poll: input.pollIntervalSeconds,
        enabled: input.enabled === false ? 0 : 1,
        now: iso(this.clock()),
        id,
      });
    return this.get(id)!;
  }

  setEnabled(id: number, enabled: boolean): void {
    const now = iso(this.clock());
    this.db
      .prepare(`UPDATE sources SET enabled = ?, updated_at = ?, next_fetch_at = CASE WHEN ? = 1 THEN ? ELSE next_fetch_at END WHERE id = ?`)
      .run(enabled ? 1 : 0, now, enabled ? 1 : 0, now, id);
  }

  /** Articles from a deleted source are kept; their source reference becomes empty. */
  delete(id: number): void {
    this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  }

  /** Make the source due immediately. */
  requestFetch(id: number): void {
    this.db.prepare('UPDATE sources SET next_fetch_at = ? WHERE id = ?').run(iso(this.clock()), id);
  }

  due(limit: number, excludeIds: number[]): Source[] {
    const now = iso(this.clock());
    const rows = this.db
      .prepare(
        `SELECT * FROM sources WHERE enabled = 1 AND (next_fetch_at IS NULL OR next_fetch_at <= ?)
         ORDER BY next_fetch_at NULLS FIRST LIMIT ?`,
      )
      .all(now, limit + excludeIds.length) as SourceRow[];
    return rows.filter((r) => !excludeIds.includes(r.id)).slice(0, limit).map(toSource);
  }

  recordSuccess(
    id: number,
    data: {
      fetchedAt: string;
      nextFetchAt: string;
      httpStatus: number;
      etag?: string | null;
      lastModified?: string | null;
      feed?: { format: string; title: string | null; siteUrl: string | null; metadata: unknown };
    },
  ): void {
    const f = data.feed;
    this.db
      .prepare(
        `UPDATE sources SET last_fetch_at = @fetchedAt, last_success_at = @fetchedAt, next_fetch_at = @nextFetchAt,
           last_http_status = @httpStatus, consecutive_failures = 0, last_error = NULL,
           etag = COALESCE(@etag, etag), last_modified = COALESCE(@lastModified, last_modified)
           ${f ? ', feed_format = @format, feed_title = @title, site_url = COALESCE(@siteUrl, site_url), feed_metadata = @metadata' : ''}
         WHERE id = @id`,
      )
      .run({
        id,
        fetchedAt: data.fetchedAt,
        nextFetchAt: data.nextFetchAt,
        httpStatus: data.httpStatus,
        etag: data.etag ?? null,
        lastModified: data.lastModified ?? null,
        ...(f ? { format: f.format, title: f.title, siteUrl: f.siteUrl, metadata: JSON.stringify(f.metadata ?? {}) } : {}),
      });
  }

  recordFailure(id: number, data: { fetchedAt: string; nextFetchAt: string; httpStatus: number | null; error: string }): void {
    this.db
      .prepare(
        `UPDATE sources SET last_fetch_at = ?, next_fetch_at = ?, last_http_status = ?, last_error = ?, last_error_at = ?,
           consecutive_failures = consecutive_failures + 1
         WHERE id = ?`,
      )
      .run(data.fetchedAt, data.nextFetchAt, data.httpStatus, data.error, data.fetchedAt, id);
  }

  logFetch(sourceId: number, r: FetchRecord): void {
    this.db
      .prepare(
        `INSERT INTO source_fetches (source_id, started_at, finished_at, duration_ms, outcome, http_status, attempts, bytes,
           items_seen, items_new, items_updated, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sourceId, r.startedAt, r.finishedAt, r.durationMs, r.outcome, r.httpStatus, r.attempts, r.bytes, r.itemsSeen, r.itemsNew, r.itemsUpdated, r.error);
  }

  recentFetches(sourceId: number, limit = 25): (FetchRecord & { id: number })[] {
    return this.db
      .prepare(
        `SELECT id, started_at AS startedAt, finished_at AS finishedAt, duration_ms AS durationMs, outcome,
           http_status AS httpStatus, attempts, bytes, items_seen AS itemsSeen, items_new AS itemsNew,
           items_updated AS itemsUpdated, error
         FROM source_fetches WHERE source_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(sourceId, limit) as (FetchRecord & { id: number })[];
  }

  /** Per-source article counts: total and discovered in the last 24h. */
  articleCounts(): Map<number, { total: number; last24h: number }> {
    const since = iso(new Date(this.clock().getTime() - 86_400_000));
    const rows = this.db
      .prepare(
        `SELECT source_id AS id, COUNT(*) AS total, SUM(first_seen_at >= ?) AS last24h
         FROM article_entries WHERE source_id IS NOT NULL GROUP BY source_id`,
      )
      .all(since) as { id: number; total: number; last24h: number }[];
    return new Map(rows.map((r) => [r.id, { total: r.total, last24h: r.last24h ?? 0 }]));
  }

  pruneFetchLog(olderThanDays: number): number {
    const cutoff = iso(new Date(this.clock().getTime() - olderThanDays * 86_400_000));
    return this.db.prepare('DELETE FROM source_fetches WHERE started_at < ?').run(cutoff).changes;
  }
}
