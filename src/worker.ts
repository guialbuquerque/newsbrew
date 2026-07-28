import { config } from "./lib/config.ts";
import { runIngestionSafely } from "./lib/ingest.ts";
import { reloadRuntimeConfig } from "./lib/store.ts";

let stopped = false;

process.once("SIGINT", () => {
  stopped = true;
});
process.once("SIGTERM", () => {
  stopped = true;
});

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

console.log(
  `News worker started. Polling every ${config.pollIntervalMinutes} minute(s).`,
);

while (!stopped) {
  reloadRuntimeConfig();
  try {
    const result = await runIngestionSafely();
    console.log(
      `${new Date().toISOString()}: added ${result.discovered} matching article(s).`,
    );
  } catch (error) {
    console.error(`${new Date().toISOString()}: ingestion failed`, error);
  }
  reloadRuntimeConfig();
  await delay(config.pollIntervalMinutes * 60_000);
}
