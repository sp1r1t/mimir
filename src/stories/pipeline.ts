import type { AppConfig } from '../config.js';
import { ClassifierError } from '../classification/types.js';
import type { DB } from '../db/database.js';
import type { Job, JobQueue } from '../jobs/queue.js';
import { JobError, JobWorker } from '../jobs/worker.js';
import type { Logger } from '../logger.js';
import type { Geocoder } from '../places/geocoder.js';
import { geocodeKey, parsePlaces, PlacesValidationError, preparePlacesPrompt, type PlaceKind } from '../places/places.js';
import { CircuitBreaker } from '../pipeline.js';
import type { ProfileRepository } from '../profile/repository.js';
import { SummaryProviderError, type SummaryProvider, type SummaryTrigger } from '../summaries/provider.js';
import { gistTexts, parseSummary, preparePrompt, selectArticles, SUMMARY_PROMPT_VERSION, SummaryValidationError } from '../summaries/summary.js';
import { backoffMs, sleep } from '../util/backoff.js';
import { iso, systemClock, type Clock } from '../util/time.js';
import { assessStory, priorityAt } from './assessment.js';
import { MEANINGFUL_UPDATE, SAME_STORY, type StoryMatcher } from './matcher.js';
import type { Candidate, StoryRepository } from './repository.js';

export const STORY_MATCH = 'story_match';
export const STORY_ASSESS = 'story_assess';
export const STORY_SUMMARY = 'story_summary';
export const STORY_PLACES = 'story_places';

interface MatchPayload {
  articleId: number;
}
interface AssessPayload {
  storyId: number;
}
interface SummaryPayload {
  storyId: number;
  trigger: SummaryTrigger;
  force?: boolean;
}
interface PlacesPayload {
  storyId: number;
  trigger: SummaryTrigger;
  force?: boolean;
}

const MANUAL_PRIORITY = 100;
const BACKFILL_BATCH = 2000;

export interface StoryPipelineDeps {
  db: DB;
  config: AppConfig;
  queue: JobQueue;
  stories: StoryRepository;
  profiles: ProfileRepository;
  matcher: StoryMatcher;
  summaries: SummaryProvider;
  /** The backend that names the places of a story; the same one the summaries use. */
  places: SummaryProvider;
  geocoder: Geocoder;
  log: Logger;
  clock?: Clock;
}

/**
 * Story processing as persistent jobs, independent of ingestion:
 * matching assigns each article to a story, assessment derives story-level signals,
 * summary jobs generate executive summaries within the provider's allowance, and place
 * jobs name the places a story is about and look them up in the gazetteer.
 */
export class StoryPipeline {
  readonly matchBreaker = new CircuitBreaker();
  readonly summaryBreaker = new CircuitBreaker(3, 60_000, 60 * 60_000);
  readonly matchWorker: JobWorker<MatchPayload>;
  readonly assessWorker: JobWorker<AssessPayload>;
  readonly summaryWorker: JobWorker<SummaryPayload>;
  readonly placesWorker: JobWorker<PlacesPayload>;
  private readonly clock: Clock;
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(private readonly d: StoryPipelineDeps) {
    this.clock = d.clock ?? systemClock;
    this.matchWorker = new JobWorker<MatchPayload>(
      d.queue,
      {
        kind: STORY_MATCH,
        // One at a time: concurrent matching could open two stories for the same event.
        concurrency: 1,
        pollMs: d.config.jobs.pollMs,
        handler: (job, signal) => this.handleMatch(job, signal),
        // Paused rather than deferred: every match depends on the stories built from earlier articles.
        pausedReason: () =>
          d.matcher.isConfigured() ? this.matchBreaker.pausedReason() : (d.matcher.configurationHint() ?? 'story matcher not configured'),
        backoff: (attempt) => backoffMs(attempt, 30_000, 30 * 60_000),
      },
      d.log.child({ worker: STORY_MATCH }),
    );
    this.assessWorker = new JobWorker<AssessPayload>(
      d.queue,
      {
        kind: STORY_ASSESS,
        concurrency: 1,
        pollMs: d.config.jobs.pollMs,
        handler: async (job) => this.handleAssess(job),
        backoff: (attempt) => backoffMs(attempt, 5_000, 5 * 60_000),
      },
      d.log.child({ worker: STORY_ASSESS }),
    );
    this.summaryWorker = new JobWorker<SummaryPayload>(
      d.queue,
      {
        kind: STORY_SUMMARY,
        concurrency: d.config.summaries.concurrency,
        pollMs: d.config.jobs.pollMs,
        handler: (job, signal) => this.handleSummary(job, signal),
        pausedReason: () => this.summaryPausedReason(),
        backoff: (attempt) => backoffMs(attempt, 60_000, 30 * 60_000),
        onFinalFailure: (job, error) => {
          const id = d.stories.resolve(job.payload.storyId);
          if (id) d.stories.setSummaryRequest(id, 'failed', error);
        },
      },
      d.log.child({ worker: STORY_SUMMARY }),
    );
    this.placesWorker = new JobWorker<PlacesPayload>(
      d.queue,
      {
        kind: STORY_PLACES,
        concurrency: 1,
        pollMs: d.config.jobs.pollMs,
        handler: (job, signal) => this.handlePlaces(job, signal),
        pausedReason: () => this.placesPausedReason(),
        backoff: (attempt) => backoffMs(attempt, 60_000, 30 * 60_000),
        onFinalFailure: (job, error) => {
          const id = d.stories.resolve(job.payload.storyId);
          if (id) d.stories.setPlacesState(id, 'failed', error);
        },
      },
      d.log.child({ worker: STORY_PLACES }),
    );
  }

  start(): void {
    this.reconcile();
    this.matchWorker.start();
    this.assessWorker.start();
    this.summaryWorker.start();
    this.placesWorker.start();
    this.reconcileTimer = setInterval(() => this.reconcile(), this.d.config.jobs.reconcileIntervalMs);
    this.reconcileTimer.unref();
    if (this.d.summaries.isConfigured()) void this.checkProvider();
  }

  /** Verify the summary provider's credentials and allowance once, so problems surface before the first summary. */
  private async checkProvider(): Promise<void> {
    const p = this.d.summaries;
    try {
      const c = await p.capacity('manual');
      if (c.ok) this.d.log.info({ provider: p.name, model: p.model, allowance: p.allowance()?.windows }, 'summary provider ready');
      else this.d.log.warn({ provider: p.name, reason: c.reason, retryAt: c.retryAt }, 'summary provider not usable yet');
    } catch (err) {
      this.d.log.warn({ err, provider: p.name }, 'summary provider check failed');
    }
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await Promise.all([this.matchWorker.stop(), this.assessWorker.stop(), this.summaryWorker.stop(), this.placesWorker.stop()]);
  }

  notify(): void {
    this.matchWorker.notify();
    this.assessWorker.notify();
    this.summaryWorker.notify();
    this.placesWorker.notify();
  }

  /** Failed jobs were re-queued: lift circuit-breaker pauses and align summary states. */
  resumeAfterRetry(): void {
    this.matchBreaker.success();
    this.summaryBreaker.success();
    this.d.stories.reconcileSummaryRequests(STORY_SUMMARY);
    this.d.stories.reconcilePlacesRequests(STORY_PLACES);
    this.notify();
  }

  summaryPausedReason(): string | null {
    const p = this.d.summaries;
    if (!p.isConfigured()) return p.configurationHint() ?? 'summary provider not configured';
    return this.summaryBreaker.pausedReason();
  }

  placesPausedReason(): string | null {
    if (!this.d.config.places.enabled) return 'place lookup is turned off';
    if (!this.d.places.isConfigured()) return this.d.places.configurationHint() ?? 'place lookup is not configured';
    return null;
  }

  automaticSummaryBudget() {
    return this.d.stories.automaticSummaryBudget(this.d.config.summaries.autoMaxPerDay);
  }

  /** Called inside the ingestion transaction for each new article. */
  onNewArticle(articleId: number, priority = 10): void {
    this.d.queue.enqueue(STORY_MATCH, `article:${articleId}`, { articleId }, { priority, maxAttempts: 8 });
  }

  /** The article's current classification changed: its story's assessment may too. */
  onClassified(articleId: number): void {
    const storyId = this.d.stories.storyIdOf(articleId);
    if (storyId != null) this.enqueueAssess(storyId);
  }

  /** Assessments read the latest membership and classifications, so a change during a running one reruns it. */
  enqueueAssess(storyId: number, priority = 5): void {
    if (this.d.queue.enqueue(STORY_ASSESS, `story:${storyId}`, { storyId }, { priority, maxAttempts: 5, rerunIfRunning: true })) this.assessWorker.notify();
  }

  /** Manual generation or regeneration: any story, ahead of automatic work. */
  requestSummary(storyId: number): { queued: boolean; message: string } {
    const s = this.d.stories.item(storyId);
    if (!s || s.status !== 'active') return { queued: false, message: 'Story not found.' };
    if (!this.d.summaries.isConfigured()) return { queued: false, message: this.d.summaries.configurationHint() ?? 'No summary provider configured.' };
    const payload: SummaryPayload = { storyId, trigger: 'manual', force: true };
    const key = `story:${storyId}`;
    const opts = { priority: MANUAL_PRIORITY, maxAttempts: this.d.config.summaries.maxAttempts };
    if (!this.d.queue.enqueue(STORY_SUMMARY, key, payload, opts) && !this.d.queue.promote(STORY_SUMMARY, key, MANUAL_PRIORITY, payload)) {
      return { queued: false, message: 'A summary for this story is already being generated.' };
    }
    this.d.stories.setSummaryRequest(storyId, 'pending');
    this.summaryWorker.notify();
    return { queued: true, message: 'Summary queued.' };
  }

  /** The reader asked for the map: name the places of this story and look them up. */
  requestPlaces(storyId: number): { queued: boolean; message: string } {
    const s = this.d.stories.item(storyId);
    if (!s || s.status !== 'active') return { queued: false, message: 'Story not found.' };
    if (!this.d.config.places.enabled) return { queued: false, message: 'Place lookup is turned off.' };
    if (!this.d.places.isConfigured()) {
      return { queued: false, message: this.d.places.configurationHint() ?? 'No place provider configured.' };
    }
    const payload: PlacesPayload = { storyId, trigger: 'manual', force: true };
    const key = `story:${storyId}`;
    const opts = { priority: MANUAL_PRIORITY, maxAttempts: this.d.config.summaries.maxAttempts };
    if (!this.d.queue.enqueue(STORY_PLACES, key, payload, opts) && !this.d.queue.promote(STORY_PLACES, key, MANUAL_PRIORITY, payload)) {
      return { queued: false, message: 'The places of this story are already being looked up.' };
    }
    this.d.stories.setPlacesState(storyId, 'pending');
    this.placesWorker.notify();
    return { queued: true, message: 'Looking for the places of this story.' };
  }

  merge(sourceId: number, targetId: number): void {
    this.d.stories.merge(sourceId, targetId);
    this.enqueueAssess(targetId, 20);
  }

  split(storyId: number, articleIds: number[]): number {
    const newId = this.d.stories.split(storyId, articleIds);
    for (const id of [storyId, newId]) this.enqueueAssess(id, 20);
    return newId;
  }

  /** Backfill articles without a story, reassess after profile changes, repair summary states after a restart. */
  reconcile(): void {
    try {
      const outdated = this.d.stories.outdatedAssessments(this.d.profiles.active().version, STORY_ASSESS, BACKFILL_BATCH);
      if (outdated.length) {
        this.d.db.transaction(() => {
          for (const id of outdated) this.enqueueAssess(id, 0);
        })();
        this.d.log.info({ count: outdated.length }, 'queued story assessments for the active profile');
      }
      const ids = this.d.stories.unassignedWithoutJob(STORY_MATCH, BACKFILL_BATCH);
      if (ids.length) {
        this.d.db.transaction(() => {
          for (const id of ids) this.onNewArticle(id, 0);
        })();
        this.d.log.info({ count: ids.length }, 'queued story matching for articles without a story');
      }
      const fixed = this.d.stories.reconcileSummaryRequests(STORY_SUMMARY);
      if (fixed) this.d.log.info({ fixed }, 'repaired summary request states');
      const fixedPlaces = this.d.stories.reconcilePlacesRequests(STORY_PLACES);
      if (fixedPlaces) this.d.log.info({ fixed: fixedPlaces }, 'repaired place request states');
      // Eligibility also changes without new articles (provider configured, capacity restored, budget reset).
      const cfg = this.d.config.summaries;
      if (cfg.autoEnabled && this.d.summaries.isConfigured()) {
        const since = iso(new Date(this.clock().getTime() - cfg.autoMaxAgeHours * 3_600_000));
        for (const id of this.d.stories.summaryCandidates(since, BACKFILL_BATCH)) this.considerAutoSummary(id);
      }
    } catch (err) {
      this.d.log.error({ err }, 'story reconcile failed');
    }
  }

  // ---- Matching -----------------------------------------------------------------------

  private async handleMatch(job: Job<MatchPayload>, signal: AbortSignal): Promise<void> {
    const { articleId } = job.payload;
    const st = this.d.stories;
    if (st.storyIdOf(articleId) != null) return;
    const article = st.articleForMatching(articleId);
    if (!article) return;
    const cfg = this.d.config.stories;
    const candidates = st.candidates(article, { windowDays: cfg.matchWindowDays, limit: cfg.maxCandidates });
    const titleHit = candidates.find((c) => c.titleMatch);
    const plausible = candidates.filter((c) => c.similarity >= cfg.minSimilarity);

    let storyId: number;
    if (titleHit) {
      storyId = this.d.db.transaction(() => {
        const target = st.resolve(titleHit.storyId)!;
        const matchId = st.recordMatch({ articleId, storyId: target, outcome: 'joined', role: 'coverage', method: 'title_match', candidates });
        st.addToStory(target, article, 'coverage', matchId);
        return target;
      })();
    } else if (!plausible.length) {
      storyId = this.d.db.transaction(() => {
        const matchId = st.recordMatch({ articleId, storyId: null, outcome: 'new_story', role: 'origin', method: 'no_candidates', candidates });
        const id = st.createStory(article, 'matcher', matchId);
        this.d.db.prepare('UPDATE story_matches SET story_id = ? WHERE id = ?').run(id, matchId);
        return id;
      })();
    } else {
      storyId = await this.judgeAndAssign(article, plausible, candidates, signal);
    }
    this.enqueueAssess(storyId);
  }

  private async judgeAndAssign(
    article: NonNullable<ReturnType<StoryRepository['articleForMatching']>>,
    plausible: Candidate[],
    all: Candidate[],
    signal: AbortSignal,
  ): Promise<number> {
    const st = this.d.stories;
    const matcher = this.d.matcher;
    const views = plausible.map((c) => st.candidateView(c.storyId)).filter((v) => v != null);
    let judgement;
    try {
      judgement = await matcher.judge({ id: article.id, title: article.title, source: article.sourceName, summary: article.summaryText }, views, signal);
    } catch (err) {
      if (!(err instanceof ClassifierError)) throw err;
      switch (err.kind) {
        case 'auth':
          this.matchBreaker.failure(err.message, 10 * 60_000);
          throw new JobError(err.message, { retryable: true, defer: true, delayMs: 0 });
        case 'unavailable':
          this.matchBreaker.failure(err.message, err.retryAfterMs ?? 0);
          throw new JobError(err.message, { retryable: true, delayMs: err.retryAfterMs ?? undefined });
        case 'invalid_input':
          throw new JobError(err.message, { retryable: false });
        case 'bad_response':
          throw new JobError(err.message, { retryable: true });
      }
    }
    this.matchBreaker.success();
    const best = judgement.candidates
      .filter((c) => c.same.level === SAME_STORY)
      .sort((a, b) => b.same.score - a.same.score)[0];
    const decided = all.map((c) => ({ ...c, ...judgement.candidates.find((j) => j.storyId === c.storyId) }));
    const provenance = {
      candidates: decided,
      matcher: matcher.name,
      matcherVersion: matcher.version,
      model: judgement.model,
      rawRequest: judgement.rawRequest,
      rawResponse: judgement.rawResponse,
      inputTokens: judgement.usage.inputTokens,
      outputTokens: judgement.usage.outputTokens,
      durationMs: judgement.durationMs,
    };
    return this.d.db.transaction(() => {
      if (st.storyIdOf(article.id) != null) return st.storyIdOf(article.id)!;
      const target = best ? st.resolve(best.storyId) : null;
      if (target != null && best) {
        const role = best.update.level === MEANINGFUL_UPDATE ? 'update' : 'coverage';
        const matchId = st.recordMatch({ articleId: article.id, storyId: target, outcome: 'joined', role, method: 'matcher', ...provenance });
        st.addToStory(target, article, role, matchId);
        return target;
      }
      const matchId = st.recordMatch({ articleId: article.id, storyId: null, outcome: 'new_story', role: 'origin', method: 'matcher', ...provenance });
      const id = st.createStory(article, 'matcher', matchId);
      this.d.db.prepare('UPDATE story_matches SET story_id = ? WHERE id = ?').run(id, matchId);
      return id;
    })();
  }

  // ---- Assessment -----------------------------------------------------------------------

  private handleAssess(job: Job<AssessPayload>): void {
    const storyId = this.d.stories.resolve(job.payload.storyId);
    if (storyId == null) return;
    const story = this.d.stories.item(storyId);
    const members = this.d.stories.assessmentMembers(storyId);
    if (!story || !members.length) return;
    const assessment = assessStory(members, story.latestDevelopmentAt, this.d.profiles.active());
    this.d.stories.saveAssessment(storyId, assessment);
    this.considerAutoSummary(storyId);
  }

  /** Automatic summaries only for high-priority, recent stories, within the daily budget. */
  private considerAutoSummary(storyId: number): void {
    const cfg = this.d.config.summaries;
    if (!cfg.autoEnabled || !this.d.summaries.isConfigured()) return;
    const s = this.d.stories.item(storyId);
    if (!s || s.summaryRequest !== 'idle') return;
    if (s.summaryId != null && !s.summaryStale) return;
    const now = this.clock().getTime();
    const priority = priorityAt(s, now);
    if (priority == null || priority < cfg.autoMinPriority) return;
    if (!s.latestDevelopmentAt || now - Date.parse(s.latestDevelopmentAt) > cfg.autoMaxAgeHours * 3_600_000) return;
    const last = this.d.stories.lastSummaryAt(storyId);
    if (last && now - Date.parse(last) < cfg.minRegenMinutes * 60_000) return;
    const budget = this.automaticSummaryBudget();
    if (budget.used + this.d.queue.countActive(STORY_SUMMARY, { trigger: 'auto' }) >= budget.limit) return;
    const payload: SummaryPayload = { storyId, trigger: 'auto' };
    if (this.d.queue.enqueue(STORY_SUMMARY, `story:${storyId}`, payload, { priority: 10 + Math.round(priority * 10), maxAttempts: cfg.maxAttempts })) {
      this.d.stories.setSummaryRequest(storyId, 'pending');
      this.summaryWorker.notify();
    }
  }

  // ---- Summaries ------------------------------------------------------------------------

  private async handleSummary(job: Job<SummaryPayload>, signal: AbortSignal): Promise<void> {
    const { trigger, force } = job.payload;
    const st = this.d.stories;
    const storyId = st.resolve(job.payload.storyId);
    if (storyId == null) return;
    const cfg = this.d.config.summaries;
    const input = st.summaryInput(storyId);
    if (!input || !input.articles.length) return st.setSummaryRequest(storyId, 'idle');
    const selected = selectArticles(input.articles, cfg.maxArticles);
    const current = st.currentSummary(storyId);
    // The brief that is being replaced: the new one leads with what changed since it.
    const previous = current
      ? {
          headline: current.content.headline,
          gist: gistTexts(current.content),
          createdAt: current.createdAt,
          articleIds: current.articles.map((a) => a.articleId),
        }
      : null;
    const prompt = preparePrompt(input.story, selected, {
      maxInputChars: cfg.maxInputChars,
      language: cfg.language,
      previous,
    });
    if (current && current.inputHash === prompt.inputHash && !force) return st.confirmSummary(storyId);

    const budget = this.automaticSummaryBudget();
    if (trigger === 'auto' && budget.used >= budget.limit) {
      const reason = `Mimir automatic-summary limit reached (${budget.used}/${budget.limit} provider attempts in the past 24 hours). MiniMax allowance is separate; Generate now requests a manual summary.`;
      st.setSummaryRequest(storyId, 'pending', reason);
      const delayMs = budget.resumesAt ? Math.max(1000, Date.parse(budget.resumesAt) - this.clock().getTime()) : 60 * 60_000;
      throw new JobError(reason, { retryable: true, defer: true, delayMs });
    }
    const provider = this.d.summaries;
    const capacity = await provider.capacity(trigger, signal);
    if (!capacity.ok) {
      st.setSummaryRequest(storyId, 'pending', capacity.reason);
      const until = capacity.retryAt ? Math.max(60_000, Date.parse(capacity.retryAt) - Date.now()) : 15 * 60_000;
      throw new JobError(capacity.reason, { retryable: true, defer: true, delayMs: until });
    }

    st.setSummaryRequest(storyId, 'running');
    const startedAt = iso(this.clock());
    const attempt = { storyId, trigger, provider: provider.name, startedAt };
    let result;
    try {
      result = await provider.generate({ system: prompt.system, user: prompt.user, maxOutputTokens: cfg.maxOutputTokens }, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      const e = err instanceof SummaryProviderError ? err : new SummaryProviderError(err instanceof Error ? err.message : String(err), 'unavailable');
      st.recordAttempt({ ...attempt, model: provider.model, outcome: e.kind, error: e.message, summaryId: null, inputTokens: null, outputTokens: null, durationMs: null });
      st.setSummaryRequest(storyId, 'pending', e.message);
      switch (e.kind) {
        case 'auth':
        case 'plan':
          this.summaryBreaker.failure(e.message, 30 * 60_000);
          throw new JobError(e.message, { retryable: true, defer: true, delayMs: 30 * 60_000 });
        case 'quota':
          this.summaryBreaker.failure(e.message, e.retryAfterMs ?? 30 * 60_000);
          throw new JobError(e.message, { retryable: true, defer: true, delayMs: e.retryAfterMs ?? 30 * 60_000 });
        case 'rate_limited':
          this.summaryBreaker.failure(e.message, e.retryAfterMs ?? 60_000);
          throw new JobError(e.message, { retryable: true, defer: true, delayMs: e.retryAfterMs ?? 60_000 });
        case 'unavailable':
          this.summaryBreaker.failure(e.message);
          throw new JobError(e.message, { retryable: true, delayMs: e.retryAfterMs ?? undefined });
        case 'invalid_output':
          throw new JobError(e.message, { retryable: true });
        case 'rejected':
          throw new JobError(e.message, { retryable: false });
      }
    }
    this.summaryBreaker.success();
    const usage = { model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, durationMs: result.durationMs };
    let content;
    try {
      content = parseSummary(result.text, new Set(selected.map((a) => a.id)));
    } catch (err) {
      if (!(err instanceof SummaryValidationError)) throw err;
      st.recordAttempt({ ...attempt, ...usage, outcome: 'invalid_output', error: err.message, summaryId: null });
      st.setSummaryRequest(storyId, 'pending', err.message);
      throw new JobError(err.message, { retryable: true });
    }
    const summaryId = st.saveSummary(storyId, {
      trigger,
      provider: provider.name,
      model: result.model,
      promptVersion: SUMMARY_PROMPT_VERSION,
      inputHash: prompt.inputHash,
      articles: prompt.articles,
      content,
      rawOutput: result.text,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      durationMs: result.durationMs,
    });
    st.recordAttempt({ ...attempt, ...usage, outcome: summaryId ? 'ok' : 'discarded', error: summaryId ? null : 'Story articles changed during generation', summaryId });
    if (!summaryId) throw new JobError('story articles changed during generation', { retryable: true, defer: true, delayMs: 0 });
  }

  // ---- Places -------------------------------------------------------------------------

  /**
   * Name the places the story is about, then look each name up in the gazetteer. A name
   * that the gazetteer does not know is kept as a name, without a pin.
   */
  private async handlePlaces(job: Job<PlacesPayload>, signal: AbortSignal): Promise<void> {
    const st = this.d.stories;
    const storyId = st.resolve(job.payload.storyId);
    if (storyId == null) return;
    const cfg = this.d.config.places;
    if (!cfg.enabled) return st.setPlacesState(storyId, 'none');
    const input = st.summaryInput(storyId);
    if (!input || !input.articles.length) return st.setPlacesState(storyId, 'none');
    const selected = selectArticles(input.articles, cfg.maxArticles);
    const prompt = preparePlacesPrompt(input.story, selected, {
      maxInputChars: cfg.maxInputChars,
      language: this.d.config.summaries.language,
    });

    const provider = this.d.places;
    const capacity = await provider.capacity('manual', signal);
    if (!capacity.ok) {
      st.setPlacesState(storyId, 'pending', capacity.reason);
      const until = capacity.retryAt ? Math.max(60_000, Date.parse(capacity.retryAt) - Date.now()) : 15 * 60_000;
      throw new JobError(capacity.reason, { retryable: true, defer: true, delayMs: until });
    }

    st.setPlacesState(storyId, 'running');
    let result;
    try {
      result = await provider.generate({ system: prompt.system, user: prompt.user, maxOutputTokens: cfg.maxOutputTokens }, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      const e = err instanceof SummaryProviderError ? err : new SummaryProviderError(err instanceof Error ? err.message : String(err), 'unavailable');
      st.setPlacesState(storyId, 'pending', e.message);
      throw new JobError(e.message, { retryable: true, delayMs: e.retryAfterMs ?? undefined });
    }

    let found;
    try {
      found = parsePlaces(result.text, new Set(selected.map((a) => a.id)));
    } catch (err) {
      if (!(err instanceof PlacesValidationError)) throw err;
      st.setPlacesState(storyId, 'pending', err.message);
      throw new JobError(err.message, { retryable: true });
    }

    const places = [];
    const failures: string[] = [];
    for (const p of found) {
      const key = geocodeKey(p.query ?? p.name, p.kind, p.countryCode);
      let g = st.cachedGeocode(key);
      if (!g) {
        try {
          g = await this.lookupPlace(p);
          st.saveGeocode(key, g);
        } catch (err) {
          // The name is worth keeping even when the gazetteer cannot be reached.
          g = { status: 'unresolved', lat: null, lon: null, label: null, displayName: null, osmId: null };
          failures.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      places.push({
        name: p.name,
        kind: p.kind,
        country: p.country,
        countryCode: p.countryCode,
        query: p.query,
        role: p.role,
        lat: g.lat,
        lon: g.lon,
        label: g.label,
        displayName: g.displayName,
        osmId: g.osmId,
        status: g.status,
        sources: p.sources,
      });
    }
    st.savePlaces(storyId, places);
    if (failures.length) {
      st.setPlacesState(storyId, 'ready', `The gazetteer could not be reached for ${failures.length} place(s): ${failures.join('; ')}`);
    }
  }

  /** The gazetteer gets three tries: it is a public service and it says so. */
  private async lookupPlace(place: { name: string; country: string | null; countryCode: string | null; kind: PlaceKind; query: string | null }) {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.d.geocoder.lookup(place);
      } catch (err) {
        lastError = err;
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
