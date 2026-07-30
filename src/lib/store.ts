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
  ArticleCursor,
  ArticlePage,
  FilterResult,
  Reaction,
  Source,
  TopicPreference,
  TopicRating,
} from "./types.ts";

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
    filter_decision TEXT NOT NULL DEFAULT 'yes'
      CHECK (filter_decision IN ('yes', 'no', 'maybe')),
    hidden INTEGER NOT NULL DEFAULT 0,
    skip_reason TEXT
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
    byline TEXT NOT NULL DEFAULT '',
    source_name TEXT NOT NULL,
    published_at TEXT,
    decision TEXT NOT NULL
      CHECK (decision IN ('yes', 'no', 'maybe')),
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
    llm_provider_mode TEXT NOT NULL DEFAULT 'lm-studio'
      CHECK (llm_provider_mode IN ('lm-studio', 'openai-compatible')),
    llm_base_url TEXT NOT NULL,
    llm_model TEXT NOT NULL,
    llm_api_key TEXT NOT NULL,
    llm_context_tokens INTEGER NOT NULL DEFAULT 131072,
    general_guidance TEXT NOT NULL DEFAULT ''
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

function topicKey(topic: string) {
  return topic.trim().toLocaleLowerCase("en-GB").replace(/\s+/g, " ");
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
        image_kind, filter_decision, hidden, skip_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        filter_decision = excluded.filter_decision,
        skip_reason = excluded.skip_reason
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
      article.filterDecision,
      article.hidden ? 1 : 0,
      article.skipReason ?? null,
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
        llm_provider_mode, llm_base_url, llm_model, llm_api_key,
        llm_context_tokens, general_guidance
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      config.pollIntervalMinutes,
      config.maxItemsPerSource,
      config.llmProviderMode,
      config.lmStudioBaseURL,
      config.lmStudioModel,
      config.lmStudioApiKey,
      config.llmContextTokens,
      config.filterGeneralGuidance,
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
    if (next.runtime || next.llm || next.filter) {
      const current = database
        .prepare(`
          SELECT poll_interval_minutes AS pollIntervalMinutes,
            max_items_per_source AS maxItemsPerSource,
            llm_provider_mode AS llmProviderMode,
            llm_base_url AS llmBaseURL, llm_model AS llmModel,
            llm_api_key AS llmApiKey,
            llm_context_tokens AS llmContextTokens,
            general_guidance AS generalGuidance
          FROM app_settings WHERE id = 1
        `)
        .get() as {
        pollIntervalMinutes: number;
        maxItemsPerSource: number;
        llmProviderMode: string;
        llmBaseURL: string;
        llmModel: string;
        llmApiKey: string;
        llmContextTokens: number;
        generalGuidance: string;
      };
      database
        .prepare(`
          UPDATE app_settings SET
            poll_interval_minutes = ?,
            max_items_per_source = ?,
            llm_provider_mode = ?,
            llm_base_url = ?,
            llm_model = ?,
            llm_api_key = ?,
            llm_context_tokens = ?,
            general_guidance = ?
          WHERE id = 1
        `)
        .run(
          next.runtime?.pollIntervalMinutes ?? current.pollIntervalMinutes,
          next.runtime?.maxItemsPerSource ?? current.maxItemsPerSource,
          next.llm?.providerMode ?? current.llmProviderMode,
          next.llm?.baseURL ?? current.llmBaseURL,
          next.llm?.model ?? current.llmModel,
          next.llm?.apiKey ?? current.llmApiKey,
          next.llm?.contextTokens ?? current.llmContextTokens,
          next.filter?.generalGuidance ?? current.generalGuidance,
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
        llm_provider_mode AS llmProviderMode,
        llm_base_url AS lmStudioBaseURL,
        llm_model AS lmStudioModel,
        llm_api_key AS lmStudioApiKey,
        llm_context_tokens AS llmContextTokens,
        general_guidance AS filterGeneralGuidance
      FROM app_settings WHERE id = 1
    `)
    .get() as {
    pollIntervalMinutes: number;
    maxItemsPerSource: number;
    llmProviderMode: "lm-studio" | "openai-compatible";
    lmStudioBaseURL: string;
    lmStudioModel: string;
    lmStudioApiKey: string;
    llmContextTokens: number;
    filterGeneralGuidance: string;
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

export async function readState(
  options: {
    includeArticles?: boolean;
    includeSeen?: boolean;
  } = {},
): Promise<AppState> {
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

  const articleRows =
    options.includeArticles === false
      ? []
      : (database
          .prepare(`
      SELECT id, source_id AS sourceId, source_name AS sourceName, url,
        headline, byline, published_at AS publishedAt,
        discovered_at AS discoveredAt, summary,
        points_markdown AS pointsMarkdown,
        image_url AS imageUrl, image_alt AS imageAlt,
        image_kind AS imageKind, filter_decision AS filterDecision,
        hidden, skip_reason AS skipReason
      FROM articles
      WHERE skip_reason IS NULL
      ORDER BY discovered_at DESC, id DESC LIMIT 250
    `)
          .all() as ArticleRow[]);

  const topics =
    articleRows.length === 0
      ? []
      : (database
          .prepare(`
      SELECT article_id AS articleId, topic
      FROM article_topics ORDER BY article_id, position
    `)
          .all() as Array<{ articleId: string; topic: string }>);
  const ratings =
    articleRows.length === 0
      ? []
      : (database
          .prepare(`
      SELECT article_id AS articleId, topic, reaction
      FROM article_topic_ratings ORDER BY article_id, created_at
    `)
          .all() as Array<{
          articleId: string;
          topic: string;
          reaction: Reaction;
        }>);

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
    skipReason: row.skipReason ?? undefined,
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

  const recentSeen =
    options.includeSeen === false
      ? []
      : database
          .prepare(`
      SELECT article_id AS articleId
      FROM seen_articles ORDER BY seen_at DESC LIMIT 2000
    `)
          .all()
          .map((row) => String((row as { articleId: string }).articleId));
  const skippedArticleIds =
    options.includeSeen === false
      ? []
      : database
          .prepare("SELECT id FROM articles WHERE skip_reason IS NOT NULL")
          .all()
          .map((row) => String((row as { id: string }).id));
  const seen = [...new Set([...recentSeen, ...skippedArticleIds])];

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

type ArticleRow = Omit<Article, "topics" | "topicRatings" | "hidden"> & {
  hidden: number;
};

function hydrateArticleRows(articleRows: ArticleRow[]) {
  if (articleRows.length === 0) return [];
  const placeholders = articleRows.map(() => "?").join(", ");
  const articleIds = articleRows.map((row) => row.id);
  const topics = database
    .prepare(`
      SELECT article_id AS articleId, topic
      FROM article_topics
      WHERE article_id IN (${placeholders})
      ORDER BY article_id, position
    `)
    .all(...articleIds) as Array<{ articleId: string; topic: string }>;
  const ratings = database
    .prepare(`
      SELECT article_id AS articleId, topic, reaction
      FROM article_topic_ratings
      WHERE article_id IN (${placeholders})
      ORDER BY article_id, created_at
    `)
    .all(...articleIds) as Array<{
    articleId: string;
    topic: string;
    reaction: Reaction;
  }>;
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
  return articleRows.map(
    (row): Article => ({
      ...row,
      hidden: Boolean(row.hidden),
      skipReason: row.skipReason ?? undefined,
      topics: topicsByArticle.get(row.id) ?? [],
      topicRatings: ratingsByArticle.get(row.id) ?? [],
    }),
  );
}

export async function readArticlePage(
  limit: number,
  cursor?: ArticleCursor,
): Promise<Omit<ArticlePage, "nextCursor"> & { next?: ArticleCursor }> {
  const pageSize = Math.max(1, Math.min(100, Math.floor(limit)));
  const query = `
    SELECT id, source_id AS sourceId, source_name AS sourceName, url,
      headline, byline, published_at AS publishedAt,
      discovered_at AS discoveredAt, summary,
      points_markdown AS pointsMarkdown,
      image_url AS imageUrl, image_alt AS imageAlt,
      image_kind AS imageKind, filter_decision AS filterDecision,
      hidden, skip_reason AS skipReason
    FROM articles
    WHERE skip_reason IS NULL
      ${
        cursor
          ? `AND (
              discovered_at < ?
              OR (discovered_at = ? AND id < ?)
            )`
          : ""
      }
    ORDER BY discovered_at DESC, id DESC
    LIMIT ?
  `;
  const rows = database
    .prepare(query)
    .all(
      ...(cursor
        ? [cursor.discoveredAt, cursor.discoveredAt, cursor.id]
        : []),
      pageSize + 1,
    ) as ArticleRow[];
  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  const articles = hydrateArticleRows(pageRows);
  const last = articles.at(-1);
  return {
    articles,
    hasMore,
    ...(hasMore && last
      ? { next: { discoveredAt: last.discoveredAt, id: last.id } }
      : {}),
  };
}

export async function addSource(source: Source) {
  insertSource(source);
}

export async function removeSource(id: string) {
  database.prepare("DELETE FROM sources WHERE id = ?").run(id);
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
}

export async function removeTopicPreference(topic: string) {
  database
    .prepare("DELETE FROM topic_preferences WHERE topic_key = ?")
    .run(topicKey(topic));
}

export function readSettings() {
  const settings = database
    .prepare(`
      SELECT poll_interval_minutes AS pollIntervalMinutes,
        max_items_per_source AS maxItemsPerSource,
        llm_provider_mode AS providerMode,
        llm_base_url AS baseURL, llm_model AS model,
        length(llm_api_key) > 0 AS hasApiKey,
        llm_context_tokens AS contextTokens,
        general_guidance AS generalGuidance
      FROM app_settings WHERE id = 1
    `)
    .get() as {
    pollIntervalMinutes: number;
    maxItemsPerSource: number;
    providerMode: "lm-studio" | "openai-compatible";
    baseURL: string;
    model: string;
    hasApiKey: number;
    contextTokens: number;
    generalGuidance: string;
  };
  return {
    runtime: {
      pollIntervalMinutes: settings.pollIntervalMinutes,
      maxItemsPerSource: settings.maxItemsPerSource,
    },
    llm: {
      providerMode: settings.providerMode,
      baseURL: settings.baseURL,
      model: settings.model,
      hasApiKey: Boolean(settings.hasApiKey),
      contextTokens: settings.contextTokens,
    },
    filter: {
      generalGuidance: settings.generalGuidance,
    },
  };
}

export function readSettingsSnapshot() {
  const settings = database
    .prepare(`
      SELECT poll_interval_minutes AS pollIntervalMinutes,
        max_items_per_source AS maxItemsPerSource,
        llm_provider_mode AS providerMode,
        llm_base_url AS baseURL, llm_model AS model,
        llm_api_key AS apiKey,
        llm_context_tokens AS contextTokens,
        general_guidance AS generalGuidance
      FROM app_settings WHERE id = 1
    `)
    .get() as {
    pollIntervalMinutes: number;
    maxItemsPerSource: number;
    providerMode: "lm-studio" | "openai-compatible";
    baseURL: string;
    model: string;
    apiKey: string;
    contextTokens: number;
    generalGuidance: string;
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
      providerMode: settings.providerMode,
      baseURL: settings.baseURL,
      model: settings.model,
      apiKey: settings.apiKey,
      contextTokens: settings.contextTokens,
    },
    filter: {
      generalGuidance: settings.generalGuidance,
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
  llmProviderMode: "lm-studio" | "openai-compatible";
  llmBaseURL: string;
  llmModel: string;
  llmApiKey?: string;
  llmContextTokens: number;
  generalGuidance: string;
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
        llm_provider_mode = ?,
        llm_base_url = ?,
        llm_model = ?,
        llm_api_key = ?,
        llm_context_tokens = ?,
        general_guidance = ?
      WHERE id = 1
    `)
    .run(
      next.pollIntervalMinutes,
      next.maxItemsPerSource,
      next.llmProviderMode,
      next.llmBaseURL,
      next.llmModel,
      apiKey,
      next.llmContextTokens,
      next.generalGuidance.trim(),
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
  return true;
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
        (url, headline, byline, source_name, published_at, decision, filtered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      result.url,
      result.headline,
      result.byline,
      result.sourceName,
      result.publishedAt ?? null,
      result.decision,
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
        SELECT id, url, headline, byline, source_name AS sourceName,
          published_at AS publishedAt, decision, filtered_at AS filteredAt
        FROM filter_results ORDER BY id
      `)
      .all() as FilterResult[]
  );
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
      WHERE skip_reason IS NULL AND id NOT IN (
        SELECT id FROM articles
        WHERE skip_reason IS NULL
        ORDER BY discovered_at DESC LIMIT 250
      )
    `);
    database.exec(`
      DELETE FROM articles
      WHERE skip_reason IS NOT NULL AND id NOT IN (
        SELECT id FROM articles
        WHERE skip_reason IS NOT NULL
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

function pruneIngestionHistory() {
  database.exec(`
    DELETE FROM seen_articles
    WHERE article_id NOT IN (
      SELECT article_id FROM seen_articles ORDER BY seen_at DESC LIMIT 2000
    )
  `);
  database.exec(`
    DELETE FROM articles
    WHERE skip_reason IS NULL AND id NOT IN (
      SELECT id FROM articles
      WHERE skip_reason IS NULL
      ORDER BY discovered_at DESC, id DESC LIMIT 250
    )
  `);
  database.exec(`
    DELETE FROM articles
    WHERE skip_reason IS NOT NULL AND id NOT IN (
      SELECT id FROM articles
      WHERE skip_reason IS NOT NULL
      ORDER BY discovered_at DESC, id DESC LIMIT 250
    )
  `);
}

function insertFilterResultRow(result: FilterResult) {
  database
    .prepare(`
      INSERT INTO filter_results
        (url, headline, byline, source_name, published_at, decision, filtered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      result.url,
      result.headline,
      result.byline,
      result.sourceName,
      result.publishedAt ?? null,
      result.decision,
      result.filteredAt,
    );
}

export async function commitFilterPhase(input: {
  filterResults: FilterResult[];
  rejectedArticleIds: string[];
}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const result of input.filterResults) insertFilterResultRow(result);
    const insertSeen = database.prepare(
      "INSERT OR IGNORE INTO seen_articles (article_id, seen_at) VALUES (?, ?)",
    );
    const seenAt = new Date().toISOString();
    for (const id of input.rejectedArticleIds) insertSeen.run(id, seenAt);
    pruneIngestionHistory();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function commitAnalysedArticle(article: Article) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        "INSERT OR IGNORE INTO seen_articles (article_id, seen_at) VALUES (?, ?)",
      )
      .run(article.id, new Date().toISOString());
    insertArticle(article);
    pruneIngestionHistory();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
