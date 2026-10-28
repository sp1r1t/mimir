import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db/database.js';
import { CONFIG_DIR } from '../paths.js';
import { iso, systemClock, type Clock } from '../util/time.js';
import { ProfileDefinitionSchema, type InterestProfile, type ProfileDefinition } from './schema.js';

interface ProfileRow {
  id: number;
  version: number;
  definition: string;
  change_note: string | null;
  author: InterestProfile['author'];
  is_active: number;
  created_at: string;
  activated_at: string | null;
}

function toProfile(r: ProfileRow): InterestProfile {
  return {
    id: r.id,
    version: r.version,
    definition: ProfileDefinitionSchema.parse(JSON.parse(r.definition)),
    changeNote: r.change_note,
    author: r.author,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
    activatedAt: r.activated_at,
  };
}

export function loadDefaultProfile(): ProfileDefinition {
  const raw = JSON.parse(readFileSync(join(CONFIG_DIR, 'default-profile.json'), 'utf8'));
  return ProfileDefinitionSchema.parse(raw);
}

/**
 * Interest profiles are immutable versions. Every change creates a new version,
 * which becomes active; older versions stay available for comparison and reactivation.
 */
export class ProfileRepository {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock = systemClock,
  ) {}

  active(): InterestProfile {
    const row = this.db.prepare('SELECT * FROM interest_profiles WHERE is_active = 1').get() as ProfileRow | undefined;
    if (!row) throw new Error('No active interest profile');
    return toProfile(row);
  }

  byVersion(version: number): InterestProfile | null {
    const row = this.db.prepare('SELECT * FROM interest_profiles WHERE version = ?').get(version) as ProfileRow | undefined;
    return row ? toProfile(row) : null;
  }

  list(): InterestProfile[] {
    return (this.db.prepare('SELECT * FROM interest_profiles ORDER BY version DESC').all() as ProfileRow[]).map(toProfile);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM interest_profiles').get() as { n: number }).n;
  }

  /** Validate and store a new version, making it active. No-op if identical to the active definition. */
  createVersion(
    input: unknown,
    meta: { changeNote?: string; author?: InterestProfile['author'] } = {},
  ): { profile: InterestProfile; changed: boolean } {
    const definition = ProfileDefinitionSchema.parse(input);
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT * FROM interest_profiles WHERE is_active = 1').get() as ProfileRow | undefined;
      if (current && JSON.stringify(toProfile(current).definition) === JSON.stringify(definition)) {
        return { profile: toProfile(current), changed: false };
      }
      const next =
        ((this.db.prepare('SELECT MAX(version) AS v FROM interest_profiles').get() as { v: number | null }).v ?? 0) + 1;
      const now = iso(this.clock());
      this.db.prepare('UPDATE interest_profiles SET is_active = 0 WHERE is_active = 1').run();
      const res = this.db
        .prepare(
          `INSERT INTO interest_profiles (version, definition, change_note, author, is_active, created_at, activated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(next, JSON.stringify(definition), meta.changeNote ?? null, meta.author ?? 'user', now, now);
      const row = this.db.prepare('SELECT * FROM interest_profiles WHERE id = ?').get(res.lastInsertRowid) as ProfileRow;
      return { profile: toProfile(row), changed: true };
    })();
  }

  /** Make an existing version active again without creating a new one. */
  activate(version: number): InterestProfile {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM interest_profiles WHERE version = ?').get(version) as ProfileRow | undefined;
      if (!row) throw new Error(`Profile version ${version} not found`);
      this.db.prepare('UPDATE interest_profiles SET is_active = 0 WHERE is_active = 1').run();
      this.db
        .prepare('UPDATE interest_profiles SET is_active = 1, activated_at = ? WHERE id = ?')
        .run(iso(this.clock()), row.id);
      return toProfile({ ...row, is_active: 1 });
    })();
  }
}
