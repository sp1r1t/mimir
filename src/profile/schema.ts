import { z } from 'zod';

export const PRIORITIES = ['core', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, "-" and "_" only');

export const TopicSchema = z.object({
  /** Stable identifier; used as the category id in classifications. Keep it when renaming the label. */
  id: slug,
  label: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  priority: z.enum(PRIORITIES).default('normal'),
  enabled: z.boolean().default(true),
});

export const ExclusionSchema = z.object({
  id: slug,
  description: z.string().min(1).max(1000),
});

/**
 * Interests inferred from behaviour. Reserved for future behavioural learning:
 * kept separate from explicit preferences and never edited through the explicit-profile form.
 */
export const InferredSchema = z.object({
  topics: z
    .array(
      z.object({
        label: z.string().min(1),
        description: z.string().default(''),
        weight: z.number().min(0).max(1).default(0.5),
        evidence: z.string().optional(),
      }),
    )
    .default([]),
  notes: z.array(z.string()).default([]),
});

export const RankingSchema = z.object({
  /** Topic probability at or above which a topic counts as an assigned category. */
  categoryThreshold: z.number().min(0).max(1).default(0.5),
  weights: z
    .object({
      relevance: z.number().min(0).max(10).default(0.5),
      significance: z.number().min(0).max(10).default(0.2),
      urgency: z.number().min(0).max(10).default(0.1),
      topicMatch: z.number().min(0).max(10).default(0.2),
    })
    .default({ relevance: 0.5, significance: 0.2, urgency: 0.1, topicMatch: 0.2 }),
  priorityWeights: z
    .object({
      core: z.number().min(0).max(1).default(1),
      high: z.number().min(0).max(1).default(0.8),
      normal: z.number().min(0).max(1).default(0.6),
      low: z.number().min(0).max(1).default(0.35),
    })
    .default({ core: 1, high: 0.8, normal: 0.6, low: 0.35 }),
  /** Multiplicative penalty strength for promotional content (0 = none, 1 = zero score). */
  promotionalPenalty: z.number().min(0).max(1).default(0.3),
  /** Multiplicative penalty strength for content matching an exclusion. */
  exclusionPenalty: z.number().min(0).max(1).default(0.7),
});

/** Story priority: weighted signals plus a recency term; repeated coverage adds little by design. */
export const StoryRankingSchema = z.object({
  weights: z
    .object({
      relevance: z.number().min(0).max(10).default(0.4),
      significance: z.number().min(0).max(10).default(0.3),
      urgency: z.number().min(0).max(10).default(0.1),
      coverage: z.number().min(0).max(10).default(0.05),
      recency: z.number().min(0).max(10).default(0.15),
    })
    .default({ relevance: 0.4, significance: 0.3, urgency: 0.1, coverage: 0.05, recency: 0.15 }),
  /** Hours after the latest development at which the recency term has halved. */
  recencyHalfLifeHours: z.number().min(1).max(24 * 365).default(24),
});

export const ProfileDefinitionSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  /** Free-text description of the reader, given to the classifier as context. */
  summary: z.string().max(4000).default(''),
  topics: z
    .array(TopicSchema)
    .min(1)
    .refine((ts) => new Set(ts.map((t) => t.id)).size === ts.length, 'topic ids must be unique'),
  exclusions: z
    .array(ExclusionSchema)
    .default([])
    .refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length, 'exclusion ids must be unique'),
  editorialPreferences: z.array(z.string().min(1).max(1000)).default([]),
  inferred: InferredSchema.default({ topics: [], notes: [] }),
  ranking: RankingSchema.default(RankingSchema.parse({})),
  storyRanking: StoryRankingSchema.default(StoryRankingSchema.parse({})),
});

export type Topic = z.infer<typeof TopicSchema>;
export type ProfileDefinition = z.infer<typeof ProfileDefinitionSchema>;
export type RankingConfig = z.infer<typeof RankingSchema>;
export type StoryRankingConfig = z.infer<typeof StoryRankingSchema>;

export interface InterestProfile {
  id: number;
  version: number;
  definition: ProfileDefinition;
  changeNote: string | null;
  author: 'system' | 'user' | 'agent';
  isActive: boolean;
  createdAt: string;
  activatedAt: string | null;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'topic'
  );
}
