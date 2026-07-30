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

    await assert.rejects(
      store.commitIngestionRun({
        filterResults: [
          {
            url: "https://example.com/rolled-back",
            headline: "Rolled back result",
            byline: "Rollback author",
            sourceName: "Rollback Source",
            decision: "yes",
            filteredAt: now.toISOString(),
          },
        ],
        seenArticleIds: ["rolled-back-seen"],
        articles: [
          {
            ...article,
            id: "invalid-article",
            sourceId: "missing-source",
            url: "https://example.com/invalid",
          },
        ],
      }),
    );
    state = await store.readState();
    assert.equal(state.seen.includes("rolled-back-seen"), false);
    assert.equal(
      (await store.readFilterResults()).some(
        (result) => result.headline === "Rolled back result",
      ),
      false,
    );
  } finally {
    delete process.env.NEWSBREW_CONFIG_JSON;
    rmSync(directory, { recursive: true, force: true });
  }
});
