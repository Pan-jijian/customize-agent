# Code Agent

企业级开源 AI Code Agent — 9 包 + 1 App Monorepo，原生 Function Calling 工具协议。

## 技术栈

- **Runtime**: Node.js 22, TypeScript 6.0 (ES2022, NodeNext)
- **Package Manager**: pnpm 10.26 (workspace)
- **Build**: tsc + Turbo 2.9
- **Test**: Vitest 4.1
- **Lint**: ESLint 10 + typescript-eslint 8
- **LLM**: OpenAI 兼容 API — 6 个 Provider，用户通过 `--provider` 显式选择，不做自动切换
- **Code Intelligence**: tree-sitter (10 语言), vscode-jsonrpc LSP
- **Storage**: SQLite (better-sqlite3), FTS5
- **Sandbox**: macOS Seatbelt / Linux Bubblewrap (内核级，启动 < 10ms)

## 包结构 (9 包 + 1 App)

```
packages/
├── types/           — 跨包类型契约：Message, LLMResponse, Session, LifecycleAware, 零外部依赖
├── diff/            — SEARCH/REPLACE 补丁解析 + 模糊容错 + Unified Diff
├── llm/             — 6 个 Provider + 重试 + 创建工厂
├── tools/           — 文件读写、沙箱、终端、Git、tree-sitter 通用语法验证
├── codex/           — 代码智能：tree-sitter 索引、ripgrep 搜索、LSP、语义 Embedding
├── engine/          — ToolRegistry、SchemaAdapter、权限、执行控制、上下文管理、规划、子智能体、MCP、Hooks、Skills
├── runtime/         — 统一调度层：LifecycleAware、拓扑初始化、ComponentState、状态机、事件总线、DI
├── memory/          — 跨会话记忆 (SQLite + FTS5)
├── telemetry/       — 审计日志 (JSONL) + 遥测指标
└── apps/
    └── cli/         — Commander+Inquirer CLI 入口、REPL、TUI 渲染、@file 引用
```

### 各包导出清单

| 包 | 主要导出 |
|----|---------|
| `@code-agent/types` | `Message`, `LLMResponse`, `ToolCall`, `StreamChunk`, `FunctionDefinition`, `LifecycleAware`, `Session`, `createSession`, `TaskState`, `ComponentState`, `Checkpoint` |
| `@code-agent/diff` | `DiffEngine.parseBlocks()`, `DiffEngine.applyPatch()`, `DiffEngine.generateUnifiedDiff()` |
| `@code-agent/llm` | `ILLMProvider` 接口, `DeepSeekProvider`, `OpenAIProvider`, `AnthropicProvider`, `GoogleProvider`, `OpenRouterProvider`, `OllamaProvider`, `createProvider()`, `estimateTokens`, `countTokensFromMessages`, `toOpenAIMessages`, `createLLMResponse` |
| `@code-agent/tools` | `ToolKit` (文件读写), `SandboxExecutor` (Seatbelt/Bubblewrap), `TerminalTool`, `GitTool`, `UnifiedSyntaxValidator` (tree-sitter 通用) |
| `@code-agent/codex` | `StorageManager`, `RepositoryIndexer`, `TreeSitterWorkerPool`, `CodeSearcher` (ripgrep), `EmbeddingSearch`, `LSPManager`, 语言配置 |
| `@code-agent/engine` | `ToolRegistry`, `SchemaAdapter`, `PermissionEngine`, `Capability` 系统, `ExecutionController` (LoopGuard/BudgetManager/GoalManager/CheckpointManager), `ContextManager`, `PlanModeManager`, `SubagentRunner`, `Orchestrator`, `SafeWorktreeManager`, `McpServer`, `McpClient`, `HooksEngine`, `SkillsLoader` |
| `@code-agent/runtime` | `LifecycleAware` 接口, `topologicalSort()`, `initializeComponents()`, `ComponentStatus`, `ComponentState`, 状态机、事件总线、DI 容器 |
| `@code-agent/memory` | `MemoryManager` (跨会话记忆 CRUD) |
| `@code-agent/telemetry` | `AuditLogger` (JSONL 审计日志), `MetricsCollector` (遥测指标) |

### CLI 工具集 (13 个)

| 工具 | 功能 | 审批 |
|------|------|:--:|
| `search_symbol` | SQLite FTS 符号搜索 | 否 |
| `read_file` | 路径沙箱内读文件 | 否 |
| `list_files` | 列出项目根目录文件 | 否 |
| `modify_file` | SEARCH/REPLACE 修改 + 回滚 | 是 |
| `write_file` | 创建/覆盖文件 | 是 |
| `execute_command` | 沙箱内终端执行 | 是 |
| `git_status` | 查看 Git 工作树状态 | 否 |
| `git_diff` | 查看 Git 未暂存变更 | 否 |
| `git_commit` | 暂存并提交 | 是 |
| `web_search` | 网络搜索 (DuckDuckGo) | 否 |
| `lsp_definition` | 跳转到符号定义 | 否 |
| `lsp_references` | 查找符号所有引用 | 否 |
| `lsp_diagnostics` | LSP 诊断信息（错误/警告） | 否 |

## 常用命令

```bash
pnpm install                          # 安装依赖
pnpm run typecheck                    # 全量类型检查 (turbo)
pnpm run build                        # 全量构建 (turbo)
pnpm --filter <package> run typecheck # 单包类型检查
pnpm --filter <package> run build     # 单包构建
pnpm run test                         # Vitest 单元测试
pnpm run test:watch                   # Vitest 监听模式
pnpm run test:e2e                     # E2E 测试 (tests/e2e/)
pnpm run lint                         # ESLint 全量检查
pnpm run check                        # typecheck + lint + test 一键检查
pnpm start:cli                        # 启动 CLI
```

## 核心架构

### 工具分发链

```
ToolRegistry.register() → SchemaAdapter.toOpenAI/Anthropic() → Provider.chat(tools)
AgentExecutor 使用原生 function calling，不再解析 XML
```

### 执行控制

```
ExecutionController = LoopGuard (最大迭代熔断) + BudgetManager (token 预算) + GoalManager (目标检测)
CheckpointManager — 文件修改前自动保存快照，失败时回滚
```

### 上下文管理

```
ContextManager = ContextSource[] 收集 → ChunkPriority 排序 → token 裁剪
内置源: SystemPromptSource, ToolDefinitionSource, ToolResultSource
```

### 权限系统

```
PermissionEngine (allow/deny/ask) + Capability 系统
TOOL_CAPABILITY_MAP — 每个工具绑定所需权能
ROLE_CAPABILITY_MAP — 子智能体角色权限继承
```

### Provider 选择策略

用户通过 `--provider` 和 `--model` 显式指定模型，不做自动切换或静默降级。Provider 失败时直接报错，由用户决定重试或更换。信任优先于自动化。

### 子智能体编排

```
SubagentRunner → 独立上下文 + 独立工作树 (SafeWorktreeManager)
  → SubagentResult.summary → Orchestrator 汇总
CollaborationMode: sequential | parallel | hierarchical
```

### MCP 协议

```
McpServer — 将内部工具暴露给外部 AI 客户端 (Claude Desktop, Cursor)
McpClient — 连接社区 MCP Server 生态 (GitHub, Postgres, Jira)
```

### Hooks & Skills

```
HooksEngine — PreToolUse / PostToolUse / Stop 事件钩子
SkillsLoader — Markdown 定义的技能包，自动触发或命令调用
```

### 生命周期管理 (ADR-16)

```
LifecycleAware 接口 → topologicalSort() → initializeComponents()
所有组件统一 init/shutdown/healthCheck/restart/reload 契约
DAG 拓扑排序保证初始化顺序，依赖故障时自动降级
```

## 环境变量

```
CODE_AGENT_DEEPSEEK_API_KEY=
CODE_AGENT_OPENAI_API_KEY=
CODE_AGENT_ANTHROPIC_API_KEY=
CODE_AGENT_GOOGLE_API_KEY=
CODE_AGENT_OPENROUTER_API_KEY=
CODE_AGENT_OLLAMA_API_KEY=
```

## 代码风格

- 严格 TypeScript (`strict: true`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`)
- ES Module (`NodeNext` module resolution)
- 接口优先: `ILLMProvider` > 具体 Provider, `ContextSource` > ad-hoc 收集
- 工具注册: 新增工具只需 `registry.register()`，不修改 executor
- 类型导入: `import type { ... }` 用于仅类型用途
- 零测试容忍度: 每个包应有 `__tests__/` 目录

## 关键设计决策 (ADR)

| ADR | 决策 | 理由 |
|-----|------|------|
| ADR-1 | 内部工具走函数调用，MCP 仅用于外部集成 | 避免进程内 JSON-RPC 序列化开销 |
| ADR-2 | Seatbelt/Bubblewrap 为主沙箱，容器可选 | 内核级隔离，启动 < 10ms，无 daemon 依赖 |
| ADR-3 | tree-sitter 统一代码智能 + 语法验证 | 一套 DFS 覆盖 10 语言，无需各语言编译器 |
| ADR-4 | LSP 使用 vscode-jsonrpc 标准库 | 不重复造轮子，VS Code 数百万用户验证 |
| ADR-5 | 废弃 — AI Gateway 自动路由已移除，用户显式选择模型 | 自动切换破坏用户信任，显式控制优于自动化 |
| ADR-16 | LifecycleAware 统一组件生命周期 | `restart()` 严禁更换实例指针，防止 Stale Reference |
