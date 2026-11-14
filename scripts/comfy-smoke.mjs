// Real run: Parallax -> real ComfyUI. Localhost only. Usage: node scripts/comfy-smoke.mjs <output-dir>  (server on :3100, see HANDOVER.md)
import { writeFileSync } from "node:fs";
const SP = process.argv[2];
const B = "http://localhost:3100";
const H = { Origin: B, "content-type": "application/json" };
let cookie = "";
const call = async (method, path, body) => {
  const r = await fetch(B + path, { method, headers: { ...H, cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const t = await r.text();
  try { return [r.status, JSON.parse(t)]; } catch { return [r.status, t.slice(0, 200)]; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

for (let i = 0; i < 40; i++) { try { await fetch(B); break; } catch { await sleep(1000); } }
let [s, g] = await call("POST", "/api/auth/guest");
console.log("guest", s, "balance", g.balance);

async function run(label, body) {
  [s] = await call("POST", "/api/jobs", body);
  console.log(`[${secs()}] ${label}: submit ->`, s);
  let job;
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    const [, out] = await call("GET", "/api/jobs?limit=1");
    job = out.jobs[0];
    if (job.status === "succeeded" || job.status === "failed") break;
  }
  console.log(`[${secs()}] ${label}: ${job.status}`, job.status === "failed" ? JSON.stringify(job.error ?? job).slice(0, 300) : "");
  return job;
}

const a = await run("text->image", { modelId: "comfyui", prompt: "a red fox sitting in fresh snow, golden hour, detailed fur, photograph", values: { aspect: "1:1", resolution: "512" } });
const assets = a.assets ?? a.outputs ?? a.results ?? [];
console.log("asset keys:", assets[0] ? Object.keys(assets[0]).join(",") : "none; job keys: " + Object.keys(a).join(","));
const first = assets[0];
if (first) {
  const url = first.url ?? first.src ?? `/api/assets/${first.id}/file`;
  const r = await fetch(url.startsWith("http") ? url : B + url, { headers: { cookie, Origin: B } });
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(`${SP}/fox-txt2img.png`, buf);
  console.log("downloaded", r.status, r.headers.get("content-type"), buf.length, "bytes", url);
  const b = await run("img2img", { modelId: "comfyui", prompt: "the same fox as an oil painting", inputs: { refs: [first.id] } });
  const a2 = (b.assets ?? b.outputs ?? [])[0];
  if (a2) {
    const u2 = a2.url ?? a2.src ?? `/api/assets/${a2.id}/file`;
    const r2 = await fetch(u2.startsWith("http") ? u2 : B + u2, { headers: { cookie, Origin: B } });
    writeFileSync(`${SP}/fox-img2img.png`, Buffer.from(await r2.arrayBuffer()));
    console.log("downloaded img2img", r2.status);
  }
}
[s, g] = await call("POST", "/api/auth/guest");
console.log("balance after (free model):", g.balance);
