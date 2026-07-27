import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Article } from "./types.ts";

test("stores topic ratings and hides stories rated with dislikes only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "signal-desk-store-"));
  process.env.NEWS_DATABASE_FILE = join(directory, "news.sqlite");

  try {
    const store = await import("./store.ts");
    const article: Article = {
      id: "funding-story",
      sourceId: "bbc-news",
      sourceName: "BBC News",
      url: "https://example.com/funding",
      headline: "The Boring Company raises infrastructure funding",
      byline: "Alex Reporter",
      discoveredAt: new Date().toISOString(),
      score: 92,
      reason: "Matches technology and infrastructure interests.",
      topics: [
        "Elon Musk",
        "Boring Company",
        "finance",
        "infrastructure",
        "tunnelling",
        "venture capital",
      ],
      summary: "The company is raising new capital for tunnelling projects.",
      bullets: ["The funding values the company at a reported $20 billion."],
      imageUrl: "https://example.com/tunnel.jpg",
      imageAlt: "Tunnel",
      imageKind: "article",
      topicRatings: [],
      hidden: false,
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
