import { ChatOpenAI, type ClientOptions } from '@langchain/openai'

const TEMPERATURE = 0

export interface ModelOption {
  id: string
  name: string
  provider: 'glm' | 'deepseek'
  maxContextTokens: number
}

const GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

const MODELS: readonly ModelOption[] = [
  { id: 'glm-5.2', name: 'GLM-5.2', provider: 'glm', maxContextTokens: 1_048_576 },
  { id: 'glm-5.1', name: 'GLM-5.1', provider: 'glm', maxContextTokens: 204_800 },
  { id: 'glm-4.5', name: 'GLM-4.5', provider: 'glm', maxContextTokens: 131_072 },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    provider: 'deepseek',
    maxContextTokens: 1_048_576
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    provider: 'deepseek',
    maxContextTokens: 1_048_576
  }
]

export const DEFAULT_MODEL_ID = 'glm-5.2'

export function listModels(): ModelOption[] {
  return MODELS.map(m => ({ ...m }))
}

export function createLlm(modelId?: string): ChatOpenAI {
  const id = modelId && MODELS.some(m => m.id === modelId) ? modelId : DEFAULT_MODEL_ID
  const cfg = MODELS.find(m => m.id === id)

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
  } else {
    throw new Error(`Provider not configured: ${cfg.provider}`)
  }

  // `streaming: true` is required for token-level streaming under LangGraph's
  // `streamMode: 'messages'`. Without it, ChatOpenAI.invoke returns the full
  // AIMessage in one shot and LangGraph emits a single chunk — no token stream.
  // The historical post-tool-call answer-drop bug was fixed in
  // @langchain/openai 1.5.5 (this repo is on ^1.5.5); see scripts/probe-glm-stream.cjs.
  //
  // `maxRetries` looks like the openai SDK's own retry, but @langchain/openai
  // forces the SDK's maxRetries to 0 and routes everything through LangChain
  // core's AsyncCaller (p-retry). That layer already retries 408/409/429/5xx and
  // network errors with exponential backoff + jitter, and stops on
  // insufficient_quota. 3 keeps waits bounded on a desktop app (default is 6).
  // `timeout` bounds a hung connection so the caller sees feedback instead of
  // hanging until the SDK's retries exhaust.
  return new ChatOpenAI({
    model: cfg.id,
    temperature: TEMPERATURE,
    streaming: true,
    maxRetries: LLM_MAX_RETRIES,
    timeout: LLM_TIMEOUT_MS,
    configuration
  })
}

export const LLM_MAX_RETRIES = 3
export const LLM_TIMEOUT_MS = 60_000

// Returns the configured API key for a model id (resolves DEFAULT_MODEL_ID when
// modelId is omitted). Empty/placeholder values from .env.example are treated as
// configured (same as createLlm) — a 401 from the provider is the source of
// truth there. Returns undefined when no env var maps to the provider.
export function getApiKeyForModel(modelId?: string): string | undefined {
  const id = modelId && MODELS.some(m => m.id === modelId) ? modelId : DEFAULT_MODEL_ID
  const cfg = MODELS.find(m => m.id === id)
  if (!cfg) return undefined
  const envVar =
    cfg.provider === 'glm' ? 'GLM_API_KEY' : cfg.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : null
  if (!envVar) return undefined
  const val = process.env[envVar]
  return val && val.length > 0 ? val : undefined
}
