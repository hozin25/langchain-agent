import type { AgentApi } from '../shared/types'

declare global {
  interface Window {
    api: AgentApi
  }
}

export {}
