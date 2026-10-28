import type { InterestProfile } from '../profile/schema.js';

/** Article fields a classifier may use. Generated interpretations are never part of the input. */
export interface ClassificationArticle {
  id: number;
  title: string | null;
  sourceName: string | null;
  author: string | null;
  url: string | null;
  publishedAt: string | null;
  language: string | null;
  feedCategories: string[];
  summary: string | null;
  text: string | null;
  contentSource: string;
  /** full is a validated body; partial is a summary or incomplete extraction. */
  contentQuality: 'unknown' | 'full' | 'partial';
}

export interface CategoryAssessment {
  id: string;
  label: string;
  probability: number;
  assigned: boolean;
}

/** A classifier's normalized assessment. All scores are in [0, 1]. */
export interface ClassificationResult {
  classifier: string;
  classifierVersion: string;
  /** Model identifier as reported by the service (e.g. a versioned id behind an alias). */
  model: string;
  inputHash: string;
  categories: CategoryAssessment[];
  personalRelevance: number;
  significance: number;
  urgency: number;
  investigate: number;
  promotional: number | null;
  exclusion: number | null;
  articleType: string | null;
  /** Additional normalized details (per-question confidence, level distributions). */
  signals: Record<string, unknown>;
  rawRequest: unknown;
  rawResponse: unknown;
  usage: { inputTokens: number | null; outputTokens: number | null };
  durationMs: number;
}

export type ClassifierErrorKind =
  /** Service down, overloaded, rate limited, or timed out: retry later. */
  | 'unavailable'
  /** Credentials missing or rejected: pause until configuration changes. */
  | 'auth'
  /** The request for this article is invalid: retrying will not help. */
  | 'invalid_input'
  /** The response did not match the expected shape. */
  | 'bad_response';

export class ClassifierError extends Error {
  constructor(
    message: string,
    readonly kind: ClassifierErrorKind,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ClassifierError';
  }
}

/** Replaceable classification engine. */
export interface Classifier {
  readonly name: string;
  readonly version: string;
  /** Whether the classifier has what it needs (e.g. credentials) to run. */
  isConfigured(): boolean;
  /** Human-readable reason when not configured. */
  configurationHint(): string | null;
  /** Hash identifying the exact input this classifier would send; used for idempotency. */
  inputHash(article: ClassificationArticle, profile: InterestProfile): string;
  classify(article: ClassificationArticle, profile: InterestProfile, signal?: AbortSignal): Promise<ClassificationResult>;
}
