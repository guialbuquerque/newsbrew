import {
  Check,
  ChevronDown,
  ChevronUp,
  Cog,
  ExternalLink,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LogOut,
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
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { relatedImageForTopics } from "~/lib/images";
import type {
  Article,
  AuthStatus,
  DashboardState,
  Reaction,
  RefreshEvent,
  RefreshProgress,
  TopicRating,
} from "~/lib/types";
import "~/settings.css";

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

function progressMessage(progress: RefreshProgress) {
  if (progress.phase === "downloading") {
    return `${progress.sources.completed}/${progress.sources.total} sources downloaded`;
  }
  if (progress.phase === "filtering") {
    return `${progress.filters.completed}/${progress.filters.total} articles filtered · ${progress.filters.accepted} accepted · ${progress.filters.maybe} maybe`;
  }
  if (progress.phase === "analysing") {
    return `${progress.analyses.completed}/${progress.analyses.total} articles analysed · ${progress.analyses.stored} added · ${progress.analyses.skipped} skipped`;
  }
  if (progress.phase === "completed") {
    return `Refresh complete · ${progress.analyses.stored} added · ${progress.analyses.skipped} skipped`;
  }
  if (progress.phase === "failed") {
    return progress.error
      ? `Refresh failed: ${progress.error}`
      : "Refresh failed.";
  }
  if (progress.phase === "stopped") {
    return "Refresh stopped · completed analyses kept";
  }
  return "";
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
  let settingsDialog: HTMLDialogElement | undefined;
  let revealAnimationFrame: number | undefined;
  const [state, setState] = createSignal<DashboardState>();
  const [auth, setAuth] = createSignal<AuthStatus>();
  const [authLoading, setAuthLoading] = createSignal(true);
  const [authBusy, setAuthBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [feedSentinel, setFeedSentinel] = createSignal<HTMLDivElement>();
  const [refreshing, setRefreshing] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);
  const [refreshProgress, setRefreshProgress] =
    createSignal<RefreshProgress>();
  const [savingRating, setSavingRating] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [expandedIds, setExpandedIds] = createSignal<string[]>([]);
  const [ratingArticleId, setRatingArticleId] = createSignal<string>();
  const [draftRatings, setDraftRatings] = createSignal<
    Record<string, Reaction>
  >({});
  const [sourceName, setSourceName] = createSignal("");
  const [sourceUrl, setSourceUrl] = createSignal("");
  const [topicName, setTopicName] = createSignal("");
  const [topicReaction, setTopicReaction] = createSignal<Reaction>("like");
  const [pollInterval, setPollInterval] = createSignal("30");
  const [maxItems, setMaxItems] = createSignal("8");
  const [llmBaseURL, setLlmBaseURL] = createSignal("");
  const [llmModel, setLlmModel] = createSignal("");
  const [llmApiKey, setLlmApiKey] = createSignal("");
  const [generalGuidance, setGeneralGuidance] = createSignal("");
  const [accessTokenAttempt, setAccessTokenAttempt] = createSignal("");
  const [accessTokenDraft, setAccessTokenDraft] = createSignal("");

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

  function mergeArticles(...groups: Article[][]) {
    const byId = new Map<string, Article>();
    for (const group of groups) {
      for (const article of group) {
        if (!byId.has(article.id)) byId.set(article.id, article);
      }
    }
    return [...byId.values()].sort(
      (left, right) =>
        right.discoveredAt.localeCompare(left.discoveredAt) ||
        right.id.localeCompare(left.id),
    );
  }

  function animateFeedReveal(distance: number) {
    if (revealAnimationFrame !== undefined) {
      cancelAnimationFrame(revealAnimationFrame);
    }

    const start = window.scrollY;
    const target = Math.max(0, start + distance);
    if (
      target === start ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      window.scrollTo({ top: target, behavior: "auto" });
      revealAnimationFrame = undefined;
      return;
    }

    const startedAt = performance.now();
    const duration = 240;
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      window.scrollTo({
        top: start + (target - start) * eased,
        behavior: "auto",
      });
      if (progress < 1) {
        revealAnimationFrame = requestAnimationFrame(step);
      } else {
        revealAnimationFrame = undefined;
      }
    };
    revealAnimationFrame = requestAnimationFrame(step);
  }

  function preserveFeedPosition(
    update: () => void,
    revealNewItemsAtTop = false,
  ) {
    const firstArticle = document.querySelector<HTMLElement>(
      ".article-list > [data-feed-article]:first-child",
    );
    const firstArticleId = firstArticle?.dataset.feedArticle;
    const firstTop = firstArticle?.getBoundingClientRect().top;
    const statusBottom =
      document
        .querySelector<HTMLElement>(".feed-column > .notice")
        ?.getBoundingClientRect().bottom ?? 0;
    const wasAtTop =
      firstTop !== undefined && firstTop >= Math.max(0, statusBottom) - 4;

    update();

    if (!firstArticleId || firstTop === undefined) return;
    requestAnimationFrame(() => {
      const anchoredArticle = document.querySelector<HTMLElement>(
        `.article-list > [data-feed-article="${CSS.escape(firstArticleId)}"]`,
      );
      if (!anchoredArticle) return;
      const heightAdded =
        anchoredArticle.getBoundingClientRect().top - firstTop;
      if (heightAdded <= 0) return;

      window.scrollTo({
        top: window.scrollY + heightAdded,
        behavior: "auto",
      });
      if (wasAtTop && revealNewItemsAtTop) {
        requestAnimationFrame(() => {
          animateFeedReveal(-Math.min(40, window.scrollY));
        });
      }
    });
  }

  async function load(options: { clearNotice?: boolean } = {}) {
    try {
      const response = await fetch("/api/state");
      if (response.status === 401) {
        setLoading(false);
        return;
      }
      if (!response.ok) throw new Error("Could not load your digest");
      const next = (await response.json()) as DashboardState;
      const current = state();
      if (current) {
        const currentIds = new Set(
          current.articles.map((article) => article.id),
        );
        const hasNewArticles = next.articles.some(
          (article) => !currentIds.has(article.id),
        );
        preserveFeedPosition(
          () =>
            setState({
              ...next,
              articles: mergeArticles(next.articles, current.articles),
            }),
          hasNewArticles,
        );
      } else {
        setState(next);
      }
      setPollInterval(String(next.runtime.pollIntervalMinutes));
      setMaxItems(String(next.runtime.maxItemsPerSource));
      setLlmBaseURL(next.llm.baseURL);
      setLlmModel(next.llm.model);
      setGeneralGuidance(next.filter.generalGuidance);
      if (options.clearNotice) setNotice("");
    } catch (error) {
      setNotice(readError(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadMoreArticles() {
    const current = state();
    const cursor = current?.feed.nextCursor;
    if (!current?.feed.hasMore || !cursor || loadingMore()) return;

    let shouldContinue = false;
    setLoadingMore(true);
    try {
      const response = await fetch(
        `/api/state?cursor=${encodeURIComponent(cursor)}`,
      );
      if (response.status === 401) return;
      if (!response.ok) throw new Error("Could not load more stories");
      const next = (await response.json()) as DashboardState;
      setState((latest) => {
        if (!latest) return next;
        const existingIds = new Set(
          latest.articles.map((article) => article.id),
        );
        const added = next.articles.filter(
          (article) => !existingIds.has(article.id),
        ).length;
        shouldContinue = added === 0 && next.feed.hasMore;
        return {
          ...latest,
          articles: mergeArticles(latest.articles, next.articles),
          feed: next.feed,
        };
      });
    } catch (error) {
      setNotice(readError(error));
    } finally {
      setLoadingMore(false);
    }
    if (shouldContinue) queueMicrotask(() => void loadMoreArticles());
  }

  function prependLiveArticle(article: Article) {
    const current = state();
    if (!current || current.articles.some((item) => item.id === article.id)) {
      return;
    }

    preserveFeedPosition(
      () =>
        setState({
          ...current,
          articles: mergeArticles([article], current.articles),
        }),
      true,
    );
  }

  function applyProgress(progress: RefreshProgress) {
    setRefreshProgress(progress);
    if (progress.status === "running") {
      setRefreshing(true);
      if (!stopping()) setNotice(progressMessage(progress));
      return;
    }
    if (progress.status === "completed") {
      setRefreshing(false);
      setStopping(false);
      setNotice(progressMessage(progress));
      void load();
      return;
    }
    if (progress.status === "failed") {
      setRefreshing(false);
      setStopping(false);
      setNotice(progressMessage(progress));
      void load();
      return;
    }
    if (progress.status === "stopped") {
      setRefreshing(false);
      setStopping(false);
      setNotice(progressMessage(progress));
      void load();
    }
  }

  createEffect(() => {
    const sentinel = feedSentinel();
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreArticles();
        }
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(sentinel);
    onCleanup(() => observer.disconnect());
  });

  onMount(() => {
    void load();
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(
        `${protocol}//${window.location.host}/api/refresh-status`,
      );
      socket.addEventListener("message", (event) => {
        try {
          const refreshEvent = JSON.parse(String(event.data)) as RefreshEvent;
          if (refreshEvent.type === "article") {
            prependLiveArticle(refreshEvent.article);
          } else {
            applyProgress(refreshEvent.progress);
          }
        } catch {
          setNotice("Received an invalid refresh status update.");
        }
      });
      socket.addEventListener("close", () => {
        if (!stopped) reconnectTimer = setTimeout(connect, 1_500);
      });
    };

    connect();
    onCleanup(() => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (revealAnimationFrame !== undefined) {
        cancelAnimationFrame(revealAnimationFrame);
      }
      socket?.close();
    });
  });

  async function loadAuth() {
    try {
      const response = await fetch("/api/auth?action=status");
      if (!response.ok) throw new Error("Could not check authentication");
      const next = (await response.json()) as AuthStatus;
      setAuth(next);
      if (next.authenticated) await load({ clearNotice: true });
      else setLoading(false);
    } catch (error) {
      setNotice(readError(error));
      setLoading(false);
    } finally {
      setAuthLoading(false);
    }
  }

  onMount(() => loadAuth());

  async function signIn() {
    setAuthBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/auth?action=authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: accessTokenAttempt() }),
      });
      const result = (await response.json()) as {
        authenticated?: boolean;
        error?: string;
      };
      if (!response.ok || !result.authenticated) {
        throw new Error(result.error ?? "Incorrect access token");
      }
      setAccessTokenAttempt("");
      await loadAuth();
    } catch (error) {
      setNotice(readError(error));
    } finally {
      setAuthBusy(false);
    }
  }

  function randomIndex(length: number) {
    const limit = 256 - (256 % length);
    const bytes = new Uint8Array(1);
    do {
      crypto.getRandomValues(bytes);
    } while (bytes[0] >= limit);
    return bytes[0] % length;
  }

  function generateAccessToken() {
    const groups = [
      "ABCDEFGHJKLMNPQRSTUVWXYZ",
      "abcdefghijkmnopqrstuvwxyz",
      "23456789",
      "!@#$%&*+-=?_",
    ];
    const all = groups.join("");
    const characters = groups.map((group) => group[randomIndex(group.length)]);
    while (characters.length < 32) {
      characters.push(all[randomIndex(all.length)]);
    }
    for (let index = characters.length - 1; index > 0; index -= 1) {
      const swap = randomIndex(index + 1);
      [characters[index], characters[swap]] = [
        characters[swap],
        characters[index],
      ];
    }
    setAccessTokenDraft(characters.join(""));
  }

  async function saveAccessToken() {
    setAuthBusy(true);
    try {
      const response = await fetch("/api/auth?action=configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: accessTokenDraft() }),
      });
      const result = (await response.json()) as AuthStatus & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(result.error ?? "Could not save access settings");
      }
      setAuth(result);
      setNotice(
        result.required
          ? "Access token saved. Keep a copy somewhere safe."
          : "Access token removed. Authentication is disabled.",
      );
    } catch (error) {
      setNotice(readError(error));
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/auth?action=logout", { method: "POST" });
    window.location.reload();
  }

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
    setStopping(false);
    setRefreshing(true);
    setNotice("Starting refresh…");
    try {
      const response = await fetch("/api/refresh", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "Refresh failed");
      }
      const body = (await response.json()) as {
        status: "started" | "already_running";
        progress: RefreshProgress;
      };
      applyProgress(body.progress);
    } catch (error) {
      setNotice(readError(error));
      setRefreshing(false);
    }
  }

  async function stopRefresh() {
    setStopping(true);
    setNotice("Stopping refresh…");
    try {
      const response = await fetch("/api/refresh", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not stop the refresh");
      const body = (await response.json()) as {
        status: "stopping" | "idle";
        progress: RefreshProgress;
      };
      if (body.status === "idle") applyProgress(body.progress);
    } catch (error) {
      setStopping(false);
      setNotice(readError(error));
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
          : "Topic preferences saved for future filtering.",
      );
    } catch (error) {
      setNotice(readError(error));
    } finally {
      setSavingRating(false);
    }
  }

  async function addTopic(event: SubmitEvent) {
    event.preventDefault();
    try {
      const response = await fetch("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topicName(),
          reaction: topicReaction(),
        }),
      });
      if (!response.ok) throw new Error("Could not add topic");
      setTopicName("");
      await load();
      setNotice("Topic added.");
    } catch (error) {
      setNotice(readError(error));
    }
  }

  async function removeTopic(topic: string) {
    try {
      const response = await fetch(
        `/api/topics?topic=${encodeURIComponent(topic)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Could not remove topic");
      await load();
      setNotice("Topic removed.");
    } catch (error) {
      setNotice(readError(error));
    }
  }

  async function saveSettings(event: SubmitEvent) {
    event.preventDefault();
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pollIntervalMinutes: Number(pollInterval()),
          maxItemsPerSource: Number(maxItems()),
          llmBaseURL: llmBaseURL(),
          llmModel: llmModel(),
          generalGuidance: generalGuidance(),
          ...(llmApiKey() ? { llmApiKey: llmApiKey() } : {}),
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? "Could not save settings");
      }
      setLlmApiKey("");
      await load();
      setNotice("Settings saved.");
    } catch (error) {
      setNotice(readError(error));
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
      <Show when={!authLoading() && !auth()?.authenticated}>
        <div class="auth-gate">
          <Card class="auth-card">
            <span class="auth-mark"><KeyRound size={24} /></span>
            <p class="auth-eyebrow">PRIVATE BRIEFING</p>
            <h1>Open Newsbrew</h1>
            <p>Enter the access token configured for this Newsbrew instance.</p>
            <form
              class="auth-token-form"
              onSubmit={(event) => {
                event.preventDefault();
                void signIn();
              }}
            >
              <input
                required
                type="text"
                autocomplete="off"
                spellcheck={false}
                placeholder="Access token"
                value={accessTokenAttempt()}
                onInput={(event) =>
                  setAccessTokenAttempt(event.currentTarget.value)
                }
              />
              <Button type="submit" variant="accent" disabled={authBusy()}>
                <KeyRound size={15} />
                {authBusy() ? "Checking…" : "Open Newsbrew"}
              </Button>
            </form>
            <Show when={notice()}>
              <div class="notice" role="status">{notice()}</div>
            </Show>
          </Card>
        </div>
      </Show>
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
            aria-haspopup="dialog"
            aria-controls="settings-dialog"
            onClick={() => settingsDialog?.showModal()}
          >
            <Cog size={14} /> Settings
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
            <div
              classList={{
                notice: true,
                "refresh-notice": Boolean(refreshProgress()),
              }}
              style={`--refresh-progress: ${refreshProgress()?.percent ?? 0}%`}
            >
              <div class="notice-status">
                <Show when={refreshing()}>
                  <LoaderCircle
                    class="notice-spinner animate-spin"
                    aria-hidden="true"
                    size={14}
                  />
                </Show>
                <span role="status" aria-live="polite">{notice()}</span>
                <Show when={refreshing()}>
                  <button
                    class="stop-refresh"
                    type="button"
                    disabled={stopping()}
                    onClick={stopRefresh}
                  >
                    <X size={12} />
                    {stopping() ? "Stopping…" : "Stop"}
                  </button>
                </Show>
              </div>
            </div>
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
                    Add feeds and preference signals, then refresh the digest
                    to scan for stories.
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
                        <Card
                          data-feed-article={article.id}
                          class="article-card hidden-article"
                        >
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
                      <Card
                        data-feed-article={article.id}
                        class={
                          article.filterDecision === "maybe"
                            ? "article-card maybe-article"
                            : "article-card"
                        }
                      >
                        <ArticleImage article={article} />
                        <div class="article-body">
                          <div class="article-meta">
                            <span>{article.sourceName}</span>
                            <span class="meta-separator">•</span>
                            <span>{formatWhen(article.publishedAt ?? article.discoveredAt)}</span>
                            <Show when={article.filterDecision === "maybe"}>
                              <span class="maybe-label">Maybe</span>
                            </Show>
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
                              <div class="points-markdown">
                                {article.pointsMarkdown}
                              </div>
                              <div class="topic-list">
                                <For each={article.topics}>
                                  {(topic) => <Badge>{topic}</Badge>}
                                </For>
                              </div>
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
              <Show when={state()?.feed.hasMore}>
                <div
                  ref={setFeedSentinel}
                  class="feed-sentinel"
                  aria-live="polite"
                >
                  <Show when={loadingMore()}>
                    <LoaderCircle class="animate-spin" size={18} />
                    <span>Loading more stories…</span>
                  </Show>
                </div>
              </Show>
            </Show>
          </Show>
        </section>

        <dialog
          ref={settingsDialog}
          id="settings-dialog"
          class="settings-modal"
          closedby="any"
          aria-labelledby="settings-title"
          aria-describedby="settings-description"
        >
              <header class="settings-modal-header">
                <div>
                  <span class="settings-eyebrow">NEWSBREW</span>
                  <h1 id="settings-title">Settings</h1>
                  <p id="settings-description">
                    Tune your sources, filtering, model and private access.
                  </p>
                </div>
                <Button
                  autofocus
                  variant="ghost"
                  size="icon"
                  aria-label="Close settings"
                  onClick={() => settingsDialog?.close()}
                >
                  <X size={18} />
                </Button>
              </header>

              <div class="settings-modal-body">
          <section class="panel-section settings-topic-section">
            <div class="panel-heading">
              <span class="panel-icon"><SlidersHorizontal size={15} /></span>
              <div>
                <h2>Topic signals</h2>
                <p>These support your natural-language guidance.</p>
              </div>
            </div>
            <details class="topic-preferences" open>
              <summary>
                Topic signals
                <span>{likedTopics().length} liked · {dislikedTopics().length} disliked</span>
              </summary>
              <div class="preference-group">
                <strong>Like</strong>
                <div>
                  <For each={likedTopics()}>
                    {(topic) => (
                      <span class="editable-topic">
                        <Badge>{topic.topic}</Badge>
                        <button
                          type="button"
                          aria-label={`Remove ${topic.topic}`}
                          onClick={() => removeTopic(topic.topic)}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    )}
                  </For>
                </div>
              </div>
              <div class="preference-group dislike">
                <strong>Dislike</strong>
                <div>
                  <For each={dislikedTopics()}>
                    {(topic) => (
                      <span class="editable-topic">
                        <Badge>{topic.topic}</Badge>
                        <button
                          type="button"
                          aria-label={`Remove ${topic.topic}`}
                          onClick={() => removeTopic(topic.topic)}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    )}
                  </For>
                </div>
              </div>
            </details>
            <form class="topic-form" onSubmit={addTopic}>
              <input
                required
                maxlength="100"
                placeholder="Add a topic"
                value={topicName()}
                onInput={(event) => setTopicName(event.currentTarget.value)}
              />
              <select
                value={topicReaction()}
                onChange={(event) =>
                  setTopicReaction(event.currentTarget.value as Reaction)
                }
              >
                <option value="like">Like</option>
                <option value="dislike">Dislike</option>
              </select>
              <Button type="submit" variant="outline" size="sm">
                <Plus size={14} /> Add
              </Button>
            </form>
            <p class="learning-note">
              <Sparkles size={13} />
              Topic ratings update these signals and are included in future
              filtering prompts.
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

          <section class="panel-section settings-runtime">
            <div class="panel-heading">
              <span class="panel-icon"><Cog size={15} /></span>
              <div>
                <h2>Filtering, runtime and model</h2>
                <p>Private settings stored in the Newsbrew database.</p>
              </div>
            </div>
            <form class="settings-form" onSubmit={saveSettings}>
              <label>
                General guidance
                <textarea
                  maxlength="5000"
                  rows="8"
                  placeholder="Describe the kinds of reporting and treatment you generally want or want to avoid."
                  value={generalGuidance()}
                  onInput={(event) =>
                    setGeneralGuidance(event.currentTarget.value)
                  }
                />
                <span>
                  Natural-language guidance is considered before the topic
                  signals.
                </span>
              </label>
              <label>
                Poll interval, minutes
                <input
                  required
                  type="number"
                  min="1"
                  step="1"
                  value={pollInterval()}
                  onInput={(event) =>
                    setPollInterval(event.currentTarget.value)
                  }
                />
              </label>
              <label>
                Items per source
                <input
                  required
                  type="number"
                  min="1"
                  step="1"
                  value={maxItems()}
                  onInput={(event) => setMaxItems(event.currentTarget.value)}
                />
              </label>
              <label>
                Responses API base URL
                <input
                  required
                  type="url"
                  value={llmBaseURL()}
                  onInput={(event) => setLlmBaseURL(event.currentTarget.value)}
                />
              </label>
              <label>
                Model
                <input
                  required
                  value={llmModel()}
                  onInput={(event) => setLlmModel(event.currentTarget.value)}
                />
              </label>
              <label>
                API key
                <input
                  type="password"
                  autocomplete="new-password"
                  placeholder={
                    state()?.llm.hasApiKey
                      ? "Stored — leave blank to keep"
                      : "API key"
                  }
                  value={llmApiKey()}
                  onInput={(event) => setLlmApiKey(event.currentTarget.value)}
                />
              </label>
              <Button type="submit" variant="accent" class="w-full">
                <Check size={14} /> Save settings
              </Button>
            </form>
          </section>

          <section class="panel-section auth-settings">
            <div class="panel-heading">
              <span class="panel-icon"><KeyRound size={15} /></span>
              <div>
                <h2>Access</h2>
                <p>
                  Leave blank for open access, or set one shared token.
                </p>
              </div>
            </div>
            <input
              class="access-token-input"
              type="text"
              autocomplete="off"
              spellcheck={false}
              maxlength="512"
              placeholder={
                auth()?.required
                  ? "Enter a replacement, or blank to disable"
                  : "No access token"
              }
              value={accessTokenDraft()}
              onInput={(event) =>
                setAccessTokenDraft(event.currentTarget.value)
              }
            />
            <div class="access-token-actions">
              <Button
                type="button"
                variant="outline"
                disabled={authBusy()}
                onClick={generateAccessToken}
              >
                Generate
              </Button>
              <Button
                type="button"
                variant="accent"
                disabled={authBusy()}
                onClick={saveAccessToken}
              >
                <Check size={14} /> Save access
              </Button>
            </div>
            <Show when={auth()?.required}>
              <Button
                type="button"
                variant="ghost"
                class="w-full"
                onClick={signOut}
              >
                <LogOut size={14} /> Sign out
              </Button>
            </Show>
          </section>
              </div>
        </dialog>
      </main>
    </div>
  );
}
