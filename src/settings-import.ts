import { existsSync } from "node:fs";
import { resolveUserPath } from "./lib/paths.ts";

const filename = process.argv.slice(2).find((argument) => !argument.startsWith("-"));
if (!filename) {
  throw new Error(
    "Missing settings file. Usage: pnpm settings:import -- ./newsbrew.dev.json",
  );
}

const absoluteFilename = resolveUserPath(filename);
if (!existsSync(absoluteFilename)) {
  throw new Error(`Settings file does not exist: ${absoluteFilename}`);
}

delete process.env.NEWSBREW_CONFIG_JSON;
process.env.NEWSBREW_CONFIG_FILE = absoluteFilename;
process.env.NEWSBREW_SETTINGS_IMPORT_MODE = "explicit";

const [{ config, importedConfig }, store] = await Promise.all([
  import("./lib/config.ts"),
  import("./lib/store.ts"),
]);

if (!importedConfig.value) {
  throw new Error(`Settings file did not produce a configuration: ${absoluteFilename}`);
}

const result = store.importConfiguredSettings(true);
store.reloadRuntimeConfig();
const state = await store.readState();
const settings = store.readSettings();

process.stdout.write(
  `${JSON.stringify({
    imported: result.imported,
    source: result.source,
    databaseFile: config.databaseFile,
    sources: state.sources.length,
    likedTopics: state.topicPreferences.filter(
      (topic) => topic.reaction === "like",
    ).length,
    dislikedTopics: state.topicPreferences.filter(
      (topic) => topic.reaction === "dislike",
    ).length,
    runtime: settings.runtime,
    llm: {
      baseURL: settings.llm.baseURL,
      model: settings.llm.model,
      hasApiKey: settings.llm.hasApiKey,
    },
    hasGeneralGuidance: settings.filter.generalGuidance.length > 0,
  }, null, 2)}\n`,
);
