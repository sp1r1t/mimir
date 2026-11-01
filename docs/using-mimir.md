# Using Mimir

[← Back to the README](../README.md)

## Use Mimir

- **Navigation:** Stories, World, Articles, Saved articles, and Glossary share the
  compact header. **More** opens Sources, Interest profile, Statistics, and Review low scores,
  and shows classifier status. Search follows the story or article context. The
  navigation and forms work without JavaScript; keyboard users can skip to content.
- **Stories:** the start page, opening on the **Relevant new** quick view: unseen stories
  with personal relevance of at least 70 and a publication in the last 7 days, newest
  development first. The tabs above the filters switch between **Relevant new** (with its
  current count), **All stories** (by priority) and **Seen**. A quick view is just a set
  of filter values: open the filters to see and adjust it. Any filter you apply replaces
  the default; the **Reset** button returns to it. Other filters: text, period, status
  (new or developing), category, relevance, significance, publisher count, brief state
  and seen state.
- **Story cards:** the title, then one scrolling line of **publishers**, then the lead
  text and one scrolling line of **tags**. The preview uses the latest brief’s gist
  when available (including older executive summaries), falling back to the first
  article’s teaser until a brief exists. Previews keep their compact 280-character
  limit. Publishers are site hosts: the highlighted
  first chip reported the story first, the rest follow by most recent coverage, and
  `×3` marks several articles from one publisher. A chip opens that publisher's article
  in the story's timeline. Tags start with status badges (new development, new, developing,
  brief state), then topics ordered by match probability times the topic's priority in
  your interest profile; topics are quiet text links, with core topics in the accent
  colour and high-priority topics in stronger text. Publishers also use text links,
  with the first reporter emphasized. The four scores share one compact footer,
  with only the priority meter accented. The line below the headline has **First reported** on the left, with
  the save star and the seen check grouped on the right. The headline uses the full card width.
- **Seen:** the check beside the save star on a story card, or the labelled seen
  button beside Save below the story-page headline, checks it off. In an unseen list
  it leaves the list and the counts update; the **Seen** tab shows checked-off stories and
  lets you undo. A story comes back as unseen, labelled **New development**, when it gets
  a meaningful update; further coverage of the same facts does not bring it back.
  **Mark all N as seen** checks off every story matching the current unseen filters, across
  all pages, after a confirmation.
- **Story details:** the Story Intelligence Brief with cited sources and claim status, the
  assessment with the articles behind each score, and a combined article timeline.
  Every panel of a story folds away, and they all fold the same way: the head of the
  panel carries its title, what it holds, and the arrow that folds it. The brief says
  when it was written, and a rewritten brief leads with what is new since
  the one before it. A brief that exists is rewritten from the bare arrow (↻) on the
  headline of the brief panel, so the control is reached before the brief text rather
  than after it; the arrow turns blue when the brief is outdated, and pressing it
  rewrites the brief without folding the panel. The brief stands open, because it is
  the story itself, and the assessment and the timeline stand open with it; the terms,
  the merge controls and the changes are folded. A reader who folds the brief keeps it
  folded, and a reader who folds the assessment keeps it folded, also after the page
  puts a fresh story in place of the old one. The timeline starts at the most recent entry;
  **Oldest first** / **Newest first** flips it, and the reader's choice is remembered
  for the next story.
  Every timeline entry carries its number, and that number is what the
  brief's citations refer to. Each timeline entry also shows its role (first report,
  update or additional coverage), discovery feed, original and available discussion
  links, article scores and a Save pill. Relevant / Not relevant controls in the story
  header use thumbs-up/thumbs-down icons with visible labels and apply to the whole story; hold an icon to see its meaning without applying it.
  Hover and keyboard focus also show explanations. The Save pill in a timeline entry
  saves that one article; the star in the story header and on a story card saves the
  whole story. Story dates and article-management controls are collapsed by
  default. Expand **Manage articles** to move selected reports into a new story; merge
  controls and brief generation remain on the story page, in panels of their own.
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
  explanations in a panel that stands after the timeline and is folded away until the
  reader opens it, **Explain the terms** looks up the ones a brief does not name, and
  **Explain again** refreshes them. The links of a term — its source, the articles it
  comes from and its own button — stand on one line, so a term does not take a screen
  of its own. The **Glossary** page in the navigation lists
  everything Mimir knows, grouped by kind. Its search filters names and explanations
  locally, without a new model request. See **Terms and the glossary** below.
- **Articles:** sort by rank, personal relevance, publication or discovery; search title,
  summary, text and author; filter by source, category, relevance range, date,
  processing status, saved state, feedback or article type. Clear filters to see all
  stored articles, including low scores and failures.
- **Article details:** start with the article text; expand Classification, Timeline,
  or Metadata to inspect scores, timestamps, metadata and original entry data,
  publication/update/discovery/ingestion timestamps, extraction status, scores,
  classification history and raw structured results. Open the publisher's original
  article or request a new classification. Discussion links supplied by feeds (RSS
  comments and Atom HTML replies) appear alongside the original on article lists,
  details and the story timeline. Existing articles use their preserved feed metadata;
  no download or reclassification is needed to show these links.
- **Sources:** feeds appear as a table on larger screens and labelled cards on phones,
  with fetch and enable/disable controls on each row. Add a feed URL or a page advertising a feed; edit intervals, extraction
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

## The world

**The World page.** The **World** tab in the header opens a map of the world, one
country at a time, with what Mimir knows about each of them: who governs it, where the
news is coming from, and when it votes next. It is the same reader as everywhere else:
a map, a list, and a page per country.

**One colour at a time.** The map can be coloured three ways, and the reader chooses
one of them at the top of the card:

- **Politics** — where the government sits on the left-right axis: left, centre-left,
  centre, centre-right, right. A government that is not on that axis at all — a
  one-party state, an absolute monarchy, a military government — is shown in its own
  grey, and a country Mimir has no row for is shown in the pale grey of the unknown.
- **Activity** — how much of your news touches each country in the last 30 days, in
  four steps of one grey. No hue is used: activity is how much, not what.
- **Elections** — whether an election is happening now (gold), is scheduled (pale
  gold), or is not known.

The colour of a country means exactly one thing at a time, and the legend under the map
names what it means. The colours of the interface are not reused: the accent blue is
for acting and the red is for failure, so the world map uses violet and orange for the
ends of its axis.

**A map of shapes, not of streets.** The world map is drawn from the shapes of the
countries themselves — Natural Earth's 110m borders, which are public domain — so each
country is a shape Mimir can fill with its own colour. There are no street tiles under
it: a road map underneath a political map only argues with it. Every country carries
its name, written where a cartographer would put it, and a name appears only when the
country is big enough on screen to hold it. Zoom in and more names appear; pan and
none of them moves or blinks away.

**Moving now.** Under the map is the list of the countries worth a look, ordered by how
loud they are: an election is happening now, an election is coming within thirty days,
the news says the snapshot may be out of date, or the country is simply where your
news is. Each row names the government, its position, the next election and how many
stories and developments mention the country. Tapping a country opens its page.

**A country page.** `/world/rs` shows one country: where it is, who governs it and with
what party, where that government sits on the axis and what its source says, when it
next votes and in how many days, whether Mimir has noticed that the snapshot may be out
of date, and the stories that name it. The stories are the reader's own: they are the
ones Mimir ranked for you.

**Where the rows come from.** Each row is read from Wikidata: the head of state, the
head of government, the party or parties in office, the next election and the date it
is due. Every row carries its source and the date it was read, and the news can mark a
row out of date when it gets old. Wikidata does not always say enough: a country whose
governing party says nothing about where it stands is shown as unknown rather than
guessed at, and a one-party state or an absolute monarchy is shown outside the axis
altogether, because its government does not stand on it. So is a government whose own
party describes it as authoritarian, monarchist or statist.

**Which party is in office.** In a parliamentary system the government is the head of
government and the head of state is a figurehead, so their party is neither the
government nor a partner of it. In a presidential system the head of state governs, and
the prime minister's party sits with them.

**Without JavaScript.** The map needs JavaScript, as the story map does. Everything else
does not: the moving list, the country table and the country page are all server
rendered, and the three ways of colouring the map are links.

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
bare name, then a search whose hits carry the name first. A page that only lists
several meanings explains nothing and is not an answer, and neither is a redirect to a
different thing entirely: "Sandbox" leads to "Sandpit", a pit for children, so it is
refused — while "Federal Bureau of Investigation", which introduces the name it was
asked for, is accepted. The explanation is the first two sentences of the article, and
the source link points at the article itself.

**When the encyclopedia answers about the wrong thing.** A name is often two things, and
the encyclopedia answers with the article whose title matches the name: "A2A" is an
Italian utility and Google's protocol for agents to talk to each other, "Dawn" is the
hour before sunrise and Chromium's WebGPU implementation, "Okta" is a scale for cloud
cover and a company that sells logins. The note the story made about the term says
which of the two the story means — "Chromium's WebGPU implementation" — and the article
has to agree with it. Where the article and the note do not plainly agree, the model,
which has read the articles, is asked whether they are about the same thing, and an
article about the other thing is refused: the term is explained from the articles
instead. The encyclopedia is asked for a term under a title it does not know, too: the
search hits are tried in order, and "Agent2Agent" is accepted for "A2A".

**A name that stands for two things.** The glossary is shared, so a term explained for
one story is marked in every story and article that names it. A name that means two
things needs more than that: "PT" is Lula's Workers' Party in one story and the
Pacific time zone in half a dozen others, "RTS" is Radio Television of Serbia in one
and a real-time strategy game in several, "GR" is a Debian General Resolution and a
Fourier robot, "Kitty" is a terminal emulator in one story and the character on the
merchandise in another. Such a name is marked only where the words of its reading
stand near it — "PT" is a button where the sentence says party, workers or Lula, and
nowhere else — and it is matched as the news writes it, so the "cube" of a solid with
six faces is never the "Cube" of Roblox's generative system. The story that named the
term marks it wherever it stands, because that story knows which of the two it means.
A thing that has a name of its own gets an entry of its own: "Hello Kitty" is filed
apart from the "Kitty" of the terminal emulators, and each of them is explained in its
own right.

**When Wikipedia does not know.** A term the encyclopedia does not have is explained
from the articles instead, by a second reading of them: one or two sentences of what
the term is, written for a reader who does not know it, and marked as coming from
Mimir rather than from Wikipedia. A term that neither source can explain stays in the
list, marked "not explained", rather than being filled with a guess. The first
explanation a term ever gets is never overwritten, so the glossary does not change its
mind; a term the encyclopedia did not know is only looked up again when a better title
arrives with it. The reader can ask for a term to be looked up again as well: the
**Explain again** button next to a term on the story page puts that term back on the
shelf and asks the encyclopedia about it once more, and the **Explain again** button of
the panel does the same for every term of the story.

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
- `POST /stories/:id/terms/:key` — asks for one term to be looked up again.

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
the map is drawn again with the new places, and every panel the reader folded or opened
keeps the state it had. The two buttons on the page — **Write
the brief** and **Find places** — post in the background and let the page update
itself when the answer is ready.

**The seconds counter.** While a brief is being written, the **Writing** badge carries a
counter: the seconds since the writing began, counting up in the browser. The start time
comes from the server, so the count is right after the page has replaced itself with a
fresh story, and it does not care whether the clock of the browser and the clock of the
server agree. A brief that is queued rather than written counts the time since the
request instead. The counter is gone as soon as the brief is there.
