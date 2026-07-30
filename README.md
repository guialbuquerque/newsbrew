# Newsbrew

A private, local-first news aggregator built with SolidStart, Solid, TypeScript,
shadcn-solid-style components, and TanStack AI. It uses an OpenAI-compatible
local model server such as LM Studio.

## What it does

1. Polls your RSS and Atom sources.
2. Sends each new headline, byline, and source through one stateful tri-state
   filter session. `YES` is clearly wanted, `MAYBE` is neutral or ambiguous,
   and `NO` is an explicit rejection. Newsbrew reads the model's active and
   maximum context lengths from LM Studio, tracks exact Responses token usage
   after every turn, and starts a fresh filter chain before the next turn would
   exceed the active window.
3. Fetches and analyses both `YES` and `MAYBE` articles. `MAYBE` stories remain
   chronologically inline with a more compact presentation; `NO` stories are
   suppressed.
4. Analyses each accepted article in a two-turn stateful session: first the
   headline, quick summary, and tags; then detailed Markdown points.
5. Combines private natural-language guidance with positive and negative topic
   signals. You can rate each story topic independently and feed those signals
   back into future filtering prompts.

Everything is stored locally under `~/.config/wes-dev/newsbrew/`. The runtime
source of truth is `news.sqlite`, accessed directly through Node's built-in
`node:sqlite` module.

## Requirements

- Node 24 or newer
- An OpenAI Responses-compatible model endpoint, such as LM Studio

## Run with npx

Once the package is published, start Newsbrew without a repository checkout or
an installed dependency tree:

```bash
npx newsbrew
```

The package ships the complete Nitro application and its runtime dependencies
inside `.output/`. By default it listens on port 3000; use `PORT` and `HOST` to
change the listener:

```bash
HOST=127.0.0.1 PORT=4321 npx newsbrew
```

From this repository, `npx .` exercises the same executable after the package
has been built. `npx newsbrew --help` prints the runtime options without
starting the app.

Runtime, model, source, topic, and authentication settings are stored in
SQLite. Access is open by default; an optional shared access token can be set
in the Settings drawer or imported with the rest of the configuration.

Settings can be imported from the default
`~/.config/wes-dev/newsbrew/newsbrew.json`, from a file selected by
`NEWSBREW_CONFIG_FILE`, or directly from the JSON stored in
`NEWSBREW_CONFIG_JSON`. Inline JSON takes precedence over a configured file.
Imports are transactional and only run again when the JSON content changes.
Relative `databaseFile` values in a settings file resolve from that file's
directory.

```bash
NEWSBREW_CONFIG_FILE=/run/secrets/newsbrew.json npx newsbrew
```

Or provide the same object directly:

```bash
NEWSBREW_CONFIG_JSON='{"runtime":{"pollIntervalMinutes":30,"maxItemsPerSource":8}}' npx newsbrew
```

Omitting `databaseFile` uses
`~/.config/wes-dev/newsbrew/news.sqlite`. A leading `~/` is also expanded in
configured paths.

## Development and settings commands

Development requires pnpm. To initialise a database or force a configuration
snapshot back into an existing database, pass its path to the import command:

```bash
pnpm settings:import -- ./newsbrew.dev.json
```

Export the current database-backed settings to the default
`~/.config/wes-dev/newsbrew/newsbrew.json`, or pass another destination:

```bash
pnpm settings:export
pnpm settings:export -- ./newsbrew.dev.json
```

Exports are written atomically with owner-only file permissions. Since access
tokens are stored as one-way hashes, export preserves one only when the
destination already contains its plaintext value; otherwise auth is omitted
instead of silently disabling an existing token.

The command validates the JSON, opens the database selected by
`databaseFile`, transactionally applies the settings, and prints a
non-sensitive import summary. `newsbrew.dev.json` is ignored by git.

See `newsbrew.example.json` for the complete structure. Set
`auth.accessToken` to a shared token or leave it as an empty string to disable
authentication. Newsbrew stores a salted token hash in SQLite and accepts the
token through the login screen or an `Authorization: Bearer` header.
Configuration files and the SQLite database should be treated as sensitive
because they may contain API keys or an access token.

## Commands

```bash
pnpm dev
pnpm ingest
pnpm tune:filter
pnpm tune:analyser
pnpm benchmark
pnpm worker
pnpm check
pnpm test
pnpm build
```

- `pnpm dev` runs the SolidStart app.
- `pnpm ingest` performs one feed scan.
- `pnpm tune:filter` fetches and judges every candidate from the enabled feeds
  through one stateful filter session, logging every `YES`, `NO`, or `MAYBE`
  result as JSONL. It is read-only: it does not add articles, mark stories as
  seen, or change topic preferences. Use `-- --limit=2` to reduce the number
  per source, or `-- --source=ars-technica` to test one source. Redirect stdout
  if you want to keep a clean JSONL log, for example
  `pnpm --silent tune:filter > filter-run.jsonl`.
- `pnpm tune:analyser` fetches full articles and runs the two-turn analyser,
  logging the exact article input, each structured model response, response ID,
  token count when provided by LM Studio, and timing as JSONL. It is also
  read-only. The same `-- --limit=2` and `-- --source=ars-technica` options
  apply. To save a clean log, use
  `pnpm --silent tune:analyser > analyser-run.jsonl`.
- `pnpm benchmark` compares downloaded local models with the production
  tri-state prompt and stateful session shape. It reads the private reader
  guidance, topic profile, and labeled reference set from ignored
  `~/.config/wes-dev/newsbrew/benchmark-*` JSON files and writes an atomic
  private report there. See `BENCHMARKING.md` before preparing or interpreting
  a run.
- `pnpm worker` scans immediately and then uses the polling interval stored in
  the database.

Both ingestion commands run TypeScript directly with Node's
`--experimental-strip-types` flag. The TypeScript configuration enables
`erasableSyntaxOnly`, and runtime imports use explicit `.ts` extensions so the
worker stays compatible with native Node type stripping.

`pnpm build` creates the self-contained `.output/` application.
`pnpm pack` runs that build before producing the npm tarball; the published
package has no runtime dependency installation because Nitro has bundled those
dependencies into the output.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the durable pipeline and session
decisions, and [BENCHMARKING.md](./BENCHMARKING.md) before comparing models or
prompts.

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
