import { TypeSafeClient, type Fetch } from '@typesafe-ai/sdk';
import { ClassifierError } from '../classification/types.js';
import { toClassifierError, type JevQuestion, type JevRequest, type ScoreQuestion } from '../classification/jev.js';
import { truncate } from '../util/text.js';

/**
 * Version of the matching questions and decision rule. Bump on any change to
 * questions, criteria, state layout, or thresholds so decisions stay attributable.
 */
export const STORY_MATCHER_VERSION = 'jev-story/1';

export interface MatchReport {
  title: string | null;
  source: string | null;
  summary: string | null;
}

export interface MatchArticle extends MatchReport {
  id: number;
}

export interface MatchCandidate {
  storyId: number;
  headline: string;
  /** What the story already contains: first report, recent developments, other coverage. */
  reports: MatchReport[];
}

export interface LevelAnswer {
  /** Position on the levels, 0 .. levels-1. */
  score: number;
  /** Nearest level, the value decisions are made on. */
  level: number;
  confidence: number | null;
  probabilities: Record<string, number>;
}

export interface CandidateJudgement {
  storyId: number;
  same: LevelAnswer;
  update: LevelAnswer;
}

export interface MatchJudgement {
  model: string;
  candidates: CandidateJudgement[];
  rawRequest: unknown;
  rawResponse: unknown;
  usage: { inputTokens: number | null; outputTokens: number | null };
  durationMs: number;
}

/** Decides, for ambiguous candidates, whether an article reports the same story and whether it adds anything. */
export interface StoryMatcher {
  readonly name: string;
  readonly version: string;
  isConfigured(): boolean;
  configurationHint(): string | null;
  judge(article: MatchArticle, candidates: MatchCandidate[], signal?: AbortSignal): Promise<MatchJudgement>;
}

/** Level 2 of SAME_STORY_LEVELS: the article belongs to the story. */
export const SAME_STORY = 2;
/** Level 2 of UPDATE_LEVELS: the article is a meaningful development. */
export const MEANINGFUL_UPDATE = 2;

export const SAME_STORY_LEVELS: ScoreQuestion['criteria'] = [
  'Different story: the article reports a different event or development, even if it shares companies, people, places, products, or the general topic.',
  'Related but separate: the article is about a distinct event connected to the story, such as a similar incident elsewhere, an earlier or unrelated decision by the same parties, or a general piece about the wider topic.',
  "Same story: the article's main subject is the same specific event or development, for example another outlet's report of it, a follow-up with new facts or reactions about it, or analysis focused on it.",
];

export const UPDATE_LEVELS: ScoreQuestion['criteria'] = [
  'Repeats: the article reports essentially the same facts as the existing reports.',
  'Minor additions: the same facts with small additions such as quotes, background, or color, without changing what is known.',
  'Meaningful development: the article reports new facts, numbers, decisions, confirmations or denials, contradictions, or a changed outcome compared with the existing reports.',
];

function reportState(r: MatchReport, summaryChars: number): Record<string, string> {
  const out: Record<string, string> = { title: r.title ?? '(untitled)', source: r.source ?? 'unknown' };
  if (r.summary) out.summary = truncate(r.summary, summaryChars);
  return out;
}

/** System One request: one same-story and one update question per candidate, answered in parallel. */
export function buildMatchRequest(article: MatchArticle, candidates: MatchCandidate[], model: string): JevRequest {
  const state: JevRequest['state'] = { article: reportState(article, 700) };
  const questions: Record<string, JevQuestion> = {};
  for (const c of candidates) {
    const key = `story_${c.storyId}`;
    state[key] = { headline: c.headline, reports: c.reports.map((r) => reportState(r, 400)) };
    questions[`same__${c.storyId}`] = {
      type: 'score',
      instructions: `Is the article in \`article\` about the same news story as the reports in \`${key}\`?`,
      criteria: SAME_STORY_LEVELS,
    };
    // Speculative: only consulted when the article joins this story.
    questions[`update__${c.storyId}`] = {
      type: 'score',
      instructions: `Compared with the reports in \`${key}\`, what does the article in \`article\` add?`,
      criteria: UPDATE_LEVELS,
    };
  }
  return { model, state, questions };
}

function levelAnswer(answers: Record<string, unknown>, id: string, levels: number): LevelAnswer {
  const a = answers[id] as { type?: string; score?: unknown; confidence?: unknown; probabilities?: unknown } | undefined;
  if (a?.type !== 'score' || typeof a.score !== 'number' || !Number.isFinite(a.score)) {
    throw new ClassifierError(`Missing or malformed score answer "${id}"`, 'bad_response');
  }
  const score = Math.min(levels - 1, Math.max(0, a.score));
  return {
    score,
    level: Math.round(score),
    confidence: typeof a.confidence === 'number' ? a.confidence : null,
    probabilities: (a.probabilities as Record<string, number>) ?? {},
  };
}

export function mapMatchResponse(
  candidates: MatchCandidate[],
  res: { model?: unknown; answers?: unknown },
): CandidateJudgement[] {
  if (!res || typeof res.answers !== 'object' || !res.answers) throw new ClassifierError('Response has no answers', 'bad_response');
  const answers = res.answers as Record<string, unknown>;
  return candidates.map((c) => ({
    storyId: c.storyId,
    same: levelAnswer(answers, `same__${c.storyId}`, SAME_STORY_LEVELS.length),
    update: levelAnswer(answers, `update__${c.storyId}`, UPDATE_LEVELS.length),
  }));
}

export interface JevStoryMatcherOptions {
  apiKey?: string;
  baseURL?: string;
  model: string;
  timeoutMs: number;
  fetch?: Fetch;
}

export class JevStoryMatcher implements StoryMatcher {
  readonly name = 'jev';
  readonly version = STORY_MATCHER_VERSION;
  private readonly client: TypeSafeClient | null;

  constructor(private readonly opts: JevStoryMatcherOptions) {
    this.client = opts.apiKey
      ? new TypeSafeClient({
          apiKey: opts.apiKey,
          baseURL: opts.baseURL,
          defaultModel: opts.model,
          timeout: opts.timeoutMs,
          retry: { maxRetries: 1 },
          logLevel: 'off',
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        })
      : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  configurationHint(): string | null {
    return this.client ? null : 'Set TYPESAFE_API_KEY to enable story matching.';
  }

  async judge(article: MatchArticle, candidates: MatchCandidate[], signal?: AbortSignal): Promise<MatchJudgement> {
    if (!this.client) throw new ClassifierError('Jev is not configured (TYPESAFE_API_KEY missing)', 'auth');
    const req = buildMatchRequest(article, candidates, this.opts.model);
    const started = Date.now();
    let res: { model?: string; answers?: unknown; usage?: { input_tokens?: number | null; output_tokens?: number | null } };
    try {
      res = await this.client.systemOne(req, { signal });
    } catch (err) {
      throw toClassifierError(err);
    }
    return {
      model: typeof res.model === 'string' ? res.model : this.opts.model,
      candidates: mapMatchResponse(candidates, res),
      rawRequest: req,
      rawResponse: res,
      usage: { inputTokens: res.usage?.input_tokens ?? null, outputTokens: res.usage?.output_tokens ?? null },
      durationMs: Date.now() - started,
    };
  }
}
