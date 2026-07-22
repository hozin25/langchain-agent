import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore, MAX_MEMORY_ENTRIES } from './config-store'

describe('MemoryStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('add + list persists and reads back sorted by createdAt', async () => {
    const store = createMemoryStore(dir)
    const a = await store.add('C:/proj', 'uses pnpm')
    const b = await store.add('C:/proj', 'lint with eslint')
    const list = await store.list('C:/proj')
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe(a.id)
    expect(list[1].id).toBe(b.id)
    const raw = await readFile(join(dir, 'memory.json'), 'utf8')
    expect(raw).toContain('uses pnpm')
  })

  it('isolates entries per workspace', async () => {
    const store = createMemoryStore(dir)
    await store.add('C:/a', 'fact A')
    await store.add('C:/b', 'fact B')
    expect(await store.list('C:/a')).toHaveLength(1)
    expect(await store.list('C:/b')).toHaveLength(1)
    expect((await store.list('C:/a'))[0].content).toBe('fact A')
    expect((await store.list('C:/b'))[0].content).toBe('fact B')
    expect(await store.list('C:/c')).toHaveLength(0)
  })

  it('drops oldest entries beyond the cap', async () => {
    const store = createMemoryStore(dir)
    for (let i = 0; i < MAX_MEMORY_ENTRIES + 3; i++) {
      await store.add('C:/proj', `entry-${i}`)
    }
    const list = await store.list('C:/proj')
    expect(list).toHaveLength(MAX_MEMORY_ENTRIES)
    // Oldest 3 dropped, so first kept is entry-3
    expect(list[0].content).toBe(`entry-3`)
    expect(list[list.length - 1].content).toBe(`entry-${MAX_MEMORY_ENTRIES + 2}`)
  })

  it('remove works and reports missing ids', async () => {
    const store = createMemoryStore(dir)
    const a = await store.add('C:/proj', 'keep')
    const r = await store.remove('C:/proj', a.id)
    expect(r).toEqual({ ok: true })
    expect(await store.list('C:/proj')).toHaveLength(0)
    const r2 = await store.remove('C:/proj', 'nope')
    expect(r2).toEqual({ ok: false })
  })
})