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

Required env for the agent to actually call an LLM: copy `.env.example` → `.env` and set `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`). `pnpm dev` opens the window without it, but sending a message will error.

## Architecture

This is a desktop **code agent**: an Electron app where a LangGraph ReAct agent in the main process reads/writes/searches files and runs shell commands inside a user-selected workspace, streaming its actions to a React chat UI.

### Three processes, three builds

`electron.vite.config.ts` builds three targets independently:

- **main** (`src/main/`) — Node/Electron main process. Owns the window, IPC handlers, and the agent runtime. Built with `externalizeDepsPlugin`, so `@langchain/*` and friends are **not** bundled — they're required from `node_modules` at runtime. Output: `out/main/index.js` (the `main` field in `package.json`). **ESM-only deps caveat:** because the output is CJS and externals stay external, esbuild lowers a `import x from 'pkg'` to a *bare* `require()` with **no `__toESM` interop**. For a pure-ESM package (e.g. `trash`, `turndown`) the required value is the namespace `{ default }`, so a default import called directly throws `TypeError: x is not a function` at runtime. Use a **namespace import** instead: `import * as x from 'pkg'` then `x.default(...)`. Verify against the **compiled `out/main/index.js`** (and a real `ELECTRON_RUN_AS_NODE` require), not just vitest — vitest applies its own interop and will mask the bug.
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

- `createReactAgent` from `@langchain/langgraph/prebuilt`, streamed with `streamMode: 'values'` (each superstep yields the full accumulated `messages` array). The dispatch logic looks only at the **last** message of each chunk: `AIMessage` with `tool_calls` → emits `tool-start` per call; `ToolMessage` → emits `tool-end`; `AIMessage` without `tool_calls` → emits the final `message`. Streaming is per-superstep, not per-token.
- **Tools are factory functions** `makeReadFile(workspace)`, etc. — each closes over the workspace path. To add a tool: create `src/main/agent/tools/<name>.ts` exporting a `makeXxx(workspace)`, then register it in `getTools()` (`tools/index.ts`).
- **Workspace sandboxing**: every filesystem tool resolves paths through `resolveInWorkspace()` in `tools/fileSystem.ts`, which rejects any path whose `relative()` escapes the workspace (`..` or absolute). Keep new fs tools on this helper — never pass user/agent-supplied paths straight to `fs`.
- LLM selection is `getLlm()` in `llm.ts`, driven by `.env` (`DEFAULT_PROVIDER` / `DEFAULT_MODEL`). Anthropic is the default; OpenAI is the alternative. There is no UI for this yet.

## Conventions and gotchas

- **Version pin (do not casually bump)**: `electron-vite@5` requires `vite ^5||^6||^7`, but `@vitejs/plugin-react@6` requires `vite ^8`. The working set is locked to **vite 7 + plugin-react 5 + electron-vite 5**. Bumping any one breaks the build with an `ERR_PACKAGE_PATH_NOT_EXPORTED` or peer-dep failure.
- **TypeScript 7 tsconfig**: there is no `baseUrl` (removed in TS7) and `paths` values must start with `./`. Don't re-add `baseUrl`.
- **Two tsconfig projects, not one**: `tsconfig.node.json` (main + preload + shared + `electron.vite.config.ts`) and `tsconfig.web.json` (renderer + shared + `src/preload/index.d.ts`). They are referenced by `tsconfig.json`. The web project deliberately excludes the preload runtime (`index.ts`) — only its type declaration is visible to the renderer.
- **Electron binary** is not committed and is downloaded by the `electron` package's install script. If `pnpm dev` fails with `Error: Electron uninstall` or `ENOENT …/electron/dist/electron.exe`, the binary is missing — reinstall it (the `@electron/get` fetcher may need a mirror or manual download). The `node_modules/electron/path.txt` must contain `electron.exe` (no `dist/` prefix, no trailing newline) — Electron's `index.js` prepends `dist/` itself and does not trim.
- **`out/` and `release/` are build artifacts** (gitignored). Don't edit them; edit `src/` and rebuild.
- Renderer ↔ main communication must go through `window.api` (preload). Never enable `nodeIntegration` or reach for Node APIs from the renderer.
