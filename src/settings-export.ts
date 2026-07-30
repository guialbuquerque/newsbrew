import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative } from "node:path";
import { defaultConfigFile, resolveUserPath } from "./lib/paths.ts";

const requestedFilename =
  process.argv.slice(2).find((argument) => !argument.startsWith("-"));
const outputFilename = requestedFilename
  ? resolveUserPath(requestedFilename)
  : defaultConfigFile;

process.env.NEWSBREW_SETTINGS_IMPORT_MODE = "explicit";

const [{ config, importedConfigSchema }, store] = await Promise.all([
  import("./lib/config.ts"),
  import("./lib/store.ts"),
]);

function portableDatabaseFile() {
  const relativePath = relative(dirname(outputFilename), config.databaseFile);
  if (!relativePath || relativePath.startsWith("..")) return config.databaseFile;
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function existingAccessToken() {
  if (!existsSync(outputFilename)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(outputFilename, "utf8")) as {
      auth?: { accessToken?: unknown };
    };
    return typeof parsed.auth?.accessToken === "string"
      ? parsed.auth.accessToken
      : undefined;
  } catch {
    return undefined;
  }
}

const snapshot = store.readSettingsSnapshot();
const preservedAccessToken = existingAccessToken();
const output = {
  databaseFile: portableDatabaseFile(),
  runtime: snapshot.runtime,
  llm: snapshot.llm,
  filter: snapshot.filter,
  ...(snapshot.accessTokenRequired
    ? preservedAccessToken === undefined
      ? {}
      : { auth: { accessToken: preservedAccessToken } }
    : { auth: { accessToken: "" } }),
  topics: snapshot.topics,
  sources: snapshot.sources,
};

const validated = importedConfigSchema.parse(output);
mkdirSync(dirname(outputFilename), { recursive: true });
const temporaryFilename = `${outputFilename}.tmp-${process.pid}`;
writeFileSync(temporaryFilename, `${JSON.stringify(validated, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
renameSync(temporaryFilename, outputFilename);
chmodSync(outputFilename, 0o600);

process.stdout.write(
  `${JSON.stringify({
    exported: true,
    output: outputFilename,
    sources: snapshot.sources.length,
    likedTopics: snapshot.topics.like.length,
    dislikedTopics: snapshot.topics.dislike.length,
    accessToken:
      snapshot.accessTokenRequired && preservedAccessToken === undefined
        ? "omitted-unrecoverable"
        : snapshot.accessTokenRequired
          ? "preserved"
          : "disabled",
  }, null, 2)}\n`,
);
