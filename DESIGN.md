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

### D4 — The check in the corner marks a story seen

**What.** A check in the top-right corner of a story card and of the story page marks
the story seen. It is a bare glyph, no border, no background.

**Why.** "Seen" is a small, frequent, reversible act. It should not cost a line of
layout, and it should not be mistaken for a decision about the story. A story that
develops after being seen comes back, labelled "New development".

**What it means for later work.** Small state changes live in the corner of the thing
they change, as a bare glyph, with the state carried by the glyph itself.

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

**The corner of the page is reserved.** The top-right corner of a story card holds the
seen check. Nothing else is put there.

**Long presses explain.** An icon button applies its action on a short tap; holding it
shows what it does. The action is never behind a hidden gesture.

**Nothing is behind a login.** There is one account, one password, and no second
surface. Anything that needs doing can be done from the dashboard on the phone.

---

## Keeping this file alive

Add an entry when a decision is made that a later feature would otherwise have to
re-derive: a new colour with a meaning, a control that floats, a way of showing that
something is waiting. Write the reason, not just the rule — the reason is what carries
to the next project.
