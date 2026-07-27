import { chat, streamToText } from "@tanstack/ai";
import { openaiCompatible } from "@tanstack/ai-openai/compatible";
import { z, type ZodType } from "zod";
import { config } from "./config.ts";
import type {
  Feedback,
  Preferences,
  TopicPreference,
} from "./types.ts";

const classificationSchema = z.object({
  score: z.number().min(0).max(100),
  reason: z.string(),
  topics: z.array(z.string()).min(1).max(10),
});

const summarySchema = z.object({
  summary: z.string().min(20),
  bullets: z.array(z.string()).min(3).max(5),
});

const provider = openaiCompatible({
  name: "lm-studio",
  baseURL: config.lmStudioBaseURL,
  apiKey: config.lmStudioApiKey,
  models: [config.lmStudioModel],
});

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate.trim()) {
    throw new Error("Local model did not return JSON");
  }
  return JSON.parse(candidate) as unknown;
}

export class ModelResponseError extends Error {
  rawOutput: string;

  constructor(message: string, rawOutput: string, cause: unknown) {
    super(message, { cause });
    this.name = "ModelResponseError";
    this.rawOutput = rawOutput;
  }
}

async function requestJson<T>(input: {
  system: string;
  prompt: string;
  schema: ZodType<T>;
}) {
  const stream = chat({
    adapter: provider(config.lmStudioModel),
    systemPrompts: [input.system],
    messages: [{ role: "user", content: input.prompt }],
    modelOptions: { temperature: 0.1 },
  });
  const text = await streamToText(stream);
  try {
    return input.schema.parse(extractJson(text));
  } catch (error) {
    throw new ModelResponseError(
      error instanceof Error ? error.message : "Invalid model response",
      text,
      error,
    );
  }
}

function examples(feedback: Feedback[]) {
  if (feedback.length === 0) return "No feedback yet.";
  return feedback
    .slice(0, 20)
    .map(
      (item) =>
        `- ${item.reaction.toUpperCase()} “${item.topic}” from: ${item.headline}`,
    )
    .join("\n");
}

function topicSignals(preferences: TopicPreference[]) {
  const liked = preferences
    .filter((item) => item.reaction === "like")
    .map((item) => item.topic);
  const disliked = preferences
    .filter((item) => item.reaction === "dislike")
    .map((item) => item.topic);
  return `Liked topics: ${liked.join(", ") || "None"}
Disliked topics: ${disliked.join(", ") || "None"}`;
}

export async function classifyArticle(input: {
  headline: string;
  byline: string;
  sourceName: string;
  preferences: Preferences;
  feedback: Feedback[];
  topicPreferences: TopicPreference[];
}) {
  const result = await requestJson({
    system:
      "You rank news for one reader using only their topic likes and dislikes. Judge only the supplied headline, byline, and source. Topic signals are directional rather than absolute rules: weigh how central each topic is, allow mixed signals, and do not punish an incidental mention. Be conservative and concise. Return only valid JSON without markdown.",
    prompt: `Known topic preferences:
${topicSignals(input.topicPreferences)}

Recent story-specific topic ratings:
${examples(input.feedback)}

Candidate:
Headline: ${input.headline}
Byline: ${input.byline}
Source: ${input.sourceName}

Return exactly this JSON shape:
{"score":75,"reason":"One concise sentence explaining the relevance score.","topics":["named person","organisation","broad field","specific facet"]}

score must be 0-100. The application, not you, decides whether the score meets the threshold of ${input.preferences.minimumScore}.
Use this scoring rubric:
- 0-25: the central subject strongly matches disliked topics.
- 30-55: neutral, no strong signal, or only one broad liked category.
- 65-79: one specific liked topic is central to the story.
- 80-100: several specific liked topics are central, or prior ratings strongly support it.
An incidental liked-topic mention must not make a story pass. A broad preference such as "arts and culture", "public policy", or "computing" is weak evidence until the story also has a more specific liked signal.

Include 1-10 concise, independently rateable subject topics only where the headline directly supports them. Never include the author/byline or the publication/source as a topic unless the story is actually about that person or organisation. Prefer the specific work, product, event, entity, format, and subject—for example "Blade Runner 2099", "television", "science fiction", "trailer", and "San Diego Comic-Con". Include named people and organisations only when they are subjects of the story. A Boring Company funding story could include "Elon Musk", "Boring Company", "finance", "investment", "infrastructure", "tunnelling", and "venture capital". Do not infer AI, computing, space, or other technology topics merely because a film or work of fiction is science fiction. Do not invent entities or themes not supported by the candidate.`,
    schema: classificationSchema,
  });
  return {
    ...result,
    matches: result.score >= input.preferences.minimumScore,
  };
}

export async function summarizeArticle(input: {
  headline: string;
  byline: string;
  content: string;
}) {
  return requestJson({
    system:
      "Summarise news accurately. Use only the supplied article. Prefer concrete facts, decisions, numbers, dates, and direct consequences. Return only valid JSON without markdown.",
    prompt: `Headline: ${input.headline}
Byline: ${input.byline}

Article:
${input.content.slice(0, 24_000)}

Return exactly this JSON shape:
{"summary":"A concise one- or two-sentence overview that can be read in two or three lines.","bullets":["First fact.","Second fact.","Third fact."]}

The summary must state the essential development and consequence without repeating the headline. Include 3-5 crisp bullet items with the supporting details.`,
    schema: summarySchema,
  });
}
