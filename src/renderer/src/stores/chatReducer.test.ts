import { describe, it, expect } from 'vitest'
import { reduceChatEvent, type ChatReducerState } from './chatReducer'
import type { AgentEvent, ChatMessage, SnapshotEntry } from '@shared/types'

function baseState(overrides: Partial<ChatReducerState> = {}): ChatReducerState {
  return {
    messages: [],
    todos: [],
    contextUsed: 0,
    contextMax: 0,
    pendingConfirm: null,
    compactState: null,
    compactError: null,
    compactNeeded: false,
    snapshots: [],
    isRestoring: false,
    restoreProgress: 0,
    restoreError: null,
    ...overrides
  }
}

function entry(overrides: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    id: 'snap_1',
    sha: 'abc123',
    workspace: '/ws',
    conversationId: 'c1',
    createdAt: 1,
    ...overrides
  }
}

function runningTool(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 't1',
    role: 'tool',
    toolName: 'write_file',
    toolCallId: 'call-1',
    content: '',
    status: 'running',
    createdAt: 1,
    ...overrides
  }
}

describe('reduceChatEvent — snapshot-taken', () => {
  it('appends the entry to the timeline', () => {
    const next = reduceChatEvent(baseState(), { type: 'snapshot-taken', entry: entry({ id: 'snap_x' }) })
    expect(next.snapshots).toHaveLength(1)
    expect(next.snapshots[0]!.id).toBe('snap_x')
  })

  it('stamps snapshotId on the matching running tool message', () => {
    const state = baseState({ messages: [runningTool({ toolName: 'write_file', agentId: undefined })] })
    const next = reduceChatEvent(state, {
      type: 'snapshot-taken',
      entry: entry({ id: 'snap_x', toolName: 'write_file', agentId: undefined })
    })
    expect(next.messages[0]!.snapshotId).toBe('snap_x')
  })

  it('does not stamp when the toolName does not match (still appends the entry)', () => {
    const state = baseState({ messages: [runningTool({ toolName: 'edit_file' })] })
    const next = reduceChatEvent(state, {
      type: 'snapshot-taken',
      entry: entry({ id: 'snap_x', toolName: 'write_file' })
    })
    expect(next.messages[0]!.snapshotId).toBeUndefined()
    expect(next.snapshots).toHaveLength(1)
  })

  it('leaves messages untouched for a turn-start snapshot (no toolName)', () => {
    const state = baseState({ messages: [runningTool()] })
    const next = reduceChatEvent(state, {
      type: 'snapshot-taken',
      entry: entry({ id: 'turn_start', toolName: undefined, turnLabel: 'turn-start' })
    })
    expect(next.messages[0]!.snapshotId).toBeUndefined()
    expect(next.snapshots).toHaveLength(1)
  })
})

describe('reduceChatEvent — restore lifecycle', () => {
  it('restore-start marks isRestoring and resets progress + error', () => {
    const next = reduceChatEvent(baseState({ isRestoring: false, restoreProgress: 50, restoreError: 'old' }), {
      type: 'restore-start'
    } satisfies AgentEvent)
    expect(next.isRestoring).toBe(true)
    expect(next.restoreProgress).toBe(0)
    expect(next.restoreError).toBeNull()
  })

  it('restore-progress updates the percent while restoring', () => {
    const next = reduceChatEvent(baseState({ isRestoring: true }), {
      type: 'restore-progress',
      percent: 42
    } satisfies AgentEvent)
    expect(next.isRestoring).toBe(true)
    expect(next.restoreProgress).toBe(42)
  })

  it('restore-end clears isRestoring, tops progress, and records preRestoreSha', () => {
    const next = reduceChatEvent(baseState({ isRestoring: true, restoreProgress: 50 }), {
      type: 'restore-end',
      preRestoreSha: 'pre-abc',
      restoredFiles: 3,
      removedFiles: 1
    } satisfies AgentEvent)
    expect(next.isRestoring).toBe(false)
    expect(next.restoreProgress).toBe(100)
    expect(next.lastPreRestoreSha).toBe('pre-abc')
  })

  it('restore-error clears isRestoring and surfaces the message', () => {
    const next = reduceChatEvent(baseState({ isRestoring: true }), {
      type: 'restore-error',
      message: 'boom'
    } satisfies AgentEvent)
    expect(next.isRestoring).toBe(false)
    expect(next.restoreError).toBe('boom')
  })
})
