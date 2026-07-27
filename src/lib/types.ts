export type Reaction = "like" | "dislike";
export type ImageKind = "article" | "related";

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
  topicRatings: TopicRating[];
  hidden: boolean;
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
  };
};
