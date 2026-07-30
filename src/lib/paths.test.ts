import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultConfigFile,
  defaultDatabaseFile,
  newsbrewDataDirectory,
  resolveUserPath,
} from "./paths.ts";

test("uses the Newsbrew config directory for persistent local data", () => {
  const expectedDirectory = join(
    homedir(),
    ".config",
    "wes-dev",
    "newsbrew",
  );

  assert.equal(newsbrewDataDirectory, expectedDirectory);
  assert.equal(defaultConfigFile, join(expectedDirectory, "newsbrew.json"));
  assert.equal(defaultDatabaseFile, join(expectedDirectory, "news.sqlite"));
  assert.equal(
    resolveUserPath("~/custom-newsbrew.json"),
    join(homedir(), "custom-newsbrew.json"),
  );
  assert.equal(
    resolveUserPath("./news.sqlite", expectedDirectory),
    join(expectedDirectory, "news.sqlite"),
  );
});
