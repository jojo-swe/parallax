/**
 * ComfyUI backend, with `fetch` mocked. Nothing here talks to a real server.
 * Run with `npm run test:providers`, from the repository root.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { getModel, quoteJob, resolveValues } from "../../src/registry";
import { ComfyError, comfyConfig, comfyPoll, comfySubmit, type ComfyConfig } from "../../src/server/providers/comfyui";
import { checkpointsFromObjectInfo, frameSize, injectWorkflow, readHistory } from "../../src/server/providers/comfyui-workflow";

type Call = { method: string; path: string; body?: unknown };

/** A fake server: routes by "METHOD /path" prefix, records every call. */
function fake(routes: Record<string, () => Response | Promise<Response>>): { cfg: ComfyConfig; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
    calls.push({ method, path: u.pathname + u.search, body });
    const key = Object.keys(routes).find((k) => `${method} ${u.pathname}`.startsWith(k));
    if (!key) throw new TypeError("fetch failed");
    return routes[key]();
  }) as typeof fetch;
  return { cfg: { baseUrl: "http://comfy.test", fetch: fetchImpl }, calls };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const CKPTS = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors", "b.safetensors"]] } } } };

test("workflow placeholders keep numeric types and fill text", () => {
  const out = injectWorkflow({ n: { inputs: { seed: "{{seed}}", w: "{{width}}", t: "a {{prompt}} b" } } }, { seed: 7, width: 512, prompt: "cat" });
  assert.deepEqual(out, { n: { inputs: { seed: 7, w: 512, t: "a cat b" } } });
});

test("frame size snaps to 8 and follows the long side", () => {
  assert.deepEqual(frameSize("16:9", "1024"), { width: 1024, height: 576 });
  assert.deepEqual(frameSize("9:16", "512"), { width: 288, height: 512 });
  assert.throws(() => frameSize("nonsense", "512"));
});

test("checkpoints are read from object_info", () => {
  assert.deepEqual(checkpointsFromObjectInfo(CKPTS), ["a.safetensors", "b.safetensors"]);
  assert.deepEqual(checkpointsFromObjectInfo({}), []);
});

test("history: empty is running, error carries the exception message, outputs complete", () => {
  assert.equal(readHistory({}, "p1").state, "running");
  const failed = readHistory({ p1: { status: { status_str: "error", messages: [["execution_error", { exception_message: "out of memory" }]] } } }, "p1");
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "out of memory");
  const done = readHistory({ p1: { status: { status_str: "success" }, outputs: { "9": { images: [{ filename: "x.png", subfolder: "", type: "output" }] } } } }, "p1");
  assert.equal(done.state, "completed");
  assert.equal(done.images[0].filename, "x.png");
});

test("config is off without COMFYUI_BASE_URL and trims the slash", () => {
  assert.equal(comfyConfig({}), null);
  assert.deepEqual(comfyConfig({ COMFYUI_BASE_URL: "http://127.0.0.1:8188/", COMFYUI_AUTH_TOKEN: " t " }), { baseUrl: "http://127.0.0.1:8188", token: "t" });
});

test("text to image uses the first checkpoint and queues a filled graph", async () => {
  const { cfg, calls } = fake({
    "GET /object_info": () => json(CKPTS),
    "POST /prompt": () => json({ prompt_id: "p1", node_errors: {} }),
  });
  const id = await comfySubmit(cfg, { prompt: "a red fox", aspect: "1:1", size: "512" });
  assert.equal(id, "p1");
  const queued = JSON.stringify(calls.find((c) => c.path === "/prompt")!.body);
  assert.match(queued, /a\.safetensors/);
  assert.match(queued, /a red fox/);
  assert.doesNotMatch(queued, /\{\{/);
});

test("image to image uploads the reference first", async () => {
  const { cfg, calls } = fake({
    "POST /upload/image": () => json({ name: "ref.png", subfolder: "", type: "input" }),
    "POST /prompt": () => json({ prompt_id: "p2", node_errors: {} }),
  });
  const id = await comfySubmit(cfg, { prompt: "restyle", checkpoint: "b.safetensors", reference: Buffer.from("png").toString("base64"), mime: "image/png" });
  assert.equal(id, "p2");
  assert.deepEqual(calls.map((c) => c.path), ["/upload/image", "/prompt"]);
  assert.match(JSON.stringify(calls[1].body), /"image":"ref\.png"/);
});

test("a rejected workflow and an unreachable server are told apart", async () => {
  const rejected = fake({ "POST /prompt": () => json({ prompt_id: "p3", node_errors: { "4": { errors: [] } } }) });
  await assert.rejects(comfySubmit(rejected.cfg, { prompt: "x", checkpoint: "a.safetensors" }), (e: unknown) => e instanceof ComfyError && !e.unreachable);
  const down = fake({});
  await assert.rejects(comfySubmit(down.cfg, { prompt: "x", checkpoint: "a.safetensors" }), (e: unknown) => e instanceof ComfyError && e.unreachable);
});

test("poll: running, then done with the image bytes", async () => {
  let ready = false;
  const { cfg } = fake({
    "GET /history": () => json(ready ? { p1: { status: { status_str: "success" }, outputs: { "9": { images: [{ filename: "x.png", subfolder: "", type: "output" }] } } } } : {}),
    "GET /view": () => new Response(new Uint8Array([1, 2, 3])),
  });
  assert.deepEqual(await comfyPoll(cfg, "p1", 1), { state: "running" });
  ready = true;
  const done = await comfyPoll(cfg, "p1", 1);
  assert.equal(done.state, "done");
  assert.deepEqual(done.state === "done" ? [...done.files[0]] : [], [1, 2, 3]);
});

test("the registry model is free and routes to the local endpoint", () => {
  const model = getModel("comfyui")!;
  const values = resolveValues(model, { checkpoint: "a.safetensors" }, {});
  const q = quoteJob(model, { prompt: "a fox", values, filled: {}, count: 2 });
  assert.equal(q.request.endpoint, "comfyui.image");
  assert.equal(q.usdPerJob, 0);
  assert.equal(q.millicredits, 0);
  assert.equal(q.jobs, 2);
  assert.equal((q.request.body as { checkpoint?: string }).checkpoint, "a.safetensors");
});
