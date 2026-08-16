import { describe, it, expect } from 'vitest'
import { snapshotLabel } from './snapshot'
import type { SnapshotEntry } from '@shared/types'

const mk = (over: Partial<SnapshotEntry>): SnapshotEntry => ({
  id: 'snap_x',
  sha: 'abc123',
  workspace: 'D:/ws',
  conversationId: 'c1',
  createdAt: 0,
  ...over
})

describe('snapshotLabel', () => {
  it('已知工具名 → 中文标签 + 目标路径', () => {
    expect(
      snapshotLabel(mk({ toolName: 'edit_file', filePath: 'src/app.js' }))
    ).toBe('编辑文件 src/app.js')
    expect(snapshotLabel(mk({ toolName: 'write_file', filePath: 'a.md' }))).toBe(
      '写入文件 a.md'
    )
  })

  it('无 filePath 时仅显示工具标签(旧 index.json 条目兼容)', () => {
    expect(snapshotLabel(mk({ toolName: 'edit_file' }))).toBe('编辑文件')
  })

  it('move_file 用 source 作路径', () => {
    expect(
      snapshotLabel(mk({ toolName: 'move_file', filePath: 'old/x.ts' }))
    ).toBe('移动文件 old/x.ts')
  })

  it('未知工具名回退原样(带路径)', () => {
    expect(snapshotLabel(mk({ toolName: 'custom_tool', filePath: 'p' }))).toBe(
      'custom_tool p'
    )
    expect(snapshotLabel(mk({ toolName: 'custom_tool' }))).toBe('custom_tool')
  })

  it('无 toolName → turnLabel 回退链', () => {
    expect(snapshotLabel(mk({ turnLabel: 'turn-start' }))).toBe('回合开始')
    expect(snapshotLabel(mk({ turnLabel: 'write' }))).toBe('write')
    expect(snapshotLabel(mk({}))).toBe('快照')
  })
})
