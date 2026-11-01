# Mimir

**A self-hosted news reader that reads the news for you, and tells you what matters.**

Mimir collects articles from as many RSS and Atom feeds as you like and ranks them
against a profile of your own interests. Articles that report the same event are grouped
into one story, so you see the story once, not twenty times. When you want to understand
a story, ask for a brief: a short, sourced summary of what happened, written on demand.

You describe what you care about in plain words, and Mimir takes it from there.

https://github.com/user-attachments/assets/cbdcc261-995a-4a2c-b643-e559c8ed61c4

## What makes it nice

- **Your own profile.** Write down your interests in plain language and edit them
  whenever you like. Every article is scored against them, and you can rescore your
  reading whenever your interests change.
- **Cheap and fast ranking.** Scoring and story matching are done by
  [Jev](https://docs.typesafe.ai), a small AI model built for exactly this kind of
  judgement. It keeps the cost of reading hundreds of articles a day low.
- **Stories, not a pile of articles.** Individual articles are grouped into stories
  automatically. A story shows its timeline, how coverage developed, and which
  publishers reported it.
- **Briefs on demand.** Open a story and ask for a Story Intelligence Brief: a summary
  with citations back to the articles, written by an AI model through a MiniMax
  subscription. Briefs are written when you ask for one, and automatically for the
  stories that matter most to you, within limits you set.
- **Unfamiliar terms, explained.** Names and concepts in a brief are tappable and
  explained in a sentence or two. Select any word in an article to add it to your own
  glossary.
- **A map for every story.** Places a story is about are pinned on a map, so you can see
  where things happen.
- **A world map.** One page that shows who governs every country, where your news is
  coming from, and who votes next.
- **As many feeds as you want.** Subscribe to anything with a feed. Mimir comes with a
  starter set, and everything else is generated for you.
- **Yours to run.** One small container and one SQLite file. No external services except
  the AI APIs, and your feeds, profile and history live on your own machine.

## What you need

- Docker with Docker Compose v2
- Optional, but it is what makes Mimir smart: a [TypeSafe](https://typesafe.ai) API key
  for Jev (ranking and stories) and a [MiniMax](https://platform.minimax.io) M Plan
  subscription key (briefs and term explanations)

Without keys Mimir still collects, stores and searches your feeds. Ranking, stories and
briefs start as soon as you add the keys.

## Quick start

```sh
git clone git@github.com:sp1r1t/mimir.git
cd mimir
cp .env.example .env
mkdir -p data
docker compose up -d --build
```

Open **http://localhost:8470**. A starter set of feeds and a default interest profile are
set up for you, and collection begins right away.

Then add your keys to `.env` and apply them with `docker compose up -d`:

```dotenv
TYPESAFE_API_KEY=your-typesafe-key
SUMMARY_PROVIDER=minimax
MINIMAX_API_KEY=your-minimax-m-plan-key
```

Finally, open **More → Interest profile** and write down what you care about.

If the container cannot write to `data/`, give it to the container user:
`sudo chown -R 1000:1000 data`.

## Learn more

- [Configuration](docs/configuration.md): keys, models, limits, and every setting
- [Using Mimir](docs/using-mimir.md): stories, briefs, the map, the glossary
- [Operation and troubleshooting](docs/operations.md): backups, upgrades, recovery
- [Development](docs/development.md): building, testing, and where the code lives
- [DESIGN.md](DESIGN.md): the rules the interface follows, and why

## License

[MIT](LICENSE)
