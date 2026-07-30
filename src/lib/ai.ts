import { z } from "zod";
import {
  articleAnalyserSystemPrompt,
  filterSystemPrompt,
} from "./ai/prompts.ts";
import { createResponsesClient } from "./ai/responses.ts";
import type { ChatMessage, TurnResult } from "./ai/responses.ts";
import type { ModelContext } from "./ai/model-context.ts";
import { config } from "./config.ts";
import type {
  ArticleSkipReason,
  FilterDecision,
  TopicPreference,
} from "./types.ts";

const articleBasicsSchema = z.object({
  skipReason: z
    .enum([
      "unusable_article",
      "headline_mismatch",
      "insufficient_content",
    ])
    .nullable(),
  headline: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string().min(1)).max(10),
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

export class ArticleAnalysisTimeoutError extends Error {
  skipReason: ArticleSkipReason = "summary_timeout";

  constructor() {
    super("Article analysis exceeded the 60-second limit");
    this.name = "ArticleAnalysisTimeoutError";
  }
}

const articleAnalysisTimeoutMs = 60_000;
const articleAnalysisMaxOutputTokens = 15_000;

export function parseFilterDecision(output: string): FilterDecision {
  const answer = output.trim().toLocaleLowerCase("en-GB");
  if (answer === "yes" || answer === "no" || answer === "maybe") return answer;
  throw new ModelResponseError(
    "The filter did not answer with exactly YES, NO, or MAYBE",
    output,
  );
}

export type ArticleFilter = {
  ready(): Promise<void>;
  decide(candidate: {
    headline: string;
    byline: string;
    sourceName: string;
  }): Promise<FilterDecision>;
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
  generalGuidance = "",
  abortController?: AbortController,
): ArticleFilter {
  const client = createResponsesClient(abortController);
  const system = filterSystemPrompt(topicPreferences, generalGuidance);
  const useMessageReplay = config.llmProviderMode === "openai-compatible";
  let previousResponseId: string | undefined;
  let sessionMessages: ChatMessage[] = [];
  let sessionTokens = 0;
  let largestTurnTokens = 0;
  let sessionTurn = 0;
  let lastTurn: ReturnType<ArticleFilter["lastTurn"]>;

  return {
    lastTurn: () => lastTurn,
    async ready() {
      await client.context;
    },
    async decide(candidate) {
      const modelContext = await client.context;
      const startedNewSession = useMessageReplay
        ? sessionMessages.length === 0
        : previousResponseId === undefined;
      if (startedNewSession) {
        sessionTokens = 0;
        largestTurnTokens = 0;
        sessionTurn = 0;
        sessionMessages = [];
      }
      const userPrompt = `Headline: ${candidate.headline}
Byline: ${candidate.byline}
Source: ${candidate.sourceName}`;
      const turnOptions = useMessageReplay
        ? {
            system,
            prompt: userPrompt,
            messages: [...sessionMessages, { role: "user" as const, content: userPrompt }],
          }
        : {
            system,
            prompt: userPrompt,
            previousResponseId,
            reasoningEffort: "none" as const,
          };
      const turn = await client.text(turnOptions);
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
      let decision: FilterDecision;
      try {
        decision = parseFilterDecision(turn.output);
      } catch (error) {
        previousResponseId = undefined;
        sessionMessages = [];
        throw error;
      }
      if (useMessageReplay) {
        if (nextTurnStartsNewSession) {
          sessionMessages = [];
        } else {
          sessionMessages.push(
            { role: "user", content: userPrompt },
            { role: "assistant", content: turn.output },
          );
        }
      } else {
        previousResponseId = nextTurnStartsNewSession
          ? undefined
          : turn.responseId;
      }
      return decision;
    },
  };
}

async function analyseArticleWithController(
  content: string,
  onTurn: ((turn: ArticleAnalysisTurn) => void) | undefined,
  abortController: AbortController,
  reasoningEffort?: "none",
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
    reasoningEffort,
    maxOutputTokens: articleAnalysisMaxOutputTokens,
  });
  const basicsContext = contextStatus(modelContext, basics, 1, 0);
  onTurn?.({
    phase: "basics",
    output: basics.output,
    responseId: basics.responseId,
    context: basicsContext,
    durationMs: Math.round(performance.now() - basicsStarted),
  });
  if (basics.output.skipReason) {
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
  const remainingOutputTokens = Math.max(
    1,
    articleAnalysisMaxOutputTokens - basicsContext.turnOutputTokens,
  );
  const points = await client.text({
    system: articleAnalyserSystemPrompt,
    prompt: pointsPrompt,
    previousResponseId: basics.responseId,
    reasoningEffort,
    maxOutputTokens: remainingOutputTokens,
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

async function analyseArticleAttempt(
  content: string,
  onTurn: ((turn: ArticleAnalysisTurn) => void) | undefined,
  abortController: AbortController | undefined,
  reasoningEffort?: "none",
): Promise<ArticleAnalysis> {
  const analysisController = new AbortController();
  let timedOut = false;
  const forwardAbort = () =>
    analysisController.abort(abortController?.signal.reason);
  if (abortController?.signal.aborted) forwardAbort();
  else abortController?.signal.addEventListener("abort", forwardAbort, {
    once: true,
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    analysisController.abort(
      new DOMException("Article analysis timed out", "TimeoutError"),
    );
  }, articleAnalysisTimeoutMs);

  try {
    return await analyseArticleWithController(
      content,
      onTurn,
      analysisController,
      reasoningEffort,
    );
  } catch (error) {
    if (timedOut) throw new ArticleAnalysisTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
    abortController?.signal.removeEventListener("abort", forwardAbort);
  }
}

export async function analyseArticle(
  content: string,
  onTurn?: (turn: ArticleAnalysisTurn) => void,
  abortController?: AbortController,
): Promise<ArticleAnalysis> {
  try {
    return await analyseArticleAttempt(content, onTurn, abortController);
  } catch (error) {
    if (!(error instanceof ArticleAnalysisTimeoutError)) throw error;
    console.warn(
      "[analysis] Article analysis timed out; retrying once with thinking off",
    );
    return analyseArticleAttempt(
      content,
      onTurn,
      abortController,
      "none",
    );
  }
}
