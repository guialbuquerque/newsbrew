import type {
  BenchmarkCandidate,
  BenchmarkDecision,
} from "./config.ts";

export type BenchmarkDecisionResult = BenchmarkCandidate & {
  predicted?: BenchmarkDecision;
  valid: boolean;
  durationMs: number;
  output: string;
  reasoning?: string;
  error?: string;
  sessionNumber?: number;
  sessionTurn?: number;
  stats?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    tokensPerSecond?: number;
    timeToFirstTokenSeconds?: number;
    modelLoadTimeSeconds?: number;
  };
};

const labels = ["YES", "MAYBE", "NO"] as const;

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? undefined : numerator / denominator;
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

export function benchmarkMetrics(decisions: BenchmarkDecisionResult[]) {
  const confusion = Object.fromEntries(
    labels.map((expected) => [
      expected,
      Object.fromEntries(labels.map((predicted) => [predicted, 0])),
    ]),
  ) as Record<
    BenchmarkDecision,
    Record<BenchmarkDecision, number>
  >;
  const expectedCounts = Object.fromEntries(
    labels.map((label) => [label, 0]),
  ) as Record<BenchmarkDecision, number>;
  let exactCorrect = 0;
  let passRejectCorrect = 0;
  let invalid = 0;

  for (const decision of decisions) {
    expectedCounts[decision.expected] += 1;
    if (!decision.predicted) {
      invalid += 1;
      continue;
    }
    confusion[decision.expected][decision.predicted] += 1;
    if (decision.expected === decision.predicted) exactCorrect += 1;
    if (
      (decision.expected === "NO") === (decision.predicted === "NO")
    ) {
      passRejectCorrect += 1;
    }
  }

  const predictedYes =
    confusion.YES.YES + confusion.MAYBE.YES + confusion.NO.YES;
  const durationMs = decisions.reduce(
    (sum, decision) => sum + decision.durationMs,
    0,
  );
  const latencies = decisions.map((decision) => decision.durationMs);
  const sources = [...new Set(decisions.map((decision) => decision.sourceName))]
    .sort((left, right) => left.localeCompare(right))
    .map((sourceName) => {
      const sourceDecisions = decisions.filter(
        (decision) => decision.sourceName === sourceName,
      );
      const correct = sourceDecisions.filter(
        (decision) => decision.predicted === decision.expected,
      ).length;
      return {
        sourceName,
        total: sourceDecisions.length,
        correct,
        exactAccuracy: ratio(correct, sourceDecisions.length),
      };
    });

  return {
    total: decisions.length,
    valid: decisions.length - invalid,
    invalid,
    expectedCounts,
    exactCorrect,
    exactAccuracy: ratio(exactCorrect, decisions.length),
    passRejectCorrect,
    passRejectAccuracy: ratio(passRejectCorrect, decisions.length),
    yesPrecision: ratio(confusion.YES.YES, predictedYes),
    wantedRecall: ratio(confusion.YES.YES, expectedCounts.YES),
    neutralRecall: ratio(confusion.MAYBE.MAYBE, expectedCounts.MAYBE),
    explicitRejectRecall: ratio(confusion.NO.NO, expectedCounts.NO),
    confusion,
    durationMs,
    itemsPerSecond:
      durationMs === 0 ? undefined : decisions.length / (durationMs / 1000),
    medianLatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    perSource: sources,
  };
}
