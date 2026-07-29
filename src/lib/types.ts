export type Reaction = "like" | "dislike";
export type ImageKind = "article" | "related";
export type FilterDecision = "yes" | "no" | "maybe";
export type ArticleSkipReason =
  | "unusable_article"
  | "headline_mismatch"
  | "insufficient_content"
  | "summary_timeout"
  | "legacy_rejected";

export type TopicRating = {
  topic: string;
  reaction: Reaction;
};

export type TopicPreference = TopicRating & {
  source: "perplexity" | "rating";
};

export type Source = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  lastFetchedAt?: string;
  lastError?: string;
};

export type Article = {
  id: string;
  sourceId: string;
  sourceName: string;
  url: string;
  headline: string;
  byline: string;
  publishedAt?: string;
  discoveredAt: string;
  topics: string[];
  summary: string;
  pointsMarkdown: string;
  imageUrl: string;
  imageAlt: string;
  imageKind: ImageKind;
  filterDecision: FilterDecision;
  topicRatings: TopicRating[];
  hidden: boolean;
  skipReason?: ArticleSkipReason;
};

export type FilterResult = {
  id?: number;
  url: string;
  headline: string;
  publishedAt?: string;
  decision: FilterDecision;
  filteredAt: string;
};

export type RefreshProgress = {
  runId?: string;
  status: "idle" | "running" | "completed" | "failed" | "stopped";
  phase:
    | "idle"
    | "downloading"
    | "filtering"
    | "analysing"
    | "completed"
    | "failed"
    | "stopped";
  percent: number;
  startedAt?: string;
  completedAt?: string;
  sources: {
    completed: number;
    total: number;
    failed: number;
  };
  filters: {
    completed: number;
    total: number;
    accepted: number;
    maybe: number;
    failed: number;
  };
  analyses: {
    completed: number;
    total: number;
    stored: number;
    skipped: number;
    failed: number;
  };
  error?: string;
};

export type AppState = {
  sources: Source[];
  articles: Article[];
  seen: string[];
  topicPreferences: TopicPreference[];
  lastRunAt?: string;
  lastRunError?: string;
};

export type DashboardState = AppState & {
  llm: {
    baseURL: string;
    model: string;
    hasApiKey: boolean;
  };
  runtime: {
    pollIntervalMinutes: number;
    maxItemsPerSource: number;
  };
};

export type AuthStatus = {
  required: boolean;
  authenticated: boolean;
};
