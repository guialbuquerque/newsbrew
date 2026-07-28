import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Article } from "./types.ts";

test("stores ratings, rejected articles, and retained filter decisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "signal-desk-store-"));
  process.env.NEWSBREW_CONFIG_JSON = JSON.stringify({
    databaseFile: join(directory, "news.sqlite"),
  });

  try {
    const store = await import("./store.ts");
    assert.equal(store.accessTokenRequired(), false);
    assert.equal(store.setAccessToken("Newsbrew-Access!42"), true);
    assert.equal(store.verifyAccessToken("incorrect"), false);
    assert.equal(store.verifyAccessToken("Newsbrew-Access!42"), true);
    assert.equal(store.setAccessToken(""), false);
    assert.equal(store.accessTokenRequired(), false);

    const article: Article = {
      id: "funding-story",
      sourceId: "bbc-news",
      sourceName: "BBC News",
      url: "https://example.com/funding",
      headline: "The Boring Company raises infrastructure funding",
      byline: "Alex Reporter",
      discoveredAt: new Date().toISOString(),
      topics: [
        "Elon Musk",
        "Boring Company",
        "finance",
        "infrastructure",
        "tunnelling",
        "venture capital",
      ],
      summary: "The company is raising new capital for tunnelling projects.",
      pointsMarkdown:
        "- The funding values the company at a reported $20 billion.",
      imageUrl: "https://example.com/tunnel.jpg",
      imageAlt: "Tunnel",
      imageKind: "article",
      topicRatings: [],
      hidden: false,
      rejected: false,
    };

    await store.mergeArticles([article]);
    await store.recordTopicRatings(article.id, [
      { topic: "finance", reaction: "dislike" },
      { topic: "venture capital", reaction: "dislike" },
    ]);
    let state = await store.readState();
    assert.equal(state.articles[0]?.hidden, true);
    assert.equal(state.articles[0]?.topicRatings.length, 2);

    await store.recordTopicRatings(article.id, [
      { topic: "infrastructure", reaction: "like" },
      { topic: "venture capital", reaction: "dislike" },
    ]);
    state = await store.readState();
    assert.equal(state.articles[0]?.hidden, false);
    assert.equal(
      state.topicPreferences.find((item) => item.topic === "infrastructure")
        ?.reaction,
      "like",
    );

    await store.mergeArticles([
      {
        ...article,
        id: "rejected-story",
        url: "https://example.com/rejected",
        rejected: true,
      },
    ]);
    state = await store.readState();
    assert.equal(
      state.articles.some((item) => item.id === "rejected-story"),
      false,
    );
    assert.equal(state.seen.includes("rejected-story"), true);

    const now = new Date("2026-07-27T12:00:00.000Z");
    await store.recordFilterResult({
      url: "https://example.com/old",
      headline: "Old result",
      publishedAt: "2026-04-01T00:00:00.000Z",
      included: false,
      filteredAt: "2026-05-01T00:00:00.000Z",
    });
    await store.recordFilterResult({
      url: "https://example.com/current",
      headline: "Current result",
      publishedAt: "2026-07-27T00:00:00.000Z",
      included: true,
      filteredAt: now.toISOString(),
    });

    assert.equal(await store.deleteOldFilterResults(now), 1);
    assert.deepEqual(
      (await store.readFilterResults()).map((result) => ({
        headline: result.headline,
        included: result.included,
      })),
      [{ headline: "Current result", included: true }],
    );

    await assert.rejects(
      store.commitIngestionRun({
        filterResults: [
          {
            url: "https://example.com/rolled-back",
            headline: "Rolled back result",
            included: true,
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
