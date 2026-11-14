/**
 * ArgoLink (https://argolink.io) as a generation backend, called with the operator's own key.
 *
 * Transport only, like `comfyui.ts`: `argoSubmit` uploads the reference files, sends the call
 * and either returns the finished images (image calls answer on the same response) or a request
 * id to poll (video calls). The worker owns the job row and saves the files. Config comes in as
 * an argument, and `fetch` and `download` are injectable so tests never touch a network. The
 * worker passes its safe downloader; this file stays free of `server-only` so it can be tested.
 *
 * Shortcut: reference videos and audio for the plain video models are not supported, only
 * pictures (and a source clip for Seedance 2.5 edit and extend). Upgrade when they are needed.
 */
import { ARGOLINK_PATHS } from "../../registry/argolink";

export { ARGOLINK_PREFIX } from "../../registry/argolink";

/** Public API origin from ArgoLink's integration guide. Override with ARGOLINK_BASE_URL. */
export const ARGOLINK_DEFAULT_BASE = "https://argolink.io";

export interface ArgoConfig {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  /** Fetches a result file. The worker passes a downloader that refuses private addresses. */
  download?: (url: string) => Promise<Buffer>;
}

/** Null when `ARGOLINK_API_KEY` is not set: the models then refuse to run. */
export function argoConfig(env: Record<string, string | undefined> = process.env): ArgoConfig | null {
  const apiKey = env.ARGOLINK_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, baseUrl: (env.ARGOLINK_BASE_URL?.trim() || ARGOLINK_DEFAULT_BASE).replace(/\/$/, "") };
}

/** `unreachable` is true when nothing answered, so a poll may try again. */
export class ArgoError extends Error {
  constructor(
    message: string,
    readonly unreachable = false,
  ) {
    super(message);
  }
}

/** The stored job body, built by the registry entries in `src/registry/argolink.ts`. */
export interface ArgoRequest {
  path: string;
  /** ArgoLink's own JSON. A string equal to a key of `media` stands for that file's URL. */
  call: Record<string, unknown>;
  media?: Record<string, { data: string; mime: string }>;
}

export type ArgoStart = { state: "queued"; id: string } | { state: "done"; files: Buffer[] };
export type ArgoPoll = { state: "running" } | { state: "failed"; error: string } | { state: "done"; files: Buffer[] };

/** The file types ArgoLink's upload accepts. */
const UPLOADABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "audio/wav", "audio/x-wav"]);
const MAX_UPLOAD = 100 * 1024 * 1024;

export async function argoSubmit(cfg: ArgoConfig, req: ArgoRequest, limit: number): Promise<ArgoStart> {
  const body = await withUploads(cfg, req);
  const payload = asRecord(await send(cfg, "POST", req.path, body));
  if (req.path === ARGOLINK_PATHS.video) {
    const id = text(payload.request_id);
    if (!id) throw new ArgoError("ArgoLink did not return a request id.");
    return { state: "queued", id };
  }
  const urls = Array.isArray(payload.data) ? payload.data.map((item) => text(asRecord(item).url)).filter((u): u is string => !!u) : [];
  if (urls.length === 0) throw new ArgoError("ArgoLink returned no image.");
  return { state: "done", files: await download(cfg, urls.slice(0, Math.max(1, limit))) };
}

export async function argoPoll(cfg: ArgoConfig, id: string): Promise<ArgoPoll> {
  const payload = asRecord(await send(cfg, "GET", `/v1/videos/${encodeURIComponent(id)}`));
  const status = text(payload.status) ?? "pending";
  if (status === "failed" || status === "expired") {
    const why = text(payload.error);
    return { state: "failed", error: why ? `ArgoLink: ${why}` : messageFrom(200, payload.error ?? payload) };
  }
  if (status !== "done") return { state: "running" };
  const url = text(asRecord(payload.video).url);
  if (!url) throw new ArgoError("ArgoLink returned no video.");
  return { state: "done", files: await download(cfg, [url]) };
}

/* -------------------------------- transport -------------------------------- */

async function request(cfg: ArgoConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  const headers = new Headers({ Authorization: `Bearer ${cfg.apiKey}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  try {
    return await (cfg.fetch ?? fetch)(`${cfg.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ArgoError("ArgoLink is unreachable.", true);
  }
}

async function send(cfg: ArgoConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const response = await request(cfg, method, path, body);
  const raw = await response.text();
  let payload: unknown = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }
  if (!response.ok) throw new ArgoError(messageFrom(response.status, payload), response.status >= 500);
  return payload;
}

async function download(cfg: ArgoConfig, urls: string[]): Promise<Buffer[]> {
  const fetchFile = cfg.download ?? (async (url: string) => Buffer.from(await (await (cfg.fetch ?? fetch)(url)).arrayBuffer()));
  const files: Buffer[] = [];
  for (const url of urls) {
    try {
      files.push(await fetchFile(url));
    } catch {
      throw new ArgoError("ArgoLink made the file, but it could not be downloaded.");
    }
  }
  return files;
}

/* --------------------------------- uploads --------------------------------- */

/** Uploads each reference file to ArgoLink and puts the URL it returns where the token stood. */
async function withUploads(cfg: ArgoConfig, req: ArgoRequest): Promise<Record<string, unknown>> {
  const media = req.media ?? {};
  const urls = new Map<string, string>();
  for (const [token, file] of Object.entries(media)) urls.set(token, await upload(cfg, String(req.call.model ?? ""), file));
  const swap = (value: unknown): unknown => {
    if (typeof value === "string") return urls.get(value) ?? value;
    if (Array.isArray(value)) return value.map(swap);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)]));
    return value;
  };
  return swap(req.call) as Record<string, unknown>;
}

async function upload(cfg: ArgoConfig, model: string, file: { data: string; mime: string }): Promise<string> {
  const bytes = Buffer.from(file.data, "base64");
  if (!UPLOADABLE.has(file.mime)) throw new ArgoError(`ArgoLink does not take ${file.mime || "this kind of"} files.`);
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD) throw new ArgoError("A reference file is too large for ArgoLink. Use one under 100 MB.");
  const ticket = asRecord(await send(cfg, "POST", "/v1/media/uploads", { model, type: file.mime.split("/")[0], content_type: file.mime, size_bytes: bytes.length }));
  const target = httpsUrl(ticket.upload_url);
  const mediaUrl = httpsUrl(ticket.media_url);
  // The storage address is signed, so the API key is not sent to it.
  let put: Response;
  try {
    put = await (cfg.fetch ?? fetch)(target, { method: "PUT", headers: { "Content-Type": file.mime }, body: new Uint8Array(bytes) });
  } catch {
    throw new ArgoError("ArgoLink's file storage is unreachable.");
  }
  if (!put.ok) throw new ArgoError(`ArgoLink did not accept a reference file (${put.status}).`);
  return mediaUrl;
}

function httpsUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:" && !url.username && !url.password) return url.toString();
  } catch {
    /* falls through */
  }
  throw new ArgoError("ArgoLink gave an invalid upload address.");
}

/* --------------------------------- helpers --------------------------------- */

function messageFrom(status: number, body: unknown): string {
  const record = asRecord(body);
  const message = text(record.message) ?? text(asRecord(record.error).message) ?? text(record.detail) ?? text(record.code);
  return message ? `ArgoLink: ${message}` : `ArgoLink request failed (${status}).`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
