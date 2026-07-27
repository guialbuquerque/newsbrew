export type ModelContext = {
  model: string;
  activeContextTokens: number;
  maximumContextTokens: number;
};

type ModelRecord = {
  key?: unknown;
  max_context_length?: unknown;
  loaded_instances?: unknown;
};

function positiveInteger(value: unknown) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : undefined;
}

export function modelListURL(baseURL: string) {
  const url = new URL(baseURL);
  const path = url.pathname.replace(/\/v1\/?$/, "/api/v1/models");
  if (path === url.pathname) {
    throw new Error(
      `LM_STUDIO_BASE_URL must end in /v1 to derive the LM Studio model metadata endpoint; received ${baseURL}`,
    );
  }
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url;
}

export function parseModelContext(payload: unknown, configuredModel: string) {
  if (!payload || typeof payload !== "object" || !("models" in payload)) {
    throw new Error("LM Studio returned invalid model metadata");
  }
  const models = Array.isArray(payload.models) ? payload.models : [];
  const model = models.find((candidate): candidate is ModelRecord => {
    if (!candidate || typeof candidate !== "object") return false;
    const record = candidate as ModelRecord;
    if (record.key === configuredModel) return true;
    if (!Array.isArray(record.loaded_instances)) return false;
    return record.loaded_instances.some(
      (instance) =>
        instance &&
        typeof instance === "object" &&
        "id" in instance &&
        instance.id === configuredModel,
    );
  });
  if (!model || typeof model.key !== "string") {
    throw new Error(
      `LM Studio does not report the configured model "${configuredModel}"`,
    );
  }

  const maximumContextTokens = positiveInteger(model.max_context_length);
  if (!maximumContextTokens) {
    throw new Error(
      `LM Studio did not report a maximum context length for "${configuredModel}"`,
    );
  }
  const instances = Array.isArray(model.loaded_instances)
    ? model.loaded_instances
    : [];
  const exactInstance = instances.find(
    (instance) =>
      instance &&
      typeof instance === "object" &&
      "id" in instance &&
      instance.id === configuredModel,
  );
  const loadedInstance = exactInstance ?? instances[0];
  const activeContextTokens =
    loadedInstance &&
    typeof loadedInstance === "object" &&
    "config" in loadedInstance &&
    loadedInstance.config &&
    typeof loadedInstance.config === "object" &&
    "context_length" in loadedInstance.config
      ? positiveInteger(loadedInstance.config.context_length)
      : undefined;
  if (!activeContextTokens) {
    throw new Error(
      `Model "${configuredModel}" is not loaded with a known context length. Load it in LM Studio before running Newsbrew.`,
    );
  }

  return {
    model: model.key,
    activeContextTokens,
    maximumContextTokens,
  } satisfies ModelContext;
}

export async function fetchModelContext(options: {
  baseURL: string;
  model: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}) {
  const response = await (options.fetch ?? globalThis.fetch)(
    modelListURL(options.baseURL),
    {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `LM Studio model metadata returned ${response.status}`,
    );
  }
  return parseModelContext(await response.json(), options.model);
}
