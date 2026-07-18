# Agent 工具集扩展设计

- 日期：2026-07-15
- 状态：已确认，待转入实现计划
- 范围：为桌面 code agent 补齐对标主流 agent（Claude Code / Cursor / Cline）的工具能力

## 1. 背景与目标

当前 `src/main/agent/tools/` 已有 6 个工具：`read_file`、`write_file`、`edit_file`、`list_directory`、`search_files`、`run_shell_command`。工具采用工厂函数 `makeXxx(workspace)` 模式，全部经 `resolveInWorkspace()`（`tools/fileSystem.ts`）做沙箱边界校验，运行结果经 `AgentEvent`（`shared/types.ts`）流式回传到 React 聊天 UI。

本设计在不破坏现有架构的前提下，新增/升级 8 个工具，覆盖四个能力方向：Web 联网、增强代码检索、补全文件操作、任务规划（含 UI 展示）。

## 2. 非目标（YAGNI）

- 不接入 MCP 服务端协议。
- 不做子 agent 分发。
- 不做浏览器自动化。
- 不做沙箱化的 Python/Node 代码执行（已有 `run_shell_command` 足够）。
- 不为破坏性操作引入 UI 确认往返（删除走回收站即可逆）。

## 3. 落地路线：三阶段按风险/依赖切分

| 阶段 | 内容                                                                    | 新依赖                     | 风险              |
| ---- | ----------------------------------------------------------------------- | -------------------------- | ----------------- |
| 1    | `glob` + `grep` 升级 + `create_directory` + `move_file` + `delete_file` | `trash`（ESM，见 §8 风险） | 低，纯本地        |
| 2    | `web_fetch` + `web_search`                                              | `turndown`                 | 中，联网 + 新 env |
| 3    | `todo_write` + `todo-update` 事件 + store + renderer 组件               | 无                         | 中，跨层改动      |

每阶段独立可验证、可提交，符合项目「单一 feat」的提交历史风格。

## 4. 跨层契约（三阶段共用）

### 4.1 `shared/types.ts`

新增 todo 类型，并为 `AgentEvent` 增加 `todo-update` 变体（阶段 3 才接线，类型先定）：

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

### 4.2 工具工厂签名

从 `getTools(workspace)` 改为 `getTools(workspace, emit)`，`emit: (e: AgentEvent) => void`。只有 `todo_write` 使用 `emit`，其余工具忽略。`runAgent`（`src/main/agent/index.ts`）把现有的 `onEvent` 作为 `emit` 传入。

todo 状态由此从工具内部直达 UI，同时保留阶段 1/2 工具沿用 `tool-start`/`tool-end` 通用事件。

## 5. 阶段 1：本地工具（零/低依赖）

### 5.1 `search.ts` 重构

抽出共享的 `walk()`、`IGNORE_DIRS`、glob 匹配逻辑，导出 `makeGlob` 与 `makeGrep`，移除旧的 `makeSearchFiles`。

- **`glob`**
  - schema：`{ pattern: string, path?: string }`（`pattern` 如 `**/*.ts`，`path` 默认 `'.'`）
  - 返回：匹配的相对路径列表，上限 500，跳过 `node_modules/.git/dist/out/build/.next/.cache/release`。

- **`grep`**（升级版 `search_files`）
  - schema：
    ```
    { pattern: string,              // 正则
      path?: string,                // 搜索子目录，默认 '.'
      glob?: string,                // 文件名 glob 过滤，如 '*.ts'
      outputMode?: 'content' | 'files_with_matches' | 'count',  // 默认 content
      contextBefore?: number,       // -B，默认 0
      contextAfter?: number,        // -A，默认 0
      caseInsensitive?: boolean,    // 默认 false
      multiline?: boolean,          // 默认 false
      headLimit?: number }          // 默认 100
    ```
  - 输出：
    - `content`：`rel/path:行号: 行内容`（含上下文行）
    - `files_with_matches`：仅路径
    - `count`：`rel/path:N`
  - 复用 `walk`。

### 5.2 `fileSystem.ts` 新增

- **`create_directory`** — `mkdir(full, { recursive: true })`。
- **`move_file`** — `rename(src, dst)`；两路径均过 `resolveInWorkspace`；目标存在则覆盖（直接执行策略）。
- **`delete_file`** — 解析路径后送 `trash` 库（回收站，可恢复）；路径受沙箱约束。

### 5.3 注册与提示词

`tools/index.ts` 注册新增的 5 个工具；`prompts.ts` 补一段工具说明（见 §7）。

## 6. 阶段 2：联网工具

- **`web_fetch`**
  - schema：`{ url: string, format?: 'markdown' | 'text'（默认 markdown）, maxLength?: number（默认 20000） }`
  - 实现：`fetch(url)` 带 UA + 15s `AbortController` 超时；HTML 用 `turndown` 转 markdown（无需 jsdom）；超长截断；非 2xx / 网络错 / 超时 → 返回错误字符串给 agent（不抛）。

- **`web_search`**
  - schema：`{ query: string, maxResults?: number（默认 5） }`
  - 实现：直连 Tavily REST `POST https://api.tavily.com/search`，body `{ query, max_results, api_key }`；返回 `title/url/content` 格式化列表；缺 `TAVILY_API_KEY` 时返回提示信息（让 agent 告知用户去配 key）。

- 依赖：新增 `turndown`；`.env.example` 增加 `TAVILY_API_KEY=xxxxxxxx`。

## 7. 阶段 3：任务规划 + UI

- **`todo_write`**
  - schema：`{ todos: Array<{ id: string, content: string, status: 'pending' | 'in_progress' | 'completed' }> }`
  - 全量替换语义（每次传完整当前列表，对标 Claude Code）。调用 `emit({ type: 'todo-update', todos })`，返回 `"Updated N todos"`。status 枚举由 zod 约束。

- **renderer store（`chat.ts`）** — 处理 `todo-update`：维护 `todos: TodoItem[]`；新 run 开始时清空。

- **UI** — 一张实时更新的「任务清单」卡片，随 `todo-update` 原地刷新状态（pending/in_progress/completed 不同标记）。具体贴在消息流的哪个位置，在写实现计划前读 `chat.ts` 与现有消息渲染组件后确定，沿用其样式。

- **`prompts.ts` 增补**：多步任务先用 `todo_write` 规划并随进度更新状态；信息可能过时用 `web_search`；读指定 URL 用 `web_fetch`；`delete_file` 走回收站可恢复。

## 8. 错误处理

- 所有新 fs 工具一律走 `resolveInWorkspace`，拒绝 `..` / 绝对路径逃逸。
- web 工具：网络/超时/非 2xx/缺 key → 返回可读字符串，绝不抛未捕获异常。
- `delete_file` 的 `trash` 失败 → 返回错误，不崩溃。
- `todo_write` 的 status 由 zod 校验。

## 9. 测试策略

项目当前零测试文件，本轮建立基线（vitest，AAA 结构，覆盖新工具核心逻辑）：

- `resolveInWorkspace` 逃逸拒绝（`..`、绝对路径）。
- `glob` 模式匹配 + 忽略目录。
- `grep` 三种 outputMode、上下文、大小写、headLimit。
- `create_directory`（recursive）、`move_file`（含覆盖）、`delete_file`（tmp 工作区 + trash）。
- `web_fetch`（mock `fetch`：成功/超时/非 2xx/截断）、`web_search`（mock `fetch`：解析/缺 key）。
- `todo_write`（mock `emit`，断言 `todo-update` 事件形状）。

## 10. 已知风险与缓解

- **`trash` 纯 ESM vs 主进程 externalize CJS 构建**：`package.json` 无 `"type": "module"`，主进程经 `externalizeDepsPlugin` 不打包、运行时 require。首选 `trash`；若构建/运行期报 ESM 导入错误，退回 Windows PowerShell 回收站 shellout（`package:win` 为 Windows 目标）。在阶段 1 实现时即验证。
- **版本锁**：CLAUDE.md 警告 vite/plugin-react/electron-vite 版本锚定。`turndown`、`trash` 不触碰该依赖图，风险低。
- **grep 引擎选纯 JS**：跨平台、不依赖 PATH 上有 `rg`；放弃 ripgrep 速度优势，换取零二进制依赖。

## 11. 阶段交付物清单

- 阶段 1：`tools/glob`/`grep`、`fileSystem` 新三工具、`index.ts` 注册、`prompts.ts` 更新、对应单测。
- 阶段 2：`tools/web.ts`（web_fetch + web_search）、`.env.example`、`prompts.ts` 更新、对应单测。
- 阶段 3：`shared/types.ts` 的 `todo-update` + `TodoItem`、`getTools(workspace, emit)`、`tools/todo.ts`、`runAgent` 接线、`chat.ts` store 处理、renderer 任务清单组件、`prompts.ts` 更新。
