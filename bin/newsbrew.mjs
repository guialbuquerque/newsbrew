#!/usr/bin/env node

const argumentsList = process.argv.slice(2);

if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
  process.stdout.write(`Newsbrew

Usage:
  npx newsbrew

Environment:
  HOST                    Listening host (default: localhost)
  PORT                    Listening port (default: 3000)
  NEWSBREW_CONFIG_FILE    Settings JSON (default:
                          ~/.config/wes-dev/newsbrew/newsbrew.json)
  NEWSBREW_CONFIG_JSON    Inline settings JSON; takes precedence over the file

Persistent data is stored in ~/.config/wes-dev/newsbrew/.
`);
} else {
  await import("../.output/server/index.mjs");
}
