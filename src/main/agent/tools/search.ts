import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { resolveInWorkspace } from './fileSystem'

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
      const root = resolveInWorkspace(workspace, path ?? '.')
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

export const makeGrep = (workspace: string) =>
  tool(
    async ({
      pattern,
      path,
      glob,
      outputMode,
      contextBefore,
      contextAfter,
      caseInsensitive,
      headLimit
    }) => {
      const root = resolveInWorkspace(workspace, path ?? '.')
      const files = await walk(root, [])
      const globRe = glob ? globToRegex(glob) : null
      const targets = globRe
        ? files.filter(f => globRe.test(relative(root, f).split(sep).join('/')))
        : files
      const re = new RegExp(pattern, caseInsensitive ? 'i' : '')
      const before = contextBefore ?? 0
      const after = contextAfter ?? 0
      const limit = headLimit ?? 100

      const fileMatches: Array<{ file: string; matches: number }> = []
      const contentLines: string[] = []

      for (const f of targets) {
        const rel = relative(root, f).split(sep).join('/')
        let text: string
        try {
          text = await readFile(f, 'utf8')
        } catch {
          continue
        }
        const lines = text.split('\n')
        const matchIdx: number[] = []
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) matchIdx.push(i)
        }
        if (matchIdx.length === 0) continue
        fileMatches.push({ file: rel, matches: matchIdx.length })

        if (outputMode === 'content') {
          const show = new Set<number>()
          const isMatch = new Set<number>(matchIdx)
          for (const m of matchIdx) {
            for (let j = m - before; j <= m + after; j++) {
              if (j >= 0 && j < lines.length) show.add(j)
            }
          }
          for (const idx of Array.from(show).sort((a, b) => a - b)) {
            const marker = isMatch.has(idx) ? ':' : '-'
            contentLines.push(`${rel}${marker}${idx + 1}${marker} ${lines[idx]}`)
            if (contentLines.length >= limit) break
          }
          if (contentLines.length >= limit) break
        }
      }

      if (outputMode === 'files_with_matches') {
        const out = fileMatches.map(m => m.file)
        return out.length > 0 ? out.slice(0, limit).join('\n') : 'No matches found'
      }
      if (outputMode === 'count') {
        const out = fileMatches.map(m => `${m.file}:${m.matches}`)
        return out.length > 0 ? out.join('\n') : 'No matches found'
      }
      return contentLines.length > 0 ? contentLines.join('\n') : 'No matches found'
    },
    {
      name: 'grep',
      description:
        'Search file contents with a regex (ripgrep-style). Options: glob filename filter, outputMode (content | files_with_matches | count), contextBefore/contextAfter, caseInsensitive, headLimit. Skips node_modules / .git / build dirs.',
      schema: z.object({
        pattern: z.string().describe('Regular expression to match line contents'),
        path: z
          .string()
          .optional()
          .describe('Subdirectory to search within; defaults to workspace root'),
        glob: z.string().optional().describe('Filename glob filter, e.g. "*.ts"'),
        outputMode: z
          .enum(['content', 'files_with_matches', 'count'])
          .optional()
          .describe('Default: content'),
        contextBefore: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Lines of context before each match (-B)'),
        contextAfter: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Lines of context after each match (-A)'),
        caseInsensitive: z.boolean().optional(),
        headLimit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max output lines/results; default 100')
      })
    }
  )
