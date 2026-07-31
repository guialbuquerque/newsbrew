import { chat } from "@tanstack/ai";
import { openaiCompatible } from "@tanstack/ai-openai/compatible";
import type { ZodType } from "zod";
import { config } from "../config.ts";
import { ensureModelContext, staticModelContext } from "./model-context.ts";
import type { ModelContext } from "./model-context.ts";
import {
  ResponseMetadataTracker,
  type ResponseMetadata,
} from "./response-metadata.ts";

export type ChatMessage = { role: "user" | "assistant"; content: string };

type TurnOptions = {
  system: string;
  prompt: string;
  messages?: ChatMessage[];
  previousResponseId?: string;
  reasoningEffort?: "none";
  maxOutputTokens?: number;
};

export type TurnResult<T> = {
  output: T;
  responseId: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ResponsesClient = {
  context: Promise<ModelContext>;
  text(options: TurnOptions): Promise<TurnResult<string>>;
  structured<T>(options: TurnOptions & { schema: ZodType<T> }): Promise<TurnResult<T>>;
};

function createLMStudioClient(
  abortController?: AbortController,
): ResponsesClient {
  const tracker = new ResponseMetadataTracker();
  const context = ensureModelContext({
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
      ...(options.maxOutputTokens
        ? { max_output_tokens: options.maxOutputTokens }
        : {}),
      ...(options.reasoningEffort
        ? { reasoning: { effort: options.reasoningEffort } }
        : {}),
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

function createOpenAICompatibleClient(
  abortController?: AbortController,
): ResponsesClient {
  const tracker = new ResponseMetadataTracker();
  const context = Promise.resolve(
    staticModelContext(config.lmStudioModel, config.llmContextTokens),
  );
  const provider = openaiCompatible({
    name: "openai-compatible",
    baseURL: config.lmStudioBaseURL,
    apiKey: config.lmStudioApiKey,
    models: [config.lmStudioModel],
    api: "chat",
    maxRetries: 0,
    fetch: tracker.fetch,
  });
  const adapter = provider(config.lmStudioModel);

  function modelOptions(options: TurnOptions) {
    return {
      temperature: 0.1,
      enable_thinking: false,
      ...(options.maxOutputTokens
        ? { max_tokens: options.maxOutputTokens }
        : {}),
    };
  }

  function buildMessages(options: TurnOptions) {
    if (options.messages && options.messages.length > 0) {
      return options.messages.map((message) => ({
        role: message.role,
        content: message.content,
      }));
    }
    return [{ role: "user" as const, content: options.prompt }];
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
          messages: buildMessages(options),
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
          messages: buildMessages(options),
          modelOptions: modelOptions(options),
          outputSchema: options.schema,
          abortController,
        });
        return output as T;
      });
    },
  };
}

export function createResponsesClient(
  abortController?: AbortController,
): ResponsesClient {
  if (config.llmProviderMode === "openai-compatible") {
    return createOpenAICompatibleClient(abortController);
  }
  return createLMStudioClient(abortController);
}