import { ChatOpenAI, type ClientOptions } from '@langchain/openai'

const TEMPERATURE = 0

export interface ModelOption {
  id: string
  name: string
  provider: 'glm' | 'deepseek'
}

const GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

const MODELS: readonly ModelOption[] = [
  { id: 'glm-5.2', name: 'GLM-5.2', provider: 'glm' },
  { id: 'glm-5.1', name: 'GLM-5.1', provider: 'glm' },
  { id: 'glm-4.5', name: 'GLM-4.5', provider: 'glm' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', provider: 'deepseek' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', provider: 'deepseek' }
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

  return new ChatOpenAI({
    model: cfg.id,
    temperature: TEMPERATURE,
    streaming: true,
    configuration
  })
}
