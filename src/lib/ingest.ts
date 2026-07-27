import { fetchArticle } from "./article.ts";
import { analyseArticle, createArticleFilter } from "./ai.ts";
import { config } from "./config.ts";
import { relatedImageForTopics } from "./images.ts";
import { calculateRefreshPercent } from "./refresh-progress.ts";
import { parseFeed } from "./rss.ts";
import {
  commitIngestionRun,
  deleteOldFilterResults,
  readState,
  recordRun,
  updateSourceStatus,
} from "./store.ts";
import type {
  Article,
  FilterResult,
  RefreshProgress,
  Source,
} from "./types.ts";
import { stableId } from "./utils.ts";

export type IngestionOptions = {
  runId?: string;
  onProgress?: (progress: RefreshProgress) => void;
  abortController?: AbortController;
};

type FeedItem = Awaited<ReturnType<typeof fetchFeed>>[number];
type Candidate = {
  id: string;
  source: Source;
  item: FeedItem;
};

export async function fetchFeed(source: Source, signal?: AbortSignal) {
  const response = await fetch(source.url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; Newsbrew/0.1; personal-use)",
      Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml",
    },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Feed returned ${response.status}`);
  return parseFeed(await response.text());
}

function initialProgress(
  runId: string | undefined,
  sourceTotal: number,
): RefreshProgress {
  return {
    runId,
    status: "running",
    phase: "downloading",
    percent: 0,
    startedAt: new Date().toISOString(),
    sources: { completed: 0, total: sourceTotal, failed: 0 },
    filters: { completed: 0, total: 0, accepted: 0, failed: 0 },
    analyses: {
      completed: 0,
      total: 0,
      stored: 0,
      rejected: 0,
      failed: 0,
    },
  };
}

function cloneProgress(progress: RefreshProgress): RefreshProgress {
  return {
    ...progress,
    sources: { ...progress.sources },
    filters: { ...progress.filters },
    analyses: { ...progress.analyses },
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function runIngestion(options: IngestionOptions = {}) {
  const state = await readState();
  const enabledSources = state.sources.filter((source) => source.enabled);
  const progress = initialProgress(options.runId, enabledSources.length);
  const publish = () => {
    progress.percent = Math.max(
      0,
      Math.min(100, calculateRefreshPercent(progress)),
    );
    options.onProgress?.(cloneProgress(progress));
  };
  const signal = options.abortController?.signal;
  const known = new Set([
    ...state.seen,
    ...state.articles.map((article) => article.id),
  ]);
  const candidates: Candidate[] = [];
  const acceptedCandidates: Candidate[] = [];
  const analysedArticles: Article[] = [];
  const pendingFilterResults: FilterResult[] = [];
  const pendingSeenArticleIds: string[] = [];

  await deleteOldFilterResults();
  publish();

  for (const source of enabledSources) {
    signal?.throwIfAborted();
    let stepFinished = false;
    try {
      const feedItems = (await fetchFeed(source, signal)).slice(
        0,
        config.maxItemsPerSource,
      );
      signal?.throwIfAborted();
      let newItems = 0;
      for (const item of feedItems) {
        const id = stableId(item.url);
        if (known.has(id)) continue;
        known.add(id);
        newItems += 1;
        candidates.push({ id, source, item });
      }
      source.lastFetchedAt = new Date().toISOString();
      source.lastError = undefined;
      console.info(
        `[refresh] Downloaded source ${progress.sources.completed + 1}/${progress.sources.total}: "${source.name}" (${feedItems.length} items, ${newItems} new)`,
      );
      stepFinished = true;
    } catch (error) {
      if (signal?.aborted) throw error;
      progress.sources.failed += 1;
      source.lastError =
        error instanceof Error ? error.message : "Unknown feed error";
      console.warn(
        `[refresh] Could not download source "${source.name}": ${source.lastError}`,
      );
      stepFinished = true;
    } finally {
      if (stepFinished) {
        progress.sources.completed += 1;
        await updateSourceStatus(source);
        publish();
      }
    }
  }

  progress.phase = "filtering";
  progress.filters.total = candidates.length;
  publish();
  const filter =
    candidates.length > 0
      ? createArticleFilter(state.topicPreferences, options.abortController)
      : undefined;

  for (const candidate of candidates) {
    signal?.throwIfAborted();
    let stepFinished = false;
    const position = progress.filters.completed + 1;
    console.info(
      `[refresh] Filtering article ${position}/${progress.filters.total}: "${candidate.item.headline}"`,
    );
    try {
      const included = await filter!.decide({
        headline: candidate.item.headline,
        byline: candidate.item.byline,
        sourceName: candidate.source.name,
      });
      signal?.throwIfAborted();
      pendingFilterResults.push({
        url: candidate.item.url,
        headline: candidate.item.headline,
        publishedAt: candidate.item.publishedAt,
        included,
        filteredAt: new Date().toISOString(),
      });
      console.info(
        `[refresh] Filter response ${position}/${progress.filters.total}: ${included ? "YES" : "NO"}`,
      );
      if (included) {
        progress.filters.accepted += 1;
        acceptedCandidates.push(candidate);
      } else {
        pendingSeenArticleIds.push(candidate.id);
      }
      stepFinished = true;
    } catch (error) {
      if (signal?.aborted) throw error;
      progress.filters.failed += 1;
      console.warn(
        `[refresh] Could not filter "${candidate.item.headline}": ${errorMessage(error)}`,
      );
      stepFinished = true;
    } finally {
      if (stepFinished) {
        progress.filters.completed += 1;
        publish();
      }
    }
  }

  progress.phase = "analysing";
  progress.analyses.total = acceptedCandidates.length;
  publish();

  for (const candidate of acceptedCandidates) {
    signal?.throwIfAborted();
    let stepFinished = false;
    const position = progress.analyses.completed + 1;
    console.info(
      `[refresh] Analysing article ${position}/${progress.analyses.total}: "${candidate.item.headline}"`,
    );
    try {
      const article = await fetchArticle(candidate.item.url, signal);
      const analysis = await analyseArticle(
        `${candidate.item.headline}\n\n${candidate.item.byline}\n\n${article.text}`,
        (turn) => {
          if (turn.phase === "basics") {
            const characterCount =
              turn.output.headline.length + turn.output.summary.length;
            console.info(
              `[refresh] Analysis response (metadata): rejected=${turn.output.rejected}, ${turn.output.tags.length} tags, ${characterCount} characters`,
            );
          } else {
            console.info(
              `[refresh] Analysis response (points): ${turn.output.length} characters`,
            );
          }
        },
        options.abortController,
      );
      signal?.throwIfAborted();
      const publisherImage = candidate.item.imageUrl ?? article.imageUrl;
      const image = publisherImage
        ? {
            url: publisherImage,
            alt: `Image supplied with “${candidate.item.headline}”`,
            kind: "article" as const,
          }
        : relatedImageForTopics(analysis.tags);
      analysedArticles.push({
        id: candidate.id,
        sourceId: candidate.source.id,
        sourceName: candidate.source.name,
        url: candidate.item.url,
        headline: analysis.headline,
        byline: candidate.item.byline,
        publishedAt: candidate.item.publishedAt,
        discoveredAt: new Date().toISOString(),
        topics: analysis.tags,
        summary: analysis.summary,
        pointsMarkdown: analysis.pointsMarkdown,
        imageUrl: image.url,
        imageAlt: image.alt,
        imageKind: image.kind,
        topicRatings: [],
        hidden: false,
        rejected: analysis.rejected,
      });
      if (analysis.rejected) {
        progress.analyses.rejected += 1;
      } else {
        progress.analyses.stored += 1;
      }
      pendingSeenArticleIds.push(candidate.id);
      stepFinished = true;
    } catch (error) {
      if (signal?.aborted) throw error;
      progress.analyses.failed += 1;
      console.warn(
        `[refresh] Skipped analysis for "${candidate.item.headline}": ${errorMessage(error)}`,
      );
      stepFinished = true;
    } finally {
      if (stepFinished) {
        progress.analyses.completed += 1;
        publish();
      }
    }
  }

  signal?.throwIfAborted();
  await commitIngestionRun({
    filterResults: pendingFilterResults,
    seenArticleIds: pendingSeenArticleIds,
    articles: analysedArticles,
  });
  await deleteOldFilterResults();
  await recordRun();
  progress.status = "completed";
  progress.phase = "completed";
  progress.completedAt = new Date().toISOString();
  publish();
  const nextState = await readState();
  return { discovered: progress.analyses.stored, state: nextState };
}

export async function runIngestionSafely(options: IngestionOptions = {}) {
  try {
    return await runIngestion(options);
  } catch (error) {
    if (options.abortController?.signal.aborted) throw error;
    await recordRun(
      error instanceof Error ? error.message : "Unknown ingestion error",
    );
    throw error;
  }
}
