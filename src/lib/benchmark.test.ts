import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  benchmarkDataPath,
  benchmarkReferenceSchema,
} from "../benchmark/config.ts";
import {
  benchmarkMetrics,
  type BenchmarkDecisionResult,
} from "../benchmark/metrics.ts";

test("benchmark data paths cannot escape the config directory or omit the prefix", () => {
  assert.equal(
    benchmarkDataPath("benchmark-results.json"),
    join(
      homedir(),
      ".config",
      "wes-dev",
      "newsbrew",
      "benchmark-results.json",
    ),
  );
  assert.throws(() => benchmarkDataPath("../benchmark-results.json"));
  assert.throws(() => benchmarkDataPath("results.json"));
  assert.throws(() => benchmarkDataPath("benchmark-results.txt"));
});

test("benchmark reference requires explicit tri-state labels", () => {
  const valid = benchmarkReferenceSchema.safeParse({
    version: 1,
    items: [
      {
        id: "one",
        sourceName: "Example",
        headline: "Example headline",
        expected: "MAYBE",
      },
    ],
  });
  assert.equal(valid.success, true);

  const legacy = benchmarkReferenceSchema.safeParse({
    version: 1,
    items: [
      {
        id: "one",
        sourceName: "Example",
        headline: "Example headline",
        expected: false,
      },
    ],
  });
  assert.equal(legacy.success, false);
});

test("benchmark metrics preserve three-way and pass-reject semantics", () => {
  const decisions: BenchmarkDecisionResult[] = [
    {
      id: "yes",
      sourceName: "One",
      headline: "Wanted",
      byline: "",
      expected: "YES",
      predicted: "MAYBE",
      valid: true,
      durationMs: 100,
      output: "MAYBE",
    },
    {
      id: "maybe",
      sourceName: "One",
      headline: "Neutral",
      byline: "",
      expected: "MAYBE",
      predicted: "MAYBE",
      valid: true,
      durationMs: 200,
      output: "MAYBE",
    },
    {
      id: "no",
      sourceName: "Two",
      headline: "Reject",
      byline: "",
      expected: "NO",
      predicted: "NO",
      valid: true,
      durationMs: 300,
      output: "NO",
    },
  ];

  const metrics = benchmarkMetrics(decisions);
  assert.equal(metrics.exactAccuracy, 2 / 3);
  assert.equal(metrics.passRejectAccuracy, 1);
  assert.equal(metrics.wantedRecall, 0);
  assert.equal(metrics.neutralRecall, 1);
  assert.equal(metrics.explicitRejectRecall, 1);
  assert.deepEqual(metrics.confusion.YES, {
    YES: 0,
    MAYBE: 1,
    NO: 0,
  });
});
