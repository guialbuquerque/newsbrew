import type { APIEvent } from "@solidjs/start/server";
import { isAuthenticated, unauthorized } from "~/lib/auth";
import {
  decodeArticleCursor,
  encodeArticleCursor,
  feedPageSize,
} from "~/lib/feed-pagination";
import { readArticlePage, readSettings, readState } from "~/lib/store";

export async function GET({ request }: APIEvent) {
  if (!isAuthenticated(request)) return unauthorized();
  let cursor;
  try {
    cursor = decodeArticleCursor(
      new URL(request.url).searchParams.get("cursor"),
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid feed cursor" },
      { status: 400 },
    );
  }
  const [state, page] = await Promise.all([
    readState({ includeArticles: false, includeSeen: false }),
    readArticlePage(feedPageSize, cursor),
  ]);
  const settings = readSettings();
  return Response.json({
    ...state,
    articles: page.articles,
    feed: {
      hasMore: page.hasMore,
      ...(page.next ? { nextCursor: encodeArticleCursor(page.next) } : {}),
    },
    ...settings,
  });
}
