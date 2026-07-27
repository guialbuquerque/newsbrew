import { XMLParser } from "fast-xml-parser";
import { cleanText, stableId } from "./utils.ts";

export type FeedItem = {
  id: string;
  headline: string;
  byline: string;
  url: string;
  publishedAt?: string;
  imageUrl?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function linkFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const link = value as Record<string, unknown>;
    return String(link["@_href"] ?? link["#text"] ?? "");
  }
  return "";
}

function firstLink(value: unknown): string {
  for (const candidate of arrayOf(value)) {
    const link = linkFrom(candidate);
    if (link) return link;
  }
  return "";
}

function authorFrom(item: Record<string, unknown>) {
  const author = item.author;
  if (typeof author === "object" && author !== null) {
    return cleanText((author as Record<string, unknown>).name);
  }
  return cleanText(author ?? item.creator ?? item["dc:creator"]);
}

function imageFrom(item: Record<string, unknown>) {
  const candidates = [
    item.thumbnail,
    item.content,
    item.enclosure,
    item.image,
  ];
  for (const candidate of candidates.flatMap(arrayOf)) {
    if (typeof candidate === "string" && /^https?:\/\//.test(candidate)) {
      return candidate;
    }
    if (candidate && typeof candidate === "object") {
      const value = candidate as Record<string, unknown>;
      const url = String(value["@_url"] ?? value["@_href"] ?? "");
      const type = String(value["@_type"] ?? "");
      if (url && (!type || type.startsWith("image/"))) return url;
    }
  }
}

export function parseFeed(xml: string): FeedItem[] {
  const document = parser.parse(xml) as Record<string, unknown>;
  const rss = document.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  const feed = document.feed as Record<string, unknown> | undefined;
  const rawItems = channel ? arrayOf(channel.item) : arrayOf(feed?.entry);

  return rawItems
    .map((raw): FeedItem | null => {
      if (!raw || typeof raw !== "object") return null;
      const item = raw as Record<string, unknown>;
      const headline = cleanText(item.title);
      const url = firstLink(item.link) || cleanText(item.guid);
      if (!headline || !url) return null;
      const published = cleanText(item.pubDate ?? item.published ?? item.updated);
      const parsedDate = published ? new Date(published) : undefined;
      return {
        id: stableId(url),
        headline,
        byline: authorFrom(item) || "Byline not supplied",
        url,
        publishedAt:
          parsedDate && !Number.isNaN(parsedDate.valueOf())
            ? parsedDate.toISOString()
            : undefined,
        imageUrl: imageFrom(item),
      };
    })
    .filter((item): item is FeedItem => item !== null);
}
