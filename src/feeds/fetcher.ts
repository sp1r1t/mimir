import { backoffMs, parseRetryAfter, sleep } from '../util/backoff.js';
import { fetchText, HttpError, isRetryableStatus } from '../util/http.js';

export type FeedFetchResult =
  | { kind: 'not_modified'; status: 304; attempts: number }
  | {
      kind: 'ok';
      status: number;
      body: string;
      bytes: number;
      etag: string | null;
      lastModified: string | null;
      finalUrl: string;
      attempts: number;
    };

export class FeedFetchError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly attempts: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = 'FeedFetchError';
  }
}

export interface FeedFetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  retries: number;
  retryBaseMs?: number;
  signal?: AbortSignal;
}

/** Conditional GET of a feed with in-request retries for transient failures. */
export async function fetchFeed(
  url: string,
  validators: { etag: string | null; lastModified: string | null },
  opts: FeedFetchOptions,
): Promise<FeedFetchResult> {
  const headers: Record<string, string> = {
    'User-Agent': opts.userAgent,
    Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
  };
  if (validators.etag) headers['If-None-Match'] = validators.etag;
  if (validators.lastModified) headers['If-Modified-Since'] = validators.lastModified;

  let attempt = 0;
  for (;;) {
    attempt++;
    let error: FeedFetchError;
    try {
      const res = await fetchText(url, { headers, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes, signal: opts.signal });
      if (res.status === 304) return { kind: 'not_modified', status: 304, attempts: attempt };
      if (res.status >= 200 && res.status < 300) {
        return {
          kind: 'ok',
          status: res.status,
          body: res.body,
          bytes: res.bytes,
          etag: res.headers.get('etag'),
          lastModified: res.headers.get('last-modified'),
          finalUrl: res.finalUrl,
          attempts: attempt,
        };
      }
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      error = new FeedFetchError(`HTTP ${res.status}`, res.status, attempt, retryAfter);
      if (!isRetryableStatus(res.status) || res.status === 429) throw error;
    } catch (err) {
      if (err instanceof FeedFetchError) throw err;
      if (err instanceof HttpError) {
        error = new FeedFetchError(err.message, err.status, attempt, err.retryAfterMs);
        if (!err.retryable) throw error;
      } else {
        throw err;
      }
    }
    if (attempt > opts.retries || opts.signal?.aborted) throw error;
    await sleep(backoffMs(attempt, opts.retryBaseMs ?? 1000, 10_000), opts.signal);
  }
}
