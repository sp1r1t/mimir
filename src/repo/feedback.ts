import type { DB } from '../db/database.js';
import { iso, systemClock, type Clock } from '../util/time.js';

export const FEEDBACK_TYPES = [
  'relevant',
  'not_relevant',
  'clear_relevance',
  'more_like_this',
  'less_like_this',
  'clear_preference',
  'save',
  'unsave',
] as const;
export const INTERACTION_TYPES = ['view', 'open_original'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
export type EventType = FeedbackType | (typeof INTERACTION_TYPES)[number];

export function isEventType(v: unknown): v is EventType {
  return typeof v === 'string' && ([...FEEDBACK_TYPES, ...INTERACTION_TYPES] as string[]).includes(v);
}

/**
 * Records feedback and interaction events (append-only) and keeps the derived
 * per-article state in sync. Events capture the classification and profile
 * version the user saw, so future learning can relate feedback to model output.
 */
export class FeedbackRepository {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock = systemClock,
  ) {}

  record(articleId: number, type: EventType, context: Record<string, unknown> = {}, actor = 'user'): number {
    return this.db.transaction(() => {
      const now = iso(this.clock());
      const state = this.db
        .prepare(
          `SELECT s.current_classification_id AS cid, s.rank_score AS rank, c.profile_version AS pv
           FROM article_state s LEFT JOIN classifications c ON c.id = s.current_classification_id WHERE s.article_id = ?`,
        )
        .get(articleId) as { cid: number | null; rank: number | null; pv: number | null } | undefined;
      if (!state) throw new Error(`Article ${articleId} not found`);
      const res = this.db
        .prepare(
          `INSERT INTO feedback_events (article_id, event_type, classification_id, profile_version, rank_score, context, actor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(articleId, type, state.cid, state.pv, state.rank, JSON.stringify(context), actor, now);

      const update: Record<EventType, string> = {
        relevant: "relevance_label = 'relevant', last_feedback_at = @now",
        not_relevant: "relevance_label = 'not_relevant', last_feedback_at = @now",
        clear_relevance: 'relevance_label = NULL, last_feedback_at = @now',
        more_like_this: "preference = 'more', last_feedback_at = @now",
        less_like_this: "preference = 'less', last_feedback_at = @now",
        clear_preference: 'preference = NULL, last_feedback_at = @now',
        save: 'saved_at = COALESCE(saved_at, @now), last_feedback_at = @now',
        unsave: 'saved_at = NULL, last_feedback_at = @now',
        view: 'first_viewed_at = COALESCE(first_viewed_at, @now)',
        open_original: 'first_viewed_at = COALESCE(first_viewed_at, @now)',
      };
      this.db.prepare(`UPDATE article_state SET ${update[type]} WHERE article_id = @id`).run({ now, id: articleId });
      return Number(res.lastInsertRowid);
    })();
  }

  counts(sinceIso?: string): { eventType: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT event_type AS eventType, COUNT(*) AS count FROM feedback_events
         ${sinceIso ? 'WHERE created_at >= ?' : ''} GROUP BY event_type ORDER BY count DESC`,
      )
      .all(...(sinceIso ? [sinceIso] : [])) as { eventType: string; count: number }[];
  }
}
