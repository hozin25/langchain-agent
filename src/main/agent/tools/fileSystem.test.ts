import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCreateDirectory, makeMoveFile } from './fileSystem'

describe('create_directory', () => {
  let workspace: string
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agent-test-'))
  })
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('creates nested directories recursively', async () => {
    const t = makeCreateDirectory(workspace)
    await t.invoke({ path: 'a/b/c' })
    const st = await stat(join(workspace, 'a', 'b', 'c'))
    expect(st.isDirectory()).toBe(true)
  })

  it('rejects paths escaping the workspace', async () => {
    const t = makeCreateDirectory(workspace)
    await expect(t.invoke({ path: '../escape' })).rejects.toThrow(/escapes the workspace/)
  })
})

describe('move_file', () => {
  let workspace: string
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agent-test-'))
  })
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('renames a file within the workspace', async () => {
    await writeFile(join(workspace, 'old.txt'), 'hello')
    const t = makeMoveFile(workspace)
    await t.invoke({ src: 'old.txt', dst: 'new.txt' })
    const content = await readFile(join(workspace, 'new.txt'), 'utf8')
    expect(content).toBe('hello')
    await expect(readFile(join(workspace, 'old.txt'), 'utf8')).rejects.toThrow()
  })

  it('overwrites an existing target', async () => {
    await writeFile(join(workspace, 'src.txt'), 'new-content')
    await writeFile(join(workspace, 'dst.txt'), 'old-content')
    const t = makeMoveFile(workspace)
    await t.invoke({ src: 'src.txt', dst: 'dst.txt' })
    expect(await readFile(join(workspace, 'dst.txt'), 'utf8')).toBe('new-content')
  })

  it('rejects a destination escaping the workspace', async () => {
    await writeFile(join(workspace, 'src.txt'), 'x')
    const t = makeMoveFile(workspace)
    await expect(t.invoke({ src: 'src.txt', dst: '../escape' })).rejects.toThrow(
      /escapes the workspace/
    )
  })
})
