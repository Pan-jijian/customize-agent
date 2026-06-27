# Customize Agent

通用终端 AI 助手 — 7 包 + 1 App Monorepo，原生 Function Calling + 双语 TUI + 三级模型分层。编程、写作、运维、数据分析、文件管理均可。

## 特性

- **通用 AI 助手** — 通过 CUSTOMIZE.md 定义角色和规则，一份配置即可切换 Agent 身份
- **CUSTOMIZE.md 角色注入** — 项目根目录放置 CUSTOMIZE.md 文件，启动时自动读取并注入系统提示词
- **中文系统提示词** — 内置规则全中文，参考 Claude Code / Aider / Codex CLI / 通义灵码 / 文心快码
- **双语 TUI** — 中/英文界面即时切换，4×6 像素字标题（天蓝→紫渐变），下拉菜单 + 提示栏完整双语
- **三级模型分层** — 读取 / 推理 / 执行 三层独立配置不同模型，未配层自动回退，降低 token 成本
- **Provider 独立管理** — API key 属于 Provider（同厂商多模型共享），协议自动推断 + 手动覆盖
- **9 个 CLI 工具** — 文件读写、全文搜索、终端执行、Git、LSP 跳转
- **零启动扫描** — `@file` 首次触发 `git ls-files` 毫秒级扫描
- **配置持久化** — `~/.customize-agent/config.json`，语言/Provider/模型全持久化，跨会话保留
- **上下文自动压缩** — 三级水位（60% 警告 → 75% 截断旧工具结果 → 85% LLM 摘要）

---

## 快速开始

### 安装与启动

```bash
pnpm install
pnpm run build
pnpm start:cli
```

### 首次配置

进入 REPL 后，配置一个模型即可使用：

```
/model add action deepseek deepseek-v4-flash    # 添加模型到执行层
/model key deepseek sk-xxx                      # 设置 API Key
```

不分区则所有任务共用这一个模型。高级用法：为不同层级配不同模型（见下方"模型三层架构"）。

### 角色定制（CUSTOMIZE.md）

在项目根目录下创建 `CUSTOMIZE.md` 文件，定义 Agent 的角色、规则和领域知识：

```markdown
# CUSTOMIZE

## 角色
你是一个 React + TypeScript 前端专家。

## 规则
- 组件用函数式 + Hooks
- 类型不用 any
- 修改后运行 `pnpm typecheck && pnpm test`
- 不修改 vite.config.ts
```

Agent 启动时自动读取并注入到系统提示词。不创建则使用默认通用规则。

### 语言切换

```
/language        # ↑↓ 选择面板
/language zh     # 直接中文
/language en     # 直接英文
```

---

## 包结构 (7 包 + 1 App)

```
packages/
├── types/      (1 file)  跨包类型契约 + BINARY_EXTENSIONS，零外部依赖
├── llm/        (12 files) 6 个 Provider + OpenAICompat 抽象基类 + 重试 + Token 估算
├── tools/      (7 files)  文件读写、沙箱（Seatbelt/Bubblewrap）、终端、Git、Diff、语法验证
├── search/      (10 files) tree-sitter 索引 + ripgrep 搜索 + LSP + 语义 Embedding
├── engine/     (18 files) ToolRegistry、权限、执行控制、上下文、规划、子智能体、MCP、Hooks
├── runtime/    (5 files)  统一调度 + ConfigStore + ModelRegistry + 遥测 + 生命周期
├── memory/     (2 files)  跨会话记忆 (SQLite + FTS5)
└── apps/cli/   (10 files) Commander CLI 入口、REPL、TUI 渲染/输入、i18n、像素字
```

### 包依赖关系

```
types (零依赖)
  ↑
  ├── llm → OpenAI SDK
  ├── tools → codex, llm
  ├── codex → llm, tree-sitter, better-sqlite3
  ├── engine → llm, types
  ├── runtime → types
  ├── memory → better-sqlite3
  └── apps/cli → engine, llm, tools, codex, runtime, memory
```

### 各包详细导出

**@customize-agent/types** — 零外部依赖的契约层
| 导出 | 说明 |
|------|------|
| `Message` | LLM 对话消息 `{ role, content, toolCalls?, toolCallId? }` |
| `LLMResponse` | LLM 响应 `{ content, thinkingContent?, toolCalls?, usage? }` |
| `ToolCall` | 工具调用 `{ id, name, arguments }` |
| `StreamChunk` | 流式块联合类型 `content \| thinking \| tool_call \| error \| done` |
| `FunctionDefinition` | OpenAI 风格函数定义 `{ name, description, parameters }` |
| `LifecycleAware` | 组件生命周期接口 `{ init?, shutdown?, healthCheck?, restart? }` |
| `Session` / `TaskState` / `Checkpoint` | 会话、任务状态、检查点 |
| `BINARY_EXTENSIONS` | 已知二进制扩展名 Set |

**@customize-agent/llm** — 6 个 Provider + 共享基础设施
| 导出 | 说明 |
|------|------|
| `OpenAICompatProvider` | OpenAI 兼容抽象基类（封装 ~90% 重复逻辑） |
| `OpenAIProvider` / `DeepSeekProvider` / `OpenRouterProvider` / `OllamaProvider` | OpenAI 兼容 Provider（继承基类，~30 行/个） |
| `AnthropicProvider` / `GoogleProvider` | 原生 API Provider |
| `createProvider(name, opts)` | Provider 工厂 `name → Provider 实例` |
| `estimateTokens` / `countTokensFromMessages` | Token 估算（字符/3.5） |
| `toOpenAIMessages` / `toOpenAITools` | 消息/工具格式转换 |
| `createLLMResponse` | 响应工厂 |
| `withRetry` / `isRetryableError` | 指数退避重试 |

**@customize-agent/tools** — Agent 可调用的工具实现
| 导出 | 说明 |
|------|------|
| `ToolKit` | 文件工具集：读写、列表、修改、备份/回滚 |
| `SandboxExecutor` | 沙箱执行：Seatbelt(macOS) / Bubblewrap(Linux) / VFS-Guard |
| `TerminalTool` | 终端命令运行（委托 SandboxExecutor） |
| `GitTool` | Git 状态/差异/提交 |
| `UnifiedSyntaxValidator` | tree-sitter 通用语法验证（11 语言） |
| `DiffEngine` | SEARCH/REPLACE 解析 + Unified Diff 生成 |

**@customize-agent/search** — 代码智能
| 导出 | 说明 |
|------|------|
| `StorageManager` | SQLite 文件索引 + FTS5 + Embedding 持久化 |
| `RepositoryIndexer` | tree-sitter AST 符号提取（11 语言，大小文件分流） |
| `TreeSitterWorkerPool` | Worker 线程池（大文件异步解析） |
| `CodeSearcher` | ripgrep 文本搜索（回退 JS） |
| `EmbeddingSearch` | LLM Embedding 语义搜索（L3） |
| `LSPManager` | vscode-jsonrpc LSP 客户端（9 种语言服务器） |
| `getLanguageConfig` / `getSupportedExtensions` | 语言配置查询 |
| `extractSymbolName` / `collectAstErrors` | 共享 AST 工具 |

**@customize-agent/engine** — 核心引擎
| 导出 | 说明 |
|------|------|
| `ToolRegistry` | 工具注册/分发中心 |
| `SchemaAdapter` | 工具 Schema → OpenAI/Anthropic/MCP 格式转换 |
| `PermissionEngine` | 权限引擎 (allow/deny/ask) + 路径/命令匹配 |
| `ExecutionController` | 执行控制器：LoopGuard + BudgetManager + GoalManager + CheckpointManager |
| `ContextManager` | 上下文管理：收集→排序→裁剪→压缩（三级水位） |
| `SubagentRunner` | 子智能体运行器（独立上下文 + LLM 循环） |
| `Orchestrator` | 多智能体编排（Orchestrator/Pipeline/Swarm） |
| `WorktreeManager` | Git Worktree 生命周期管理（FIFO 互斥锁） |
| `MCPServer` / `MCPClient` | MCP 协议 stdio 服务端/客户端 |
| `HooksEngine` | 6 事件生命周期钩子 |
| `SkillsLoader` | Markdown 技能包加载 |

**@customize-agent/runtime** — 运行时 + 配置
| 导出 | 说明 |
|------|------|
| `AgentRuntime` | 统一调度：组件生命周期 + 会话 + 主循环 + 取消传播 |
| `ConfigStore` | 用户配置持久化 ~/.customize-agent/config.json |
| `ModelRegistry` | 模型注册中心：三层回退解析 |
| `detectProtocol` / `resolveProtocol` | Provider 协议推断 |
| `EventBus` | 三层事件总线 (L0 系统 / L1 领域 / L2 遥测) |
| `StateMachine` | 14 状态任务状态机 |
| `AuditLogger` / `MetricsCollector` | 审计日志 (JSONL) + 遥测指标 |

**@customize-agent/memory** — 跨会话记忆
| 导出 | 说明 |
|------|------|
| `MemoryManager` | 记忆 CRUD：FTS5 全文搜索 + LIKE 回退 + FNV-1a 去重 |

---

## TUI 界面

启动后显示欢迎横幅（4×6 像素字标题 + 天蓝→紫渐变）：

```
╭──────────────────────────────────────────╮
│      ██  █  █  ███  ████  ███           │  ← 像素字
│     █  █ █  █ █    █  █ █  █           │  ← 天蓝→紫渐变
│     █  █ █  █  ██  █  █ █  █           │
│     █  █ █  █    █ █  █ █  █           │
│     █  █ █  █    █ █  █ █  █           │
│      ██   ███  ███  ████  ███           │
│                                          │
│               0.0.3                      │
│        Provider  deepseek/...            │
│                                          │
│    ▶  输入任务开始  @ 引用文件  / 命令    │
╰──────────────────────────────────────────╯
  AGENT  │  ➜ _
```

- `@` 触发文件下拉菜单（模糊匹配 + 子串评分）
- `/` 触发命令下拉菜单（↑↓ 选择 + Enter 确认）
- 提示栏实时显示 `Tab 选择  ·  ↑↓ 导航  ·  Enter 确认  ·  Esc 关闭`

---

## CLI 工具集 (9 个)

AI Agent 可调用以下工具，通过原生 Function Calling 协议传递给 LLM：

| 工具 | 功能 | 审批 | 对应 Capability |
|------|------|:--:|------|
| `read_file` | 路径沙箱内读文件（分页/二进制检测） | 否 | READ_CODE |
| `list_files` | 列出项目文件（.gitignore 感知） | 否 | READ_CODE |
| `search` | 全文搜索（ripgrep），不限文件类型 | 否 | READ_CODE |
| `write_file` | 创建/覆盖 或 SEARCH/REPLACE 修改 + 备份回滚 | 是 | WRITE_CODE |
| `execute_command` | 终端执行（Seatbelt/Bubblewrap/Docker 自适应） | 是 | EXECUTE_COMMAND |
| `git_commit` | 暂存 + 提交 | 是 | GIT_OPERATION |
| `lsp_definition` | 跳转到符号定义 | 否 | LSP_QUERY |
| `lsp_references` | 查找符号引用 | 否 | LSP_QUERY |
| `lsp_diagnostics` | LSP 诊断 | 否 | LSP_QUERY |

### 沙箱模式

| 模式 | 平台 | 隔离级别 |
|------|------|------|
| `workspace-write` (默认) | macOS Seatbelt / Linux Bubblewrap | 内核级 |
| `read-only` | 同上 + 写命令拦截 | 内核级 |
| `danger-full-access` | 需环境变量确认 | 无隔离 |
| `vfs-guard` (回退) | JS 纯虚拟沙箱 | 进程级 |

---

## REPL 命令

| 命令 | 功能 |
|------|------|
| `/model` | 直观分层视图 + 快速开始示例 |
| `/model add <tier> <provider> <name>` | 添加模型到指定层 |
| `/model set <tier> <name>` | 切换该层激活模型 |
| `/model rm <tier> <name>` | 移除模型 |
| `/model key <provider> <key>` | 设置 Provider API Key |
| `/model fallback` | 查看各层回退路径 |
| `/provider` | 列出所有 Provider（key 状态/协议） |
| `/provider key <name> <key>` | 设置/更新 API Key |
| `/provider protocol <name> <p>` | 手动指定协议 |
| `/provider url <name> <url>` | 覆盖 API 端点 |
| `/language` | ↑↓ 语言选择面板 |
| `/language zh\|en` | 直接切换 |
| `/plan <task>` | Plan 模式（只读探索，不修改文件） |
| `/clear` | 重置会话 |
| `/compact` | 手动压缩上下文 |
| `/context` | 查看上下文用量 |
| `/sessions` | 查看历史会话 |
| `/help` | 命令列表 |
| `/exit` / `/quit` | 退出 |

---

## 配置

配置存储在 `~/.customize-agent/config.json`，支持全 REPL 命令即时修改：

```json5
{
  "language": "zh",                     // 界面语言
  "providers": {                        // Provider 独立配置
    "deepseek": {
      "apiKey": "sk-xxx",               // 手动设置 / 环境变量 / 留空
      "baseUrl": "",                    // 留空=默认端点
      "protocol": ""                    // 留空=自动推断
    }
  },
  "models": {
    "reader":    { "active": "",                      "list": [] },
    "reasoning": { "active": "",                      "list": [] },
    "action":    { "active": "deepseek-v4-flash",     "list": [
      { "name": "deepseek-v4-flash", "provider": "deepseek" }
    ]}
  }
}
```

### 模型三层架构

```
Reader (读取层)    →  Reasoning (推理层)  →  Action (执行层)
  读文件                分析代码                修改文件
  搜索符号              制定方案                执行命令
  浏览代码              整合信息                Git 操作
  [便宜模型]            [强推理模型]            [精准模型]
```

**回退规则：** 某层未配 → `reasoning → action → reader` 优先查找。只配一层则三层共用。

### Provider 协议推断

| Provider | 默认协议 | Base URL |
|----------|:--:|------|
| deepseek | openai | api.deepseek.com/v1 |
| openai | openai | api.openai.com/v1 |
| openrouter | openai | openrouter.ai/api/v1 |
| ollama | openai | localhost:11434/v1 |
| anthropic | anthropic | api.anthropic.com/v1 |
| google | google | generativelanguage.googleapis.com |
| 其他 | openai | — |

手动覆盖：`/provider protocol my-api anthropic` 或 `config.json` 中设置 `"protocol": "anthropic"`。

### API Key 优先级

```
/provider key 设置  >  环境变量 CUSTOMIZE_AGENT_{NAME}_API_KEY  >  SDK 默认查找
```

---

## 环境变量

```
CUSTOMIZE_AGENT_DEEPSEEK_API_KEY=        # DeepSeek
CUSTOMIZE_AGENT_OPENAI_API_KEY=          # OpenAI
CUSTOMIZE_AGENT_ANTHROPIC_API_KEY=       # Anthropic
CUSTOMIZE_AGENT_GOOGLE_API_KEY=          # Google
CUSTOMIZE_AGENT_OPENROUTER_API_KEY=      # OpenRouter
CUSTOMIZE_AGENT_OLLAMA_API_KEY=          # Ollama（本地通常不需要）
CUSTOMIZE_AGENT_DANGER_MODE=1            # 启用 danger-full-access 沙箱
```

---

## 项目命令

```bash
pnpm install                          # 安装依赖
pnpm run typecheck                    # 全量类型检查 (turbo)
pnpm run build                        # 全量构建 (turbo)
pnpm --filter <package> run typecheck # 单包类型检查
pnpm --filter <package> run build     # 单包构建
pnpm run test                         # Vitest 单元测试
pnpm run test:watch                   # Vitest 监听模式
pnpm run lint                         # ESLint 全量检查
pnpm run check                        # typecheck + lint + test 一键检查
pnpm start:cli                        # 启动 CLI
pnpm start:cli -- -p "your task"      # 单次执行模式
pnpm start:cli -- mcp-server          # 启动 MCP Server
```

---

## 核心架构

### 数据流

```
用户输入 → TuiInput (raw mode keypress)
  → Repl._execute()
    → AgentExecutor.runTask()
      → Provider.chat(tools) ← SchemaAdapter.toProvider(registry)
        → LLM Response (content + toolCalls)
      → ToolRegistry.dispatch(toolCall)
        → PermissionEngine.check()
        → ToolKit / GitTool / SandboxExecutor / ...
      → ExecutionController.evaluate()
        → 继续 / 停止 / 重规划 / 暂停
    → Repl 展示结果
```

### 系统提示词

```
内置规则 (prompt.ts, 中文)          CUSTOMIZE.md (项目根, 可选)
─────────────────────────          ─────────────────────────
核心协议（Think-Act-Observe）      角色定义
安全红线（不泄露/不破坏）          领域规则
工具使用规范                       技术栈/约定
质量要求（验证/熔断）              偏好工具
上下文管理（三级水位）             项目结构
交互风格                          业务约束
```

CUSTOMIZE.md 规则优先于内置规则。不创建则仅用内置规则。

### 工具分发链

```
ToolRegistry.register() → SchemaAdapter.toOpenAI/Anthropic/MCP() → Provider.chat(tools)
AgentExecutor 使用原生 function calling，不解析 XML
```

### 执行控制

```
ExecutionController:
  L1 LoopGuard     — 连续 3 轮相同 tool+args+result → 死循环 → replan
  L2 BudgetManager — 累计费用 > 上限 → 熔断 stop
  L3 GoalManager   — <task_finish> 标记 / 里程碑事件 → 完成检测
  L4 Checkpoint    — 每 15 轮暂停 → 人工确认
```

### 上下文管理

```
ContextManager.compactMessages():
  60% token → 警告
  75% token → 轻量截断（旧 tool 结果截 200 字符）
  85% token → LLM 摘要压缩（替换旧消息）
```

### 权限系统

```
PermissionEngine.check(tool, args):
  → Capability 检查 (ROLE_CAPABILITY_MAP)
  → 路径 glob 匹配 (deny /etc/ ...)
  → 命令模式匹配 (deny rm -rf / ...)
  → 默认策略 → allow / deny / ask
```

### 子智能体编排

```
SubagentRunner:
  独立 Message[] history + 独立 BudgetManager($1) + 独立 LoopGuard(3)
  → <task_finish> 完成标记 → SubagentResult.summary
  → Orchestrator 汇总 (Orchestrator/Pipeline/Swarm 三种模式)
```

### MCP 协议

```
MCPServer (stdio JSON-RPC 2.0):
  initialize → tools/list → tools/call
  将 ToolRegistry 中的工具暴露给 Claude Desktop / Cursor

MCPClient:
  spawn MCP Server 子进程 → 握手 → tools/list → 注册到本地 ToolRegistry
  mcp_{server}_{tool} 命名，默认 requiresApproval: true
```

### 文件索引

```
@file 模糊补全:
  首次 @ → git ls-files (毫秒) → fallback fast-glob
  后续按键 → 子串匹配 + (匹配位置 × 10000 + 路径长度) 评分 → top 12

search_symbol:
  首次调用 → lazy-index tree-sitter AST → SQLite FTS5
  后续调用 → 增量索引 (mtime 检查) → FTS5 MATCH
```

---

## 国际化 (i18n)

- 翻译引擎：`I18nManager` (`apps/cli/src/i18n/manager.ts`)
- 翻译包：`zh.ts` (中文, 141 键) / `en.ts` (英文, 141 键)
- 覆盖范围：Banner、下拉菜单、提示栏、工具名、审批弹窗、上下文、模型管理、错误提示
- 切换方式：`/language` 面板 或 `/language zh|en` 直接切换
- 语言切换即时生效（重建 TuiInput 标签 + 重绘 Banner）

---

## 代码风格

- 严格 TypeScript (`strict: true`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`)
- ES Module (`NodeNext` module resolution)
- 接口优先: `LLMProvider` > 具体 Provider, `ContextSource` > ad-hoc 收集
- 工具注册: 新增工具只需 `registry.register()`，不修改 executor
- 类型导入: `import type { ... }` 用于仅类型用途

---

## 关键设计决策 (ADR)

| ADR | 决策 | 理由 |
|-----|------|------|
| ADR-1 | 内部工具走函数调用，MCP 仅用于外部集成 | 避免进程内 JSON-RPC 序列化开销 |
| ADR-2 | Seatbelt/Bubblewrap 为主沙箱，容器可选 | 内核级隔离，启动 < 10ms，无 daemon |
| ADR-3 | tree-sitter 统一代码智能 + 语法验证 | 一套 DFS 覆盖 11 语言，无需各语言编译器 |
| ADR-4 | LSP 使用 vscode-jsonrpc 标准库 | 不重复造轮子 |
| ADR-5 | 废弃 AI Gateway 自动路由 | 自动切换破坏用户信任，显式控制优于自动化 |
| ADR-16 | LifecycleAware 统一组件生命周期 | `restart()` 严禁更换实例指针 |
| ADR-17 | 三级模型分层 (reader/reasoning/action) | 按任务类型路由不同模型，降低 token 成本 |
| ADR-18 | Provider 协议自动推断 + 手动覆盖 | 零配置可用，第三方 Provider 可手动修正 |
| ADR-19 | API Key 属于 Provider 不属于 Model | 同厂商多模型共享 Key，减少重复配置 |
| ADR-20 | 零启动扫描，全部懒加载 | git ls-files 毫秒级，不阻塞启动 |
| ADR-21 | 内置规则 + CUSTOMIZE.md 双层提示词 | 内置规则管安全/协议，CUSTOMIZE.md 管角色/领域 |
