import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("migrates binary filter results and boolean article skips", async () => {
  const directory = mkdtempSync(join(tmpdir(), "newsbrew-migration-"));
  const databaseFile = join(directory, "news.sqlite");
  const legacyDatabase = new DatabaseSync(databaseFile);
  legacyDatabase.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_fetched_at TEXT,
      last_error TEXT
    );
    INSERT INTO sources (id, name, url, enabled)
    VALUES ('legacy-source', 'Legacy Source', 'https://example.com/feed', 1);

    CREATE TABLE articles (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      source_name TEXT NOT NULL,
      url TEXT NOT NULL,
      headline TEXT NOT NULL,
      byline TEXT NOT NULL,
      published_at TEXT,
      discovered_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      points_markdown TEXT NOT NULL,
      image_url TEXT NOT NULL,
      image_alt TEXT NOT NULL,
      image_kind TEXT NOT NULL,
      filter_decision TEXT NOT NULL DEFAULT 'yes',
      hidden INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO articles (
      id, source_id, source_name, url, headline, byline, discovered_at,
      summary, points_markdown, image_url, image_alt, image_kind,
      filter_decision, hidden, rejected
    ) VALUES (
      'legacy-skipped', 'legacy-source', 'Legacy Source',
      'https://example.com/skipped', 'Legacy skipped article', '',
      '2026-07-01T00:00:00.000Z', 'No summary', '',
      'https://example.com/image.jpg', 'Image', 'article',
      'yes', 0, 1
    );

    CREATE TABLE filter_results (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      headline TEXT NOT NULL,
      published_at TEXT,
      included INTEGER NOT NULL CHECK (included IN (0, 1)),
      filtered_at TEXT NOT NULL
    );
    INSERT INTO filter_results
      (url, headline, included, filtered_at)
    VALUES
      ('https://example.com/yes', 'Legacy yes', 1, '2026-07-01T00:00:00.000Z'),
      ('https://example.com/no', 'Legacy no', 0, '2026-07-01T00:00:00.000Z');
  `);
  legacyDatabase.close();
  process.env.NEWSBREW_CONFIG_JSON = JSON.stringify({ databaseFile });

  try {
    const store = await import("./store.ts");
    assert.deepEqual(
      (await store.readFilterResults()).map(({ headline, decision }) => ({
        headline,
        decision,
      })),
      [
        { headline: "Legacy yes", decision: "yes" },
        { headline: "Legacy no", decision: "no" },
      ],
    );
    const state = await store.readState();
    assert.equal(
      state.articles.some((article) => article.id === "legacy-skipped"),
      false,
    );
    assert.equal(state.seen.includes("legacy-skipped"), true);
  } finally {
    delete process.env.NEWSBREW_CONFIG_JSON;
    rmSync(directory, { recursive: true, force: true });
  }
});
