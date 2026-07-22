import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeSaveMemory } from './memory'
import { createMemoryStore } from '../memory/config-store'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('save_memory', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mem-tool-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('persists the entry through the store for the given workspace', async () => {
    const store = createMemoryStore(dir)
    const t = makeSaveMemory('C:/proj', store)
    const out = await t.invoke({ content: 'uses pnpm not npm' })
    expect(out).toMatch(/Saved memory entry/)
    const list = await store.list('C:/proj')
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('uses pnpm not npm')
  })

  it('rejects empty content', async () => {
    const store = createMemoryStore(dir)
    const t = makeSaveMemory('C:/proj', store)
    await expect(t.invoke({ content: '' })).rejects.toThrow()
  })
})