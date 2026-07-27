import type { RefreshProgress } from "./types.ts";

export function calculateRefreshPercent(progress: RefreshProgress) {
  if (progress.phase === "downloading") {
    return progress.sources.total
      ? (progress.sources.completed / progress.sources.total) * 10
      : 0;
  }
  if (progress.phase === "filtering") {
    return (
      10 +
      (progress.filters.total
        ? (progress.filters.completed / progress.filters.total) * 30
        : 30)
    );
  }
  if (progress.phase === "analysing") {
    return (
      40 +
      (progress.analyses.total
        ? (progress.analyses.completed / progress.analyses.total) * 60
        : 60)
    );
  }
  if (progress.phase === "completed") return 100;
  return progress.percent;
}
