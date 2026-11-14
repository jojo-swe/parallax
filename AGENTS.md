<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Parallax (fork)

Read `HANDOVER.md` for the current state of this fork, `README.md` for setup, `CONTRIBUTING.md`
for the upstream rules.

## Gates

Run before you push:

```bash
npm run typecheck
npm run lint            # warnings exist upstream; there must be no errors
npm run check:registry
npm run test:providers  # mocked fetch, no network
npm run build
```

`npm test` (Python and browser walk-throughs) needs Python 3 and Chrome. Never call a live gateway
or a real ComfyUI from tests.

## Local backends

A model whose `build()` returns an endpoint id starting with `comfyui.` is a local backend:
`src/registry/local.ts` defines it, `src/server/providers/` talks to it, and `src/server/worker.ts`
dispatches to it instead of the treg gateway. It quotes zero credits. To add another local backend,
extend `isLocalEndpoint` in `src/registry/local.ts`, add the transport next to `comfyui.ts`, add a
branch in the worker's `startLocal` and `pollLocal`, and add mocked tests under `tests/providers/`.

## Hard rules for this fork

- Do not push to `main` and do not open a pull request upstream unless the owner says so.
- No private data in commits: no personal email, no internal IPs, no `*.ts.net` hosts, no
  usernames in paths, no secrets, no `.env` contents. Examples use `http://127.0.0.1:8188`.
- Do not add a new paid service. The treg gateway is optional (mock mode needs nothing).
- Keep the upstream MIT `LICENSE` and copyright line.
