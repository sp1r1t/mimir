import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../src/db/database.js';
import { JobQueue } from '../src/jobs/queue.js';

let db: DB;
afterEach(() => db?.close());

function setup(now = { t: Date.parse('2026-10-25T12:00:00Z') }) {
  db = openDatabase(':memory:');
  return { q: new JobQueue(db, () => new Date(now.t)), now };
}

describe('JobQueue', () => {
  it('deduplicates active jobs by kind and key', () => {
    const { q } = setup();
    expect(q.enqueue('classify', 'article:1', { articleId: 1 })).toBe(true);
    expect(q.enqueue('classify', 'article:1', { articleId: 1 })).toBe(false);
    expect(q.enqueue('extract', 'article:1', { articleId: 1 })).toBe(true);
    const [job] = q.claim('classify', 5);
    q.complete(job!.id);
    // Once finished, the same key can be enqueued again (e.g. reclassification).
    expect(q.enqueue('classify', 'article:1', { articleId: 1 })).toBe(true);
  });

  it('claims by priority and respects run_after', () => {
    const { q, now } = setup();
    q.enqueue('k', 'a', { n: 'a' }, { priority: 0 });
    q.enqueue('k', 'b', { n: 'b' }, { priority: 10 });
    q.enqueue('k', 'c', { n: 'c' }, { priority: 20, delayMs: 60_000 });
    expect(q.claim<{ n: string }>('k', 5).map((j) => j.payload.n)).toEqual(['b', 'a']);
    expect(q.claim('k', 5)).toHaveLength(0);
    now.t += 61_000;
    expect(q.claim<{ n: string }>('k', 5).map((j) => j.payload.n)).toEqual(['c']);
  });

  it('retries with delay and fails after max attempts', () => {
    const { q, now } = setup();
    q.enqueue('k', 'x', {}, { maxAttempts: 2 });
    let [job] = q.claim('k', 1);
    expect(q.retryOrFail(job!.id, 'boom', 1000)).toBe('pending');
    expect(q.claim('k', 1)).toHaveLength(0);
    now.t += 1000;
    [job] = q.claim('k', 1);
    expect(job!.attempts).toBe(2);
    expect(q.retryOrFail(job!.id, 'boom again', 1000)).toBe('failed');
    expect(q.recentFailures()[0]!.lastError).toBe('boom again');
    expect(q.retryFailed()).toBe(1);
    expect(q.claim('k', 1)[0]!.attempts).toBe(1);
  });

  it('defer does not consume an attempt', () => {
    const { q, now } = setup();
    q.enqueue('k', 'x', {}, { maxAttempts: 1 });
    const [job] = q.claim('k', 1);
    q.defer(job!.id, 500, 'paused');
    now.t += 500;
    expect(q.claim('k', 1)[0]!.attempts).toBe(1);
  });

  it('recovers jobs interrupted by a crash', () => {
    const { q } = setup();
    q.enqueue('k', 'x', {});
    q.claim('k', 1);
    expect(q.claim('k', 1)).toHaveLength(0);
    expect(q.recoverInterrupted()).toBe(1);
    expect(q.claim('k', 1)).toHaveLength(1);
  });
});
