import { defineWebSocketHandler } from "nitro";
import {
  getRefreshProgress,
  subscribeToRefresh,
} from "../../../src/lib/refresh.ts";

const subscriptions = new Map<string, () => void>();

export default defineWebSocketHandler({
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
