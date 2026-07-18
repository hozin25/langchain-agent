# 面试竞争力差距分析

> 分析日期：2026-07-17
> 目标：评估 langchain-agent-desktop 作为面试作品项目的竞争力，识别差距和改进方向

## 项目概述

**langchain-agent-desktop** v0.1.0 — 基于 Electron + React + TypeScript + LangChain.js 的桌面 AI 代码 agent。

核心能力：用户选择工作区文件夹，用自然语言聊天，让 agent 读/写/搜索文件、执行 shell 命令。

## 当前亮点（面试中可讲的点）

### 架构与工程

- **三进程 Electron 架构**：Main / Preload / Renderer 严格分离
- **安全最佳实践**：`contextIsolation: true`，`nodeIntegration: false`，preload 通过 `contextBridge` 暴露最小 API
- **路径沙箱**：所有文件系统工具通过 `resolveInWorkspace()` 校验，拒绝 `..` 和绝对路径逃逸
- **Proxy 支持**：主进程 HTTP 请求通过 undici `ProxyAgent` 走代理，兼容国内网络环境
- **TypeScript strict mode**：web 项目开启 strict + noUnusedLocals + noUnusedParameters

### Agent 能力

- **LangGraph ReAct agent**：基于 `@langchain/langgraph` 的 `createReactAgent`，非简单 wrapper
- **13 个工具**：文件 CRUD（7个）+ glob/grep 搜索（2个）+ web_fetch/web_search（2个）+ shell + todo_write
- **上下文窗口监控**：实时估算 token 用量并在 UI 中以进度条展示
- **中止/停止**：`AbortController` 机制，支持用户中断正在运行的 agent
- **文件附件**：支持选择文本/代码文件作为上下文附加到消息中
- **Todo 追踪**：agent 可创建和更新任务列表，UI 实时反映

### UI/UX

- **Markdown 渲染**：react-markdown + remark-gfm，支持表格、代码块、引用等
- **Thinking 动画**：agent 思考时显示跳动圆点动画
- **模型切换**：下拉选择不同模型
- **流式光标**：assistant 输出未完成时显示闪烁光标

### 数据持久化

- **会话管理**：按 workspace 存储/加载/删除对话，JSON 文件持久化
- **上次工作区记忆**：重启后自动恢复上次打开的工作区

### 测试

- **47 个测试全部通过**：覆盖文件系统工具、搜索工具、web 工具、todo 工具、会话存储

---

## 差距分析

### P0 — 严重影响面试竞争力（必须修）

| #   | 问题                     | 现状                                                                                                           | 为什么重要                                                                                                                                                          | 改进方向                                                                                                                                                      |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **无 MCP 支持**          | 13 个工具全部在 `tools/index.ts` 中硬编码注册                                                                  | 2025-2026 年 MCP（Model Context Protocol）是 AI agent 工具扩展的行业标准。面试官会直接问"为什么不用 MCP？"。不支持 MCP 意味着工具集不可扩展，用户无法接入自己的工具 | 接入 `@modelcontextprotocol/sdk`，让 agent 能连接 MCP server，同时保留内置工具作为 fallback                                                                   |
| 2   | **无 Agent 集成测试**    | `runAgent()` 完全没有测试覆盖。47 个测试全部是工具单元测试和 store 单元测试                                    | 面试官会问"你怎么知道 agent loop 的行为是正确的？"。没有集成测试意味着 ReAct loop 的推理链路、tool call 分发、事件发射、错误处理都是未经验证的                      | 用 mock LLM 写出确定性响应，测试完整 ReAct loop：message → tool-start → tool-end → done；错误路径；interrupted 路径；recursion limit 路径                     |
| 3   | **只支持国内模型**       | 虽安装了 `@langchain/anthropic` 但未接入。实际只支持 GLM 和 DeepSeek，且 `createLlm()` 硬编码返回 `ChatOpenAI` | 面试时如果对方用 OpenAI/Claude API，你连演示都跑不了。`@langchain/anthropic` 已安装却未接入，面试官会觉得你没做完                                                   | 接入 Anthropic Claude（`ChatAnthropic`）和 OpenAI（`ChatOpenAI` 直接连 api.openai.com），在 `llm.ts` 中按 provider 分发                                       |
| 4   | **无流式输出**           | `streaming: false`，CLAUDE.md 注释说明是因为 GLM-5.x reasoning model 的 chunk aggregation bug                  | 一款"AI 对话工具"不能流式输出，面试官第一反应是"有 bug 没修"。虽然 CLAUDE.md 写明了原因，但面试中不太可能让你解释这么细                                             | 给不同 provider 分别处理：非 reasoning model 开启 streaming；或者修 GLM 的 post-processing 逻辑处理 reasoning 模型的特殊 chunk 格式                           |
| 5   | **无 Human-in-the-loop** | `run_shell_command` 和 `delete_file` 等危险操作没有任何用户确认步骤，agent 直接执行                            | 安全问题。面试官会问"用户怎么防止 agent 删错文件或执行危险命令？"。没有审批流程的 agent 在生产环境不可用                                                            | 增加 tool call 拦截机制：对 `run_shell_command`、`delete_file`、`write_file`（覆盖）等操作，先发 `tool-approval-required` 事件给 renderer，等用户确认后再执行 |

### P1 — 明显不足（应该有）

| #   | 问题                      | 现状                                                                                     | 改进方向                                                                                                                                        |
| --- | ------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | **无代码高亮**            | 代码块使用纯文本 `<pre><code>`，无 syntax highlighting                                   | 集成 `highlight.js` 或 `prism.js`，在 `react-markdown` 的 `components` 中自定义 `code` 渲染                                                     |
| 7   | **无 Diff 视图**          | agent 编辑文件后只返回 "Edited xxx"，用户看不到具体改了什么                              | 在 `tool-end` 事件中携带 old/new text，UI 中用 diff 组件（如 `react-diff-viewer`）展示                                                          |
| 8   | **无 RAG / 向量存储**     | 只能通过 `grep` 做正则搜索，无法做语义搜索                                               | 集成 `@langchain/community` 的 vectorstore，支持索引项目文件做语义搜索。可选方案：用 `sqlite-vss` 做本地向量库或接外部 embedding API            |
| 9   | **无 Tracing / 可观测性** | agent 运行仅在控制台打 `console.log`，无结构化 trace                                     | 接入 LangSmith 或 LangFuse 做 agent run tracing，面试中可以展示完整的调用链路                                                                   |
| 10  | **React 组件无测试**      | Zustand store、5 个组件（ChatPanel、MessageList、MessageInput、Sidebar、TodoList）0 测试 | 用 `@testing-library/react` + `vitest` 写组件测试，覆盖消息渲染、输入提交、工具状态转换                                                         |
| 11  | **无 E2E 测试**           | 整个 Electron 应用没有任何端到端测试                                                     | 用 Playwright + `electron` 做 E2E，覆盖：启动应用 → 选择工作区 → 发送消息 → 验证回复 → 切换会话。这是面试中区分"会写测试"和"真正会测试"的分界线 |
| 12  | **无 CI/CD**              | 无 GitHub Actions 或其他 CI 配置                                                         | 增加 CI pipeline：typecheck → lint → test → build → package。PR 上有绿色 check mark 本身就是专业度的体现                                        |

### P2 — 锦上添花（有条件做）

| #   | 问题                            | 现状                                        | 改进方向                                                                                |
| --- | ------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| 13  | **无结构化日志**                | 全是 `console.log`，无日志级别、无文件输出  | 用 `pino` 或 `winston` 做结构化日志，区分 debug/info/warn/error，输出到文件方便排查问题 |
| 14  | **无 Error Boundary**           | React renderer 无错误边界，组件崩溃可能白屏 | 用 React Error Boundary 包裹聊天面板和侧边栏，崩溃时显示回退 UI + 重试按钮              |
| 15  | **无多模态支持**                | 不支持图片输入，VLM 模型无法发挥能力        | 文件附件支持图片，消息内容使用 `ContentBlock[]`（文本 + 图片 URL）                      |
| 16  | **无消息编辑/分支**             | 发出去的消息不能编辑后重发                  | 支持编辑已发送的用户消息，重新运行得到新分支；保留原始消息历史                          |
| 17  | **无键盘快捷键**                | 除了 Enter 发送，没有其他快捷键             | 增加：`Ctrl+K` 聚焦输入框，`Ctrl+L` 清空对话，`Ctrl+Shift+N` 新会话                     |
| 18  | **无拖拽文件附件**              | 只能通过按钮选择文件                        | 聊天区域和输入框支持拖拽文件添加附件                                                    |
| 19  | **无会话导出**                  | 无法导出对话                                | 支持导出为 Markdown、JSON、PDF                                                          |
| 20  | **无主题切换**                  | 仅暗色模式，无亮色模式                      | 增加亮色/暗色主题切换，通过 CSS 变量实现                                                |
| 21  | **无 i18n**                     | 中英文 UI 文本混用                          | 用 `react-i18next` 做国际化，面试时提到国际化意识是加分项                               |
| 22  | **应用图标缺失**                | `resources/` 目录为空，打包后无图标         | 设计应用图标，放到 `resources/` 并在 `electron-builder.yml` 中配置                      |
| 23  | **无 CHANGELOG / CONTRIBUTING** | 无变更日志和贡献指南                        | 添加 `CHANGELOG.md` 和 `CONTRIBUTING.md`，展示开源项目维护规范                          |
| 24  | **无 Auto-update**              | 打包后无法自动更新                          | 接入 `electron-updater`，配合 GitHub Releases 做自动更新                                |
| 25  | **无崩溃报告**                  | 主进程崩溃无上报                            | 接入 `electron-crash-reporter` 或 Sentry                                                |

---

## 改进路线图建议

### 第一阶段（2-3 周）：修 P0，让项目能拿出手

```
Week 1-2:  修复 streaming + 接入 Claude/OpenAI + MCP 支持
Week 2-3:  Human-in-the-loop + Agent 集成测试
```

### 第二阶段（2-3 周）：补 P1，让项目看起来专业

```
Week 4:    代码高亮 + Diff 视图 + Tracing
Week 5-6:  React 组件测试 + E2E 测试 + CI/CD
Week 7:    RAG / 向量存储
```

### 第三阶段（按需）：做 P2，让项目脱颖而出

根据面试目标公司/岗位选择性地做 3-5 项 P2 改进。

---

## 参考数据

- 当前代码规模：~40 个源文件，~3,500 行代码
- 测试：47 个测试，全过，覆盖率估计 30-40%
- 依赖：Electron 43 + React 19 + LangChain.js（`@langchain/core` 1.2 + `@langchain/langgraph` 1.4）
- 构建工具：electron-vite 5 + Vite 7 + TypeScript 7
