import { createArticleFilter, ModelResponseError } from "./lib/ai.ts";
import { config } from "./lib/config.ts";
import { fetchFeed } from "./lib/ingest.ts";
import { readState } from "./lib/store.ts";

function option(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(
    prefix.length,
  );
}

function log(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const requestedLimit = Number(option("limit"));
const limit =
  Number.isInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : config.maxItemsPerSource;
const requestedSource = option("source");
const state = await readState();
const sources = state.sources.filter(
  (source) =>
    source.enabled && (!requestedSource || source.id === requestedSource),
);

if (sources.length === 0) {
  throw new Error(
    requestedSource
      ? `No enabled source has id "${requestedSource}"`
      : "No sources are enabled",
  );
}

const filter = createArticleFilter(state.topicPreferences);
const startedAt = new Date().toISOString();
let sequence = 0;
let judged = 0;
let failed = 0;

log({
  type: "run_started",
  startedAt,
  model: config.lmStudioModel,
  session: "stateful-responses",
  limitPerSource: limit,
  sources: sources.map(({ id, name, url }) => ({ id, name, url })),
  topicPreferences: state.topicPreferences,
  note: "This command does not modify articles, topic preferences, or seen state.",
});

for (const source of sources) {
  let items;
  try {
    items = (await fetchFeed(source)).slice(0, limit);
  } catch (error) {
    failed += 1;
    log({
      type: "source_error",
      source: { id: source.id, name: source.name, url: source.url },
      error: error instanceof Error ? error.message : String(error),
    });
    continue;
  }

  for (const item of items) {
    sequence += 1;
    const candidate = {
      sequence,
      sourceId: source.id,
      sourceName: source.name,
      headline: item.headline,
      byline: item.byline,
      url: item.url,
      publishedAt: item.publishedAt,
    };
    log({ type: "candidate", ...candidate });

    const started = performance.now();
    try {
      const decision = await filter.decide({
        headline: item.headline,
        byline: item.byline,
        sourceName: source.name,
      });
      judged += 1;
      log({
        type: "judgement",
        ...candidate,
        durationMs: Math.round(performance.now() - started),
        result: decision.toUpperCase(),
        context: filter.lastTurn(),
      });
    } catch (error) {
      failed += 1;
      log({
        type: "judgement_error",
        ...candidate,
        durationMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
        rawOutput:
          error instanceof ModelResponseError ? error.rawOutput : undefined,
        context: filter.lastTurn(),
      });
    }
  }
}

log({
  type: "run_completed",
  startedAt,
  completedAt: new Date().toISOString(),
  candidates: sequence,
  judged,
  failed,
});
