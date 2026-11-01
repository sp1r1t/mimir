# Configuration

[← Back to the README](../README.md)

## Configure Jev

Set the following in `.env` using your TypeSafe credentials:

```dotenv
TYPESAFE_API_KEY=your-key
JEV_MODEL=jev-latest
```

Then recreate the container so Compose reloads the environment:

```sh
docker compose up -d
```

Pending classifications start automatically as articles finish extraction. The
backlog is processed against the active interest profile. Set a versioned model ID
instead of an alias when you want a fixed model. The returned model ID, adapter
version, exact request and response, input hash, profile version, and timestamps are
stored with every successful classification. Credentials stay on the server and are
excluded from version control and Docker build context.

The adapter uses the official `@typesafe-ai/sdk`, `systemOne`, and documented
`POST /v1/systemone` contract:

- [HTTP API](https://docs.typesafe.ai/api)
- [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [Noul](https://docs.typesafe.ai/primitives/noul), [Score](https://docs.typesafe.ai/primitives/score), and [Choice](https://docs.typesafe.ai/primitives/choice)

One request contains independent topic Noul questions, Score questions for personal
relevance, general significance and urgency, and further-investigation and editorial
signals. Score positions are divided by their highest level number to normalize
them to 0–1; Noul results remain probabilities. Multiple topics may apply.

**Validation boundary:** request serialization, response mapping, retries and outage
handling are tested using fixtures through the actual SDK. Live authenticated Jev
classification was verified with `jev-1.14.0`; ranking quality still needs evaluation
against your feedback. Test a small backlog first when enabling a paid API; every processed
article and forced reclassification can use API credits.

Jev also decides story membership (see [Stories](using-mimir.md#stories-and-story-intelligence-briefs)).
Matching waits, without creating stories, until the key is set.

## Configure MiniMax summaries

Story Intelligence Briefs use MiniMax's OpenAI-compatible
[Chat Completions API](https://platform.minimax.io/docs/api-reference/text-chat-openai)
with an M Plan subscription key:

```dotenv
SUMMARY_PROVIDER=minimax
MINIMAX_API_KEY=your-m-plan-key
MINIMAX_MODEL=MiniMax-M3.1-Flash
```

Recreate the container afterwards (`docker compose up -d`). Before any generation request,
Mimir reads the plan usage endpoint (`GET /v1/token_plan/remains`, see the
[M Plan FAQ](https://platform.minimax.io/docs/m-plan/faq)). That endpoint only accepts
subscription keys, so a pay-as-you-go key is refused and never used for generation;
the Stats page then shows why summaries are paused. There is no fallback to another key
or provider.

MiniMax consumes purchased credit packs once the plan allowance is spent, if any are on the
account. Mimir stops before that point: automatic summaries pause when either plan window
(5 hours or weekly) reaches `MINIMAX_AUTO_RESERVE_PERCENT` remaining, and all summaries
pause at `MINIMAX_MIN_REMAINING_PERCENT`. Paused jobs resume when the window resets. For a
hard guarantee, also turn off automatic credit consumption in the MiniMax console.

The key stays on the server. The model receives only the system instructions and the
story's article excerpts, never credentials, configuration or other data.

**Validation boundary:** request format, error codes and the usage endpoint were taken from
MiniMax's documentation and are tested against a fake server. The usage response schema is
not formally documented; Mimir reads the remaining percentages and reset times and blocks
generation if it cannot recognize a plan allowance. Verify the first summaries after adding
a key.

## Configuration

See [`.env.example`](.env.example) for defaults and comments. Secrets are environment
variables; feeds and profiles are persisted in SQLite. Editing seed JSON files does
not overwrite subscriptions or profiles already in the database.

Key settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MIMIR_PUBLISH` | `127.0.0.1:8470` | Compose host binding |
| `MIMIR_BASIC_AUTH` | unset | Optional `user:password` for UI, API and metrics |
| `MIMIR_SEED_DEFAULTS` | `true` | Seed default subscriptions once |
| `FEED_DEFAULT_POLL_MINUTES` | `30` | Default for new subscriptions |
| `FEED_MIN_POLL_MINUTES` | `5` | Minimum effective polling interval |
| `FEED_CONCURRENCY` | `4` | Simultaneous scheduled and manual feed fetches |
| `EXTRACT_ENABLED` | `true` | Fetch article pages for short feed entries |
| `EXTRACT_MIN_FEED_CHARS` | `1500` | Skip extraction when feed text suffices |
| `EXTRACT_CONCURRENCY` | `2` | Simultaneous extraction jobs |
| `CLASSIFY_CONCURRENCY` | `2` | Simultaneous Jev requests |
| `CLASSIFY_MAX_CONTENT_CHARS` | `6000` | Maximum article text excerpt sent to Jev |
| `CLASSIFY_MAX_ATTEMPTS` | `8` | Classification job retry budget |
| `STORY_MATCH_WINDOW_DAYS` | `4` | Age of stories an article can join |
| `STORY_MAX_CANDIDATES` | `4` | Candidate stories per matching decision |
| `STORY_MIN_SIMILARITY` | `0.3` | Lexical similarity required before asking Jev |
| `SUMMARY_PROVIDER` | `minimax` | `minimax`, `mock` (offline test output) or `none` |
| `MINIMAX_API_KEY` | unset | M Plan subscription key |
| `MINIMAX_MODEL` | `MiniMax-M3.1-Flash` | Brief model |
| `MINIMAX_REASONING_EFFORT` | `low` | `low` to `max`; higher uses more allowance |
| `MINIMAX_AUTO_RESERVE_PERCENT` | `25` | Plan allowance kept for requested summaries |
| `MINIMAX_MIN_REMAINING_PERCENT` | `3` | Plan allowance at which all summaries pause |
| `SUMMARY_AUTO_ENABLED` | `true` | Automatic summaries for high-priority stories |
| `SUMMARY_AUTO_MIN_PRIORITY` | `0.6` | Priority required for automatic summaries |
| `SUMMARY_AUTO_MAX_PER_DAY` | `40` | Automatic provider-attempt limit per rolling 24 hours |
| `SUMMARY_LANGUAGE` | `English` | Language of summaries |
| `PLACES_ENABLED` | `true` | Read the places of a story and put them on a map |
| `PLACES_MAX_ARTICLES` | `12` | Articles offered to the place reader |
| `PLACES_MAX_INPUT_CHARS` | `40000` | Maximum article text sent to the place reader |
| `PLACES_MAX_OUTPUT_TOKENS` | `4000` | Output token limit of the place reader |
| `GEOCODER_URL` | `https://nominatim.openstreetmap.org` | OpenStreetMap gazetteer |
| `GEOCODER_USER_AGENT` | `Mimir/0.1 (self-hosted news reader)` | How the gazetteer is asked; make it identify you |
| `GEOCODER_TIMEOUT_MS` | `15000` | Timeout of one gazetteer request |
| `GEOCODER_MIN_INTERVAL_MS` | `1000` | Minimum gap between two gazetteer requests |
| `TILE_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Map tiles |
| `TILE_ATTRIBUTION` | OpenStreetMap contributors | Attribution shown on the map |
| `TERMS_ENABLED` | `true` | Explain the terms a story uses and keep a glossary |
| `TERMS_MAX_ARTICLES` | `12` | Articles offered to the term reader |
| `TERMS_MAX_INPUT_CHARS` | `40000` | Maximum article text sent to the term reader |
| `TERMS_MAX_OUTPUT_TOKENS` | `4000` | Output token limit of the term reader |
| `WIKIPEDIA_URL` | `https://en.wikipedia.org` | Encyclopedia the terms are looked up in |
| `WIKIPEDIA_USER_AGENT` | `Mimir/1.0 (self-hosted news reader; https://mimir.invalid)` | How Wikipedia is asked; it must carry an address |
| `WIKIPEDIA_TIMEOUT_MS` | `15000` | Timeout of one Wikipedia request |
| `WIKIPEDIA_MIN_INTERVAL_MS` | `500` | Minimum gap between two Wikipedia requests |
| `WORLD_ENABLED` | `true` | Fill the world map from Wikidata |
| `WORLD_REFRESH_HOURS` | `24` | How often the world snapshot is read again |
| `WIKIDATA_URL` | `https://www.wikidata.org` | Wikidata item API |
| `WIKIDATA_QUERY_URL` | `https://query.wikidata.org/sparql` | Wikidata query service |
| `WIKIDATA_USER_AGENT` | `Mimir/1.0 (self-hosted news reader; https://mimir.invalid)` | How Wikidata is asked; it must carry an address |
| `WIKIDATA_TIMEOUT_MS` | `30000` | Timeout of one Wikidata request |
| `WIKIDATA_MIN_INTERVAL_MS` | `700` | Minimum gap between two Wikidata requests |
| `LOG_LEVEL` | `info` | JSON log verbosity |
| `RETENTION_FETCH_LOG_DAYS` | `30` | Fetch-history retention |
| `RETENTION_JOBS_DAYS` | `14` | Completed-job retention |

Optional advanced environment settings are validated in `src/config.ts`:
`MIMIR_HOST`, `MIMIR_PORT`, `MIMIR_DATA_DIR`, `MIMIR_DB_PATH`, `LOG_PRETTY`,
`FEED_MAX_BYTES`, `FEED_SCHEDULER_TICK_MS`, `EXTRACT_MAX_BYTES`, `JOB_POLL_MS`,
and `RECONCILE_INTERVAL_MS`. Compose sets the internal port to 8080 and data directory
to `/data`; use `MIMIR_PUBLISH` to change the host port. Native execution reads the
process environment; use Node's `--env-file` to load `.env`.

Keep the default localhost binding for local use. For remote access, configure
`MIMIR_BASIC_AUTH` and an HTTPS reverse proxy; forward the original Host header.
Health endpoints remain unauthenticated. Feed URLs are administrator-managed and
may point at LAN feeds. Automatic article extraction blocks private-network targets
by default; this is not a network sandbox for untrusted users.
