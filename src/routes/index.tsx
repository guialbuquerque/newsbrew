import {
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  EyeOff,
  LoaderCircle,
  Newspaper,
  Plus,
  Radio,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-solid";
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { relatedImageForTopics } from "~/lib/images";
import type {
  Article,
  DashboardState,
  Preferences,
  Reaction,
  TopicRating,
} from "~/lib/types";

function formatWhen(value?: string) {
  if (!value) return "Not run yet";
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function readError(value: unknown) {
  return value instanceof Error ? value.message : "Something went wrong";
}

function ArticleImage(props: { article: Article }) {
  const fallback = relatedImageForTopics(props.article.topics);
  const [src, setSrc] = createSignal(props.article.imageUrl);
  const [kind, setKind] = createSignal(props.article.imageKind);
  const [alt, setAlt] = createSignal(props.article.imageAlt);

  return (
    <div classList={{ "article-image": true, related: kind() === "related" }}>
      <img
        src={src()}
        alt={alt()}
        loading="lazy"
        onError={() => {
          if (src() !== fallback.url) {
            setSrc(fallback.url);
            setAlt(fallback.alt);
            setKind("related");
          }
        }}
      />
      <Show when={kind() === "related"}>
        <span>Related image</span>
      </Show>
    </div>
  );
}

export default function Home() {
  const [state, setState] = createSignal<DashboardState>();
  const [loading, setLoading] = createSignal(true);
  const [refreshing, setRefreshing] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [savingRating, setSavingRating] = createSignal(false);
  const [panelOpen, setPanelOpen] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [expandedIds, setExpandedIds] = createSignal<string[]>([]);
  const [ratingArticleId, setRatingArticleId] = createSignal<string>();
  const [draftRatings, setDraftRatings] = createSignal<
    Record<string, Reaction>
  >({});
  const [preferences, setPreferences] = createSignal<Preferences>({
    minimumScore: 65,
  });
  const [sourceName, setSourceName] = createSignal("");
  const [sourceUrl, setSourceUrl] = createSignal("");

  const likedTopics = createMemo(
    () =>
      state()?.topicPreferences.filter((topic) => topic.reaction === "like") ??
      [],
  );
  const dislikedTopics = createMemo(
    () =>
      state()?.topicPreferences.filter(
        (topic) => topic.reaction === "dislike",
      ) ?? [],
  );

  async function load(options: { clearNotice?: boolean } = {}) {
    try {
      const response = await fetch("/api/state");
      if (!response.ok) throw new Error("Could not load your digest");
      const next = (await response.json()) as DashboardState;
      setState(next);
      setPreferences(next.preferences);
      if (options.clearNotice) setNotice("");
    } catch (error) {
      setNotice(readError(error));
    } finally {
      setLoading(false);
    }
  }

  onMount(() => load());

  function isExpanded(id: string) {
    return expandedIds().includes(id);
  }

  function toggleExpanded(id: string) {
    setExpandedIds((ids) =>
      ids.includes(id)
        ? ids.filter((candidate) => candidate !== id)
        : [...ids, id],
    );
  }

  async function refresh() {
    setRefreshing(true);
    setNotice("Checking sources and asking your local model…");
    try {
      const response = await fetch("/api/refresh", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "Refresh failed");
      }
      await load();
      setNotice("Your digest is up to date.");
    } catch (error) {
      setNotice(readError(error));
    } finally {
      setRefreshing(false);
    }
  }

  function openRating(article: Article) {
    if (ratingArticleId() === article.id) {
      setRatingArticleId();
      return;
    }
    const existing = new Map(
      article.topicRatings.map((item) => [
        item.topic.toLocaleLowerCase("en-GB"),
        item.reaction,
      ]),
    );
    setDraftRatings(
      Object.fromEntries(
        article.topics.flatMap((topic) => {
          const key = topic.toLocaleLowerCase("en-GB");
          const reaction = existing.get(key);
          return reaction ? [[topic, reaction]] : [];
        }),
      ),
    );
    setRatingArticleId(article.id);
  }

  function toggleRating(topic: string, reaction: Reaction) {
    const next = { ...draftRatings() };
    if (next[topic] === reaction) delete next[topic];
    else next[topic] = reaction;
    setDraftRatings(next);
  }

  async function saveRating(article: Article) {
    setSavingRating(true);
    const ratings: TopicRating[] = article.topics.flatMap((topic) => {
      const reaction = draftRatings()[topic];
      return reaction ? [{ topic, reaction }] : [];
    });
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articleId: article.id, ratings }),
      });
      if (!response.ok) throw new Error("Could not save topic ratings");
      await load();
      setRatingArticleId();
      setNotice(
        ratings.length === 0
          ? "The story’s topic ratings were cleared."
          : "Topic preferences saved for future rankings.",
      );
    } catch (error) {
      setNotice(readError(error));
    } finally {
      setSavingRating(false);
    }
  }

  async function savePreferences() {
    setSaving(true);
    try {
      const response = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preferences()),
      });
      if (!response.ok) throw new Error("Could not save preferences");
      const current = state();
      if (current) setState({ ...current, preferences: preferences() });
      setNotice("Match threshold saved for the next refresh.");
    } catch (error) {
      setNotice(readError(error));
    } finally {
      setSaving(false);
    }
  }

  async function addSource(event: SubmitEvent) {
    event.preventDefault();
    try {
      const response = await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: sourceName(), url: sourceUrl() }),
      });
      if (!response.ok) throw new Error("Add a valid RSS or Atom feed URL");
      setSourceName("");
      setSourceUrl("");
      await load();
      setNotice("Source added.");
    } catch (error) {
      setNotice(readError(error));
    }
  }

  async function removeSource(id: string) {
    try {
      const response = await fetch(`/api/sources?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Could not remove source");
      await load();
      setNotice("Source removed.");
    } catch (error) {
      setNotice(readError(error));
    }
  }

  function RatingPanel(props: { article: Article }) {
    return (
      <div class="rating-panel">
        <div class="rating-heading">
          <div>
            <strong>Rate the topics, not the whole story</strong>
            <p>Leave either toggle off when the topic did not affect your view.</p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close topic rating"
            onClick={() => setRatingArticleId()}
          >
            <X size={16} />
          </Button>
        </div>
        <div class="rating-table" role="table" aria-label="Topic ratings">
          <div class="rating-row rating-header" role="row">
            <span role="columnheader">Topic</span>
            <span role="columnheader">Like</span>
            <span role="columnheader">Dislike</span>
          </div>
          <For each={props.article.topics}>
            {(topic) => (
              <div class="rating-row" role="row">
                <strong role="cell">{topic}</strong>
                <span role="cell">
                  <Button
                    size="icon"
                    variant={draftRatings()[topic] === "like" ? "accent" : "outline"}
                    aria-label={`Like ${topic}`}
                    aria-pressed={draftRatings()[topic] === "like"}
                    onClick={() => toggleRating(topic, "like")}
                  >
                    <ThumbsUp size={15} />
                  </Button>
                </span>
                <span role="cell">
                  <Button
                    size="icon"
                    variant={
                      draftRatings()[topic] === "dislike" ? "default" : "outline"
                    }
                    aria-label={`Dislike ${topic}`}
                    aria-pressed={draftRatings()[topic] === "dislike"}
                    onClick={() => toggleRating(topic, "dislike")}
                  >
                    <ThumbsDown size={15} />
                  </Button>
                </span>
              </div>
            )}
          </For>
        </div>
        <div class="rating-save">
          <Button
            size="sm"
            disabled={savingRating()}
            onClick={() => saveRating(props.article)}
          >
            <Check size={14} />
            {savingRating() ? "Saving…" : "Save topic ratings"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div class="min-h-screen bg-[var(--canvas)] text-[var(--ink)]">
      <header class="topbar">
        <a href="/" class="brand" aria-label="Newsbrew home">
          <span class="brand-mark"><Newspaper size={17} /></span>
          <span>NEWSBREW</span>
        </a>
        <div class="header-actions">
          <Show when={state()}>
            {(loaded) => (
              <span class="model-chip">
                <span class="status-dot" />
                {loaded().llm.model}
              </span>
            )}
          </Show>
          <Button
            variant="outline"
            size="sm"
            class="lg:hidden"
            onClick={() => setPanelOpen(true)}
          >
            <SlidersHorizontal size={14} /> Tune
          </Button>
          <Button
            variant="accent"
            size="sm"
            disabled={refreshing()}
            onClick={refresh}
          >
            <Show when={refreshing()} fallback={<RefreshCw size={14} />}>
              <LoaderCircle class="animate-spin" size={14} />
            </Show>
            {refreshing() ? "Reading…" : "Refresh digest"}
          </Button>
        </div>
      </header>

      <main class="app-shell">
        <section class="feed-column">
          <Show when={notice()}>
            <div class="notice" role="status">{notice()}</div>
          </Show>

          <Show
            when={!loading()}
            fallback={
              <Card class="empty-card">
                <LoaderCircle class="animate-spin" size={24} />
                <p>Opening your briefing…</p>
              </Card>
            }
          >
            <Show
              when={(state()?.articles.length ?? 0) > 0}
              fallback={
                <Card class="empty-card">
                  <span class="empty-icon"><Radio size={24} /></span>
                  <h2>Your desk is ready</h2>
                  <p>
                    Refresh the digest to scan the starter sources, or review
                    your topic signals and add feeds first.
                  </p>
                  <Button variant="accent" onClick={refresh} disabled={refreshing()}>
                    <RefreshCw size={15} /> Run first refresh
                  </Button>
                </Card>
              }
            >
              <div class="article-list">
                <For each={state()?.articles}>
                  {(article) => (
                    <Show
                      when={!article.hidden}
                      fallback={
                        <Card class="article-card hidden-article">
                          <div class="hidden-story-copy">
                            <EyeOff size={14} />
                            <div>
                              <span>{article.sourceName} · hidden by your topic ratings</span>
                              <h2>{article.headline}</h2>
                            </div>
                          </div>
                          <div class="hidden-story-actions">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openRating(article)}
                            >
                              Rate
                            </Button>
                            <a
                              class="open-link compact"
                              href={article.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open <ExternalLink size={13} />
                            </a>
                          </div>
                          <Show when={ratingArticleId() === article.id}>
                            <RatingPanel article={article} />
                          </Show>
                        </Card>
                      }
                    >
                      <Card class="article-card">
                        <ArticleImage article={article} />
                        <div class="article-body">
                          <div class="article-meta">
                            <span>{article.sourceName}</span>
                            <span class="meta-separator">•</span>
                            <span>{formatWhen(article.publishedAt ?? article.discoveredAt)}</span>
                            <span class="score">{article.score}% match</span>
                          </div>
                          <h2 class="article-headline">{article.headline}</h2>
                          <p class="byline">{article.byline}</p>
                          <p class="article-summary">{article.summary}</p>

                          <div class="article-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-expanded={isExpanded(article.id)}
                              onClick={() => toggleExpanded(article.id)}
                            >
                              {isExpanded(article.id) ? "See less" : "See more"}
                              <Show
                                when={isExpanded(article.id)}
                                fallback={<ChevronDown size={14} />}
                              >
                                <ChevronUp size={14} />
                              </Show>
                            </Button>
                            <a
                              class="open-link"
                              href={article.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open <ExternalLink size={14} />
                            </a>
                            <Button
                              class="rate-button"
                              size="sm"
                              variant={
                                article.topicRatings.length > 0 ? "accent" : "outline"
                              }
                              onClick={() => openRating(article)}
                            >
                              Rate
                            </Button>
                          </div>

                          <Show when={isExpanded(article.id)}>
                            <div class="article-details">
                              <ul class="summary-list">
                                <For each={article.bullets}>
                                  {(bullet) => <li>{bullet}</li>}
                                </For>
                              </ul>
                              <div class="topic-list">
                                <For each={article.topics}>
                                  {(topic) => <Badge>{topic}</Badge>}
                                </For>
                              </div>
                              <p class="match-reason">{article.reason}</p>
                            </div>
                          </Show>
                          <Show when={ratingArticleId() === article.id}>
                            <RatingPanel article={article} />
                          </Show>
                        </div>
                      </Card>
                    </Show>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </section>

        <aside classList={{ "control-panel": true, open: panelOpen() }}>
          <div class="mobile-panel-head">
            <strong>Tune your desk</strong>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close settings"
              onClick={() => setPanelOpen(false)}
            >
              <X size={18} />
            </Button>
          </div>

          <section class="panel-section">
            <div class="panel-heading">
              <span class="panel-icon"><SlidersHorizontal size={15} /></span>
              <div>
                <h2>Judgement</h2>
                <p>Topic ratings are the only signals used to rank stories.</p>
              </div>
            </div>
            <label class="field">
              <span>
                Match threshold
                <strong>{preferences().minimumScore}%</strong>
              </span>
              <input
                class="range"
                type="range"
                min="0"
                max="100"
                step="5"
                value={preferences().minimumScore}
                style={`--range-value: ${preferences().minimumScore}%`}
                onInput={(event) =>
                  setPreferences({
                    ...preferences(),
                    minimumScore: Number(event.currentTarget.value),
                  })
                }
              />
            </label>
            <Button class="w-full" onClick={savePreferences} disabled={saving()}>
              {saving() ? "Saving…" : "Save threshold"}
            </Button>

            <details class="topic-preferences">
              <summary>
                Topic signals
                <span>{likedTopics().length} liked · {dislikedTopics().length} disliked</span>
              </summary>
              <div class="preference-group">
                <strong>Like</strong>
                <div>
                  <For each={likedTopics()}>
                    {(topic) => <Badge>{topic.topic}</Badge>}
                  </For>
                </div>
              </div>
              <div class="preference-group dislike">
                <strong>Dislike</strong>
                <div>
                  <For each={dislikedTopics()}>
                    {(topic) => <Badge>{topic.topic}</Badge>}
                  </For>
                </div>
              </div>
            </details>
            <p class="learning-note">
              <Sparkles size={13} />
              Topic ratings update these signals and are included in future
              ranking prompts.
            </p>
          </section>

          <section class="panel-section source-section">
            <div class="panel-heading">
              <span class="panel-icon"><Radio size={15} /></span>
              <div>
                <h2>Sources</h2>
                <p>RSS or Atom feeds, checked on your schedule.</p>
              </div>
            </div>

            <div class="source-list">
              <For each={state()?.sources}>
                {(source) => (
                  <div class="source-row">
                    <span classList={{ "source-status": true, error: !!source.lastError }} />
                    <div>
                      <strong>{source.name}</strong>
                      <span>
                        {source.lastError
                          ? source.lastError
                          : formatWhen(source.lastFetchedAt)}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${source.name}`}
                      onClick={() => removeSource(source.id)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                )}
              </For>
            </div>

            <form class="source-form" onSubmit={addSource}>
              <input
                required
                minlength="2"
                placeholder="Source name"
                value={sourceName()}
                onInput={(event) => setSourceName(event.currentTarget.value)}
              />
              <input
                required
                type="url"
                placeholder="https://example.com/feed.xml"
                value={sourceUrl()}
                onInput={(event) => setSourceUrl(event.currentTarget.value)}
              />
              <Button type="submit" variant="outline" class="w-full">
                <Plus size={14} /> Add source
              </Button>
            </form>
          </section>
        </aside>
      </main>

      <Show when={panelOpen()}>
        <button
          class="panel-backdrop"
          aria-label="Close settings"
          onClick={() => setPanelOpen(false)}
        />
      </Show>
    </div>
  );
}
