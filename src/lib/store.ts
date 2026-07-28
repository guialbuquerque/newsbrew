import { mkdirSync } from "node:fs";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyRuntimeConfig,
  config,
  importedConfig,
} from "./config.ts";
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

  CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    poll_interval_minutes REAL NOT NULL,
    max_items_per_source INTEGER NOT NULL,
    llm_base_url TEXT NOT NULL,
    llm_model TEXT NOT NULL,
    llm_api_key TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    rp_name TEXT NOT NULL,
    rp_id TEXT,
    origin TEXT,
    access_token_salt TEXT NOT NULL DEFAULT '',
    access_token_hash TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS articles_discovered_at
    ON articles(discovered_at DESC);
  CREATE INDEX IF NOT EXISTS ratings_created_at
    ON article_topic_ratings(created_at DESC);
  CREATE INDEX IF NOT EXISTS filter_results_filtered_at
    ON filter_results(filtered_at DESC);
`);

database.exec(`
  DROP TABLE IF EXISTS passkeys;
  DROP TABLE IF EXISTS auth_challenges;
`);

const articleColumns = database
  .prepare("PRAGMA table_info(articles)")
  .all() as Array<{ name: string }>;
if (!articleColumns.some((column) => column.name === "rejected")) {
  database.exec(
    "ALTER TABLE articles ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0",
  );
}

const authSettingColumns = database
  .prepare("PRAGMA table_info(auth_settings)")
  .all() as Array<{ name: string }>;
if (!authSettingColumns.some((column) => column.name === "access_token_salt")) {
  database.exec(
    "ALTER TABLE auth_settings ADD COLUMN access_token_salt TEXT NOT NULL DEFAULT ''",
  );
}
if (!authSettingColumns.some((column) => column.name === "access_token_hash")) {
  database.exec(
    "ALTER TABLE auth_settings ADD COLUMN access_token_hash TEXT NOT NULL DEFAULT ''",
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
  const initialized = database
    .prepare("SELECT 1 FROM app_meta WHERE key = 'initialDataSeeded'")
    .get();
  if (initialized) return;
  const row = database.prepare("SELECT COUNT(*) AS count FROM sources").get() as {
    count: number;
  };
  if (row.count > 0) {
    database
      .prepare(`
        INSERT OR IGNORE INTO app_meta (key, value)
        VALUES ('initialDataSeeded', ?)
      `)
      .run(new Date().toISOString());
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
    database
      .prepare(`
        INSERT INTO app_meta (key, value)
        VALUES ('initialDataSeeded', ?)
      `)
      .run(new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

initializeData();

function sourceId(name: string, url: string) {
  return createHash("sha256").update(`${name}:${url}`).digest("hex").slice(0, 24);
}

function initializeSettings() {
  database
    .prepare(`
      INSERT OR IGNORE INTO app_settings (
        id, poll_interval_minutes, max_items_per_source,
        llm_base_url, llm_model, llm_api_key
      ) VALUES (1, ?, ?, ?, ?, ?)
    `)
    .run(
      config.pollIntervalMinutes,
      config.maxItemsPerSource,
      config.lmStudioBaseURL,
      config.lmStudioModel,
      config.lmStudioApiKey,
    );
  database
    .prepare(`
      INSERT OR IGNORE INTO auth_settings (
        id, rp_name, rp_id, origin, access_token_salt, access_token_hash
      )
      VALUES (1, 'Newsbrew', NULL, NULL, '', '')
    `)
    .run();
}

export function importConfiguredSettings(force = false) {
  const next = importedConfig.value;
  const fingerprint = importedConfig.fingerprint;
  if (!next || !fingerprint) {
    return { imported: false, source: importedConfig.source };
  }
  const previous = database
    .prepare("SELECT value FROM app_meta WHERE key = 'configImportFingerprint'")
    .get() as { value?: string } | undefined;
  if (!force && previous?.value === fingerprint) {
    return { imported: false, source: importedConfig.source };
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    if (next.runtime || next.llm) {
      const current = database
        .prepare(`
          SELECT poll_interval_minutes AS pollIntervalMinutes,
            max_items_per_source AS maxItemsPerSource,
            llm_base_url AS llmBaseURL, llm_model AS llmModel,
            llm_api_key AS llmApiKey
          FROM app_settings WHERE id = 1
        `)
        .get() as {
        pollIntervalMinutes: number;
        maxItemsPerSource: number;
        llmBaseURL: string;
        llmModel: string;
        llmApiKey: string;
      };
      database
        .prepare(`
          UPDATE app_settings SET
            poll_interval_minutes = ?,
            max_items_per_source = ?,
            llm_base_url = ?,
            llm_model = ?,
            llm_api_key = ?
          WHERE id = 1
        `)
        .run(
          next.runtime?.pollIntervalMinutes ?? current.pollIntervalMinutes,
          next.runtime?.maxItemsPerSource ?? current.maxItemsPerSource,
          next.llm?.baseURL ?? current.llmBaseURL,
          next.llm?.model ?? current.llmModel,
          next.llm?.apiKey ?? current.llmApiKey,
        );
    }

    if (next.auth) {
      setAccessToken(next.auth.accessToken ?? "");
    }

    if (next.sources) {
      database.prepare("UPDATE sources SET enabled = 0").run();
      const upsert = database.prepare(`
        INSERT INTO sources (id, name, url, enabled)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          url = excluded.url,
          enabled = excluded.enabled
      `);
      for (const source of next.sources) {
        upsert.run(
          source.id ?? sourceId(source.name, source.url),
          source.name,
          source.url,
          source.enabled ? 1 : 0,
        );
      }
    }

    if (next.topics) {
      database.prepare("DELETE FROM topic_preferences").run();
      const insert = database.prepare(`
        INSERT INTO topic_preferences
          (topic_key, topic, reaction, source, updated_at)
        VALUES (?, ?, ?, 'rating', ?)
      `);
      const now = new Date().toISOString();
      for (const topic of next.topics.like) {
        insert.run(topicKey(topic), topic.trim(), "like", now);
      }
      for (const topic of next.topics.dislike) {
        insert.run(topicKey(topic), topic.trim(), "dislike", now);
      }
    }

    database
      .prepare(`
        INSERT INTO app_meta (key, value)
        VALUES ('configImportFingerprint', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(fingerprint);
    database.exec("COMMIT");
    return { imported: true, source: importedConfig.source };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function hydrateRuntimeConfig() {
  const settings = database
    .prepare(`
      SELECT poll_interval_minutes AS pollIntervalMinutes,
        max_items_per_source AS maxItemsPerSource,
        llm_base_url AS lmStudioBaseURL,
        llm_model AS lmStudioModel,
        llm_api_key AS lmStudioApiKey
      FROM app_settings WHERE id = 1
    `)
    .get() as {
    pollIntervalMinutes: number;
    maxItemsPerSource: number;
    lmStudioBaseURL: string;
    lmStudioModel: string;
    lmStudioApiKey: string;
  };
  applyRuntimeConfig(settings);
}

export function reloadRuntimeConfig() {
  hydrateRuntimeConfig();
  return readSettings();
}

initializeSettings();
if (process.env.NEWSBREW_SETTINGS_IMPORT_MODE !== "explicit") {
  importConfiguredSettings();
}
hydrateRuntimeConfig();

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

export async function addTopicPreference(
  topic: string,
  reaction: Reaction,
) {
  const normalized = topic.trim();
  database
    .prepare(`
      INSERT INTO topic_preferences
        (topic_key, topic, reaction, source, updated_at)
      VALUES (?, ?, ?, 'rating', ?)
      ON CONFLICT(topic_key) DO UPDATE SET
        topic = excluded.topic,
        reaction = excluded.reaction,
        source = excluded.source,
        updated_at = excluded.updated_at
    `)
    .run(topicKey(normalized), normalized, reaction, new Date().toISOString());
  return readState();
}

export async function removeTopicPreference(topic: string) {
  database
    .prepare("DELETE FROM topic_preferences WHERE topic_key = ?")
    .run(topicKey(topic));
  return readState();
}

export function readSettings() {
  const settings = database
    .prepare(`
      SELECT poll_interval_minutes AS pollIntervalMinutes,
        max_items_per_source AS maxItemsPerSource,
        llm_base_url AS baseURL, llm_model AS model,
        length(llm_api_key) > 0 AS hasApiKey
      FROM app_settings WHERE id = 1
    `)
    .get() as {
    pollIntervalMinutes: number;
    maxItemsPerSource: number;
    baseURL: string;
    model: string;
    hasApiKey: number;
  };
  return {
    runtime: {
      pollIntervalMinutes: settings.pollIntervalMinutes,
      maxItemsPerSource: settings.maxItemsPerSource,
    },
    llm: {
      baseURL: settings.baseURL,
      model: settings.model,
      hasApiKey: Boolean(settings.hasApiKey),
    },
  };
}

export function readSettingsSnapshot() {
  const settings = database
    .prepare(`
      SELECT poll_interval_minutes AS pollIntervalMinutes,
        max_items_per_source AS maxItemsPerSource,
        llm_base_url AS baseURL, llm_model AS model,
        llm_api_key AS apiKey
      FROM app_settings WHERE id = 1
    `)
    .get() as {
    pollIntervalMinutes: number;
    maxItemsPerSource: number;
    baseURL: string;
    model: string;
    apiKey: string;
  };
  const sources = (
    database
      .prepare(`
        SELECT id, name, url, enabled
        FROM sources ORDER BY rowid
      `)
      .all() as Array<{
      id: string;
      name: string;
      url: string;
      enabled: number;
    }>
  ).map((source) => ({
    id: source.id,
    name: source.name,
    url: source.url,
    enabled: Boolean(source.enabled),
  }));
  const preferences = database
    .prepare(`
      SELECT topic, reaction
      FROM topic_preferences
      ORDER BY topic COLLATE NOCASE
    `)
    .all() as Array<{ topic: string; reaction: Reaction }>;
  return {
    runtime: {
      pollIntervalMinutes: settings.pollIntervalMinutes,
      maxItemsPerSource: settings.maxItemsPerSource,
    },
    llm: {
      baseURL: settings.baseURL,
      model: settings.model,
      apiKey: settings.apiKey,
    },
    sources,
    topics: {
      like: preferences
        .filter((preference) => preference.reaction === "like")
        .map((preference) => preference.topic),
      dislike: preferences
        .filter((preference) => preference.reaction === "dislike")
        .map((preference) => preference.topic),
    },
    accessTokenRequired: accessTokenRequired(),
  };
}

export function updateSettings(next: {
  pollIntervalMinutes: number;
  maxItemsPerSource: number;
  llmBaseURL: string;
  llmModel: string;
  llmApiKey?: string;
}) {
  const current = database
    .prepare("SELECT llm_api_key AS apiKey FROM app_settings WHERE id = 1")
    .get() as { apiKey: string };
  const apiKey = next.llmApiKey === undefined ? current.apiKey : next.llmApiKey;
  database
    .prepare(`
      UPDATE app_settings SET
        poll_interval_minutes = ?,
        max_items_per_source = ?,
        llm_base_url = ?,
        llm_model = ?,
        llm_api_key = ?
      WHERE id = 1
    `)
    .run(
      next.pollIntervalMinutes,
      next.maxItemsPerSource,
      next.llmBaseURL,
      next.llmModel,
      apiKey,
    );
  hydrateRuntimeConfig();
  return readSettings();
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

function accessTokenDigest(token: string, salt: string) {
  return scryptSync(token, salt, 32);
}

export function accessTokenRequired() {
  const row = database
    .prepare(`
      SELECT access_token_hash AS tokenHash
      FROM auth_settings WHERE id = 1
    `)
    .get() as { tokenHash: string };
  return row.tokenHash.length > 0;
}

export function verifyAccessToken(token: string) {
  const row = database
    .prepare(`
      SELECT access_token_salt AS salt, access_token_hash AS tokenHash
      FROM auth_settings WHERE id = 1
    `)
    .get() as { salt: string; tokenHash: string };
  if (!row.salt || !row.tokenHash) return false;
  const expected = Buffer.from(row.tokenHash, "hex");
  const actual = accessTokenDigest(token.trim(), row.salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function setAccessToken(token: string) {
  const normalized = token.trim();
  if (!normalized) {
    database
      .prepare(`
        UPDATE auth_settings
        SET access_token_salt = '', access_token_hash = ''
        WHERE id = 1
      `)
      .run();
  } else {
    const salt = randomBytes(16).toString("hex");
    const tokenHash = accessTokenDigest(normalized, salt).toString("hex");
    database
      .prepare(`
        UPDATE auth_settings
        SET access_token_salt = ?, access_token_hash = ?
        WHERE id = 1
      `)
      .run(salt, tokenHash);
  }
  database.prepare("DELETE FROM auth_sessions").run();
  return accessTokenRequired();
}

function sessionHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createAuthSession() {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
  database
    .prepare(`
      INSERT INTO auth_sessions (token_hash, expires_at, created_at)
      VALUES (?, ?, ?)
    `)
    .run(sessionHash(token), expiresAt.toISOString(), now.toISOString());
  return { token, expiresAt };
}

export function authSessionIsValid(token: string | undefined) {
  if (!token) return false;
  const row = database
    .prepare(`
      SELECT expires_at AS expiresAt FROM auth_sessions WHERE token_hash = ?
    `)
    .get(sessionHash(token)) as { expiresAt: string } | undefined;
  return Boolean(row && row.expiresAt > new Date().toISOString());
}

export function deleteAuthSession(token: string | undefined) {
  if (!token) return;
  database
    .prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
    .run(sessionHash(token));
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
