import { MemorySaver } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph'

// 进程内 checkpointer 单例,跨所有 conversation 共享,用 thread_id(= conversationId)
// 隔离。LangGraph 的 checkpointer 设计就是多 thread 共享一个 saver实例。
//
// 当前后端:MemorySaver(进程内,无持久化——Electron 退出即丢)。这意味着单次
// 会话内 agent 状态跨轮保留(append 契约),但崩溃/重启恢复要等持久化后端。
//
// 切 SqliteSaver 时只改这一处:getCheckpointer 返回
//   SqliteSaver.fromConnString(dbPath)   // dbPath = join(app.getPath('userData'), 'checkpoints.sqlite')
// 业务代码零改动(checkpoint 语义一致,probe-checkpointer.cjs 已验证 append /
// 撞限续跑 / deleteThread 三点对 SqliteSaver 同样成立)。SqliteSaver 需
// better-sqlite3 native + electron-rebuild + VS Build Tools 2022(本机暂缺,
// 见 plan Phase 2 Spike 结论)。
let saver: BaseCheckpointSaver | null = null

export function getCheckpointer(): BaseCheckpointSaver {
  if (!saver) saver = new MemorySaver()
  return saver
}
