import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createShadowRepo } from './shadowRepo'

// Real-git integration test for the shadow repo. Mirrors what probe-shadow-git.cjs
// verifies at the Electron ABI level; here we confirm the TS wrapper's contract:
// snapshot → sha, listFiles/readFile round-trip, no-change idempotence, the
// --allow-empty baseline path, exclude patterns, and multi-commit log ordering.

let userData: string
let workspace: string

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'snap-userdata-'))
  workspace = await mkdtemp(join(tmpdir(), 'snap-ws-'))
})

afterEach(async () => {
  await Promise.all([
    rm(userData, { recursive: true, force: true }),
    rm(workspace, { recursive: true, force: true })
  ])
})

describe('createShadowRepo', () => {
  it('snapshot returns a sha and the file round-trips via listFiles/readFile', async () => {
    const repo = createShadowRepo(userData, workspace)
    await writeFile(join(workspace, 'a.txt'), 'hello')
    const sha = await repo.snapshot('first')
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/)
    expect(await repo.listFiles(sha)).toContain('a.txt')
    expect((await repo.readFile(sha, 'a.txt')).toString('utf8')).toBe('hello')
  })

  it('returns the previous sha when nothing changed (no throw)', async () => {
    const repo = createShadowRepo(userData, workspace)
    await writeFile(join(workspace, 'a.txt'), 'v1')
    const sha1 = await repo.snapshot('first')
    const sha2 = await repo.snapshot('no-change')
    expect(sha2).toBe(sha1)
  })

  it('creates a new commit when content changes and keeps old snapshots readable', async () => {
    const repo = createShadowRepo(userData, workspace)
    await writeFile(join(workspace, 'a.txt'), 'v1')
    const sha1 = await repo.snapshot('first')
    await writeFile(join(workspace, 'a.txt'), 'v2')
    const sha2 = await repo.snapshot('second')
    expect(sha2).not.toBe(sha1)
    expect((await repo.readFile(sha2, 'a.txt')).toString('utf8')).toBe('v2')
    expect((await repo.readFile(sha1, 'a.txt')).toString('utf8')).toBe('v1')
  })

  it('creates a baseline commit on an empty workspace via --allow-empty', async () => {
    const repo = createShadowRepo(userData, workspace)
    const sha = await repo.snapshot('baseline')
    expect(sha).toMatch(/^[0-9a-f]+$/)
    expect(await repo.listFiles(sha)).toEqual([])
  })

  it('handles nested directories', async () => {
    const repo = createShadowRepo(userData, workspace)
    await mkdir(join(workspace, 'src', 'deep'), { recursive: true })
    await writeFile(join(workspace, 'src', 'deep', 'x.ts'), 'export {}')
    const sha = await repo.snapshot('nested')
    expect(await repo.listFiles(sha)).toContain('src/deep/x.ts')
  })

  it('excludes node_modules and build artifact dirs from snapshots', async () => {
    const repo = createShadowRepo(userData, workspace)
    await writeFile(join(workspace, 'keep.txt'), 'keep')
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(workspace, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1')
    await mkdir(join(workspace, 'out'), { recursive: true })
    await writeFile(join(workspace, 'out', 'bundle.js'), 'built')
    const files = await repo.listFiles(await repo.snapshot('exclude'))
    expect(files).toContain('keep.txt')
    expect(files.some(f => f.includes('node_modules'))).toBe(false)
    expect(files.some(f => f.startsWith('out/'))).toBe(false)
  })

  it('lists commits newest-first with message + timestamp', async () => {
    const repo = createShadowRepo(userData, workspace)
    await writeFile(join(workspace, 'a.txt'), '1')
    await repo.snapshot('commit-one')
    await writeFile(join(workspace, 'a.txt'), '2')
    await repo.snapshot('commit-two')
    const commits = await repo.listCommits()
    expect(commits.length).toBeGreaterThanOrEqual(2)
    expect(commits[0]!.message).toBe('commit-two')
    expect(commits[1]!.message).toBe('commit-one')
    expect(commits[0]!.createdAt).toBeGreaterThanOrEqual(commits[1]!.createdAt)
  })
})
