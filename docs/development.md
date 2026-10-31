# Development

[← Back to the README](../README.md)

## Development and tests

Use Node 24 LTS and npm. If `better-sqlite3` has no prebuilt binary for your Node
version, install Python 3, make and a C++ compiler (the Docker build does this).

```sh
npm ci
npm run typecheck
npm test
npm run build
node --env-file=.env dist/index.js
```

For watch mode: `node --env-file=.env --import tsx --watch src/index.ts`.
Native runs default to port 8080; `MIMIR_PUBLISH` only affects Compose.

Tests use isolated temporary SQLite databases, local HTTP fixtures and mocked Jev
responses. They cover RSS/Atom/RDF/JSON normalization, URL and GUID deduplication,
cross-source provenance, FTS and persistence after reopening, conditional requests,
concurrency, timeouts, retry/backoff, outage recovery, idempotent jobs and
classifications, profile versioning, extraction restrictions, feedback and HTTP
routes. Story tests cover clustering, duplicate headlines, updates versus coverage,
outdated summaries, automatic-summary eligibility and limits, provider failures and
retries, malformed and mis-cited output, merge and split, and restarts. MiniMax tests run
against a fake server, including subscription verification and error codes. They do not
need credentials or access public feeds.

## Code and extension points

`DESIGN.md` records the design decisions of the interface — what each colour means,
where a control lives, why the brief is rewritten from its own card — so that later
features follow the same rules and other projects can borrow them.

```text
src/feeds/            parser, conditional fetcher, ingestor, persistent scheduling
src/extraction/       permitted article text extraction and host pacing
src/classification/   replaceable Classifier interface, Jev adapter, ranking
src/jobs/             SQLite queue and bounded workers
src/profile/          validated profile schema and version repository
src/stories/          candidate retrieval, similarity score, Jev story matcher, assessment, replay, story jobs
src/summaries/        SummaryProvider interface, MiniMax and mock providers, prompt and validation
src/terms/            term prompt and validation, Wikipedia client, glossary markup, word count
src/repo/             article/source/feedback/statistics persistence
src/web/              Fastify routes, server-rendered pages, metrics
src/pipeline.ts       extraction/classification/recovery coordination
migrations/           numbered transactional SQLite migrations and FTS5 triggers
config/               initial feed subscriptions and explicit interest defaults
public/               responsive CSS and progressive-enhancement JavaScript
test/                 isolated integration and unit tests
```

`articles` and `article_entries` preserve original source information, multiple feed
sightings and first/latest raw entries. `classifications` is append-only generated
data; `article_state` points to the current assessment and materializes feedback.
`feedback_events` preserves interaction history and the profile/classification shown.
Publication, source update, discovery, ingestion and classification times remain
distinct. Canonical URL normalization deduplicates matching links. Stories, their
matches, developments, assessments and summary revisions are derived tables; articles and
classifications remain the source of truth.

A summary backend implements `SummaryProvider` in `src/summaries/provider.ts`: one prompt
in, text out, with an optional allowance check. Parsing and validation stay outside the
provider, so an HTTP API and a local CLI process (prompt on stdin, text on stdout) are held
to the same schema. A story matcher implements `StoryMatcher` in `src/stories/matcher.ts`.
Both can be injected through `createApp`.

An alternative classifier implements `src/classification/types.ts` and can be
injected through `createApp`. The profile JSON API supports future programmatic
edits while preserving authorship and explicit/inferred fields. Evidence snapshots,
raw classification inputs and event history support future provenance, clustering,
topic tracking, credibility assessment, behavioral learning and digests without
implementing those features in Phase 1.

The JSON API includes `GET /api/articles`, `GET /api/articles/:id`,
`POST /api/articles/:id/feedback`, `GET/POST /api/sources`, `GET/PUT /api/profile`,
`GET /api/profile/versions`, `POST /api/reclassify`, `GET /api/stats`, `GET /api/stories`,
`GET /api/stories/:id`, `GET /api/stories/:id/events` (the live event stream),
`GET /api/stories/:id/state`, `POST /api/stories/:id/summary` and
`POST /api/stories/:id/seen`
and, for the glossary, `GET /api/terms/:key`, `GET /api/stories/:id/terms` and
`POST /api/stories/:id/terms`
(body `{ "state": "seen" | "unseen" }`). A story is kept with `POST /api/stories/:id/save`
(body `{ "type": "save" | "unsave" }`). Story query parameters match the Stories URL
(`q`, `sort`, `days`, `state`, `category`, `min`, `sig`, `publishers`, `summary`, `seen`
(`unseen` or `seen`), `saved` (`saved` or `unsaved`), `page`, `size`); the API applies no
default filters.
Profile updates accept `{ "definition": { ... }, "changeNote": "...", "author": "user" }`;
`author` may also be `agent`. Reclassification accepts `days`, `onlyOutdated`,
`articleIds` and `force`. Feed creation uses `name`, `url`, `pollMinutes`, optional
`enabled`, `extractContent` and comma-separated `tags` string fields, matching the
web form. Article query parameters match the inbox URL (`q`, `source`, `category`,
`min`, `max`, `date`, `from`, `to`, `status`, `saved`, `feedback`, `type`, `sort`,
`page`, `size`); relevance bounds are 0–100.
