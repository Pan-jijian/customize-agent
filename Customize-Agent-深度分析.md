# Customize Agent — 深度项目分析

## 一、一句话定位

**一个 Dogfooding（自举）的通用终端 AI Agent 开发框架 & 运行时。** 采用 pnpm Monorepo，含 7 个 packages + 1 个 CLI app。我（Customize Agent 自身）正在用它来分析它本身的源码——这就是 Dogfooding 的最佳证明。

---

## 二、架构全景

```
┌──────────────────────────────────────────────────────────────────┐
│  apps/cli/                                                        │
│  ├─ index.ts         CLI 入口 (Commander.js) · 70+ 工具注册       │
│  ├─ agent/executor.ts  AgentExecutor：主循环 · 流式渲染 · 折叠    │
│  ├─ agent/prompt.ts  系统提示词构建（含 CUSTOMIZE.md）            │
│  ├─ repl/repl.ts     REPL 交互循环 · 多模态输入 · 命令路由        │
│  ├─ tui/renderer.ts  终端渲染引擎（Markdown/思考链/表格/代码块）  │
│  └─ i18n/            国际化（中/英）                              │
├──────────────────────────────────────────────────────────────────┤
│  packages/                                                        │
│  ├─ engine/          编排大脑：Orchestrator · SubAgent · Context  │
│  ├─ llm/             LLM 抽象层：Provider · 流式 · 重试           │
│  ├─ tools/           工具执行层：BuiltinTools · Sandbox · Diff    │
│  ├─ search/          搜索层：ripgrep · LSP · 代码索引             │
│  ├─ memory/          会话记忆管理                                 │
│  ├─ runtime/         运行时：配置 · 模型注册 · 遥测 · 生命周期    │
│  └─ types/           零依赖类型契约层                             │
└──────────────────────────────────────────────────────────────────┘
```

---

## 三、各层深入分析

### 3.1 CLI 层（`apps/cli/src/index.ts`）

**入口职责**：参数解析 → 模型解析 → 工具注册 → AgentExecutor 创建 → REPL / 单次执行。

关键设计：

- **双模式**：`-p "task"` 单次执行，无参数进入 REPL 交互模式
- **计划模式**：`--plan` 只读探索，要求 `-p` 配合使用
- **模型回退链**：`ModelRegistry.resolve('action')` → 回退到第一个可用模型或未配置状态
- **MCP Server 子命令**：`customize-agent mcp-server` 启动 JSON-RPC stdio 服务器，对外暴露工具

**70+ 工具注册**在 `buildRegistry()` 中完成，分 5 大类：
- **文件操作**：read_file, write_file, edit_file, multi_edit, delete_file, move_file, copy_file, mkdir
- **搜索/浏览**：search, list_files, tree, repo_map, symbol_search, glob, dependency_graph
- **执行**：execute_command, run_background, check_command, stop_command
- **Git**：git_status, git_diff, git_log, git_stash, git_commit, git_apply_patch
- **外部能力**：web_search, web_fetch, download_file, export_*, mcp_*, plugin_*, checkpoint_*
- **LSP**（可选，需 LSP Manager）：lsp_definition, lsp_references, lsp_diagnostics
- **媒体处理**：ocr_image, transcribe_audio, video_metadata, extract_pdf_text, compress_image...

**`reg()` 辅助函数**：自动补全 `parameters.type: 'object'` 和 `additionalProperties: false`，大幅减少样板代码。

### 3.2 AgentExecutor（`apps/cli/src/agent/executor.ts`）

这是 **主循环的核心**，对标 Claude Code / Codex CLI 的 agent loop：

```
for round in 1..maxIterations:
  1. 注入排队的用户输入
  2. 上下文水位检查 → 按需自动压缩
  3. call LLM（流式或非流式）
  4. 解析 tool_calls
  5. 同类工具折叠渲染（read_file × 3, search × 2...）
  6. 权限/审批 → 执行工具
  7. ExecutionController.evaluate() 四层熔断检查
  8. 无 tool_calls → break
```

**流式渲染**的亮点：

- **思考链（Thinking）**：`extended thinking` 内容不入主输出，显示为实时旋转状态行（"Thinking… 12s · 3.2K tokens · 正在分析…"），支持 `Ctrl+O` 展开
- **代码围栏缓冲**：完整收集围栏内容后整体渲染，避免 ANSI 染色断裂
- **表格行缓冲**：按 `|` 开头的行收集，整表一次性渲染
- **工具折叠**：同类工具连续调用折叠为一行（如 `read_file × 4 · a.ts, b.ts, c.ts, d.ts · 23ms`）
- **write_file 特殊处理**：折叠行末尾显示 diff 摘要

### 3.3 Engine 层

#### 3.3.1 ExecutionController（`packages/engine/src/execution-controller.ts`）

四层熔断链，替代硬编码固定轮数限制：

```
L1 → LoopGuard (语义死循环) ─── 连续 N 轮相同 toolName+args+result → replan
L2 → BudgetManager (财务熔断) ─ 费用超 $5 → stop  
L3 → GoalManager (完成检测) ─── 启发式触发 + LLM 判定 → stop
L4 → CheckpointManager (人机检查) ─ 每 15 轮弹窗 → pause
```

**LoopGuard 的巧妙之处**：不仅比哈希值，还比对结果哈希，三要素（工具名 + 参数 + 结果）全部相同才判定死循环。FNV-1a 哈希确保低开销。

**GoalManager 的启发式前置过滤**：
- 只读工具永远不触发检测
- 里程碑事件（modify_file / git_commit / execute_command）触发检测
- 每 5 轮步长保底触发一次轻量检测
- 上下文压缩到 ~500 token（仅传任务目标 + 最新 git diff + 最后工具结果）

#### 3.3.2 ContextManager（`packages/engine/src/context-manager.ts`）

ADR-17 设计中，上下文管理是**来源无关的切块管道**：

```
ContextSource[] → collect() → 排序(priority) → TTL 过期淘汰 → 预算裁剪 → 注入
```

三级水位线：

| 水位 | 动作 |
|------|------|
| 60% | 控制台打印警告 |
| 75% | 轻量裁剪：旧 tool 结果截断到 200 字符，保留用户消息和 assistant 内容 |
| 85% | LLM 摘要压缩：调用模型生成结构化摘要替换旧消息，保留最近 4 轮 |

**尾部保留策略**：从末尾向前找最近的 assistant 消息作为边界，确保 tool 消息有前置 tool_calls，语义完整性。

#### 3.3.3 Orchestrator（`packages/engine/src/orchestration/orchestrator.ts`）

三种协作模式的多智能体编排：

| 模式 | 策略 | 适用场景 |
|------|------|----------|
| **Orchestrator** | DAG 拓扑排序，每步 1 Worker | 有依赖关系的多步骤任务 |
| **Pipeline** | 串行流水线 A→B→C，前步结果注入后步 | 分阶段处理管道 |
| **Swarm** | 同任务 × 3 Worker 并发，选最优结果 | 创造性/探索性任务 |

支持 SafeWorktree：修改文件的任务在 git worktree 中执行，成功则合并，失败则丢弃。

#### 3.3.4 Permissions（安全层）

权限三级：`allow` → `deny` → `ask`。基于 capability 矩阵（TOOL_CAPABILITY_MAP / ROLE_CAPABILITY_MAP），每个工具标记为所属 capability 类别（read_code / write_code / execute_command / network / git_operation / lsp_query）。

#### 3.3.5 Planner（`packages/engine/src/planner.ts`）

计划模式管理器，支持 `--plan` 只读探索，生成 ExecutionPlan，包含 Step[] 序列，每步有预估复杂度、依赖关系和只读标志。

#### 3.3.6 Subagent（`packages/engine/src/orchestration/subagent/`）

子智能体运行器：为每个子任务克隆 AgentExecutor 实例，注入独立角色 system prompt，受独立预算和上下文限制。Builtin 角色预设有 explorer / reviewer / tester / fixer。

### 3.4 LLM 层（`packages/llm/src/`）

厂商无关抽象（ADR-20）：

- **统一接口** `ILLMProvider`：chat() / chatStream() / countTokens() / capabilities
- **统一类型** `StreamChunk`：content / thinking / tool_call_preview / tool_call / reset / done / error
- **重试机制** `retry.ts`：指数退避 + 可重试错误分类
- **Provider 实现**：DeepSeek、Anthropic、OpenAI 兼容（`providers/` 目录）

### 3.5 Tools 层（`packages/tools/src/`）

| 模块 | 职责 |
|------|------|
| `toolkit.ts` | 文件 I/O、备份、终端命令执行 |
| `builtin-tools.ts` | 全部 70+ 内置工具的实现（~566 行） |
| `sandbox-executor.ts` | Docker 沙箱执行 Python/Node 代码 |
| `diff.ts` | SEARCH/REPLACE 块解析与精确替换 |
| `syntax-validator.ts` | 修改后语法验证 |
| `perception-gateway.ts` | 感知网关：文件检测、媒体识别 |
| `terminal-shell.ts` | PTY 终端 Shell 封装 |

**安全设计**：
- 路径安全：所有文件操作必须 resolve 到项目根目录以内
- 文件快照：write_file 前自动备份（~/.customize-agent/snapshots/）
- 二进制检测：read_file 双重检测（扩展名 + NUL 字节/非打印字符比例）

### 3.6 Search 层（`packages/search/src/`）

- `CodeSearcher.grep()`：封装 ripgrep，支持 maxResults 和 AbortSignal
- `LSPManager`：Language Server Protocol 集成（定义跳转、引用查找、诊断）
- `code-index/`：tree-sitter 代码索引（支持 JS/TS/Python/Rust/Go/Java/C/C++/Ruby/PHP）

### 3.7 Memory 层（`packages/memory/src/`）

会话记忆管理器：加载/保存会话历史、工作目录上下文、用户偏好。

### 3.8 Runtime 层（`packages/runtime/src/`）

- `ConfigStore`：~/.customize-agent/config.json 管理（语言、模型、API key）
- `ModelRegistry`：模型注册与回退链解析
- `AgentRuntime`：组件生命周期管理（init → health → shutdown）
- `Reconciliation`：配置一致性校验
- `Telemetry`：遥测事件收集

### 3.9 Types 层（`packages/types/src/`）

零外部依赖的跨包契约：

- **Message / LLMResponse / ToolCall / StreamChunk**：LLM 交互核心类型
- **FunctionDefinition**：厂商无关的 function calling 工具定义（JSON Schema 子集）
- **LifecycleAware / ComponentState**：组件生命周期接口（ADR-16）
- **Session / TaskState / Checkpoint**：任务状态机（15 种状态）
- **BINARY_EXTENSIONS**：已知二进制扩展名集合

---

## 四、设计哲学

### 4.1 Dogfooding 自举

项目使用自己的工具和引擎来开发自己。AgentExecutor 的循环中不仅调用 write_file / execute_command，还能通过 `read_file` / `search` / `lsp_definition` 分析自身源码。这种自举设计确保每个工具和引擎特性都在开发者自己的日常使用中被验证。

### 4.2 厂商无关

- LLM Provider 抽象：DeepSeek / Anthropic / OpenAI 统一接口
- Tool Definition：基于 JSON Schema 子集，可转换到 OpenAI/Anthropic/MCP 格式
- MCP 协议支持：对外作为 MCP Server，对内连接外部 MCP Server

### 4.3 安全熔断

| 层 | 机制 |
|----|------|
| 路径安全 | resolveSafe() 防目录穿越 |
| 权限矩阵 | allow/deny/ask 三级，基于 capability |
| 审批 UI | TUI 交互式审批对话框（↑↓ Enter Esc） |
| 财务熔断 | BudgetManager $5 硬上限 |
| 死循环检测 | LoopGuard 语义比对 |
| 读写分离 | Plan 模式只读；工具 requiresApproval 标记 |

### 4.4 渐进式复杂度

- 单次执行：`customize-agent -p "fix the bug"`
- REPL 交互：`customize-agent`（多轮对话）
- 计划模式：`customize-agent --plan -p "..."`（只读探索）
- MCP Server：`customize-agent mcp-server`（作为工具后端）
- 多智能体：Orchestrator → SubagentRunner（内部编排）

### 4.5 上下文工程

- 三级水位自动压缩（60% / 75% / 85%）
- 切块管道（收集 → 排序 → TTL → 裁剪）
- 提示词缓存优化（System Prompt 前置）
- 思考链与内容分离（thinking 不入主上下文，节省 token）

---

## 五、技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript 6.0 |
| 运行时 | Node.js |
| 包管理 | pnpm 10.26 + Turborepo |
| CLI 框架 | Commander.js |
| 终端渲染 | ANSI 原始控制 + 自研 Markdown 渲染器 |
| 测试 | Vitest 4.1 |
| Lint | ESLint 10 + typescript-eslint |
| 沙箱 | Docker（Python/Node 代码执行） |
| 搜索 | ripgrep + tree-sitter |
| LSP | 自研 LSP Manager |
| 文档解析 | mammoth (DOCX) · xlsx · sharp (图片) · tesseract.js (OCR) |
| MCP | @modelcontextprotocol/sdk |
| 终端 | execa (子进程) · readline (键盘事件) |

---

## 六、我的独立思考

### 亮点

1. **自举 Dogfooding**：不是口号。我运行在它之上，用的就是它自己的 read_file、search、write_file 等工具来分析它自己。这种设计本身就是最严格的集成测试。

2. **ContextManager 的水位线设计**非常务实：60% 警告 / 75% 轻量裁剪 / 85% LLM 摘要，三层渐进，既避免了过早压缩带来的信息丢失，也防止了 OOM 崩溃。尾部保留策略（从末尾向前找 assistant 边界）保证了语义完整性。

3. **ExecutionController 的四层熔断链**替代了早期版本的硬编码"8 轮强制停止"。LoopGuard 的三要素哈希比对（工具名 + 参数 + 结果）是低成本高准确率的死循环检测方案。

4. **工具折叠（tool call folding）**是借鉴 Claude Code 的 UX 优化，连续同类工具调用合并为一行，大幅减少终端噪音。write_file 的 diff 摘要直接显示在折叠行中，反馈即时。

5. **流式渲染的缓冲策略**考虑周全：代码围栏和表格都做整块缓冲，避免 ANSI 染色跨行断裂。思考链与主内容分离，进入独立状态行，不污染输出。

6. **类型契约层的零依赖设计**（`packages/types/`）遵循了 Monorepo 的最佳实践——类型层不应引入任何运行时依赖，所有包可以安全导入。

### 可观察到的演进方向

1. **REPL 的 Ink React 迁移**：`tui/renderer.ts` 目前是原始 ANSI 控制，但如果要支持更复杂的交互式 UI（如文件树选择器、diff 预览），可能需要迁移到 Ink（React for terminal）。

2. **多智能体编排的完善**：Orchestrator 已实现三种模式，但 SubagentRunner 的具体实现、评判模型（Swarm 模式中选最优）、Worktree 合并冲突处理等还在早期阶段。

3. **插件系统**：`plugin_install` / `plugin_list` 工具已注册但标注为 "placeholder"，MCP Server 集成已基本可用的同时，本地插件机制待完善。

4. **Telemetry 和可观测性**：`runtime/src/telemetry/` 模块已搭建，但端到端的遥测管道（收集 → 聚合 → 展示）可能还在建设中。

### 总结

这是一个**务实、设计清晰、技术债务低**的项目。没有过度工程化——每个模块都有明确的边界和单一职责。最大的特点是**自举验证**——框架本身被用于自身的开发循环，这意味着每个设计决策都经过了"自己吃自己的狗粮"的检验。ContextManager 和 ExecutionController 是两个最成熟的子系统，Orchestrator 和 Subagent 是多智能体方向的自然延伸。
