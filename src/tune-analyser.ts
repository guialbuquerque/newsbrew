import { analyseArticle } from "./lib/ai.ts";
import { fetchArticle } from "./lib/article.ts";
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

const startedAt = new Date().toISOString();
let sequence = 0;
let analysed = 0;
let failed = 0;

log({
  type: "run_started",
  startedAt,
  model: config.lmStudioModel,
  analyser: "two-turn-stateful-responses",
  limitPerSource: limit,
  sources: sources.map(({ id, name, url }) => ({ id, name, url })),
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
    const started = performance.now();

    try {
      const article = await fetchArticle(item.url);
      const input = `${item.headline}\n\n${item.byline}\n\n${article.text}`;
      log({ type: "article", ...candidate, input });

      const analysis = await analyseArticle(input, (turn) => {
        log({
          type: "analysis_turn",
          ...candidate,
          ...turn,
        });
      });
      analysed += 1;
      log({
        type: "analysis_completed",
        ...candidate,
        durationMs: Math.round(performance.now() - started),
        analysis,
      });
    } catch (error) {
      failed += 1;
      log({
        type: "analysis_error",
        ...candidate,
        durationMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

log({
  type: "run_completed",
  startedAt,
  completedAt: new Date().toISOString(),
  candidates: sequence,
  analysed,
  failed,
});
