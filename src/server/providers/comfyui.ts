/**
 * A local ComfyUI server as a generation backend. Free, runs on the operator's own GPU.
 *
 * It is only a transport: `comfySubmit` queues a workflow and returns ComfyUI's prompt id,
 * `comfyPoll` asks how it is doing and downloads the images when done. The worker owns the
 * job row, the credit hold and saving the files. Config comes in as an argument and `fetch`
 * is injectable, so tests never touch a network.
 *
 * Shortcut: only the two shipped graphs (text to image, image to image) are supported, with one
 * output kind, images. Upgrade when a video or user-supplied graph is needed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  checkpointsFromObjectInfo,
  frameSize,
  graphUsesCheckpoint,
  injectWorkflow,
  readHistory,
  viewQuery,
  type ComfyFile,
} from "./comfyui-workflow";

/** One definition, shared with the registry, of which endpoint ids are served here. */
export { isLocalEndpoint } from "../../registry/local";

export const COMFYUI_DEFAULT_BASE = "http://127.0.0.1:8188";

export interface ComfyConfig {
  baseUrl: string;
  token?: string;
  /** Used when a request names no checkpoint. Without it the server's first one is used, which is arbitrary. */
  checkpoint?: string;
  fetch?: typeof fetch;
}

/** Null when `COMFYUI_BASE_URL` is not set: ComfyUI is opt-in, so a studio without one shows no dead backend. */
export function comfyConfig(env: Record<string, string | undefined> = process.env): ComfyConfig | null {
  const base = env.COMFYUI_BASE_URL?.trim();
  if (!base) return null;
  return { baseUrl: base.replace(/\/$/, ""), token: env.COMFYUI_AUTH_TOKEN?.trim() || undefined, checkpoint: env.COMFYUI_CHECKPOINT?.trim() || undefined };
}

/** `unreachable` is true when nothing answered, so the worker may try again. */
export class ComfyError extends Error {
  constructor(
    message: string,
    readonly unreachable = false,
  ) {
    super(message);
  }
}

/** The stored job body, built by the registry entry in `src/registry/local.ts`. */
export interface ComfyRequest {
  prompt: string;
  negative?: string;
  checkpoint?: string;
  aspect?: string;
  size?: string;
  /** A reference image as base64, for image to image. */
  reference?: string;
  mime?: string;
}

const SHIPPED = path.join(process.cwd(), "workflows", "comfyui");

export async function comfySubmit(cfg: ComfyConfig, req: ComfyRequest): Promise<string> {
  const reference = req.reference ? Buffer.from(req.reference, "base64") : null;
  const graph = JSON.parse(readFileSync(path.join(SHIPPED, reference ? "img2img.json" : "txt2img.json"), "utf8")) as unknown;

  let checkpoint = req.checkpoint?.trim() || cfg.checkpoint || "";
  if (graphUsesCheckpoint(graph) && !checkpoint) {
    checkpoint = checkpointsFromObjectInfo(await send(cfg, "GET", "/object_info/CheckpointLoaderSimple"))[0] ?? "";
    if (!checkpoint) throw new ComfyError("ComfyUI has no checkpoints. Put one in its models/checkpoints folder.");
  }

  let image = "";
  if (reference) image = await upload(cfg, reference, req.mime ?? "image/png");

  const size = frameSize(req.aspect ?? "1:1", req.size ?? "512");
  const prompt = injectWorkflow(graph, {
    prompt: req.prompt,
    negative: req.negative ?? "",
    checkpoint,
    image,
    seed: Math.floor(Math.random() * 2_147_483_647) + 1,
    width: size.width,
    height: size.height,
  });

  const queued = asRecord(await send(cfg, "POST", "/prompt", JSON.stringify({ prompt, client_id: "parallax" }), true));
  if (Object.keys(asRecord(queued.node_errors)).length > 0) throw new ComfyError("ComfyUI rejected the workflow. Check that the checkpoint name exists on the server.");
  if (typeof queued.prompt_id !== "string" || !queued.prompt_id) throw new ComfyError("ComfyUI did not return a prompt id.");
  return queued.prompt_id;
}

export type ComfyPoll = { state: "running" } | { state: "failed"; error: string } | { state: "done"; files: Buffer[] };

export async function comfyPoll(cfg: ComfyConfig, promptId: string, limit: number): Promise<ComfyPoll> {
  const view = readHistory(await send(cfg, "GET", `/history/${encodeURIComponent(promptId)}`), promptId);
  if (view.state === "running") return { state: "running" };
  if (view.state === "failed") return { state: "failed", error: view.error ?? "ComfyUI reported a failure" };
  const files: Buffer[] = [];
  for (const file of view.images.slice(0, Math.max(1, limit))) files.push(await download(cfg, file));
  return { state: "done", files };
}

/* -------------------------------- transport -------------------------------- */

async function request(cfg: ComfyConfig, method: "GET" | "POST", pathname: string, body?: BodyInit, json = false): Promise<Response> {
  const headers = new Headers();
  if (cfg.token) headers.set("Authorization", `Bearer ${cfg.token}`);
  if (json) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await (cfg.fetch ?? fetch)(`${cfg.baseUrl}${pathname}`, { method, headers, body });
  } catch {
    throw new ComfyError("ComfyUI is unreachable. Is it running at COMFYUI_BASE_URL?", true);
  }
  return response;
}

async function send(cfg: ComfyConfig, method: "GET" | "POST", pathname: string, body?: BodyInit, json = false): Promise<unknown> {
  const response = await request(cfg, method, pathname, body, json);
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) throw new ComfyError(errorMessage(payload, response.status), response.status >= 500);
  return payload;
}

async function download(cfg: ComfyConfig, file: ComfyFile): Promise<Buffer> {
  const response = await request(cfg, "GET", `/view?${viewQuery(file).toString()}`);
  if (!response.ok) throw new ComfyError(`ComfyUI could not return the image (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

async function upload(cfg: ComfyConfig, bytes: Buffer, mime: string): Promise<string> {
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(bytes)], { type: mime }), `parallax-${Date.now()}.png`);
  const payload = asRecord(await send(cfg, "POST", "/upload/image", form));
  if (typeof payload.name !== "string" || !payload.name) throw new ComfyError("ComfyUI did not accept the reference image.");
  return payload.name;
}

function errorMessage(payload: unknown, status: number): string {
  const record = asRecord(payload);
  const nested = asRecord(record.error);
  if (typeof nested.message === "string" && nested.message) return `ComfyUI: ${nested.message}`;
  if (typeof record.error === "string" && record.error) return `ComfyUI: ${record.error}`;
  return `ComfyUI request failed (${status}).`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
