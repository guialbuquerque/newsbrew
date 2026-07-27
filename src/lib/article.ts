import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { cleanText } from "./utils.ts";

function imageUrl(document: Document, articleUrl: string) {
  const selectors = [
    'meta[property="og:image:secure_url"]',
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
    'link[rel="image_src"]',
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const candidate =
      element?.getAttribute("content") ?? element?.getAttribute("href");
    if (!candidate) continue;
    try {
      const resolved = new URL(candidate, articleUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        return resolved.href;
      }
    } catch {
      // Try the next publisher-provided image.
    }
  }
}

export async function fetchArticle(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; Newsbrew/0.1; personal-use)",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Article returned ${response.status}`);
  const html = await response.text();
  const { document } = parseHTML(html);
  const image = imageUrl(document as unknown as Document, url);
  const readable = new Readability(document as unknown as Document).parse();
  const text = cleanText(readable?.textContent);
  if (text.length < 200) {
    throw new Error("Could not extract enough article text");
  }
  return { text, imageUrl: image };
}
