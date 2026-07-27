import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

const envFile = resolve(".env");
if (existsSync(envFile)) {
  loadEnvFile(envFile);
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Set it in the process environment or in ${envFile}.`,
    );
  }
  return value;
}

function positiveNumber(name: string) {
  const value = required(name);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Environment variable ${name} must be a positive number; received ${JSON.stringify(value)}.`,
    );
  }
  return parsed;
}

export const config = {
  lmStudioBaseURL: required("LM_STUDIO_BASE_URL"),
  lmStudioModel: required("LM_STUDIO_MODEL"),
  lmStudioApiKey: required("LM_STUDIO_API_KEY"),
  pollIntervalMinutes: positiveNumber("POLL_INTERVAL_MINUTES"),
  maxItemsPerSource: positiveNumber("MAX_ITEMS_PER_SOURCE"),
  databaseFile: resolve(required("NEWS_DATABASE_FILE")),
};
