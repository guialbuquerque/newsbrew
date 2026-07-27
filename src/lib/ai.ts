import { z } from "zod";
import {
  articleAnalyserSystemPrompt,
  filterSystemPrompt,
} from "./ai/prompts.ts";
import { createResponsesClient } from "./ai/responses.ts";
import type { TurnResult } from "./ai/responses.ts";
import type { ModelContext } from "./ai/model-context.ts";
import type { TopicPreference } from "./types.ts";

const articleBasicsSchema = z.object({
  rejected: z.boolean(),
  headline: z.string().min(1),
  summary: z.string().min(20),
  tags: z.array(z.string().min(1)).min(1).max(10),
});

export type ArticleBasics = z.infer<typeof articleBasicsSchema>;
export type ArticlePoints = { pointsMarkdown: string };
export type ArticleAnalysis = ArticleBasics & ArticlePoints;

export type ContextStatus = ModelContext & {
  sessionTurn: number;
  turnInputTokens: number;
  turnOutputTokens: number;
  turnTokens: number;
  sessionTokens: number;
  remainingTokens: number;
};

export type ArticleAnalysisTurn =
  | {
      phase: "basics";
      output: ArticleBasics;
      responseId: string;
      context: ContextStatus;
      durationMs: number;
    }
  | {
      phase: "points";
      output: string;
      responseId: string;
      context: ContextStatus;
      durationMs: number;
    };

export class ModelResponseError extends Error {
  rawOutput: string;

  constructor(message: string, rawOutput: string) {
    super(message);
    this.name = "ModelResponseError";
    this.rawOutput = rawOutput;
  }
}

export function parseFilterDecision(output: string) {
  const answer = output.trim().toLocaleLowerCase("en-GB");
  if (answer.startsWith("yes")) return true;
  if (answer.startsWith("no")) return false;
  throw new ModelResponseError(
    "The filter did not start its answer with YES or NO",
    output,
  );
}

export type ArticleFilter = {
  decide(candidate: {
    headline: string;
    byline: string;
    sourceName: string;
  }): Promise<boolean>;
  lastTurn():
    | (ContextStatus & {
        startedNewSession: boolean;
        nextTurnStartsNewSession: boolean;
      })
    | undefined;
};

function contextStatus<T>(
  context: ModelContext,
  turn: TurnResult<T>,
  sessionTurn: number,
  previousSessionTokens: number,
): ContextStatus {
  if (
    turn.inputTokens === undefined ||
    turn.outputTokens === undefined ||
    turn.totalTokens === undefined
  ) {
    throw new Error("LM Studio did not report complete token usage");
  }
  const sessionTokens = previousSessionTokens + turn.totalTokens;
  return {
    ...context,
    sessionTurn,
    turnInputTokens: turn.inputTokens,
    turnOutputTokens: turn.outputTokens,
    turnTokens: turn.totalTokens,
    sessionTokens,
    remainingTokens: Math.max(0, context.activeContextTokens - sessionTokens),
  };
}

export function createArticleFilter(
  topicPreferences: TopicPreference[],
  abortController?: AbortController,
): ArticleFilter {
  const client = createResponsesClient(abortController);
  const system = filterSystemPrompt(topicPreferences);
  let previousResponseId: string | undefined;
  let sessionTokens = 0;
  let largestTurnTokens = 0;
  let sessionTurn = 0;
  let lastTurn: ReturnType<ArticleFilter["lastTurn"]>;

  return {
    lastTurn: () => lastTurn,
    async decide(candidate) {
      const modelContext = await client.context;
      const startedNewSession = previousResponseId === undefined;
      if (startedNewSession) {
        sessionTokens = 0;
        largestTurnTokens = 0;
        sessionTurn = 0;
      }
      const turn = await client.text({
        system,
        prompt: `Headline: ${candidate.headline}
Byline: ${candidate.byline}
Source: ${candidate.sourceName}`,
        previousResponseId,
      });
      sessionTurn += 1;
      const usage = contextStatus(
        modelContext,
        turn,
        sessionTurn,
        sessionTokens,
      );
      sessionTokens = usage.sessionTokens;
      largestTurnTokens = Math.max(largestTurnTokens, usage.turnTokens);
      const nextTurnStartsNewSession =
        usage.sessionTokens + largestTurnTokens >=
        modelContext.activeContextTokens;
      lastTurn = {
        ...usage,
        startedNewSession,
        nextTurnStartsNewSession,
      };
      let included: boolean;
      try {
        included = parseFilterDecision(turn.output);
      } catch (error) {
        previousResponseId = undefined;
        throw error;
      }
      previousResponseId = nextTurnStartsNewSession
        ? undefined
        : turn.responseId;
      return included;
    },
  };
}

export async function analyseArticle(
  content: string,
  onTurn?: (turn: ArticleAnalysisTurn) => void,
  abortController?: AbortController,
): Promise<ArticleAnalysis> {
  const client = createResponsesClient(abortController);
  const modelContext = await client.context;
  const freshTurnByteUpperBound = new TextEncoder().encode(
    `${articleAnalyserSystemPrompt}\n${content}`,
  ).byteLength;
  if (
    freshTurnByteUpperBound >= modelContext.activeContextTokens
  ) {
    throw new Error(
      `Article cannot fit safely in the active ${modelContext.activeContextTokens}-token context window`,
    );
  }
  const basicsStarted = performance.now();
  const basics = await client.structured<ArticleBasics>({
    system: articleAnalyserSystemPrompt,
    prompt: content,
    schema: articleBasicsSchema,
  });
  const basicsContext = contextStatus(modelContext, basics, 1, 0);
  onTurn?.({
    phase: "basics",
    output: basics.output,
    responseId: basics.responseId,
    context: basicsContext,
    durationMs: Math.round(performance.now() - basicsStarted),
  });
  if (basics.output.rejected) {
    return {
      ...basics.output,
      pointsMarkdown: "",
    };
  }
  const pointsPrompt =
    "Now return the detailed factual points for that article as requested.";
  const followUpByteUpperBound = new TextEncoder().encode(
    `${articleAnalyserSystemPrompt}\n${pointsPrompt}`,
  ).byteLength;
  if (
    basicsContext.sessionTokens + followUpByteUpperBound >=
    modelContext.activeContextTokens
  ) {
    throw new Error(
      `The detailed-points turn cannot fit in the remaining ${basicsContext.remainingTokens} context tokens`,
    );
  }
  const pointsStarted = performance.now();
  const points = await client.text({
    system: articleAnalyserSystemPrompt,
    prompt: pointsPrompt,
    previousResponseId: basics.responseId,
  });
  const pointsContext = contextStatus(
    modelContext,
    points,
    2,
    basicsContext.sessionTokens,
  );
  onTurn?.({
    phase: "points",
    output: points.output,
    responseId: points.responseId,
    context: pointsContext,
    durationMs: Math.round(performance.now() - pointsStarted),
  });
  return {
    ...basics.output,
    pointsMarkdown: points.output,
  };
}
