import type { SnapshotEntry } from '@shared/types'
import { useChatStore } from '../stores/chat'
import { formatRelative } from '../utils/time'
import { snapshotLabel } from '../utils/snapshot'

// Phase 3 sidebar timeline: lists the current conversation's shadow-git
// snapshots (loaded by loadSnapshots on openConversation, appended live by
// snapshot-taken during a run). Each entry opens RestoreDialog via
// requestRestore. Disabled while a run or restore is in flight (restore refuses
// concurrent runs; see chat.ts). Only rendered when a conversation is open.
export function CheckpointTimeline() {
  const snapshots = useChatStore(s => s.snapshots)
  const currentConversationId = useChatStore(s => s.currentConversationId)
  const requestRestore = useChatStore(s => s.requestRestore)
  const isRunning = useChatStore(s => s.isRunning)
  const isRestoring = useChatStore(s => s.isRestoring)

  if (!currentConversationId) return null

  const ordered = [...snapshots].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <section className="sidebar__section sidebar__timeline">
      <div className="sidebar__label">快照时间线</div>
      <div className="timeline__list">
        {ordered.length === 0 ? (
          <div className="history__empty">本会话尚无快照。Agent 写文件时会自动建立快照。</div>
        ) : (
          ordered.map((s: SnapshotEntry) => (
            <button
              key={s.id}
              className="timeline__item"
              onClick={() => requestRestore(s.sha, snapshotLabel(s))}
              title={`回滚到:${snapshotLabel(s)} · ${new Date(s.createdAt).toLocaleString()}`}
              disabled={isRunning || isRestoring}
            >
              <span className="timeline__icon" aria-hidden>
                ⏪
              </span>
              <span className="timeline__body">
                <span className="timeline__label">{snapshotLabel(s)}</span>
                <span className="timeline__time">{formatRelative(s.createdAt)}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  )
}
