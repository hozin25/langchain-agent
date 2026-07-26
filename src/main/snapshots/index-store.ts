import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { workspaceHash } from './shadowRepo'
import type { SnapshotEntry } from '@shared/types'

// 快照 timeline 索引:落在 <userDataDir>/agent-snapshots/<workspaceHash>/index.json,
// 与 shadow repo 的 .git 同目录。按 workspace scope(用 workspaceHash 隔离),每条
// SnapshotEntry 记录 sha + 触发上下文(conversationId/messageId/toolName/agentId)供
// 前端 timeline 渲染与过滤。写法参照 conversations/store.ts 的 read-modify-write。
//
// workspaceHash 是 16 位 hex(SAFE_ID 友好),无需额外校验;但 entry.id 在前端当 key,
// 仍走 conversations 一致的 SAFE_ID 校验防御。

const SAFE_ID = /^[a-zA-Z0-9_-]+$/

export interface SnapshotIndexStore {
  list(workspace: string): Promise<SnapshotEntry[]>
  add(entry: SnapshotEntry): Promise<void>
  clear(workspace: string): Promise<void>
}

export function createSnapshotIndexStore(userDataDir: string): SnapshotIndexStore {
  const root = (workspace: string): string =>
    join(userDataDir, 'agent-snapshots', workspaceHash(workspace))
  const indexPath = (workspace: string): string => join(root(workspace), 'index.json')

  async function readAll(workspace: string): Promise<SnapshotEntry[]> {
    try {
      const raw = await readFile(indexPath(workspace), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? (parsed as SnapshotEntry[]) : []
    } catch {
      return []
    }
  }

  async function writeAll(workspace: string, entries: SnapshotEntry[]): Promise<void> {
    await mkdir(root(workspace), { recursive: true })
    await writeFile(indexPath(workspace), JSON.stringify(entries, null, 2), 'utf8')
  }

  return {
    async list(workspace): Promise<SnapshotEntry[]> {
      return await readAll(workspace)
    },

    async add(entry): Promise<void> {
      if (!SAFE_ID.test(entry.id)) {
        throw new Error(`Invalid snapshot id: ${entry.id}`)
      }
      const all = await readAll(entry.workspace)
      all.push(entry)
      await writeAll(entry.workspace, all)
    },

    async clear(workspace): Promise<void> {
      await writeAll(workspace, [])
    }
  }
}
