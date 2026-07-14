import { ChatOpenAI, type ClientOptions } from '@langchain/openai'

const TEMPERATURE = 0

export interface ModelOption {
  id: string
  name: string
  provider: 'glm'
}

const GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'

const MODELS: readonly ModelOption[] = [
  { id: 'glm-5.2', name: 'GLM-5.2', provider: 'glm' },
  { id: 'glm-5.1', name: 'GLM-5.1', provider: 'glm' },
  { id: 'glm-4.5', name: 'GLM-4.5', provider: 'glm' }
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

  if (cfg.provider === 'glm') {
    const apiKey = process.env['GLM_API_KEY'] ?? ''
    const baseURL = process.env['GLM_BASE_URL'] ?? GLM_BASE_URL
    const configuration: ClientOptions = { apiKey, baseURL }
    return new ChatOpenAI({
      model: cfg.id,
      temperature: TEMPERATURE,
      configuration
    })
  }

  throw new Error(`Provider not configured: ${cfg.provider}`)
}
