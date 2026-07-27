import assert from "node:assert/strict";
import test from "node:test";
import { parseFeed } from "./rss.ts";

test("parses RSS headline, byline and link", () => {
  const items = parseFeed(`
    <rss><channel><item>
      <title>Community garden opens</title>
      <link>https://example.com/garden</link>
      <dc:creator xmlns:dc="dc">Alex Smith</dc:creator>
      <pubDate>Sat, 25 Jul 2026 10:00:00 GMT</pubDate>
    </item></channel></rss>
  `);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.headline, "Community garden opens");
  assert.equal(items[0]?.byline, "Alex Smith");
  assert.equal(items[0]?.url, "https://example.com/garden");
});

test("parses Atom links and nested author names", () => {
  const items = parseFeed(`
    <feed><entry>
      <title>Transit plan approved</title>
      <link href="https://example.com/transit" />
      <author><name>Sam Lee</name></author>
    </entry></feed>
  `);

  assert.equal(items[0]?.headline, "Transit plan approved");
  assert.equal(items[0]?.byline, "Sam Lee");
});

test("extracts publisher-provided feed images", () => {
  const items = parseFeed(`
    <rss><channel><item>
      <title>New tunnel receives funding</title>
      <link>https://example.com/tunnel</link>
      <media:content xmlns:media="media" url="https://example.com/tunnel.jpg" type="image/jpeg" />
    </item></channel></rss>
  `);

  assert.equal(items[0]?.imageUrl, "https://example.com/tunnel.jpg");
});
