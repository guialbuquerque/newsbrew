# Newsbrew

A private, local-first news aggregator built with SolidStart, Solid, TypeScript,
shadcn-solid-style components, and TanStack AI. It uses an OpenAI-compatible
local model server such as LM Studio.

## What it does

1. Polls your RSS and Atom sources.
2. Sends each new headline, byline, and source to your local model.
3. Keeps only stories above your interest threshold.
4. Extracts the matching article image and asks the model for a short summary
   plus 3–5 factual bullets.
5. Lets you rate each story topic independently and feeds those signals back
   into future ranking prompts.

Everything is stored locally in `data/news.sqlite` using Node's built-in
`node:sqlite` module directly.

## Requirements

- Node 24 or newer
- pnpm
- LM Studio with its local server enabled

All runtime configuration is required. The app loads `.env` from its working
directory when that file exists; otherwise it reads the same values directly
from the process environment. Process-provided values take precedence, which
allows the same configuration to work in Docker without copying a `.env`
file.

```dotenv
LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
LM_STUDIO_MODEL=lfm2.5-8b-a1b-mlx
LM_STUDIO_API_KEY=lm-studio
POLL_INTERVAL_MINUTES=30
MAX_ITEMS_PER_SOURCE=8
NEWS_DATABASE_FILE=./data/news.sqlite
```

The app throws a descriptive startup error if any value is absent or if either
numeric value is not positive. `.env.example` documents the complete contract;
the local `.env` is ignored by git.

## Commands

```bash
pnpm dev
pnpm ingest
pnpm tune:classifier
pnpm worker
pnpm check
pnpm test
pnpm build
```

- `pnpm dev` runs the SolidStart app.
- `pnpm ingest` performs one feed scan.
- `pnpm tune:classifier` fetches and judges every candidate from the enabled
  feeds, logging each candidate and complete model response as JSONL. It is
  read-only: it does not add articles, mark stories as seen, or change topic
  preferences. Use `-- --limit=2` to reduce the number per source, or
  `-- --source=ars-technica` to test one source. Redirect stdout if you want to
  keep a clean JSONL log, for example
  `pnpm --silent tune:classifier > classifier-run.jsonl`.
- `pnpm worker` scans immediately and then every
  `POLL_INTERVAL_MINUTES` minutes.

Both ingestion commands run TypeScript directly with Node's
`--experimental-strip-types` flag. The TypeScript configuration enables
`erasableSyntaxOnly`, and runtime imports use explicit `.ts` extensions so the
worker stays compatible with native Node type stripping.

## Notes

- Add local publications by pasting their RSS or Atom URL into the Sources
  panel.
- Publisher-provided article images are preferred. When one is unavailable,
  the app uses a non-generated, topic-related image at half height and labels
  it as related.
- Some publisher pages block automated reading. Those stories are skipped and
  the worker continues.
- Keep the model server bound to localhost unless you intentionally secure it.
- Respect publishers' terms and use this for personal reading.
