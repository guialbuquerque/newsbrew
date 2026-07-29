import assert from "node:assert/strict";
import test from "node:test";
import { calculateRefreshPercent } from "./refresh-progress.ts";
import type { RefreshProgress } from "./types.ts";

function progress(
  phase: RefreshProgress["phase"],
  completed: number,
  total: number,
): RefreshProgress {
  return {
    status: phase === "completed" ? "completed" : "running",
    phase,
    percent: 0,
    sources: {
      completed: phase === "downloading" ? completed : 0,
      total: phase === "downloading" ? total : 0,
      failed: 0,
    },
    filters: {
      completed: phase === "filtering" ? completed : 0,
      total: phase === "filtering" ? total : 0,
      accepted: 0,
      maybe: 0,
      failed: 0,
    },
    analyses: {
      completed: phase === "analysing" ? completed : 0,
      total: phase === "analysing" ? total : 0,
      stored: 0,
      skipped: 0,
      failed: 0,
    },
  };
}

test("weights refresh phases across 0-10, 10-40, and 40-100", () => {
  assert.equal(calculateRefreshPercent(progress("downloading", 1, 2)), 5);
  assert.equal(calculateRefreshPercent(progress("filtering", 1, 2)), 25);
  assert.equal(calculateRefreshPercent(progress("analysing", 1, 2)), 70);
  assert.equal(calculateRefreshPercent(progress("completed", 0, 0)), 100);
});
