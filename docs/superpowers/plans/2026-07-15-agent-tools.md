# Agent 工具集扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为桌面 code agent 新增/升级 8 个工具（glob、grep、create_directory、move_file、delete_file、web_fetch、web_search、todo_write），对标主流 agent，并让 todo 状态在聊天 UI 实时展示。

**Architecture:** 沿用现有工厂函数 `makeXxx(workspace)` 模式；所有 fs 工具继续走 `resolveInWorkspace()` 沙箱。todo 工具经新增的 `emit` 回调把 `todo-update` 事件推到 renderer store，由 `TodoList` 组件实时渲染。web 工具直接 `fetch`（web_search 走 Tavily REST，web_fetch 用 turndown 转 markdown）。三阶段按依赖/风险切分，每阶段独立可提交。

**Tech Stack:** TypeScript 7、Electron、@langchain/core 的 `tool()` + zod、vitest、turndown、trash、Node 24 全局 `fetch`/`AbortController`。

---

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `src/main/agent/tools/fileSystem.ts` | read/write/edit/list + 新增 create_directory/move_file/delete_file；持有 `resolveInWorkspace` | 修改 |
| `src/main/agent/tools/search.ts` | 重构共享 `walk`/`IGNORE_DIRS`/`globToRegex`；导出 `makeGlob`、`makeGrep`；删除 `makeSearchFiles` | 修改 |
| `src/main/agent/tools/web.ts` | `makeWebFetch` + `makeWebSearch` | 新建 |
| `src/main/agent/tools/todo.ts` | `makeTodoWrite(emit)` | 新建 |
| `src/main/agent/tools/index.ts` | `getTools(workspace, emit)` 注册全部工具 | 修改 |
| `src/main/agent/index.ts` | `runAgent` 把 `onEvent` 作为 `emit` 传入 | 修改 |
| `src/main/agent/prompts.ts` | 增补新工具用法与规划指引 | 修改 |
| `src/shared/types.ts` | 新增 `TodoItem` + `AgentEvent` 的 `todo-update` 变体 | 修改 |
| `src/renderer/src/stores/chat.ts` | `todos` 状态 + `todo-update` 事件分支 + send 时清空 | 修改 |
| `src/renderer/src/components/TodoList.tsx` | 任务清单卡片 | 新建 |
| `src/renderer/src/components/ChatPanel.tsx` | 渲染 `TodoList` | 修改 |
| `src/renderer/src/index.css` | todo 卡片样式 | 修改 |
| `.env.example` | 增加 `TAVILY_API_KEY` | 修改 |
| `src/main/agent/tools/*.test.ts` | 各工具单测 | 新建 |

### 计划相对 spec 的一处精简（YAGNI）

spec §5.1 的 `grep` 列了 `multiline` 选项。逐行扫描实现下，`m`/`s` 正则标志对该扫描无实际效果，等于一个空操作开关。本计划**移除 `multiline`**，其余参数与 spec 一致。如需跨行匹配，后续再单独加。

---

## Phase 1 — 本地工具（低风险，零/低依赖）

### Task 1: create_directory 与 move_file

**Files:**
- Modify: `src/main/agent/tools/fileSystem.ts`（追加两个工厂）
- Modify: `src/main/agent/tools/index.ts`（注册）
- Test: `src/main/agent/tools/fileSystem.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

创建 `src/main/agent/tools/fileSystem.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from 'node:fs/promises'
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
    await expect(t.invoke({ src: 'src.txt', dst: '../escape' })).rejects.toThrow(/escapes the workspace/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/agent/tools/fileSystem.test.ts`
Expected: FAIL — `makeCreateDirectory is not a function`（工厂尚未导出）。

- [ ] **Step 3: 实现两个工厂**

在 `src/main/agent/tools/fileSystem.ts` 末尾追加（`mkdir`、`rename` 加入顶部 `node:fs/promises` 的 import）：

```ts
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
```

更新 `fileSystem.ts` 顶部的 import 行，把 `mkdir`、`rename` 加进去：

```ts
import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises'
```

- [ ] **Step 4: 在 index.ts 注册**

把 `src/main/agent/tools/index.ts` 改为：

```ts
import { makeReadFile, makeWriteFile, makeEditFile, makeListDirectory, makeCreateDirectory, makeMoveFile } from './fileSystem'
import { makeSearchFiles } from './search'
import { makeRunShellCommand } from './shell'

export function getTools(workspace: string) {
  return [
    makeReadFile(workspace),
    makeWriteFile(workspace),
    makeEditFile(workspace),
    makeListDirectory(workspace),
    makeCreateDirectory(workspace),
    makeMoveFile(workspace),
    makeSearchFiles(workspace),
    makeRunShellCommand(workspace)
  ]
}
```

注意：Task 4 会把 `makeSearchFiles` 换成 `makeGlob`/`makeGrep`，本任务保持 `makeSearchFiles` 不动以维持构建可用。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/agent/tools/fileSystem.test.ts`
Expected: PASS（5 个用例全过）。

- [ ] **Step 6: 提交**

```bash
git add src/main/agent/tools/fileSystem.ts src/main/agent/tools/fileSystem.test.ts src/main/agent/tools/index.ts
git commit -m "feat: add create_directory and move_file tools"
```

---

### Task 2: delete_file（送回收站）

**Files:**
- Modify: `package.json`（加 `trash` 依赖）
- Modify: `src/main/agent/tools/fileSystem.ts`
- Modify: `src/main/agent/tools/index.ts`
- Test: `src/main/agent/tools/fileSystem.test.ts`（追加 describe）

- [ ] **Step 1: 安装依赖**

Run: `pnpm add trash`
Expected: 安装成功；`package.json` 的 `dependencies` 出现 `trash`。

- [ ] **Step 2: 写失败测试**

在 `src/main/agent/tools/fileSystem.test.ts` 顶部 import 区追加 `vi`，并新增文件顶部 mock 与 describe：

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('trash', () => ({ default: vi.fn().mockResolvedValue(undefined) }))
import trash from 'trash'
```

在文件末尾追加：

```ts
describe('delete_file', () => {
  let workspace: string
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agent-test-'))
    vi.mocked(trash).mockClear()
  })
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('sends a file to the trash', async () => {
    await writeFile(join(workspace, 'gone.txt'), 'bye')
    const t = makeDeleteFile(workspace)
    const out = await t.invoke({ path: 'gone.txt' })
    expect(out).toMatch(/Moved .* to trash/)
    expect(trash).toHaveBeenCalledTimes(1)
    expect(trash).toHaveBeenCalledWith([join(workspace, 'gone.txt')])
  })

  it('rejects paths escaping the workspace', async () => {
    const t = makeDeleteFile(workspace)
    await expect(t.invoke({ path: '../../etc' })).rejects.toThrow(/escapes the workspace/)
    expect(trash).not.toHaveBeenCalled()
  })
})
```

并在顶部 import 行加入 `makeDeleteFile`：

```ts
import { makeCreateDirectory, makeMoveFile, makeDeleteFile } from './fileSystem'
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/agent/tools/fileSystem.test.ts -t delete_file`
Expected: FAIL — `makeDeleteFile is not a function`。

- [ ] **Step 4: 实现 delete_file**

在 `fileSystem.ts` 顶部加默认 import：

```ts
import trash from 'trash'
```

末尾追加：

```ts
export const makeDeleteFile = (workspace: string) =>
  tool(
    async ({ path }) => {
      const full = resolveInWorkspace(workspace, path)
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
```

- [ ] **Step 5: 注册**

更新 `src/main/agent/tools/index.ts` 的 import 与数组，加入 `makeDeleteFile`：

```ts
import { makeReadFile, makeWriteFile, makeEditFile, makeListDirectory, makeCreateDirectory, makeMoveFile, makeDeleteFile } from './fileSystem'
import { makeSearchFiles } from './search'
import { makeRunShellCommand } from './shell'

export function getTools(workspace: string) {
  return [
    makeReadFile(workspace),
    makeWriteFile(workspace),
    makeEditFile(workspace),
    makeListDirectory(workspace),
    makeCreateDirectory(workspace),
    makeMoveFile(workspace),
    makeDeleteFile(workspace),
    makeSearchFiles(workspace),
    makeRunShellCommand(workspace)
  ]
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/agent/tools/fileSystem.test.ts`
Expected: PASS（含 delete_file 的两个用例）。

- [ ] **Step 7: 校验 trash 的 ESM 导入在主进程可用**

Run: `pnpm typecheck:node`
Expected: 通过。再启动 `pnpm dev`，在选中工作区里让 agent 调用 `delete_file`（或临时手测），确认主进程没有 `ERR_REQUIRE_ESM` 之类报错。若报 ESM 错误，按 spec §10 退回 Windows PowerShell 回收站实现（见本步备注）。

备注（仅当 ESM 失败时执行）：把 `delete_file` 中的 `await trash([full])` 替换为 `await moveToTrashWindows(full)`，并实现：

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

async function moveToTrashWindows(absPath: string): Promise<void> {
  // Uses the Shell.Application COM to send a file to the Recycle Bin.
  const ps = `$p = '${absPath.replace(/'/g, "''")}'; (New-Object -ComObject Shell.Application).Namespace(0).MoveHere($p)`
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps])
}
```

- [ ] **Step 8: 提交**

```bash
git add package.json pnpm-lock.yaml src/main/agent/tools/fileSystem.ts src/main/agent/tools/fileSystem.test.ts src/main/agent/tools/index.ts
git commit -m "feat: add delete_file tool (trash, recoverable)"
```

---

### Task 3: glob 工具

**Files:**
- Modify: `src/main/agent/tools/search.ts`（重构共享逻辑 + 新增 `makeGlob`）
- Modify: `src/main/agent/tools/index.ts`
- Test: `src/main/agent/tools/search.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

创建 `src/main/agent/tools/search.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/agent/tools/search.test.ts`
Expected: FAIL — `makeGlob is not a function`。

- [ ] **Step 3: 重构 search.ts 并实现 makeGlob**

把 `src/main/agent/tools/search.ts` 顶部的 `globToRegex` 替换为支持 `**` 的版本，并新增 `makeGlob`。重写整个文件为：

```ts
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
      const hits = files.filter(f => re.test(relative(root, f))).sort()
      if (hits.length === 0) return 'No files found'
      return hits.map(f => relative(root, f)).slice(0, MAX_MATCHES).join('\n')
    },
    {
      name: 'glob',
      description:
        'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.test.ts"). Skips node_modules / .git / build dirs. Paths are relative to the workspace root.',
      schema: z.object({
        pattern: z.string().describe('Glob pattern, e.g. "**/*.ts"'),
        path: z.string().optional().describe('Subdirectory to search within; defaults to workspace root')
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
```

（`makeSearchFiles` 暂时保留，Task 4 删除。）

- [ ] **Step 4: 注册 glob**

更新 `src/main/agent/tools/index.ts`：

```ts
import { makeReadFile, makeWriteFile, makeEditFile, makeListDirectory, makeCreateDirectory, makeMoveFile, makeDeleteFile } from './fileSystem'
import { makeGlob, makeSearchFiles } from './search'
import { makeRunShellCommand } from './shell'

export function getTools(workspace: string) {
  return [
    makeReadFile(workspace),
    makeWriteFile(workspace),
    makeEditFile(workspace),
    makeListDirectory(workspace),
    makeCreateDirectory(workspace),
    makeMoveFile(workspace),
    makeDeleteFile(workspace),
    makeGlob(workspace),
    makeSearchFiles(workspace),
    makeRunShellCommand(workspace)
  ]
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/agent/tools/search.test.ts`
Expected: PASS（4 个用例）。

- [ ] **Step 6: 提交**

```bash
git add src/main/agent/tools/search.ts src/main/agent/tools/search.test.ts src/main/agent/tools/index.ts
git commit -m "feat: add glob tool with ** pattern support"
```

---

### Task 4: grep 工具（替换 search_files）+ 更新提示词

**Files:**
- Modify: `src/main/agent/tools/search.ts`（新增 `makeGrep`，删除 `makeSearchFiles`）
- Modify: `src/main/agent/tools/index.ts`
- Modify: `src/main/agent/prompts.ts`
- Test: `src/main/agent/tools/search.test.ts`（追加 grep describe）

- [ ] **Step 1: 写失败测试**

在 `src/main/agent/tools/search.test.ts` 顶部 import 加 `makeGrep`：

```ts
import { makeGlob, makeGrep } from './search'
```

并补充更丰富的工作区文件（在 `glob` 的 beforeEach 里已建 a.ts/sub/b.ts/readme.md；为 grep 追加内容）。在文件末尾新增：

```ts
describe('grep', () => {
  let workspace: string
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agent-grep-'))
    await mkdir(join(workspace, 'sub'))
    await writeFile(join(workspace, 'a.ts'), 'export const alpha = 1\nconst beta = 2\nexport const gamma = 3')
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
    const out = await t.invoke({ pattern: 'export', outputMode: 'files_with_matches', glob: '**/*.ts' })
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/agent/tools/search.test.ts -t grep`
Expected: FAIL — `makeGrep is not a function`。

- [ ] **Step 3: 实现 makeGrep，删除 makeSearchFiles**

在 `src/main/agent/tools/search.ts` 中删除整个 `makeSearchFiles` 导出，新增 `makeGrep`（放在 `makeGlob` 之后）：

```ts
export const makeGrep = (workspace: string) =>
  tool(
    async ({ pattern, path, glob, outputMode, contextBefore, contextAfter, caseInsensitive, headLimit }) => {
      const root = resolve(workspace, path ?? '.')
      const files = await walk(root, [])
      const globRe = glob ? globToRegex(glob) : null
      const targets = globRe ? files.filter(f => globRe.test(relative(root, f))) : files
      const re = new RegExp(pattern, caseInsensitive ? 'i' : '')
      const before = contextBefore ?? 0
      const after = contextAfter ?? 0
      const limit = headLimit ?? 100

      const fileMatches: Array<{ file: string; matches: number }> = []
      const contentLines: string[] = []

      for (const f of targets) {
        const rel = relative(root, f)
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
            const sep = isMatch.has(idx) ? ':' : '-'
            contentLines.push(`${rel}${sep}${idx + 1}${sep} ${lines[idx]}`)
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
        path: z.string().optional().describe('Subdirectory to search within; defaults to workspace root'),
        glob: z.string().optional().describe('Filename glob filter, e.g. "*.ts"'),
        outputMode: z.enum(['content', 'files_with_matches', 'count']).optional().describe('Default: content'),
        contextBefore: z.number().int().min(0).optional().describe('Lines of context before each match (-B)'),
        contextAfter: z.number().int().min(0).optional().describe('Lines of context after each match (-A)'),
        caseInsensitive: z.boolean().optional(),
        headLimit: z.number().int().positive().optional().describe('Max output lines/results; default 100')
      })
    }
  )
```

- [ ] **Step 4: 更新 index.ts（去 search_files，加 grep）**

```ts
import { makeReadFile, makeWriteFile, makeEditFile, makeListDirectory, makeCreateDirectory, makeMoveFile, makeDeleteFile } from './fileSystem'
import { makeGlob, makeGrep } from './search'
import { makeRunShellCommand } from './shell'

export function getTools(workspace: string) {
  return [
    makeReadFile(workspace),
    makeWriteFile(workspace),
    makeEditFile(workspace),
    makeListDirectory(workspace),
    makeCreateDirectory(workspace),
    makeMoveFile(workspace),
    makeDeleteFile(workspace),
    makeGlob(workspace),
    makeGrep(workspace),
    makeRunShellCommand(workspace)
  ]
}
```

- [ ] **Step 5: 运行全部 search 测试确认通过**

Run: `pnpm exec vitest run src/main/agent/tools/search.test.ts`
Expected: PASS（glob 4 个 + grep 6 个）。

- [ ] **Step 6: 更新 system prompt（覆盖阶段 1 工具）**

把 `src/main/agent/prompts.ts` 的 `SYSTEM_PROMPT` 改为：

```ts
const today = new Date().toISOString().split('T')[0]

export const SYSTEM_PROMPT = `You are a helpful coding assistant running inside a desktop application with direct filesystem, shell, and web access to the user's selected workspace.

Operating principles:
- Explore before editing. Use glob to find files by name and grep to search contents; read files and list directories to build a mental model before changing anything.
- Be surgical. Prefer targeted edits over rewriting whole files.
- Narrate briefly: in one or two sentences say what you will do, then call the tool.
- Verify your work. After changes, run the relevant build / typecheck / test command when feasible.
- Report results. Summarize what changed, anything that failed, and concrete next steps.
- Ask when unsure. If a request is ambiguous, request clarification instead of guessing.

Constraints:
- All file paths are relative to the workspace root. Tools reject paths that escape it.
- Shell commands run in the workspace with a 30-second timeout.
- Do not attempt to access anything outside the workspace.
- delete_file moves files to the recycle bin (recoverable); move_file overwrites an existing target.

Today is ${today}.`
```

- [ ] **Step 7: 提交**

```bash
git add src/main/agent/tools/search.ts src/main/agent/tools/search.test.ts src/main/agent/tools/index.ts src/main/agent/prompts.ts
git commit -m "feat: replace search_files with ripgrep-style grep"
```

---

### Task 5: 阶段 1 验证

- [ ] **Step 1: 类型检查双工程**

Run: `pnpm typecheck`
Expected: 两个工程均无错误。

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 所有用例通过。

- [ ] **Step 3: 手动冒烟**

Run: `pnpm dev`，选一个工作区，让 agent：用 `glob` 找文件、用 `grep` 搜内容、`create_directory` 建目录、`move_file` 改名、`delete_file` 删文件（确认进了回收站）。确认无回归（read/write/edit/list/shell 仍正常）。

---

## Phase 2 — 联网工具

### Task 6: web_fetch

**Files:**
- Modify: `package.json`（加 `turndown` 及 `@types/turndown`）
- Create: `src/main/agent/tools/web.ts`
- Modify: `src/main/agent/tools/index.ts`
- Test: `src/main/agent/tools/web.test.ts`

- [ ] **Step 1: 安装依赖**

Run: `pnpm add turndown && pnpm add -D @types/turndown`
Expected: 安装成功。

- [ ] **Step 2: 写失败测试**

创建 `src/main/agent/tools/web.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeWebFetch } from './web'

function mockResponse(opts: { ok?: boolean; status?: number; statusText?: string; contentType?: string; body: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? opts.contentType ?? 'text/html; charset=utf-8' : null) },
    text: () => Promise.resolve(opts.body)
  }
}

describe('web_fetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('converts HTML to markdown', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse({ body: '<h1>Title</h1><p>Hi</p>' }) as never)
    const t = makeWebFetch()
    const out = await t.invoke({ url: 'https://example.com' })
    expect(out).toMatch(/Title/)
    expect(out).toMatch(/Hi/)
    expect(out).not.toContain('<')
  })

  it('returns text format verbatim for non-HTML', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse({ contentType: 'text/plain', body: 'plain text' }) as never)
    const t = makeWebFetch()
    const out = await t.invoke({ url: 'https://example.com', format: 'text' })
    expect(out).toBe('plain text')
  })

  it('reports non-2xx as failure', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse({ ok: false, status: 404, statusText: 'Not Found', body: '' }) as never)
    const t = makeWebFetch()
    const out = await t.invoke({ url: 'https://example.com' })
    expect(out).toMatch(/HTTP 404/)
  })

  it('maps an aborted request to a timeout message', async () => {
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    vi.mocked(globalThis.fetch).mockRejectedValue(abortError as never)
    const t = makeWebFetch()
    const out = await t.invoke({ url: 'https://example.com' })
    expect(out).toMatch(/timed out/)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/agent/tools/web.test.ts`
Expected: FAIL — `makeWebFetch is not a function`。

- [ ] **Step 4: 实现 web_fetch**

创建 `src/main/agent/tools/web.ts`：

```ts
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import TurndownService from 'turndown'

const MAX_LEN = 20000
const TIMEOUT_MS = 15000

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n…[truncated]' : s
}

export const makeWebFetch = () =>
  tool(
    async ({ url, format, maxLength }) => {
      const max = maxLength ?? MAX_LEN
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          redirect: 'follow',
          headers: { 'User-Agent': 'LangChainAgentDesktop/0.1 (+desktop code agent)' }
        })
        if (!res.ok) {
          return `Request failed: HTTP ${res.status} ${res.statusText}`
        }
        const body = await res.text()
        const type = res.headers.get('content-type') ?? ''
        if (format === 'text' || !type.includes('html')) {
          return clip(body, max)
        }
        const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
        return clip(td.turndown(body), max)
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          return `Request timed out after ${TIMEOUT_MS / 1000}s`
        }
        return `Request failed: ${e instanceof Error ? e.message : String(e)}`
      } finally {
        clearTimeout(timer)
      }
    },
    {
      name: 'web_fetch',
      description:
        'Fetch a URL and return its content as markdown (HTML pages) or plain text. Use to read a specific page or doc. 15s timeout; output capped at 20k chars by default.',
      schema: z.object({
        url: z.string().url(),
        format: z.enum(['markdown', 'text']).optional().describe('Output format; defaults to markdown for HTML'),
        maxLength: z.number().int().positive().optional()
      })
    }
  )
```

- [ ] **Step 5: 注册 web_fetch**

更新 `src/main/agent/tools/index.ts`：

```ts
import { makeReadFile, makeWriteFile, makeEditFile, makeListDirectory, makeCreateDirectory, makeMoveFile, makeDeleteFile } from './fileSystem'
import { makeGlob, makeGrep } from './search'
import { makeWebFetch } from './web'
import { makeRunShellCommand } from './shell'

export function getTools(workspace: string) {
  return [
    makeReadFile(workspace),
    makeWriteFile(workspace),
    makeEditFile(workspace),
    makeListDirectory(workspace),
    makeCreateDirectory(workspace),
    makeMoveFile(workspace),
    makeDeleteFile(workspace),
    makeGlob(workspace),
    makeGrep(workspace),
    makeWebFetch(),
    makeRunShellCommand(workspace)
  ]
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/agent/tools/web.test.ts`
Expected: PASS（4 个用例）。

- [ ] **Step 7: 提交**

```bash
git add package.json pnpm-lock.yaml src/main/agent/tools/web.ts src/main/agent/tools/web.test.ts src/main/agent/tools/index.ts
git commit -m "feat: add web_fetch tool (HTML to markdown)"
```

---

### Task 7: web_search（Tavily）+ env + 提示词

**Files:**
- Modify: `src/main/agent/tools/web.ts`（追加 `makeWebSearch`）
- Modify: `src/main/agent/tools/index.ts`
- Modify: `.env.example`
- Modify: `src/main/agent/prompts.ts`
- Test: `src/main/agent/tools/web.test.ts`（追加 describe）

- [ ] **Step 1: 写失败测试**

在 `src/main/agent/tools/web.test.ts` 顶部 import 加 `makeWebSearch`，并新增 describe：

```ts
import { makeWebFetch, makeWebSearch } from './web'
```

末尾追加：

```ts
describe('web_search', () => {
  const prevKey = process.env['TAVILY_API_KEY']
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    if (prevKey === undefined) delete process.env['TAVILY_API_KEY']
    else process.env['TAVILY_API_KEY'] = prevKey
  })

  it('returns formatted results', async () => {
    process.env['TAVILY_API_KEY'] = 'test-key'
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ results: [{ title: 'T1', url: 'https://a', content: 'Snip A' }] })
    } as never)
    const t = makeWebSearch()
    const out = await t.invoke({ query: 'hello' })
    expect(out).toContain('T1')
    expect(out).toContain('https://a')
    expect(out).toContain('Snip A')
  })

  it('reports missing API key', async () => {
    delete process.env['TAVILY_API_KEY']
    const t = makeWebSearch()
    const out = await t.invoke({ query: 'hello' })
    expect(out).toMatch(/TAVILY_API_KEY/)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('reports non-2xx', async () => {
    process.env['TAVILY_API_KEY'] = 'test-key'
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', json: () => Promise.resolve({}) } as never)
    const t = makeWebSearch()
    const out = await t.invoke({ query: 'hello' })
    expect(out).toMatch(/HTTP 401/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/agent/tools/web.test.ts -t web_search`
Expected: FAIL — `makeWebSearch is not a function`。

- [ ] **Step 3: 实现 makeWebSearch**

在 `src/main/agent/tools/web.ts` 末尾追加：

```ts
export const makeWebSearch = () =>
  tool(
    async ({ query, maxResults }) => {
      const apiKey = process.env['TAVILY_API_KEY']
      if (!apiKey) {
        return 'web_search is not configured: set TAVILY_API_KEY in .env'
      }
      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, max_results: maxResults ?? 5, api_key: apiKey })
        })
        if (!res.ok) {
          return `Search failed: HTTP ${res.status} ${res.statusText}`
        }
        const data = (await res.json()) as {
          results?: Array<{ title?: string; url?: string; content?: string }>
        }
        const results = data.results ?? []
        if (results.length === 0) return 'No results found'
        return results
          .map((r, i) => `${i + 1}. ${r.title ?? '(no title)'}\n${r.url ?? ''}\n${(r.content ?? '').trim()}`)
          .join('\n\n')
      } catch (e) {
        return `Search failed: ${e instanceof Error ? e.message : String(e)}`
      }
    },
    {
      name: 'web_search',
      description:
        'Search the web with Tavily and return ranked results (title, url, snippet). Use when the answer may need up-to-date or external information.',
      schema: z.object({
        query: z.string(),
        maxResults: z.number().int().min(1).max(10).optional()
      })
    }
  )
```

- [ ] **Step 4: 注册 web_search**

更新 `src/main/agent/tools/index.ts` 的 import 与数组，加入 `makeWebSearch`：

```ts
import { makeWebFetch, makeWebSearch } from './web'
```

在数组里 `makeWebFetch()` 之后加 `makeWebSearch()`。

- [ ] **Step 5: 更新 .env.example**

在 `.env.example` 末尾追加：

```
# --- Tavily — required for web_search tool ---
# Get your key at https://tavily.com/
TAVILY_API_KEY=tvly-xxxxxxxx
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/agent/tools/web.test.ts`
Expected: PASS（web_fetch 4 个 + web_search 3 个）。

- [ ] **Step 7: 更新 prompt（联网指引）**

在 `prompts.ts` 的 Operating principles 里，把：

```
- Verify your work. After changes, run the relevant build / typecheck / test command when feasible.
```

后面插入一行：

```
- Use the web when needed. Call web_search when information may be stale or external, and web_fetch to read a specific URL.
```

- [ ] **Step 8: 提交**

```bash
git add src/main/agent/tools/web.ts src/main/agent/tools/web.test.ts src/main/agent/tools/index.ts .env.example src/main/agent/prompts.ts
git commit -m "feat: add web_search tool (Tavily)"
```

---

### Task 8: 阶段 2 验证

- [ ] **Step 1: 类型检查**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 全部通过。

- [ ] **Step 3: 手动冒烟**

在 `.env` 设置 `TAVILY_API_KEY`，`pnpm dev`，让 agent 用 `web_search` 查信息、用 `web_fetch` 读某个 URL。无 key 时确认 agent 收到配置提示。

---

## Phase 3 — 任务规划 + UI

### Task 9: shared 类型（TodoItem + todo-update）

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: 扩展类型**

在 `src/shared/types.ts` 的 `AgentEvent` 之前新增 `TodoItem`，并在联合类型中加入 `todo-update`：

```ts
export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type AgentEvent =
  | { type: 'message'; content: string }
  | { type: 'message-delta'; delta: string }
  | { type: 'tool-start'; tool: string; input: unknown }
  | { type: 'tool-end'; tool: string; output: string }
  | { type: 'todo-update'; todos: TodoItem[] }
  | { type: 'error'; message: string }
  | { type: 'done' }
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 通过（此时还没有代码消费 `todo-update`，但类型已就位）。

- [ ] **Step 3: 提交**

```bash
git add src/shared/types.ts
git commit -m "feat: add TodoItem type and todo-update event"
```

---

### Task 10: todo_write 工具 + getTools(emit) + runAgent 接线

**Files:**
- Create: `src/main/agent/tools/todo.ts`
- Modify: `src/main/agent/tools/index.ts`
- Modify: `src/main/agent/index.ts`
- Test: `src/main/agent/tools/todo.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/main/agent/tools/todo.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import type { AgentEvent } from '@shared/types'
import { makeTodoWrite } from './todo'

describe('todo_write', () => {
  it('emits a todo-update event with the provided list', async () => {
    const emitted: AgentEvent[] = []
    const t = makeTodoWrite(e => emitted.push(e))
    const out = await t.invoke({
      todos: [
        { id: '1', content: 'first', status: 'pending' },
        { id: '2', content: 'second', status: 'in_progress' }
      ]
    })
    expect(out).toBe('Updated 2 todos')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      type: 'todo-update',
      todos: [
        { id: '1', content: 'first', status: 'pending' },
        { id: '2', content: 'second', status: 'in_progress' }
      ]
    })
  })

  it('handles an empty list', async () => {
    const emit = vi.fn()
    const t = makeTodoWrite(emit)
    const out = await t.invoke({ todos: [] })
    expect(out).toBe('Updated 0 todos')
    expect(emit).toHaveBeenCalledWith({ type: 'todo-update', todos: [] })
  })

  it('rejects an invalid status', async () => {
    const t = makeTodoWrite(() => {})
    await expect(
      t.invoke({ todos: [{ id: '1', content: 'x', status: 'bogus' as unknown as 'pending' }] })
    ).rejects.toThrow()
  })
})
```

> 注：`@shared/types` 是 `import type`，编译期擦除，vitest 运行期不会触发别名解析，无需 vitest 别名配置。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/agent/tools/todo.test.ts`
Expected: FAIL — `makeTodoWrite is not a function`。

- [ ] **Step 3: 实现 todo_write**

创建 `src/main/agent/tools/todo.ts`：

```ts
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { AgentEvent } from '@shared/types'

export const makeTodoWrite = (emit: (event: AgentEvent) => void) =>
  tool(
    async ({ todos }) => {
      emit({ type: 'todo-update', todos })
      return `Updated ${todos.length} todo${todos.length === 1 ? '' : 's'}`
    },
    {
      name: 'todo_write',
      description:
        'Create or update the task list for the current run. Pass the FULL list each call (it replaces the previous list). Use for multi-step tasks: plan upfront, keep exactly one item in_progress while working on it, mark items completed when done.',
      schema: z.object({
        todos: z
          .array(
            z.object({
              id: z.string(),
              content: z.string(),
              status: z.enum(['pending', 'in_progress', 'completed'])
            })
          )
          .describe('Full task list; replaces the previous list on every call')
      })
    }
  )
```

- [ ] **Step 4: 改 getTools 签名为 (workspace, emit)**

更新 `src/main/agent/tools/index.ts`：

```ts
import type { AgentEvent } from '@shared/types'
import { makeReadFile, makeWriteFile, makeEditFile, makeListDirectory, makeCreateDirectory, makeMoveFile, makeDeleteFile } from './fileSystem'
import { makeGlob, makeGrep } from './search'
import { makeWebFetch, makeWebSearch } from './web'
import { makeTodoWrite } from './todo'
import { makeRunShellCommand } from './shell'

export function getTools(workspace: string, emit: (event: AgentEvent) => void) {
  return [
    makeReadFile(workspace),
    makeWriteFile(workspace),
    makeEditFile(workspace),
    makeListDirectory(workspace),
    makeCreateDirectory(workspace),
    makeMoveFile(workspace),
    makeDeleteFile(workspace),
    makeGlob(workspace),
    makeGrep(workspace),
    makeWebFetch(),
    makeWebSearch(),
    makeTodoWrite(emit),
    makeRunShellCommand(workspace)
  ]
}
```

- [ ] **Step 5: runAgent 传入 onEvent**

在 `src/main/agent/index.ts` 中，把：

```ts
const tools = getTools(workspace)
```

改为：

```ts
const tools = getTools(workspace, onEvent)
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/agent/tools/todo.test.ts`
Expected: PASS（3 个用例）。再跑 `pnpm typecheck` 确认接线无误。

- [ ] **Step 7: 提交**

```bash
git add src/main/agent/tools/todo.ts src/main/agent/tools/todo.test.ts src/main/agent/tools/index.ts src/main/agent/index.ts
git commit -m "feat: add todo_write tool with emit callback"
```

---

### Task 11: store 处理 todo-update

**Files:**
- Modify: `src/renderer/src/stores/chat.ts`

- [ ] **Step 1: 引入 TodoItem 类型**

把 `src/renderer/src/stores/chat.ts` 顶部 import 改为：

```ts
import type { AgentEvent, FileAttachment, ModelOption, TodoItem } from '@shared/types'
```

- [ ] **Step 2: 加 todos 状态字段**

在 `ChatState` 接口里 `modelId: string` 之后新增：

```ts
  todos: TodoItem[]
```

在 `create<ChatState>(...)` 的初始状态里 `modelId: ''` 之后新增：

```ts
  todos: [],
```

- [ ] **Step 3: send 开始时清空 todos**

把 `send` 内的：

```ts
    set(s => ({ messages: [...s.messages, userMsg, assistantMsg], isRunning: true }))
```

改为：

```ts
    set(s => ({ messages: [...s.messages, userMsg, assistantMsg], isRunning: true, todos: [] }))
```

- [ ] **Step 4: clear 也清空 todos**

把：

```ts
  clear: () => set({ messages: [] }),
```

改为：

```ts
  clear: () => set({ messages: [], todos: [] }),
```

- [ ] **Step 5: 加 todo-update 事件分支**

在 `onEvent` 的 switch 内、`case 'tool-start'` 之前插入：

```ts
        case 'todo-update':
          set({ todos: event.todos })
          break
```

- [ ] **Step 6: 类型检查**

Run: `pnpm typecheck:web`
Expected: 通过。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/src/stores/chat.ts
git commit -m "feat: wire todo-update event into chat store"
```

---

### Task 12: TodoList 组件 + 样式 + 渲染

**Files:**
- Create: `src/renderer/src/components/TodoList.tsx`
- Modify: `src/renderer/src/components/ChatPanel.tsx`
- Modify: `src/renderer/src/index.css`
- Modify: `src/main/agent/prompts.ts`

- [ ] **Step 1: 写 TodoList 组件**

创建 `src/renderer/src/components/TodoList.tsx`：

```tsx
import type { TodoItem } from '@shared/types'

export function TodoList({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null

  const mark = (status: TodoItem['status']): string => {
    if (status === 'completed') return '✓'
    if (status === 'in_progress') return '▶'
    return '○'
  }

  return (
    <div className="todos" aria-live="polite">
      <div className="todos__title">Tasks</div>
      <ul className="todos__list">
        {todos.map(t => (
          <li key={t.id} className={`todos__item todos__item--${t.status}`}>
            <span className="todos__mark">{mark(t.status)}</span>
            <span className="todos__content">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 2: 在 ChatPanel 渲染**

把 `src/renderer/src/components/ChatPanel.tsx` 改为：

```tsx
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { TodoList } from './TodoList'
import { useChatStore } from '../stores/chat'

export function ChatPanel() {
  const workspace = useChatStore(s => s.workspace)
  const messages = useChatStore(s => s.messages)
  const todos = useChatStore(s => s.todos)
  const isRunning = useChatStore(s => s.isRunning)

  return (
    <div className="chat">
      <header className="chat__header">
        <h1>Chat</h1>
        {workspace ? (
          <span className="chat__hint">● Workspace ready</span>
        ) : (
          <span className="chat__hint chat__hint--warn">○ Select a workspace to begin</span>
        )}
      </header>
      <MessageList messages={messages} />
      <TodoList todos={todos} />
      <MessageInput disabled={!workspace || isRunning} />
    </div>
  )
}
```

- [ ] **Step 3: 加 CSS**

在 `src/renderer/src/index.css` 末尾追加：

```css
/* ---------- Todos ---------- */
.todos {
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
  padding: 12px 24px;
}

.todos__title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.todos__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.todos__item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.todos__mark {
  width: 14px;
  flex-shrink: 0;
  text-align: center;
}

.todos__item--completed {
  color: var(--text-muted);
  text-decoration: line-through;
}

.todos__item--completed .todos__mark {
  color: var(--success);
}

.todos__item--in_progress .todos__mark {
  color: var(--accent);
}

.todos__item--in_progress .todos__content {
  font-weight: 600;
}
```

- [ ] **Step 4: 更新 prompt（规划指引）**

在 `prompts.ts` 的 Operating principles 最前面插入规划原则，把开头改为：

```
Operating principles:
- Plan multi-step work. For non-trivial tasks, call todo_write first with the full plan, keep exactly one item in_progress while you work, and mark items completed as you finish them.
- Explore before editing. Use glob to find files by name and grep to search contents; read files and list directories to build a mental model before changing anything.
```

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/components/TodoList.tsx src/renderer/src/components/ChatPanel.tsx src/renderer/src/index.css src/main/agent/prompts.ts
git commit -m "feat: render live todo list in chat UI"
```

---

### Task 13: 阶段 3 验证

- [ ] **Step 1: 类型检查**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 全部通过。

- [ ] **Step 3: 手动 UI 验证**

Run: `pnpm dev`，给 agent 一个多步任务（如「在新建的 demo 目录里建一个含两文件的 Node 项目并跑一次 npm init」）。确认：
- Tasks 卡片出现并随 `todo_write` 调用实时刷新（pending ▶ in_progress → completed ✓）。
- 新一次发送时旧任务清空。
- 既有聊天流（消息/工具/流式）无回归。

---

## 收尾

- [ ] 全量 `pnpm typecheck && pnpm test` 通过。
- [ ] `git log` 确认三阶段各成一至多个 feat 提交，工作树干净。
- [ ] （可选）更新 CLAUDE.md 的工具清单与 `getTools(workspace, emit)` 签名描述。
