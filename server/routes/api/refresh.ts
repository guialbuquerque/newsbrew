import { defineHandler } from "nitro";
import { isAuthenticated, unauthorized } from "../../../src/lib/auth.ts";
import {
  getRefreshProgress,
  startRefresh,
  stopRefresh,
} from "../../../src/lib/refresh.ts";

export default defineHandler((event) => {
  if (!isAuthenticated(event.req)) return unauthorized();
  if (event.method === "GET") {
    return Response.json(getRefreshProgress());
  }
  if (event.method === "POST") {
    const result = startRefresh();
    return Response.json(
      {
        status: result.started ? "started" : "already_running",
        progress: result.progress,
      },
      { status: 202 },
    );
  }
  if (event.method === "DELETE") {
    const result = stopRefresh();
    return Response.json(
      {
        status: result.stopped ? "stopping" : "idle",
        progress: result.progress,
      },
      { status: result.stopped ? 202 : 200 },
    );
  }
  return Response.json({ error: "Method not allowed" }, { status: 405 });
});
