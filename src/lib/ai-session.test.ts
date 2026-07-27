import assert from "node:assert/strict";
import test from "node:test";
import {
  readResponseMetadata,
  ResponseMetadataTracker,
} from "./ai/response-metadata.ts";
import { modelListURL, parseModelContext } from "./ai/model-context.ts";
import { filterSystemPrompt } from "./ai/prompts.ts";
import { parseFilterDecision } from "./ai.ts";

test("filter prompt contains topic signals and requires a binary answer", () => {
  const prompt = filterSystemPrompt([
    { topic: "infrastructure", reaction: "like", source: "rating" },
    { topic: "celebrity gossip", reaction: "dislike", source: "perplexity" },
  ]);

  assert.match(prompt, /Positive topics:\n- infrastructure/);
  assert.match(prompt, /Negative topics:\n- celebrity gossip/);
  assert.match(prompt, /exactly YES or NO/);
  assert.doesNotMatch(prompt, /score|rubric|recent feedback/i);
});

test("accepts filter answers that start with yes or no", () => {
  assert.equal(parseFilterDecision("YES\nYES"), true);
  assert.equal(parseFilterDecision("  no\nNO"), false);
  assert.throws(
    () => parseFilterDecision("The answer is YES"),
    /did not start its answer/,
  );
});

test("reads response metadata from a JSON response", async () => {
  const response = new Response(
    JSON.stringify({
      id: "resp_json",
      usage: { input_tokens: 42, output_tokens: 8, total_tokens: 50 },
    }),
    { headers: { "content-type": "application/json" } },
  );

  assert.deepEqual(await readResponseMetadata(response), {
    responseId: "resp_json",
    inputTokens: 42,
    outputTokens: 8,
    totalTokens: 50,
  });
});

test("reads the response id and final usage from an SSE response", async () => {
  const response = new Response(
    [
      'data: {"type":"response.created","response":{"id":"resp_sse"}}',
      "",
      'data: {"type":"response.completed","response":{"id":"resp_sse","usage":{"input_tokens":73,"output_tokens":11,"total_tokens":84}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    { headers: { "content-type": "text/event-stream" } },
  );

  assert.deepEqual(await readResponseMetadata(response), {
    responseId: "resp_sse",
    inputTokens: 73,
    outputTokens: 11,
    totalTokens: 84,
  });
});

test("tracks the response used by the next request only", async () => {
  const tracker = new ResponseMetadataTracker(async () => {
    return new Response(JSON.stringify({ id: "resp_tracked" }), {
      headers: { "content-type": "application/json" },
    });
  });
  const tracked = tracker.next();

  await tracker.fetch("http://localhost/v1/responses");

  assert.deepEqual(await tracked.metadata, { responseId: "resp_tracked" });
});

test("reads the active and absolute model context limits", () => {
  const context = parseModelContext(
    {
      models: [
        {
          key: "example/model",
          max_context_length: 128_000,
          loaded_instances: [
            {
              id: "example/model",
              config: { context_length: 32_768 },
            },
          ],
        },
      ],
    },
    "example/model",
  );

  assert.deepEqual(context, {
    model: "example/model",
    activeContextTokens: 32_768,
    maximumContextTokens: 128_000,
  });
  assert.equal(
    modelListURL("http://127.0.0.1:1234/v1").href,
    "http://127.0.0.1:1234/api/v1/models",
  );
});
