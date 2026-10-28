import { clamp01 } from '../classification/ranking.js';
import type { InterestProfile } from '../profile/schema.js';
import { sha256, stableStringify } from '../util/hash.js';

export const STORY_PRIORITY_FORMULA = 'story-priority/1';

/** Articles from this many hours before the latest development count towards current urgency. */
const URGENCY_WINDOW_HOURS = 24;
/** Promotional probability at or above which an article does not count as independent coverage. */
const PROMOTIONAL_CUTOFF = 0.5;
/** Independent publishers at which the coverage signal reaches 0.5. */
const COVERAGE_HALF_PUBLISHERS = 3;

export interface AssessmentMember {
  articleId: number;
  publisher: string;
  occurredAt: string;
  classification: {
    id: number;
    personalRelevance: number;
    significance: number;
    urgency: number;
    promotional: number | null;
    exclusion: number | null;
    categories: { id: string; label: string; probability: number; assigned: boolean }[];
  } | null;
}

export interface SignalEvidence {
  value: number;
  articleId: number;
  classificationId: number;
}

export interface StoryAssessment {
  formula: string;
  profileVersion: number;
  inputHash: string;
  personalRelevance: number | null;
  significance: number | null;
  urgency: number | null;
  coverage: number;
  /** Priority without the recency term; null until at least one article is classified. */
  priorityStatic: number | null;
  recencyWeight: number;
  recencyHalfLifeHours: number;
  categories: { id: string; label: string; probability: number }[];
  evidence: {
    personalRelevance: SignalEvidence | null;
    significance: SignalEvidence | null;
    urgency: SignalEvidence | null;
    independentPublishers: string[];
    promotionalArticles: number[];
    classifiedArticles: number;
    unclassifiedArticles: number;
  };
}

/** Recency term in [0, 1]: 1 at the latest development, 0.5 after one half-life, decaying hyperbolically. */
export function recency(latestDevelopmentAt: string | null, now: number, halfLifeHours: number): number {
  if (!latestDevelopmentAt) return 0;
  const ageHours = Math.max(0, (now - Date.parse(latestDevelopmentAt)) / 3_600_000);
  return 1 / (1 + ageHours / halfLifeHours);
}

export function priorityAt(
  s: { priorityStatic: number | null; recencyWeight: number | null; recencyHalfLifeHours: number | null; latestDevelopmentAt: string | null },
  now: number,
): number | null {
  if (s.priorityStatic == null || s.recencyWeight == null || s.recencyHalfLifeHours == null) return null;
  return clamp01(s.priorityStatic + s.recencyWeight * recency(s.latestDevelopmentAt, now, s.recencyHalfLifeHours));
}

/**
 * Story-level assessment from member article classifications.
 * Relevance and significance come from the strongest substantive report (promotion and
 * exclusions discount an article, as in article ranking); urgency from reports around the
 * latest development. Coverage counts distinct independent publishers with diminishing
 * returns, so repeated or syndicated copies and press releases do not raise priority.
 */
export function assessStory(members: AssessmentMember[], latestDevelopmentAt: string | null, profile: InterestProfile): StoryAssessment {
  const ranking = profile.definition.ranking;
  const sr = profile.definition.storyRanking;
  const discount = (c: NonNullable<AssessmentMember['classification']>) =>
    (1 - ranking.promotionalPenalty * (c.promotional ?? 0)) * (1 - ranking.exclusionPenalty * (c.exclusion ?? 0));

  const best = (pick: (c: NonNullable<AssessmentMember['classification']>) => number, among: AssessmentMember[]): SignalEvidence | null => {
    let out: SignalEvidence | null = null;
    for (const m of among) {
      if (!m.classification) continue;
      const value = clamp01(pick(m.classification) * discount(m.classification));
      if (!out || value > out.value) out = { value, articleId: m.articleId, classificationId: m.classification.id };
    }
    return out;
  };

  const relevance = best((c) => c.personalRelevance, members);
  const significance = best((c) => c.significance, members);
  const cutoff = latestDevelopmentAt ? Date.parse(latestDevelopmentAt) - URGENCY_WINDOW_HOURS * 3_600_000 : -Infinity;
  const recent = members.filter((m) => Date.parse(m.occurredAt) >= cutoff);
  const urgency = best((c) => c.urgency, recent.some((m) => m.classification) ? recent : members);

  const promotionalArticles = members
    .filter((m) => (m.classification?.promotional ?? 0) >= PROMOTIONAL_CUTOFF)
    .map((m) => m.articleId);
  const independentPublishers = [
    ...new Set(members.filter((m) => !promotionalArticles.includes(m.articleId)).map((m) => m.publisher)),
  ].sort();
  const extra = Math.max(0, independentPublishers.length - 1);
  const coverage = extra / (extra + COVERAGE_HALF_PUBLISHERS - 1);

  const categoryMax = new Map<string, { id: string; label: string; probability: number }>();
  for (const m of members) {
    for (const c of m.classification?.categories ?? []) {
      const prev = categoryMax.get(c.id);
      if (!prev || c.probability > prev.probability) categoryMax.set(c.id, { id: c.id, label: c.label, probability: c.probability });
    }
  }
  const categories = [...categoryMax.values()]
    .filter((c) => c.probability >= ranking.categoryThreshold)
    .sort((a, b) => b.probability - a.probability);

  const w = sr.weights;
  const total = w.relevance + w.significance + w.urgency + w.coverage + w.recency;
  const norm = total > 0 ? total : 1;
  const priorityStatic =
    relevance && significance && urgency
      ? (w.relevance * relevance.value + w.significance * significance.value + w.urgency * urgency.value + w.coverage * coverage) / norm
      : null;

  const classified = members.filter((m) => m.classification).length;
  const result = {
    formula: STORY_PRIORITY_FORMULA,
    profileVersion: profile.version,
    personalRelevance: relevance?.value ?? null,
    significance: significance?.value ?? null,
    urgency: urgency?.value ?? null,
    coverage,
    priorityStatic,
    recencyWeight: w.recency / norm,
    recencyHalfLifeHours: sr.recencyHalfLifeHours,
    categories,
    evidence: {
      personalRelevance: relevance,
      significance,
      urgency,
      independentPublishers,
      promotionalArticles,
      classifiedArticles: classified,
      unclassifiedArticles: members.length - classified,
    },
  };
  return { ...result, inputHash: sha256(stableStringify(result)) };
}
