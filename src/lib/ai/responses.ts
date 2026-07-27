import { chat } from "@tanstack/ai";
import { openaiCompatible } from "@tanstack/ai-openai/compatible";
import type { ZodType } from "zod";
import { config } from "../config.ts";
import { fetchModelContext } from "./model-context.ts";
import {
  ResponseMetadataTracker,
  type ResponseMetadata,
} from "./response-metadata.ts";

type TurnOptions = {
  system: string;
  prompt: string;
  previousResponseId?: string;
};

export type TurnResult<T> = {
  output: T;
  responseId: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export function createResponsesClient(abortController?: AbortController) {
  const tracker = new ResponseMetadataTracker();
  const context = fetchModelContext({
    baseURL: config.lmStudioBaseURL,
    model: config.lmStudioModel,
    apiKey: config.lmStudioApiKey,
    signal: abortController?.signal,
  });
  const provider = openaiCompatible({
    name: "lm-studio",
    baseURL: config.lmStudioBaseURL,
    apiKey: config.lmStudioApiKey,
    models: [config.lmStudioModel],
    api: "responses",
    maxRetries: 0,
    fetch: tracker.fetch,
  });
  const adapter = provider(config.lmStudioModel);

  function modelOptions(options: TurnOptions) {
    return {
      temperature: 0.1,
      store: true,
      truncation: "disabled" as const,
      ...(options.previousResponseId
        ? { previous_response_id: options.previousResponseId }
        : {}),
    };
  }

  async function withMetadata<T>(
    request: () => Promise<T>,
  ): Promise<TurnResult<T>> {
    const tracked = tracker.next();
    try {
      const output = await request();
      const metadata: ResponseMetadata = await tracked.metadata;
      return {
        output,
        responseId: metadata.responseId,
        ...(metadata.inputTokens === undefined
          ? {}
          : { inputTokens: metadata.inputTokens }),
        ...(metadata.outputTokens === undefined
          ? {}
          : { outputTokens: metadata.outputTokens }),
        ...(metadata.totalTokens === undefined
          ? {}
          : { totalTokens: metadata.totalTokens }),
      };
    } catch (error) {
      tracked.cancel();
      void tracked.metadata.catch(() => undefined);
      throw error;
    }
  }

  return {
    context,
    text(options: TurnOptions) {
      return withMetadata(() =>
        chat({
          adapter,
          systemPrompts: [options.system],
          messages: [{ role: "user", content: options.prompt }],
          modelOptions: modelOptions(options),
          stream: false,
          abortController,
        }),
      );
    },

    structured<T>(options: TurnOptions & { schema: ZodType<T> }) {
      return withMetadata<T>(async () => {
        const output = await chat({
          adapter,
          systemPrompts: [options.system],
          messages: [{ role: "user", content: options.prompt }],
          modelOptions: modelOptions(options),
          outputSchema: options.schema,
          abortController,
        });
        return output as T;
      });
    },
  };
}
