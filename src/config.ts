import { resolve } from 'node:path';
import { z } from 'zod';
import { APP_ROOT } from './paths.js';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const EnvSchema = z.object({
  MIMIR_HOST: z.string().default('0.0.0.0'),
  MIMIR_PORT: int(8080, 1),
  MIMIR_DATA_DIR: z.string().default(resolve(APP_ROOT, 'data')),
  MIMIR_DB_PATH: optionalString,
  MIMIR_BASIC_AUTH: optionalString,
  MIMIR_SEED_DEFAULTS: bool.default(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: bool.default(false),

  HTTP_USER_AGENT: z.string().default('Mimir/0.1 (self-hosted news reader)'),

  FEED_DEFAULT_POLL_MINUTES: int(30, 1),
  FEED_MIN_POLL_MINUTES: int(5, 1),
  FEED_MAX_BACKOFF_MINUTES: int(720, 1),
  FEED_CONCURRENCY: int(4, 1),
  FEED_TIMEOUT_MS: int(20000, 1000),
  FEED_RETRIES: int(2, 0),
  FEED_MAX_BYTES: int(10 * 1024 * 1024, 1024),
  FEED_SCHEDULER_TICK_MS: int(10000, 100),

  EXTRACT_ENABLED: bool.default(true),
  EXTRACT_CONCURRENCY: int(2, 1),
  EXTRACT_TIMEOUT_MS: int(20000, 1000),
  EXTRACT_MAX_BYTES: int(5 * 1024 * 1024, 1024),
  EXTRACT_MIN_FEED_CHARS: int(1500, 0),
  EXTRACT_RESPECT_ROBOTS: bool.default(true),
  EXTRACT_ALLOW_PRIVATE_NETWORKS: bool.default(false),

  TYPESAFE_API_KEY: optionalString,
  TYPESAFE_BASE_URL: optionalString,
  JEV_MODEL: z.string().default('jev-latest'),
  JEV_TIMEOUT_MS: int(30000, 1000),
  CLASSIFY_CONCURRENCY: int(2, 1),
  CLASSIFY_MAX_ATTEMPTS: int(8, 1),
  CLASSIFY_MAX_CONTENT_CHARS: int(6000, 200),

  STORY_MATCH_WINDOW_DAYS: int(4, 1),
  STORY_MAX_CANDIDATES: int(4, 1),
  STORY_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.3),

  SUMMARY_PROVIDER: z.enum(['minimax', 'mock', 'none']).default('minimax'),
  SUMMARY_LANGUAGE: z.string().min(1).default('English'),
  SUMMARY_AUTO_ENABLED: bool.default(true),
  SUMMARY_AUTO_MIN_PRIORITY: z.coerce.number().min(0).max(1).default(0.6),
  SUMMARY_AUTO_MAX_PER_DAY: int(40, 0),
  SUMMARY_AUTO_MAX_AGE_HOURS: int(72, 1),
  SUMMARY_MIN_REGEN_MINUTES: int(120, 0),
  SUMMARY_CONCURRENCY: int(1, 1),
  SUMMARY_MAX_ATTEMPTS: int(3, 1),
  SUMMARY_MAX_ARTICLES: int(12, 1),
  SUMMARY_MAX_INPUT_CHARS: int(40000, 2000),
  SUMMARY_MAX_OUTPUT_TOKENS: int(16000, 1000),
  MOCK_SUMMARY_MODE: z.enum(['ok', 'invalid', 'auth', 'plan', 'quota', 'rate_limited', 'unavailable', 'invalid_output', 'rejected']).default('ok'),
  MOCK_SUMMARY_DELAY_MS: int(0, 0),

  PLACES_ENABLED: bool.default(true),
  PLACES_MAX_ARTICLES: int(12, 1),
  PLACES_MAX_INPUT_CHARS: int(40000, 2000),
  PLACES_MAX_OUTPUT_TOKENS: int(4000, 500),
  GEOCODER_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
  GEOCODER_USER_AGENT: z.string().min(1).default('Mimir/0.1 (self-hosted news reader)'),
  GEOCODER_TIMEOUT_MS: int(15000, 1000),
  GEOCODER_MIN_INTERVAL_MS: int(1000, 0),
  TILE_URL: z.string().min(1).default('https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
  TILE_ATTRIBUTION: z.string().default('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'),

  WORLD_ENABLED: bool.default(true),
  // How often the world snapshot is read again. Wikidata changes slowly, and it
  // is a public service that asks to be treated politely.
  WORLD_REFRESH_HOURS: int(24, 1),
  WIKIDATA_URL: z.string().url().default('https://www.wikidata.org'),
  WIKIDATA_QUERY_URL: z.string().url().default('https://query.wikidata.org/sparql'),
  // Wikidata asks who is asking, and answers a stranger with less. The address
  // below is the reserved ".invalid" one, because a self-hosted reader has no
  // public homepage to point at; set WIKIDATA_USER_AGENT to your own address to
  // be reachable.
  WIKIDATA_USER_AGENT: z
    .string()
    .min(1)
    .default('Mimir/1.0 (self-hosted news reader; https://mimir.invalid)'),
  WIKIDATA_TIMEOUT_MS: int(30000, 1000),
  WIKIDATA_MIN_INTERVAL_MS: int(700, 0),

  TERMS_ENABLED: bool.default(true),
  TERMS_MAX_ARTICLES: int(12, 1),
  TERMS_MAX_INPUT_CHARS: int(40000, 2000),
  TERMS_MAX_OUTPUT_TOKENS: int(4000, 500),
  WIKIPEDIA_URL: z.string().url().default('https://en.wikipedia.org'),
  // Wikipedia's edge lets a request through only when the User-Agent says who is
  // asking: a name and a way to reach them. Without one it answers 429 after a
  // handful of requests, whatever the gap between them is. The address below is the
  // reserved ".invalid" one, because a self-hosted reader has no public homepage to
  // point at; set WIKIPEDIA_USER_AGENT to your own address to be reachable.
  WIKIPEDIA_USER_AGENT: z
    .string()
    .min(1)
    .default('Mimir/1.0 (self-hosted news reader; https://mimir.invalid)'),
  WIKIPEDIA_TIMEOUT_MS: int(15000, 1000),
  WIKIPEDIA_MIN_INTERVAL_MS: int(500, 0),

  MINIMAX_API_KEY: optionalString,
  MINIMAX_BASE_URL: z.string().url().default('https://api.minimax.io'),
  MINIMAX_QUOTA_URL: z.string().url().default('https://www.minimax.io/v1/token_plan/remains'),
  MINIMAX_MODEL: z.string().min(1).default('MiniMax-M3.1-Flash'),
  MINIMAX_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  MINIMAX_TIMEOUT_MS: int(180000, 5000),
  MINIMAX_AUTO_RESERVE_PERCENT: z.coerce.number().min(0).max(100).default(25),
  MINIMAX_MIN_REMAINING_PERCENT: z.coerce.number().min(0).max(100).default(3),

  JOB_POLL_MS: int(2000, 50),
  RECONCILE_INTERVAL_MS: int(5 * 60 * 1000, 1000),
  RETENTION_FETCH_LOG_DAYS: int(30, 1),
  RETENTION_JOBS_DAYS: int(14, 1),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  basicAuth?: { user: string; password: string };
  seedDefaults: boolean;
  logLevel: Env['LOG_LEVEL'];
  logPretty: boolean;
  userAgent: string;
  feeds: {
    defaultPollSeconds: number;
    minPollSeconds: number;
    maxBackoffSeconds: number;
    concurrency: number;
    timeoutMs: number;
    retries: number;
    maxBytes: number;
    tickMs: number;
  };
  extraction: {
    enabled: boolean;
    concurrency: number;
    timeoutMs: number;
    maxBytes: number;
    minFeedChars: number;
    respectRobots: boolean;
    allowPrivateNetworks: boolean;
  };
  jev: {
    apiKey?: string;
    baseURL?: string;
    model: string;
    timeoutMs: number;
  };
  classification: {
    concurrency: number;
    maxAttempts: number;
    maxContentChars: number;
  };
  stories: {
    matchWindowDays: number;
    maxCandidates: number;
    minSimilarity: number;
  };
  summaries: {
    provider: Env['SUMMARY_PROVIDER'];
    language: string;
    autoEnabled: boolean;
    autoMinPriority: number;
    autoMaxPerDay: number;
    autoMaxAgeHours: number;
    minRegenMinutes: number;
    concurrency: number;
    maxAttempts: number;
    maxArticles: number;
    maxInputChars: number;
    maxOutputTokens: number;
    mock: { mode: Env['MOCK_SUMMARY_MODE']; delayMs: number };
  };
  places: {
    enabled: boolean;
    maxArticles: number;
    maxInputChars: number;
    maxOutputTokens: number;
    tileUrl: string;
    tileAttribution: string;
    geocoder: {
      baseUrl: string;
      userAgent: string;
      timeoutMs: number;
      minIntervalMs: number;
    };
  };
  terms: {
    enabled: boolean;
    maxArticles: number;
    maxInputChars: number;
    maxOutputTokens: number;
    wikipedia: {
      baseUrl: string;
      userAgent: string;
      timeoutMs: number;
      minIntervalMs: number;
    };
  };
  world: {
    enabled: boolean;
    refreshHours: number;
    wikidata: {
      baseUrl: string;
      queryUrl: string;
      userAgent: string;
      timeoutMs: number;
      minIntervalMs: number;
    };
  };
  minimax: {
    apiKey?: string;
    baseURL: string;
    quotaURL: string;
    model: string;
    reasoningEffort: Env['MINIMAX_REASONING_EFFORT'];
    timeoutMs: number;
    autoReservePercent: number;
    minRemainingPercent: number;
  };
  jobs: {
    pollMs: number;
    reconcileIntervalMs: number;
  };
  retention: {
    fetchLogDays: number;
    jobsDays: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  let basicAuth: AppConfig['basicAuth'];
  if (e.MIMIR_BASIC_AUTH) {
    const idx = e.MIMIR_BASIC_AUTH.indexOf(':');
    if (idx <= 0) throw new Error('Invalid configuration: MIMIR_BASIC_AUTH must be user:password');
    basicAuth = { user: e.MIMIR_BASIC_AUTH.slice(0, idx), password: e.MIMIR_BASIC_AUTH.slice(idx + 1) };
  }
  return {
    host: e.MIMIR_HOST,
    port: e.MIMIR_PORT,
    dataDir: e.MIMIR_DATA_DIR,
    dbPath: e.MIMIR_DB_PATH ?? resolve(e.MIMIR_DATA_DIR, 'mimir.db'),
    basicAuth,
    seedDefaults: e.MIMIR_SEED_DEFAULTS,
    logLevel: e.LOG_LEVEL,
    logPretty: e.LOG_PRETTY,
    userAgent: e.HTTP_USER_AGENT,
    feeds: {
      defaultPollSeconds: e.FEED_DEFAULT_POLL_MINUTES * 60,
      minPollSeconds: e.FEED_MIN_POLL_MINUTES * 60,
      maxBackoffSeconds: e.FEED_MAX_BACKOFF_MINUTES * 60,
      concurrency: e.FEED_CONCURRENCY,
      timeoutMs: e.FEED_TIMEOUT_MS,
      retries: e.FEED_RETRIES,
      maxBytes: e.FEED_MAX_BYTES,
      tickMs: e.FEED_SCHEDULER_TICK_MS,
    },
    extraction: {
      enabled: e.EXTRACT_ENABLED,
      concurrency: e.EXTRACT_CONCURRENCY,
      timeoutMs: e.EXTRACT_TIMEOUT_MS,
      maxBytes: e.EXTRACT_MAX_BYTES,
      minFeedChars: e.EXTRACT_MIN_FEED_CHARS,
      respectRobots: e.EXTRACT_RESPECT_ROBOTS,
      allowPrivateNetworks: e.EXTRACT_ALLOW_PRIVATE_NETWORKS,
    },
    jev: {
      apiKey: e.TYPESAFE_API_KEY,
      baseURL: e.TYPESAFE_BASE_URL,
      model: e.JEV_MODEL,
      timeoutMs: e.JEV_TIMEOUT_MS,
    },
    classification: {
      concurrency: e.CLASSIFY_CONCURRENCY,
      maxAttempts: e.CLASSIFY_MAX_ATTEMPTS,
      maxContentChars: e.CLASSIFY_MAX_CONTENT_CHARS,
    },
    stories: {
      matchWindowDays: e.STORY_MATCH_WINDOW_DAYS,
      maxCandidates: e.STORY_MAX_CANDIDATES,
      minSimilarity: e.STORY_MIN_SIMILARITY,
    },
    summaries: {
      provider: e.SUMMARY_PROVIDER,
      language: e.SUMMARY_LANGUAGE,
      autoEnabled: e.SUMMARY_AUTO_ENABLED,
      autoMinPriority: e.SUMMARY_AUTO_MIN_PRIORITY,
      autoMaxPerDay: e.SUMMARY_AUTO_MAX_PER_DAY,
      autoMaxAgeHours: e.SUMMARY_AUTO_MAX_AGE_HOURS,
      minRegenMinutes: e.SUMMARY_MIN_REGEN_MINUTES,
      concurrency: e.SUMMARY_CONCURRENCY,
      maxAttempts: e.SUMMARY_MAX_ATTEMPTS,
      maxArticles: e.SUMMARY_MAX_ARTICLES,
      maxInputChars: e.SUMMARY_MAX_INPUT_CHARS,
      maxOutputTokens: e.SUMMARY_MAX_OUTPUT_TOKENS,
      mock: { mode: e.MOCK_SUMMARY_MODE, delayMs: e.MOCK_SUMMARY_DELAY_MS },
    },
    places: {
      enabled: e.PLACES_ENABLED,
      maxArticles: e.PLACES_MAX_ARTICLES,
      maxInputChars: e.PLACES_MAX_INPUT_CHARS,
      maxOutputTokens: e.PLACES_MAX_OUTPUT_TOKENS,
      tileUrl: e.TILE_URL,
      tileAttribution: e.TILE_ATTRIBUTION,
      geocoder: {
        baseUrl: e.GEOCODER_URL,
        userAgent: e.GEOCODER_USER_AGENT,
        timeoutMs: e.GEOCODER_TIMEOUT_MS,
        minIntervalMs: e.GEOCODER_MIN_INTERVAL_MS,
      },
    },
    terms: {
      enabled: e.TERMS_ENABLED,
      maxArticles: e.TERMS_MAX_ARTICLES,
      maxInputChars: e.TERMS_MAX_INPUT_CHARS,
      maxOutputTokens: e.TERMS_MAX_OUTPUT_TOKENS,
      wikipedia: {
        baseUrl: e.WIKIPEDIA_URL,
        userAgent: e.WIKIPEDIA_USER_AGENT,
        timeoutMs: e.WIKIPEDIA_TIMEOUT_MS,
        minIntervalMs: e.WIKIPEDIA_MIN_INTERVAL_MS,
      },
    },
    world: {
      enabled: e.WORLD_ENABLED,
      refreshHours: e.WORLD_REFRESH_HOURS,
      wikidata: {
        baseUrl: e.WIKIDATA_URL,
        queryUrl: e.WIKIDATA_QUERY_URL,
        userAgent: e.WIKIDATA_USER_AGENT,
        timeoutMs: e.WIKIDATA_TIMEOUT_MS,
        minIntervalMs: e.WIKIDATA_MIN_INTERVAL_MS,
      },
    },
    minimax: {
      apiKey: e.MINIMAX_API_KEY,
      baseURL: e.MINIMAX_BASE_URL,
      quotaURL: e.MINIMAX_QUOTA_URL,
      model: e.MINIMAX_MODEL,
      reasoningEffort: e.MINIMAX_REASONING_EFFORT,
      timeoutMs: e.MINIMAX_TIMEOUT_MS,
      autoReservePercent: e.MINIMAX_AUTO_RESERVE_PERCENT,
      minRemainingPercent: e.MINIMAX_MIN_REMAINING_PERCENT,
    },
    jobs: {
      pollMs: e.JOB_POLL_MS,
      reconcileIntervalMs: e.RECONCILE_INTERVAL_MS,
    },
    retention: {
      fetchLogDays: e.RETENTION_FETCH_LOG_DAYS,
      jobsDays: e.RETENTION_JOBS_DAYS,
    },
  };
}
