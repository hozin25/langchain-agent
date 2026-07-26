import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSnapshotIndexStore } from './index-store'
import { workspaceHash } from './shadowRepo'
import type { SnapshotEntry } from '@shared/types'

let dir: string
let store: ReturnType<typeof createSnapshotIndexStore>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snap-index-'))
  store = createSnapshotIndexStore(dir)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeEntry(overrides: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    id: 'snap_1',
    sha: 'abc123',
    workspace: '/ws/a',
    conversationId: 'conv-1',
    createdAt: 1000,
    ...overrides
  }
}

describe('createSnapshotIndexStore', () => {
  it('returns an empty list when nothing is saved', async () => {
    expect(await store.list('/ws/a')).toEqual([])
  })

  it('adds and lists entries sequentially (the production pattern)', async () => {
    // In production snapshots are serialized — one per write tool, awaited before
    // the tool runs — so adds are sequential, not Promise.all'd. True concurrent
    // writes would race the read-modify-write (same shape as conversations/store.ts);
    // that's an accepted limitation, not a contract we test for.
    await store.add(makeEntry({ id: 'snap_1' }))
    await store.add(makeEntry({ id: 'snap_2', sha: 'def456' }))
    const list = await store.list('/ws/a')
    expect(list).toHaveLength(2)
    expect(list.map(e => e.id)).toEqual(['snap_1', 'snap_2'])
  })

  it('isolates timelines by workspace (per-workspaceHash folders)', async () => {
    await store.add(makeEntry({ id: 'snap_1', workspace: '/ws/a' }))
    await store.add(makeEntry({ id: 'snap_2', workspace: '/ws/b' }))
    expect(await store.list('/ws/a')).toHaveLength(1)
    expect(await store.list('/ws/b')).toHaveLength(1)
    expect((await store.list('/ws/a'))[0]!.id).toBe('snap_1')
  })

  it('rejects unsafe ids via SAFE_ID', async () => {
    await expect(store.add(makeEntry({ id: '../evil' }))).rejects.toThrow(/Invalid snapshot id/)
    await expect(store.add(makeEntry({ id: 'has space' }))).rejects.toThrow(/Invalid snapshot id/)
    await expect(store.add(makeEntry({ id: 'dot.dot' }))).rejects.toThrow(/Invalid snapshot id/)
    // underscores and dashes are allowed
    await store.add(makeEntry({ id: 'ok-id_1' }))
    expect(await store.list('/ws/a')).toHaveLength(1)
  })

  it('clears one workspace timeline without touching others', async () => {
    await store.add(makeEntry({ id: 'snap_1', workspace: '/ws/a' }))
    await store.add(makeEntry({ id: 'snap_2', workspace: '/ws/b' }))
    await store.clear('/ws/a')
    expect(await store.list('/ws/a')).toEqual([])
    expect(await store.list('/ws/b')).toHaveLength(1)
  })

  it('treats a corrupted index.json as an empty list and repairs on next add', async () => {
    const root = join(dir, 'agent-snapshots', workspaceHash('/ws/a'))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'index.json'), '{ broken', 'utf8')
    expect(await store.list('/ws/a')).toEqual([])
    await store.add(makeEntry({ id: 'snap_1' }))
    expect(await store.list('/ws/a')).toHaveLength(1)
  })
})
