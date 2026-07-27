import { randomUUID } from "node:crypto";
import { runIngestionSafely } from "./ingest.ts";
import type { RefreshProgress } from "./types.ts";

type RefreshListener = (progress: RefreshProgress) => void;

type RefreshRuntime = {
  progress: RefreshProgress;
  activeRun?: Promise<void>;
  abortController?: AbortController;
  listeners: Set<RefreshListener>;
};

const emptyProgress: RefreshProgress = {
  status: "idle",
  phase: "idle",
  percent: 0,
  sources: { completed: 0, total: 0, failed: 0 },
  filters: { completed: 0, total: 0, accepted: 0, failed: 0 },
  analyses: {
    completed: 0,
    total: 0,
    stored: 0,
    rejected: 0,
    failed: 0,
  },
};

const sharedGlobal = globalThis as typeof globalThis & {
  __newsbrewRefreshRuntime?: RefreshRuntime;
};
const runtime =
  sharedGlobal.__newsbrewRefreshRuntime ??
  (sharedGlobal.__newsbrewRefreshRuntime = {
    progress: emptyProgress,
    listeners: new Set(),
  });

function publish(progress: RefreshProgress) {
  runtime.progress = progress;
  for (const listener of runtime.listeners) listener(progress);
}

export function getRefreshProgress() {
  return runtime.progress;
}

export function subscribeToRefresh(listener: RefreshListener) {
  runtime.listeners.add(listener);
  return () => runtime.listeners.delete(listener);
}

export function startRefresh() {
  if (runtime.activeRun) {
    return {
      started: false,
      progress: getRefreshProgress(),
    };
  }

  const runId = randomUUID();
  const abortController = new AbortController();
  runtime.abortController = abortController;
  const startedAt = new Date().toISOString();
  publish({
    ...emptyProgress,
    runId,
    status: "running",
    phase: "downloading",
    percent: 0,
    startedAt,
  });

  runtime.activeRun = runIngestionSafely({
    runId,
    onProgress: publish,
    abortController,
  })
    .then(() => undefined)
    .catch((error) => {
      if (abortController.signal.aborted) {
        console.info("[refresh] Refresh stopped; pending rows discarded");
        publish({
          ...runtime.progress,
          status: "stopped",
          phase: "stopped",
          completedAt: new Date().toISOString(),
        });
        return;
      }
      publish({
        ...runtime.progress,
        status: "failed",
        phase: "failed",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      runtime.activeRun = undefined;
      runtime.abortController = undefined;
    });

  return {
    started: true,
    progress: getRefreshProgress(),
  };
}

export function stopRefresh() {
  if (!runtime.activeRun || !runtime.abortController) {
    return {
      stopped: false,
      progress: getRefreshProgress(),
    };
  }
  runtime.abortController.abort(
    new DOMException("Refresh stopped by user", "AbortError"),
  );
  return {
    stopped: true,
    progress: getRefreshProgress(),
  };
}
