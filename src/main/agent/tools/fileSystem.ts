import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

export function resolveInWorkspace(workspace: string, path: string): string {
  const abs = isAbsolute(path) ? path : join(workspace, path)
  const resolved = resolve(abs)
  const rel = relative(workspace, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${path}" escapes the workspace boundary`)
  }
  return resolved
}

export const makeReadFile = (workspace: string) =>
  tool(
    async ({ path }) => {
      const full = resolveInWorkspace(workspace, path)
      return await readFile(full, 'utf8')
    },
    {
      name: 'read_file',
      description: 'Read the full text content of a file. Path is relative to the workspace root.',
      schema: z.object({ path: z.string().describe('Relative path to the file') })
    }
  )

export const makeWriteFile = (workspace: string) =>
  tool(
    async ({ path, content }) => {
      const full = resolveInWorkspace(workspace, path)
      await writeFile(full, content, 'utf8')
      return `Wrote ${content.length} characters to ${path}`
    },
    {
      name: 'write_file',
      description:
        'Create or overwrite a file with the given content. Path is relative to the workspace root.',
      schema: z.object({ path: z.string(), content: z.string() })
    }
  )

export const makeEditFile = (workspace: string) =>
  tool(
    async ({ path, oldText, newText }) => {
      const full = resolveInWorkspace(workspace, path)
      const original = await readFile(full, 'utf8')
      if (!original.includes(oldText)) {
        throw new Error('oldText was not found in the file — provide an exact, unique snippet')
      }
      const occurrences = original.split(oldText).length - 1
      if (occurrences > 1) {
        throw new Error(
          `oldText matches ${occurrences} times — include more surrounding context to make it unique`
        )
      }
      await writeFile(full, original.replace(oldText, newText), 'utf8')
      return `Edited ${path}`
    },
    {
      name: 'edit_file',
      description:
        'Replace a unique, exact string (oldText) in a file with newText. Fails if oldText is missing or not unique.',
      schema: z.object({
        path: z.string(),
        oldText: z.string(),
        newText: z.string()
      })
    }
  )

export const makeListDirectory = (workspace: string) =>
  tool(
    async ({ path }) => {
      const full = resolveInWorkspace(workspace, path ?? '.')
      const entries = await readdir(full, { withFileTypes: true })
      return entries.map(e => `${e.isDirectory() ? '[dir]  ' : '[file] '}${e.name}`).join('\n')
    },
    {
      name: 'list_directory',
      description: 'List files and subdirectories at the given path (defaults to workspace root).',
      schema: z.object({
        path: z.string().optional().describe('Relative path; defaults to workspace root')
      })
    }
  )

export const makeCreateDirectory = (workspace: string) =>
  tool(
    async ({ path }) => {
      const full = resolveInWorkspace(workspace, path)
      await mkdir(full, { recursive: true })
      return `Created directory ${path}`
    },
    {
      name: 'create_directory',
      description:
        'Create a directory (and any missing parent directories). Path is relative to the workspace root.',
      schema: z.object({ path: z.string().describe('Relative path of the directory to create') })
    }
  )

export const makeMoveFile = (workspace: string) =>
  tool(
    async ({ src, dst }) => {
      const srcFull = resolveInWorkspace(workspace, src)
      const dstFull = resolveInWorkspace(workspace, dst)
      await rename(srcFull, dstFull)
      return `Moved ${src} → ${dst}`
    },
    {
      name: 'move_file',
      description:
        'Rename or move a file/directory. Overwrites an existing target. Both paths are relative to the workspace root.',
      schema: z.object({
        src: z.string().describe('Relative path of the source'),
        dst: z.string().describe('Relative path of the destination')
      })
    }
  )

export const makeDeleteFile = (workspace: string) =>
  tool(
    async ({ path }) => {
      const full = resolveInWorkspace(workspace, path)
      const trash = (await import('trash')).default
      await trash([full])
      return `Moved ${path} to trash (recoverable)`
    },
    {
      name: 'delete_file',
      description:
        'Move a file or directory to the operating system trash (recoverable). Path is relative to the workspace root.',
      schema: z.object({ path: z.string().describe('Relative path to delete (sent to trash)') })
    }
  )
