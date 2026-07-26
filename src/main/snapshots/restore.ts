import { mkdir, readdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { resolveInWorkspace } from '../agent/tools/fileSystem'
import type { RestoreMode } from '@shared/types'
import type { ShadowRepo } from './shadowRepo'

// 安全 Restore —— 整个 Phase 3 最危险的环节。
//
// **核心原则(CLAUDE.md / 吸取 Cline #1213 删文件教训):绝不在用户 workspace 跑
// `git checkout`/`git reset`/`git clean`。** 用 shadow repo 的 `show`/`cat-file` 读出
// 快照内容,再用 Node fs API 拷贝回去。所有落盘路径过 resolveInWorkspace 沙箱校验,
// 拒绝任何逃逸 workspace 的路径。删除(full 模式)只针对非排除清单的普通文件,绝不
// 递归删 workspace 根。
//
// 模式:
//  - conservative(默认):只把 snapshot 里有的文件覆盖回去;workspace 里 snapshot 没有
//    的文件(用户新增)原样保留。
//  - full:额外删除 workspace 中存在但 snapshot 没有的文件(仅限非排除清单普通文件)。
//
// 恢复前先做 pre-restore snapshot(可逆):用户后悔能用这个 sha restore 回去。

export interface RestoreResult {
  preRestoreSha: string
  restoredFiles: number
  removedFiles: number
}

// 与 shadowRepo.ts 的 EXCLUDE_PATTERNS 对齐:full 模式删除「孤儿」文件时跳过这些目录,
// 否则 node_modules 等从未被快照的文件会全部被当孤儿删掉(灾难性)。
const EXCLUDE_DIRS = new Set(['node_modules', 'out', 'release', 'dist', 'build', '.git'])

export async function restoreToSnapshot(
  repo: ShadowRepo,
  workspace: string,
  sha: string,
  mode: RestoreMode
): Promise<RestoreResult> {
  // 1. pre-restore snapshot(可逆)。即便恢复失败,用户也能用这个 sha 回到恢复前状态。
  const preRestoreSha = await repo.snapshot('pre-restore')

  // 2. 把 snapshot 的每个文件读出来落盘(覆盖)。
  const files = await repo.listFiles(sha)
  for (const rel of files) {
    const buf = await repo.readFile(sha, rel)
    const full = resolveInWorkspace(workspace, rel) // 沙箱校验,拒绝逃逸路径
    await mkdir(dirname(full), { recursive: true }) // 父目录可能已被删,先建
    await writeFile(full, buf)
  }

  // 3. full 模式:删除 workspace 中存在但 snapshot 没有的普通文件(非排除清单)。
  let removedFiles = 0
  if (mode === 'full') {
    const snapSet = new Set(files)
    const orphans = await listWorkspaceFiles(workspace)
    for (const rel of orphans) {
      if (snapSet.has(rel)) continue
      const full = resolveInWorkspace(workspace, rel)
      await rm(full, { force: true })
      removedFiles++
    }
  }

  return { preRestoreSha, restoredFiles: files.length, removedFiles }
}

// 列 workspace 下所有普通文件(相对路径,forward-slash),跳过排除目录。full 模式用它
// 找「孤儿」。不递归 .git/node_modules 等;空目录留着无害(不删目录,只删文件)。
async function listWorkspaceFiles(workspace: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue
        await walk(join(dir, e.name))
      } else if (e.isFile()) {
        // 统一 forward-slash,与 git ls-tree 输出口径一致(Windows 上 relative 返回 \\)。
        const rel = relative(workspace, join(dir, e.name)).replace(/\\/g, '/')
        out.push(rel)
      }
    }
  }
  await walk(workspace)
  return out
}
