import type { RankingConfig, Topic } from '../profile/schema.js';

export const RANK_FORMULA = 'rank-v1';

export interface RankInputs {
  personalRelevance: number;
  significance: number;
  urgency: number;
  promotional: number | null;
  exclusion: number | null;
  topics: { topic: Topic; probability: number }[];
}

/**
 * Composite ranking score in [0, 1]:
 *   base  = weighted mean of relevance, significance, urgency, and best priority-weighted topic match
 *   score = base × (1 − promotionalPenalty·P(promotional)) × (1 − exclusionPenalty·P(excluded))
 * Raw assessments are stored separately, so the formula can change without reclassifying.
 */
export function rankScore(inputs: RankInputs, cfg: RankingConfig): number {
  const w = cfg.weights;
  const topicMatch = inputs.topics.reduce(
    (best, t) => Math.max(best, t.probability * cfg.priorityWeights[t.topic.priority]),
    0,
  );
  const totalWeight = w.relevance + w.significance + w.urgency + w.topicMatch;
  const base =
    totalWeight > 0
      ? (w.relevance * inputs.personalRelevance +
          w.significance * inputs.significance +
          w.urgency * inputs.urgency +
          w.topicMatch * topicMatch) /
        totalWeight
      : inputs.personalRelevance;
  const promo = 1 - cfg.promotionalPenalty * (inputs.promotional ?? 0);
  const excl = 1 - cfg.exclusionPenalty * (inputs.exclusion ?? 0);
  return clamp01(base * promo * excl);
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
