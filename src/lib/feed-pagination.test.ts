import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeArticleCursor,
  encodeArticleCursor,
  feedPageSize,
} from "./feed-pagination.ts";

test("feed cursors round-trip stable article ordering fields", () => {
  const cursor = {
    discoveredAt: "2026-07-30T12:34:56.000Z",
    id: "example-article",
  };

  assert.equal(feedPageSize, 20);
  assert.deepEqual(decodeArticleCursor(encodeArticleCursor(cursor)), cursor);
  assert.equal(decodeArticleCursor(null), undefined);
  assert.throws(() => decodeArticleCursor("not-a-cursor"));
});
