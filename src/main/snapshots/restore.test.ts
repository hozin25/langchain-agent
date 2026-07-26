import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreToSnapshot } from './restore'
import type { ShadowRepo } from './shadowRepo'

// Pure-logic test of restoreToSnapshot with a fake ShadowRepo (no git involved).
// The dangerous guarantees under test: conservative keeps user-added files, full
// only removes non-excluded orphans, pre-restore snapshot is always taken, escape
// paths are rejected by resolveInWorkspace, and missing parent dirs are recreated.

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'restore-ws-'))
})
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

interface FakeRepoOptions {
  files: string[]
  content: Record<string, Buffer>
  preRestoreSha?: string
}

function makeFakeRepo(opts: FakeRepoOptions): { repo: ShadowRepo; snapshotCalls: string[] } {
  const snapshotCalls: string[] = []
  const repo: ShadowRepo = {
    init: async () => {},
    snapshot: async (message: string) => {
      snapshotCalls.push(message)
      return opts.preRestoreSha ?? 'snap-sha'
    },
    listFiles: async () => opts.files,
    readFile: async (_sha: string, rel: string) => opts.content[rel] ?? Buffer.alloc(0),
    listCommits: async () => []
  }
  return { repo, snapshotCalls }
}

describe('restoreToSnapshot', () => {
  it('conservative overwrites snapshot files and keeps user-added files', async () => {
    await writeFile(join(workspace, 'a.txt'), 'ws-old')
    await writeFile(join(workspace, 'new.txt'), 'user-added')
    const { repo } = makeFakeRepo({
      files: ['a.txt'],
      content: { 'a.txt': Buffer.from('snap-content') }
    })
    const result = await restoreToSnapshot(repo, workspace, 'target', 'conservative')
    expect(result.restoredFiles).toBe(1)
    expect(result.removedFiles).toBe(0)
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('snap-content')
    expect(await readFile(join(workspace, 'new.txt'), 'utf8')).toBe('user-added')
  })

  it('full removes workspace files absent from the snapshot', async () => {
    await writeFile(join(workspace, 'a.txt'), 'old')
    await writeFile(join(workspace, 'orphan.txt'), 'gone')
    const { repo } = makeFakeRepo({
      files: ['a.txt'],
      content: { 'a.txt': Buffer.from('new') }
    })
    const result = await restoreToSnapshot(repo, workspace, 'target', 'full')
    expect(result.restoredFiles).toBe(1)
    expect(result.removedFiles).toBe(1)
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('new')
    await expect(readFile(join(workspace, 'orphan.txt'), 'utf8')).rejects.toThrow()
  })

  it('full mode does not delete files under excluded dirs (node_modules)', async () => {
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(workspace, 'node_modules', 'pkg', 'index.js'), 'keep me')
    await writeFile(join(workspace, 'orphan.txt'), 'gone')
    const { repo } = makeFakeRepo({ files: [], content: {} })
    const result = await restoreToSnapshot(repo, workspace, 'target', 'full')
    expect(result.removedFiles).toBe(1)
    expect(await readFile(join(workspace, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('keep me')
  })

  it('creates a pre-restore snapshot and returns its sha (undo path)', async () => {
    const { repo, snapshotCalls } = makeFakeRepo({
      files: [],
      content: {},
      preRestoreSha: 'pre-abc'
    })
    const result = await restoreToSnapshot(repo, workspace, 'target', 'conservative')
    expect(snapshotCalls).toContain('pre-restore')
    expect(result.preRestoreSha).toBe('pre-abc')
  })

  it('rejects snapshot paths that escape the workspace', async () => {
    const { repo } = makeFakeRepo({
      files: ['../escape.txt'],
      content: { '../escape.txt': Buffer.from('evil') }
    })
    await expect(restoreToSnapshot(repo, workspace, 'target', 'conservative')).rejects.toThrow(
      /escapes the workspace/
    )
  })

  it('recreates missing parent directories when restoring nested files', async () => {
    const { repo } = makeFakeRepo({
      files: ['src/deep/x.ts'],
      content: { 'src/deep/x.ts': Buffer.from('nested') }
    })
    const result = await restoreToSnapshot(repo, workspace, 'target', 'conservative')
    expect(result.restoredFiles).toBe(1)
    expect(await readFile(join(workspace, 'src', 'deep', 'x.ts'), 'utf8')).toBe('nested')
  })
})
