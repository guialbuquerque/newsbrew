import { runIngestionSafely } from "~/lib/ingest";

let activeRun: Promise<unknown> | undefined;

export async function POST() {
  if (activeRun) {
    return Response.json({ error: "A refresh is already running" }, { status: 409 });
  }
  activeRun = runIngestionSafely().finally(() => {
    activeRun = undefined;
  });
  const result = await activeRun;
  return Response.json(result);
}
