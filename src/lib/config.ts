import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import {
  defaultConfigFile,
  defaultDatabaseFile,
  resolveUserPath,
} from "./paths.ts";

const positiveNumber = z.number().finite().positive();

const sourceSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  url: z.string().url(),
  enabled: z.boolean().default(true),
});

export const importedConfigSchema = z.object({
  databaseFile: z.string().min(1).optional(),
  runtime: z
    .object({
      pollIntervalMinutes: positiveNumber.optional(),
      maxItemsPerSource: positiveNumber.optional(),
    })
    .optional(),
  llm: z
    .object({
      baseURL: z.string().url().optional(),
      model: z.string().min(1).optional(),
      apiKey: z.string().optional(),
    })
    .optional(),
  filter: z
    .object({
      generalGuidance: z.string().max(5_000).default(""),
    })
    .optional(),
  topics: z
    .object({
      like: z.array(z.string().min(1)).default([]),
      dislike: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  sources: z.array(sourceSchema).optional(),
  auth: z
    .object({
      accessToken: z.string().optional(),
    })
    .optional(),
});

export type ImportedConfig = z.infer<typeof importedConfigSchema>;

function readImportedConfig() {
  const inline = process.env.NEWSBREW_CONFIG_JSON?.trim();
  const configuredFile = process.env.NEWSBREW_CONFIG_FILE?.trim();
  const defaultFile = defaultConfigFile;
  const filename = configuredFile
    ? resolveUserPath(configuredFile)
    : existsSync(defaultFile)
      ? defaultFile
      : undefined;
  const raw = inline ?? (filename ? readFileSync(filename, "utf8") : undefined);
  if (!raw) {
    return {
      value: undefined,
      fingerprint: undefined,
      source: undefined,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Could not parse Newsbrew configuration from ${inline ? "NEWSBREW_CONFIG_JSON" : filename}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const parsed = importedConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Invalid Newsbrew configuration from ${inline ? "NEWSBREW_CONFIG_JSON" : filename}: ${parsed.error.message}`,
    );
  }
  return {
    value: parsed.data,
    fingerprint: createHash("sha256").update(raw).digest("hex"),
    source: inline ? "NEWSBREW_CONFIG_JSON" : filename,
  };
}

export const importedConfig = readImportedConfig();

export type RuntimeConfig = {
  lmStudioBaseURL: string;
  lmStudioModel: string;
  lmStudioApiKey: string;
  filterGeneralGuidance: string;
  pollIntervalMinutes: number;
  maxItemsPerSource: number;
  databaseFile: string;
};

function configuredDatabaseFile() {
  const databaseFile = importedConfig.value?.databaseFile;
  if (!databaseFile) return defaultDatabaseFile;

  const sourceDirectory =
    importedConfig.source && importedConfig.source !== "NEWSBREW_CONFIG_JSON"
      ? dirname(importedConfig.source)
      : process.cwd();
  return resolveUserPath(databaseFile, sourceDirectory);
}

export const config: RuntimeConfig = {
  lmStudioBaseURL: importedConfig.value?.llm?.baseURL ?? "",
  lmStudioModel: importedConfig.value?.llm?.model ?? "",
  lmStudioApiKey: importedConfig.value?.llm?.apiKey ?? "",
  filterGeneralGuidance:
    importedConfig.value?.filter?.generalGuidance ?? "",
  pollIntervalMinutes:
    importedConfig.value?.runtime?.pollIntervalMinutes ?? 30,
  maxItemsPerSource:
    importedConfig.value?.runtime?.maxItemsPerSource ?? 8,
  databaseFile: configuredDatabaseFile(),
};

export function applyRuntimeConfig(next: Partial<RuntimeConfig>) {
  Object.assign(config, next);
}
