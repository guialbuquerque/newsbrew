import { runIngestionSafely } from "./lib/ingest.ts";

const result = await runIngestionSafely();
console.log(`Ingestion complete: ${result.discovered} matching article(s) added.`);
