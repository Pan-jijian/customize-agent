# Customize Agent

通用终端 AI 助手 — 8 包 + 1 App Monorepo，原生 Function Calling + 双语 TUI + 三级模型分层。支持编程、写作、系统运维、数据分析和文件管理。

通过项目根目录的 `CUSTOMIZE.md` 文件一键切换 Agent 角色和规则，无需修改代码。

---

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [包详解](#包详解)
  - [@customize-agent/types](#customize-agenttypes)
  - [@customize-agent/llm](#customize-agentllm)
  - [@customize-agent/tools](#customize-agenttools)
  - [@customize-agent/search](#customize-agentsearch)
  - [@customize-agent/knowledge](#customize-agentknowledge)
  - [@customize-agent/engine](#customize-agentengine)
  - [@customize-agent/runtime](#customize-agentruntime)
  - [@customize-agent/memory](#customize-agentmemory)
  - [CLI App](#cli-app)
- [核心架构](#核心架构)
- [完整工具集](#完整工具集)
- [模型三层架构](#模型三层架构)
- [Provider 与协议](#provider-与协议)
- [沙箱系统](#沙箱系统)
- [执行控制](#执行控制)
- [权限系统](#权限系统)
- [上下文管理](#上下文管理)
- [子智能体编排](#子智能体编排)
- [MCP 协议集成](#mcp-协议集成)
- [Hooks 系统](#hooks-系统)
- [跨会话记忆](#跨会话记忆)
- [本地知识库](#本地知识库)
- [文件索引与符号搜索](#文件索引与符号搜索)
- [TUI 界面](#tui-界面)
- [国际化 (i18n)](#国际化-i18n)
- [REPL 命令参考](#repl-命令参考)
- [配置参考](#配置参考)
- [环境变量](#环境变量)
- [项目命令](#项目命令)
- [发包流程](#发包流程)
- [测试](#测试)
- [代码风格](#代码风格)
- [设计决策 (ADR)](#设计决策-adr)
- [Docker 沙箱](#docker-沙箱)
- [故障排除](#故障排除)

---

## 特性

- **通用 AI 助手** — 通过 `CUSTOMIZE.md` 定义角色和规则，一份配置即可切换 Agent 身份
- **CUSTOMIZE.md 角色注入** — 项目根目录放置 `CUSTOMIZE.md` 文件，启动时自动读取并注入系统提示词
- **双语 TUI** — 中/英文界面即时切换，4×6 像素字标题（天蓝→紫渐变），下拉菜单 + 提示栏完整双语
- **三级模型分层** — 读取 / 推理 / 执行 三层独立配置不同模型，未配层自动回退，降低 token 成本
- **Provider 独立管理** — API Key 属于 Provider（同厂商多模型共享），协议自动推断 + 手动覆盖
- **6 个 LLM Provider** — OpenAI、DeepSeek、Anthropic、Google Gemini、OpenRouter、Ollama 开箱即用
- **50+ 内置工具** — 文件读写、全文搜索、终端执行、Git、LSP 跳转、多媒体处理、导出、检查点等
- **沙箱安全** — macOS Seatbelt / Linux Bubblewrap 内核级隔离，回退 VFS-Guard 进程级隔离
- **四层执行控制** — 死循环检测 / 预算熔断 / 目标完成判断 / 人工检查点
- **子智能体编排** — Orchestrator（DAG）/ Pipeline / Swarm 三种协作模式
- **MCP 协议** — 既可作为 MCP Server 暴露工具，也可作为 MCP Client 接入外部工具
- **Hooks 系统** — 6 个生命周期事件的命令/提示词钩子
- **跨会话记忆** — SQLite + FTS5 全文搜索，4 种记忆类型
- **本地知识库** — PDF/Word/Excel/图片/图纸等多格式文件解析与向量化检索
- **零启动扫描** — `@file` 首次触发 `git ls-files` 毫秒级扫描
- **配置持久化** — `~/.customize-agent/config.json`，语言/Provider/模型全持久化，跨会话保留
- **上下文自动压缩** — 三级水位（60% 警告 → 75% 截断旧工具结果 → 85% LLM 摘要）
- **跨平台抽象层** — Shell 命令翻译（Windows CMD/PowerShell 自动适配）、进程管理、二进制路径解析
- **子智能体文件隔离** — Git Worktree 隔离 + 内存快照隔离，子 Agent 可在完全独立的文件系统中并发运行
- **Changesets 自动化发布** — CI/CD 流水线自动版本管理 + npm 发布

---

## 快速开始

### 环境要求

- **Node.js** >= 18
- **pnpm** >= 10（项目使用 pnpm workspace）
- **macOS** 或 **Linux**（Windows 可通过 WSL2 运行）
- **可选**：Docker（用于容器沙箱模式）

### 安装与启动

```bash
# 1. 克隆项目
git clone https://github.com/Pan-jijian/customize-agent.git
cd customize-agent

# 2. 安装依赖
pnpm install

# 3. 全量构建
pnpm run build

# 4. 启动 CLI
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

Agent 启动时自动读取并注入到系统提示词。首次启动会在用户项目根目录生成示例 `CUSTOMIZE.md`；已有文件不会被覆盖。

**详细规则优先级：** CUSTOMIZE.md 中的规则覆盖内置规则。内置规则管理安全底线的协议和红线，CUSTOMIZE.md 管理角色和领域知识。

### 语言切换

```
/language        # ↑↓ 选择面板
/language zh     # 直接中文
/language en     # 直接英文
```

### 单次执行模式

```bash
pnpm start:cli -- -p "用 TypeScript 写一个快速排序"
pnpm start:cli -- -p "审查 src/ 目录下的代码" --plan   # Plan 模式（只读探索）
```

### MCP Server 模式

```bash
pnpm start:cli -- mcp-server
# 启动后通过 stdio JSON-RPC 暴露工具，供 Claude Desktop / Cursor 等 MCP 客户端使用
```

---

## 项目结构

```
customize-agent/
├── apps/
│   └── cli/                          # CLI 应用
│       └── src/
│           ├── index.ts              # Commander 入口点（REPL/单次/MCP-Server）
│           ├── bootstrap.ts          # 引导/组装：将引擎/工具/搜索/运行时组合为 AgentExecutor
│           ├── agent/                # Agent 核心循环
│           │   ├── executor.ts       # AgentExecutor 主循环
│           │   ├── prompt.ts         # 系统提示词构建（双层：内置规则 + CUSTOMIZE.md）
│           │   ├── stream-chat.ts    # 流式聊天处理
│           │   ├── tool-registry.ts  # 50+ 工具声明
│           │   ├── approval.ts       # 用户审批处理器
│           │   ├── tool-tracker.ts   # 工具调用追踪
│           │   └── tool-result.ts    # 工具结果处理
│           ├── repl/                 # REPL 交互层
│           │   ├── repl.ts           # 会话管理、命令分发、任务队列
│           │   ├── commands.ts       # 基础命令处理
│           │   ├── model-provider-commands.ts  # /model 和 /provider 命令
│           │   ├── session-commands.ts         # 会话命令
│           │   ├── tool-commands.ts            # 工具命令
│           │   ├── at-file-resolver.ts         # @file 模糊匹配
│           │   └── select-list.ts              # 选择列表 UI
│           ├── tui/                  # TUI 渲染
│           │   ├── renderer.ts       # ANSI 渲染引擎（框线、消息、横幅、下拉菜单等）
│           │   ├── input.ts          # 原始模式按键输入
│           │   ├── big-text.ts       # 4×6 像素字渐变标题
│           │   ├── colors.ts         # 颜色定义
│           │   ├── markdown.ts       # Markdown 渲染
│           │   ├── file-index.ts     # 文件索引管理
│           │   ├── language-selector.ts  # 语言选择 UI
│           │   └── task-input-capture.ts # 任务输入捕获
│           └── i18n/                 # 国际化
│               ├── manager.ts        # I18nManager
│               ├── zh.ts             # 中文翻译（141 键）
│               └── en.ts             # 英文翻译（141 键）
├── packages/
│   ├── types/                        # 跨包类型契约层（零外部依赖）
│   │   └── src/
│   │       ├── index.ts              # 统一导出
│   │       ├── message.ts            # Message / LLMResponse / StreamChunk
│   │       ├── session.ts            # Session / ConversationHistory
│   │       ├── task.ts               # TaskState / Checkpoint / TaskContext
│   │       ├── lifecycle.ts          # LifecycleAware 接口
│   │       ├── errors.ts             # 统一错误类型定义
│   │       └── constants.ts          # BINARY_EXTENSIONS 等常量
│   ├── llm/                          # AI 模型 Provider（15 个源文件）
│   │   └── src/
│   │       ├── index.ts              # createProvider 工厂
│   │       ├── interface.ts          # ILLMProvider 统一接口
│   │       ├── retry.ts              # 指数退避重试 + 错误分类
│   │       ├── providers/            # 6 个 Provider 实现
│   │       │   ├── openai-base.ts    # OpenAI 兼容抽象基类（~90% 公共逻辑）
│   │       │   ├── openai.ts         # OpenAI Provider（~30 行）
│   │       │   ├── deepseek.ts       # DeepSeek Provider（~30 行）
│   │       │   ├── openrouter.ts     # OpenRouter Provider（~30 行）
│   │       │   ├── ollama.ts         # Ollama Provider（~30 行）
│   │       │   ├── anthropic.ts      # Anthropic 原生 Provider
│   │       │   └── google.ts         # Google Gemini 原生 Provider
│   │       └── utils/                # 工具函数
│   │           ├── tokens.ts         # Token 估算
│   │           ├── pricing.ts        # 成本估算
│   │           ├── messages.ts       # 消息格式转换
│   │           ├── response.ts       # 响应工厂
│   │           └── sse.ts            # SSE 流解析
│   ├── tools/                        # Agent 工具实现（20 个源文件）
│   │   └── src/
│   │       ├── index.ts              # 统一导出
│   │       ├── toolkit.ts            # ToolKit 高质量文件操作
│   │       ├── tool-def.ts           # 声明式工具定义类型
│   │       ├── builtins-facade.ts    # BuiltinTools 外观类
│   │       ├── archiver.d.ts          # Archiver v8 ESM 类型声明
│   │       ├── core/                 # 核心基础设施
│   │       │   ├── workspace-fs.ts   # 工作区安全文件系统
│   │       │   ├── workspace-snapshot.ts  # 工作区快照/检查点
│   │       │   ├── path-utils.ts     # 安全路径工具
│   │       │   ├── constants.ts      # SKIP_DIRS 等常量
│   │       │   └── platform/         # 跨平台抽象层
│   │       │       ├── shell.ts      #   命令翻译（bash→CMD/PowerShell）
│   │       │       ├── process.ts    #   进程管理 + 清理信号处理
│   │       │       ├── binary.ts     #   二进制路径解析（跨平台）
│   │       │       ├── utils.ts      #   平台检测 + 路径工具
│   │       │       └── types.ts      #   平台类型定义
│   │       ├── builtins/             # 按领域拆分的工具实现
│   │       │   ├── index.ts          # 导出所有工具组
│   │       │   ├── file-tools.ts     # 文件操作工具
│   │       │   ├── search-tools.ts   # 搜索工具
│   │       │   ├── shell-tools.ts    # Shell/终端工具
│   │       │   ├── web-tools.ts      # 网络工具
│   │       │   ├── export-tools.ts   # 导出工具
│   │       │   ├── media-tools.ts    # 多媒体处理工具
│   │       │   ├── mcp-tools.ts      # MCP 配置工具
│   │       │   └── checkpoint-tools.ts # 检查点工具
│   │       ├── editing/              # 编辑工具
│   │       │   ├── diff.ts           # DiffEngine（SEARCH/REPLACE + Unified Diff）
│   │       │   └── syntax-validator.ts # tree-sitter 语法验证
│   │       └── sandbox/              # 沙箱
│   │           └── sandbox-executor.ts # SandboxExecutor
│   ├── search/                       # 代码智能（12 个源文件）
│   │   └── src/
│   │       ├── index.ts              # 统一导出
│   │       ├── index/                # tree-sitter AST 索引
│   │       │   ├── db.ts             # StorageManager（SQLite + FTS5）
│   │       │   ├── indexer.ts        # RepositoryIndexer（11 种语言 AST 提取）
│   │       │   ├── pool.ts           # TreeSitterWorkerPool（大文件异步解析）
│   │       │   ├── worker.ts         # Worker 线程实现
│   │       │   ├── languages.ts      # 语言配置（11 种语言 + 文件扩展名映射）
│   │       │   ├── ast-utils.ts      # AST 工具（符号名提取、错误收集）
│   │       │   └── types.ts          # 索引相关类型
│   │       ├── search/               # 搜索引擎
│   │       │   ├── grep.ts           # CodeSearcher（ripgrep + 回退 JS）
│   │       │   └── semantic.ts       # EmbeddingSearch（语义搜索）
│   │       └── lsp/                  # LSP 集成
│   │           └── lsp-manager.ts    # LSPManager（9 种语言服务器）
│   ├── knowledge/                    # 本地知识库（12 个源文件）
│   │   └── src/
│   │       ├── index.ts              # 统一导出
│   │       ├── types.ts              # 知识库类型定义
│   │       ├── constants.ts          # 常量（支持的文件类型等）
│   │       ├── chunking/             # 文本分块
│   │       │   └── text-chunker.ts   # TextChunker（滑动窗口 + 语义边界）
│   │       ├── classification/       # 文件分类
│   │       │   └── classifier.ts     # FileClassifier（MIME 类型 + 扩展名）
│   │       ├── extraction/           # 内容提取
│   │       │   ├── content-extractor.ts     # 多格式文本提取
│   │       │   └── external-extractor.ts    # 外部命令行提取器注册
│   │       ├── embedding/            # Embedding
│   │       │   └── embedding-provider.ts    # HashEmbeddingProvider
│   │       ├── dedup/                # 去重
│   │       │   ├── dedup-engine.ts          # DedupEngine（MinHash 去重）
│   │       │   └── relationship-detector.ts # 文件关系检测
│   │       ├── vector/               # 向量存储
│   │       │   ├── chroma-store.ts          # ChromaDB 向量存储
│   │       │   ├── vector-indexer.ts        # VectorIndexer
│   │       │   ├── collection-manager.ts    # 集合管理（全局/项目级）
│   │       │   └── types.ts                 # 向量存储类型
│   │       ├── core/                 # 核心管理
│   │       │   ├── knowledge-base-manager.ts  # KnowledgeBaseManager
│   │       │   ├── multi-project-manager.ts   # MultiProjectManager
│   │       │   ├── file-scanner.ts            # 文件扫描 + 增量同步
│   │       │   ├── change-tracker.ts          # 变更追踪
│   │       │   ├── index-state-store.ts       # 索引状态存储（SQLite）
│   │       │   ├── project-config.ts          # 项目配置管理
│   │       │   ├── project-id.ts              # 项目 ID 计算
│   │       │   └── project-registry.ts        # 项目注册表
│   │       ├── search/               # 联合搜索
│   │       │   └── federation-search.ts       # FederationSearch
│   │       └── server/               # Web 管理
│   │           └── dashboard-server.ts        # 知识库 Dashboard
│   ├── engine/                       # 核心引擎（19 个源文件）
│   │   └── src/
│   │       ├── index.ts              # 统一导出
│   │       ├── tools/                # 工具注册与适配
│   │       │   ├── registry.ts       # ToolRegistry（中心化注册/分发）
│   │       │   └── adapter.ts        # SchemaAdapter（OpenAI/Anthropic/MCP 格式转换）
│   │       ├── security/             # 安全与权限
│   │       │   ├── capability.ts     # Capability 枚举 + ROLE_CAPABILITY_MAP
│   │       │   └── permissions.ts    # PermissionEngine（三层权限 + 路径/命令匹配）
│   │       ├── core/                 # 核心控制
│   │       │   ├── execution-controller.ts  # ExecutionController（4 层保护）
│   │       │   ├── context-manager.ts # ContextManager（三级水位压缩）
│   │       │   ├── planner.ts        # PlanModeManager（只读探索）
│   │       │   └── tool-loop-runner.ts # 工具循环运行器
│   │       ├── orchestration/        # 子智能体编排
│   │       │   ├── orchestrator.ts   # Orchestrator（三种协作模式）
│   │       │   ├── isolation.ts      # 多策略子 Agent 隔离（Git Worktree + 内存快照）
│   │       │   └── subagent/         # 子智能体
│   │       │       ├── runner.ts     # SubagentRunner
│   │       │       ├── builtins.ts   # 内置子智能体定义
│   │       │       └── types.ts      # 子智能体类型
│   │       ├── extensions/           # 扩展
│   │       │   ├── mcp-server.ts     # McpServer（stdio JSON-RPC 2.0）
│   │       │   ├── mcp-client.ts     # McpClient（连接外部 MCP 服务器）
│   │       │   ├── hooks.ts          # HooksEngine（6 事件钩子）
│   │       │   └── skills.ts         # SkillsLoader（Markdown 技能包加载）
│   │       └── utils/
│   │           └── json-rpc.ts       # JSON-RPC 2.0 工具
│   ├── runtime/                      # 运行时与配置（3 个源文件）
│   │   └── src/
│   │       ├── index.ts              # 统一导出
│   │       ├── config-store.ts       # ConfigStore + ModelRegistry + 协议推断
│   │       └── telemetry/
│   │           └── audit-logger.ts   # AuditLogger（JSONL 审计日志）
│   └── memory/                       # 跨会话记忆（2 个源文件）
│       └── src/
│           ├── index.ts              # 统一导出
│           └── manager.ts            # MemoryManager（SQLite + FTS5）
├── Dockerfile.sandbox                # Docker 沙箱镜像
├── eslint.config.mjs                 # ESLint 配置
├── tsconfig.base.json                # 共享 TypeScript 配置
├── turbo.json                        # Turborepo 构建流水线
├── vitest.config.ts                  # Vitest 测试配置
├── pnpm-workspace.yaml               # pnpm workspace 定义
├── pnpm-lock.yaml                    # 依赖锁文件
├── set-claude-env.sh                 # Claude Code 通过 DeepSeek V4 代理配置
├── .changeset/                       # Changesets 版本管理配置
│   ├── config.json                   # Changesets 配置
│   └── README.md                     # Changesets 工作流说明
├── .github/workflows/                # CI/CD 流水线 (ci.yml + release.yml)
├── docs/
│   └── knowledge-base-design.md      # 本地知识库系统完整设计方案
└── README.md                         # 本文件
```

---

## 包详解

### @customize-agent/types

**跨包类型契约层 — 零外部依赖**

所有包共享的基础类型定义，确保类型安全且零运行时开销。

| 导出 | 说明 |
|------|------|
| `Message` | LLM 对话消息 `{ role, content, toolCalls?, toolCallId? }` |
| `LLMResponse` | LLM 响应 `{ content, thinkingContent?, toolCalls?, usage?, vendorExtensions? }` |
| `ToolCall` | 工具调用 `{ id, name, arguments, vendorExtensions? }` |
| `StreamChunk` | 流式块联合类型 `content \| thinking \| tool_call_preview \| tool_call \| error \| reset \| done` |
| `FunctionDefinition` | 供应商无关的工具定义 `{ name, description, parameters }` |
| `LifecycleAware` | 组件生命周期接口 `{ init?, shutdown?, healthCheck?, restart? }` |
| `Session` | 会话元数据 `{ id, createdAt, messageCount, projectRoot }` |
| `TaskState` | 任务状态 `{ status, round, checkpointCount, toolCalls }` |
| `Checkpoint` | 检查点 `{ id, taskId, round, snapshot, type }` |
| `BINARY_EXTENSIONS` | 已知二进制扩展名 Set（pdf, png, zip, exe 等） |
| `AgentError` / `ToolError` / `ProviderError` / 等 | 统一错误类型（含错误码、可重试标记、上下文信息） |

### @customize-agent/llm

**AI 模型 Provider + 自动路由网关**

统一的 LLM Provider 接口，封装 6 个供应商的差异。4 个 OpenAI 兼容供应商共享抽象基类。

| 导出 | 说明 |
|------|------|
| `ILLMProvider` | 统一 LLM Provider 接口 `{ chat(), chatStream(), countTokens(), healthCheck(), embed() }` |
| `OpenAICompatProvider` | OpenAI 兼容抽象基类（封装 ~90% 重复逻辑） |
| `OpenAIProvider` | OpenAI API Provider |
| `DeepSeekProvider` | DeepSeek API Provider |
| `OpenRouterProvider` | OpenRouter API Provider |
| `OllamaProvider` | 本地 Ollama Provider |
| `AnthropicProvider` | Anthropic 原生 API Provider |
| `GoogleProvider` | Google AI (Gemini) 原生 API Provider |
| `createProvider(name, opts)` | Provider 工厂函数：`name → Provider 实例` |
| `estimateTokens(text)` | Token 估算（约 3.5 字符/token） |
| `countTokensFromMessages(messages)` | 消息级 Token 计数 |
| `estimateCostUsd(usage, provider, model)` | 成本估算（美元） |
| `getModelPricing(provider, model)` | 获取模型定价信息 |
| `toOpenAIMessages(messages)` | 消息格式转换 |
| `withRetry(fn, opts)` | 指数退避重试装饰器 |
| `isRetryableError(error)` | 判断错误是否可重试 |

**重试策略：** 默认 3 次重试，指数退避（1s → 2s → 4s），仅重试 429/5xx 和网络错误，4xx 状态码直接抛出。

### @customize-agent/tools

**Agent 工具 — 文件操作、终端、Git、沙箱、语法验证、多媒体处理**

按功能域拆分为 8 组内置工具，通过外观类统一暴露。

| 导出 | 说明 |
|------|------|
| `ToolKit` | 高质量文件操作（.gitignore 感知、备份/回滚、语法验证） |
| `BuiltinTools` | CLI 所有内置工具的外观类（向后兼容） |
| `WorkspaceFs` | 工作区安全路径解析与基础文件操作 |
| `WorkspaceSnapshotService` | 工作区快照/检查点（创建、恢复、删除、列表） |
| `SandboxExecutor` | 沙箱执行器（Seatbelt/Bubblewrap/Docker/VFS-Guard） |
| `DiffEngine` | SEARCH/REPLACE 解析 + Unified Diff 生成 |
| `UnifiedSyntaxValidator` | tree-sitter 通用语法验证（11 种语言） |
| `resolveSafe(path)` | 安全路径解析（防路径穿越） |
| `walk(dir)` | 递归目录遍历（.gitignore 感知） |
| `SKIP_DIRS` | 默认跳过目录 Set（node_modules, .git 等） |
| `FileTools` | 文件操作工具组（read/write/edit/delete/move/copy/mkdir/stat 等） |
| `SearchTools` | 搜索工具组（ripgrep 搜索、符号搜索、repo map 生成） |
| `ShellTools` | Shell 工具组（命令执行、后台任务、测试/构建/检查运行） |
| `WebTools` | 网络工具组（web_search, web_fetch, download_file, open_preview） |
| `ExportTools` | 导出工具组（markdown/json/html/pdf/session 导出、zip 打包） |
| `MediaTools` | 多媒体工具组（文本提取、OCR、音频转写、视频元数据、图片压缩） |
| `McpTools` | MCP 配置工具组（mcp list/add/remove/tools） |
| `CheckpointTools` | 检查点工具组（create/list/restore/delete） |

**语法验证支持语言：** C, C++, Go, Java, JavaScript, PHP, Python, Ruby, TypeScript, TypeScript-React (TSX), Rust（11 种语言的 tree-sitter 语法）。

### @customize-agent/search

**代码智能 — tree-sitter 索引、ripgrep 搜索、LSP、语义搜索**

分层代码理解方案：L1 文本搜索（ripgrep）→ L2 符号索引（tree-sitter AST + SQLite FTS5）→ L3 语义搜索（LLM Embedding）。

| 导出 | 说明 |
|------|------|
| `StorageManager` | SQLite 文件索引 + FTS5 全文搜索 + Embedding 持久化 |
| `RepositoryIndexer` | tree-sitter AST 符号提取（11 种语言，大小文件分流） |
| `TreeSitterWorkerPool` | Worker 线程池（大文件异步解析，不阻塞主线程） |
| `CodeSearcher` | ripgrep 文本搜索（原生 rg 优先，不可用时回退 JS 实现） |
| `EmbeddingSearch` | LLM Embedding 语义搜索 |
| `LSPManager` | vscode-jsonrpc LSP 客户端（9 种语言服务器支持） |
| `getLanguageConfig(ext)` | 根据文件扩展名获取语言配置 |
| `getSupportedExtensions()` | 获取所有支持的文件扩展名 |
| `extractSymbolName(node)` | 从 tree-sitter AST 节点提取符号名 |
| `collectAstErrors(tree)` | 收集 AST 中的语法错误节点 |

**大小文件分流策略：** 大文件（> 1MB）使用 Worker 线程异步解析，避免阻塞主线程。符号索引懒加载，首次搜索时按需构建，后续增量更新（检查 mtime）。

**LSP 支持语言：** TypeScript/JavaScript, Python, Go, Rust, Java, C/C++, Ruby, PHP, JSON（9 种语言服务器）。

### @customize-agent/knowledge

**本地知识库 — 多格式文件解析、向量化检索、联合搜索**

为 Agent 提供本地文件的知识检索能力。支持 PDF、Word、Excel、图片、CAD 图纸等多种格式的解析和向量化，通过 ChromaDB 存储向量并支持联合搜索。

| 导出 | 说明 |
|------|------|
| `KnowledgeBaseManager` | 知识库管理器（扫描、解析、索引、检索的统一入口） |
| `MultiProjectManager` | 多项目管理器（支持多个项目独立知识库） |
| `KnowledgeFileScanner` | 文件扫描器（增量同步，检测新增/修改/删除） |
| `ChangeTracker` | 变更追踪器（基于 mtime + 哈希的文件变更检测） |
| `ContentExtractor` | 内容提取器（PDF/Word/Excel/图片 OCR/图纸等多格式） |
| `ExternalExtractorRegistry` | 外部提取器注册表（支持命令行工具扩展） |
| `TextChunker` | 文本分块器（滑动窗口 + 语义边界，可配置 chunk 大小） |
| `FileClassifier` | 文件分类器（MIME 类型识别 + 扩展名映射） |
| `DedupEngine` | 去重引擎（MinHash + LSH 局部敏感哈希去重） |
| `RelationshipDetector` | 文件关系检测器（检测文件间的引用和依赖关系） |
| `HashEmbeddingProvider` | 哈希 Embedding 提供者（轻量级文本向量化） |
| `ChromaVectorStore` | ChromaDB 向量存储（ChromaDB HTTP 客户端封装） |
| `VectorIndexer` | 向量索引器（批量文本向量化 + 存储） |
| `CollectionManager` | 集合管理器（全局集合 + 项目级集合隔离） |
| `FederationSearch` | 联合搜索引擎（跨项目 + 跨格式统一检索） |
| `IndexStateStore` | 索引状态存储（SQLite，文件哈希 + chunk 映射） |
| `ProjectRegistry` | 项目注册表（管理所有已索引项目） |
| `ProjectConfigManager` | 项目配置管理器（项目级知识库配置） |
| `startKnowledgeDashboard` | 启动 Web 管理页面（Express 服务器） |

**支持的文件格式：**

| 类别 | 格式 | 解析方式 |
|------|------|------|
| 文档 | PDF, Word (.docx), PPT (.pptx) | pdf-parse, mammoth, 内置解析 |
| 表格 | Excel (.xlsx/.xls), CSV, TSV | xlsx 库，含工作表和公式 |
| 图片 | PNG, JPG, GIF, BMP, TIFF | Tesseract.js OCR |
| 图纸 | DXF, STEP, IGES, OBJ, GLTF, STL, 3MF | 文本提取 + 元数据 |
| 代码 | JS, TS, Python, Rust, Go 等 | 直接文本 + AST 增强 |
| 数据 | JSON, YAML, XML, HTML | 结构化解析 |
| 压缩包 | ZIP, TAR, GZ | 清单提取 + 内容递归解析 |

**知识库目录结构：**

首次启动会在用户项目根目录自动生成：

```text
knowledgeBase/
  文档资料/
  表格数据/
  图片素材/
  图纸文件/
  代码文件/
  数据文件/
  网页文件/
  图表流程/
  压缩包/
  其他文件/
```

用户可将文件放入对应目录，Agent 自动增量同步和索引。

### @customize-agent/engine

**Agent 引擎 — 工具注册、权限控制、执行调度、子智能体编排、MCP、Hooks**

核心引擎包，包含工具注册分发、权限检查、执行控制、上下文管理、子智能体编排、MCP 协议和 Hooks 系统。

| 导出 | 说明 |
|------|------|
| `ToolRegistry` | 中心化工具注册、查找和分发 |
| `SchemaAdapter` | 工具 Schema → OpenAI/Anthropic/MCP 格式转换 |
| `PermissionEngine` | 三层权限引擎（allow/deny/ask）+ 路径 glob 匹配 + 命令模式匹配 |
| `ExecutionController` | 四层执行控制器（LoopGuard + BudgetManager + GoalManager + CheckpointManager） |
| `LoopGuard` | 语义死循环检测（连续 N 轮相同 tool+args+result 哈希） |
| `BudgetManager` | 财务熔断器（累计费用超限自动停止） |
| `GoalManager` | 任务完成检测（`<task_finish>` 标记 + 里程碑事件 + LLM 评估器） |
| `CheckpointManager` | 人机检查点（每 N 轮暂停等待确认） |
| `ContextManager` | 上下文管理（收集 → 排序 → 裁剪 → 压缩，三级水位） |
| `PlanModeManager` | 只读探索模式（生成 JSON 格式执行计划） |
| `SubagentRunner` | 子智能体运行器（独立上下文 + 独立 LLM 循环 + 完成标记） |
| `Orchestrator` | 多智能体编排（Orchestrator DAG / Pipeline / Swarm 三种模式） |
| `GitWorktreeIsolation` / `SnapshotIsolation` | 子 Agent 隔离策略（Git Worktree + 内存快照，自动检测降级） |
| `McpServer` | MCP stdio 服务端（JSON-RPC 2.0），暴露工具给外部客户端 |
| `McpClient` | MCP 客户端，连接外部 MCP 服务器并注册工具 |
| `HooksEngine` | 6 事件生命周期钩子系统（command 和 prompt 两种类型） |
| `SkillsLoader` | Markdown 技能包加载器 |
| `Capability` | 能力枚举（READ_CODE, WRITE_CODE, SEARCH_SYMBOL, EXECUTE_COMMAND 等 10 种） |
| `ROLE_CAPABILITY_MAP` | 子智能体角色 → 能力映射表 |
| `buildToolDefinitions(registry)` | 从 ToolRegistry 构建格式化的工具定义列表 |
| `runToolLoop(history, registry, provider, opts)` | 核心工具循环运行器 |

### @customize-agent/runtime

**Agent Runtime — 配置持久化 + 模型注册 + 遥测**

所有入口点（CLI, MCP Server, 子智能体）复用的统一调度层。

| 导出 | 说明 |
|------|------|
| `ConfigStore` | 用户配置持久化到 `~/.customize-agent/config.json` |
| `ModelRegistry` | 三层模型注册中心（reader/reasoning/action），含回退链解析 |
| `detectProtocol(name)` | Provider 协议自动推断 |
| `resolveProtocol(name, config?)` | 协议解析（自动推断 + 手动覆盖） |
| `AuditLogger` | JSONL 格式审计日志 |
| `UserConfig` | 用户配置类型 |
| `ModelTier` | 模型层级类型（`'reader' \| 'reasoning' \| 'action'`） |
| `ModelEntry` | 模型条目 `{ name, provider }` |
| `TierConfig` | 层级配置 `{ active, list }` |
| `ProviderConfig` | Provider 配置 `{ apiKey?, baseUrl?, protocol? }` |

### @customize-agent/memory

**跨会话记忆系统 — SQLite + FTS5 全文搜索**

持久化存储在 `~/.customize-agent/memory.db`，支持跨会话的记忆累积和检索。

| 导出 | 说明 |
|------|------|
| `MemoryManager` | 记忆 CRUD + FTS5 全文搜索 + LIKE 回退 + FNV-1a 去重 |

**4 种记忆类型：**

| 类型 | 说明 | 生命周期 |
|------|------|------|
| `project_fact` | 项目架构、模块依赖、构建系统信息 | 长期（项目存活期间） |
| `user_preference` | 编码风格、命名约定、工具偏好 | 长期（用户级） |
| `feedback` | 用户纠正记录（如"不要改 package-lock.json"） | 中期（可累积覆盖） |
| `pattern` | 常见问题的解决模式 | 长期（跨项目复用） |

**去重策略：** 使用 FNV-1a 哈希对内容生成指纹，相同哈希判定为重复且拒绝写入。冲突检测（不同内容相同哈希）会触发重新计算。

**检索评分：** `score = 1 / (1 + bm25_rank) × log(1 + access_count)`，平衡了语义相关性和使用频率。

### CLI App

**终端入口应用 — Commander CLI + REPL + 双语 TUI**

`customize-agent` 包（`apps/cli`），npm 包名为 `customize-agent`，安装后暴露 `customize` 二进制命令。

3 种运行模式：

| 模式 | 命令 | 说明 |
|------|------|------|
| 交互式 REPL | `pnpm start:cli` | 全功能 TUI，支持所有命令和交互 |
| 单次执行 | `pnpm start:cli -- -p "task"` | 非交互式，执行后输出结果并退出 |
| Plan 模式 | `pnpm start:cli -- -p "task" --plan` | 只读探索，生成执行计划不修改文件 |
| MCP Server | `pnpm start:cli -- mcp-server` | stdio JSON-RPC 模式，供外部客户端使用 |

---

## 核心架构

### 整体数据流

```
用户输入 → TuiInput (raw mode keypress)
  → Repl._execute()
    → AgentExecutor.runTask()
      → Provider.chatStream(tools) ← SchemaAdapter.toProvider(registry)
        → LLM Response (content + toolCalls)
      → ToolRegistry.dispatch(toolCall)
        → PermissionEngine.check()
        → FileTools / SearchTools / ShellTools / ...
      → ExecutionController.evaluate()
        → continue / stop / replan / pause
    → TuiRenderer.show() → 展示结果给用户
```

### AgentExecutor 主循环

```
while (未完成) {
  1. 构建系统提示词 (内置规则 + CUSTOMIZE.md + repoMap)
  2. ContextManager.compactMessages() — 压缩上下文
  3. Provider.chatStream(messages, tools) — 流式调用 LLM
  4. 解析响应 (content + thinkingContent + toolCalls)
  5. 如果没有 toolCalls → 展示结果，检查完成
  6. 如果有 toolCalls → 逐个执行:
     a. ToolRegistry.dispatch(toolCall)
     b. PermissionEngine.check(tool, args)
     c. 如果需要审批 → 弹出 TUI 审批弹窗
     d. 执行工具 → 收集结果
  7. ExecutionController.evaluate()
     a. L1 LoopGuard — 死循环检测
     b. L2 BudgetManager — 预算检查
     c. L3 GoalManager — 完成检测
     d. L4 CheckpointManager — 人工确认点
  8. 根据评估结果 → continue / stop / replan / pause
}
```

### 系统提示词双层架构

```
┌─────────────────────────────────────────────────────────────────┐
│ 内置规则 (prompt.ts, 中文)        │ CUSTOMIZE.md (项目根, 可选)   │
├───────────────────────────────────┼──────────────────────────────┤
│ 核心协议（Think-Act-Observe）      │ 角色定义                      │
│ 安全红线（不泄露/不破坏）          │ 领域规则                      │
│ 工具使用规范                      │ 技术栈/约定                    │
│ 质量要求（验证/熔断）              │ 偏好工具                      │
│ 上下文管理（三级水位）             │ 项目结构                      │
│ 交互风格                          │ 业务约束                      │
│ 身份认知 + 环境识别               │ （用户自定义，优先级高于内置） │
└───────────────────────────────────┴──────────────────────────────┘
```

CUSTOMIZE.md 规则优先于内置规则。不创建则仅使用内置规则。

**内置规则关键内容：**
- 必须在回答前思考（think before acting）
- 使用工具前验证路径安全性
- 修改代码后验证语法
- 敏感操作（删除、强制推送）需要用户确认
- 无法确定时主动询问而非猜测
- 上下文中 token 使用情况可视化

### 工具分发链

```
ToolRegistry.register(toolDef)
  → SchemaAdapter.toOpenAIFunction(toolDef)    // 转为 OpenAI Function Calling 格式
  → SchemaAdapter.toAnthropicTool(toolDef)     // 转为 Anthropic Tool Use 格式
  → SchemaAdapter.toMcpTool(toolDef)           // 转为 MCP Tool 格式
  → Provider.chat(messages, tools)             // 原生 Function Calling，不解析 XML
  → AgentExecutor 使用原生 function calling，不解析 XML
```

---

## 完整工具集

CLI 中注册了 50+ 工具，按功能域分类如下：

### 文件操作（FileTools）

| 工具 | 功能 | 审批 |
|------|------|:--:|
| `read_file` | 路径沙箱内读文件（分页/二进制检测） | 否 |
| `write_file` | 创建/覆盖文件 + 备份回滚 | 是 |
| `edit_file` | SEARCH/REPLACE 精确字符串替换 | 是 |
| `multi_edit` | 单文件多处编辑（事务性，原子提交/回滚） | 是 |
| `delete_file` | 删除文件（移入回收站） | 是 |
| `move_file` | 移动/重命名文件 | 是 |
| `copy_file` | 复制文件 | 否 |
| `mkdir` | 创建目录 | 否 |
| `stat_file` | 查看文件元信息（大小、权限、mtime） | 否 |
| `inspect_file` | 检查文件信息：行数、编码、二进制判断 | 否 |
| `list_files` | 列出项目文件（.gitignore 感知 + 自定义忽略规则） | 否 |
| `tree` | 目录树展示 | 否 |

### 搜索（SearchTools）

| 工具 | 功能 | 审批 |
|------|------|:--:|
| `search` | 全文搜索（ripgrep），支持正则和文件类型过滤 | 否 |
| `symbol_search` | tree-sitter AST 符号搜索（函数/类/变量定义） | 否 |
| `dependency_graph` | 模块依赖关系图谱 | 否 |
| `repo_map` | 生成项目结构快照（目录树 + 关键符号摘要） | 否 |

### Shell/终端（ShellTools）

| 工具 | 功能 | 审批 |
|------|------|:--:|
| `execute_command` | 终端命令执行（沙箱隔离） | 是 |
| `run_background` | 后台运行长时间任务 | 是 |
| `check_command` | 检查后台任务状态 | 否 |
| `stop_command` | 停止后台任务 | 是 |
| `run_test` | 运行项目测试 | 是 |
| `run_build` | 运行项目构建 | 是 |
| `run_lint` | 运行项目 lint 检查 | 否 |

### Git（内置在 ShellTools 中）

| 工具 | 功能 | 审批 |
|------|------|:--:|
| `git_status` | 查看工作区状态 | 否 |
| `git_diff` | 查看差异（staged/unstaged） | 否 |
| `git_log` | 查看提交历史 | 否 |
| `git_stash` | 暂存/恢复工作区 | 是 |
| `git_commit` | 暂存 + 提交 | 是 |
| `git_apply_patch` | 应用补丁 | 是 |
| `git_create_patch` | 创建补丁 | 否 |

### 网络（WebTools）

| 工具 | 功能 | 审批 |
|------|------|:--:|
| `web_search` | 网络搜索（返回标题 + URL + 摘要） | 否 |
| `web_fetch` | 获取 URL 内容并转为 Markdown | 否 |
| `download_file` | 下载文件到工作区 | 是 |
| `browser_open` | 在浏览器中打开 URL | 是 |
| `open_preview` | 在工作区启动本地预览（HTML/图片） | 否 |

### 导出与打包（ExportTools）

| 工具 | 功能 | 审批 |
|------|------|:--:|
| `export_markdown` | 导出对话结果为 Markdown | 否 |
| `export_json` | 导出对话结果为 JSON | 否 |
| `export_html` | 导出对话结果为 HTML | 否 |
| `export_pdf` | 导出对话结果为 PDF | 否 |
| `export_session` | 导出完整会话记录 | 否 |
| `zip_files` | 打包文件为 ZIP | 是 |

### 多媒体处理（MediaTools）

| 工具 | 功能 | 审批 |
|------|------|:--:|
| `extract_text` | 通用文本提取（自动识别文件类型） | 否 |
| `extract_pdf_text` | PDF 文本提取 | 否 |
| `extract_docx_text` | Word 文档文本提取 | 否 |
| `extract_xlsx_data` | Excel 表格数据提取 | 否 |
| `ocr_image` | 图像 OCR 文字识别（Tesseract.js） | 否 |
| `transcribe_audio` | 音频转写 | 否 |
| `video_metadata` | 视频元信息提取 | 否 |
| `convert_file` | 文件格式转换 | 是 |
| `compress_image` | 图片压缩（sharp） | 是 |
| `generate_thumbnail` | 生成缩略图 | 否 |

### MCP/Plugin 管理（McpTools）

| 工具 | 功能 | 审批 |
|------|------|:--:|
| `mcp_list` | 列出已连接的 MCP 服务器 | 否 |
| `mcp_add` | 添加 MCP 服务器配置 | 是 |
| `mcp_remove` | 移除 MCP 服务器 | 是 |
| `mcp_tools` | 查看 MCP 服务器提供的工具列表 | 否 |
| `plugin_list` | 列出已安装插件 | 否 |
| `plugin_install` | 安装插件 | 是 |

### 检查点（CheckpointTools）

| 工具 | 功能 | 审批 |
|------|------|:--:|
| `checkpoint_create` | 创建工作区快照 | 是 |
| `checkpoint_list` | 列出所有快照 | 否 |
| `checkpoint_restore` | 恢复到指定快照 | 是 |
| `checkpoint_delete` | 删除快照 | 是 |

### 知识库

| 工具 | 功能 | 审批 |
|------|------|:--:|
| `knowledge_search` | 搜索本地知识库（向量 + 关键词联合检索） | 否 |
| `knowledge_overview` | 查看知识库概览 | 否 |
| `knowledge_list` | 列出已索引文件 | 否 |
| `knowledge_reindex` | 手动触发重新索引 | 是 |

### LSP 工具

| 工具 | 功能 | 审批 |
|------|------|:--:|
| `lsp_definition` | 跳转到符号定义 | 否 |
| `lsp_references` | 查找符号引用 | 否 |
| `lsp_diagnostics` | LSP 诊断（错误/警告/提示） | 否 |

### 其他工具

| 工具 | 功能 | 审批 |
|------|------|:--:|
| `todo_write` | 写入任务列表 | 否 |
| `doctor` | 工具链诊断 | 否 |
| `version` | 显示版本信息 | 否 |
| `tool_health` | 工具健康检查 | 否 |
| `check_update` | 检查更新 | 否 |
| `update` | 执行更新 | 是 |
| `orchestrate_agents` | 多智能体编排 | 是 |

---

## 模型三层架构

```
Reader (读取层)    →  Reasoning (推理层)  →  Action (执行层)
  读文件                分析代码                修改文件
  搜索符号              制定方案                执行命令
  浏览代码              整合信息                Git 操作
  [便宜模型]            [强推理模型]            [精准模型]
```

**三层职责：**

| 层级 | 典型任务 | 推荐模型要求 |
|------|------|------|
| **Reader** (读取层) | 读取文件、浏览代码、搜索符号 | 便宜、快速、大上下文窗口 |
| **Reasoning** (推理层) | 分析代码逻辑、设计方案、整合信息 | 强推理能力、准确度高 |
| **Action** (执行层) | 修改文件、执行命令、Git 操作 | 精准、工具调用可靠 |

**回退规则：** 某层未配置模型 → `reasoning → action → reader` 优先级查找。只配一层则所有任务共用一个模型。

**配置示例：**

```
/model add reader deepseek deepseek-chat          # 读取层用便宜模型
/model add reasoning deepseek deepseek-v4-pro     # 推理层用强模型
/model add action deepseek deepseek-v4-flash      # 执行层用快速模型
/model key deepseek sk-xxx                        # 一个 Key 覆盖所有层
```

---

## Provider 与协议

### 支持的 Provider

| Provider | 默认协议 | Base URL | 实现方式 |
|----------|:--:|------|------|
| `deepseek` | openai | api.deepseek.com/v1 | OpenAI 兼容基类（~30 行） |
| `openai` | openai | api.openai.com/v1 | OpenAI 兼容基类（~30 行） |
| `openrouter` | openai | openrouter.ai/api/v1 | OpenAI 兼容基类（~30 行） |
| `ollama` | openai | localhost:11434/v1 | OpenAI 兼容基类（~30 行） |
| `anthropic` | anthropic | api.anthropic.com/v1 | 原生 Anthropic SDK |
| `google` | google | generativelanguage.googleapis.com | 原生 Google API |
| 其他自定义 | openai | 用户指定 | OpenAI 兼容基类 |

### 协议自动推断

系统根据 Provider 名称自动推断 API 协议，无需手动指定：
- `deepseek`/`openai`/`openrouter`/`ollama` → `openai` 协议
- `anthropic` → `anthropic` 协议
- `google` → `google` 协议

手动覆盖：`/provider protocol my-custom-api anthropic`

### API Key 优先级

```
/provider key 设置  >  环境变量 CUSTOMIZE_AGENT_{NAME}_API_KEY  >  SDK 默认查找
```

API Key 属于 Provider 而非 Model — 同厂商多模型共享 Key，减少重复配置。

---

## 沙箱系统

命令执行通过 `SandboxExecutor` 进行安全隔离，支持 4+1 种沙箱模式：

### 沙箱模式对比

| 模式 | 平台 | 隔离级别 | 启动时间 | 适用场景 |
|------|------|------|------|------|
| `workspace-write` (默认) | macOS Seatbelt / Linux Bubblewrap | 内核级 | < 10ms | 日常开发 |
| `read-only` | 同上 + 写命令拦截 | 内核级 | < 10ms | 代码审查/分析 |
| `danger-full-access` | 需环境变量确认 | 无隔离 | 0ms | 紧急/信任环境 |
| `vfs-guard` (回退) | 跨平台 JS 纯虚拟沙箱 | 进程级 | < 1ms | 内核沙箱不可用时 |
| `docker` | 需要 Docker daemon | 容器级 | ~1s | 数据分析/不可信代码 |

### 沙箱启动流程

```
SandboxExecutor.preflight()
  → 检测平台 (macOS/Linux/其他)
  → 检测内核沙箱 binary (sandbox-exec / bwrap)
  → 可用 → workspace-write
  → 不可用 → 降级 vfs-guard + 打印安全警告
```

### VFS-Guard 降级策略

当内核沙箱不可用时，VFS-Guard 提供进程级隔离：
- 路径白名单（仅限工作区目录 + 系统临时目录）
- 敏感目录拦截（/etc, /proc, ~/.ssh 等）
- 危险命令模式匹配（`rm -rf /`, `chmod 777 /` 等）
- sudo/doas 等提权命令强制拦截

---

## 执行控制

`ExecutionController` 实现四层保护，每轮工具调用后执行评估：

```
┌───────────────────────────────────────────────────┐
│ L1 LoopGuard      │ 连续 3 轮相同 tool+args+result │
│                    │ 哈希 → 死循环 → 强制 replan    │
├───────────────────┼────────────────────────────────┤
│ L2 BudgetManager  │ 累计费用 > $5（可配置）         │
│                    │ → 熔断停止 + 费用报告           │
├───────────────────┼────────────────────────────────┤
│ L3 GoalManager    │ <task_finish> 标记检测          │
│                    │ + 里程碑事件 + LLM GoalEvaluator │
├───────────────────┼────────────────────────────────┤
│ L4 CheckpointManager│ 每 15 轮暂停 → 等待人工确认    │
│                    │ 可跳过/继续/终止                │
└───────────────────────────────────────────────────┘
```

**LoopGuard 详细信息：**
- 记录每轮 `(toolName, argsHash, resultHash)` 三元组
- 连续 `threshold` 次（默认 4 次）匹配 → 判定死循环
- 触发后给出原因并强制 `replan`

**BudgetManager 详细信息：**
- 默认上限：$5 USD
- 记录每次 chat 调用的 token 用量 + 费用
- 超过上限后立即 `stop`，输出费用报告

**GoalManager 详细信息：**
- 检测 `<task_finish>` 标记（模型主动声明完成）
- 检测里程碑事件（关键工具执行成功 + 无后续调用）
- LLM GoalEvaluator：使用独立 LLM 调用判断任务是否真正完成

---

## 权限系统

`PermissionEngine` 实现三层权限模型，在工具执行前进行检查：

```
PermissionEngine.check(tool, args):
  → Capability 检查 (ROLE_CAPABILITY_MAP)
  → 路径 glob 匹配 (deny /etc/**, ~/.ssh/** 等敏感路径)
  → 命令模式匹配 (deny rm -rf /, chmod 777, sudo 等危险命令)
  → 默认策略 → allow / deny / ask
```

**三层权限：**

| 权限 | 说明 | 典型用例 |
|------|------|------|
| `allow` | 直接执行，无弹窗 | read_file, search, list_files |
| `deny` | 直接拒绝 + 提示原因 | 读取 .env, 执行 rm -rf / |
| `ask` | TUI 审批弹窗征求用户同意 | write_file, execute_command, git_commit |

**10 种能力（Capability）：**

| 能力 | 说明 |
|------|------|
| `READ_CODE` | 读取代码文件 |
| `WRITE_CODE` | 写入/修改代码文件 |
| `SEARCH_SYMBOL` | 搜索符号定义和引用 |
| `EXECUTE_COMMAND` | 执行 shell 命令 |
| `NETWORK` | 网络访问（搜索、获取 URL、下载） |
| `GIT_OPERATION` | Git 操作（commit, push, stash） |
| `LSP_QUERY` | LSP 定义/引用/诊断查询 |
| `MEMORY_ACCESS` | 跨会话记忆读写 |
| `MCP_EXTERNAL` | 外部 MCP 工具调用 |
| `EMBEDDING_SEARCH` | 语义搜索（调用 Embedding API） |

**子智能体角色能力映射：**

| 角色 | 能力 |
|------|------|
| `explorer` | READ_CODE, SEARCH_SYMBOL, LSP_QUERY, EMBEDDING_SEARCH |
| `planner` | READ_CODE, SEARCH_SYMBOL, LSP_QUERY, MEMORY_ACCESS |
| `implementer` | READ_CODE, WRITE_CODE, SEARCH_SYMBOL, EXECUTE_COMMAND |
| `reviewer` | READ_CODE, SEARCH_SYMBOL, LSP_QUERY, MEMORY_ACCESS |
| `tester` | READ_CODE, EXECUTE_COMMAND, LSP_QUERY |
| `conflict_resolver` | READ_CODE, WRITE_CODE, SEARCH_SYMBOL, GIT_OPERATION |

---

## 上下文管理

`ContextManager` 三级水位自动管理上下文，确保不超出 LLM 的 token 限制：

```
ContextManager.compactMessages():
  60% token → ⚠️ 警告（在 TUI 状态栏显示 token 使用率）
  75% token → 📐 轻量截断（旧工具结果截断至 200 字符）
  85% token → 🤖 LLM 摘要压缩（用生成的摘要替换旧消息）
```

**处理流程：**
1. **收集** — 按优先级收集消息（系统提示词 > 用户消息 > 工具调用结果）
2. **排序** — 按时间顺序 + 重要性评分（最近的 + 关键的在前）
3. **裁剪** — 75% 水位触发：旧工具结果（非错误结果）截断至 200 字符
4. **压缩** — 85% 水位触发：早期对话用 LLM 生成摘要替换原始消息

---

## 子智能体编排

`Orchestrator` 支持三种多智能体协作模式：

### Orchestrator（DAG 模式）

```
用户任务
  → Orchestrator 分析任务
    → 生成子任务 DAG
      → 按拓扑顺序分发到 SubagentRunner
        → 每个子智能体独立执行
          → Orchestrator 汇总结果
```

适用场景：复杂任务可拆分且有依赖关系时。

### Pipeline 模式

```
[阶段 1 Worker] → [阶段 2 Worker] → [阶段 3 Worker]
    浏览代码          设计方案            实现代码
```

每阶段一个工作者，流水线传递上下文。

### Swarm 模式

```
         ┌→ Worker A (方案 1) ─┐
用户任务 ─┼→ Worker B (方案 2) ─┼→ 评判模型 → 最优方案
         └→ Worker C (方案 3) ─┘
```

3 个并发工作者解决同一任务，评判模型选择最优方案。

**子智能体规格：**
- 独立 `Message[]` 历史
- 独立 `BudgetManager`（$1 上限）
- 独立 `LoopGuard`（3 次阈值）
- 通过 `<task_finish>` 标记完成
- 可选 Git Worktree 隔离（完全独立的文件系统）

---

## MCP 协议集成

### 作为 MCP Server

Customize Agent 可以作为 MCP Server 通过 stdio JSON-RPC 暴露工具：

```bash
pnpm start:cli -- mcp-server
```

支持的 MCP 方法：
- `initialize` — 握手，返回 server info + capabilities
- `tools/list` — 返回工具列表（含 schema）
- `tools/call` — 调用指定工具
- `ping` — 健康检查

**配置 Claude Desktop 使用 Customize Agent：**

```json
{
  "mcpServers": {
    "customize-agent": {
      "command": "node",
      "args": ["apps/cli/dist/index.js", "mcp-server"]
    }
  }
}
```

### 作为 MCP Client

Customize Agent 可以连接外部 MCP 服务器：

1. 配置 `~/.customize-agent/mcp.json`：
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-playwright"]
    }
  }
}
```

2. 外部工具注册到本地 ToolRegistry，命名规范：`mcp_{server}_{tool}`
3. 默认 `requiresApproval: true`（外部工具需要用户确认）

---

## Hooks 系统

`HooksEngine` 支持 6 个生命周期事件的自定义钩子：

| 事件 | 触发时机 | 典型用途 |
|------|------|------|
| `on_session_start` | 会话启动时 | 加载项目配置、检查环境 |
| `pre_tool_call` | 工具调用前 | lint 检查、pre-commit 验证 |
| `post_tool_call` | 工具调用后 | 记录日志、触发通知 |
| `pre_task_finish` | 任务完成前 | 运行完整测试套件 |
| `on_error` | 发生错误时 | 错误诊断、自动恢复 |
| `on_session_end` | 会话结束时 | 清理资源、生成报告 |

**两种钩子类型：**

| 类型 | 说明 | 超时 |
|------|------|:--:|
| `command` | 执行 shell 命令（通过沙箱） | 60s 可配置 |
| `prompt` | 注入提示词到 LLM 上下文 | N/A |

**配置示例（~/.customize-agent/config.json）：**

```json
{
  "hooks": [
    {
      "name": "pre-commit-check",
      "event": "pre_tool_call",
      "condition": "toolName === 'git_commit'",
      "type": "command",
      "action": "pnpm run typecheck && pnpm run lint && pnpm run test",
      "timeout": 120000
    }
  ]
}
```

---

## 跨会话记忆

记忆系统基于 SQLite + FTS5 全文搜索，存储在 `~/.customize-agent/memory.db`：

### 记忆生命周期

```
写入 → FNV-1a 哈希去重 → SQLite 持久化 → FTS5 索引
检索 → FTS5 全文搜索 → LIKE 回退 → 相关性评分排序 → 注入系统提示词
淘汰 → access_count 衰减 + 时间衰减 → 低分记忆自动清理
```

### 检索评分算法

```
score = 1 / (1 + bm25_rank) × log(1 + access_count)
```

- `bm25_rank` — FTS5 BM25 排序（越低越相关）
- `access_count` — 访问频率（越高分越高）
- 加权后确保高频相关记忆优先注入

### 记忆注入策略

- 每次会话启动时：注入 Top-5 `project_fact` + Top-3 `user_preference`
- 工具调用前后：检索相关 `pattern` 记忆辅助执行
- 用户纠正时：自动写入 `feedback` 记忆

---

## 本地知识库

本地知识库由 `@customize-agent/knowledge` 包提供，支持多格式文件解析与向量化检索。

### 知识库目录

首次启动会在用户项目根目录自动生成：

```text
CUSTOMIZE.md
knowledgeBase/
  文档资料/
  表格数据/
  图片素材/
  图纸文件/
  代码文件/
  数据文件/
  网页文件/
  图表流程/
  压缩包/
  其他文件/
```

你可以通过 Web 页面上传资料，也可以直接把文件放入 `knowledgeBase`。文件管理页和智能体检索会自动增量同步本地变更。

### 支持的文件格式

知识库支持解析并向量化：

- PDF、Word、PPT、Office 文档
- Excel、CSV、TSV 等表格，包含工作表、单元格、公式和合并区域
- 图片 OCR
- DXF、STEP、IGES、OBJ、GLTF、STL、3MF、DWG/SolidWorks 等图纸或模型资料
- JSON、YAML、XML、HTML、Markdown、代码和压缩包清单

主智能体会自动注入相关知识库上下文；子智能体也可以使用 `knowledge_search` 工具检索同一个用户项目知识库。

### 常用命令

```bash
/kb overview          # 查看知识库概览
/kb list [keyword]    # 查看已解析入库文件
/kb search <query>    # 搜索本地知识库
/kb dashboard         # 打开 Web 管理页面
/kb reindex           # 手动重新同步和索引
```

---

## 文件索引与符号搜索

### @ 文件模糊补全

```
首次 @ → git ls-files（毫秒级）→ fallback fast-glob
后续按键 → 子串匹配 + (匹配位置 × 10000 + 路径长度) 评分 → top 12
Tab 键 → 自动补全最长公共前缀
```

### 符号搜索

```
首次调用 → lazy-index tree-sitter AST → SQLite FTS5
后续调用 → 增量索引 (mtime 检查) → FTS5 MATCH
大文件 → Worker 线程异步解析，不阻塞主线程
```

---

## TUI 界面

### 欢迎横幅

启动后显示 4×6 像素字标题 + 天蓝→紫渐变：

```
╭──────────────────────────────────────────╮
│      ██  █  █  ███  ████  ███           │  ← 自定义标题
│     █  █ █  █ █    █  █ █  █           │  ← 4×6 像素字体
│     █  █ █  █  ██  █  █ █  █           │  ← 天蓝(#00BFFF)→紫(#8B00FF)渐变
│     █  █ █  █    █ █  █ █  █           │
│     █  █ █  █    █ █  █ █  █           │
│      ██   ███  ███  ████  ███           │
│                                          │
│               v1.0.0                     │
│        Provider  deepseek/...            │
│                                          │
│    ▶  输入任务开始  @ 引用文件  / 命令    │
╰──────────────────────────────────────────╯
  AGENT  │  ➜ _
```

### 交互功能

| 功能 | 触发 | 说明 |
|------|------|------|
| 文件下拉菜单 | `@` | 模糊匹配 + 子串评分，↑↓ 选择 |
| 命令下拉菜单 | `/` | ↑↓ 选择 + Enter 确认 |
| 提示栏 | 始终显示 | `Tab 选择  ·  ↑↓ 导航  ·  Enter 确认  ·  Esc 关闭` |
| 审批弹窗 | 工具需要审批时 | 显示工具名 + 参数摘要 + Y/N 确认 |
| 思考链 | 流式传输时 | 实时显示思考内容，带 spinner 动画 |
| 工具调用折叠 | 同类型多工具调用 | 折叠显示 `N × tool_name` |
| 状态行 | 始终显示 | Token 使用率 / 模型信息 / 语言 / 费用 |
| Markdown 渲染 | 输出时 | 代码块高亮、表格、列表等 |

---

## 国际化 (i18n)

- **翻译引擎：** `I18nManager` (`apps/cli/src/i18n/manager.ts`)
- **翻译包：** `zh.ts` (中文, 141 键) / `en.ts` (英文, 141 键)
- **覆盖范围：** Banner、下拉菜单、提示栏、工具名、审批弹窗、上下文管理、模型管理、错误提示
- **切换方式：** `/language` 面板 或 `/language zh|en` 直接切换
- **即时生效：** 无需重启，重建 TuiInput 标签 + 重绘 Banner

### 翻译键示例

| 键 | 中文 | 英文 |
|------|------|------|
| `welcome.banner` | 欢迎使用 Customize Agent | Welcome to Customize Agent |
| `cmd.no_model_configured` | 未配置模型 | No model configured |
| `tool.read_file` | 读取文件 | Read file |
| `permission.ask` | 需要您的确认 | Requires your approval |
| `context.warning` | Token 使用率较高 | High token usage |
| `error.execution` | 执行出错 | Execution error |

---

## REPL 命令参考

### 模型管理

| 命令 | 功能 |
|------|------|
| `/model` | 直观分层视图 + 快速开始示例 |
| `/model add <tier> <provider> <name>` | 添加模型到指定层 |
| `/model set <tier> <name>` | 切换该层激活模型 |
| `/model rm <tier> <name>` | 移除模型 |
| `/model key <provider> <key>` | 设置 Provider API Key |
| `/model fallback` | 查看各层回退路径 |

### Provider 管理

| 命令 | 功能 |
|------|------|
| `/provider` | 列出所有 Provider（key 状态/协议/URL） |
| `/provider key <name> <key>` | 设置/更新 API Key |
| `/provider protocol <name> <p>` | 手动指定协议（openai/anthropic/google） |
| `/provider url <name> <url>` | 覆盖 API 端点 |

### 会话控制

| 命令 | 功能 |
|------|------|
| `/language` | ↑↓ 语言选择面板 |
| `/language zh\|en` | 直接切换语言 |
| `/plan <task>` | Plan 模式（只读探索，不修改文件） |
| `/clear` | 重置会话（清除对话历史） |
| `/compact` | 手动触发上下文压缩 |
| `/context` | 查看上下文使用详情 |
| `/rewind` | 回退对话轮次 |
| `/resume` | 恢复历史会话 |
| `/sessions` | 查看历史会话列表 |

### 工具操作

| 命令 | 功能 |
|------|------|
| `/web <query>` | 网络搜索 |
| `/export <format>` | 导出会话结果 |
| `/git <op>` | Git 操作 |
| `/checkpoint` | 管理工作区快照 |
| `/kb overview` | 知识库概览 |
| `/kb list [keyword]` | 列出已索引文件 |
| `/kb search <query>` | 搜索知识库 |
| `/kb dashboard` | 打开知识库 Web 管理页 |
| `/kb reindex` | 手动重建索引 |
| `/doctor` | 工具链诊断 |
| `/help` | 显示完整命令列表 |
| `/exit` / `/quit` | 退出程序 |

---

## 配置参考

配置持久化在 `~/.customize-agent/config.json`，所有配置可通过 REPL 命令即时修改：

```json5
{
  "language": "zh",                     // 界面语言 (zh/en)
  "providers": {                        // Provider 独立配置
    "deepseek": {
      "apiKey": "sk-xxx",               // 手动设置 / 环境变量 / 留空
      "baseUrl": "",                    // 留空 = 使用默认端点
      "protocol": ""                    // 留空 = 自动推断，可选: openai/anthropic/google
    },
    "openai": {
      "apiKey": "",
      "baseUrl": "",
      "protocol": ""
    },
    "anthropic": {
      "apiKey": "",
      "baseUrl": "",
      "protocol": ""
    },
    "openrouter": {
      "apiKey": "",
      "baseUrl": "",
      "protocol": ""
    },
    "google": {
      "apiKey": "",
      "baseUrl": "",
      "protocol": ""
    },
    "ollama": {
      "apiKey": "",                     // 本地通常不需要
      "baseUrl": "http://localhost:11434/v1",
      "protocol": ""
    }
  },
  "models": {
    "reader": {
      "active": "",                     // 当前激活模型名
      "list": []                        // 候选模型列表 [{ name, provider }]
    },
    "reasoning": {
      "active": "",
      "list": []
    },
    "action": {
      "active": "deepseek-v4-flash",
      "list": [
        { "name": "deepseek-v4-flash", "provider": "deepseek" }
      ]
    }
  },
  "hooks": [],                          // Hooks 配置（见 Hooks 系统章节）
  "sandbox": {
    "mode": "workspace-write",          // workspace-write / read-only / danger-full-access / vfs-guard / docker
    "dockerImage": "customize-agent-sandbox:latest"
  },
  "execution": {
    "maxBudgetUsd": 5.0,                // 财务熔断上限（美元）
    "deadLoopThreshold": 4,             // 死循环检测阈值（连续轮数）
    "checkpointInterval": 15,           // 人工检查点间隔（轮数）
    "contextWarningRatio": 0.6,         // 上下文警告水位
    "contextTruncateRatio": 0.75,       // 截断水位
    "contextCompressRatio": 0.85        // 压缩水位
  },
  "mcpServers": {}                      // 外部 MCP 服务器配置
}
```

---

## 环境变量

```bash
# API Keys（按 Provider 设置）
CUSTOMIZE_AGENT_DEEPSEEK_API_KEY=        # DeepSeek
CUSTOMIZE_AGENT_OPENAI_API_KEY=          # OpenAI
CUSTOMIZE_AGENT_ANTHROPIC_API_KEY=       # Anthropic
CUSTOMIZE_AGENT_GOOGLE_API_KEY=          # Google Gemini
CUSTOMIZE_AGENT_OPENROUTER_API_KEY=      # OpenRouter
CUSTOMIZE_AGENT_OLLAMA_API_KEY=          # Ollama（本地通常不需要）

# 项目根目录
CUSTOMIZE_PROJECT_ROOT=/path/to/project  # 显式指定用户项目根；未设置时使用 INIT_CWD/PWD/当前目录

# 沙箱
CUSTOMIZE_AGENT_DANGER_MODE=1            # 启用 danger-full-access 沙箱模式

# 调试
CUSTOMIZE_AGENT_LOG_LEVEL=debug          # 日志级别（debug/info/warn/error）
CUSTOMIZE_AGENT_NO_COLOR=1               # 禁用 TUI 颜色输出
```

---

## 项目命令

```bash
# 安装
pnpm install                          # 安装所有依赖

# 类型检查
pnpm run typecheck                    # 全量类型检查 (turbo)
pnpm --filter <package> run typecheck # 单包类型检查

# 构建
pnpm run build                        # 全量构建 (turbo)
pnpm --filter <package> run build     # 单包构建

# 测试
pnpm run test                         # Vitest 单元测试（单次运行）
pnpm run test:watch                   # Vitest 监听模式（开发时使用）

# Lint
pnpm run lint                         # ESLint 全量检查
pnpm --filter <package> run lint      # 单包 lint

# 一体化检查
pnpm run check                        # typecheck + lint + test 一键检查

# 运行
pnpm start:cli                        # 启动交互式 REPL
pnpm start:cli -- -p "your task"      # 单次执行模式
pnpm start:cli -- -p "task" --plan    # Plan 模式（只读探索）
pnpm start:cli -- mcp-server          # 启动 MCP Server

# 开发
pnpm run dev                          # 构建 + 启动
```

---

## 发包流程

本项目使用 **Changesets** 管理版本和发布，配合 GitHub Actions 实现 CI/CD 自动化发布到 npm。

### 发布包总览

Monorepo 中以下 9 个包独立发布到 npm（均为 `public` 访问）：

| npm 包名 | 源目录 | 当前版本 |
|------|------|------|
| `customize-agent` | `apps/cli` | 1.0.5 |
| `@customize-agent/types` | `packages/types` | 1.0.2 |
| `@customize-agent/llm` | `packages/llm` | 1.0.2 |
| `@customize-agent/tools` | `packages/tools` | 1.0.3 |
| `@customize-agent/search` | `packages/search` | 1.0.3 |
| `@customize-agent/knowledge` | `packages/knowledge` | 1.0.1 |
| `@customize-agent/engine` | `packages/engine` | 1.0.3 |
| `@customize-agent/runtime` | `packages/runtime` | 1.0.2 |
| `@customize-agent/memory` | `packages/memory` | 1.0.2 |

### 前置条件

1. **npm 账号** — 在 [npmjs.com](https://www.npmjs.com/) 注册账号
2. **npm Token** — 在 npm 网站生成 Automation Token（用于 CI）或 Publish Token
3. **GitHub Secrets** — 在仓库 Settings → Secrets and variables → Actions 中添加：
   - `NPM_TOKEN`：npm 发布 Token
4. **GitHub Actions 权限** — 确保 Actions 有 Read and write permissions（Settings → Actions → General → Workflow permissions）

### 发包方式一：自动化 CI/CD 发布（推荐）

日常开发使用此方式，合并 PR 到 `master` 分支后自动触发。

#### 完整工作流

```
1. 开发功能/修复 Bug
      │
2. 创建 Changeset（记录变更）
      │  pnpm changeset
      │
3. 提交代码 + Changeset 文件
      │  git add . && git commit
      │
4. 创建 PR → master
      │  CI 运行 lint + typecheck + test + build
      │
5. 合并 PR → master
      │
6. Changesets Bot 自动创建/更新 "Version Packages" PR
      │  （自动计算版本号、生成 CHANGELOG、更新 package.json）
      │
7. 合并 "Version Packages" PR → master
      │
8. 自动发布到 npm
      └─ 自动创建 GitHub Release
```

#### 操作步骤

**第 1 步：创建 Changeset**

当你做了一个需要发布的变更（新功能、Bug 修复、API 变更等），在项目根目录运行：

```bash
pnpm changeset
```

交互式 CLI 会依次询问：

1. **选择要发布的包** — 用空格选中（如 `@customize-agent/tools`, `@customize-agent/engine`）
2. **选择版本类型** — `major` / `minor` / `patch`

| 版本类型 | 何时使用 | 示例 |
|------|------|------|
| `major` | 破坏性 API 变更 | 移除/重命名导出函数，变更接口参数签名 |
| `minor` | 向后兼容的新功能 | 新增工具、新增 Provider、新增 Hook 事件 |
| `patch` | 向后兼容的 Bug 修复 | 修复死循环误判、修复权限检查逻辑、文档修正 |

3. **输入变更描述** — 会写入 CHANGELOG，按 Enter 确认

这会生成一个随机命名的 `.md` 文件在 `.changeset/` 目录下，内容示例：

```markdown
---
"@customize-agent/tools": patch
"@customize-agent/engine": minor
---

新增 export_json 工具，修复沙箱权限检查的边界情况。
```

**第 2 步：提交 Changeset**

```bash
git add .changeset/
git commit -m "chore: add changeset for xxx feature"
```

> **注意：** Changeset 文件必须随代码一起提交到 git。如果变更不需要发布（如仅修改 README、CI 配置），则无需创建 changeset。

**第 3 步：创建 PR 并合并**

```bash
git push origin your-feature-branch
# 在 GitHub 创建 PR → master
```

PR 合并到 `master` 后，CI 流水线自动执行：

1. **CI 检查** (`ci.yml`) — lint → typecheck → test (ubuntu/macos/windows) → build (ubuntu/macos/windows)
2. **Changesets Bot** (`release.yml`) — 检测 `.changeset/` 目录中的变更文件，自动创建或更新 "Version Packages" PR

**第 4 步：合并 Version Packages PR**

Changesets Bot 创建的 "Version Packages" PR 包含：
- 更新后的各包 `package.json` 版本号
- 自动生成的 `CHANGELOG.md`
- 删除已消费的 `.changeset/*.md` 文件

审查无误后，合并该 PR。

**第 5 步：自动发布到 npm**

合并 "Version Packages" PR 后，`release.yml` 自动执行：

```bash
pnpm run version-packages    # changeset version（更新版本号）
pnpm run build               # 全量构建
pnpm run release             # changeset publish（发布到 npm）
```

同时自动创建 GitHub Release（tag 格式：`customize-agent-v1.0.5`）。

### 发包方式二：手动本地发布

适用于紧急修复或 CI 不可用的情况。

#### 前置准备

```bash
# 1. 登录 npm（首次需要）
npm login

# 2. 验证登录状态
npm whoami

# 3. 确保工作区干净
git status
```

#### 完整命令流程

```bash
# === 1. 创建 Changeset ===
pnpm changeset
# 交互式选择要发布的包和版本类型

# === 2. 提交 Changeset ===
git add .changeset/
git commit -m "chore: add changeset for xxx"

# === 3. 消费 Changeset，更新版本号 ===
pnpm run version-packages
# 等价于: changeset version
# 效果: 更新 package.json 版本号、生成 CHANGELOG、删除已消费的 .changeset/*.md

# === 4. 提交版本更新 ===
git add .
git commit -m "chore: version packages"

# === 5. 全量构建（必须通过） ===
pnpm run build

# === 6. 运行测试（必须通过） ===
pnpm run test

# === 7. 发布到 npm ===
pnpm run release
# 等价于: changeset publish
# 效果: 为每个有变更的包执行 npm publish

# === 8. 推送 tag 和提交到远程 ===
git push --follow-tags
```

#### 手动发布单个包（不使用 Changesets）

如果只需要发布某一个包（比如紧急热修复），可以手动操作：

```bash
# 1. 进入包目录
cd packages/tools

# 2. 手动更新版本号
# 编辑 package.json，将 version 从 "1.0.3" 改为 "1.0.4"

# 3. 构建
pnpm run build

# 4. 发布
npm publish --access public

# 5. 提交版本更新
cd ../..
git add packages/tools/package.json
git commit -m "chore: bump @customize-agent/tools to 1.0.4"
git tag @customize-agent/tools@1.0.4
git push --follow-tags
```

> **注意：** 手动发布单个包后，记得同步更新依赖该包的其他包的版本号，否则可能导致依赖不一致。

### CI/CD 流水线详解

#### CI 流水线 (`.github/workflows/ci.yml`)

触发条件：PR → `master` 或 Push → `master`

| Job | 运行环境 | 内容 |
|------|------|------|
| `lint` | ubuntu-latest | ESLint 全量检查 |
| `typecheck` | ubuntu-latest | TypeScript 全量类型检查 |
| `test` | ubuntu / macos / windows | 构建 + Vitest 测试 |
| `build` | ubuntu / macos / windows | 全量构建验证 |

#### Release 流水线 (`.github/workflows/release.yml`)

触发条件：Push → `master`

```yaml
步骤:
  1. Checkout (fetch-depth: 0 获取完整历史)
  2. 安装 pnpm + Node.js 22
  3. pnpm install --frozen-lockfile
  4. pnpm run build
  5. pnpm run test
  6. changesets/action@v1:
     - version: pnpm run version-packages
     - publish: pnpm run release
  7. 创建 GitHub Release (softprops/action-gh-release)
```

### npm Scripts 参考

| 命令 | 底层实现 | 说明 |
|------|------|------|
| `pnpm changeset` | `changeset` | 交互式创建 Changeset |
| `pnpm run version-packages` | `changeset version` | 消费 Changeset → 更新版本号 + 生成 CHANGELOG |
| `pnpm run release` | `pnpm run build && changeset publish` | 构建所有包 → 发布有变更的包到 npm |
| `pnpm run build` | `turbo run build` | Turborepo 并行构建（自动处理依赖顺序） |
| `pnpm run check` | `turbo run typecheck lint && vitest run` | 全量质量检查 |

### 依赖关系与构建顺序

包之间的依赖关系决定构建顺序（Turborepo 通过 `dependsOn: ["^build"]` 自动处理）：

```
types (零依赖)
  ├── llm → types
  ├── tools → types, search
  ├── search → types
  ├── knowledge → types
  ├── engine → types, llm, tools, search
  ├── runtime → types
  ├── memory → types
  └── cli → engine, runtime, llm, tools, search, memory, knowledge, types
```

### 常见问题

**Q: Changeset 创建后能修改吗？**

可以。在合并到 master 之前，直接编辑 `.changeset/` 目录下对应的 `.md` 文件即可。

**Q: 如何跳过某个包的发布？**

在创建 Changeset 时不要选中该包，或在 `.changeset/config.json` 的 `ignore` 数组中添加包名。

**Q: 发布失败如何回滚？**

npm 包发布后在 72 小时内可以撤销（`npm unpublish <package>@<version>`），但不建议撤销已发布的版本，应发布一个新的 patch 版本来修复。

**Q: 多个 Changeset 如何合并？**

Changesets Bot 会自动将所有未消费的 Changeset 合并到 "Version Packages" PR 中，按最大版本类型升级。

**Q: 如何查看哪些包需要发布？**

```bash
pnpm changeset status
# 显示当前所有未消费的 Changeset 和受影响的包
```

**Q: Changesets Bot 没有创建 PR？**

检查：
1. `.github/workflows/release.yml` 是否正确配置
2. GitHub Actions 是否有 Read and write permissions
3. `NPM_TOKEN` Secret 是否正确设置
4. Action 的运行日志是否有报错

---

## 测试

项目使用 **Vitest** 作为测试框架，配置在根级 `vitest.config.ts`：

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

### 现有测试

| 包 | 测试文件 | 覆盖内容 |
|------|------|------|
| `engine` | `execution-controller.test.ts` | LoopGuard 死循环检测、BudgetManager 预算熔断 |
| `engine` | `permission-engine.test.ts` | 权限检查（allow/deny/ask）、路径匹配 |
| `engine` | `tool-loop-runner.test.ts` | 工具循环运行逻辑 |
| `engine` | `tool-registry.test.ts` | 工具注册、查找、Schema 生成 |
| `llm` | `retry.test.ts` | 指数退避重试逻辑 |
| `tools` | `path-safety.test.ts` | 安全路径解析、路径穿越防护 |
| `search` | `db.test.ts` | SQLite FTS5 索引、查询 |
| `cli` | `executor.test.ts` | AgentExecutor 集成测试 |

### 运行测试

```bash
pnpm run test                         # 运行所有测试
pnpm run test:watch                   # 监听模式
pnpm --filter @customize-agent/engine run test  # 单包测试
```

---

## 代码风格

### TypeScript 配置

- **严格模式：** `strict: true`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`
- **未使用检查：** `noUnusedLocals: true`, `noUnusedParameters: true`
- **模块：** ES Module (`NodeNext` module resolution)
- **强制：** `isolatedModules: true`, `forceConsistentCasingInFileNames: true`

### 编码规范

- **接口优先：** `ILLMProvider` > 具体 Provider, `ContextSource` > ad-hoc 收集
- **工具注册：** 新增工具只需 `registry.register()`，不修改 executor
- **类型导入：** 强制 `import type { ... }` 用于仅类型用途（ESLint `consistent-type-imports`）
- **命名约定：**
  - 类：PascalCase (`ToolRegistry`, `SandboxExecutor`)
  - 接口：`I` 前缀 (`ILLMProvider`) 或无前缀
  - 函数/变量：camelCase (`createProvider`, `resolveSafe`)
  - 常量：UPPER_SNAKE_CASE (`SKIP_DIRS`, `BINARY_EXTENSIONS`)
- **文件组织：** 按功能域拆分，每个文件职责单一

---

## 设计决策 (ADR)

以下记录了项目中的关键架构决策：

| ADR | 决策 | 理由 |
|-----|------|------|
| ADR-1 | 内部工具走函数调用，MCP 仅用于外部集成 | 避免进程内 JSON-RPC 序列化开销 |
| ADR-2 | Seatbelt/Bubblewrap 为主沙箱，容器可选 | 内核级隔离，启动 < 10ms，无 daemon 依赖 |
| ADR-3 | tree-sitter 统一代码智能 + 语法验证 | 一套 DFS 覆盖 11 语言，无需各语言编译器 |
| ADR-4 | LSP 使用 vscode-jsonrpc 标准库 | 不重复造轮子，社区标准 |
| ADR-5 | 废弃 AI Gateway 自动路由 | 自动切换破坏用户信任，显式控制优于自动化 |
| ADR-16 | LifecycleAware 统一组件生命周期 | `restart()` 严禁更换实例指针 |
| ADR-17 | 三级模型分层 (reader/reasoning/action) | 按任务类型路由不同模型，降低 token 成本 |
| ADR-18 | Provider 协议自动推断 + 手动覆盖 | 零配置可用，第三方 Provider 可手动修正 |
| ADR-19 | API Key 属于 Provider 不属于 Model | 同厂商多模型共享 Key，减少重复配置 |
| ADR-20 | 零启动扫描，全部懒加载 | git ls-files 毫秒级，不阻塞启动 |
| ADR-21 | 内置规则 + CUSTOMIZE.md 双层提示词 | 内置规则管安全/协议，CUSTOMIZE.md 管角色/领域 |

---

## Docker 沙箱

项目提供可选的 Docker 沙箱镜像（`Dockerfile.sandbox`），用于执行不可信代码或运行数据分析任务：

```dockerfile
FROM python:3.11-slim

# 系统工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget jq ca-certificates openssh-client \
    build-essential nodejs npm bash

# JS 生态
RUN npm install -g pnpm typescript tsx prettier eslint

# Python 数据分析工具链
RUN pip install --no-cache-dir \
    numpy pandas scipy matplotlib seaborn \
    requests beautifulsoup4 lxml pdfplumber \
    tabulate Pillow playwright \
    pytest black ruff mypy

# 浏览器自动化
RUN playwright install --with-deps chromium

WORKDIR /workspace
```

### 构建和使用

```bash
# 构建镜像
docker build -f Dockerfile.sandbox -t customize-agent-sandbox:latest .

# 在 REPL 中切换到 Docker 沙箱模式
# 在 config.json 中设置:
#   "sandbox": { "mode": "docker", "dockerImage": "customize-agent-sandbox:latest" }
```

---

## 故障排除

### 常见问题

**Q: 启动后提示 "No model configured"？**

运行首次配置：
```
/model add action deepseek deepseek-v4-flash
/model key deepseek sk-your-api-key
```

**Q: 沙箱不可用，打印了降级警告？**

```
[Sandbox] Bubblewrap unavailable, falling back to VFS-Guard mode
```

这是正常行为。macOS 上确保系统完整性保护 (SIP) 未完全禁用 sandbox-exec。Linux 上运行：
```bash
# 检查 unprivileged user namespaces
sysctl kernel.unprivileged_userns_clone
# 如果为 0，启用：
sudo sysctl -w kernel.unprivileged_userns_clone=1
```

**Q: tree-sitter 语法高亮不工作？**

确认 tree-sitter 已正确安装：
```bash
pnpm rebuild tree-sitter
```

**Q: 类型检查失败？**

运行单个包的类型检查来定位问题：
```bash
pnpm --filter @customize-agent/engine run typecheck
```

**Q: 如何切换 API 协议（如用第三方 OpenAI 兼容 API）？**

```
/provider protocol my-api openai
/provider url my-api https://my-api.example.com/v1
```

**Q: token 消耗太快？**

1. 为读取层配置更便宜的模型：`/model add reader deepseek deepseek-chat`
2. 降低上下文压缩水位（修改 config.json 中的 `contextCompressRatio`）
3. 手动触发压缩：`/compact`

### 调试模式

```bash
CUSTOMIZE_AGENT_LOG_LEVEL=debug pnpm start:cli
```

---

## 许可证

MIT

---

## 贡献

欢迎提交 Issue 和 Pull Request。在提交 PR 前请确保：

```bash
pnpm run check    # typecheck + lint + test 全部通过
```

大型变更请先开 Issue 讨论设计方案。
