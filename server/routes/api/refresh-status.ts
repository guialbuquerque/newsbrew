import { defineWebSocketHandler } from "nitro";
import { isAuthenticated } from "../../../src/lib/auth.ts";
import {
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
    peer.send(JSON.stringify(getRefreshProgress()));
    subscriptions.set(
      peer.id,
      subscribeToRefresh((progress) => {
        peer.send(JSON.stringify(progress));
      }),
    );
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
