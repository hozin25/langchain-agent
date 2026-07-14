import { create } from 'zustand'
import type { AgentEvent } from '@shared/types'

export type MessageStatus = 'running' | 'done' | 'error'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  status?: MessageStatus
}

interface ChatState {
  messages: ChatMessage[]
  workspace: string | null
  isRunning: boolean
  setWorkspace: (path: string | null) => void
  send: (text: string) => Promise<void>
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

  setWorkspace: (path) => set({ workspace: path }),

  clear: () => set({ messages: [] }),

  send: async (text) => {
    const state = get()
    const workspace = state.workspace
    if (!workspace || !text.trim() || state.isRunning) return

    const userMsg: ChatMessage = { id: uid(), role: 'user', content: text }
    set((s) => ({ messages: [...s.messages, userMsg], isRunning: true }))

    const off = window.api.agent.onEvent((event: AgentEvent) => {
      switch (event.type) {
        case 'message':
          set((s) => {
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
        case 'tool-start':
          set((s) => ({
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
          set((s) => {
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
          set((s) => ({
            messages: [
              ...s.messages,
              {
                id: uid(),
                role: 'assistant',
                content: `⚠️ ${event.message}`,
                status: 'error' as const
              }
            ]
          }))
          break
        case 'done':
          set((s) => ({
            messages: s.messages.map((m) =>
              m.status === 'running' ? { ...m, status: 'done' as const } : m
            )
          }))
          break
      }
    })

    try {
      await window.api.agent.run(text, workspace)
    } catch (e) {
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: uid(),
            role: 'assistant',
            content: `❌ ${e instanceof Error ? e.message : String(e)}`,
            status: 'error' as const
          }
        ]
      }))
    } finally {
      off()
      set({ isRunning: false })
    }
  }
}))
