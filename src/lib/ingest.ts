import { fetchArticle } from "./article.ts";
import { analyseArticle, createArticleFilter } from "./ai.ts";
import { config } from "./config.ts";
import { relatedImageForTopics } from "./images.ts";
import { parseFeed } from "./rss.ts";
import {
  markSeen,
  mergeArticles,
  readState,
  recordRun,
  updateSourceStatus,
} from "./store.ts";
import type { Article, Source } from "./types.ts";
import { stableId } from "./utils.ts";

export async function fetchFeed(source: Source) {
  const response = await fetch(source.url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; Newsbrew/0.1; personal-use)",
      Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Feed returned ${response.status}`);
  return parseFeed(await response.text());
}

export async function runIngestion() {
  const state = await readState();
  const known = new Set([
    ...state.seen,
    ...state.articles.map((article) => article.id),
  ]);
  const accepted: Article[] = [];
  const filter = createArticleFilter(state.topicPreferences);

  for (const source of state.sources.filter((item) => item.enabled)) {
    try {
      const feedItems = (await fetchFeed(source)).slice(
        0,
        config.maxItemsPerSource,
      );
      source.lastFetchedAt = new Date().toISOString();
      source.lastError = undefined;

      for (const item of feedItems) {
        const id = stableId(item.url);
        if (known.has(id)) continue;
        known.add(id);

        let included;
        try {
          included = await filter.decide({
            headline: item.headline,
            byline: item.byline,
            sourceName: source.name,
          });
        } catch (error) {
          console.warn(`Could not filter "${item.headline}":`, error);
          continue;
        }

        if (!included) {
          await markSeen(id);
          continue;
        }

        try {
          const article = await fetchArticle(item.url);
          const analysis = await analyseArticle(
            `${item.headline}\n\n${item.byline}\n\n${article.text}`,
          );
          const publisherImage = item.imageUrl ?? article.imageUrl;
          const image = publisherImage
            ? {
                url: publisherImage,
                alt: `Image supplied with “${item.headline}”`,
                kind: "article" as const,
              }
            : relatedImageForTopics(analysis.tags);
          accepted.push({
            id,
            sourceId: source.id,
            sourceName: source.name,
            url: item.url,
            headline: analysis.headline,
            byline: item.byline,
            publishedAt: item.publishedAt,
            discoveredAt: new Date().toISOString(),
            topics: analysis.tags,
            summary: analysis.summary,
            pointsMarkdown: analysis.pointsMarkdown,
            imageUrl: image.url,
            imageAlt: image.alt,
            imageKind: image.kind,
            topicRatings: [],
            hidden: false,
          });
          await markSeen(id);
        } catch (error) {
          console.warn(`Skipped analysis for "${item.headline}":`, error);
        }
      }
    } catch (error) {
      source.lastError =
        error instanceof Error ? error.message : "Unknown feed error";
    } finally {
      await updateSourceStatus(source);
    }
  }

  await mergeArticles(accepted);
  await recordRun();
  const nextState = await readState();
  return { discovered: accepted.length, state: nextState };
}

export async function runIngestionSafely() {
  try {
    return await runIngestion();
  } catch (error) {
    await recordRun(
      error instanceof Error ? error.message : "Unknown ingestion error",
    );
    throw error;
  }
}
