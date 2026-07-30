import type { Article, ArticleCursor } from "./types.ts";

export const feedPageSize = 20;

export function encodeArticleCursor(
  article: Pick<Article, "discoveredAt" | "id">,
) {
  return Buffer.from(
    JSON.stringify({
      discoveredAt: article.discoveredAt,
      id: article.id,
    } satisfies ArticleCursor),
  ).toString("base64url");
}

export function decodeArticleCursor(value: string | null) {
  if (!value) return undefined;
  if (value.length > 1_024) throw new Error("Invalid feed cursor");

  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      !("discoveredAt" in decoded) ||
      !("id" in decoded) ||
      typeof decoded.discoveredAt !== "string" ||
      typeof decoded.id !== "string" ||
      decoded.id.length === 0 ||
      Number.isNaN(Date.parse(decoded.discoveredAt))
    ) {
      throw new Error("Invalid feed cursor");
    }
    return {
      discoveredAt: decoded.discoveredAt,
      id: decoded.id,
    } satisfies ArticleCursor;
  } catch {
    throw new Error("Invalid feed cursor");
  }
}
