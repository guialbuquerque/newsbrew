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

export function modelLoadURL(baseURL: string) {
  const url = modelListURL(baseURL);
  url.pathname = `${url.pathname}/load`;
  return url;
}

function configuredModelRecord(payload: unknown, configuredModel: string) {
  if (!payload || typeof payload !== "object" || !("models" in payload)) {
    throw new Error("LM Studio returned invalid model metadata");
  }
  const models = Array.isArray(payload.models) ? payload.models : [];
  return models.find((candidate): candidate is ModelRecord => {
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
}

export function parseModelContext(payload: unknown, configuredModel: string) {
  const model = configuredModelRecord(payload, configuredModel);
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

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

async function fetchModelMetadata(options: {
  baseURL: string;
  apiKey: string;
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
}) {
  const response = await options.fetch(modelListURL(options.baseURL), {
    headers: { Authorization: `Bearer ${options.apiKey}` },
    signal: requestSignal(options.signal, 10_000),
  });
  if (!response.ok) {
    throw new Error(
      `LM Studio model metadata returned ${response.status}`,
    );
  }
  return response.json();
}

export async function fetchModelContext(options: {
  baseURL: string;
  model: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}) {
  const payload = await fetchModelMetadata({
    ...options,
    fetch: options.fetch ?? globalThis.fetch,
  });
  return parseModelContext(payload, options.model);
}

const pendingModelLoads = new Map<string, Promise<ModelContext>>();

export function ensureModelContext(options: {
  baseURL: string;
  model: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}) {
  const key = `${options.baseURL}\n${options.model}`;
  const pending = pendingModelLoads.get(key);
  if (pending) return pending;

  const load = (async () => {
    const request = options.fetch ?? globalThis.fetch;
    const payload = await fetchModelMetadata({
      ...options,
      fetch: request,
    });
    const model = configuredModelRecord(payload, options.model);
    if (!model || typeof model.key !== "string") {
      throw new Error(
        `LM Studio does not report the configured model "${options.model}"`,
      );
    }
    const instances = Array.isArray(model.loaded_instances)
      ? model.loaded_instances
      : [];
    if (instances.length > 0) {
      return parseModelContext(payload, options.model);
    }

    const maximumContextTokens = positiveInteger(model.max_context_length);
    if (!maximumContextTokens) {
      throw new Error(
        `LM Studio did not report a maximum context length for "${options.model}"`,
      );
    }
    const response = await request(modelLoadURL(options.baseURL), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        echo_load_config: true,
      }),
      signal: requestSignal(options.signal, 120_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(
        `LM Studio could not load "${options.model}" (${response.status})${
          detail ? `: ${detail.slice(0, 500)}` : ""
        }`,
      );
    }

    return fetchModelContext({
      ...options,
      fetch: request,
    });
  })();
  pendingModelLoads.set(key, load);
  void load.then(
    () => pendingModelLoads.delete(key),
    () => pendingModelLoads.delete(key),
  );
  return load;
}
