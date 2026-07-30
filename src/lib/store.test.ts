import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Article } from "./types.ts";

test("stores ratings, skipped articles, and retained filter decisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "signal-desk-store-"));
  process.env.NEWSBREW_CONFIG_JSON = JSON.stringify({
    databaseFile: join(directory, "news.sqlite"),
    filter: {
      generalGuidance: "Imported example guidance.",
    },
  });

  try {
    const store = await import("./store.ts");
    assert.equal(
      store.readSettings().filter.generalGuidance,
      "Imported example guidance.",
    );
    assert.equal(store.accessTokenRequired(), false);
    assert.equal(store.setAccessToken("Newsbrew-Access!42"), true);
    assert.equal(store.verifyAccessToken("incorrect"), false);
    assert.equal(store.verifyAccessToken("Newsbrew-Access!42"), true);
    assert.equal(store.setAccessToken(""), false);
    assert.equal(store.accessTokenRequired(), false);

    const initialSettings = store.readSettings();
    store.updateSettings({
      pollIntervalMinutes: initialSettings.runtime.pollIntervalMinutes,
      maxItemsPerSource: initialSettings.runtime.maxItemsPerSource,
      llmBaseURL: initialSettings.llm.baseURL,
      llmModel: initialSettings.llm.model,
      generalGuidance: "Prefer detailed example reporting.",
    });
    assert.equal(
      store.readSettings().filter.generalGuidance,
      "Prefer detailed example reporting.",
    );
    assert.equal(
      store.readSettingsSnapshot().filter.generalGuidance,
      "Prefer detailed example reporting.",
    );

    await store.addSource({
      id: "example-news",
      name: "Example News",
      url: "https://example.com/feed.xml",
      enabled: true,
    });
    const article: Article = {
      id: "funding-story",
      sourceId: "example-news",
      sourceName: "Example News",
      url: "https://example.com/funding",
      headline: "Example company raises project funding",
      byline: "Alex Reporter",
      discoveredAt: new Date().toISOString(),
      topics: [
        "example company",
        "finance",
        "project delivery",
        "venture capital",
      ],
      summary: "The company is raising new capital for a project.",
      pointsMarkdown:
        "- The funding values the company at a reported amount.",
      imageUrl: "https://example.com/project.jpg",
      imageAlt: "Project",
      imageKind: "article",
      filterDecision: "yes",
      topicRatings: [],
      hidden: false,
    };

    await store.mergeArticles([article]);
    let state = await store.readState();
    assert.equal(state.articles[0]?.filterDecision, "yes");
    await store.recordTopicRatings(article.id, [
      { topic: "finance", reaction: "dislike" },
      { topic: "venture capital", reaction: "dislike" },
    ]);
    state = await store.readState();
    assert.equal(state.articles[0]?.hidden, true);
    assert.equal(state.articles[0]?.topicRatings.length, 2);

    await store.recordTopicRatings(article.id, [
      { topic: "project delivery", reaction: "like" },
      { topic: "venture capital", reaction: "dislike" },
    ]);
    state = await store.readState();
    assert.equal(state.articles[0]?.hidden, false);
    assert.equal(
      state.topicPreferences.find((item) => item.topic === "project delivery")
        ?.reaction,
      "like",
    );

    await store.mergeArticles([
      {
        ...article,
        id: "skipped-story",
        url: "https://example.com/skipped",
        skipReason: "summary_timeout",
      },
    ]);
    state = await store.readState();
    assert.equal(
      state.articles.some((item) => item.id === "skipped-story"),
      false,
    );
    assert.equal(state.seen.includes("skipped-story"), true);

    const now = new Date("2026-07-27T12:00:00.000Z");
    await store.recordFilterResult({
      url: "https://example.com/old",
      headline: "Old result",
      byline: "Old author",
      sourceName: "Old Source",
      publishedAt: "2026-04-01T00:00:00.000Z",
      decision: "no",
      filteredAt: "2026-05-01T00:00:00.000Z",
    });
    await store.recordFilterResult({
      url: "https://example.com/current",
      headline: "Current result",
      byline: "Current author",
      sourceName: "Current Source",
      publishedAt: "2026-07-27T00:00:00.000Z",
      decision: "maybe",
      filteredAt: now.toISOString(),
    });

    assert.equal(await store.deleteOldFilterResults(now), 1);
    assert.deepEqual(
      (await store.readFilterResults()).map((result) => ({
        headline: result.headline,
        byline: result.byline,
        sourceName: result.sourceName,
        decision: result.decision,
      })),
      [
        {
          headline: "Current result",
          byline: "Current author",
          sourceName: "Current Source",
          decision: "maybe",
        },
      ],
    );

    const immediateArticle: Article = {
      ...article,
      id: "immediate-story",
      url: "https://example.com/immediate",
      discoveredAt: "2026-07-30T12:00:00.000Z",
    };
    await assert.rejects(
      store.commitFilterPhase({
        filterResults: [
          {
            url: "https://example.com/filter-rollback",
            headline: "Filter phase rollback",
            byline: "Rollback author",
            sourceName: "Rollback source",
            decision: "yes",
            filteredAt: "2026-07-30T11:58:00.000Z",
          },
          {
            url: "https://example.com/filter-invalid",
            headline: "Invalid filter decision",
            byline: "Rollback author",
            sourceName: "Rollback source",
            decision: "invalid" as "yes",
            filteredAt: "2026-07-30T11:58:01.000Z",
          },
        ],
        rejectedArticleIds: ["filter-rollback-seen"],
      }),
    );
    assert.equal(
      (await store.readFilterResults()).some(
        (result) => result.url === "https://example.com/filter-rollback",
      ),
      false,
    );
    assert.equal(
      (await store.readState()).seen.includes("filter-rollback-seen"),
      false,
    );

    await store.commitFilterPhase({
      filterResults: [{
        url: immediateArticle.url,
        headline: immediateArticle.headline,
        byline: immediateArticle.byline,
        sourceName: immediateArticle.sourceName,
        decision: "yes",
        filteredAt: "2026-07-30T11:59:00.000Z",
      }],
      rejectedArticleIds: [],
    });
    await store.commitAnalysedArticle(immediateArticle);
    state = await store.readState();
    assert.equal(
      state.articles.some((item) => item.id === immediateArticle.id),
      true,
    );
    assert.equal(state.seen.includes(immediateArticle.id), true);
    assert.equal(
      (await store.readFilterResults()).some(
        (result) => result.url === immediateArticle.url,
      ),
      true,
    );

    await store.mergeArticles(
      Array.from({ length: 25 }, (_, index) => ({
        ...article,
        id: `page-story-${String(index).padStart(2, "0")}`,
        url: `https://example.com/page/${index}`,
        discoveredAt: new Date(
          Date.UTC(2026, 6, 29, 0, index),
        ).toISOString(),
      })),
    );
    const firstPage = await store.readArticlePage(20);
    assert.equal(firstPage.articles.length, 20);
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.next);
    const secondPage = await store.readArticlePage(20, firstPage.next);
    assert.equal(secondPage.articles.length >= 5, true);
    assert.equal(
      new Set([
        ...firstPage.articles.map((item) => item.id),
        ...secondPage.articles.map((item) => item.id),
      ]).size,
      firstPage.articles.length + secondPage.articles.length,
    );
    const metadataOnly = await store.readState({
      includeArticles: false,
      includeSeen: false,
    });
    assert.deepEqual(metadataOnly.articles, []);
    assert.deepEqual(metadataOnly.seen, []);

  } finally {
    delete process.env.NEWSBREW_CONFIG_JSON;
    rmSync(directory, { recursive: true, force: true });
  }
});
