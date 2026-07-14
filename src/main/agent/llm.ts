import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'

const TEMPERATURE = 0

export function getLlm(): ChatAnthropic | ChatOpenAI {
  const provider = (process.env['DEFAULT_PROVIDER'] ?? 'anthropic').toLowerCase()
  const model = process.env['DEFAULT_MODEL'] ?? 'claude-sonnet-4-6'

  if (provider === 'openai') {
    return new ChatOpenAI({
      model: model || 'gpt-4o',
      apiKey: process.env['OPENAI_API_KEY'],
      temperature: TEMPERATURE
    })
  }

  return new ChatAnthropic({
    model: model || 'claude-sonnet-4-6',
    apiKey: process.env['ANTHROPIC_API_KEY'],
    temperature: TEMPERATURE
  })
}
