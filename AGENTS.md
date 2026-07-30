# Newsbrew agent instructions

- Read `ARCHITECTURE.md` before changing the AI, ingestion, refresh, authentication, or storage paths. Read `BENCHMARKING.md` before running or changing model evaluations.
- Newsbrew is unreleased. Do not add database migration logic, compatibility branches, legacy schema fields, or migration tests.
- When the SQLite schema changes, update the canonical `CREATE TABLE` definitions and directly mutate `~/.config/wes-dev/newsbrew/news.sqlite` during the same task. Preserve relevant local data and verify the resulting schema.
- When database-backed settings or their import/export shape changes, also
  update `~/.config/wes-dev/newsbrew/newsbrew.json` and
  `~/.config/wes-dev/newsbrew/newsbrew.dev.json` when they exist. Preserve
  their file-specific values and secrets, write them with owner-only
  permissions, and validate them against the current configuration schema.
- Persist the exact inputs needed to audit classifier decisions. `filter_results` includes the URL, headline, byline, source name, publication time, decision, and filtering time.
- Preserve the stateful OpenAI Responses design: stored responses, `previous_response_id`, exact usage metadata, and context-aware filter-session rollover are intentional. Do not replace it with Chat Completions, stateless message replay, provider switching, or provider-specific branches without an explicit product decision.
- Preserve tri-state semantics end to end: `YES` is clearly wanted, `MAYBE` is neutral or ambiguous and remains in the feed with compact treatment, and `NO` is an explicit rejection. Do not collapse neutral stories into negative preference evidence.
- Keep filtering atomic: stage every filter result and explicit `NO` seen ID,
  and commit that phase only after all filtering succeeds. Afterward, commit
  each analysed article and its seen ID independently so completed analyses
  survive a later stop or failure.
- Store tests must set `NEWSBREW_CONFIG_JSON` to a temporary database before importing `store.ts`. Never let tests open `~/.config/wes-dev/newsbrew/news.sqlite`, and check the live database for exact fixture contamination if isolation fails.
- Before explaining a missing or changed file, inspect staged changes, unstaged changes, untracked files, and relevant Git stashes. Do not attribute it to concurrent work without evidence.
- Treat SQLite data, settings exports, tuning JSONL, benchmark configs,
  reference sets, reports, and server logs as sensitive local artifacts. Keep
  benchmark artifacts under `~/.config/wes-dev/newsbrew/benchmark-*`; never
  put a reader's identity, machine paths, credentials, preferences, or labeled
  headlines in tracked code or documentation.
- Never start the development, preview, production, or worker server. Ask the user to restart a running process manually after runtime code changes.
