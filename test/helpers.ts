import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createApp, type App } from '../src/app.js';
import type { Classifier } from '../src/classification/types.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import type { ArticleExtractor } from '../src/extraction/extractor.js';
import { silentLogger } from '../src/logger.js';
import type { Geocoder } from '../src/places/geocoder.js';
import type { StoryMatcher } from '../src/stories/matcher.js';
import type { SummaryProvider } from '../src/summaries/provider.js';
import type { Encyclopedia } from '../src/terms/wikipedia.js';
import type { Clock } from '../src/util/time.js';

export const FIXTURES = join(import.meta.dirname, 'fixtures');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testConfig(dataDir: string, env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    MIMIR_DATA_DIR: dataDir,
    MIMIR_SEED_DEFAULTS: 'false',
    FEED_RETRIES: '0',
    FEED_TIMEOUT_MS: '2000',
    FEED_MIN_POLL_MINUTES: '1',
    JOB_POLL_MS: '50',
    FEED_SCHEDULER_TICK_MS: '100000',
    EXTRACT_ENABLED: 'false',
    SUMMARY_PROVIDER: 'none',
    ...env,
  });
}

export interface TestApp {
  app: App;
  dir: string;
  cleanup: () => Promise<void>;
}

export function makeApp(
  opts: {
    env?: Record<string, string>;
    classifier?: Classifier;
    extractor?: ArticleExtractor;
    geocoder?: Geocoder;
    matcher?: StoryMatcher;
    summaries?: SummaryProvider;
    places?: SummaryProvider;
    terms?: SummaryProvider;
    wikipedia?: Encyclopedia;
    clock?: Clock;
    dir?: string;
  } = {},
): TestApp {
  const tmp = opts.dir ? { dir: opts.dir, cleanup: () => {} } : tempDir();
  const config = testConfig(tmp.dir, opts.env);
  const app = createApp(config, silentLogger(), {
    classifier: opts.classifier,
    extractor: opts.extractor,
    geocoder: opts.geocoder,
    matcher: opts.matcher,
    summaries: opts.summaries,
    places: opts.places,
    terms: opts.terms,
    wikipedia: opts.wikipedia,
    clock: opts.clock,
    db: openDatabase(config.dbPath),
  });
  return {
    app,
    dir: tmp.dir,
    cleanup: async () => {
      await app.stop();
      app.db.close();
      tmp.cleanup();
    },
  };
}

/** A tiny HTTP server whose routes can be changed during a test. */
export class FeedServer {
  private server: Server | null = null;
  readonly requests: { path: string; headers: IncomingMessage['headers'] }[] = [];
  routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.requests.push({ path: req.url ?? '', headers: req.headers });
      const handler = this.routes.get((req.url ?? '').split('?')[0]!);
      if (handler) handler(req, res);
      else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  /** Serve a static body with an ETag, answering conditional requests with 304. */
  serveFeed(path: string, body: () => string, type = 'application/rss+xml'): void {
    this.routes.set(path, (req, res) => {
      const b = body();
      const etag = `"${Buffer.from(b).toString('base64').slice(0, 16)}${b.length}"`;
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.setHeader('Content-Type', type);
      res.setHeader('ETag', etag);
      res.end(b);
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

interface QuestionLike {
  type: 'noul' | 'score' | 'choice';
  criteria?: unknown;
}

/**
 * Build a System One response in the documented format
 * (https://docs.typesafe.ai/api.md) for every question in a request.
 * `pick` lets a test choose answers per question id.
 */
export function fakeSystemOneResponse(
  request: { model?: string; questions: Record<string, QuestionLike> },
  pick: (id: string, q: QuestionLike) => number | string = () => 0.5,
  model = 'jev-1.14.0',
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(request.questions)) {
    if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: Number(pick(id, q)) };
    } else if (q.type === 'score') {
      const levels = q.criteria as string[];
      const score = Number(pick(id, q));
      const lo = Math.floor(score);
      const probabilities: Record<string, number> = {};
      const legend: Record<string, string> = {};
      levels.forEach((l, i) => {
        legend[String(i)] = l;
        probabilities[String(i)] = i === lo ? 1 - (score - lo) : i === lo + 1 ? score - lo : 0;
      });
      answers[id] = { type: 'score', score, confidence: 0.6, legend, probabilities };
    } else {
      const options = Object.keys(q.criteria as Record<string, string>);
      const choice = String(pick(id, q)) || options[0]!;
      const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? 0.9 : 0.1 / (options.length - 1)]));
      answers[id] = { type: 'choice', choice, confidence: 0.8, probabilities };
    }
  }
  return { model, answers, usage: { input_tokens: 1234, output_tokens: 20 } };
}

/** Read the JSON body the SDK sent (handles its zstd request compression). */
export async function readSdkRequest(input: RequestInfo | URL, init?: RequestInit): Promise<{ url: string; headers: Headers; body: any }> {
  const req = new Request(input, init);
  let buf = Buffer.from(await req.arrayBuffer());
  if (req.headers.get('content-encoding') === 'zstd') buf = zstdDecompressSync(buf);
  return { url: req.url, headers: req.headers, body: JSON.parse(buf.toString('utf8')) };
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
