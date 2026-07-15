import { create } from 'zustand'
import type { AgentEvent, FileAttachment, ModelOption } from '@shared/types'

export type MessageStatus = 'running' | 'done' | 'error'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  status?: MessageStatus
  attachments?: { name: string }[]
}

interface ChatState {
  messages: ChatMessage[]
  workspace: string | null
  isRunning: boolean
  models: ModelOption[]
  modelId: string
  setWorkspace: (path: string | null) => void
  setModels: (models: ModelOption[], defaultId: string) => void
  setModelId: (id: string) => void
  send: (text: string, attachments?: FileAttachment[]) => Promise<void>
  clear: () => void
}

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2)
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  workspace: null,
  isRunning: false,
  models: [],
  modelId: '',

  setWorkspace: path => set({ workspace: path }),

  setModels: (models, defaultId) =>
    set(s => ({
      models,
      modelId: s.modelId || defaultId
    })),

  setModelId: id => set({ modelId: id }),

  clear: () => set({ messages: [] }),

  send: async (text, attachments) => {
    const state = get()
    const workspace = state.workspace
    if (!workspace || !text.trim() || state.isRunning) return

    const modelId = state.modelId || undefined
    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text,
      attachments: attachments?.map(a => ({ name: a.name }))
    }
    const assistantMsg: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: '',
      status: 'running'
    }
    set(s => ({ messages: [...s.messages, userMsg, assistantMsg], isRunning: true }))

    const off = window.api.agent.onEvent((event: AgentEvent) => {
      switch (event.type) {
        case 'message':
          set(s => {
            const last = s.messages[s.messages.length - 1]
            if (last && last.role === 'assistant' && last.status === 'running') {
              const copy = s.messages.slice()
              copy[copy.length - 1] = { ...last, content: last.content + event.content }
              return { messages: copy }
            }
            return {
              messages: [
                ...s.messages,
                {
                  id: uid(),
                  role: 'assistant',
                  content: event.content,
                  status: 'running' as const
                }
              ]
            }
          })
          break
        case 'message-delta':
          set(s => {
            const last = s.messages[s.messages.length - 1]
            if (last && last.role === 'assistant' && last.status === 'running') {
              const copy = s.messages.slice()
              copy[copy.length - 1] = { ...last, content: last.content + event.delta }
              return { messages: copy }
            }
            return {
              messages: [
                ...s.messages,
                {
                  id: uid(),
                  role: 'assistant',
                  content: event.delta,
                  status: 'running' as const
                }
              ]
            }
          })
          break
        case 'tool-start':
          set(s => ({
            messages: [
              ...s.messages,
              {
                id: uid(),
                role: 'tool',
                toolName: event.tool,
                content: JSON.stringify(event.input, null, 2),
                status: 'running' as const
              }
            ]
          }))
          break
        case 'tool-end':
          set(s => {
            const copy = s.messages.slice()
            for (let i = copy.length - 1; i >= 0; i--) {
              const m = copy[i]
              if (m && m.role === 'tool' && m.status === 'running') {
                copy[i] = { ...m, content: event.output, status: 'done' as const }
                break
              }
            }
            return { messages: copy }
          })
          break
        case 'error':
          set(s => {
            const last = s.messages[s.messages.length - 1]
            if (last && last.role === 'assistant' && last.status === 'running') {
              const copy = s.messages.slice()
              copy[copy.length - 1] = {
                ...last,
                content: `⚠️ ${event.message}`,
                status: 'error' as const
              }
              return { messages: copy }
            }
            return {
              messages: [
                ...s.messages,
                {
                  id: uid(),
                  role: 'assistant',
                  content: `⚠️ ${event.message}`,
                  status: 'error' as const
                }
              ]
            }
          })
          break
        case 'done':
          set(s => ({
            messages: s.messages.map(m => {
              if (m.status !== 'running') return m
              if (m.role === 'assistant' && m.content.length === 0) {
                return {
                  ...m,
                  content:
                    '⚠️ No response received. Check the terminal running `pnpm dev` for `[agent]` logs.',
                  status: 'error' as const
                }
              }
              return { ...m, status: 'done' as const }
            })
          }))
          break
      }
    })

    try {
      await window.api.agent.run(text, workspace, modelId, attachments)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set(s => {
        const last = s.messages[s.messages.length - 1]
        if (last && last.role === 'assistant' && last.status === 'running') {
          const copy = s.messages.slice()
          copy[copy.length - 1] = {
            ...last,
            content: `❌ ${msg}`,
            status: 'error' as const
          }
          return { messages: copy }
        }
        return {
          messages: [
            ...s.messages,
            {
              id: uid(),
              role: 'assistant',
              content: `❌ ${msg}`,
              status: 'error' as const
            }
          ]
        }
      })
    } finally {
      off()
      set({ isRunning: false })
    }
  }
}))
