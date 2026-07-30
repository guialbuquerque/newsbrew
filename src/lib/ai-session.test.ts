import assert from "node:assert/strict";
import test from "node:test";
import {
  readResponseMetadata,
  ResponseMetadataTracker,
} from "./ai/response-metadata.ts";
import {
  ensureModelContext,
  modelListURL,
  modelLoadURL,
  parseModelContext,
} from "./ai/model-context.ts";
import { filterSystemPrompt } from "./ai/prompts.ts";
import { parseFilterDecision } from "./ai.ts";

test("filter prompt contains topic signals, directional guidance, and tri-state labels", () => {
  const prompt = filterSystemPrompt([
    { topic: "preferred subject", reaction: "like", source: "rating" },
    { topic: "excluded subject", reaction: "dislike", source: "rating" },
  ], "Prefer evidence-rich reporting over promotional coverage.");

  assert.match(
    prompt,
    /General guidance:\nPrefer evidence-rich reporting over promotional coverage\./,
  );
  assert.match(prompt, /Positive topics:\n- preferred subject/);
  assert.match(prompt, /Negative topics:\n- excluded subject/);
  assert.match(prompt, /Treat topic signals as directional/);
  assert.match(prompt, /incidental positive topic/);
  assert.match(prompt, /YES = clearly wanted/);
  assert.match(prompt, /NO = explicit rejection/);
  assert.match(prompt, /MAYBE = neutral, ambiguous/);
  assert.doesNotMatch(prompt, /score|rubric|recent feedback/i);
  assert.ok(
    prompt.indexOf("General guidance:") < prompt.indexOf("Positive topics:"),
  );
});

test("accepts only exact tri-state filter answers", () => {
  assert.equal(parseFilterDecision(" YES \n"), "yes");
  assert.equal(parseFilterDecision("no"), "no");
  assert.equal(parseFilterDecision("MAYBE"), "maybe");
  assert.throws(
    () => parseFilterDecision("The answer is YES"),
    /did not answer with exactly/,
  );
  assert.throws(
    () => parseFilterDecision("YES\nYES"),
    /did not answer with exactly/,
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
  assert.equal(
    modelLoadURL("http://127.0.0.1:1234/v1").href,
    "http://127.0.0.1:1234/api/v1/models/load",
  );
});

test("loads the configured local model when it is not already resident", async () => {
  let loaded = false;
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.endsWith("/models/load")) {
      loaded = true;
      return Response.json({
        type: "llm",
        instance_id: "example/model",
        status: "loaded",
      });
    }
    return Response.json({
      models: [
        {
          key: "example/model",
          max_context_length: 128_000,
          loaded_instances: loaded
            ? [
                {
                  id: "example/model",
                  config: { context_length: 128_000 },
                },
              ]
            : [],
        },
      ],
    });
  };

  assert.deepEqual(
    await ensureModelContext({
      baseURL: "http://127.0.0.1:1234/v1",
      model: "example/model",
      apiKey: "local",
      fetch: mockFetch,
    }),
    {
      model: "example/model",
      activeContextTokens: 128_000,
      maximumContextTokens: 128_000,
    },
  );
  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1:1234/api/v1/models",
      method: "GET",
    },
    {
      url: "http://127.0.0.1:1234/api/v1/models/load",
      method: "POST",
      body: {
        model: "example/model",
        echo_load_config: true,
      },
    },
    {
      url: "http://127.0.0.1:1234/api/v1/models",
      method: "GET",
    },
  ]);
});
