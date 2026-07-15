import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.cache',
  'release'
])
const MAX_FILES = 500
const MAX_MATCHES = 100

async function walk(dir: string, acc: string[]): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) return acc
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue
      await walk(join(dir, e.name), acc)
    } else {
      acc.push(join(dir, e.name))
    }
  }
  return acc
}

function globToRegex(glob: string): RegExp {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 3
        continue
      }
      re += '.*'
      i += 2
      continue
    }
    if (c === '*') {
      re += '[^/]*'
      i += 1
      continue
    }
    if (c === '?') {
      re += '[^/]'
      i += 1
      continue
    }
    if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
      i += 1
      continue
    }
    re += c
    i += 1
  }
  return new RegExp('^' + re + '$')
}

export const makeGlob = (workspace: string) =>
  tool(
    async ({ pattern, path }) => {
      const root = resolve(workspace, path ?? '.')
      const files = await walk(root, [])
      const re = globToRegex(pattern)
      const hits = files
        .filter(f => re.test(relative(root, f).split(sep).join('/')))
        .map(f => relative(root, f).split(sep).join('/'))
        .sort()
      if (hits.length === 0) return 'No files found'
      return hits.slice(0, MAX_MATCHES).join('\n')
    },
    {
      name: 'glob',
      description:
        'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.test.ts"). Skips node_modules / .git / build dirs. Paths are relative to the workspace root.',
      schema: z.object({
        pattern: z.string().describe('Glob pattern, e.g. "**/*.ts"'),
        path: z
          .string()
          .optional()
          .describe('Subdirectory to search within; defaults to workspace root')
      })
    }
  )

export const makeSearchFiles = (workspace: string) =>
  tool(
    async ({ pattern, glob }) => {
      const root = resolve(workspace)
      let files = await walk(root, [])
      if (glob) {
        const re = globToRegex(glob)
        files = files.filter(f => re.test(relative(root, f)))
      }
      const re = new RegExp(pattern)
      const hits: string[] = []
      for (const f of files) {
        if (hits.length >= MAX_MATCHES) break
        try {
          const content = await readFile(f, 'utf8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (hits.length >= MAX_MATCHES) break
            const line = lines[i]
            if (line && re.test(line)) {
              hits.push(`${relative(root, f)}:${i + 1}: ${line.trim()}`)
            }
          }
        } catch {
          // skip unreadable / binary files
        }
      }
      return hits.length > 0 ? hits.join('\n') : 'No matches found'
    },
    {
      name: 'search_files',
      description:
        'Search file contents with a regex pattern. Optionally restrict to a glob like "*.ts". Skips node_modules / .git / build dirs.',
      schema: z.object({
        pattern: z.string().describe('Regular expression to match line contents'),
        glob: z.string().optional().describe('Optional filename glob, e.g. "*.ts"')
      })
    }
  )
