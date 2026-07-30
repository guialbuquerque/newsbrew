import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { newsbrewDataDirectory } from "../lib/paths.ts";

export const benchmarkDecisionSchema = z.enum(["YES", "MAYBE", "NO"]);
export type BenchmarkDecision = z.infer<typeof benchmarkDecisionSchema>;

const reasoningModeSchema = z.enum([
  "off",
  "on",
  "low",
  "medium",
  "high",
  "default",
]);

export const benchmarkConfigSchema = z.object({
  version: z.literal(1),
  lmStudio: z.object({
    baseURL: z.string().url(),
    apiKey: z.string().default("lm-studio"),
  }),
  preferences: z.object({
    like: z.array(z.string().trim().min(1)),
    dislike: z.array(z.string().trim().min(1)),
  }),
  generalGuidance: z.string().max(5_000).default(""),
  run: z
    .object({
      contextLength: z.number().int().positive().default(8192),
      requestTimeoutMs: z.number().int().positive().default(120_000),
      temperature: z.number().finite().min(0).max(2).default(0.1),
      reasoningModes: z
        .array(reasoningModeSchema)
        .min(1)
        .default(["off"]),
      shuffleSeed: z.number().int().nonnegative().default(0x4e425257),
    })
    .default({
      contextLength: 8192,
      requestTimeoutMs: 120_000,
      temperature: 0.1,
      reasoningModes: ["off"],
      shuffleSeed: 0x4e425257,
    }),
});

export type BenchmarkConfig = z.infer<typeof benchmarkConfigSchema>;
export type BenchmarkReasoningMode = z.infer<typeof reasoningModeSchema>;

export const benchmarkReferenceSchema = z.object({
  version: z.literal(1),
  reviewStatus: z.string().optional(),
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        sourceName: z.string().min(1),
        headline: z.string().min(1),
        byline: z.string().default(""),
        expected: benchmarkDecisionSchema,
      }),
    )
    .min(1),
});

export type BenchmarkReference = z.infer<typeof benchmarkReferenceSchema>;
export type BenchmarkCandidate = BenchmarkReference["items"][number];

export const benchmarkDataDirectory = newsbrewDataDirectory;
export const defaultBenchmarkConfigFile = "benchmark-config.json";
export const defaultBenchmarkReferenceFile = "benchmark-reference.json";
export const defaultBenchmarkOutputFile = "benchmark-results.json";

export function benchmarkDataPath(filename: string) {
  if (
    basename(filename) !== filename ||
    !filename.startsWith("benchmark-") ||
    !filename.endsWith(".json")
  ) {
    throw new Error(
      "Benchmark filenames must be JSON files beginning with benchmark- and may not contain a path",
    );
  }
  return resolve(benchmarkDataDirectory, filename);
}

async function readJson(path: string) {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(`Missing private benchmark file: ${path}`);
    }
    throw error;
  }

  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch (error) {
    throw new Error(
      `Could not parse ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function readBenchmarkConfig(filename: string) {
  const path = benchmarkDataPath(filename);
  const json = await readJson(path);
  const parsed = benchmarkConfigSchema.safeParse(json.value);
  if (!parsed.success) {
    throw new Error(`Invalid benchmark config ${path}: ${parsed.error.message}`);
  }
  return { path, raw: json.raw, value: parsed.data };
}

export async function readBenchmarkReference(filename: string) {
  const path = benchmarkDataPath(filename);
  const json = await readJson(path);
  const parsed = benchmarkReferenceSchema.safeParse(json.value);
  if (!parsed.success) {
    throw new Error(
      `Invalid benchmark reference ${path}: ${parsed.error.message}`,
    );
  }
  const ids = new Set<string>();
  for (const item of parsed.data.items) {
    if (ids.has(item.id)) {
      throw new Error(
        `Invalid benchmark reference ${path}: duplicate id "${item.id}"`,
      );
    }
    ids.add(item.id);
  }
  return { path, raw: json.raw, value: parsed.data };
}
