---
name: adding-llm-provider
description: Use when adding a new LLM provider (e.g. Qwen, Moonshot, Doubao, Yi) or a new model under an existing provider to this Electron + LangChain agent app. Triggers on phrases like "add a model", "wire up Qwen", "接入新模型", "加一个 LLM provider", or when editing src/main/agent/llm.ts to change the model lineup.
---

# Adding an LLM Provider

## Overview

This app talks to LLMs through `ChatOpenAI` from `@langchain/openai`. Any vendor that exposes an OpenAI-compatible `/chat/completions` endpoint can be wired in by editing **one source file** (`src/main/agent/llm.ts`) plus the `.env` files. The IPC pipeline, preload bridge, renderer store, and UI are all provider-agnostic — they ferry `modelId` as an opaque string, so **do not touch them**.

Core principle: the provider list is a flat table. Each row knows its id, display name, and which env block to read. Adding a provider = adding rows + one env-keyed branch.

## When to Use

Use this skill when:
- Adding a **new provider** (Qwen, Moonshot, Doubao, Yi, OpenAI itself, etc.) — requires a new branch in `createLlm`
- Adding a **new model under an existing provider** (e.g. `glm-4.5-air`) — requires only a new row in `MODELS`

Do **not** use this skill when:
- Changing the agent's tools, prompts, or streaming behavior — those live in `src/main/agent/index.ts`, `prompts.ts`, `tools/`
- Modifying the chat UI, model selector widget, or IPC contract — those are intentionally provider-agnostic

## The Two File Changes

### 1. `src/main/agent/llm.ts`

This file has four sections that must stay in sync. Shown below as if we were adding **Qwen** as a new provider; a new-model-only change skips steps (a) and (d).

```ts
import { ChatOpenAI, type ClientOptions } from '@langchain/openai'

const TEMPERATURE = 0

export interface ModelOption {
  id: string
  name: string
  provider: 'glm' | 'deepseek' | 'qwen' // (a) extend the union for new providers
}

const GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1' // (b) new constant

const MODELS: readonly ModelOption[] = [
  { id: 'glm-5.2', name: 'GLM-5.2', provider: 'glm' },
  { id: 'glm-5.1', name: 'GLM-5.1', provider: 'glm' },
  { id: 'glm-4.5', name: 'GLM-4.5', provider: 'glm' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', provider: 'deepseek' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', provider: 'deepseek' },
  // (c) new row — for new model under existing provider, only this line is needed
  { id: 'qwen-max', name: 'Qwen-Max', provider: 'qwen' }
]

export const DEFAULT_MODEL_ID = 'glm-5.2'

export function listModels(): ModelOption[] {
  return MODELS.map((m) => ({ ...m }))
}

export function createLlm(modelId?: string): ChatOpenAI {
  const id =
    modelId && MODELS.some((m) => m.id === modelId) ? modelId : DEFAULT_MODEL_ID
  const cfg = MODELS.find((m) => m.id === id)

  if (!cfg) {
    throw new Error(`Unknown model: ${id}`)
  }

  let configuration: ClientOptions
  if (cfg.provider === 'glm') {
    configuration = {
      apiKey: process.env['GLM_API_KEY'] ?? '',
      baseURL: process.env['GLM_BASE_URL'] ?? GLM_BASE_URL
    }
  } else if (cfg.provider === 'deepseek') {
    configuration = {
      apiKey: process.env['DEEPSEEK_API_KEY'] ?? '',
      baseURL: process.env['DEEPSEEK_BASE_URL'] ?? DEEPSEEK_BASE_URL
    }
  } else if (cfg.provider === 'qwen') {
    // (d) new branch — reads QWEN_API_KEY / QWEN_BASE_URL from .env
    configuration = {
      apiKey: process.env['QWEN_API_KEY'] ?? '',
      baseURL: process.env['QWEN_BASE_URL'] ?? QWEN_BASE_URL
    }
  } else {
    throw new Error(`Provider not configured: ${cfg.provider}`)
  }

  return new ChatOpenAI({
    model: cfg.id,
    temperature: TEMPERATURE,
    configuration
  })
}
```

**Four touch-points, in order:**
1. Union type `provider` — add the new string literal
2. `<NAME>_BASE_URL` constant — the vendor's OpenAI-compatible base URL
3. `MODELS` array — one row per model id you want selectable
4. `createLlm()` — a new `else if` branch mapping the provider to its env keys

### 2. `.env.example` and `.env`

Append a new block to `.env.example` (template, `x`s):

```
# --- Qwen (阿里通义) — required for qwen-* models ---
# Get your key at https://dashscope.console.aliyun.com/
QWEN_API_KEY=sk-xxxxxxxx
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

Append the real values to `.env` (gitignored, never committed):

```
QWEN_API_KEY=sk-<real-key>
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

The env variable names must match the keys read by the new branch in `createLlm` — by convention `<PROVIDER>_API_KEY` and `<PROVIDER>_BASE_URL`, upper-snake-case.

## Files NOT to Touch

The IPC pipeline was designed so adding a provider requires no changes downstream:

| File | Why it's untouched |
|------|-------------------|
| `src/main/agent/index.ts` | `runAgent` calls `createLlm(modelId)` — it doesn't care which provider |
| `src/main/ipc/index.ts` | `agent:run` forwards `modelId` as opaque string; `agent:listModels` already calls `listModels()` |
| `src/shared/types.ts` | `ModelOption.provider` is typed `string`, not a union — new providers fit automatically |
| `src/preload/index.ts` | Forwards `modelId` verbatim |
| `src/renderer/src/stores/chat.ts` | Hydrates `models` from `listModels()` IPC; auto-picks up new entries |
| `src/renderer/src/components/MessageInput.tsx` | Renders `models` dynamically into `<select>` |
| `src/renderer/src/App.tsx` | Calls `listModels()` once on mount |

If you find yourself editing any of these to add a provider, **stop** — something has drifted from the architecture described in [CLAUDE.md](../../../CLAUDE.md).

## Verification

From the repo root:

```bash
pnpm typecheck   # must pass — catches union/typos in llm.ts
pnpm dev         # launches Electron
```

In the running app:
1. Click the model dropdown — the new model must appear
2. Send "你好" — expect a streamed reply
3. Send "列出当前目录下的文件" — confirms the new model's tool-calling works with LangGraph's ReAct loop (Chinese models occasionally degenerate on function-calling — flag this if it happens)

## Provider-Specific Gotchas

- **Base URL shape differs by vendor.** GLM uses `/api/paas/v4`, DeepSeek uses bare `https://api.deepseek.com` (no `/v1`), Qwen uses `/compatible-mode/v1`. Always copy the documented base URL verbatim — don't append `/v1` speculatively.
- **Model IDs are case-sensitive** and must match what the vendor's API expects (e.g. `glm-5.2`, not `GLM-5.2`). The display `name` can be prettified for the dropdown.
- **API key in `.env` only.** Never hardcode keys into `llm.ts` — the file is committed; `.env` is gitignored.
- **Some Chinese providers mis-identify themselves** when asked "你是谁" (claim to be Claude/GPT). This is training-data pollution, not a bug in the wiring — fixable via `src/main/agent/prompts.ts` if it bothers you, out of scope for adding the provider.

## Common Mistakes

- Forgetting `.env.example` while updating `.env` — both files must change (`.env.example` is the template teammates copy from)
- Adding the new provider to a union in `src/shared/types.ts` — `provider: string` there is intentional, don't narrow it
- Editing the IPC / preload / renderer files to plumb a new provider through — they're provider-agnostic by design (see table above)
