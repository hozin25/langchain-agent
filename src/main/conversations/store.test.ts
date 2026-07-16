import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationStore } from './store'
import type { Conversation } from '@shared/types'

let dir: string
let store: ReturnType<typeof createConversationStore>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'conv-test-'))
  store = createConversationStore(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeConv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'hello world',
    workspace: '/ws/a',
    createdAt: 1000,
    updatedAt: 1000,
    messages: [
      { id: 'm1', role: 'user', content: 'hi', createdAt: 1000 },
      { id: 'm2', role: 'assistant', content: 'hello', status: 'done', createdAt: 1001 }
    ],
    todos: [],
    ...overrides
  }
}

describe('createConversationStore', () => {
  it('returns an empty list when nothing is saved', async () => {
    const list = await store.listMetas('/ws/a')
    expect(list).toEqual([])
  })

  it('saves a conversation and lists its meta', async () => {
    await store.saveConversation(makeConv())
    const list = await store.listMetas('/ws/a')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'conv-1', title: 'hello world', workspace: '/ws/a' })
  })

  it('filters the list by workspace', async () => {
    await store.saveConversation(makeConv({ id: 'a', workspace: '/ws/a' }))
    await store.saveConversation(makeConv({ id: 'b', workspace: '/ws/b' }))
    expect(await store.listMetas('/ws/a')).toHaveLength(1)
    expect(await store.listMetas('/ws/b')).toHaveLength(1)
    expect((await store.listMetas('/ws/a'))[0].id).toBe('a')
  })

  it('sorts the list by updatedAt descending (newest first)', async () => {
    await store.saveConversation(makeConv({ id: 'old', updatedAt: 1000 }))
    await store.saveConversation(makeConv({ id: 'new', updatedAt: 5000 }))
    await store.saveConversation(makeConv({ id: 'mid', updatedAt: 3000 }))
    const list = await store.listMetas('/ws/a')
    expect(list.map(m => m.id)).toEqual(['new', 'mid', 'old'])
  })

  it('loads the full conversation with messages', async () => {
    await store.saveConversation(makeConv())
    const conv = await store.loadConversation('conv-1')
    expect(conv).not.toBeNull()
    expect(conv?.messages).toHaveLength(2)
    expect(conv?.messages[0].content).toBe('hi')
  })

  it('returns null for a missing conversation', async () => {
    expect(await store.loadConversation('does-not-exist')).toBeNull()
  })

  it('rejects unsafe ids that could escape the directory', async () => {
    expect(await store.loadConversation('../etc/passwd')).toBeNull()
    expect(await store.deleteConversation('../etc/passwd')).toEqual({ ok: false })
    await expect(store.saveConversation(makeConv({ id: '../evil' }))).rejects.toThrow()
  })

  it('updates an existing conversation in place (no duplicate metas)', async () => {
    await store.saveConversation(makeConv({ title: 'first', updatedAt: 1000 }))
    await store.saveConversation(makeConv({ id: 'conv-1', title: 'edited', updatedAt: 2000 }))
    const list = await store.listMetas('/ws/a')
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('edited')
    expect(list[0].updatedAt).toBe(2000)
  })

  it('deletes a conversation from both content and index', async () => {
    await store.saveConversation(makeConv({ id: 'conv-1' }))
    await store.saveConversation(makeConv({ id: 'conv-2', title: 'keep' }))
    expect(await store.deleteConversation('conv-1')).toEqual({ ok: true })
    expect(await store.loadConversation('conv-1')).toBeNull()
    const list = await store.listMetas('/ws/a')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('conv-2')
  })

  it('treats a corrupted index.json as an empty list', async () => {
    // manually plant a broken index
    const convSubdir = join(dir, 'conversations')
    await mkdir(convSubdir, { recursive: true })
    await writeFile(join(convSubdir, 'index.json'), '{ not valid json', 'utf8')
    const list = await store.listMetas('/ws/a')
    expect(list).toEqual([])
    // and saving afterwards should repair it
    await store.saveConversation(makeConv())
    expect(await store.listMetas('/ws/a')).toHaveLength(1)
  })

  it('remembers and returns the last workspace', async () => {
    expect(await store.getLastWorkspace()).toBeNull()
    await store.setLastWorkspace('/ws/a')
    expect(await store.getLastWorkspace()).toBe('/ws/a')
  })
})
