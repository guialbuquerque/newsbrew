import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import type {
  AppState,
  Article,
  Feedback,
  Preferences,
  Reaction,
  Source,
  TopicPreference,
  TopicRating,
} from "./types.ts";

const seededPreferences: Preferences = {
  minimumScore: 65,
};

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

  CREATE TABLE IF NOT EXISTS preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    minimum_score INTEGER NOT NULL
  );

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
    score INTEGER NOT NULL,
    reason TEXT NOT NULL,
    summary TEXT NOT NULL,
    image_url TEXT NOT NULL,
    image_alt TEXT NOT NULL,
    image_kind TEXT NOT NULL CHECK (image_kind IN ('article', 'related')),
    hidden INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS article_bullets (
    article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (article_id, position)
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

  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS articles_discovered_at
    ON articles(discovered_at DESC);
  CREATE INDEX IF NOT EXISTS ratings_created_at
    ON article_topic_ratings(created_at DESC);
`);

const preferenceColumns = database
  .prepare("PRAGMA table_info(preferences)")
  .all() as Array<{ name: string }>;
if (
  preferenceColumns.some(
    (column) => column.name === "description" || column.name === "avoid",
  )
) {
  database.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE preferences RENAME TO preferences_with_text;
    CREATE TABLE preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      minimum_score INTEGER NOT NULL
    );
    INSERT INTO preferences (id, minimum_score)
      SELECT id, minimum_score FROM preferences_with_text;
    DROP TABLE preferences_with_text;
    COMMIT;
  `);
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
        discovered_at, score, reason, summary, image_url, image_alt,
        image_kind, hidden
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_name = excluded.source_name,
        url = excluded.url,
        headline = excluded.headline,
        byline = excluded.byline,
        published_at = excluded.published_at,
        score = excluded.score,
        reason = excluded.reason,
        summary = excluded.summary,
        image_url = excluded.image_url,
        image_alt = excluded.image_alt,
        image_kind = excluded.image_kind
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
      article.score,
      article.reason,
      article.summary,
      article.imageUrl,
      article.imageAlt,
      article.imageKind,
      article.hidden ? 1 : 0,
    );

  database
    .prepare("DELETE FROM article_bullets WHERE article_id = ?")
    .run(article.id);
  const insertBullet = database.prepare(`
    INSERT INTO article_bullets (article_id, position, text) VALUES (?, ?, ?)
  `);
  article.bullets.forEach((bullet, position) => {
    insertBullet.run(article.id, position, bullet);
  });

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
    database
      .prepare(`
        INSERT OR IGNORE INTO preferences
          (id, minimum_score)
        VALUES (1, ?)
      `)
      .run(seededPreferences.minimumScore);

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
        discovered_at AS discoveredAt, score, reason, summary,
        image_url AS imageUrl, image_alt AS imageAlt,
        image_kind AS imageKind, hidden
      FROM articles ORDER BY discovered_at DESC LIMIT 250
    `)
    .all() as Array<
    Omit<Article, "topics" | "bullets" | "topicRatings" | "hidden"> & {
      hidden: number;
    }
  >;

  const bullets = database
    .prepare(`
      SELECT article_id AS articleId, text
      FROM article_bullets ORDER BY article_id, position
    `)
    .all() as Array<{ articleId: string; text: string }>;
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

  const bulletsByArticle = new Map<string, string[]>();
  for (const row of bullets) {
    bulletsByArticle.set(row.articleId, [
      ...(bulletsByArticle.get(row.articleId) ?? []),
      row.text,
    ]);
  }
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
    topics: topicsByArticle.get(row.id) ?? [],
    bullets: bulletsByArticle.get(row.id) ?? [],
    topicRatings: ratingsByArticle.get(row.id) ?? [],
  }));

  const preference = database
    .prepare(`
      SELECT minimum_score AS minimumScore
      FROM preferences WHERE id = 1
    `)
    .get() as Preferences | undefined;

  const topicPreferences = database
    .prepare(`
      SELECT topic, reaction, source
      FROM topic_preferences
      ORDER BY reaction, updated_at DESC, topic
    `)
    .all() as TopicPreference[];

  const feedback = database
    .prepare(`
      SELECT r.article_id AS articleId, a.headline, r.topic, r.reaction,
        r.created_at AS createdAt
      FROM article_topic_ratings r
      JOIN articles a ON a.id = r.article_id
      ORDER BY r.created_at DESC LIMIT 40
    `)
    .all() as Feedback[];

  const seen = database
    .prepare(`
      SELECT article_id AS articleId
      FROM seen_articles ORDER BY seen_at DESC LIMIT 2000
    `)
    .all()
    .map((row) => String((row as { articleId: string }).articleId));

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
    preferences: preference ?? seededPreferences,
    topicPreferences,
    feedback,
    lastRunAt: metadata.lastRunAt ?? undefined,
    lastRunError: metadata.lastRunError ?? undefined,
  };
}

export async function updatePreferences(preferences: Preferences) {
  database
    .prepare(`
      INSERT INTO preferences (id, minimum_score)
      VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET
        minimum_score = excluded.minimum_score
    `)
    .run(preferences.minimumScore);
  return readState();
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
      WHERE id NOT IN (
        SELECT id FROM articles ORDER BY discovered_at DESC LIMIT 250
      )
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
