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
  score: number;
  reason: string;
  topics: string[];
  summary: string;
  bullets: string[];
  imageUrl: string;
  imageAlt: string;
  imageKind: ImageKind;
  topicRatings: TopicRating[];
  hidden: boolean;
};

export type Preferences = {
  minimumScore: number;
};

export type Feedback = {
  articleId: string;
  headline: string;
  topic: string;
  reaction: Reaction;
  createdAt: string;
};

export type AppState = {
  sources: Source[];
  articles: Article[];
  seen: string[];
  preferences: Preferences;
  topicPreferences: TopicPreference[];
  feedback: Feedback[];
  lastRunAt?: string;
  lastRunError?: string;
};

export type DashboardState = AppState & {
  llm: {
    baseURL: string;
    model: string;
  };
};
