# LangChain Code Agent (Desktop)

A desktop code agent built from scratch with **Electron + React + TypeScript + LangChain.js**.

It lives next to your codebase: pick a workspace folder, chat in natural language, and the agent reads / writes / searches files and runs shell commands through sandboxed tools.

## Status

Early scaffold (`0.1.0`) — project layout, IPC bridge, agent loop, and a basic chat UI are wired up. Tool surface and safety guarantees are intentionally minimal; treat this as a starting point, not production-ready.

## Tech stack

| Layer | Choice                                        |
| ----- | --------------------------------------------- |
| Shell | Electron                                      |
| Build | electron-vite + Vite                          |
| UI    | React + TypeScript                            |
| State | Zustand                                       |
| Agent | LangChain.js + LangGraph (`createReactAgent`) |
| LLM   | Anthropic Claude (default) / OpenAI           |

## Prerequisites

- Node.js 20+
- pnpm 9+ (`npm i -g pnpm`)
- An API key (Anthropic or OpenAI)

## Getting started

```bash
pnpm install
cp .env.example .env      # fill in your API key
pnpm dev                  # launches the Electron window
```

Pick a workspace folder via the sidebar, type a request, and the agent will call tools to act on it.

## Scripts

| Script           | What it does                    |
| ---------------- | ------------------------------- |
| `pnpm dev`       | Run the app in dev (HMR)        |
| `pnpm build`     | Build main / preload / renderer |
| `pnpm typecheck` | Type-check Node + Web projects  |
| `pnpm test`      | Run Vitest unit tests           |
| `pnpm package`   | Build a distributable installer |

## Project layout

```
src/
  main/          Electron main process — window, IPC, agent runtime
    agent/       LangGraph agent + tools (fs / search / shell)
    ipc/         IPC handlers bridging renderer <-> agent
  preload/       contextBridge API exposed to the renderer
  renderer/      React UI (chat panel, sidebar, store)
  shared/        Types shared across process boundaries
```

## How it works

1. Renderer (React) calls `window.api.agent.run(message, workspace)`.
2. Preload forwards it to the main process over IPC.
3. Main process runs a LangGraph `createReactAgent` with file/shell tools scoped to the workspace.
4. Tool calls and assistant tokens are streamed back to the renderer via `agent:event`.

## Security notes

- Tools resolve paths against the selected workspace and reject paths that escape it.
- `nodeIntegration` is off; the renderer only sees the `window.api` surface from the preload.
- Shell execution is allowed in the workspace dir with a 30s timeout — review commands before running untrusted requests.
- API keys live in `.env` (gitignored). A settings UI for runtime configuration is a TODO.
