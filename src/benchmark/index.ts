#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { filterSystemPrompt } from "../lib/ai/prompts.ts";
import type { TopicPreference } from "../lib/types.ts";
import {
  benchmarkDataDirectory,
  benchmarkDataPath,
  defaultBenchmarkConfigFile,
  defaultBenchmarkOutputFile,
  defaultBenchmarkReferenceFile,
  readBenchmarkConfig,
  readBenchmarkReference,
  type BenchmarkCandidate,
  type BenchmarkConfig,
  type BenchmarkDecision,
  type BenchmarkReasoningMode,
} from "./config.ts";
import {
  benchmarkMetrics,
  type BenchmarkDecisionResult,
} from "./metrics.ts";

type JsonObject = Record<string, unknown>;

type Model = {
  key: string;
  display_name?: string;
  size_bytes?: number;
  params_string?: string;
  format?: string;
  quantization?: { name?: string };
  capabilities?: {
    reasoning?: { allowed_options?: string[]; default?: string };
  };
  reasoning?: { allowed_options?: string[]; default?: string };
  loaded_instances?: Array<{ id?: string }>;
  type?: string;
};

type RunMode = {
  id: BenchmarkReasoningMode;
  label: string;
  reasoning?: Exclude<BenchmarkReasoningMode, "default">;
};

function option(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(
    prefix.length,
  );
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function positiveIntegerOption(name: string) {
  const raw = option(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage:
  pnpm benchmark [options]

Options:
  --config=benchmark-NAME.json     Private config in the Newsbrew data directory
  --reference=benchmark-NAME.json  Private reference set in the data directory
  --output=benchmark-NAME.json     Private report in the data directory
  --model=TEXT                     Test only matching local model names
  --limit=N                        Use the first N shuffled reference items
  --show-misses                    Print misclassified item IDs and headlines
  --help                           Show this help

Defaults:
  ~/.config/wes-dev/newsbrew/${defaultBenchmarkConfigFile}
  ~/.config/wes-dev/newsbrew/${defaultBenchmarkReferenceFile}
  ~/.config/wes-dev/newsbrew/${defaultBenchmarkOutputFile}

All benchmark files must stay in the Newsbrew data directory and begin with
benchmark-. The command does not start LM Studio or download models.`);
}

function serverRoot(baseURL: string) {
  const url = new URL(baseURL);
  url.pathname = url.pathname
    .replace(/\/api\/v1\/?$/, "")
    .replace(/\/v1\/?$/, "")
    .replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function compactError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object"
    ? (value as JsonObject)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function messageText(payload: JsonObject) {
  return Array.isArray(payload.output)
    ? payload.output
        .filter((item) => asObject(item).type === "message")
        .map((item) => stringValue(asObject(item).content) ?? "")
        .join("\n")
        .trim()
    : "";
}

function reasoningText(payload: JsonObject) {
  return Array.isArray(payload.output)
    ? payload.output
        .filter((item) => asObject(item).type === "reasoning")
        .map((item) => stringValue(asObject(item).content) ?? "")
        .join("\n")
        .trim()
    : "";
}

function parseDecision(output: string): BenchmarkDecision | undefined {
  const normalized = output.trim().toLocaleUpperCase("en-GB");
  return normalized === "YES" ||
    normalized === "MAYBE" ||
    normalized === "NO"
    ? normalized
    : undefined;
}

function candidatePrompt(candidate: BenchmarkCandidate) {
  return `Headline: ${candidate.headline}
Byline: ${candidate.byline}
Source: ${candidate.sourceName}`;
}

function topicPreferences(config: BenchmarkConfig): TopicPreference[] {
  return [
    ...config.preferences.like.map(
      (topic): TopicPreference => ({
        topic,
        reaction: "like",
        source: "rating",
      }),
    ),
    ...config.preferences.dislike.map(
      (topic): TopicPreference => ({
        topic,
        reaction: "dislike",
        source: "rating",
      }),
    ),
  ];
}

function modelReasoning(model: Model) {
  return model.capabilities?.reasoning ?? model.reasoning;
}

function modesFor(model: Model, requested: BenchmarkReasoningMode[]) {
  const allowed = modelReasoning(model)?.allowed_options ?? [];
  const modes: RunMode[] = [];
  const skipped: Array<{ mode: BenchmarkReasoningMode; reason: string }> = [];
  for (const mode of [...new Set(requested)]) {
    if (mode === "default") {
      modes.push({ id: mode, label: "model default" });
    } else if (allowed.includes(mode)) {
      modes.push({ id: mode, label: `reasoning ${mode}`, reasoning: mode });
    } else {
      skipped.push({
        mode,
        reason:
          allowed.length === 0
            ? "model does not expose reasoning controls"
            : `model allows only: ${allowed.join(", ")}`,
      });
    }
  }
  return { modes, skipped };
}

function seededShuffle<T>(values: T[], seed: number) {
  const output = [...values];
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let index = output.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [output[index], output[other]] = [output[other], output[index]];
  }
  return output;
}

async function requestJson(
  url: string,
  options: {
    method?: string;
    apiKey?: string;
    timeoutMs: number;
    body?: JsonObject;
  },
) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(options.apiKey
        ? { Authorization: `Bearer ${options.apiKey}` }
        : {}),
      ...(options.body
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const object = asObject(payload);
    const error = asObject(object.error);
    const detail =
      stringValue(error.message) ??
      stringValue(object.error) ??
      stringValue(object.message) ??
      stringValue(object.raw) ??
      response.statusText;
    throw new Error(`${response.status} ${response.statusText}: ${detail}`);
  }
  return asObject(payload);
}

async function runMode(options: {
  root: string;
  apiKey: string;
  timeoutMs: number;
  contextLength: number;
  temperature: number;
  systemPrompt: string;
  model: Model;
  mode: RunMode;
  candidates: BenchmarkCandidate[];
}) {
  const decisions: BenchmarkDecisionResult[] = [];
  const responseIds: string[] = [];
  const instanceIds = new Set<string>();
  let previousResponseId: string | undefined;
  let activeInstanceId: string | undefined;
  let sessionTokens = 0;
  let largestTurnTokens = 0;
  let sessionTurn = 0;
  let sessionCount = 0;
  let failureReason: string | undefined;

  process.stderr.write(
    `  ${options.mode.label.padEnd(18)} ${String(options.candidates.length).padStart(3)} items `,
  );

  for (const [index, candidate] of options.candidates.entries()) {
    const started = performance.now();
    const startedNewSession = previousResponseId === undefined;
    if (startedNewSession) {
      sessionTokens = 0;
      largestTurnTokens = 0;
      sessionTurn = 0;
      activeInstanceId = undefined;
      sessionCount += 1;
    }

    try {
      const payload = await requestJson(`${options.root}/api/v1/chat`, {
        method: "POST",
        apiKey: options.apiKey,
        timeoutMs: options.timeoutMs,
        body: {
          model: options.model.key,
          system_prompt: options.systemPrompt,
          input: candidatePrompt(candidate),
          ...(previousResponseId
            ? { previous_response_id: previousResponseId }
            : { context_length: options.contextLength }),
          ...(options.mode.reasoning
            ? { reasoning: options.mode.reasoning }
            : {}),
          temperature: options.temperature,
          store: true,
        },
      });
      const output = messageText(payload);
      const predicted = parseDecision(output);
      const responseId = stringValue(payload.response_id);
      const instanceId = stringValue(payload.model_instance_id);
      const stats = asObject(payload.stats);
      const inputTokens = numberValue(stats.input_tokens);
      const outputTokens = numberValue(stats.total_output_tokens);
      const reasoningTokens = numberValue(stats.reasoning_output_tokens);
      const totalTokens =
        inputTokens === undefined || outputTokens === undefined
          ? undefined
          : inputTokens + outputTokens;

      if (!responseId) {
        throw new Error("LM Studio did not return a response_id");
      }
      if (!instanceId) {
        throw new Error("LM Studio did not return a model_instance_id");
      }
      if (activeInstanceId && activeInstanceId !== instanceId) {
        throw new Error(
          `LM Studio switched model instances within a session (${activeInstanceId} to ${instanceId})`,
        );
      }
      activeInstanceId = instanceId;
      instanceIds.add(instanceId);
      responseIds.push(responseId);
      if (
        options.mode.reasoning === "off" &&
        reasoningTokens !== undefined &&
        reasoningTokens > 0
      ) {
        throw new Error(
          `Reasoning-off control failed: LM Studio reported ${reasoningTokens} reasoning tokens`,
        );
      }
      if (!predicted) {
        decisions.push({
          ...candidate,
          valid: false,
          durationMs: Math.round(performance.now() - started),
          output,
          reasoning: reasoningText(payload),
          error: "Expected exactly YES, MAYBE, or NO",
          sessionNumber: sessionCount,
          sessionTurn: sessionTurn + 1,
          stats: {
            inputTokens,
            outputTokens,
            reasoningTokens,
            tokensPerSecond: numberValue(stats.tokens_per_second),
            timeToFirstTokenSeconds: numberValue(
              stats.time_to_first_token_seconds,
            ),
            modelLoadTimeSeconds: numberValue(
              stats.model_load_time_seconds,
            ),
          },
        });
        previousResponseId = undefined;
        process.stderr.write("?");
        continue;
      }

      sessionTurn += 1;
      if (totalTokens !== undefined) {
        sessionTokens += totalTokens;
        largestTurnTokens = Math.max(largestTurnTokens, totalTokens);
      }
      const shouldRollover =
        totalTokens !== undefined &&
        sessionTokens + largestTurnTokens >= options.contextLength;
      previousResponseId = shouldRollover ? undefined : responseId;
      decisions.push({
        ...candidate,
        predicted,
        valid: true,
        durationMs: Math.round(performance.now() - started),
        output,
        reasoning: reasoningText(payload),
        sessionNumber: sessionCount,
        sessionTurn,
        stats: {
          inputTokens,
          outputTokens,
          reasoningTokens,
          tokensPerSecond: numberValue(stats.tokens_per_second),
          timeToFirstTokenSeconds: numberValue(
            stats.time_to_first_token_seconds,
          ),
          modelLoadTimeSeconds: numberValue(stats.model_load_time_seconds),
        },
      });
      process.stderr.write(predicted === candidate.expected ? "." : "x");
    } catch (error) {
      const message = compactError(error);
      failureReason = failureReason ?? message;
      decisions.push({
        ...candidate,
        valid: false,
        durationMs: Math.round(performance.now() - started),
        output: "",
        error: message,
        sessionNumber: sessionCount,
        sessionTurn: sessionTurn + 1,
      });
      previousResponseId = undefined;
      process.stderr.write("!");
      break;
    }

    if ((index + 1) % 20 === 0 && index + 1 < options.candidates.length) {
      process.stderr.write(" ");
    }
  }
  process.stderr.write("\n");

  const metrics = benchmarkMetrics(decisions);
  return {
    model: options.model.key,
    displayName: options.model.display_name,
    modelSizeBytes: options.model.size_bytes,
    params: options.model.params_string,
    format: options.model.format,
    quantization: options.model.quantization?.name,
    mode: options.mode.id,
    modeLabel: options.mode.label,
    completed: decisions.length === options.candidates.length,
    expectedTotal: options.candidates.length,
    valid:
      decisions.length === options.candidates.length && metrics.invalid === 0,
    failureReason,
    sessionStrategy: "sequential stateful chain with context-aware rollover",
    sessionCount,
    responseIds,
    instanceIds: [...instanceIds],
    metrics,
    decisions,
  };
}

async function unloadNewInstances(options: {
  root: string;
  apiKey: string;
  timeoutMs: number;
  modelKey: string;
  preserveIds: Set<string>;
}) {
  const payload = await requestJson(`${options.root}/api/v1/models`, {
    apiKey: options.apiKey,
    timeoutMs: Math.min(options.timeoutMs, 10_000),
  });
  const models = Array.isArray(payload.models)
    ? (payload.models as Model[])
    : [];
  const model = models.find((candidate) => candidate.key === options.modelKey);
  const ids = (model?.loaded_instances ?? [])
    .map((instance) => instance.id)
    .filter(
      (id): id is string =>
        typeof id === "string" && !options.preserveIds.has(id),
    );
  const unloaded: string[] = [];
  const failed: Array<{ instanceId: string; error: string }> = [];
  for (const instanceId of ids) {
    try {
      await requestJson(`${options.root}/api/v1/models/unload`, {
        method: "POST",
        apiKey: options.apiKey,
        timeoutMs: Math.min(options.timeoutMs, 30_000),
        body: { instance_id: instanceId },
      });
      unloaded.push(instanceId);
    } catch (error) {
      failed.push({ instanceId, error: compactError(error) });
    }
  }
  return { unloaded, failed };
}

function fingerprint(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

function percent(value: number | undefined) {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function summaryRow(result: Awaited<ReturnType<typeof runMode>>) {
  return {
    model: result.displayName ?? result.model,
    mode: result.modeLabel,
    valid: result.valid ? "yes" : "no",
    exact: percent(result.metrics.exactAccuracy),
    pass_reject: percent(result.metrics.passRejectAccuracy),
    yes_precision: percent(result.metrics.yesPrecision),
    wanted_recall: percent(result.metrics.wantedRecall),
    neutral_recall: percent(result.metrics.neutralRecall),
    reject_recall: percent(result.metrics.explicitRejectRecall),
    median_ms: result.metrics.medianLatencyMs,
    p95_ms: result.metrics.p95LatencyMs,
  };
}

async function writeReport(path: string, report: JsonObject) {
  await mkdir(benchmarkDataDirectory, { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

async function main() {
  if (hasFlag("help")) {
    printHelp();
    return;
  }

  const configFilename = option("config") ?? defaultBenchmarkConfigFile;
  const referenceFilename =
    option("reference") ?? defaultBenchmarkReferenceFile;
  const outputFilename = option("output") ?? defaultBenchmarkOutputFile;
  const outputPath = benchmarkDataPath(outputFilename);
  const [loadedConfig, loadedReference] = await Promise.all([
    readBenchmarkConfig(configFilename),
    readBenchmarkReference(referenceFilename),
  ]);
  const config = loadedConfig.value;
  const root = serverRoot(config.lmStudio.baseURL);
  const modelFilter = option("model")?.toLocaleLowerCase("en-GB");
  const requestedLimit = positiveIntegerOption("limit");
  const shuffled = seededShuffle(
    loadedReference.value.items,
    config.run.shuffleSeed,
  );
  const candidates = requestedLimit
    ? shuffled.slice(0, requestedLimit)
    : shuffled;
  if (requestedLimit && requestedLimit > shuffled.length) {
    throw new Error(
      `--limit cannot exceed the ${shuffled.length} reference items`,
    );
  }
  const expectedCounts = benchmarkMetrics(
    candidates.map((candidate) => ({
      ...candidate,
      valid: false,
      durationMs: 0,
      output: "",
    })),
  ).expectedCounts;
  const missingClasses = (["YES", "MAYBE", "NO"] as const).filter(
    (label) => expectedCounts[label] === 0,
  );
  const referenceValidForThreeClassComparison = missingClasses.length === 0;

  console.log("Newsbrew model benchmark");
  console.log(`Server: ${root}`);
  console.log(
    `Reference: ${candidates.length}/${loadedReference.value.items.length} items ` +
      `(${expectedCounts.YES} YES, ${expectedCounts.MAYBE} MAYBE, ${expectedCounts.NO} NO)`,
  );
  console.log(
    "Inference: production tri-state prompt, sequential stateful chain, context-aware rollover",
  );
  console.log(
    `Reasoning modes: ${config.run.reasoningModes.join(", ")}; output: ${outputPath}`,
  );
  console.log(
    "The command will not start LM Studio and unloads only model instances it creates.\n",
  );
  if (!referenceValidForThreeClassComparison) {
    console.warn(
      `WARNING: reference set has no ${missingClasses.join(", ")} labels. ` +
        "Runs will be reported but not ranked as valid three-class comparisons.\n",
    );
  }

  let payload: JsonObject;
  try {
    payload = await requestJson(`${root}/api/v1/models`, {
      apiKey: config.lmStudio.apiKey,
      timeoutMs: Math.min(config.run.requestTimeoutMs, 10_000),
    });
  } catch (error) {
    throw new Error(
      `Cannot reach LM Studio at ${root}. Start its API server manually and rerun. ` +
        `Original error: ${compactError(error)}`,
    );
  }
  const allModels = Array.isArray(payload.models)
    ? (payload.models as Model[])
    : [];
  const models = allModels.filter(
    (model) =>
      model.type === "llm" &&
      (!modelFilter ||
        `${model.key} ${model.display_name ?? ""}`
          .toLocaleLowerCase("en-GB")
          .includes(modelFilter)),
  );
  if (models.length === 0) {
    throw new Error(
      modelFilter
        ? `No downloaded LLM matches --model=${option("model")}`
        : "LM Studio did not report any downloaded LLMs",
    );
  }

  const prompt = filterSystemPrompt(
    topicPreferences(config),
    config.generalGuidance,
  );
  const results: Array<Awaited<ReturnType<typeof runMode>>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  const cleanup: Array<Record<string, unknown>> = [];
  const reportBase = {
    benchmark: "newsbrew-headline-filter",
    version: 2,
    startedAt: new Date().toISOString(),
    completedAt: null,
    configFingerprint: fingerprint(loadedConfig.raw),
    referenceFingerprint: fingerprint(loadedReference.raw),
    settings: {
      contextLength: config.run.contextLength,
      temperature: config.run.temperature,
      requestTimeoutMs: config.run.requestTimeoutMs,
      reasoningModes: config.run.reasoningModes,
      shuffleSeed: config.run.shuffleSeed,
      itemLimit: candidates.length,
      stateful: true,
      sessionStrategy: "sequential chain with context-aware rollover",
      productionPrompt: true,
    },
    classBalance: expectedCounts,
    referenceValidForThreeClassComparison,
    referenceReviewStatus: loadedReference.value.reviewStatus,
  };

  for (const [index, model] of models.entries()) {
    console.error(
      `[${index + 1}/${models.length}] ${model.display_name ?? model.key}`,
    );
    const preserveIds = new Set(
      (model.loaded_instances ?? [])
        .map((instance) => instance.id)
        .filter((id): id is string => typeof id === "string"),
    );
    const selected = modesFor(model, config.run.reasoningModes);
    for (const item of selected.skipped) {
      skipped.push({
        model: model.key,
        displayName: model.display_name,
        mode: item.mode,
        reason: item.reason,
      });
      console.error(`  ${item.mode}: skipped — ${item.reason}`);
    }
    try {
      for (const mode of selected.modes) {
        const result = await runMode({
          root,
          apiKey: config.lmStudio.apiKey,
          timeoutMs: config.run.requestTimeoutMs,
          contextLength: config.run.contextLength,
          temperature: config.run.temperature,
          systemPrompt: prompt,
          model,
          mode,
          candidates,
        });
        results.push(result);
        await writeReport(outputPath, {
          ...reportBase,
          results,
          skipped,
          cleanup,
        });
      }
    } finally {
      try {
        const outcome = await unloadNewInstances({
          root,
          apiKey: config.lmStudio.apiKey,
          timeoutMs: config.run.requestTimeoutMs,
          modelKey: model.key,
          preserveIds,
        });
        cleanup.push({ model: model.key, ...outcome });
      } catch (error) {
        cleanup.push({
          model: model.key,
          failed: true,
          error: compactError(error),
        });
      }
    }
  }

  const validResults = referenceValidForThreeClassComparison
    ? results.filter((result) => result.valid)
    : [];
  const rankings = {
    exactAccuracy: [...validResults]
      .sort(
        (left, right) =>
          (right.metrics.exactAccuracy ?? 0) -
            (left.metrics.exactAccuracy ?? 0) ||
          (right.metrics.passRejectAccuracy ?? 0) -
            (left.metrics.passRejectAccuracy ?? 0) ||
          (left.metrics.medianLatencyMs ?? Infinity) -
            (right.metrics.medianLatencyMs ?? Infinity),
      )
      .map((result) => ({
        model: result.model,
        mode: result.mode,
        exactAccuracy: result.metrics.exactAccuracy,
        passRejectAccuracy: result.metrics.passRejectAccuracy,
      })),
    speed: [...validResults]
      .sort(
        (left, right) =>
          (right.metrics.itemsPerSecond ?? 0) -
          (left.metrics.itemsPerSecond ?? 0),
      )
      .map((result) => ({
        model: result.model,
        mode: result.mode,
        itemsPerSecond: result.metrics.itemsPerSecond,
        medianLatencyMs: result.metrics.medianLatencyMs,
      })),
  };
  const completedAt = new Date().toISOString();
  await writeReport(outputPath, {
    ...reportBase,
    completedAt,
    rankings,
    results,
    skipped,
    cleanup,
  });

  console.log("\nResults");
  console.table(results.map(summaryRow));
  if (skipped.length > 0) {
    console.log("\nSkipped configurations");
    console.table(skipped);
  }
  if (hasFlag("show-misses")) {
    for (const result of results) {
      const misses = result.decisions.filter(
        (decision) => decision.predicted !== decision.expected,
      );
      if (misses.length === 0) continue;
      console.log(
        `\nMisses: ${result.displayName ?? result.model} (${result.modeLabel})`,
      );
      for (const miss of misses) {
        console.log(
          `  ${miss.id}: expected ${miss.expected}, got ${miss.predicted ?? "INVALID"} — ${miss.headline}`,
        );
      }
    }
  }
  console.log(`\nComplete private report: ${outputPath}`);
}

main().catch((error) => {
  console.error(`\nBenchmark failed: ${compactError(error)}`);
  process.exitCode = 1;
});
