/**
 * ArgoLink backend, with `fetch` mocked. Nothing here talks to a real server.
 * Run with `npm run test:providers`, from the repository root.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { assetRef, getModel, models, quoteJob, resolveValues, type ModelDef } from "../../src/registry";
import { ArgoError, argoConfig, argoPoll, argoSubmit, type ArgoConfig, type ArgoRequest } from "../../src/server/providers/argolink";
import { localSetupHint } from "../../src/server/providers/local";

type Call = { method: string; url: string; headers: Headers; body?: unknown };

/** A fake server: routes by "METHOD /path" prefix (or full url for storage), records every call. */
function fake(routes: Record<string, (call: Call) => Response>): { cfg: ArgoConfig; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
    const call = { method, url: u.toString(), headers: new Headers(init?.headers), body };
    calls.push(call);
    const key = Object.keys(routes).find((k) => `${method} ${u.host === "argo.test" ? u.pathname : u.toString()}`.startsWith(k));
    if (!key) throw new TypeError("fetch failed");
    return routes[key](call);
  }) as typeof fetch;
  const download = async (url: string) => Buffer.from(`file:${url}`);
  return { cfg: { apiKey: "k-secret", baseUrl: "https://argo.test", fetch: fetchImpl, download }, calls };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const PNG = { data: Buffer.from("png").toString("base64"), mime: "image/png" };

test("config is off without ARGOLINK_API_KEY and trims the slash", () => {
  assert.equal(argoConfig({}), null);
  assert.deepEqual(argoConfig({ ARGOLINK_API_KEY: " k ", ARGOLINK_BASE_URL: "https://x.test/" }), { apiKey: "k", baseUrl: "https://x.test" });
  assert.equal(argoConfig({ ARGOLINK_API_KEY: "k" })?.baseUrl, "https://argolink.io");
});

test("an image call answers on the same response, with the key sent as a bearer", async () => {
  const { cfg, calls } = fake({ "POST /v1/images/generations": () => json({ data: [{ url: "https://cdn.test/a.png" }, { url: "https://cdn.test/b.png" }] }) });
  const out = await argoSubmit(cfg, { path: "/v1/images/generations", call: { model: "m", prompt: "a fox" } }, 1);
  assert.equal(out.state, "done");
  assert.deepEqual(out.state === "done" ? out.files.map(String) : [], ["file:https://cdn.test/a.png"], "only as many as asked for");
  assert.equal(calls[0].headers.get("authorization"), "Bearer k-secret");
});

test("reference files are uploaded first and their tokens become the returned URLs", async () => {
  const { cfg, calls } = fake({
    "POST /v1/media/uploads": () => json({ upload_url: "https://store.test/put/1", media_url: "https://media.test/1.png" }),
    "PUT https://store.test/put/1": () => new Response(null, { status: 200 }),
    "POST /v1/images/edits": () => json({ data: [{ url: "https://cdn.test/e.png" }] }),
  });
  const req: ArgoRequest = { path: "/v1/images/edits", call: { model: "m", prompt: "p", images: [{ image_url: "@m0" }] }, media: { "@m0": PNG } };
  await argoSubmit(cfg, req, 1);
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ["POST /v1/media/uploads", "PUT /put/1", "POST /v1/images/edits"]);
  assert.deepEqual(calls[0].body, { model: "m", type: "image", content_type: "image/png", size_bytes: 3 });
  assert.equal(calls[1].headers.get("authorization"), null, "the key never goes to file storage");
  assert.deepEqual((calls[2].body as { images: unknown }).images, [{ image_url: "https://media.test/1.png" }]);
});

test("a video call is queued with its request id, then polled to a result", async () => {
  let state = "pending";
  const { cfg } = fake({
    "POST /v1/videos/generations": () => json({ request_id: "r1" }),
    "GET /v1/videos/r1": () => json(state === "done" ? { status: "done", video: { url: "https://cdn.test/v.mp4" } } : state === "failed" ? { status: "failed", error: "bad prompt" } : { status: state }),
  });
  assert.deepEqual(await argoSubmit(cfg, { path: "/v1/videos/generations", call: { model: "m" } }, 1), { state: "queued", id: "r1" });
  assert.deepEqual(await argoPoll(cfg, "r1"), { state: "running" });
  state = "done";
  const done = await argoPoll(cfg, "r1");
  assert.deepEqual(done.state === "done" ? done.files.map(String) : [], ["file:https://cdn.test/v.mp4"]);
  state = "failed";
  assert.deepEqual(await argoPoll(cfg, "r1"), { state: "failed", error: "ArgoLink: bad prompt" });
});

test("errors are told apart: a refusal shows ArgoLink's message, a dead server is unreachable", async () => {
  const refused = fake({ "POST /v1/videos/generations": () => json({ error: { message: "quota exceeded" } }, 402) });
  await assert.rejects(argoSubmit(refused.cfg, { path: "/v1/videos/generations", call: {} }, 1), (e: unknown) => e instanceof ArgoError && !e.unreachable && e.message === "ArgoLink: quota exceeded");
  const down = fake({});
  await assert.rejects(argoPoll(down.cfg, "r1"), (e: unknown) => e instanceof ArgoError && e.unreachable);
});

test("files ArgoLink cannot take, and non-https upload addresses, are refused before anything is sent on", async () => {
  const bad = fake({});
  await assert.rejects(argoSubmit(bad.cfg, { path: "/v1/images/edits", call: { images: [{ image_url: "@m0" }] }, media: { "@m0": { data: "AAAA", mime: "application/pdf" } } }, 1), /does not take/);
  assert.equal(bad.calls.length, 0);
  const http = fake({ "POST /v1/media/uploads": () => json({ upload_url: "http://store.test/put", media_url: "https://media.test/1.png" }) });
  await assert.rejects(argoSubmit(http.cfg, { path: "/v1/images/edits", call: { images: [{ image_url: "@m0" }] }, media: { "@m0": PNG } }, 1), /invalid upload address/);
});

test("a finished image that cannot be downloaded fails the job instead of passing nothing on", async () => {
  const { cfg } = fake({ "POST /v1/images/generations": () => json({ data: [{ url: "https://cdn.test/a.png" }] }) });
  cfg.download = async () => {
    throw new Error("nope");
  };
  await assert.rejects(argoSubmit(cfg, { path: "/v1/images/generations", call: {} }, 1), /could not be downloaded/);
  const empty = fake({ "POST /v1/images/generations": () => json({ data: [] }) });
  await assert.rejects(argoSubmit(empty.cfg, { path: "/v1/images/generations", call: {} }, 1), /returned no image/);
});

/* ------------------------------- registry models ------------------------------ */

const argo = models.filter((m) => m.vendor === "ArgoLink");

function build(model: ModelDef, filled: Record<string, number> = {}, mimes: Record<string, string> = {}, values: Record<string, string | number | boolean> = {}) {
  const media: Record<string, ReturnType<typeof assetRef>[]> = {};
  for (const [slot, n] of Object.entries(filled)) media[slot] = Array.from({ length: n }, (_, i) => assetRef(`ast_${slot}${i}`.padEnd(20, "0"), mimes[slot] ?? "image/png"));
  const resolved = resolveValues(model, values, filled);
  return quoteJob(model, { prompt: "a fox", values: resolved, media, filled, count: 1 });
}

test("every ArgoLink model is free to quote, local, and builds a plain request from its defaults", () => {
  assert.equal(argo.length, 11);
  for (const m of argo) {
    const q = build(m, m.id.endsWith("-edit") || m.id.endsWith("-extend") ? { source: 1 } : {}, { source: "video/mp4" });
    assert.equal(q.millicredits, 0, m.id);
    assert.match(q.request.endpoint, /^argolink\.(image|video)$/, m.id);
    const body = q.request.body as { path: string; call: Record<string, unknown> };
    assert.ok(body.path.startsWith("/v1/"), m.id);
    assert.equal(body.call.prompt, "a fox", m.id);
    assert.ok(!JSON.stringify(body).includes("undefined"), m.id);
  }
});

test("a start frame makes the shape adaptive on Seedance 2.5 and an explicit ratio elsewhere, and its file travels as a token", () => {
  const seedance = build(getModel("argolink-seedance-2.5")!, { start: 1 });
  const call = (seedance.request.body as { call: Record<string, unknown>; media: Record<string, unknown> });
  assert.equal(call.call.aspect_ratio, "adaptive");
  assert.deepEqual(call.call.start_image, { url: "@m0" });
  assert.deepEqual(Object.keys(call.media), ["@m0"]);
  const wan = build(getModel("argolink-wan-3")!, { start: 1 }).request.body as { call: Record<string, unknown> };
  assert.equal(wan.call.aspect_ratio, "16:9");
  assert.equal(wan.call.generate_audio, undefined, "Wan has no sound control");
});

test("references become reference_images, an image edit goes to the edits path, and Grok video drops the ratio with pictures", () => {
  const refs = build(getModel("argolink-wan-3")!, { refs: 2 }).request.body as { call: { reference_images: unknown[] } };
  assert.equal(refs.call.reference_images.length, 2);
  const edit = build(getModel("argolink-grok-image")!, { refs: 1 }).request.body as { path: string; call: { images: unknown[] } };
  assert.equal(edit.path, "/v1/images/edits");
  assert.equal(edit.call.images.length, 1);
  assert.equal((build(getModel("argolink-grok-image")!).request.body as { path: string }).path, "/v1/images/generations");
  const grok = build(getModel("argolink-grok-video")!, { refs: 1 }).request.body as { call: Record<string, unknown> };
  assert.equal(grok.call.aspect_ratio, undefined);
  assert.ok(grok.call.reference_images);
});

test("edit and extend send the source clip as a reference video; only extend adds a length", () => {
  const edit = build(getModel("argolink-seedance-2.5-edit")!, { source: 1 }, { source: "video/mp4" }).request.body as { call: Record<string, unknown>; media: Record<string, { mime: string }> };
  assert.equal(edit.call.omni_reference_task_type, "edit");
  assert.equal(edit.call.duration, undefined);
  assert.deepEqual(edit.call.reference_videos, [{ url: "@m0" }]);
  assert.equal(edit.media["@m0"].mime, "video/mp4");
  const extend = build(getModel("argolink-seedance-2.5-extend")!, { source: 1 }, { source: "video/mp4" }).request.body as { call: Record<string, unknown> };
  assert.equal(extend.call.omni_reference_task_type, "extend");
  assert.equal(typeof extend.call.duration, "number");
});

test("an unset key is named in the refusal, and other endpoints are left alone", () => {
  assert.equal(localSetupHint("argolink.video", {}), "Set ARGOLINK_API_KEY.");
  assert.equal(localSetupHint("argolink.image", { ARGOLINK_API_KEY: "k" }), null);
  assert.equal(localSetupHint("comfyui.image", {}), "Set COMFYUI_BASE_URL.");
  assert.equal(localSetupHint("openrouter.x.some-model", {}), null);
});
