# Design log

The README says what Mimir does. This file says how it should look and feel, and why.
Each entry is a decision with its reason, so that a later feature can be built in the
same spirit — and so that other projects can borrow the ideas without re-deriving them.

The decisions are written for the reader who holds the phone. Everything here follows
from that.

---

## Principles

**1. The phone is the reader.** The dashboard is the whole interface. There is no
desktop mode, no second surface, no "open the app to do this properly". A decision that
only works on a wide screen is a decision that has to be rethought.

**2. The action belongs where the trouble is.** A control that changes something lives
in the card of that thing, at the head of it — so it is reached before the long text
under it, not after it. A control that acts on nothing in particular may float, but it
has to earn that.

**3. Show the wait.** Anything that takes time says so, counts, and says how long it has
been waiting. Silence is the same as failure, and a reader cannot tell them apart.

**4. One meaning per mark.** Every colour, icon and word carries exactly one thing. The
accent blue is an action. Gold is something kept. Green is done. Muted is context.
Nothing is decorative and nothing is reused for a second purpose.

**5. The page keeps itself current.** New content arrives by itself. No reload, no
"refresh to see the result", no stale count.

**6. Text from the outside stays text.** Names, summaries and encyclopedia extracts are
third-party text. They are shown as text, never as markup.

---

## Decisions

### D1 — The brief is rewritten from the brief card

**What.** A brief that exists is rewritten from a bare arrow (↻) in the head of the
brief card, beside the "Story Intelligence Brief" title. The card keeps its text button
only when there is no brief yet ("Write the brief"), when one is queued ("Write now"),
or when writing failed ("Retry the brief").

**Why.** Rewriting is an operation on the brief, so it belongs in the brief card — not
in the story header, and not floating over the page. The button used to sit at the end
of the brief text, which asked the reader to walk through the whole of it to reach it.
The head of the card is where the reader already is when the brief is the thing in
hand, and it is above the text rather than below it.

**How it shows.** A bare glyph, like the check that marks a story seen: no border, no
circle, no background. Quiet grey normally, accent blue when the brief is outdated. It
carries the label "Rewrite the brief." for a screen reader. It disappears while the
brief is being written, because there is nothing to rewrite then, and comes back when
the writing is done.

**What it means for later work.** An operation lives in the card of the thing it
operates on, at the head of that card. A control that floats over the page has to earn
its place, and a control that sits in a card it does not belong to is a lie about what
it changes.

### D2 — A counter for every wait

**What.** A seconds counter stands next to the "Writing" badge, and another next to
"Queued" for the waiting time. It is written by the server and counted by the browser
from the server's clock, so it stays right when the page puts a fresh story in place of
an old one.

**Why.** "Writing…" tells the reader that nothing is wrong. It does not tell them
whether the model is thirty seconds in or five minutes in, and those are very different
situations: one is normal, the other is a plan that has gone wrong.

**How it shows.** `42s`, then `1m 05s`, then `2h 03m`. Tabular figures so the number
does not jump. The count starts at the moment the request was made, not at the moment
the page loaded.

**What it means for later work.** Any new slow thing gets a counter. If a reader can
wait for it, the reader can watch it.

### D3 — A star keeps a story

**What.** A story is kept with a star: an outlined ☆ on a story card, a filled ★ in
gold once it is kept. The star sits in the card's meta line, next to the first report,
and in the story header next to the relevance controls. The story list has a "Saved
stories" tab and a "Saved" filter.

**Why.** The Save pill on an article saves an article. There was no way to keep a
*story*, which is the thing a reader actually comes back for: a story is one thread
across many publishers, and it is the thread that gets lost.

**How it shows.** Gold, not blue: gold is "kept", blue is "act". The card's star is a
glyph only, so it does not compete with the headline; the header's star carries the
word "Saved". Letting a story go in the saved list takes it out of that list, the same
way checking off a story takes it out of the unseen list.

**What it means for later work.** Kept things are gold, everywhere. A saved filter, a
saved list and a saved count are one feature, not three.

### D4 — The check marks a story seen

**What.** On a story card, the line below the headline has First reported on the
left and the save star followed by the seen check grouped on the right. This leaves the full width for the headline
on a phone. The story page uses one toolbar below the publishers: Relevant, Not
relevant, Map, Save, and Seen. Five equal columns keep every control on one row,
with consistent monochrome icons above visible labels and no individual button
borders. Save and Seen stay on the right; only Seen uses a check mark.

**Why.** "Seen" is a small, frequent, reversible act. It should not cost a line of
layout, and it should not be mistaken for a decision about the story. A story that
develops after being seen comes back, labelled "New development".

**What it means for later work.** Frequent story controls belong together below the
card headline, with the state carried by the glyph itself.

### D5 — A term is a button

**What.** A name the reader may not know — an organisation, a protocol, a place — is a
button in the brief, in the headline and in the timeline. Tapping it opens a small card
with a one or two sentence explanation and a link to the source. The **Glossary** page
lists everything Mimir knows.

**Why.** The reader came for the news, not for a vocabulary lesson. A name that stops
them is a name that should be tappable, and an explanation that is one tap away is
better than a footnote that is one scroll away.

**How it shows.** The card is built from DOM nodes, never from markup, because the
explanation comes from an encyclopedia. The glossary is global and shared: the first
explanation of a term is never overwritten.

**What it means for later work.** Any word that might stop the reader is a button.
Explanations are kept once and reused everywhere.

### D6 — The page puts new content in place

**What.** The story page watches its own story and swaps the fresh story in place of
the old one. A server-sent event stream carries the change; a browser that cannot hold
one falls back to asking for the story's version every few seconds.

**Why.** A reader who asked for a brief should watch it being written, not stare at a
page and wonder whether to refresh. The scroll position and the open map stay where they
are.

**What it means for later work.** Every page that waits for something watches for it.
Refresh is a failure of the interface, not a step in the flow.

### D7 — A term is marked only when it stands on its own

**What.** A name in the glossary becomes a button only where it stands on its own in the
text: "ICE" is a button, "office" and "practice" are not. A term the articles only ever
name inside another word is dropped instead of being filed.

**Why.** The glossary is shared by every story, so a name picked up once is offered
everywhere. A mark that lands in the middle of a word is a mark on nothing: the reader
taps "ice" inside "office" and is given a card about a law enforcement agency the story
never mentioned.

**How it shows.** Nothing at all — the word stays a word. The check is the same for the
whole glossary, not for one story, because the glossary is shared.

**What it means for later work.** Any mark in a text has to know where words begin and
end. Unicode letter classes need the `u` flag to be letter classes at all: without it
`\p{L}` is the literal letters p, {, L, } and N, and "ice" is a word inside "office".

### D8 — Story cards put reading before scoring

**What.** Story cards use one full-width column, with the headline, dates and controls,
publishers, brief preview, and topics above a compact four-column score footer.
Publishers and topics are text links rather than separate bordered pills. The first
publisher is emphasized; core and high-priority topics keep their visual emphasis.
Status badges retain their state colours. Only the priority meter uses the accent;
the other meters are muted. Reading text and headline sizes stay the same.

**Why.** A card should let the reader understand the story before inspecting its
assessment. Shared alignment, fewer boxes, and quiet metadata preserve an overview
on a phone. Long words and URLs wrap without widening the page. Save and Seen stay
together on the right below the headline, with comfortable touch targets.

### D9 — One reader, one visual language

**What.** The shared header has four reading destinations: Stories, Articles, Saved,
and Glossary. Sources, the interest profile, statistics, and the low-score review
live in a native More disclosure. Search follows the reading context. On phones,
the header is two compact rows; a healthy classifier does not occupy reading space.
The More menu carries its status, while configuration problems still show a banner.

Every page shares the same headings, spacing, fields, focus treatment, and panel
style. Article cards use the story-card score footer. Article detail leads with the
text; classification, dates, and metadata are folded but remain available without
JavaScript. Source rows become labelled cards on phones, with their actions in reach.
Wide tables scroll within their panels. The glossary can be searched locally.
Profile preferences come first; reclassification and JSON editing are secondary.

**Why.** Reading is the frequent task. Settings and diagnostics should remain easy
to reach without taking over every screen. The compact font scale stays as the reader
chose it. Controls work with touch and keyboard, the skip link clears the sticky
header, and navigation and forms retain their native HTML behaviour without scripts.

### D10 — The world is one colour at a time

**What.** The World page colours each country with one thing: the position of its
government, the amount of the reader's news that touches it, or the state of its next
election. The reader chooses which of the three, and the legend under the map names
what the colour means. A government that is not on the left-right axis — a one-party
state, an absolute monarchy, a military government — has a colour of its own, and a
country Mimir knows nothing about is shown as unknown rather than as a guess.

**Why.** The map can only say one thing with a colour. Three things at once are three
meanings on one mark, and a reader who has to work out which is which stops reading
the map. The axis is also not universal: a state with no party government and no
elections is not "right-wing", and painting it as if it were would be a claim the
source does not support.

**How it shows.** Violet is the left end of the axis and orange the right end, with
the page's own grey in the middle, because the centre of the spectrum is not a strong
claim. The accent blue and the red are not used: they are the interface's action and
failure, and the world map does not act on a country or fail at it. The activity map
uses one grey in four steps, because how much is not a kind. Every legend entry carries
a word, and the country rows carry the same colour beside the name.

**What it means for later work.** Any new mark on a map says one thing. When a second
thing has to be shown, it gets another channel — a badge, a glyph, a second map — and
the reader is told which channel carries what.

### D11 — The world map is a map of shapes, and the shapes carry their names

**What.** The world map is drawn from the borders of the countries themselves rather
than from street tiles, and every country carries its own name.

**Why.** A political map and a street map are two different maps, and they argue. The
place names and roads of a street map compete with the colour that carries the
meaning, so the reader is left reading a road map with a wash on top of it. The
countries were vector shapes all along — they were the thing being coloured — so the
tiles are simply taken away. As for the names: most readers know most of the world,
but not instantly, and a name written on its own country saves the hunt. A name also
has to earn its place, or the map becomes a wall of text.

**How it shows.** The shapes come from Natural Earth's 110m countries, which are public
domain, and are deliberately coarse: a country is read as one mark. A name is written
at the point Natural Earth's own cartographers chose, and where that point falls in the
sea it is moved onto the country's land, so a name is always written on the colour of
the country it belongs to — which is also why it is written in ink or in light,
whichever that colour can carry. A name appears only when the country is big enough on
screen to hold it, and no two names touch. Zooming in uncovers more names; panning
never makes one blink away.

**What it means for later work.** A map that carries data is drawn from the data's own
shapes. Tiles belong to maps that show where something happened, not to maps that say
what a place is.

### D12 — The world map is filled in from Wikidata, and says nothing it cannot support

**What.** Every row of the world map is read from Wikidata: the head of state, the head
of government, the party or parties in office, where that party stands on the
left–right axis, and the next election. A country whose government Wikidata cannot
place on the axis is shown as unknown, and a government that does not stand on the axis
at all is shown outside it.

**Why.** The map has to answer a political question, and it can only answer it with a
source. Wikidata is the one public source that states, for every country, who holds
which office, when their term began and ended, which party they belong to and where
that party stands — and it states it as data rather than as prose, so it can be read
again the same way tomorrow. It is also incomplete, and the incompleteness is the
point: a party that says nothing about where it stands has not been placed, and
filling that gap from Mimir's own guesses would put a claim on the map that nothing
supports. The reader has to be able to ask "where does this come from?" of every row,
and the answer has to be a place they can go and look.

**How it shows.** Each row carries the Wikidata item it was read from and the moment
it was read, and the country page shows both. The axis is Wikidata's own: a party
carries an alignment, an alignment hangs off the political spectrum as a tree, and the
narrowest point of that tree the party reaches is the one that says the most. Ideologies
are usually not on that tree, so they are read as words — a table of what each one
usually means — and where Wikidata does place an ideology on the spectrum, that
placement wins over the table. A government that says it belongs to nobody is not a
government with no position; it is a government whose position is not written down,
and it says so. A party that calls itself authoritarian, monarchist or statist is not
standing to the left or the right of anyone, and is shown outside the axis with that
said in words.

Which party is in office depends on the shape of the country. In a parliamentary
system the head of state is a figurehead, and their party is neither the government
nor a partner of it. In a presidential system the head of state governs, and the prime
minister's party sits with them. A country that calls itself both is read as
parliamentary, which is the safer of the two: a party that is only the president's is
not a government.

**What it means for later work.** The map is a reading, not an opinion. A second source
can be added — and should be, for the countries the first one is silent about — but it
is added as another reading, with its own name on the row, and never as a patch that
hides the gap.

---

## The visual language

**Colour** (light / dark)

| Meaning | Light | Dark |
|---|---|---|
| Action, link, brand | `#2a78d6` | `#3987e5` |
| Kept (a saved story) | `#8a5a00` | `#f1c46b` |
| Done, seen | `#1f7a3a` | `#7fd18f` |
| Wrong, failed | `#b3261e` | `#f08a83` |
| Waiting, caution | `#8a5a00` | `#f1c46b` |
| Context, metadata | `#77766f` | `#8f8e86` |
| World map: left end of the axis | `#6d4aa8` | `#a184e0` |
| World map: right end of the axis | `#c2681c` | `#e08a2c` |
| World map: not on the axis | `#6f6e68` | `#6a6963` |
| Page / card surface | `#fcfcfb` | `#1a1a19` |
| Page background | `#f6f6f4` | `#121211` |
| Border | `#e2e1dc` | `#2f2f2c` |

The accent is the only strong colour in the interface. Everything else is a tint of
grey, the warm gold of "kept", or the green and red of a state. A screen should never
show two accents fighting.

**Shape.** Cards and panels have an 8px radius and a 1px border, no shadow. Only
floating things (the term card, the full-screen map) have a shadow, because only they
are off the page. A button that acts on a card sits in that card's head, as a bare
glyph: no border, no circle, no background.

**Type.** The body is the browser's default at 16px. Metadata is 0.82rem and muted.
Card headlines are 1.05rem. Chips are 0.78rem. Numbers that count are tabular, so they
do not shift the line they sit in.

**Touch.** Anything a finger has to hit is at least 44px on a coarse pointer, even when
it looks smaller. A 36px glyph gets a 44px target.

**Motion.** Only two: a card that leaves a list fades and slides 8px over 200ms, and the
map expands into full screen. Nothing else moves on its own. An interface that moves
while you are reading it is an interface that has been interrupted.

---

## Rules that keep coming up

**A lane for floating controls.** A control that floats over the content gets a lane
reserved for it, so it never lies on top of the text. A floating control that hides the
thing it is about is a control that is in the wrong place.

**The headline gets the full width.** Story-card controls live below the headline.
The story detail page also keeps its controls below the headline.

**Long presses explain.** An icon button applies its action on a short tap; holding it
shows what it does. The action is never behind a hidden gesture.

**Nothing is behind a login.** There is one account, one password, and no second
surface. Anything that needs doing can be done from the dashboard on the phone.

**A word is a word.** A mark in a text knows where words begin and end. A name is only
marked where it stands on its own, and a term that the text only names inside another
word is not a term (D7).

---

## Keeping this file alive

Add an entry when a decision is made that a later feature would otherwise have to
re-derive: a new colour with a meaning, a control that floats, a way of showing that
something is waiting. Write the reason, not just the rule — the reason is what carries
to the next project.
