# Code Agent

企业级开源 AI Code Agent — 6 个 Phase 已实施，10 个包 Monorepo。

## 技术栈

- **Runtime**: Node.js 22, TypeScript 6 (ES2022, NodeNext)
- **Package Manager**: pnpm 10 (workspace)
- **Build**: tsc + Turbo
- **LLM**: OpenAI 兼容 API (DeepSeek/OpenAI/Anthropic/Google/OpenRouter/Ollama)
- **Code Intelligence**: tree-sitter (10 语言), vscode-jsonrpc LSP
- **Storage**: SQLite (better-sqlite3), FTS5
- **Sandbox**: macOS Seatbelt / Linux Bubblewrap

## 包结构 (10 包)

```
packages/
├── shared/          — Message, LLMResponse 接口
├── diff-engine/     — SEARCH/REPLACE 补丁解析 + Unified Diff
├── llm-provider/    — 6 个 Provider + AI Gateway + 重试
├── tool-kit/        — 文件读写、沙箱、语法验证、Git
├── context-engine/  — tree-sitter 索引器、搜索、LSP、Embedding
├── agent-core/      — ToolRegistry、权限、执行控制、子智能体、Hooks/Skills/MCP
├── runtime/         — AgentRuntime、EventBus、StateMachine、DI
├── memory/          — 跨会话记忆 (SQLite + FTS5)
├── logger/          — 审计日志 (JSONL)
└── apps/
    └── cli/         — Commander+Inquirer CLI 入口
```

## 常用命令

```bash
pnpm install                          # 安装依赖
pnpm run typecheck                    # 全量类型检查
pnpm run build                        # 全量构建
pnpm --filter <package> run typecheck # 单包类型检查
pnpm start:cli                        # 启动 CLI
```

## 核心架构

- **工具分发**: ToolRegistry.register() → SchemaAdapter.toOpenAI/Anthropic() → Provider.chat()
- **执行控制**: ExecutionController = LoopGuard + BudgetManager + GoalManager
- **上下文**: ContextManager = ContextSource[] 收集 → 优先级排序 → token 裁剪
- **权限**: PermissionEngine (allow/deny/ask) + Capability 系统
- **子智能体**: SubagentRunner 独立上下文 → SubagentResult.summary → Orchestrator 汇总

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

- 严格 TypeScript (strict: true, noUncheckedIndexedAccess, noUnusedLocals)
- ES Module (NodeNext module resolution)
- 接口优先: ILLMProvider > 具体 Provider, ContextSource > ad-hoc 收集
- 工具注册: 新增工具只需 registry.register()，不修改 executor
