import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const newsbrewDataDirectory = join(
  homedir(),
  ".config",
  "wes-dev",
  "newsbrew",
);

export const defaultConfigFile = join(
  newsbrewDataDirectory,
  "newsbrew.json",
);

export const defaultDatabaseFile = join(
  newsbrewDataDirectory,
  "news.sqlite",
);

export function resolveUserPath(path: string, baseDirectory = process.cwd()) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(baseDirectory, path);
}
