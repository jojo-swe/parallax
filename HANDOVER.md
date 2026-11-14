# Handover

## Purpose

Personal fork of [nickvasilescu/parallax](https://github.com/nickvasilescu/parallax) (MIT). It is
the new base for the private studio that used to live in `open-higgsfield-multi`. The idea is to
keep Parallax's product (studios, library, credits, agent chat) and add what the old repo had that
Parallax lacks: local and alternative generation backends.

`upstream` is the original repo, `origin` is this fork. Pull upstream changes with
`git fetch upstream && git merge upstream/main`.

## Current state

- **Parallax itself:** unchanged apart from the points below.
- **ComfyUI backend (added here):** a "ComfyUI" model in the image studio. Text to image, or image
  to image with one reference. Free (quotes 0 credits, not even the one-step minimum), no gateway
  needed. Enabled by `COMFYUI_BASE_URL`; optional `COMFYUI_AUTH_TOKEN`.
  - `src/registry/local.ts` the model and `isLocalEndpoint`
  - `src/server/providers/comfyui.ts`, `comfyui-workflow.ts` transport and pure helpers
  - `src/server/worker.ts` `startLocal` / `pollLocal`; the backend's prompt id is stored in the
    existing `treg_call_id` column, so no migration
  - `src/server/jobs.ts` accepts local endpoints and refuses them when the URL is not set
  - `workflows/comfyui/txt2img.json`, `img2img.json` the shipped graphs
  - `tests/providers/comfyui.test.ts` mocked tests, run with `npm run test:providers`

## Verified

- `typecheck`, `check:registry` (40 models), `test:providers` (11 tests) and `build` pass; lint has
  0 errors (25 upstream warnings).
- End to end against a stand-in ComfyUI (a small fake HTTP server, not the real thing): a guest
  submitted two text-to-image jobs and one image-to-image job, all succeeded, files were saved as
  assets, and the balance stayed at 60000.

- **Real ComfyUI (v0.42.1, RTX 4080), checkpoint `dreamshaper_8.safetensors` set through
  `COMFYUI_CHECKPOINT`:** a guest's text-to-image job (512x512) succeeded in 7 s and an
  image-to-image job using that picture as reference in 12 s. Both images were real pictures (a
  fox in snow, then a painted version keeping the pose), saved as assets, and the balance stayed
  at 60000. Run from the install's own `ComfyUI\.venv` Python (it has torch 2.12.1+cu130 with
  CUDA); the `standalone-env` folder next to it has no torch and is not the one the app uses.
  Output and input folders were redirected to a scratch folder, so nothing was written to the
  install's own folders.
- Parallax's own Python suite (`tests/*.py`, 12 files, 937 checks) passes with these changes,
  including `core_e2e` and `core_recovery` (the worker path). On Windows `tests/run.py` and two
  test files call `os.killpg`, which does not exist there. Run them with a `sitecustomize.py` on
  `PYTHONPATH` that defines `os.killpg` and `signal.SIGKILL`; this is a harness issue, not the code.

## Picking this up on another machine

```bash
git clone https://github.com/jojo-swe/parallax.git && cd parallax
git remote add upstream https://github.com/nickvasilescu/parallax.git
npm ci                       # Node >= 22.13 (built-in SQLite)
cp .env.example .env.local   # leave TREG_TOKEN empty for mock mode; no secrets in git
npm run typecheck && npm run check:registry && npm run test:providers && npm run build
```

- Nothing from the first machine is needed: no database, no keys, no local-only files.
- To use ComfyUI: run it, set `COMFYUI_BASE_URL` (default `http://127.0.0.1:8188`) and
  `COMFYUI_CHECKPOINT` to an **SD 1.x** checkpoint name in `.env.local`. Use the ComfyUI install's
  own Python environment (the one with torch and CUDA), not a bare one.
- Real end-to-end check: start Parallax on port 3100 with those variables, then
  `node scripts/comfy-smoke.mjs <output-dir>`. It makes a guest, runs text to image and image to
  image, saves both pictures and prints the balance (it must stay 60000, the model is free).
- Python suite on Windows: `tests/run.py` calls `os.killpg`, which Windows lacks. Put
  `scripts/windows` on `PYTHONPATH` (it holds a `sitecustomize.py` that fills the gap) and run
  `python tests/run.py ...` from the repo root. Linux and macOS need nothing.
- Git: `main` is this fork's default. Work on `agent/<tool>/<topic>` branches. Do not push to
  `main` or open a PR against upstream unless the owner says so.

## Not verified

- Only SD 1.5 checkpoints were tried on the real server. SDXL, Turbo, FLUX and video checkpoints
  need different graphs (steps, cfg, loaders) and are not supported.
- The browser walk-throughs (`tests/ui/*.mjs`, need Chrome) were not run.
- The server's first checkpoint is arbitrary. On the dev machine the checkpoint folder mixes
  SD 1.5, SDXL, FLUX and video models, and the shipped graphs only suit SD 1.x. Set
  `COMFYUI_CHECKPOINT`.
- The model shows in the picker even when `COMFYUI_BASE_URL` is unset; submitting then fails with a
  clear message. The registry is shared with the browser and cannot read the server's environment.

## Not ported from the old repo

- **ArgoLink adapter** (`src/generation/providers/argolink*.ts` in `open-higgsfield-multi`). Its
  models overlap what treg already offers. Port only if a cheaper or separate route is wanted.
- **Direct Higgsfield adapter and catalog.** They came from `wide-trace/open-higgsfield`, which has
  no license. Do not copy them into this MIT tree without checking what is original.
- Vercel Blob upload, the old model picker and the old UI: Parallax has its own.
- User-supplied ComfyUI workflow directory and video workflows: dropped to keep the port small.

## Next steps

- Add graphs for SDXL, Turbo and FLUX checkpoints if wanted (the shipped graphs are SD 1.x only),
  or let the studio pick a graph from the checkpoint.
- Decide whether this fork stays public (a GitHub fork of a public repo cannot be made private) or
  moves to a private copy.
- Decide on ArgoLink.
- If the studio is ever reachable by anyone else: gate the server keys first. Parallax is a
  multi-user app; run it on your own machine.

## Log

- 2026-11-14, Claude Code: forked Parallax, added the ComfyUI local backend on branch
  `agent/claude/comfyui-provider`, pushed to `origin` (public fork) and fast-forwarded into `main` on the owner's say-so.
- 2026-11-14, Claude Code: ran the ComfyUI model against the real local ComfyUI with
  `COMFYUI_CHECKPOINT=dreamshaper_8.safetensors`: text to image and image to image both worked.
  Corrected an earlier wrong note that the install had no torch (the wrong Python was used).
- 2026-11-14, Claude Code: prepared the hand-over to another machine: setup steps above, the
  Windows test shim (`scripts/windows`) and the real-server smoke script (`scripts/comfy-smoke.mjs`)
  are now in the repo. Branch `agent/claude/handover-other-pc`; `main` is untouched by this.
  Stale branches that can be deleted: `agent/claude/comfyui-provider`, `agent/claude/handover-real-test`
  (both already contained in `main`).
