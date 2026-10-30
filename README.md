# Mimir — News Intelligence Core

A self-hosted RSS/Atom inbox with persistent collection, optional article extraction,
personalized Jev classification, versioned interests, and relevance feedback.
Articles about the same event are grouped into stories with their own assessment,
development history and, on a MiniMax M Plan, cited Story Intelligence Briefs.
One Node.js/TypeScript process runs the web server, feed scheduler, and SQLite-backed
workers. SQLite FTS5 provides search and story candidates. No external workflow
service or vector database is required. The rules the interface follows, and why they
are what they are, are written down in [DESIGN.md](DESIGN.md).

## Start with Docker Compose

Requires Docker Engine and Docker Compose v2, with outbound HTTPS and DNS access.

```sh
cd mimir
cp .env.example .env
mkdir -p data
docker compose up -d --build
docker compose ps
```

Open **http://localhost:8470**. The initial image build includes the compiler tools
needed for SQLite's native Node module; the runtime image runs as the `node` user.
The bind-mounted `data/` directory must be writable by UID/GID 1000. If your host
user has a different UID, set ownership on this directory before starting:

```sh
sudo chown -R 1000:1000 data
```

On first start, migrations run automatically and 34 feed subscriptions and a default
interest profile are seeded. Feeds poll continuously; the inbox does not require a
manual fetch. Initial feeds may contain thousands of historical entries, so the first
extraction pass can take time. Recent publications receive higher processing priority.

The app starts without Jev credentials. Collection, content storage, search, profile
editing, and feedback work while the interface displays **Pending configuration**.
Classification jobs wait without consuming their retry budgets.

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

Jev also decides story membership (see [Stories](#stories-and-story-intelligence-briefs)).
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

## Use Mimir

- **Stories:** the start page, opening on the **Relevant new** quick view: unseen stories
  with personal relevance of at least 70 and a publication in the last 7 days, newest
  development first. The tabs above the filters switch between **Relevant new** (with its
  current count), **All stories** (by priority) and **Seen**. A quick view is just a set
  of filter values: open the filters to see and adjust it. Any filter you apply replaces
  the default; the **Reset** button returns to it. Other filters: text, period, status
  (new or developing), category, relevance, significance, publisher count, brief state
  and seen state.
- **Story cards:** the title, then one scrolling line of **publishers**, then the lead
  text and one scrolling line of **tags**. Publishers are site hosts: the highlighted
  first chip reported the story first, the rest follow by most recent coverage, and
  `×3` marks several articles from one publisher. A chip opens that publisher's article
  in the story's timeline. Tags start with status badges (new development, new, developing,
  brief state), then topics ordered by match probability times the topic's priority in
  your interest profile; core and high-priority topics are filled, normal and low ones
  are outlined. The check in the top-right corner marks the story seen, and the star
  next to the first report keeps the story with you.
- **Seen:** the corner check on a story card or story page checks it off. In an unseen list
  it leaves the list and the counts update; the **Seen** tab shows checked-off stories and
  lets you undo. A story comes back as unseen, labelled **New development**, when it gets
  a meaningful update; further coverage of the same facts does not bring it back.
  **Mark all N as seen** checks off every story matching the current unseen filters, across
  all pages, after a confirmation.
- **Story details:** the Story Intelligence Brief with cited sources and claim status, the
  assessment with the articles behind each score, and a combined article timeline.
  The brief says when it was written, and a rewritten brief leads with what is new since
  the one before it. A brief that exists is rewritten from the bare arrow (↻) in the head
  of the brief card, beside its title, so the control is reached before the brief text
  rather than after it; the arrow turns blue when the brief is outdated. The timeline
  starts at the most recent entry;
  **Oldest first** / **Newest first** flips it, and the reader's choice is remembered
  for the next story.
  Every timeline entry carries its number, and that number is what the
  brief's citations refer to. Each timeline entry also shows its role (first report,
  update or additional coverage), discovery feed, original and available discussion
  links, article scores and a Save pill. Relevant / Not relevant controls in the story
  header apply to the whole story; hold an icon to see its meaning without applying it.
  Hover and keyboard focus also show explanations. The Save pill in a timeline entry
  saves that one article; the star in the story header and on a story card saves the
  whole story. Story dates and article-management controls are collapsed by
  default. Expand **Manage articles** to move selected reports into a new story; merge
  controls and brief generation remain on the story page.
- **Saved stories:** the star on a story card or in the story header keeps the story
  with you, the way a Save pill keeps an article. The **Saved stories** tab on the story
  list shows the stories you kept (the **Saved** in the navigation holds the saved
  articles), and the **Saved** filter mixes kept and unkept stories with the rest of
  the filters. Letting a story go in the saved list takes it out of that list, the way
  checking off a story takes it out of the unseen list.
- **Live updates:** the story page watches its own story and puts new content in place
  by itself. Write the brief, look up the places, and the page shows the result while
  you watch: no reload, and the scroll position and the open map stay where they are.
  The page holds a server-sent event stream open for the story it shows; if the browser
  cannot keep the stream open, the page falls back to asking for the story's version
  every few seconds. The same happens when a story develops while the page is open: the
  new articles and the new brief arrive by themselves.
- **The counter:** while a brief is being written, a seconds counter stands next to the
  **Writing** badge, so the reader can see how far along it is and how long a brief
  takes. A queued brief counts the waiting time instead. The count comes from the
  server, so it stays right when the page puts a fresh story in place of the old one,
  and it disappears as soon as the brief is there.
- **Map:** the **Map** button in the story header opens a card with the places the story
  is about on an OpenStreetMap map, and a list of the same places with the articles that
  mention them. A pin's popup links to the articles that name the place. **Full screen**
  gives the map the whole screen. The places come with the brief; **Find places** looks
  up the ones a brief does not name, **Look again** refreshes them. See **Places and the
  map** below.
- **Terms:** a name the reader may not know is a button in the brief, the headline and
  the timeline; tapping it opens a card with a one or two sentence explanation and a
  link to its source. The story page lists the terms of the story with their
  explanations, **Explain the terms** looks up the ones a brief does not name, and
  **Explain again** refreshes them. The **Glossary** page in the navigation lists
  everything Mimir knows, grouped by kind. See **Terms and the glossary** below.
- **Articles:** sort by rank, personal relevance, publication or discovery; search title,
  summary, text and author; filter by source, category, relevance range, date,
  processing status, saved state, feedback or article type. Clear filters to see all
  stored articles, including low scores and failures.
- **Article details:** inspect source content, metadata and original entry data,
  publication/update/discovery/ingestion timestamps, extraction status, scores,
  classification history and raw structured results. Open the publisher's original
  article or request a new classification. Discussion links supplied by feeds (RSS
  comments and Atom HTML replies) appear alongside the original on article lists,
  details and the story timeline. Existing articles use their preserved feed metadata;
  no download or reclassification is needed to show these links.
- **Sources:** add a feed URL or a page advertising a feed; edit intervals, extraction
  preferences and tags; enable, disable, fetch or delete subscriptions. Fetch history
  includes HTTP status, counts and errors. Deleting a source keeps its articles and
  provenance snapshots.
- **Interest profile:** edit interests, priorities, exclusions, editorial preferences
  and ranking weights. Changed definitions create immutable versions. Activate older
  versions or reclassify existing articles by time range. Saving a profile affects
  future work; use the reclassification controls to update previous results.
- **Statistics:** inspect volumes, score distribution, categories, feedback agreement,
  worker state and failed jobs. Retry failed jobs here after addressing their cause.

Story relevance feedback preserves the assessment, profile version, coverage and
development count shown at the time. Labels survive new developments; seen state
does not. Stats compares these story labels with story assessments. Existing article
labels are carried to their stories only when they agree, and all original feedback
events remain in history. Old more/less events remain historical; those controls are
no longer offered. Feedback does not automatically train or modify rankings. Explicit
and future inferred interests have separate profile fields.

Rank is a weighted mean of relevance, significance, urgency and the strongest
priority-weighted topic match, multiplied by promotional and exclusion penalties.
Individual assessments remain available separately. Changing weights creates a new
profile; use reclassification to apply it to existing articles in this UI.

## Stories and Story Intelligence Briefs

**Matching.** Every new article goes through a persistent matching job. Full-text search
over the stories of the last `STORY_MATCH_WINDOW_DAYS` days finds candidate stories; a
candidate qualifies when enough of the article's distinctive words (weighted by rarity)
appear in the story, by title or by title and teaser (`STORY_MIN_SIMILARITY`). An identical
headline joins directly. Otherwise one Jev request decides, per candidate, whether the
article reports the same story and whether it adds a meaningful development (new facts,
numbers, decisions, confirmations, contradictions) or only repeats it. No qualifying
candidate, or no "same story" decision, starts a new story. Each decision is stored with
the candidates, scores, model, request and response. Matching runs one article at a time so
two reports of a new event cannot open two stories. Existing articles are matched in the
background after the upgrade.

**Development history.** A story keeps its identity as it grows. The first report and each
meaningful update are developments; other articles are coverage. The story records when
it was created, first and latest publication, and the latest development.

**Assessment.** Stories are assessed separately from articles, from the current
classifications of their members:

- personal relevance and significance: the strongest report, with the profile's promotional
  and exclusion penalties applied to each article;
- urgency: the strongest report around the latest development;
- coverage: independent publishers, with diminishing returns. Promotional articles and
  further reports from the same publisher add nothing, so press releases and syndicated
  copies cannot inflate priority;
- recency: decays from the latest development (half-life in the profile).

Priority is the weighted mean of these signals with the weights under **Story priority
weights** on the profile page. It is not an average over articles and does not grow with
article count. Every assessment records the formula, profile version and the articles and
classifications behind each score; history is kept. Stories are reassessed when members or
their classifications change and after a profile change.

**Briefs.** A Story Intelligence Brief synthesizes the articles of one story into a
coherent, factual account. It has five parts: the gist (two or three sentences), the key
developments, the context and why it matters, the differences between sources and what
is still uncertain, and what comes next. A section that would add nothing is left out
rather than padded. Every item cites the articles it is based on, and each claim is
marked as established (independently confirmed or the primary source's own statement),
reported (one publisher), claimed (attributed, unverified) or disputed. The prompt says
how much of each article is available (full text, partial, teaser or headline only,
shortened) so the brief does not imply more was read. Article text is treated as
untrusted data, never as instructions. Output must be one JSON object matching a strict
schema and may cite only articles it was given; anything else is rejected and retried. A
failed or rejected attempt never replaces the existing brief. Each revision stores the
provider, model, prompt version, the articles and their content hashes, raw output and
token usage.

**Rewriting a brief.** Every brief is kept, as a numbered revision, and the page shows
when the current one was written. A rewritten brief is given the one it replaces and
leads with what has happened and changed since then: new developments, corrections and
changed numbers, and nothing the previous brief already said. The articles that were not
part of the previous brief are marked for the model, so it knows what is new. When no
article is new, the section is left out entirely rather than repeated.

**The numbers.** A citation points at the article it is based on, and the number it
shows is that article's number in the story's timeline, which is also its publish
order. The timeline carries the numbers, so there is one list of articles and one
numbering, not two. The number stays the publish order when the reader flips the
timeline to read from the start.

- **Automatic:** for stories at or above `SUMMARY_AUTO_MIN_PRIORITY` whose latest
  development is within `SUMMARY_AUTO_MAX_AGE_HOURS`, at most `SUMMARY_AUTO_MAX_PER_DAY`
  provider attempts in a rolling 24-hour window, including failed attempts and retries.
  This local cost limit is independent of the provider's subscription allowance.
- **On request:** any story, from its page, ahead of automatic work. **Write now**
  promotes an already queued brief to manual priority and checks current provider
  capacity. Manual requests bypass the local automatic limit, while all provider
  allowance checks remain in force. Running generations cannot be duplicated.
- **Outdated:** a meaningful update marks the brief outdated; coverage that only repeats
  it does not. Outdated briefs of high-priority stories are regenerated automatically
  (at most every `SUMMARY_MIN_REGEN_MINUTES`); others when you request it.

Brief generation runs as persistent jobs and never blocks collection or classification.
Story pages show queued, generating, failed and outdated states.
Stats displays the local automatic budget separately from provider capacity; when
the local cap is reached, the story page shows when capacity begins returning.

## Places and the map

**The map.** Every story page has a **Map** button. It opens a card with a live map of
the places the story is about: one pin per place, on OpenStreetMap tiles, draggable and
zoomable like any map, with the place name and coordinates in a popup. The button shows
how many places are known, and the card carries the same list of places as text with the
articles that mention them, so the information is readable even where the map is not. A
pin's popup names the place, gives the gazetteer's own wording for it and the
coordinates, and links to the articles that mention it.

**Full screen.** The map card has a **Full screen** button: the map then takes the whole
screen, which is easier on a phone and leaves the popups the room they need. The button
becomes **Close map**, and the Escape key leaves full screen as well. A popup never grows
taller than the map it is in, so it can always be closed: a place that many articles
mention gets a list that scrolls.



**Where the places come from.** Two steps, and only the first one costs anything:

1. *Reading the names.* The brief's answer names the places as well as writing the
   brief: one model pass over the story's articles answers both questions, so the
   articles are sent once and the places ride along in the same reply. The prompt asks
   for names only and explicitly forbids coordinates, because a model asked for
   coordinates invents plausible ones. The places are read leniently: a place that does
   not fit is dropped, and one that cites an article the model was not given loses that
   citation, but the brief it came with is never lost. A brief written before this
   change carries no places, and asking for its map runs the separate name-reading pass
   instead, whose prompt is versioned as `places/2`.
2. *Finding them on the map.* Each name is looked up in the OpenStreetMap gazetteer
   (Nominatim), one request a second at most, with an identifying `User-Agent`. The kind
   of place narrows the search, so a city is not answered with a street of the same name
   and a region is not answered with a building. Every answer is cached in the database,
   including the ones that found nothing, so a place that recurs in many stories is
   looked up once. The pin carries the name as the story wrote it; the gazetteer's own
   wording, in English where it has one, is shown beside it.

**The same name, the wrong place.** "Gaza" is a strip, a city and a province, and there
are towns of that name in other countries; "Ohio" is a state and a river. The gazetteer
answers a bare name with whichever place it ranks first, so a bare name is not enough.
The model resolves each place in the context of the articles first — not from its own
knowledge of the world, but from the country or region the articles themselves give — and
answers with three things: the name as the articles write it, the country it lies in
with its ISO code, and the name to look up, made unambiguous with the larger unit it
belongs to ("Gaza Strip", "Kherson", "Springfield, Illinois"). The gazetteer search
then uses that country and judges the hits: a hit in another country is a different
place and is passed over, a hit that is neither a place of the right kind nor the place
of the right name is passed over, and a country the model did not name is only accepted
when nothing else answers.

**What the reader sees.** A place the gazetteer does not know stays in the list without a
pin; it is not silently dropped. If the gazetteer cannot be reached at all, the names are
kept, the map is left empty and the card says so. A place named in a story but not about
it is not worth a pin, so the prompt asks for the places the story is actually about and
gives each place a role in the story. The map opens on the places where things happened;
a country is drawn too, but it does not pull the view away from the city.

**When it runs.** The names come with the brief, so a brief that names its places
brings its map along: the lookup starts by itself once the brief is written. A story
whose brief names no place has no map until you ask for one with **Find places** on the
story page, and **Look again** does it again. A lookup that is already running is not
started twice. When a story develops, its places are marked outdated, and the card says
that the map may be behind the news; the map itself keeps the previous answer until you
refresh it.

**Cost.** The names are part of the brief's answer, so they cost a few hundred output
tokens and no second call: the articles are not sent twice. Only a brief written before
that change needs the separate name-reading pass, which uses the same provider and the
same allowance rules as the summaries. Geocoding is free, but the public
Nominatim instance asks for at most one request a second and for a `User-Agent` that
identifies the caller; `GEOCODER_MIN_INTERVAL_MS` enforces that, and
`GEOCODER_USER_AGENT` should say who you are.

**The tiles.** The map draws the standard OpenStreetMap raster tiles, which the tile
policy allows for light use and requires to be attributed on the map; Mimir shows the
attribution from `TILE_ATTRIBUTION`. Point `TILE_URL` at your own tile server if Mimir
grows busier than light use. The map library (Leaflet 1.9.4, BSD-2-Clause) is vendored
in `public/vendor/leaflet/`, not loaded from a CDN, so the feature works on a network
that cannot reach one.

**Without JavaScript.** The **Map** button is a link, so it opens the card on the server;
the list of places is server-rendered; only the map itself needs JavaScript. The brief
and the places are written by the server, so without JavaScript the page does not
update itself: reload it to see the result. The **Full screen** button is only shown
when JavaScript is there, because without it there is nothing to press. The same goes
for the timeline's order switch.

## Terms and the glossary

**Terms you can tap.** A name the reader may not know — "Cohere", "Nvidia", "the
Mormon Trail" — becomes a button in the brief, in the story headline and in the
timeline. Tapping it opens a small card with the explanation: what the term is, in one
or two sentences, and a link to the source it came from. The card is built from DOM
nodes and never from markup, so a term an article brought in cannot inject anything into
the page. Without JavaScript the button still carries the explanation as its tooltip,
and the story page lists every term with its explanation in full.

**Mimir's own glossary.** The explanations live in Mimir's database, not in the
browser: a term is explained once and reused in every story that mentions it. The
**Glossary** page in the navigation lists everything Mimir knows, grouped by kind
(organisation, product, person, project, concept, acronym), with the number of stories
that mention each term. A name is only a term when it stands on its own: "ICE" is a
button, the "ice" inside "office" is not, and a term the articles only ever name inside
another word is dropped instead of being filed.

**Where the names come from.** The brief's answer names the terms as well as writing
the brief, exactly as it names the places: one model pass over the story's articles
answers both, so the articles are sent once. The terms are read leniently — a term that
does not fit is dropped, and one that cites an article the model was not given loses
that citation, but the brief it came with is never lost. A brief written before this
change carries no terms, and asking for the terms of such a story runs the separate
name-reading pass instead, whose prompt is versioned as `terms/1`.

**Words that are only words in one story.** A name the news writes in lower case most
of the time is an ordinary word, not a name: "NEW" is Debian's queue of new packages in
one story and the opposite of old in all the others, "Office" is Microsoft Office in one
story and a room in all the others. Mimir counts the words of the news — the
headlines, the teasers the feeds carry and the briefs — and a name it finds in lower
case most of the time (at least ten times, and of at least three letters) is marked as
an ordinary word. Such a name is marked only in the stories that named it, and only
where the text writes it as it is named: "NEW" is a button in the story about Debian's
packages, and the "new" of "a new release" is plain text everywhere else. The count is
redone every ten minutes, as the news grows.

**Where the explanation comes from.** Each term is looked up in Wikipedia first: the
title the model gave ("Sandbox (software development)" for an ambiguous name), then the
bare name, then a search whose hits are only accepted when their title carries the
name. A page that only lists several meanings explains nothing and is not an answer,
and neither is a redirect to a different thing entirely: "Sandbox" leads to "Sandpit",
a pit for children, so it is refused — while "Federal Bureau of Investigation", which
introduces the name it was asked for, is accepted. The explanation is the first two
sentences of the article, and the source link points at the article itself.

**When Wikipedia does not know.** A term the encyclopedia does not have is explained
from the articles instead, by a second reading of them: one or two sentences of what
the term is, written for a reader who does not know it, and marked as coming from
Mimir rather than from Wikipedia. A term that neither source can explain stays in the
list, marked "not explained", rather than being filled with a guess. The first
explanation a term ever gets is never overwritten, so the glossary does not change its
mind; a term the encyclopedia did not know is only looked up again when a better title
arrives with it.

**When it runs.** The terms come with the brief, so a brief that names its terms
brings the glossary along: the lookup starts by itself once the brief is written. A
story whose brief names no term has no glossary until you ask for one with **Explain
the terms** on the story page, and **Explain again** does it again. A lookup that is
already running is not started twice. When a story develops, its terms are marked
outdated, like its places.

**Cost.** The names are part of the brief's answer, so they cost a few hundred output
tokens and no second call. Only a brief written before that change needs the separate
name-reading pass. Wikipedia is free, but the public instance asks for a `User-Agent`
that identifies the caller and for a request at a time; `WIKIPEDIA_MIN_INTERVAL_MS`
enforces the gap. The `User-Agent` has to carry an address — a URL or a mailto — not
just a name: Wikipedia's edge answers 429 to a caller it cannot reach, whatever the
gap between the requests is. The default carries the reserved `.invalid` address, so
set `WIKIPEDIA_USER_AGENT` to your own to be reachable.

**The endpoints.**

- `GET /api/terms/:key` — the explanation of one term, as JSON.
- `GET /api/stories/:id/terms` — the terms of a story and the state of the lookup.
- `POST /stories/:id/terms` — asks for the terms of a story to be looked up.

## Live updates

A story page watches its own story, so that nothing the reader asks for ends in a
reload. The page holds a server-sent event stream open for the story it shows; the
server sends an event when something on the page has changed.

**What counts as a change.** The server keeps a short fingerprint of each story: the
revision of the brief, whether a brief was asked for, whether the brief is out of date,
the state of the place lookup, the number of articles in the story, and the newest
brief, place and assessment. Any write to a story moves that fingerprint, so a new
brief, a found place, a new article or a new assessment is noticed without the web
layer having to know which of them it was.

**The endpoints.**

- `GET /api/stories/:id/events` — the event stream. It opens with the version the
  page already has, and sends a `change` event with the new version whenever the
  fingerprint moves. A comment every 20 seconds keeps the connection alive, and the
  browser reconnects on its own.
- `GET /api/stories/:id/state` — the same fingerprint as JSON, for a browser that
  cannot hold an event stream open. The page then asks every few seconds.

**What the page does.** On a change, the page fetches the story page again and puts the
new story in place of the old one: the brief, the places, the map and the timeline all
come back in the new version. The reader's timeline order and the open map are kept,
and the map is drawn again with the new places. The two buttons on the page — **Write
the brief** and **Find places** — post in the background and let the page update
itself when the answer is ready.

**The seconds counter.** While a brief is being written, the **Writing** badge carries a
counter: the seconds since the writing began, counting up in the browser. The start time
comes from the server, so the count is right after the page has replaced itself with a
fresh story, and it does not care whether the clock of the browser and the clock of the
server agree. A brief that is queued rather than written counts the time since the
request instead. The counter is gone as soon as the brief is there.

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
src/stories/          candidate retrieval, Jev story matcher, assessment, story jobs
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
