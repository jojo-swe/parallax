/**
 * Pure helpers for ComfyUI: fill a workflow graph, read the history answer, work out sizes.
 * No I/O and no Node imports, so they can be tested without a server.
 */

export type ComfyFile = { filename: string; subfolder: string; type: string };

export type ComfyHistoryView = {
  state: "running" | "completed" | "failed";
  images: ComfyFile[];
  error?: string;
};

const NUMERIC = new Set(["seed", "width", "height"]);

/** Replaces `{{name}}` placeholders in a workflow graph. A lone placeholder keeps the value's type. */
export function injectWorkflow(graph: unknown, values: Record<string, string | number>): Record<string, unknown> {
  const injected = inject(graph, values);
  if (injected === null || typeof injected !== "object" || Array.isArray(injected)) throw new Error("ComfyUI workflow must be a JSON object");
  return injected as Record<string, unknown>;
}

export function graphUsesCheckpoint(graph: unknown): boolean {
  return JSON.stringify(graph).includes("{{checkpoint}}");
}

/** The checkpoint file names a server offers, from `/object_info/CheckpointLoaderSimple`. */
export function checkpointsFromObjectInfo(payload: unknown): string[] {
  const loader = asRecord(payload).CheckpointLoaderSimple ?? payload;
  const ckpt = asRecord(asRecord(asRecord(loader).input).required).ckpt_name;
  const list = Array.isArray(ckpt) ? ckpt[0] : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** Reads `/history/{id}`. An empty answer means the job is still waiting or running. */
export function readHistory(payload: unknown, promptId: string): ComfyHistoryView {
  const root = asRecord(payload);
  const entry = asRecord(root[promptId] ?? (root.outputs || root.status ? root : {}));
  if (Object.keys(entry).length === 0) return { state: "running", images: [] };
  const status = asRecord(entry.status);
  if (status.status_str === "error") return { state: "failed", images: [], error: historyError(status) };
  const images = outputImages(entry.outputs);
  if (images.length === 0) {
    if (status.completed === true) return { state: "failed", images: [], error: "ComfyUI finished without an image" };
    return { state: "running", images: [] };
  }
  return { state: "completed", images };
}

/** Query string for `GET /view`. */
export function viewQuery(file: ComfyFile): URLSearchParams {
  const params = new URLSearchParams({ filename: file.filename, type: file.type || "output" });
  if (file.subfolder) params.set("subfolder", file.subfolder);
  return params;
}

/** `16:9` at a long side of 1024 -> 1024x576. Both sides snap to a multiple of 8, as the samplers need. */
export function frameSize(aspect: string, resolution: string): { width: number; height: number } {
  const long = Number(resolution);
  const [w, h] = aspect.split(":").map(Number);
  if (!Number.isFinite(long) || !w || !h) throw new Error("Invalid size");
  const width = w >= h ? long : Math.round((long * w) / h);
  const height = w >= h ? Math.round((long * h) / w) : long;
  return { width: snap8(width), height: snap8(height) };
}

const snap8 = (value: number) => Math.max(64, Math.round(value / 8) * 8);

function inject(value: unknown, values: Record<string, string | number>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{([a-z]+)\}\}$/);
    const key = exact?.[1];
    if (key && Object.prototype.hasOwnProperty.call(values, key)) {
      const replacement = values[key];
      if (replacement !== undefined && NUMERIC.has(key)) return replacement;
      return replacement ?? "";
    }
    return value.replace(/\{\{([a-z]+)\}\}/g, (_, name: string) => {
      const replacement = values[name];
      return replacement === undefined ? "" : String(replacement);
    });
  }
  if (Array.isArray(value)) return value.map((item) => inject(item, values));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = inject(item, values);
    return out;
  }
  return value;
}

function outputImages(outputs: unknown): ComfyFile[] {
  const images: ComfyFile[] = [];
  for (const node of Object.values(asRecord(outputs))) {
    const list = asRecord(node).images;
    for (const image of Array.isArray(list) ? list : []) {
      const record = asRecord(image);
      if (typeof record.filename !== "string" || !record.filename) continue;
      images.push({
        filename: record.filename,
        subfolder: typeof record.subfolder === "string" ? record.subfolder : "",
        type: typeof record.type === "string" && record.type ? record.type : "output",
      });
    }
  }
  return images;
}

function historyError(status: Record<string, unknown>): string {
  // ComfyUI writes messages as ["execution_error", { exception_message, ... }] pairs.
  for (const message of Array.isArray(status.messages) ? status.messages : []) {
    for (const part of Array.isArray(message) ? message : [message]) {
      const record = asRecord(part);
      const text = record.exception_message ?? record.message;
      if (typeof text === "string" && text.trim()) return text.trim().slice(0, 300);
    }
  }
  return "ComfyUI reported a failure";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
