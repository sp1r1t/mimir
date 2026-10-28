import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  type Fetch,
} from '@typesafe-ai/sdk';
import type { InterestProfile, Topic } from '../profile/schema.js';
import { sha256, stableStringify } from '../util/hash.js';
import { truncate } from '../util/text.js';
import {
  ClassifierError,
  type CategoryAssessment,
  type ClassificationArticle,
  type ClassificationResult,
  type Classifier,
} from './types.js';

/**
 * Version of the question set and mapping below. Bump it whenever questions,
 * criteria, state layout, or normalization change, so results stay attributable.
 */
export const JEV_CLASSIFIER_VERSION = 'jev-news/1';

const TOPIC_PREFIX = 'topic__';

// ---- Request construction (System One: POST /v1/systemone) -----------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
type Instructions = Exclude<JsonValue, number | boolean>;

export interface NoulQuestion {
  type: 'noul';
  instructions: Instructions;
  criteria?: { true?: string; false?: string };
}
export interface ScoreQuestion {
  type: 'score';
  instructions: Instructions;
  criteria: [string, string, ...string[]];
}
export interface ChoiceQuestion {
  type: 'choice';
  instructions: Instructions;
  criteria: Record<string, string>;
}
export type JevQuestion = NoulQuestion | ScoreQuestion | ChoiceQuestion;

export interface JevRequest {
  model: string;
  state: Record<string, JsonValue>;
  questions: Record<string, JevQuestion>;
}

export const RELEVANCE_LEVELS: ScoreQuestion['criteria'] = [
  "Not relevant: outside the reader's interests, or matches one of the reader's exclusions.",
  "Marginal: touches the reader's interests only tangentially, or is low-value material the reader's editorial preferences disfavor.",
  "Somewhat relevant: within the reader's interests, but routine or of modest value to them.",
  "Relevant: a substantive development within the reader's interests that they would likely want to read.",
  "Highly relevant: an important, substantive development squarely within the reader's high-priority interests that they would not want to miss.",
];

export const SIGNIFICANCE_LEVELS: ScoreQuestion['criteria'] = [
  'Trivial: no real consequence; filler, gossip, promotion, or minor commentary.',
  'Minor: a small update with limited consequences, mainly of interest to a niche audience.',
  'Notable: a meaningful development within its field or community.',
  'Major: a development with broad consequences across an industry, a scientific field, or a country.',
  'Historic: a development with lasting, far-reaching consequences that will be widely referenced for years.',
];

export const URGENCY_LEVELS: ScoreQuestion['criteria'] = [
  'Not time-sensitive: evergreen or background material that is just as useful weeks from now.',
  'Low: worth reading within the next few weeks; it will not go stale soon.',
  'Moderate: worth knowing within the next few days, before it becomes stale.',
  'High: breaking or fast-moving news worth knowing today, such as a critical security vulnerability, a major outage, or a major breaking event.',
];

export const ARTICLE_TYPES: Record<string, string> = {
  news_report: 'Reporting of a new event or development.',
  analysis: 'In-depth explanation or analysis of a development, technology, or issue.',
  opinion: 'An opinion, commentary, or personal essay.',
  research: 'A research paper, study, or summary of new research findings.',
  release: 'A software, product, or model release announcement with substantive details.',
  tutorial: 'A how-to guide, tutorial, or reference documentation.',
  promotional: 'Marketing, sponsored content, a deal, or a press release without substance.',
  discussion: 'A link to a discussion, a forum post, or an item with too little content to judge.',
  other: 'None of the above.',
};

function priorityPhrase(p: Topic['priority']): string {
  return { core: 'core interest (highest priority)', high: 'high priority', normal: 'normal priority', low: 'low priority' }[p];
}

/** Build the System One request for one article against an interest profile. */
export function buildJevRequest(
  article: ClassificationArticle,
  profile: InterestProfile,
  opts: { model: string; maxContentChars: number },
): JevRequest {
  const def = profile.definition;
  const topics = def.topics.filter((t) => t.enabled);
  const articleState: Record<string, JsonValue> = {
    title: article.title ?? '(untitled)',
    source: article.sourceName ?? 'unknown',
  };
  if (article.author) articleState.author = article.author;
  if (article.feedCategories.length) articleState.source_tags = article.feedCategories.slice(0, 15);
  if (article.summary) articleState.summary = truncate(article.summary, 1500);
  if (article.text && article.text !== article.summary) {
    articleState.text_excerpt = truncate(article.text, opts.maxContentChars);
  }
  if (article.contentQuality === 'partial') articleState.text_completeness = 'partial';

  const reader: Record<string, JsonValue> = {
    interests: topics.map((t) => ({ topic: t.label, description: t.description, priority: priorityPhrase(t.priority) })),
  };
  if (def.summary) reader.about = def.summary;
  if (def.exclusions.length) reader.exclusions = def.exclusions.map((x) => x.description);
  if (def.editorialPreferences.length) reader.editorial_preferences = def.editorialPreferences;

  const state: Record<string, JsonValue> = { article: articleState, reader_profile: reader };
  // Inferred interests (future behavioural learning) stay separate from explicit ones.
  if (def.inferred.topics.length) {
    state.inferred_interests = def.inferred.topics.map((t) => ({ topic: t.label, description: t.description }));
  }

  const questions: Record<string, JevQuestion> = {};
  for (const t of topics) {
    questions[`${TOPIC_PREFIX}${t.id}`] = {
      type: 'noul',
      instructions: {
        question: 'Is the article in `article` substantively about the topic below? A passing mention does not count.',
        topic: { name: t.label, description: t.description || t.label },
      },
      criteria: {
        true: "The article's main subject, or a major part of it, falls within this topic.",
        false: 'The topic is absent from the article or only mentioned in passing.',
      },
    };
  }
  questions.personal_relevance = {
    type: 'score',
    instructions:
      'How relevant is the article in `article` to the reader described in `reader_profile`? Take into account the priorities of `reader_profile.interests`, `reader_profile.exclusions`, and `reader_profile.editorial_preferences`.',
    criteria: RELEVANCE_LEVELS,
  };
  questions.significance = {
    type: 'score',
    instructions:
      'Regardless of any particular reader, how significant is the development reported in `article` for the world, an industry, or a field?',
    criteria: SIGNIFICANCE_LEVELS,
  };
  questions.urgency = {
    type: 'score',
    instructions: 'How time-sensitive is the information in `article` for someone who wants to stay well informed?',
    criteria: URGENCY_LEVELS,
  };
  questions.investigate = {
    type: 'noul',
    instructions:
      'Would it be worthwhile for the reader described in `reader_profile` to investigate the development in `article` further, for example by reading primary sources or following how it develops?',
    criteria: {
      true: 'The development is substantive and relevant to the reader, and has open questions, consequences, or details worth following up.',
      false: 'The article is low-value, self-contained, or irrelevant to the reader; reading it once, or not at all, is enough.',
    },
  };
  questions.promotional = {
    type: 'noul',
    instructions:
      'Is the article in `article` primarily marketing, promotion, sponsored content, or a routine announcement without substantive new information?',
  };
  if (def.exclusions.length) {
    questions.exclusion = {
      type: 'noul',
      instructions: 'Does the article in `article` match any of the exclusions listed in `reader_profile.exclusions`?',
    };
  }
  questions.article_type = {
    type: 'choice',
    instructions: 'What kind of piece is the article in `article`?',
    criteria: ARTICLE_TYPES,
  };

  return { model: opts.model, state, questions };
}

// ---- Response mapping --------------------------------------------------------

interface NoulAnswer {
  type: 'noul';
  noul: number;
}
interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}
interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevResponse {
  model: string;
  answers: Record<string, unknown>;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function noul(answers: Record<string, unknown>, id: string, required: boolean): number | null {
  const a = answers[id] as Partial<NoulAnswer> | undefined;
  if (a?.type === 'noul' && isNum(a.noul)) return clamp(a.noul, 0, 1);
  if (required) throw new ClassifierError(`Missing or malformed noul answer "${id}"`, 'bad_response');
  return null;
}

function scoreAns(answers: Record<string, unknown>, id: string, levels: number): { value: number; confidence: number | null; probabilities: Record<string, number> } {
  const a = answers[id] as Partial<ScoreAnswer> | undefined;
  if (a?.type !== 'score' || !isNum(a.score)) {
    throw new ClassifierError(`Missing or malformed score answer "${id}"`, 'bad_response');
  }
  const max = levels - 1;
  return {
    value: clamp(a.score / max, 0, 1),
    confidence: isNum(a.confidence) ? a.confidence : null,
    probabilities: a.probabilities ?? {},
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Map a System One response to normalized classification fields (scores in [0, 1]). */
export function mapJevResponse(
  req: JevRequest,
  res: JevResponse,
  profile: InterestProfile,
): Omit<ClassificationResult, 'classifier' | 'classifierVersion' | 'inputHash' | 'rawRequest' | 'rawResponse' | 'durationMs'> {
  if (!res || typeof res !== 'object' || !res.answers || typeof res.answers !== 'object') {
    throw new ClassifierError('Response has no answers', 'bad_response');
  }
  const answers = res.answers;
  const def = profile.definition;
  const threshold = def.ranking.categoryThreshold;
  const topics = def.topics.filter((t) => t.enabled);

  const categories: CategoryAssessment[] = topics.map((t) => {
    const p = noul(answers, `${TOPIC_PREFIX}${t.id}`, true)!;
    return { id: t.id, label: t.label, probability: p, assigned: p >= threshold };
  });
  const relevance = scoreAns(answers, 'personal_relevance', RELEVANCE_LEVELS.length);
  const significance = scoreAns(answers, 'significance', SIGNIFICANCE_LEVELS.length);
  const urgency = scoreAns(answers, 'urgency', URGENCY_LEVELS.length);
  const investigate = noul(answers, 'investigate', true)!;
  const promotional = noul(answers, 'promotional', false);
  const exclusion = 'exclusion' in req.questions ? noul(answers, 'exclusion', false) : null;
  const typeAns = answers.article_type as Partial<ChoiceAnswer> | undefined;
  const articleType = typeAns?.type === 'choice' && typeof typeAns.choice === 'string' ? typeAns.choice : null;

  return {
    model: typeof res.model === 'string' ? res.model : req.model,
    categories,
    personalRelevance: relevance.value,
    significance: significance.value,
    urgency: urgency.value,
    investigate,
    promotional,
    exclusion,
    articleType,
    signals: {
      confidence: {
        personalRelevance: relevance.confidence,
        significance: significance.confidence,
        urgency: urgency.confidence,
        articleType: isNum(typeAns?.confidence) ? typeAns.confidence : null,
      },
      levelProbabilities: {
        personalRelevance: relevance.probabilities,
        significance: significance.probabilities,
        urgency: urgency.probabilities,
      },
      articleTypeProbabilities: typeAns?.probabilities ?? null,
    },
    usage: {
      inputTokens: isNum(res.usage?.input_tokens) ? res.usage.input_tokens : null,
      outputTokens: isNum(res.usage?.output_tokens) ? res.usage.output_tokens : null,
    },
  };
}

// ---- Client ------------------------------------------------------------------

export interface JevClassifierOptions {
  apiKey?: string;
  baseURL?: string;
  model: string;
  timeoutMs: number;
  maxContentChars: number;
  /** Custom fetch (tests). */
  fetch?: Fetch;
}

/** Classifier backed by TypeSafe's Jev System One model via the official SDK. */
export class JevClassifier implements Classifier {
  readonly name = 'jev';
  readonly version = JEV_CLASSIFIER_VERSION;
  private readonly client: TypeSafeClient | null;

  constructor(private readonly opts: JevClassifierOptions) {
    this.client = opts.apiKey
      ? new TypeSafeClient({
          apiKey: opts.apiKey,
          baseURL: opts.baseURL,
          defaultModel: opts.model,
          timeout: opts.timeoutMs,
          // Retries are owned by the job queue (persistent, with backoff); keep SDK retries short.
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
    return this.client ? null : 'Set TYPESAFE_API_KEY to enable Jev classification.';
  }

  private request(article: ClassificationArticle, profile: InterestProfile): JevRequest {
    return buildJevRequest(article, profile, { model: this.opts.model, maxContentChars: this.opts.maxContentChars });
  }

  inputHash(article: ClassificationArticle, profile: InterestProfile): string {
    return sha256(stableStringify({ v: this.version, req: this.request(article, profile) }));
  }

  async classify(article: ClassificationArticle, profile: InterestProfile, signal?: AbortSignal): Promise<ClassificationResult> {
    if (!this.client) throw new ClassifierError('Jev is not configured (TYPESAFE_API_KEY missing)', 'auth');
    const req = this.request(article, profile);
    const started = Date.now();
    let res: JevResponse;
    try {
      res = await this.client.systemOne(req, { signal });
    } catch (err) {
      throw toClassifierError(err);
    }
    const mapped = mapJevResponse(req, res, profile);
    return {
      ...mapped,
      classifier: this.name,
      classifierVersion: this.version,
      inputHash: sha256(stableStringify({ v: this.version, req })),
      rawRequest: req,
      rawResponse: res,
      durationMs: Date.now() - started,
    };
  }
}

export function toClassifierError(err: unknown): ClassifierError {
  if (err instanceof ClassifierError) return err;
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return new ClassifierError(`Jev rejected the credentials (HTTP ${err.status})`, 'auth', err.status);
  }
  if (err instanceof APIError) {
    const s = err.status;
    const retryAfterMs = err instanceof RateLimitError ? (err.retryAfterMs ?? null) : null;
    if (s === 400 || s === 413 || s === 415 || s === 422) {
      return new ClassifierError(`Jev rejected the request (HTTP ${s}): ${describeBody(err.body)}`, 'invalid_input', s);
    }
    return new ClassifierError(`Jev unavailable (HTTP ${s})`, 'unavailable', s, retryAfterMs);
  }
  if (err instanceof APIConnectionError) {
    return new ClassifierError(`Jev unreachable: ${err.message}`, 'unavailable');
  }
  return new ClassifierError(`Jev call failed: ${err instanceof Error ? err.message : String(err)}`, 'unavailable');
}

function describeBody(body: unknown): string {
  try {
    return truncate(typeof body === 'string' ? body : JSON.stringify(body), 500);
  } catch {
    return 'unreadable error body';
  }
}
