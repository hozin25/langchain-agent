import { create } from 'zustand'
import type {
  AgentEvent,
  ChatMessage,
  Conversation,
  ConversationMeta,
  FileAttachment,
  ModelOption,
  TodoItem
} from '@shared/types'
import { reduceChatEvent } from './chatReducer'

const TITLE_MAX = 40

interface ChatState {
  messages: ChatMessage[]
  workspace: string | null
  isRunning: boolean
  models: ModelOption[]
  modelId: string
  todos: TodoItem[]
  conversations: ConversationMeta[]
  currentConversationId: string | null
  contextUsed: number
  contextMax: number
  pendingConfirm:
    | { id: string; tool: string; input: unknown; agentId?: string; agentName?: string }
    | null
  setWorkspace: (path: string | null) => Promise<void>
  setModels: (models: ModelOption[], defaultId: string) => void
  setModelId: (id: string) => void
  send: (text: string, attachments?: FileAttachment[]) => Promise<void>
  interrupt: () => void
  respondConfirmation: (approved: boolean, remember: boolean) => void
  loadConversationList: () => Promise<void>
  openConversation: (id: string) => Promise<void>
  startNewConversation: () => void
  deleteConversation: (id: string) => Promise<void>
}

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2)
}

function deriveTitle(text: string): string {
  const firstLine = (text.trim().split('\n')[0] ?? '').trim()
  if (!firstLine) return 'New conversation'
  return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX)}…` : firstLine
}

function upsertMeta(list: ConversationMeta[], meta: ConversationMeta): ConversationMeta[] {
  const idx = list.findIndex(c => c.id === meta.id)
  const next = idx >= 0 ? [...list.slice(0, idx), meta, ...list.slice(idx + 1)] : [meta, ...list]
  return next.sort((a, b) => b.updatedAt - a.updatedAt)
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  workspace: null,
  isRunning: false,
  models: [],
  modelId: '',
  todos: [],
  conversations: [],
  currentConversationId: null,
  contextUsed: 0,
  contextMax: 0,
  pendingConfirm: null,

  setWorkspace: async path => {
    // ignore workspace switches while a run is in flight — clearing messages mid-run
    // would mix the in-flight stream into the new workspace's view
    if (get().isRunning) return
    set({
      workspace: path,
      messages: [],
      todos: [],
      currentConversationId: null,
      conversations: [],
      contextUsed: 0
    })
    if (!path) return
    // remember last workspace so the app reopens into it, then load its history
    await window.api.app.setLastWorkspace(path)
    const list = await window.api.conversations.list(path)
    set({ conversations: list })
  },

  setModels: (models, defaultId) =>
    set(s => {
      const modelId = s.modelId || defaultId
      const model = models.find(m => m.id === modelId)
      return {
        models,
        modelId,
        contextMax: model?.maxContextTokens ?? 0
      }
    }),

  setModelId: id => {
    const model = get().models.find(m => m.id === id)
    set({ modelId: id, contextMax: model?.maxContextTokens ?? 0, contextUsed: 0 })
  },

  loadConversationList: async () => {
    const ws = get().workspace
    if (!ws) {
      set({ conversations: [] })
      return
    }
    const list = await window.api.conversations.list(ws)
    set({ conversations: list })
  },

  openConversation: async id => {
    if (get().isRunning) return
    const conv = await window.api.conversations.load(id)
    if (!conv) return
    set({ messages: conv.messages, todos: conv.todos, currentConversationId: id, contextUsed: 0 })
  },

  startNewConversation: () => {
    if (get().isRunning) return
    set({ messages: [], todos: [], currentConversationId: null, contextUsed: 0 })
  },

  deleteConversation: async id => {
    await window.api.conversations.delete(id)
    set(s => {
      const conversations = s.conversations.filter(c => c.id !== id)
      if (s.currentConversationId !== id) return { conversations }
      return { conversations, messages: [], todos: [], currentConversationId: null, contextUsed: 0 }
    })
  },

  send: async (text, attachments) => {
    const state = get()
    const workspace = state.workspace
    if (!workspace || !text.trim() || state.isRunning) return

    const modelId = state.modelId || undefined
    const now = Date.now()
    const convId = state.currentConversationId ?? uid()
    const isNew = state.currentConversationId === null
    const existing = isNew ? null : (state.conversations.find(c => c.id === convId) ?? null)

    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text,
      attachments: attachments?.map(a => ({ name: a.name })),
      createdAt: now
    }
    const assistantMsg: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: '',
      status: 'running',
      createdAt: now
    }
    set(s => ({
      messages: [...s.messages, userMsg, assistantMsg],
      isRunning: true,
      todos: [],
      currentConversationId: convId
    }))

    const off = window.api.agent.onEvent((event: AgentEvent) => {
      set(s =>
        reduceChatEvent(
          {
            messages: s.messages,
            todos: s.todos,
            contextUsed: s.contextUsed,
            contextMax: s.contextMax,
            pendingConfirm: s.pendingConfirm
          },
          event
        )
      )
    })

    try {
      await window.api.agent.run(text, workspace, modelId, attachments, state.messages)
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
              status: 'error' as const,
              createdAt: Date.now()
            }
          ]
        }
      })
    } finally {
      // Let pending IPC events (done/error/interrupted) flush before
      // unsubscribing — webContents.send and ipcRenderer.invoke resolve
      // on different channels and can race.
      await new Promise(resolve => setTimeout(resolve, 0))
      off()
      set({ isRunning: false })
      // Persist once the run reaches a terminal state (done/error/interrupted all
      // land here after updating messages). Streaming deltas are not written to
      // disk — one IO per turn, not per token.
      const finalState = get()
      const conv: Conversation = {
        id: convId,
        title: existing?.title ?? deriveTitle(text),
        workspace,
        createdAt: existing?.createdAt ?? now,
        updatedAt: Date.now(),
        messages: finalState.messages,
        todos: finalState.todos
      }
      try {
        await window.api.conversations.save(conv)
        const meta: ConversationMeta = {
          id: conv.id,
          title: conv.title,
          workspace: conv.workspace,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt
        }
        set(s => ({ conversations: upsertMeta(s.conversations, meta) }))
      } catch {
        // persistence failure must not break the in-memory session
      }
    }
  },

  interrupt: () => {
    if (!get().isRunning) return
    void window.api.agent.cancel()
  },

  respondConfirmation: (approved, remember) => {
    const pending = get().pendingConfirm
    if (!pending) return
    void window.api.agent.respondConfirmation(pending.id, approved, remember)
    set({ pendingConfirm: null })
  }
}))
