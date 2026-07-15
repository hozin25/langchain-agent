import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGlob } from './search'

describe('glob', () => {
  let workspace: string
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agent-glob-'))
    await mkdir(join(workspace, 'sub'))
    await writeFile(join(workspace, 'a.ts'), 'x')
    await writeFile(join(workspace, 'sub', 'b.ts'), 'x')
    await writeFile(join(workspace, 'readme.md'), 'x')
    await mkdir(join(workspace, 'node_modules'))
    await writeFile(join(workspace, 'node_modules', 'skip.ts'), 'x')
  })
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('matches files recursively by extension', async () => {
    const t = makeGlob(workspace)
    const out = await t.invoke({ pattern: '**/*.ts' })
    const lines = out.split('\n').sort()
    expect(lines).toEqual(['a.ts', 'sub/b.ts'])
  })

  it('respects ignore dirs', async () => {
    const t = makeGlob(workspace)
    const out = await t.invoke({ pattern: '**/*.ts' })
    expect(out).not.toContain('node_modules')
  })

  it('scopes to a subdirectory', async () => {
    const t = makeGlob(workspace)
    const out = await t.invoke({ pattern: '*.ts', path: 'sub' })
    expect(out.trim()).toBe('b.ts')
  })

  it('reports no matches', async () => {
    const t = makeGlob(workspace)
    const out = await t.invoke({ pattern: '**/*.xyz' })
    expect(out).toMatch(/No files found/)
  })
})
