import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import type {
  AppState,
  Article,
  FilterResult,
  Reaction,
  Source,
  TopicPreference,
  TopicRating,
} from "./types.ts";

const seededTopicPreferences: TopicPreference[] = [
  "AI",
  "foundation models",
  "open-source AI",
  "AI agents",
  "AI security",
  "developer tools",
  "technology economics",
  "technology policy",
  "privacy",
  "competition",
  "Apple",
  "UK news",
  "London news",
  "transport",
  "housing",
  "immigration",
  "trade",
  "infrastructure",
  "geopolitics",
  "public policy",
  "climate science",
  "space",
  "computing",
  "emerging technology",
  "arts and culture",
].map((topic) => ({ topic, reaction: "like", source: "perplexity" }));

seededTopicPreferences.push(
  ...[
    "sports results",
    "celebrity gossip",
    "generic market news",
    "ordinary corporate earnings",
    "outrage bait",
    "political soundbites",
    "unverified rumours",
    "incremental war updates",
    "unsupported product speculation",
    "personal scandals",
  ].map(
    (topic): TopicPreference => ({
      topic,
      reaction: "dislike",
      source: "perplexity",
    }),
  ),
);

mkdirSync(dirname(config.databaseFile), { recursive: true });
const database = new DatabaseSync(config.databaseFile);
database.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fetched_at TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS articles (
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
    image_kind TEXT NOT NULL CHECK (image_kind IN ('article', 'related')),
    hidden INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS article_topics (
    article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    topic_key TEXT NOT NULL,
    topic TEXT NOT NULL,
    PRIMARY KEY (article_id, topic_key)
  );

  CREATE TABLE IF NOT EXISTS topic_preferences (
    topic_key TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    reaction TEXT NOT NULL CHECK (reaction IN ('like', 'dislike')),
    source TEXT NOT NULL CHECK (source IN ('perplexity', 'rating')),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS article_topic_ratings (
    article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    topic_key TEXT NOT NULL,
    topic TEXT NOT NULL,
    reaction TEXT NOT NULL CHECK (reaction IN ('like', 'dislike')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (article_id, topic_key)
  );

  CREATE TABLE IF NOT EXISTS seen_articles (
    article_id TEXT PRIMARY KEY,
    seen_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS filter_results (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL,
    headline TEXT NOT NULL,
    published_at TEXT,
    included INTEGER NOT NULL CHECK (included IN (0, 1)),
    filtered_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS articles_discovered_at
    ON articles(discovered_at DESC);
  CREATE INDEX IF NOT EXISTS ratings_created_at
    ON article_topic_ratings(created_at DESC);
  CREATE INDEX IF NOT EXISTS filter_results_filtered_at
    ON filter_results(filtered_at DESC);
`);

const articleColumns = database
  .prepare("PRAGMA table_info(articles)")
  .all() as Array<{ name: string }>;
if (!articleColumns.some((column) => column.name === "rejected")) {
  database.exec(
    "ALTER TABLE articles ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0",
  );
}

function topicKey(topic: string) {
  return topic.trim().toLocaleLowerCase("en-GB").replace(/\s+/g, " ");
}

function seedTopicPreferences() {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO topic_preferences
      (topic_key, topic, reaction, source, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const preference of seededTopicPreferences) {
    insert.run(
      topicKey(preference.topic),
      preference.topic,
      preference.reaction,
      preference.source,
      now,
    );
  }
}

function insertSource(source: Source) {
  database
    .prepare(`
      INSERT INTO sources
        (id, name, url, enabled, last_fetched_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        url = excluded.url,
        enabled = excluded.enabled,
        last_fetched_at = excluded.last_fetched_at,
        last_error = excluded.last_error
    `)
    .run(
      source.id,
      source.name,
      source.url,
      source.enabled ? 1 : 0,
      source.lastFetchedAt ?? null,
      source.lastError ?? null,
    );
}

function insertArticle(article: Article) {
  database
    .prepare(`
      INSERT INTO articles (
        id, source_id, source_name, url, headline, byline, published_at,
        discovered_at, summary, points_markdown, image_url, image_alt,
        image_kind, hidden, rejected
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_name = excluded.source_name,
        url = excluded.url,
        headline = excluded.headline,
        byline = excluded.byline,
        published_at = excluded.published_at,
        summary = excluded.summary,
        points_markdown = excluded.points_markdown,
        image_url = excluded.image_url,
        image_alt = excluded.image_alt,
        image_kind = excluded.image_kind,
        rejected = excluded.rejected
    `)
    .run(
      article.id,
      article.sourceId,
      article.sourceName,
      article.url,
      article.headline,
      article.byline,
      article.publishedAt ?? null,
      article.discoveredAt,
      article.summary,
      article.pointsMarkdown,
      article.imageUrl,
      article.imageAlt,
      article.imageKind,
      article.hidden ? 1 : 0,
      article.rejected ? 1 : 0,
    );

  database
    .prepare("DELETE FROM article_topics WHERE article_id = ?")
    .run(article.id);
  const insertTopic = database.prepare(`
    INSERT INTO article_topics (article_id, position, topic_key, topic)
    VALUES (?, ?, ?, ?)
  `);
  article.topics.forEach((topic, position) => {
    insertTopic.run(article.id, position, topicKey(topic), topic);
  });
}

function initializeData() {
  const row = database.prepare("SELECT COUNT(*) AS count FROM sources").get() as {
    count: number;
  };
  if (row.count > 0) {
    seedTopicPreferences();
    return;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const sources: Source[] = [
      {
        id: "bbc-news",
        name: "BBC News",
        url: "https://feeds.bbci.co.uk/news/rss.xml",
        enabled: true,
      },
      {
        id: "guardian-uk",
        name: "The Guardian · UK",
        url: "https://www.theguardian.com/uk-news/rss",
        enabled: true,
      },
      {
        id: "ars-technica",
        name: "Ars Technica",
        url: "https://feeds.arstechnica.com/arstechnica/index",
        enabled: true,
      },
    ];
    sources.forEach(insertSource);
    seedTopicPreferences();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

initializeData();

export async function readState(): Promise<AppState> {
  const sources = database
    .prepare(`
      SELECT id, name, url, enabled, last_fetched_at AS lastFetchedAt,
        last_error AS lastError
      FROM sources ORDER BY rowid
    `)
    .all()
    .map((row) => ({
      ...(row as Omit<Source, "enabled"> & { enabled: number }),
      enabled: Boolean((row as { enabled: number }).enabled),
    }));

  const articleRows = database
    .prepare(`
      SELECT id, source_id AS sourceId, source_name AS sourceName, url,
        headline, byline, published_at AS publishedAt,
        discovered_at AS discoveredAt, summary,
        points_markdown AS pointsMarkdown,
        image_url AS imageUrl, image_alt AS imageAlt,
        image_kind AS imageKind, hidden, rejected
      FROM articles
      WHERE rejected = 0
      ORDER BY discovered_at DESC LIMIT 250
    `)
    .all() as Array<
    Omit<Article, "topics" | "topicRatings" | "hidden" | "rejected"> & {
      hidden: number;
      rejected: number;
    }
  >;

  const topics = database
    .prepare(`
      SELECT article_id AS articleId, topic
      FROM article_topics ORDER BY article_id, position
    `)
    .all() as Array<{ articleId: string; topic: string }>;
  const ratings = database
    .prepare(`
      SELECT article_id AS articleId, topic, reaction
      FROM article_topic_ratings ORDER BY article_id, created_at
    `)
    .all() as Array<{ articleId: string; topic: string; reaction: Reaction }>;

  const topicsByArticle = new Map<string, string[]>();
  for (const row of topics) {
    topicsByArticle.set(row.articleId, [
      ...(topicsByArticle.get(row.articleId) ?? []),
      row.topic,
    ]);
  }
  const ratingsByArticle = new Map<string, TopicRating[]>();
  for (const row of ratings) {
    ratingsByArticle.set(row.articleId, [
      ...(ratingsByArticle.get(row.articleId) ?? []),
      { topic: row.topic, reaction: row.reaction },
    ]);
  }

  const articles: Article[] = articleRows.map((row) => ({
    ...row,
    hidden: Boolean(row.hidden),
    rejected: Boolean(row.rejected),
    topics: topicsByArticle.get(row.id) ?? [],
    topicRatings: ratingsByArticle.get(row.id) ?? [],
  }));

  const topicPreferences = database
    .prepare(`
      SELECT topic, reaction, source
      FROM topic_preferences
      ORDER BY reaction, updated_at DESC, topic
    `)
    .all() as TopicPreference[];

  const recentSeen = database
    .prepare(`
      SELECT article_id AS articleId
      FROM seen_articles ORDER BY seen_at DESC LIMIT 2000
    `)
    .all()
    .map((row) => String((row as { articleId: string }).articleId));
  const rejectedArticleIds = database
    .prepare("SELECT id FROM articles WHERE rejected = 1")
    .all()
    .map((row) => String((row as { id: string }).id));
  const seen = [...new Set([...recentSeen, ...rejectedArticleIds])];

  const metadata = Object.fromEntries(
    (
      database
        .prepare("SELECT key, value FROM app_meta")
        .all() as Array<{ key: string; value: string | null }>
    ).map((row) => [row.key, row.value]),
  );

  return {
    sources,
    articles,
    seen,
    topicPreferences,
    lastRunAt: metadata.lastRunAt ?? undefined,
    lastRunError: metadata.lastRunError ?? undefined,
  };
}

export async function addSource(source: Source) {
  insertSource(source);
  return readState();
}

export async function removeSource(id: string) {
  database.prepare("DELETE FROM sources WHERE id = ?").run(id);
  return readState();
}

export async function recordTopicRatings(
  articleId: string,
  ratings: TopicRating[],
) {
  const article = database
    .prepare("SELECT id FROM articles WHERE id = ?")
    .get(articleId);
  if (!article) return null;

  const validTopics = new Map(
    (
      database
        .prepare(`
          SELECT topic_key AS topicKey, topic
          FROM article_topics WHERE article_id = ?
        `)
        .all(articleId) as Array<{ topicKey: string; topic: string }>
    ).map((item) => [item.topicKey, item.topic]),
  );
  const selected = ratings
    .map((rating) => ({
      topic: validTopics.get(topicKey(rating.topic)),
      reaction: rating.reaction,
    }))
    .filter(
      (rating): rating is TopicRating =>
        Boolean(rating.topic) &&
        (rating.reaction === "like" || rating.reaction === "dislike"),
    );
  const hidden =
    selected.length > 0 &&
    selected.every((rating) => rating.reaction === "dislike");
  const now = new Date().toISOString();

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("DELETE FROM article_topic_ratings WHERE article_id = ?")
      .run(articleId);
    const insertRating = database.prepare(`
      INSERT INTO article_topic_ratings
        (article_id, topic_key, topic, reaction, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const upsertPreference = database.prepare(`
      INSERT INTO topic_preferences
        (topic_key, topic, reaction, source, updated_at)
      VALUES (?, ?, ?, 'rating', ?)
      ON CONFLICT(topic_key) DO UPDATE SET
        topic = excluded.topic,
        reaction = excluded.reaction,
        source = excluded.source,
        updated_at = excluded.updated_at
    `);
    for (const rating of selected) {
      const key = topicKey(rating.topic);
      insertRating.run(articleId, key, rating.topic, rating.reaction, now);
      upsertPreference.run(key, rating.topic, rating.reaction, now);
    }
    database
      .prepare("UPDATE articles SET hidden = ? WHERE id = ?")
      .run(hidden ? 1 : 0, articleId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return readState();
}

export async function markSeen(id: string) {
  database
    .prepare(`
      INSERT OR IGNORE INTO seen_articles (article_id, seen_at) VALUES (?, ?)
    `)
    .run(id, new Date().toISOString());
  database.exec(`
    DELETE FROM seen_articles
    WHERE article_id NOT IN (
      SELECT article_id FROM seen_articles ORDER BY seen_at DESC LIMIT 2000
    )
  `);
}

export async function recordFilterResult(result: FilterResult) {
  database
    .prepare(`
      INSERT INTO filter_results
        (url, headline, published_at, included, filtered_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      result.url,
      result.headline,
      result.publishedAt ?? null,
      result.included ? 1 : 0,
      result.filteredAt,
    );
}

export async function deleteOldFilterResults(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 2);
  return database
    .prepare("DELETE FROM filter_results WHERE filtered_at < ?")
    .run(cutoff.toISOString()).changes;
}

export async function readFilterResults(): Promise<FilterResult[]> {
  return (
    database
      .prepare(`
        SELECT id, url, headline, published_at AS publishedAt,
          included, filtered_at AS filteredAt
        FROM filter_results ORDER BY id
      `)
      .all() as Array<Omit<FilterResult, "included"> & { included: number }>
  ).map((result) => ({
    ...result,
    included: Boolean(result.included),
  }));
}

export async function updateSourceStatus(source: Source) {
  database
    .prepare(`
      UPDATE sources SET last_fetched_at = ?, last_error = ? WHERE id = ?
    `)
    .run(
      source.lastFetchedAt ?? null,
      source.lastError ?? null,
      source.id,
    );
}

export async function recordRun(error?: string) {
  const upsert = database.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  upsert.run("lastRunAt", new Date().toISOString());
  if (error) upsert.run("lastRunError", error);
  else database.prepare("DELETE FROM app_meta WHERE key = ?").run("lastRunError");
}

export async function mergeArticles(articles: Article[]) {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const article of articles) insertArticle(article);
    database.exec(`
      DELETE FROM articles
      WHERE rejected = 0 AND id NOT IN (
        SELECT id FROM articles
        WHERE rejected = 0
        ORDER BY discovered_at DESC LIMIT 250
      )
    `);
    database.exec(`
      DELETE FROM articles
      WHERE rejected = 1 AND id NOT IN (
        SELECT id FROM articles
        WHERE rejected = 1
        ORDER BY discovered_at DESC LIMIT 250
      )
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function commitIngestionRun(input: {
  filterResults: FilterResult[];
  seenArticleIds: string[];
  articles: Article[];
}) {
  const insertFilterResult = database.prepare(`
    INSERT INTO filter_results
      (url, headline, published_at, included, filtered_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertSeen = database.prepare(`
    INSERT OR IGNORE INTO seen_articles (article_id, seen_at) VALUES (?, ?)
  `);
  const seenAt = new Date().toISOString();

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const result of input.filterResults) {
      insertFilterResult.run(
        result.url,
        result.headline,
        result.publishedAt ?? null,
        result.included ? 1 : 0,
        result.filteredAt,
      );
    }
    for (const id of input.seenArticleIds) {
      insertSeen.run(id, seenAt);
    }
    for (const article of input.articles) insertArticle(article);
    database.exec(`
      DELETE FROM seen_articles
      WHERE article_id NOT IN (
        SELECT article_id FROM seen_articles ORDER BY seen_at DESC LIMIT 2000
      )
    `);
    database.exec(`
      DELETE FROM articles
      WHERE rejected = 0 AND id NOT IN (
        SELECT id FROM articles
        WHERE rejected = 0
        ORDER BY discovered_at DESC LIMIT 250
      )
    `);
    database.exec(`
      DELETE FROM articles
      WHERE rejected = 1 AND id NOT IN (
        SELECT id FROM articles
        WHERE rejected = 1
        ORDER BY discovered_at DESC LIMIT 250
      )
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
