import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { JevClassifier } from './classification/jev.js';
import type { Classifier } from './classification/types.js';
import { getMeta, openDatabase, setMeta, type DB } from './db/database.js';
import { ArticleExtractor } from './extraction/extractor.js';
import { FeedIngestor } from './feeds/ingest.js';
import { FeedScheduler } from './feeds/scheduler.js';
import { JobQueue } from './jobs/queue.js';
import type { Logger } from './logger.js';
import { CONFIG_DIR } from './paths.js';
import { NominatimGeocoder, type Geocoder } from './places/geocoder.js';
import { Pipeline, recencyPriority } from './pipeline.js';
import { loadDefaultProfile, ProfileRepository } from './profile/repository.js';
import { ArticleRepository } from './repo/articles.js';
import { FeedbackRepository } from './repo/feedback.js';
import { SourceRepository } from './repo/sources.js';
import { StatsRepository } from './repo/stats.js';
import { JevStoryMatcher, type StoryMatcher } from './stories/matcher.js';
import { StoryPipeline } from './stories/pipeline.js';
import { StoryRepository } from './stories/repository.js';
import { MiniMaxProvider } from './summaries/minimax.js';
import { MockSummaryProvider } from './summaries/mock.js';
import { DisabledSummaryProvider, type SummaryProvider } from './summaries/provider.js';
import { systemClock, type Clock } from './util/time.js';

export interface App {
  config: AppConfig;
  db: DB;
  log: Logger;
  queue: JobQueue;
  sources: SourceRepository;
  articles: ArticleRepository;
  profiles: ProfileRepository;
  feedback: FeedbackRepository;
  stats: StatsRepository;
  classifier: Classifier;
  pipeline: Pipeline;
  stories: StoryRepository;
  storyPipeline: StoryPipeline;
  summaries: SummaryProvider;
  scheduler: FeedScheduler;
  startedAt: Date;
  start(): void;
  stop(): Promise<void>;
}

const DefaultFeedsSchema = z.array(
  z.object({ name: z.string(), url: z.string().url(), pollMinutes: z.number().int().min(1), tags: z.array(z.string()).default([]) }),
);

export function createApp(
  config: AppConfig,
  log: Logger,
  overrides: {
    classifier?: Classifier;
    clock?: Clock;
    db?: DB;
    extractor?: ArticleExtractor;
    geocoder?: Geocoder;
    matcher?: StoryMatcher;
    summaries?: SummaryProvider;
    places?: SummaryProvider;
  } = {},
): App {
  const clock = overrides.clock ?? systemClock;
  const db = overrides.db ?? openDatabase(config.dbPath);
  const queue = new JobQueue(db, clock);
  const sources = new SourceRepository(db, clock);
  const articles = new ArticleRepository(db, clock);
  const profiles = new ProfileRepository(db, clock);
  const feedback = new FeedbackRepository(db, clock);
  const stats = new StatsRepository(db, clock);
  const classifier =
    overrides.classifier ??
    new JevClassifier({
      apiKey: config.jev.apiKey,
      baseURL: config.jev.baseURL,
      model: config.jev.model,
      timeoutMs: config.jev.timeoutMs,
      maxContentChars: config.classification.maxContentChars,
    });
  const extractor =
    overrides.extractor ??
    new ArticleExtractor({
      userAgent: config.userAgent,
      timeoutMs: config.extraction.timeoutMs,
      maxBytes: config.extraction.maxBytes,
      respectRobots: config.extraction.respectRobots,
      allowPrivateNetworks: config.extraction.allowPrivateNetworks,
    });

  const stories = new StoryRepository(db, clock);
  const matcher =
    overrides.matcher ??
    new JevStoryMatcher({ apiKey: config.jev.apiKey, baseURL: config.jev.baseURL, model: config.jev.model, timeoutMs: config.jev.timeoutMs });
  const summaries = overrides.summaries ?? summaryProvider(config);
  // The places are named by the same kind of model as the summaries, so the same
  // provider answers both unless another one is given.
  const places = overrides.places ?? summaries;
  const geocoder = overrides.geocoder ?? new NominatimGeocoder(config.places.geocoder);

  seed(db, config, sources, profiles, log);

  const storyPipeline = new StoryPipeline({ db, config, queue, stories, profiles, matcher, summaries, places, geocoder, log, clock });
  const pipeline = new Pipeline({
    db, config, queue, articles, sources, profiles, classifier, extractor, log, clock,
    onClassified: (id) => storyPipeline.onClassified(id),
  });
  const ingestor = new FeedIngestor(
    db,
    (id) => {
      pipeline.onNewArticle(id);
      storyPipeline.onNewArticle(id, recencyPriority(articles.forExtraction(id)?.publishedAt ?? null, clock()));
    },
    clock,
  );
  const scheduler = new FeedScheduler(
    sources,
    ingestor,
    { ...config.feeds, userAgent: config.userAgent },
    log.child({ component: 'feeds' }),
    clock,
    () => {
      pipeline.notify();
      storyPipeline.notify();
    },
  );

  let started = false;
  return {
    config,
    db,
    log,
    queue,
    sources,
    articles,
    profiles,
    feedback,
    stats,
    classifier,
    pipeline,
    stories,
    storyPipeline,
    summaries,
    scheduler,
    startedAt: clock(),
    start() {
      if (started) return;
      started = true;
      if (!classifier.isConfigured()) {
        log.warn({ hint: classifier.configurationHint() }, 'classifier not configured; articles will be collected and queued for classification');
      }
      if (!summaries.isConfigured()) log.warn({ hint: summaries.configurationHint() }, 'executive summaries disabled');
      pipeline.start();
      storyPipeline.start();
      scheduler.start();
    },
    async stop() {
      if (!started) return;
      started = false;
      await scheduler.stop();
      await Promise.all([pipeline.stop(), storyPipeline.stop()]);
    },
  };
}

function summaryProvider(config: AppConfig): SummaryProvider {
  switch (config.summaries.provider) {
    case 'minimax':
      return new MiniMaxProvider({ ...config.minimax, quotaCacheMs: 60_000 });
    case 'mock':
      return new MockSummaryProvider(config.summaries.mock.mode, config.summaries.mock.delayMs);
    case 'none':
      return new DisabledSummaryProvider();
  }
}

function seed(db: DB, config: AppConfig, sources: SourceRepository, profiles: ProfileRepository, log: Logger): void {
  if (profiles.count() === 0) {
    profiles.createVersion(loadDefaultProfile(), { author: 'system', changeNote: 'Initial default profile' });
    log.info('created default interest profile (version 1)');
  }
  if (config.seedDefaults && !getMeta(db, 'seeded_default_feeds')) {
    const feeds = DefaultFeedsSchema.parse(JSON.parse(readFileSync(join(CONFIG_DIR, 'default-feeds.json'), 'utf8')));
    let added = 0;
    db.transaction(() => {
      for (const f of feeds) {
        if (sources.byUrl(f.url)) continue;
        sources.create({
          name: f.name,
          url: f.url,
          pollIntervalSeconds: Math.max(f.pollMinutes * 60, config.feeds.minPollSeconds),
          config: { tags: f.tags },
        });
        added++;
      }
      setMeta(db, 'seeded_default_feeds', new Date().toISOString());
    })();
    log.info({ added }, 'seeded default feed subscriptions');
  }
}
