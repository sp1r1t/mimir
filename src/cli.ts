import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { repairExtractedArticles } from './extraction/repair.js';
import { JobQueue } from './jobs/queue.js';
import { CLASSIFY } from './pipeline.js';
import { ProfileRepository } from './profile/repository.js';
import { formatReport, runReplay } from './stories/replay.js';
import { systemClock } from './util/time.js';
import { mapCountries } from './world/countries.js';
import { WorldFetcher } from './world/fetch.js';
import { WorldRepository } from './world/repository.js';
import { Wikidata } from './world/wikidata.js';

const USAGE = `Usage: node dist/cli.js <command>

Commands:
  migrate              Apply pending database migrations
  backup [file]        Write a consistent online backup of the database
                       (default: <data dir>/backups/mimir-<timestamp>.db)
  repair-content       Clean stored article HTML without downloading pages,
                       and queue classification where that text changed
  status               Print article, source, and job counts
  world fetch          Read the world's governments from Wikidata and write them
                       into the snapshot
  replay [--json]      Replay the recorded matching decisions and report how well the
                       similarity score tells same-story pairs from different ones
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [cmd, arg] = args;
  const config = loadConfig();
  switch (cmd) {
    case 'migrate': {
      openDatabase(config.dbPath).close();
      console.log(`Database at ${config.dbPath} is up to date.`);
      break;
    }
    case 'backup': {
      const db = openDatabase(config.dbPath);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = resolve(arg ?? resolve(config.dataDir, 'backups', `mimir-${stamp}.db`));
      mkdirSync(dirname(target), { recursive: true });
      await db.backup(target);
      db.close();
      console.log(`Backup written to ${target}`);
      break;
    }
    case 'repair-content': {
      const db = openDatabase(config.dbPath);
      const repaired = repairExtractedArticles(db);
      let queued = 0;
      let skipped = 0;
      try {
        const profile = new ProfileRepository(db).active();
        const queue = new JobQueue(db);
        for (const articleId of repaired.reclassifyIds) {
          const created = queue.enqueue(
            CLASSIFY,
            `article:${articleId}:v${profile.version}`,
            { articleId, profileVersion: profile.version },
            { priority: 20, maxAttempts: config.classification.maxAttempts },
          );
          if (created) queued++;
          else skipped++;
        }
      } catch (err) {
        db.close();
        throw err;
      }
      db.close();
      console.log(
        `Examined ${repaired.examined} extracted articles. Updated ${repaired.updated}, restored feed text for ${repaired.restoredFeed}, left ${repaired.unchanged} unchanged.`,
      );
      console.log(`Queued ${queued} classifications${skipped ? ` (${skipped} already queued)` : ''}.`);
      break;
    }
    case 'status': {
      const db = openDatabase(config.dbPath);
      const q = (sql: string) => db.prepare(sql).all();
      console.log('Articles:', q('SELECT COUNT(*) AS n FROM articles'));
      console.log('Classification:', q('SELECT classification_status AS status, COUNT(*) AS n FROM article_state GROUP BY 1'));
      console.log('Sources:', q('SELECT enabled, COUNT(*) AS n, SUM(consecutive_failures > 0) AS failing FROM sources GROUP BY 1'));
      console.log('Jobs:', q('SELECT kind, status, COUNT(*) AS n FROM jobs GROUP BY 1, 2'));
      db.close();
      break;
    }
    case 'replay': {
      const db = openDatabase(config.dbPath);
      try {
        const report = runReplay(db, { threshold: config.stories.minSimilarity });
        console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report));
      } finally {
        db.close();
      }
      break;
    }
    case 'world': {
      if (arg !== 'fetch') {
        process.stdout.write(USAGE);
        process.exit(1);
      }
      const db = openDatabase(config.dbPath);
      try {
        const world = new WorldRepository(db, systemClock);
        const wikidata = new Wikidata(config.world.wikidata);
        const started = new Date();
        process.stdout.write('Reading the world from Wikidata…\n');
        const result = await new WorldFetcher({
          wikidata,
          countries: mapCountries(),
          now: started,
        }).run();
        const written = world.saveSnapshots(result.snapshots);
        world.recordFetch({
          startedAt: started.toISOString(),
          finishedAt: new Date().toISOString(),
          countries: written,
          unmapped: result.unmapped,
        });
        const known = result.snapshots.filter((s) => s.position !== 'unknown').length;
        console.log(`Wrote ${written} countries to the world snapshot; ${known} of them sit on the axis.`);
        if (result.unmapped.length) {
          console.log(`Not sovereign states in Wikidata: ${result.unmapped.join(', ')}`);
        }
      } finally {
        db.close();
      }
      break;
    }
    default:
      process.stdout.write(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
