# Newsbrew architecture

This document records product and implementation decisions that have been
revisited across multiple development sessions. Change them deliberately, not
as incidental refactors.

## Ingestion pipeline

1. Download enabled RSS and Atom feeds. Preserve the candidate URL, headline,
   byline, source name, publication time, and publisher image.
2. Judge new candidates in one stateful filter session using only the
   headline, byline, source, and current positive/negative topic preferences.
3. Interpret the filter labels as:
   - `YES`: clearly wanted.
   - `MAYBE`: neutral, ambiguous, or insufficiently interesting, but not an
     explicit rejection.
   - `NO`: explicitly unwanted.
4. Fetch and analyse the full article for both `YES` and `MAYBE`. Suppress
   `NO` and mark it seen.
5. Analyse each accepted article in its own two-turn stateful session:
   structured headline/summary/tags first, then raw Markdown factual points.
6. Persist successful filter decisions for auditing and retain them for two
   months.

`MAYBE` stays chronologically inline in the feed with a compact visual
treatment. It is not a hidden rejection queue.

The source name is a weak contextual signal that can disambiguate a review,
podcast, reader callout, or announcement. It must not become a shortcut for
publisher reputation or override the headline's central treatment.

## LLM session design

Newsbrew intentionally targets an OpenAI Responses-compatible endpoint rather
than general OpenAI compatibility.

- TanStack AI uses the Responses adapter with `store: true`.
- Filter turns continue through `previous_response_id`, avoiding replay of the
  full conversation.
- Response IDs and exact token usage are captured from response metadata.
- The filter starts a fresh chain before the next ordinary turn could exceed
  the model-reported active context window.
- Filter reasoning is disabled because the output is a compact preference
  label.
- Automatic transport retries remain disabled so response metadata cannot be
  paired with the wrong request.

The analyser treats downloaded article text as untrusted content. Its first
turn must match the structured schema; its second turn is stored directly as
`pointsMarkdown` without converting it to a legacy bullet-array shape.

Each analysis attempt has one 60-second timeout and a 15,000-output-token
budget shared across both turns. A timeout retries once in a fresh session with
reasoning disabled. A second timeout becomes `summary_timeout`; ordinary
transient failures remain retryable on a later refresh.

The configured model is checked once before filtering. If absent, Newsbrew asks
LM Studio to load it and fails the refresh at preflight if that cannot be done;
it must not repeat the same model-availability error for every candidate.

## Refresh and persistence

The refresh endpoint starts work in the shared Nitro server runtime and returns
immediately. The HTTP route and WebSocket status route must share the same
refresh controller; verify both routes are present in the production build
after route or Vite/Nitro changes.

Progress is weighted by phase:

- Feed download: 0–10%
- Headline filtering: 10–40%
- Article analysis: 40–100%

One abort controller is threaded through feed downloads, article extraction,
model context lookup, filter turns, and analyser turns.

Filter results, seen IDs, and analysed articles are accumulated in memory and
committed in one SQLite transaction after the complete run. Stopping before
that commit discards the pending ingestion rows while preserving completed
earlier refreshes.

SQLite is used directly through Node's `node:sqlite`; there is no ORM or storage
abstraction. The project is unreleased, so schema changes update the canonical
table definitions and the local database directly rather than adding runtime
migrations.

Persistent local state is independent of the install or working directory.
The default database, settings snapshot, and private benchmark artifacts live
under `~/.config/wes-dev/newsbrew/`. Relative `databaseFile` values in a
settings file resolve from that settings file's directory; inline settings
continue to resolve relative paths from the current working directory.

`filter_results` stores the exact auditable classifier inputs:

- URL
- Headline
- Byline
- Source name
- Publication time
- Decision
- Filtering time

Current filter rows do not record the model or a prompt/version fingerprint.
Historical audits therefore must not assume every row was produced by the
currently configured model or prompt.

## Preferences and feedback

General guidance and topic lists are private reader data stored in SQLite or
an ignored configuration file. Do not seed a personal preference profile in
tracked code. The classifier reads the natural-language guidance before the
positive and negative topic lists, then treats those topic signals
directionally and judges the central subject and treatment rather than keyword
presence.

Keep neutral/not-interesting stories separate from explicit rejects. Only an
explicit dislike selected by the user should become negative preference
evidence.

Topic ratings are per topic, not merely per article. A rating containing only
dislikes hides the article; otherwise the article remains visible.

## Configuration and authentication

SQLite is the runtime source of truth, including filter guidance. The default
`~/.config/wes-dev/newsbrew/newsbrew.json`, `NEWSBREW_CONFIG_FILE`, and
`NEWSBREW_CONFIG_JSON` are bootstrap/import paths.
The worker reloads database-backed runtime settings between polling runs.

A blank access token disables authentication. A configured token is stored as
a salted scrypt hash, successful login creates an HTTP-only session cookie, and
API clients may use a Bearer token. Changing the token invalidates existing
sessions. Authentication must cover state-changing HTTP routes and refresh
WebSocket upgrades.

Settings exports are atomic and owner-only. Because the database stores only a
token hash, an export may preserve plaintext only when the destination file
already contains it; otherwise it must omit auth rather than silently disable
protection.

## Feed and presentation details

RSS parsing supports both RSS and namespaced Atom feeds, including attributed
Atom text constructs such as `<title type="html">` and `rel="alternate"`
links.

Article images are never generated. Prefer publisher-provided images; otherwise
use a topic-related image, label it as related, and render it at reduced height.
