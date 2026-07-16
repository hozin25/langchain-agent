# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

| Task                                                                                             | Command                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Run the app (Electron + Vite dev server, HMR on renderer; main/preload changes restart Electron) | `pnpm dev`                                                                                                                  |
| Type-check both projects (must pass before committing)                                           | `pnpm typecheck`                                                                                                            |
| Type-check only main/preload or only renderer                                                    | `pnpm typecheck:node` / `pnpm typecheck:web`                                                                                |
| Production build (main + preload + renderer → `out/`)                                            | `pnpm build`                                                                                                                |
| Format check / write                                                                             | `pnpm lint` / `pnpm format`                                                                                                 |
| Run all tests                                                                                    | `pnpm test`                                                                                                                 |
| Run a single test file                                                                           | `pnpm exec vitest run src/main/agent/tools/fileSystem.ts` (no test files exist yet — create `*.test.ts` next to the module) |
| Run tests matching a name, watch mode                                                            | `pnpm exec vitest -t "rejects paths" -w`                                                                                    |
| Build a Windows installer                                                                        | `pnpm package:win` (output in `release/`)                                                                                   |

Required env for the agent to actually call an LLM: copy `.env.example` → `.env` and set `GLM_API_KEY` (default provider; `DEEPSEEK_API_KEY` for deepseek-* models, `TAVILY_API_KEY` for `web_search`). `pnpm dev` opens the window without it, but sending a message will error.

## Architecture

This is a desktop **code agent**: an Electron app where a LangGraph ReAct agent in the main process reads/writes/searches files and runs shell commands inside a user-selected workspace, streaming its actions to a React chat UI.

### Three processes, three builds

`electron.vite.config.ts` builds three targets independently:

- **main** (`src/main/`) — Node/Electron main process. Owns the window, IPC handlers, and the agent runtime. Built with `externalizeDepsPlugin`, so `@langchain/*` and friends are **not** bundled — they're required from `node_modules` at runtime. Output: `out/main/index.js` (the `main` field in `package.json`). **ESM-only deps caveat:** the output is CJS and externals stay external, so esbuild's interop helpers decide how an import resolves at runtime — and **both** static forms break for a pure-ESM package (e.g. `trash`): a default import `import x from 'pkg'` lowers to a *bare* `require()` with no `__toESM`, and a namespace import `import * as x from 'pkg'` lowers to `_interopNamespaceDefault`, whose `n.default = e` step leaves `.default` as the *whole* `{ __esModule, default }` namespace object rather than the function — either way `x(...)`/`x.default(...)` throws `TypeError: ... is not a function`. (For a UMD/CJS package like `turndown`, `require()` returns the function itself, so `import * as x; x.default(...)` happens to work — don't let that mislead you.) The fix that works for **both**: a **dynamic import** in the consuming function — `const x = (await import('pkg')).default`. Always verify against the **compiled `out/main/index.js`** plus a real `ELECTRON_RUN_AS_NODE=1 pnpm exec electron <probe>.cjs` runtime check (replicate the exact compiled expression and confirm it runs), not just vitest — vitest applies its own interop and masks this bug entirely.
- **preload** (`src/preload/`) — The only bridge between main and renderer. Uses `contextBridge` to expose a minimal `window.api`. `contextIsolation: true`, `nodeIntegration: false` — the renderer never touches Node directly.
- **renderer** (`src/renderer/`) — Vite + React 19 SPA, root at `src/renderer/index.html`. Dev server runs on `localhost:5173`; Electron loads that URL in dev, the built `out/renderer/index.html` when packaged.

### IPC event flow (the core loop — spans 5 files)

The agent does not live in the renderer. Understanding this round-trip is required before touching chat or agent code:

1. Renderer calls `window.api.agent.run(message, workspace)` (`src/renderer/src/stores/chat.ts`).
2. Preload forwards it: `ipcRenderer.invoke('agent:run', …)` (`src/preload/index.ts`).
3. Main handles it: `ipcMain.handle('agent:run')` calls `runAgent()` and pushes progress back with `webContents.send('agent:event', evt)` (`src/main/ipc/index.ts`, `src/main/agent/index.ts`).
4. Preload's `onEvent` subscribes to `agent:event` and forwards each event to the renderer callback.
5. The Zustand store's event reducer maps each `AgentEvent` (`message` / `tool-start` / `tool-end` / `error` / `done`) into `ChatMessage` updates.

The `AgentEvent` and `AgentApi` shapes live in **`src/shared/types.ts`** — this file is the single source of truth included by both the node and web tsconfigs. If you change an event type, update it there and both sides follow. `src/preload/index.d.ts` separately declares the global `Window.api` for the renderer (the runtime `index.ts` is not part of the web project — only its `.d.ts` is).

### Agent runtime (`src/main/agent/`)

- `createReactAgent` from `@langchain/langgraph/prebuilt`, streamed with `streamMode: 'values'` (each superstep yields the full accumulated `messages` array). The dispatch logic looks only at the **last** message of each chunk: `AIMessage` with `tool_calls` → emits `tool-start` per call; `ToolMessage` → emits `tool-end`; `AIMessage` without `tool_calls` → emits the final `message`. Streaming is per-superstep, not per-token. There is also a defensive branch for a final message that some OpenAI-compatible providers mis-role as a generic `ChatMessage`.
- **Tools are factory functions** `makeReadFile(workspace)`, etc. — each closes over the workspace path. To add a tool: create `src/main/agent/tools/<name>.ts` exporting a `makeXxx(workspace)`, then register it in `getTools()` (`tools/index.ts`).
- **Workspace sandboxing**: every filesystem tool resolves paths through `resolveInWorkspace()` in `tools/fileSystem.ts`, which rejects any path whose `relative()` escapes the workspace (`..` or absolute). Keep new fs tools on this helper — never pass user/agent-supplied paths straight to `fs`.
- LLM selection is `createLlm(modelId)` in `llm.ts`. GLM (智谱, OpenAI-compatible) is the default; DeepSeek is the alternative, both via `ChatOpenAI`. The model list shown in the UI comes from `listModels()`. **`streaming` is intentionally `false`**: GLM-5.x is a reasoning model, and with `streaming: true` `@langchain/openai`'s chunk aggregation drops the final answer after a tool call and mis-roles it as a generic `ChatMessage` (`completion_tokens` are billed but `content` arrives empty), which ends the ReAct loop with no text and surfaces as "No response received". Do not re-enable streaming without a provider-specific fix.

## Conventions and gotchas

- **Version pin (do not casually bump)**: `electron-vite@5` requires `vite ^5||^6||^7`, but `@vitejs/plugin-react@6` requires `vite ^8`. The working set is locked to **vite 7 + plugin-react 5 + electron-vite 5**. Bumping any one breaks the build with an `ERR_PACKAGE_PATH_NOT_EXPORTED` or peer-dep failure.
- **TypeScript 7 tsconfig**: there is no `baseUrl` (removed in TS7) and `paths` values must start with `./`. Don't re-add `baseUrl`.
- **Two tsconfig projects, not one**: `tsconfig.node.json` (main + preload + shared + `electron.vite.config.ts`) and `tsconfig.web.json` (renderer + shared + `src/preload/index.d.ts`). They are referenced by `tsconfig.json`. The web project deliberately excludes the preload runtime (`index.ts`) — only its type declaration is visible to the renderer.
- **Electron binary** is not committed and is downloaded by the `electron` package's install script. If `pnpm dev` fails with `Error: Electron uninstall` or `ENOENT …/electron/dist/electron.exe`, the binary is missing — reinstall it (the `@electron/get` fetcher may need a mirror or manual download). The `node_modules/electron/path.txt` must contain `electron.exe` (no `dist/` prefix, no trailing newline) — Electron's `index.js` prepends `dist/` itself and does not trim.
- **`out/` and `release/` are build artifacts** (gitignored). Don't edit them; edit `src/` and rebuild.
- Renderer ↔ main communication must go through `window.api` (preload). Never enable `nodeIntegration` or reach for Node APIs from the renderer.
- **Main-process HTTP ignores the system proxy**: `web_fetch` / `web_search` run in the main process on Node's `fetch` (undici), which by default uses neither the Windows system proxy nor `HTTP_PROXY`/`HTTPS_PROXY`. `src/main/agent/tools/web.ts` builds an undici `ProxyAgent` from `HTTPS_PROXY`/`HTTP_PROXY` (read once at module load, after dotenv) and passes it as a per-request `dispatcher` — it must be undici's **own** `fetch`, because passing a npm-undici `ProxyAgent` to the global `fetch` throws `UND_ERR_INVALID_ARG` (two undici instances). `NODE_USE_ENV_PROXY=1` works on Node ≥24 but is read only at process **startup**, so dotenv can't set it at runtime in an Electron app — that's why the explicit `ProxyAgent` is used. Symptom when the proxy is missing: `UND_ERR_CONNECT_TIMEOUT`, surfaced as `Request failed: fetch failed (UND_ERR_CONNECT_TIMEOUT)` (the `catch` in `web.ts` now exposes `e.cause.code` so the model stops looping on a bare "fetch failed"). Verify any change here against the compiled `out/main/index.js` plus `ELECTRON_RUN_AS_NODE=1 pnpm exec electron <probe>.cjs`, not just vitest.
