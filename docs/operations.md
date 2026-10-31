# Operation, backup and troubleshooting

[← Back to the README](../README.md)

## Operation and recovery

```sh
docker compose logs -f --tail=100 mimir
docker compose exec -T mimir node dist/cli.js status
curl -fsS http://localhost:8470/healthz
curl -fsS http://localhost:8470/readyz
docker compose restart mimir
docker compose down
```

`/healthz` checks the database and drives Docker health checks. `/readyz` and
`/api/health` report collection and classification state. A missing classifier key
does not make ingestion unhealthy. `/metrics` exposes Prometheus text metrics;
`/api/stats` exposes dashboard data as JSON. If basic auth is enabled, supply it for
API and metrics requests.

Feed validators (ETag and Last-Modified), next fetch time and failure backoff persist
across restarts. Requests have timeouts, response size limits and bounded retries.
Malformed or unavailable feeds fail individually. Extraction and classification run
independently through a persistent queue with active-job uniqueness constraints,
retry budgets and exponential backoff. Jev errors open a circuit breaker; rejected
credentials pause work without exhausting attempts. Startup requeues interrupted
jobs, and a periodic reconciler repairs missing work.

Story matching, assessment and summaries use the same queue. A change that arrives while a
story's assessment is running queues it once more. Summary jobs wait without consuming
attempts while the plan allowance is low, while MiniMax rate-limits, or while the key is
rejected; invalid output and outages are retried with backoff. Stats shows the remaining
plan allowance, summary calls by outcome and token usage, and matching decisions;
`/metrics` exposes the same as `mimir_stories`, `mimir_story_summaries`, `mimir_summary_*`
and per-worker counters.

Extraction respects robots.txt and noarchive directives, sends no login cookies and
does not bypass paywalls. It retains feed text when extraction is unavailable,
prohibited or insufficient. Per-host spacing and temporary access-denied suppression
limit repeated downloads. Unchanged entries are not re-extracted or reclassified.

Page extraction runs Mozilla Readability after the document root's class and id are
removed, so a site-wide class cannot delete the whole tree, and after hidden nodes
and compact consent or newsletter widgets are removed. Stored HTML and plain text
are taken from that cleaned result. A page replaces feed text only when it has
article paragraphs and is not mostly links or interface copy. Suspect pages keep
the feed text. Partial text is labeled on the article and sent to Jev as partial.

Stored extractions can be cleaned without downloading the pages again:

```sh
docker compose exec -T mimir node dist/cli.js repair-content
```

The command rewrites saved article HTML that still contains hidden or widget markup,
regenerates plain text, and queues classification only where that text changed.
Earlier classifications remain in history. Take a backup first.

Changed feed entries update source fields and preserve first/latest raw metadata;
they do not automatically reclassify previously assessed articles. Use article or
profile reclassification when you want a fresh assessment.

Run exactly one application instance per database on local disk. SQLite WAL and
job recovery are designed for this deployment, not multiple replicas or network
filesystems. Articles, classification history, profiles and feedback are retained
indefinitely; monitor disk usage. Only fetch logs and completed jobs are pruned.

## Measuring the story matcher

Every matching decision is written down: the article, the stories it was compared
with, the similarity each one got, what the matcher said about each, and the
corrections the reader made by hand. The replay command reads that history back
and measures how well the similarity score is doing:

```sh
docker compose exec -T mimir node dist/cli.js replay
docker compose exec -T mimir node dist/cli.js replay --json
```

The report says how far the score separates the pairs the matcher called the same
story from the pairs it called a different one, how often the score ranked the
candidates the way the matcher did, what a lower threshold would add, how much a
story's size or the amount of text in an article moves its score, which candidates
the threshold kept back, and what the reader's own merges score. It reads only
what was recorded and calls no model, so it costs nothing.

Use it before changing the score: a new rule is only an improvement if the replay
says so. The score itself lives in `src/stories/similarity.ts` and is deliberately
separable from the retrieval that feeds it, so two rules can be measured against
the same decisions.

## Backup, restore and upgrades

Create a consistent online SQLite backup while collection continues:

```sh
docker compose exec -T mimir node dist/cli.js backup
```

The CLI prints the resulting `/data/backups/mimir-<timestamp>.db` path, available on
the host under `data/backups/`. Copy backups off the host and back up `.env` securely
separately. Do not copy only a live `mimir.db`: recent transactions may be in its WAL.

To restore, stop the application, preserve the current database and its sidecars,
then copy a selected backup into place:

```sh
docker compose down
mkdir -p data/before-restore
mv data/mimir.db data/before-restore/
# Move mimir.db-wal and mimir.db-shm there too if present.
cp data/backups/CHOSEN-BACKUP.db data/mimir.db
# Ensure data/mimir.db is writable by UID 1000, as described above.
docker compose up -d
```

The backup includes subscriptions, profiles, feedback, all article content and job
state. Startup recovers pending/interrupted work. Test restores periodically.

Before upgrading, take a backup, update the application files and run
`docker compose up -d --build`. Numbered SQL migrations apply transactionally on
startup and are tracked in `schema_migrations`. Restore a pre-upgrade backup along
with the matching application version if a migration must be rolled back.

## Troubleshooting

| Symptom | Check / action |
| --- | --- |
| Cannot open port 8470 | Check `docker compose ps`, logs and host port conflicts; change `MIMIR_PUBLISH` |
| SQLite cannot open database | Check bind mount ownership and free disk space |
| Pending configuration | Set `TYPESAFE_API_KEY` in `.env`, then `docker compose up -d` |
| Jev paused / authentication error | Correct credentials, recreate container; inspect Stats for error and pause state |
| Failed classification | Inspect Stats; retry failed jobs after correcting request/configuration problems |
| Missing full text | Inspect article extraction status; robots restrictions, paywalls and short pages keep feed content |
| Feed failing | Inspect source fetch history; update URL or disable it; other sources keep polling |
| Nature returns HTML | Publisher can serve an access/challenge page instead of RSS; retry later, edit or disable this subscription |
| Old scores after editing interests | Queue reclassification from the profile page |
| Articles not yet grouped into stories | Matching needs `TYPESAFE_API_KEY`; inspect the `story_match` worker on Stats |
| Summaries paused | Stats shows the reason: missing or non-subscription key, low plan allowance (resumes at reset) or rate limit |
| Two stories about one event | Merge one into the other from its story page; split misgrouped articles out the same way |
| Slow initial backlog | Check extraction and classification worker state; initial feeds include older entries |
| DNS errors such as `EAI_AGAIN` | Check the host DNS resolver. This installation uses an ignored `docker-compose.override.yml` with container DNS resolvers `1.1.1.1` and `9.9.9.9` because the LAN resolver refused queries; remove or adjust that local override when needed |
