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

- `typecheck`, `check:registry` (40 models), `test:providers` (10 tests) and `build` pass; lint has
  0 errors (25 upstream warnings).
- End to end against a stand-in ComfyUI (a small fake HTTP server, not the real thing): a guest
  submitted two text-to-image jobs and one image-to-image job, all succeeded, files were saved as
  assets, and the balance stayed at 60000.

## Not verified

- Never run against a **real ComfyUI**. Workflow node names, checkpoint handling and the
  `/history` shape come from the old repo's mocked tests.
- `npm test` (Python and Chrome walk-throughs) was not run.
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

- Run the ComfyUI model against a real local server and record what fails.
- Decide whether this fork stays public (a GitHub fork of a public repo cannot be made private) or
  moves to a private copy.
- Decide on ArgoLink.
- If the studio is ever reachable by anyone else: gate the server keys first. Parallax is a
  multi-user app; run it on your own machine.

## Log

- 2026-11-14, Claude Code: forked Parallax, added the ComfyUI local backend on branch
  `agent/claude/comfyui-provider`. Not pushed.
