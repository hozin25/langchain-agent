import { ChatOpenAI } from '@langchain/openai'
import { ChatAnthropic } from '@langchain/anthropic'

const TEMPERATURE = 0

// `/api/anthropic` 是 GLM 的 Anthropic 协议兼容端点,必须用 ChatAnthropic,
// 不能用 ChatOpenAI —— 用错协议会导致 400/empty response。订阅套餐升级后
// 原生 /paas/v4 端点会 429 余额不足,所以用户会把 GLM_BASE_URL 改到这里。
const GLM_ANTHROPIC_PATH = '/anthropic'

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

// `/api/anthropic` endpoint requires Anthropic's protocol (max_tokens mandatory,
// different streaming chunk shape). Sniff the baseURL once at config time and
// route to ChatAnthropic when the path is present — keeps the call sites unaware
// of which SDK backs the model, and falls back to ChatOpenAI for the default
// /paas/v4 endpoint and DeepSeek.
function isGlmAnthropicBase(base: string): boolean {
  try {
    const u = new URL(base)
    return u.pathname.toLowerCase().includes(GLM_ANTHROPIC_PATH)
  } catch {
    return false
  }
}

export function createLlm(modelId?: string): ChatOpenAI | ChatAnthropic {
  const id = modelId && MODELS.some(m => m.id === modelId) ? modelId : DEFAULT_MODEL_ID
  const cfg = MODELS.find(m => m.id === id)

  if (!cfg) {
    throw new Error(`Unknown model: ${id}`)
  }

  if (cfg.provider === 'deepseek') {
    return new ChatOpenAI({
      model: cfg.id,
      temperature: TEMPERATURE,
      streaming: true,
      maxRetries: LLM_MAX_RETRIES,
      timeout: LLM_TIMEOUT_MS,
      configuration: {
        apiKey: process.env['DEEPSEEK_API_KEY'] ?? '',
        baseURL: process.env['DEEPSEEK_BASE_URL'] ?? DEEPSEEK_BASE_URL
      }
    })
  }

  // provider === 'glm'
  const glmBase = process.env['GLM_BASE_URL'] ?? GLM_BASE_URL
  const apiKey = process.env['GLM_API_KEY'] ?? ''
  if (isGlmAnthropicBase(glmBase)) {
    // ChatAnthropic: maxTokens is required by Anthropic API. GLM's anthropic
    // endpoint caps at a low output budget; pick a safe per-turn ceiling well
    // below the context window. streaming:true is required for token-level
    // streaming under LangGraph's streamMode:'messages', same as ChatOpenAI.
    return new ChatAnthropic({
      model: cfg.id,
      apiKey,
      anthropicApiUrl: glmBase,
      streaming: true,
      maxRetries: LLM_MAX_RETRIES,
      temperature: TEMPERATURE,
      maxTokens: GLM_ANTHROPIC_MAX_TOKENS,
      clientOptions: { timeout: LLM_TIMEOUT_MS }
    })
  }

  return new ChatOpenAI({
    model: cfg.id,
    temperature: TEMPERATURE,
    streaming: true,
    maxRetries: LLM_MAX_RETRIES,
    timeout: LLM_TIMEOUT_MS,
    configuration: { apiKey, baseURL: glmBase }
  })
}

export const LLM_MAX_RETRIES = 3
export const LLM_TIMEOUT_MS = 60_000

// Anthropic 协议要求 max_tokens 必填,且 GLM anthropic 端点对单次输出有上限。
// 取一个远小于上下文窗口的安全值,避免 400 invalid max_tokens。
const GLM_ANTHROPIC_MAX_TOKENS = 8192

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
