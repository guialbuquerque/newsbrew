export type ResponseMetadata = {
  responseId: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

function usageFromObject(usage: Record<string, unknown>): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  const inputTokens =
    typeof usage.input_tokens === "number"
      ? usage.input_tokens
      : typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : undefined;
  const outputTokens =
    typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : undefined;
  const totalTokens =
    typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function metadataFromValue(value: unknown): ResponseMetadata | undefined {
  if (!value || typeof value !== "object") return;
  const response =
    "response" in value &&
    value.response &&
    typeof value.response === "object"
      ? value.response
      : value;
  if (!("id" in response) || typeof response.id !== "string") return;
  const usage =
    "usage" in response && response.usage && typeof response.usage === "object"
      ? usageFromObject(response.usage as Record<string, unknown>)
      : {};
  return {
    responseId: response.id,
    ...usage,
  };
}

export async function readResponseMetadata(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return metadataFromValue(await response.json());
  }

  let latest: ResponseMetadata | undefined;
  for (const line of (await response.text()).split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const metadata = metadataFromValue(JSON.parse(data));
      if (metadata) {
        latest = {
          responseId: metadata.responseId,
          inputTokens: metadata.inputTokens ?? latest?.inputTokens,
          outputTokens: metadata.outputTokens ?? latest?.outputTokens,
          totalTokens: metadata.totalTokens ?? latest?.totalTokens,
        };
      }
    } catch {
      // The OpenAI SDK remains responsible for validating malformed events.
    }
  }
  return latest;
}

export class ResponseMetadataTracker {
  readonly fetch: typeof globalThis.fetch;
  private pending?: {
    resolve: (metadata: ResponseMetadata) => void;
    reject: (error: unknown) => void;
  };

  constructor(fetchImplementation: typeof globalThis.fetch = globalThis.fetch) {
    this.fetch = async (input, init) => {
      const pending = this.pending;
      this.pending = undefined;
      const response = await fetchImplementation(input, init);
      if (pending) {
        void readResponseMetadata(response.clone()).then((metadata) => {
          if (metadata) pending.resolve(metadata);
          else pending.reject(new Error("LM Studio did not return a response id"));
        }, pending.reject);
      }
      return response;
    };
  }

  next() {
    if (this.pending) {
      throw new Error("Only one LM Studio response may be tracked at a time");
    }
    let resolve!: (metadata: ResponseMetadata) => void;
    let reject!: (error: unknown) => void;
    const metadata = new Promise<ResponseMetadata>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.pending = { resolve, reject };
    return {
      metadata,
      cancel: () => {
        if (this.pending?.resolve === resolve) this.pending = undefined;
      },
    };
  }
}
