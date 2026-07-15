import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

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
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(escaped + '$')
}

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
