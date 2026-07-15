import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGlob, makeGrep } from './search'

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

describe('grep', () => {
  let workspace: string
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agent-grep-'))
    await mkdir(join(workspace, 'sub'))
    await writeFile(
      join(workspace, 'a.ts'),
      'export const alpha = 1\nconst beta = 2\nexport const gamma = 3'
    )
    await writeFile(join(workspace, 'sub', 'b.ts'), 'export const delta = 4')
    await writeFile(join(workspace, 'readme.md'), '# Export Guide')
  })
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('content mode lists matching lines with line numbers', async () => {
    const t = makeGrep(workspace)
    const out = await t.invoke({ pattern: 'export', outputMode: 'content' })
    expect(out).toContain('a.ts:1: export const alpha = 1')
    expect(out).toContain('a.ts:3: export const gamma = 3')
    expect(out).toContain('sub/b.ts:1: export const delta = 4')
  })

  it('files_with_matches mode lists only matching paths', async () => {
    const t = makeGrep(workspace)
    const out = await t.invoke({
      pattern: 'export',
      outputMode: 'files_with_matches',
      glob: '**/*.ts'
    })
    const lines = out.split('\n').sort()
    expect(lines).toEqual(['a.ts', 'sub/b.ts'])
    expect(out).not.toContain('readme.md')
  })

  it('count mode reports per-file counts', async () => {
    const t = makeGrep(workspace)
    const out = await t.invoke({ pattern: 'export', outputMode: 'count' })
    expect(out).toContain('a.ts:2')
    expect(out).toContain('sub/b.ts:1')
  })

  it('contextAfter includes following lines', async () => {
    const t = makeGrep(workspace)
    const out = await t.invoke({ pattern: 'alpha', outputMode: 'content', contextAfter: 1 })
    expect(out).toContain('a.ts:1: export const alpha = 1')
    expect(out).toContain('a.ts-2- const beta = 2')
  })

  it('caseInsensitive matches different casing', async () => {
    const t = makeGrep(workspace)
    const out = await t.invoke({ pattern: 'EXPORT', outputMode: 'content', caseInsensitive: true })
    expect(out).toContain('Export Guide')
  })

  it('reports no matches', async () => {
    const t = makeGrep(workspace)
    const out = await t.invoke({ pattern: 'zzzzz', outputMode: 'content' })
    expect(out).toMatch(/No matches found/)
  })
})
