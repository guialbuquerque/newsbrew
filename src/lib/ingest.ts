import { fetchArticle } from "./article.ts";
import {
  analyseArticle,
  ArticleAnalysisTimeoutError,
  createArticleFilter,
} from "./ai.ts";
import { config } from "./config.ts";
import { relatedImageForTopics } from "./images.ts";
import { calculateRefreshPercent } from "./refresh-progress.ts";
import { parseFeed } from "./rss.ts";
import {
  commitAnalysedArticle,
  commitFilterPhase,
  deleteOldFilterResults,
  readState,
  recordRun,
  updateSourceStatus,
} from "./store.ts";
import type {
  Article,
  FilterDecision,
  FilterResult,
  RefreshProgress,
  Source,
} from "./types.ts";
import { stableId } from "./utils.ts";

export type IngestionOptions = {
  runId?: string;
  onProgress?: (progress: RefreshProgress) => void;
  onArticle?: (article: Article) => void;
  abortController?: AbortController;
};

type FeedItem = Awaited<ReturnType<typeof fetchFeed>>[number];
type Candidate = {
  id: string;
  source: Source;
  item: FeedItem;
};
type AcceptedCandidate = Candidate & {
  filterDecision: Exclude<FilterDecision, "no">;
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
    filters: {
      completed: 0,
      total: 0,
      accepted: 0,
      maybe: 0,
      failed: 0,
    },
    analyses: {
      completed: 0,
      total: 0,
      stored: 0,
      skipped: 0,
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
  const acceptedCandidates: AcceptedCandidate[] = [];
  const pendingFilterResults: FilterResult[] = [];
  const rejectedArticleIds: string[] = [];

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
      ? createArticleFilter(
          state.topicPreferences,
          config.filterGeneralGuidance,
          options.abortController,
        )
      : undefined;
  await filter?.ready();

  for (const candidate of candidates) {
    signal?.throwIfAborted();
    let stepFinished = false;
    const position = progress.filters.completed + 1;
    console.info(
      `[refresh] Filtering article ${position}/${progress.filters.total}: "${candidate.item.headline}"`,
    );
    try {
      const decision = await filter!.decide({
        headline: candidate.item.headline,
        byline: candidate.item.byline,
        sourceName: candidate.source.name,
      });
      signal?.throwIfAborted();
      const filterResult: FilterResult = {
        url: candidate.item.url,
        headline: candidate.item.headline,
        byline: candidate.item.byline,
        sourceName: candidate.source.name,
        publishedAt: candidate.item.publishedAt,
        decision,
        filteredAt: new Date().toISOString(),
      };
      pendingFilterResults.push(filterResult);
      console.info(
        `[refresh] Filter response ${position}/${progress.filters.total}: ${decision.toUpperCase()}`,
      );
      if (decision === "yes") {
        progress.filters.accepted += 1;
        acceptedCandidates.push({
          ...candidate,
          filterDecision: decision,
        });
      } else if (decision === "maybe") {
        progress.filters.maybe += 1;
        acceptedCandidates.push({
          ...candidate,
          filterDecision: decision,
        });
      } else {
        rejectedArticleIds.push(candidate.id);
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

  signal?.throwIfAborted();
  await commitFilterPhase({
    filterResults: pendingFilterResults,
    rejectedArticleIds,
  });

  progress.phase = "analysing";
  progress.analyses.total = acceptedCandidates.length;
  publish();

  for (const candidate of acceptedCandidates) {
    signal?.throwIfAborted();
    let stepFinished = false;
    let publisherImage: string | undefined = candidate.item.imageUrl;
    const position = progress.analyses.completed + 1;
    console.info(
      `[refresh] Analysing article ${position}/${progress.analyses.total}: "${candidate.item.headline}"`,
    );
    try {
      const article = await fetchArticle(candidate.item.url, signal);
      publisherImage ??= article.imageUrl;
      const analysis = await analyseArticle(
        `${candidate.item.headline}\n\n${candidate.item.byline}\n\n${article.text}`,
        (turn) => {
          if (turn.phase === "basics") {
            const characterCount =
              turn.output.headline.length + turn.output.summary.length;
            console.info(
              `[refresh] Analysis response (metadata): skipReason=${turn.output.skipReason ?? "none"}, ${turn.output.tags.length} tags, ${characterCount} characters`,
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
      const image = publisherImage
        ? {
            url: publisherImage,
            alt: `Image supplied with “${candidate.item.headline}”`,
            kind: "article" as const,
          }
        : relatedImageForTopics(analysis.tags);
      const analysedArticle: Article = {
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
        filterDecision: candidate.filterDecision,
        topicRatings: [],
        hidden: false,
        skipReason: analysis.skipReason ?? undefined,
      };
      await commitAnalysedArticle(analysedArticle);
      if (analysis.skipReason) {
        progress.analyses.skipped += 1;
      } else {
        progress.analyses.stored += 1;
        options.onArticle?.(analysedArticle);
      }
      stepFinished = true;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof ArticleAnalysisTimeoutError) {
        const image = publisherImage
          ? {
              url: publisherImage,
              alt: `Image supplied with “${candidate.item.headline}”`,
              kind: "article" as const,
            }
          : relatedImageForTopics([]);
        const skippedArticle: Article = {
          id: candidate.id,
          sourceId: candidate.source.id,
          sourceName: candidate.source.name,
          url: candidate.item.url,
          headline: candidate.item.headline,
          byline: candidate.item.byline,
          publishedAt: candidate.item.publishedAt,
          discoveredAt: new Date().toISOString(),
          topics: [],
          summary: error.message,
          pointsMarkdown: "",
          imageUrl: image.url,
          imageAlt: image.alt,
          imageKind: image.kind,
          filterDecision: candidate.filterDecision,
          topicRatings: [],
          hidden: false,
          skipReason: error.skipReason,
        };
        await commitAnalysedArticle(skippedArticle);
        progress.analyses.skipped += 1;
        console.warn(
          `[refresh] Skipped "${candidate.item.headline}" with reason ${error.skipReason}: ${error.message}`,
        );
      } else {
        progress.analyses.failed += 1;
        console.warn(
          `[refresh] Analysis failed for "${candidate.item.headline}": ${errorMessage(error)}`,
        );
      }
      stepFinished = true;
    } finally {
      if (stepFinished) {
        progress.analyses.completed += 1;
        publish();
      }
    }
  }

  signal?.throwIfAborted();
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
