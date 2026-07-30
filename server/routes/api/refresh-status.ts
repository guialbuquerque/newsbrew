import { defineWebSocketHandler } from "nitro";
import { isAuthenticated } from "../../../src/lib/auth.ts";
import {
  getLiveRefreshArticles,
  getRefreshProgress,
  subscribeToRefresh,
} from "../../../src/lib/refresh.ts";

const subscriptions = new Map<string, () => void>();

export default defineWebSocketHandler({
  upgrade(request) {
    if (!isAuthenticated(request)) {
      throw new Response("Access token required", { status: 401 });
    }
  },
  open(peer) {
    subscriptions.set(
      peer.id,
      subscribeToRefresh((event) => {
        peer.send(JSON.stringify(event));
      }),
    );
    const progress = getRefreshProgress();
    peer.send(JSON.stringify({ type: "progress", progress }));
    if (progress.runId) {
      for (const article of getLiveRefreshArticles()) {
        peer.send(
          JSON.stringify({
            type: "article",
            runId: progress.runId,
            article,
          }),
        );
      }
    }
  },
  close(peer) {
    subscriptions.get(peer.id)?.();
    subscriptions.delete(peer.id);
  },
  error(peer) {
    subscriptions.get(peer.id)?.();
    subscriptions.delete(peer.id);
  },
});
