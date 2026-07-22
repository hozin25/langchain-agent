import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillConfigStore } from './config-store'

describe('SkillConfigStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skills-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('add + list persists and reads back', async () => {
    const store = createSkillConfigStore(dir)
    const added = await store.add({ name: 'demo', description: 'd', filePath: 'C:/x.md', enabled: true })
    expect(added.id).toBeTruthy()
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('demo')
    const raw = await readFile(join(dir, 'skills-config.json'), 'utf8')
    expect(raw).toContain('demo')
  })

  it('rejects duplicate name', async () => {
    const store = createSkillConfigStore(dir)
    await store.add({ name: 'dup', description: 'd', filePath: 'C:/a.md', enabled: true })
    await expect(
      store.add({ name: 'dup', description: 'd2', filePath: 'C:/b.md', enabled: true })
    ).rejects.toThrow(/already exists/)
  })

  it('remove works', async () => {
    const store = createSkillConfigStore(dir)
    const a = await store.add({ name: 'a', description: 'd', filePath: 'C:/a.md', enabled: true })
    const r = await store.remove(a.id)
    expect(r).toEqual({ ok: true })
    expect(await store.list()).toHaveLength(0)
  })
})
