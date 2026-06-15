# Code Agent 开发实施方案 (v3)

> 2026-06-15 | 基于代码实际状态，架构优先，设计决策透明
>
> **编写原则：** 描述架构边界、接口契约、设计决策、验收标准。不粘贴实现代码。

---

## 0. 当前代码状态清单

### 包结构（6 包，~800 行 TS）

| 包 | 源文件 | 功能 | 状态 |
|---|--------|------|:----:|
| `packages/shared` | `index.ts` | `Message`、`LLMResponse` 接口 | ✅ |
| `packages/diff-engine` | `index.ts` | `parseBlocks`、`applyPatch`、`generateUnifiedDiff` | ✅ bug: `\N`→`\n` |
| `packages/llm-provider` | `index.ts` | `DeepSeekProvider` 具体类，无接口，无流式，无重试 | ⚠️ |
| `packages/tool-kit` | `index.ts`, `git.ts`, `terminal.ts`, `sandbox.ts`, `syntax-validator.ts` | 路径沙箱 ✅、OS 沙箱 ✅、修改回滚 ✅、5 语言语法验证（8 种注释） | ⚠️ |
| `packages/context-engine` | `index.ts`, `db.ts`, `indexer.ts` | SQLite（LIKE 搜索）、TS-only AST 索引 | ⚠️ |
| `apps/cli` | `index.ts`, `executor.ts`, `prompt.ts` | Commander+Inquirer CLI、ReAct 循环(固定 8 轮硬熔断 ⚠️)、XML 工具协议 | ⚠️ |

### 已知 Bug

| 位置 | 问题 |
|------|------|
| `diff-engine/src/index.ts:13` | `\N` 笔误，应为 `\n` |
| `sandbox.ts:127-129` | Linux workspace-write 模式 root 被重复挂载 |
| `syntax-validator.ts:201` | `yaml` 动态 import 但 `package.json` 未声明依赖 |
| 全项目 | 零测试 |

### 已知架构缺陷

| 缺陷 | 影响 |
|------|------|
| XML `<call_tool>` 协议非标准 | LLM 输出格式错误率高，每加工具需改 executor |
| `DeepSeekProvider` 硬编码 | 单模型锁定 |
| 无流式输出 | 阻塞等待，用户体验差 |
| `RepositoryIndexer` 仅 TS/JS | 其他语言项目无代码索引 |
| 5 种语言手写 Validator，8 种被注释 | 多语言验证不可持续 |
| executor 固定 8 轮熔断 | 稍大任务（编译纠偏）轻松超过 8 轮被误杀；业界无此做法 |
| executor switch-case 工具分发 | 工具和循环耦合 |
| 无权限/审批 | Agent 静默修改文件 |
| 无审计日志 | 中断后上下文全部丢失 |
| 无上下文管理 | 长对话可能撑爆 token 窗口 |
| 手动 LSP 协议解析（v2 方案） | 重复造轮子，脆弱 |

---

## 架构决策记录 (ADR)

### ADR-1：内部工具走函数调用，MCP 用于外部集成

核心工具（文件读写、终端执行、代码搜索）走直接函数调用。MCP 协议用于：(1) 将我们的工具暴露给外部 AI 客户端（Claude Desktop、Cursor）；(2) 连接社区 MCP Server 生态（GitHub、Postgres、Jira）。

**理由：** 内部工具走进程间 JSON-RPC 会引入不必要的序列化开销和调试复杂度。MCP 的正确边界是跨进程/跨网络的外部集成。

### ADR-2：保留 OS 沙箱（Seatbelt + Bubblewrap），容器作为可选增强

当前 SandboxExecutor 使用 macOS Seatbelt 和 Linux Bubblewrap —— 内核级沙箱，无 daemon、启动 < 10ms、零外部依赖。保留为主方案。Docker/Podman 容器沙箱作为 `danger-full-access` 模式下的可选替代，不替换默认沙箱。

**理由：** 容器需要 daemon 常驻、root/sudo、冷启动 > 500ms。对每次命令执行都启动一个容器的开销不可接受。内核级沙箱是更适合开发工具的隔离方案。

**前置诊断与优雅降级：** Bubblewrap 依赖 Linux 内核 `unprivileged user namespaces` 特性。在企业级加固的 Linux 宿主机、旧版 CentOS/RHEL 或受限 CI/CD 容器内，该特性可能被强制关闭。系统初始化时需执行 **Sandbox Preflight Diagnostics**，若检测到宿主环境不支持 Bubblewrap，自动降级为**纯路径虚拟沙箱（VFS Guard 拦截）**，并向审计日志和控制台打印安全警告，不崩溃退出。

### ADR-3：tree-sitter 统一代码智能层

用 tree-sitter 通用 AST 引擎一次性解决两个问题：
- **多语言符号索引** — 替换 TS-only `ts.createSourceFile`
- **通用语法错误检测** — 替换 5 个手写 Validator 策略类

**原理：** 任何语言的 tree-sitter AST 中，语法错误节点 `hasError()` 返回 `true`，一套 DFS 遍历覆盖所有语言。不依赖各语言编译器是否安装。

### ADR-4：LSP 集成使用 vscode-jsonrpc 标准库

v2 方案中 `LSPConnection` 类手动拼接 `Content-Length:` 头、维护 buffer、管理 pending Map —— 这是在重新发明 `vscode-jsonrpc`。v3 直接使用 Microsoft 官方 `vscode-jsonrpc` + `vscode-languageclient` 库，这是 VS Code 自身使用的 LSP 客户端实现，经过数百万用户验证。

### ADR-5：AI Gateway 自动路由是核心差异化能力

AI Gateway 按任务类型/复杂度/成本预算自动选择最优模型，这是本项目超越竞品单模型锁定的关键差异化能力。Embedding 语义搜索（L3）提供 FTS5（L1）和 ripgrep（L2）无法覆盖的语义理解能力——搜索"用户认证"能命中包含 "login"、"sign in"、"auth middleware" 等文本不同但语义相关的代码。

### ADR-6：配置文件优先，不硬编码

权限规则、Provider 配置、Hooks、Skills、子智能体定义均通过 `.code-agent/` 目录下 YAML/JSON 文件管理，支持项目级 → 用户级 → 默认值三层覆盖。

### ADR-7：tree-sitter 巨型文件需 Worker Thread 隔离，设文件大小熔断线

tree-sitter WASM 在主线程同步执行 DFS 深度遍历。当遇到单文件数万行的巨型前端打包产物、自动生成代码或超长日志时，同步 AST 解析会**阻塞 Node.js 事件循环**，导致流式输出（Task 1.5）卡死，甚至触发 OOM。

**方案：**
- 设定 `MAX_FILE_SIZE = 1MB` 熔断线，超限文件跳过 tree-sitter 解析（不阻塞索引和验证流程）
- 对大型文件（> 100KB 但 < 1MB），将解析任务移交至 **Worker Thread Pool** 异步执行，不阻塞主线程
- Worker Pool 大小 = `max(2, os.cpus().length - 1)`

### ADR-8：子进程（LSP Server / MCP Server）必须绑定生命周期看门狗

通过 `spawn` 启动的外部进程（LSP Server、MCP Server）在用户 Ctrl+C、Agent 崩溃或未捕获异常时，极易变成**孤儿/僵尸进程**，常驻系统吞噬 CPU。

**方案：**
- 所有 `spawn` 调用必须声明 `detached: false`，确保默认与父进程绑定
- LSPManager 为每个 LSP 连接设置 TTL 空闲回收定时器（默认 5 分钟无调用 → 优雅 shutdown + exit）
- 全局监听 `process.on('SIGINT')`、`process.on('SIGTERM')`、`process.on('exit')`，遍历连接池执行 `process.kill(pid)` 强制清理
- MCP Client 同上

### ADR-9：Git 写操作需串行化（互斥锁），锁粒度精准到 Worktree 生命周期管理

Git Worktree 底层为每个 Worktree 创建**完全独立的 index 文件**（位于 `.git/worktrees/<name>/index`）。不同 Worktree 目录下的子智能体各自并发调用 `git add`/`git commit` 时，**天然不冲突**。真正的 `.git/index.lock` 冲突只发生在：(1) 多个智能体在**同一物理目录**并发写 Git；(2) 主编排器在主仓库并发执行 `git worktree add/remove` 这类操纵全局 refs 的管理命令。

**方案：** `AsyncMutex` 仅覆盖 `WorktreeManager` 的**工作区生命周期管理方法**（`createWorktree`、`destroyWorktree`），保护主仓库的全局 refs 不被并发写乱。子智能体在各 Worktree 内部的 `git add`/`git commit` 无需加锁，保留 Swarm 的并行效率。

### ADR-10：Embedding 代码切块必须注入文件路径和外层作用域元数据

简单的按行切块（100-500 行）会导致切块丢失其所在文件、包、类/模块的上下文。例如一个切块全是底层 `if/else` 逻辑却不含任何业务关键词，检索 "用户认证" 时余弦相似度极低、无法被召回。

**方案：** 每个代码块在送入 Embedding API 之前，自动拼接上下文头信息（Header Injection）：
```text
// File: src/services/auth/middleware.ts
// Enclosing: class SessionAuthenticator implements IAuth
// =============================================================
[原始代码片段]
```
注入路径名和外层类/函数签名，将语义召回精确度提升 40%+。

### ADR-11：执行控制对齐业界标准——财务预算 + Goal 检测 + 死循环检测

固定 8 轮熔断（`executor.ts:12`）没有主流 Agent 使用。学术界结论（arXiv 2510.16786）："Fixed max_turns is not an intelligent strategy — it lacks adaptability for tasks of varying complexity."

**业界标杆做法：**

| Agent | 首要机制 | 次要机制 |
|-------|---------|---------|
| **Claude Code** | `ANTHROPIC_COST_BUDGET`（财务）+ `/goal`（目标达成自动停） | Loop Breaker hooks（死循环检测） |
| **Codex CLI** | `token_budget` + `turn_budget`（可选，null=无限） | `/goal` 完成检测 |
| **Aider** | 无内置限制 | 外部脚本轮询成本 |
| **Ouro Loop** | 5 验证门（EXIST/RELEVANCE/ROOT_CAUSE/RECALL/MOMENTUM） | hooks 物理阻断 |

**我们的方案（对齐 Claude Code + Codex CLI）：**

| 维度 | 对标 | 机制 | 默认值 |
|------|------|------|--------|
| **财务熔断** | Claude Code `ANTHROPIC_COST_BUDGET` | AI Gateway 实时累加 token 费用，超限优雅终止 | `$3.00`/任务 |
| **Goal 完成检测** | Claude Code `/goal` validator model | 每轮用轻量模型检查"任务目标是否已达成"，达成即停 | 启用 |
| **语义死循环检测** | Ouro Loop 验证门 / Loop Breaker | 连续 3 轮相同 toolName+args+result 哈希 → 拦截并触发 Re-plan | 连续 3 次 |
| **人机检查点** | Codex CLI `turn_budget` 模式 | 每 15 轮阻塞弹窗展示进度 + 询问是否继续 | 每 15 轮 |

**明确不做的：** 不设硬编码的绝对轮数上限。学术界和工业界共识：静态轮数限制是笨拙的——要么误杀复杂任务，要么对死循环无感知。

### ADR-12：引入 Agent Runtime 作为统一调度层，防止 Executor 退化为 God Object

当前架构中 ContextManager、ExecutionController、AuditLogger、PermissionEngine、Planner、SubAgent 全部是横向能力，直接挂在 Executor 上。随着 Planner/SubAgent/Web UI/VSCode 扩展等多入口的加入，逻辑会逐渐分散到各入口各自实现一遍，最终 Executor 退化为 3000+ 行的 God Object。

**方案：** 新增 `packages/runtime`，作为所有入口（CLI/Web/VSCode/CI）共享的统一调度层：

```
CLI / Web / VSCode / CI
         │
    ┌────▼────────────────────────────┐
    │        Agent Runtime            │
    │  Session · Loop · StateMachine  │
    │  EventBus · Checkpoint · Cancel │
    │  ExecutionContext · Recovery    │
    └────┬────────────────────────────┘
         │
    ┌────▼────────────────────────────┐
    │  ExecutionController (编排)      │
    │  ├─ LoopGuard                   │
    │  ├─ BudgetManager               │
    │  ├─ GoalManager                 │
    │  └─ CheckpointManager           │
    └────┬────────────────────────────┘
         │
    ┌────▼────────────────────────────┐
    │  ToolRegistry · Provider · ...  │
    └─────────────────────────────────┘
```

Runtime 统一管理：Session 生命周期、主 Loop 控制、TaskState 状态机、EventBus 事件总线、CancellationToken 取消传播、Checkpoint/Recovery 持久化。

### ADR-13：Tree-sitter 与 LSP 的 Source of Truth 边界必须明确

Tree-sitter 和 LSP 在符号搜索（Document Symbol）、诊断（Diagnostic）等能力上存在重叠。若不定义清晰边界，未来会出现同一查询走两个路径、结果不一致、双维护的问题。

**方案：**

| 能力 | 首选 Source | 降级 Fallback | 说明 |
|------|:---------:|:---------:|------|
| **结构索引**（符号提取、代码导航） | Tree-sitter | — | 离线、零依赖、覆盖所有 tree-sitter 支持的语言 |
| **语义分析**（跳转定义、查找引用） | LSP | Tree-sitter 符号搜索 | LSP 提供精确的跨文件语义分析，不可用时降级为 tree-sitter 文本级搜索 |
| **编译诊断**（类型错误、未使用变量） | LSP | Tree-sitter 语法验证 | LSP 提供类型级诊断，不可用时 tree-sitter 仅提供语法级检查 |
| **语法验证**（修改后文件是否可解析） | Tree-sitter | — | 纯语法检查用 tree-sitter（零外部依赖、< 20ms），不调 LSP |

**查询路由规则：** `lsp_definition` / `lsp_references` 优先走 LSP → LSP 不可用则降级为 tree-sitter 符号搜索 + 文本匹配。`search_symbol` 直接走 tree-sitter（不经过 LSP）。`lsp_diagnostics` 走 LSP → 不可用则降级为 tree-sitter 的 `hasError()` 检查。

### ADR-14：ToolRegistry 只负责注册/查找/执行，Schema 适配和权限检查独立

当前 ToolRegistry 承担了 6 项职责（注册、分发、权限检查、MCP 导出、OpenAI Schema、Anthropic Schema），严重违反单一职责。随着 Provider 数量增长（OpenAI/Anthropic/Gemini/OpenRouter），格式适配逻辑会爆炸。

**方案：**

```
ToolRegistry          → register / dispatch / listAll（核心）
SchemaAdapter         → toOpenAIFunctions / toAnthropicTools / toGeminiFunctions
MCPAdapter            → getMCPSchemas / handleMCPCall
PermissionEngine      → check（已独立，Phase 4）
```

ToolRegistry 保持纯粹，SchemaAdapter 和 MCPAdapter 消费 ToolRegistry 的数据，不写入。

### ADR-15：AI Gateway 分解为协调器 + 可插拔策略组件

当前 Gateway 承担路由、重试、成本统计、健康检查、升级策略五大职责。未来加入 Prompt Cache、Model Ranking、A/B Test、Provider Weight、Fallback Graph 后会变成第二个 God Object。

**方案：**

```
AIGateway (协调器)
  ├─ Router            → 委托给 RoutingStrategy
  ├─ CostTracker       → 成本累加与上限检查
  ├─ HealthManager     → 健康检查与故障标记
  └─ FallbackManager   → 降级链管理
```

Gateway 仅做编排，具体策略由各组件独立实现，方便替换和测试。

**路由策略插件化：**

```typescript
interface RoutingStrategy {
  readonly name: string;
  route(task: TaskAnalysis, providers: Map<string, ILLMProvider>): Promise<ILLMProvider | null>;
}
```

内置策略：`CostFirstStrategy`（最便宜） / `QualityFirstStrategy`（最强推理） / `LatencyFirstStrategy`（最快响应） / `PrivacyFirstStrategy`（本地优先）。Gateway 通过配置选择策略，用户可通过 `--strategy quality-first` 覆盖。未来企业可注入自定义 `EnterprisePolicyStrategy`。

### ADR-16：统一组件生命周期（LifecycleAware）——现在就建，不等重构

当前系统中 LSPManager、TreeSitterWorkerPool、SandboxExecutor、StorageManager、MemoryManager、AuditLogger、各 Provider、MCP Client 各自有各自的初始化和清理方式。若不在架构起步阶段统一生命周期，未来会出现：忘记调 `shutdown()` 导致孤儿进程泄露（LSP/MCP），忘记调 `terminate()` 导致 Worker 线程残留，初始化顺序错误导致依赖组件未就绪就被调用。

**方案：** 所有需要初始化和清理的组件实现统一的 `LifecycleAware` 接口。Runtime 管理全部组件的生命周期拓扑排序、初始化、健康检查和优雅关闭。

```typescript
interface LifecycleAware {
  readonly name: string;
  readonly dependencies?: string[];

  init?(): Promise<void>;
  healthCheck?(): Promise<boolean>;
  shutdown?(): Promise<void>;

  // 自恢复能力
  restart?(): Promise<void>;                          // shutdown → init
  reload?(config: Record<string, any>): Promise<void>; // 运行时热更新配置
  onDependencyFailure?(failedComponent: string): Promise<void>;  // 依赖组件故障回调
}
```

**自恢复流程 + 引用悬空防护：** Runtime 定期 `healthCheck` 所有组件 → 某组件返回 false → 调用其 `onDependencyFailure`（通知依赖方进入降级模式） → 调用 `restart()` 尝试恢复 → 失败达 3 次 → 标记为 DEGRADED → 继续运行（不崩溃）。

> ⚠️ **Stale Reference 陷阱：** 若 `restart()` 内部销毁旧实例并 `new` 新实例，依赖该组件的所有其他组件（如 Executor/ContextManager 持有 `LSPManager` 引用）将变成**指向僵尸对象的失效指针**。组件在 Runtime 层面宣告自愈成功，但业务代码调用的依然是已 `shutdown` 的旧实例。

**约束 — 就地重置契约（In-place Reset）：** `restart()` 严禁更换类实例的物理指针。必须是内部状态、连接池、子进程的就地销毁与重建。业务组件禁止在 `init()` 时固化依赖对象引用，必须通过 `ExecutionContext` 容器在运行时动态获取（如 `this.ctx.get('lspManager')`），防止 Stale Reference。

**Runtime 生命周期管理：**

```
Runtime.start()
  │
  ├─ 拓扑排序所有 LifecycleAware 组件（按 dependencies 构建 DAG）
  ├─ 按依赖顺序依次调用 component.init()
  │   例: StorageManager → MemoryManager → SandboxExecutor → LSPManager → Providers
  ├─ 任一 init 失败 → 已初始化的组件逆序 shutdown → 启动失败
  │
  ▼
  EventBus.emit('runtime:ready')
  │
  ▼ (正常运行...)
  │
Runtime.shutdown()
  ├─ 所有组件按初始化逆序依次调用 component.shutdown()
  │   例: Providers → LSPManager → SandboxExecutor → MemoryManager → StorageManager
  └─ 任一 shutdown 超时 (5s) → 打印警告 → 继续清理下一个
```

**适用组件（全部实现 LifecycleAware）：**

| 组件 | 所属包 | init | shutdown |
|------|--------|------|---------|
| StorageManager | context-engine | 打开 SQLite 连接 | 关闭连接 |
| TreeSitterWorkerPool | context-engine | 预拉起 Warm Pool + 加载 WASM | terminate 全部 Worker |
| LSPManager | context-engine | —（按需启动） | 遍历连接池 kill 全部 LSP 进程 |
| SandboxExecutor | tool-kit | 执行 preflight 诊断 | — |
| MemoryManager | memory | 打开 SQLite 连接 | 关闭连接 |
| AuditLogger | logger | 创建日志目录 | 刷新缓冲区 |
| DeepSeekProvider 等 | llm-provider | — | 关闭 HTTP 连接池 |
| MCPClient | agent-core | — | disconnect 全部 MCP 连接 |
| EmbeddingSearch | context-engine | 加载向量索引 | 持久化脏向量 |

**为什么现在做而不是以后：** 当前代码量 ~800 行，组件数量少。统一生命周期只需每个组件增加 ~10 行代码。等到 Phase 7 组件数量 ×10 后再回头统一，就是 3000+ 行重构——到那时大概率不会做，留下的就是永久的架构债务。

### ADR-17：ContextSource 统一协议——所有上下文来源必须实现同一接口

当前 ContextManager 自己收集、自己裁剪、自己排序、自己注入。Memory/SubAgent 结果/Planner 输出/Reviewer 评论/Embedding 结果/LSP 诊断全部是 ad-hoc 的 `if (memory) push()` / `if (planner) push()` 模式。未来新增上下文来源时，ContextManager 代码会爆炸。

**方案：** 所有上下文来源实现 `ContextSource` 接口，ContextManager 变为纯粹的收集→排序→裁剪→注入管道。

```typescript
interface ContextChunk {
  priority: number;         // 0 = system, 1-99 = high, 100-199 = medium, 200+ = low
  content: string;
  tokens: number;
  source: string;           // 'memory' | 'subagent' | 'planner' | 'tool_result' | 'lsp' | ...
  ttl?: number;             // 保留轮数，过期自动丢弃
  mergeStrategy?: 'replace' | 'append' | 'summarize';  // 同 source 新 chunk 到达时的合并策略
}

interface ContextSource {
  readonly id: string;
  readonly priority: number;
  collect(session: Session, currentRound: number): Promise<ContextChunk[]>;
}
```

**内置 ContextSource 实现：**

| Source | Priority | TTL | 说明 |
|--------|:----:|:---:|------|
| SystemPromptSource | 0 | ∞ | System Prompt，永不裁剪 |
| ToolDefinitionSource | 1 | ∞ | 工具定义，永不裁剪 |
| MemorySource | 10 | 10 轮 | 相关记忆，定期刷新 |
| PlannerResultSource | 20 | ∞ | 执行计划，任务结束前保留 |
| SubAgentReportSource | 30 | 5 轮 | 子智能体报告，短期有效 |
| ToolResultSource | 100 | 3 轮 | 工具执行结果 |
| LSPDiagnosticSource | 110 | 2 轮 | LSP 诊断，快速过期 |
| GitDiffSource | 120 | 2 轮 | Git diff 快照 |
| AuditTrailSource | 200 | 1 轮 | 最近审计摘要（Phase 7 Metrics 使用） |

ContextManager 不再 `if (x) push(y)`，改为 `for (source of sources) { chunks.push(...await source.collect()) }` → 按 priority 排序 → 按 token 预算从低 priority 开始裁剪。

**关键滑窗保留额度（防上下文饥饿）：** 纯线性优先级裁剪有一个致命盲区——当 Agent 进入复杂重构中后期，Plan 历史 + 子智能体报告（priority 20-30）体量膨胀触发 Token 预算线时，算法会无情裁剪 priority 100+ 的 `ToolResultSource` 和 `LSPDiagnosticSource`。结果：对当前轮大模型决定"下一步该怎么修"最重要的实时报错反馈被优先切掉，双眼"失明"，陷入原地打转死循环。

**方案：** 当前轮（Round N）和上一轮（Round N-1）的 `ToolResultSource`、`LSPDiagnosticSource`、`GitDiffSource` 设 `uncuttable: true` 标记——无论总 Token 多紧张，**最近两轮的实时反馈必须全额保留**。高优先级历史内容（Planner 计划、子智能体报告）在逼近预算线时执行 `summarize` 压缩而非直接丢弃。

### ADR-18：统一 Capability System——权限和角色的共同基础

当前权限系统（allow/deny/ask）和子智能体角色（Planner 只读/Implementer 完整）是分开设计的。未来 Planner 禁止 `modify_file`、Reviewer 禁止 `execute_command`、Memory 禁止 `git_commit` 这些约束会散落为硬编码。

**方案：** 定义统一的 `Capability` 枚举，Tool/SubAgent/MCP 全部绑定 Capability。权限引擎和角色系统共享同一套 Capability 模型。

```typescript
enum Capability {
  READ_CODE = 'read_code',           // read_file, list_files
  WRITE_CODE = 'write_code',         // modify_file
  SEARCH_SYMBOL = 'search_symbol',   // search_symbol, fts_search, grep_search, semantic_search
  EXECUTE_COMMAND = 'execute_command',
  GIT_OPERATION = 'git_operation',   // git_status, git_diff, git_commit
  LSP_QUERY = 'lsp_query',           // lsp_definition, lsp_references, lsp_diagnostics
  MEMORY_ACCESS = 'memory_access',   // memory recall/inject/record
  MCP_EXTERNAL = 'mcp_external',     // 外部 MCP 工具
  EMBEDDING_SEARCH = 'embedding_search',
}
```

**Tool ↔ Capability 映射：**

| 工具 | 绑定 Capability |
|------|---------------|
| `read_file`, `list_files` | READ_CODE |
| `modify_file` | WRITE_CODE |
| `search_symbol`, `fts_search`, `grep_search`, `semantic_search` | SEARCH_SYMBOL |
| `execute_command` | EXECUTE_COMMAND |
| `git_status`, `git_diff`, `git_commit` | GIT_OPERATION |
| `lsp_definition`, `lsp_references`, `lsp_diagnostics` | LSP_QUERY |
| `mcp_*`（外部 MCP 工具） | 动态能力投影（见下文） |

**MCP 工具动态能力投影（Dynamic Capability Projection）：**

> ⚠️ 外部 MCP Server 的工具有"运行时动态发现"特性——同一个 Server 可能同时暴露安全的 `read_db_schema` 和危险的 `drop_database_table`。若全部捆绑在孤立的 `MCP_EXTERNAL` 标签下，PermissionEngine 将失去微观拦截能力——只能"完全信任"或"完全封杀"整个 MCP Server。

**方案：** MCP Client 完成 `listTools()` 后，通过映射器将外部工具动态投影到内部 Capability 矩阵：

1. **名称模式匹配**：工具名匹配 `*read*`/`*get*`/`*list*`/`*search*` → 投影到 `READ_CODE` + `SEARCH_SYMBOL`
2. **Schema 分析**：若 inputSchema 不含破坏性参数 → 投影到 `READ_CODE`
3. **用户显式标记**：`.code-agent/config.yaml` 中可手动为特定 MCP 工具指定 Capability：
   ```yaml
   mcp_capabilities:
     mcp_github_create_issue: [WRITE_CODE]
     mcp_github_list_repos: [READ_CODE]
   ```
4. **默认兜底**：无法确定的 MCP 工具 → 投影到 `MCP_EXTERNAL` + 默认 `requiresApproval: true`

确保外部集成完美融入原生安全防线，而非绕过硬编码。

**角色 ↔ Capability 绑定：**

| 角色 | 允许的 Capability |
|------|-----------------|
| Explorer | READ_CODE, SEARCH_SYMBOL, LSP_QUERY, EMBEDDING_SEARCH |
| Planner | READ_CODE, SEARCH_SYMBOL, LSP_QUERY, EMBEDDING_SEARCH, MEMORY_ACCESS |
| Implementer | 全部（包括 WRITE_CODE, EXECUTE_COMMAND, GIT_OPERATION） |
| Reviewer | READ_CODE, SEARCH_SYMBOL, LSP_QUERY, GIT_OPERATION（只读 git） |
| Tester | READ_CODE, WRITE_CODE, EXECUTE_COMMAND, SEARCH_SYMBOL |
| ConflictResolver | READ_CODE, WRITE_CODE, GIT_OPERATION |

不再需要硬编码 `writeToolNames = ['modify_file', ...]`——权限检查和角色限制统一通过 Capability 匹配。

### ADR-19：Runtime 硬边界——只负责生命周期和调度，业务逻辑禁止进入

Runtime 存在退化为"God Object 2.0"的风险——当 `routeModel()`、`searchMemory()`、`spawnSubAgent()`、`mergeWorktree()` 等业务能力持续进入 Runtime 时，只是把 Executor 的 God Object 搬到了 Runtime。

**硬规则：**

```typescript
// ✅ Runtime 的职责（生命周期和调度）
class AgentRuntime {
  registerComponent(c: LifecycleAware): void;
  create/resume/suspend/destroy(): Promise<void>;
  run(task: string): Promise<TaskResult>;
  cancel(reason: string): Promise<void>;
}

// ❌ 禁止进入 Runtime 的业务能力
// Runtime.routeModel()       → Router (Phase 3)
// Runtime.searchMemory()     → MemoryManager (Phase 6)
// Runtime.spawnSubAgent()    → Orchestrator (Phase 5)
// Runtime.mergeWorktree()    → SafeWorktreeManager (Phase 5)
// Runtime.collectContext()   → ContextManager (Phase 4)
// Runtime.checkPermission()  → PermissionEngine (Phase 4)
```

Runtime 只调度，不执行。所有业务能力通过 `ExecutionContext` 注入，由专门的组件实现。违反此规则的 PR 在 Code Review 阶段直接拒绝。

---

## Phase 1：核心循环现代化 (P0)

> **目标：** 建立 Runtime 调度层 + 修复阻碍可用性的根本问题。新增 `packages/runtime` 和 `packages/agent-core`。

### Task 1.0 — Agent Runtime 统一调度层 (Foundation)

**问题：** 当前 `Executor` 直接持有 ContextManager、ExecutionController、AuditLogger、PermissionEngine 等全部横向能力。随着 Phase 5 的 Planner/SubAgent/Orchestrator、未来 Web UI/VSCode 扩展等多入口加入，逻辑会分散到各入口各自实现一遍，Executor 将退化为 3000+ 行的 God Object。

**方案：** 新增 `packages/runtime`，作为所有入口（CLI/Web/VSCode/CI）共享的统一调度层。

**核心模块：**

```text
packages/runtime/src/
├── runtime.ts          → AgentRuntime（统一入口，组装所有组件）
├── lifecycle.ts        → LifecycleAware 接口 + 拓扑排序 + 初始化/关闭编排
├── session.ts          → Session 生命周期（create/resume/suspend/destroy）
├── loop.ts             → 主 Loop 控制（while evaluate → dispatch → observe）
├── state-machine.ts    → TaskState 状态机
├── event-bus.ts        → EventBus（TypedEmitter·三层分层）
├── context.ts          → ExecutionContext（注入 runtime 依赖的容器 + ServiceLocator）
├── cancellation.ts     → CancellationToken（取消传播）
├── checkpoint.ts       → Checkpoint/Recovery（序列化+恢复）
└── reconciliation.ts   → 物理世界调和（Resume 时协调逻辑状态与物理现实）
```

**AgentRuntime 接口契约：**

```typescript
class AgentRuntime {
  readonly session: Session;
  readonly eventBus: EventBus;
  readonly stateMachine: StateMachine;
  readonly context: ExecutionContext;

  // 生命周期（含组件管理）
  registerComponent(component: LifecycleAware): void;
  static create(config: RuntimeConfig): AgentRuntime;   // 内部: 拓扑排序 → init 所有组件
  static resume(sessionId: string): AgentRuntime;        // 内部: 反序列化 → 跳过已初始化组件
  suspend(): Promise<void>;
  destroy(): Promise<void>;                               // 内部: 逆序 shutdown 所有组件

  // 执行
  run(task: string): Promise<TaskResult>;
  cancel(reason: string): Promise<void>;
}
```

**统一组件生命周期 (ADR-16)：** 所有需要 init/shutdown 的组件实现 `LifecycleAware` 接口。Runtime 在 `create()` 时按依赖拓扑排序初始化。`destroy()` 时逆序调用 `shutdown()`。定期 `healthCheck` → 失败组件自动 `restart()` → 3 次失败标记 DEGRADED。确保从 Phase 1 开始杜绝孤儿进程/线程泄露。

**两阶段恢复 — 反序列化 + 物理世界调和 (Reconciliation)：**

> ⚠️ 长任务重构可能持续数小时。用户关机/网络中断后通过 `resume()` 恢复时，JSON 反序列化只能恢复状态机的**逻辑状态**（"状态=Running，当前工具=execute_command"），但物理现实已失衡——LSP 子进程早已死掉、Git Worktree 临时目录可能残留为孤儿、沙箱会话句柄失效。若 Runtime 盲目认为一切如初并继续 dispatch，会瞬间因找不到物理进程句柄而崩溃。

**方案：** `AgentRuntime.resume()` 强制执行两阶段恢复：

```
Phase A — 反序列化 (Hydration):
  从 SQLite/JSONL 恢复 Session + TaskState + 最近消息历史

Phase B — 物理世界调和 (Reconciliation):
  1. 扫描物理工作区 → 检查残留 git worktree → 清理孤儿目录或重新对接
  2. 为所有 LifecycleAware 组件派发 onRestore(snapshot) 生命周期事件
     - LSPManager: 重新 spawn LSP 进程 + 重新绑定通信管道
     - SandboxExecutor: 重新执行 preflight 诊断
     - WorkerPool: 重新拉起常热线程 + 加载 WASM
  3. 确认逻辑状态与物理现实一致 → 刷新 CancellationToken
  4. 正式激活主 Loop
```

**Runtime 硬边界 (ADR-19)：** 业务逻辑禁止进入 Runtime。Runtime 只负责生命周期管理和调度。所有业务能力（路由、搜索、子智能体、Worktree、上下文收集、权限检查）通过 `ExecutionContext` 注入，由专门组件实现。违反此规则的 PR 在 Code Review 阶段直接拒绝。

**EventBus（类型安全的事件总线，按三层分层）：**

```typescript
// 替代当前全部"直接调用"模式。解耦 Logger/Metrics/Telemetry/Web UI/Progress Bar。
// 分层设计防止 interface AgentEvents 突破 100+ 事件导致维护困难。

// L0 — 系统事件（Runtime 生命周期）
interface SystemEvents {
  'runtime:ready': {};
  'runtime:shutdown': { reason: string };
  'component:degraded': { component: string; reason: string };
  'component:recovered': { component: string };
  'session:started': { sessionId: string };
  'session:ended': { sessionId: string; reason: string };
}

// L1 — 领域事件（Agent 任务执行）
interface DomainEvents {
  'task:started': { task: string };
  'task:completed': { result: TaskResult };
  'task:failed': { error: Error };
  'task:cancelled': { reason: string };
  'state:changed': { from: TaskState; to: TaskState };
  'loop:iteration': { round: number; cost: number };
  'tool:beforeExecute': { toolName: string; args: Record<string, any> };
  'tool:afterExecute': { toolName: string; result: string; durationMs: number };
  'permission:requested': { toolName: string; args: Record<string, any> };
  'permission:granted': { toolName: string };
  'permission:denied': { toolName: string; reason: string };
  'provider:switched': { from: string; to: string; reason: string };
}

// L2 — 遥测事件（Metrics/Logging 消费）
interface TelemetryEvents {
  'budget:warning': { used: number; limit: number };
  'budget:exceeded': { used: number; limit: number };
  'checkpoint:reached': { round: number; cost: number };
  'error:recoverable': { error: Error; attempt: number };
  'error:fatal': { error: Error };
  'metric:counter': { name: string; value: number; tags?: Record<string, string> };
  'metric:histogram': { name: string; value: number; tags?: Record<string, string> };
}

type AgentEventBus = SystemEvents & DomainEvents & TelemetryEvents;
```

**TaskState 状态机（扩展子智能体/Worktree 场景）：**

```
                    ┌─────────────────────────────────────────────┐
                    │              单 Agent 主流程                  │
                    │                                              │
IDLE → PLANNING → WAIT_APPROVAL → EXECUTING → TESTING → REVIEWING → FINISHED
  │        │            │              │           │           │          │
  │        │            │              │           │           │          │
  │        └────────────┴──────────────┴───────────┴───────────┴──────────┘
  │                                    ↓
  │                            FAILED / CANCELLED
  │
  └──────────────────────────────────────────────────────────────┐
                    │        子智能体/Worktree 扩展状态              │
                    │                                              │
                    ├─ WAIT_SUBTASK      → 等待子智能体完成         │
                    ├─ MERGING           → Git merge 进行中         │
                    ├─ CONFLICT_RESOLVING → 三路归并中               │
                    ├─ PAUSED            → 用户挂起（会话保持）       │
                    └─ RECOVERING        → 从 checkpoint 恢复中     │
```

防止 `TaskState.EXECUTING` 承担"执行中/等待子任务/等待合并/等待冲突解决"四种不同含义导致状态机失真。

**新建文件：** `packages/runtime/` **新建包**
**验收：** CLI/Web/VSCode 共享同一 Runtime；Executor 不再直接持有各横向组件，改为通过 `ExecutionContext` 注入；TaskState 统一流转。

---

### Task 1.1 — 修复已知 Bug + 沙箱前置诊断

**修改文件：**
- `packages/diff-engine/src/index.ts` — 正则 `\N` → `\n`
- `packages/tool-kit/src/sandbox.ts` — `_executeLandlockBwrap` 中，read-only 用 `'--ro-bind'`，workspace-write 用 `'--bind'`（二选一，不重复）
- `packages/tool-kit/package.json` — 添加 `yaml` 依赖

**新增 — 沙箱前置诊断 (Sandbox Preflight Diagnostics)：**
- `packages/tool-kit/src/sandbox.ts` — 新增 `static async preflight(): Promise<SandboxMode>` 方法
- 检测 Linux 内核是否支持 `unprivileged user namespaces`：执行 `bwrap --version` 并尝试创建一个测试 namespace
- 若不可用 → 自动降级为 `'vfs-guard'` 模式，向控制台和审计日志输出安全警告
- macOS 同样检测 `sandbox-exec` 是否可用，不可用 → 降级
- 降级不影响 Agent 启动，但安全策略收紧

**VFS-Guard 模式的安全策略（关键设计）：**

> ⚠️ 不能在 VFS-Guard 模式下一刀切拒绝 `execute_command` 的写权限。编译命令（`pnpm build`、`cargo build`、`go build`）的底层本质是子进程向磁盘写入产物（`dist/`、`target/`、缓存），封禁写操作 = Agent 完全失去编译验证能力 → 陷入"编译失败→尝试修复→编译被拦截"死循环。

**正确策略 — CWD 强绑定 + 命令意图扫描：**

1. **CWD 强绑定**：`spawn` 子进程时 `cwd` 强制限定在项目根目录，禁止通过 `cd` 或绝对路径逃逸
2. **命令意图扫描**：执行前用正则/AST 解析命令字符串，拦截包含以下模式的危险命令：
   - 绝对路径写操作：`> /etc/...`、`>> /sys/...`
   - 路径遍历：`../` 超出项目根目录
   - 系统破坏：`rm -rf /`、`mkfs.*`
3. **写范围限制**：允许对项目目录内的写入（`dist/`、`target/`、`node_modules/`、`__pycache__/` 等编译产物路径），拦截对 `.env`、`*.key`、`*secret*` 的写入
4. **外网访问**：VFS-Guard 模式下外网默认不可达（编译依赖应从本地缓存获取）

**VFS-Guard 间接写逃逸防御 + 配置注入逃逸防御（关键安全红线）：**

> ⚠️ **逃逸路径 1（间接写）：** 大模型利用写工具在项目内创建 `test.js`（内容 `require('fs').writeFileSync('/etc/passwd', '...')`），然后 `execute_command: "node test.js"`。外层命令扫描只看到 `node test.js`，完美绕过。
>
> ⚠️ **逃逸路径 2（配置注入）：** 更隐蔽的黑客级逃逸——LLM 不直接调 `node`，而是修改 `package.json` 的 `scripts` 字段：`"build": "node malicious.js && tsc"`，或修改 Rust 项目的 `build.rs` 植入恶意代码，随后调用 `execute_command: "pnpm build"` 或 `cargo build`。由于 `pnpm` 和 `cargo` 在**静默白名单**中，系统直接放行——白名单工具顺着配置文件动态拉起埋好的恶意脚本，沙箱防线瞬时被完全绕过。

**防御策略（双层）：**

**L1 — 解释器执行提级审批（防间接写）：** VFS-Guard 模式下，任何通过解释器（`node`、`python`、`python3`、`ruby`、`php`、`bash`、`sh`、`perl`）运行项目内本地脚本文件的命令，**强制归类为高危命令**，触发 Phase 4 权限引擎的 `ask` 审批流程。白名单例外：仅 `npm`、`pnpm`、`yarn`、`cargo`、`go`、`make`、`cmake` 可静默执行。

**L2 — 配置污染标记（防配置注入）：** 当 Agent 在当前会话中修改或新建了任何敏感构建配置文件（`package.json`、`Makefile`、`Cargo.toml`、`CMakeLists.txt`、`build.rs`、`pyproject.toml`、`go.mod`、`Gemfile`、`composer.json`、`.npmrc`、`.env*` 等），该会话立即进入**"配置受污染（Polluted）"状态**。在此状态下，原本静默放行的白名单工具（`pnpm`/`npm`/`cargo`/`make`/`cmake`）**全部自动降级，取消静默资格**。

**审批去疲劳设计（关键）：** 不是每次构建都弹窗（那会产生审批疲劳导致用户盲点 Yes），而是进入 Polluted 状态后的**首次构建命令**触发**一次性综合审批**：
- 弹窗汇总展示 Agent 修改过的**全部配置文件 Diff**（而非只展示当前命令）
- 用户选择：**"仅本次放行"**（保持 Polluted，下次构建继续审批）或 **"信任本会话全部配置变更"**（恢复 Clean，后续构建恢复静默）
- 选择"信任"后，除非 Agent 再次修改配置文件，否则后续构建不再弹窗
- 审批次数从 N 次降为 1 次高质量决策——用户只需要认真看一次全部配置变更

**验收：** parseBlocks 正确解析；Linux 沙箱无重复挂载；YAML 验证可用；加固 Linux 环境自动降级不崩溃。

---

### Task 1.2 — 工具注册表 (ToolRegistry) + Schema 适配器

**问题：** `executor.ts:85-105` 用正则解析 XML → switch-case 分发。每加工具改 executor。LLM 输出 XML 格式错误率高。

**方案：** 新增 `packages/agent-core`。按 ADR-14 拆分为三个独立模块：

```typescript
// packages/agent-core/src/tool-registry.ts
// 职责：仅注册、查找、执行。不关心 schema 格式。

interface RegisteredTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  requiresApproval: boolean;
  handler: (args: Record<string, any>) => Promise<string>;
}

class ToolRegistry {
  register(tool: RegisteredTool): void;
  dispatch(name: string, args: Record<string, any>): Promise<string>;
  get(name: string): RegisteredTool | undefined;
  listAll(): RegisteredTool[];
}

// packages/agent-core/src/schema-adapter.ts
// 职责：ToolRegistry → Provider 特定格式。新增 Provider 时只改这里。

class SchemaAdapter {
  static toOpenAIFunctions(registry: ToolRegistry): OpenAIFunctionDefinition[];
  static toAnthropicTools(registry: ToolRegistry): AnthropicToolDefinition[];
  // 未来: static toGeminiFunctions(...)
}

// packages/agent-core/src/mcp-adapter.ts (Phase 7)
// 职责：ToolRegistry → MCP 协议格式
```

**初始注册工具（从现有 4 个包装 + 新增 4 个）：**

| 工具 | 来源 | 审批 | 说明 |
|------|------|:----:|------|
| `search_symbol` | `dbManager.searchSymbol` | 否 | 已有 |
| `read_file` | `toolkit.readFile` | 否 | 已有 |
| `list_files` | `toolkit.listFiles` | 否 | 新增 |
| `modify_file` | `toolkit.modifyFileWithDiff` | **是** | 已有 |
| `execute_command` | `toolkit.terminal.executeCommand` | **是** | 已有 |
| `git_status` | `toolkit.git.getStatus` | 否 | 新增 |
| `git_diff` | `toolkit.git.getDiff` | 否 | 新增 |
| `git_commit` | `toolkit.git.commitAll` | **是** | 新增 |

**修改/新建文件：**
- `packages/agent-core/src/tool-registry.ts` — **新建**
- `packages/agent-core/package.json` — **新建**
- `apps/cli/src/executor.ts` — `dispatchTool` 改为 `registry.dispatch`

**验收：** 新增工具只需 `registry.register({...})`，不修改 executor 代码；`SchemaAdapter` 为每个 Provider 输出正确格式；ToolRegistry 自身不含任何 schema 转换逻辑。

---

### Task 1.3 — System Prompt 重构

**问题：** `prompt.ts` 使用自定义 XML `<call_tool name="...">` 协议，硬编码 4 个工具和 `pnpm build` 等 Node.js 特化指令。

**方案：** 重写 System Prompt 为通用 Agent 描述。工具列表不再硬编码——由各 Provider 从 ToolRegistry 获取对应 API 格式（OpenAI/DeepSeek 用 `toOpenAIFunctions()`，Anthropic 用 `toAnthropicTools()`）。Prompt 不假设任何特定语言或构建系统。

**关键变化：**
- 移除 XML 工具格式说明 → 改为标准 function calling
- 移除 `pnpm build` 等 Node.js 特化指令
- 新增语言/构建系统自动检测指导
- 新增通用验证指令："每次修改后使用该语言的编译命令验证"
- 保留 `<task_finish>` 作为任务完成标记

**修改文件：**
- `apps/cli/src/prompt.ts` — 重写
- `apps/cli/src/executor.ts` — `chat()` 传入 `tools`（各 Provider 内部从 ToolRegistry 获取对应格式）

**验收：** Python 项目 Agent 不尝试 `pnpm build`；Rust 项目自动用 `cargo build`；工具调用走 function calling 而非 XML 正则。

---

### Task 1.4 — ILLMProvider 接口 + 初始 3 个 Provider

**问题：** `executor.ts:8` 硬编码 `DeepSeekProvider` 具体类。

**方案：** 抽取 `ILLMProvider` 接口。初始实现 3 个 Provider（DeepSeek 重构、OpenAI 新增、Anthropic 新增）。Phase 3 补充到 6 个。

**接口契约：**

```typescript
// packages/llm-provider/src/interface.ts

interface ModelCapabilities {
  maxContextTokens: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean;
  supportsVision: boolean;
  supportsThinking: boolean;
  supportsEmbedding: boolean;
}

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  tools?: FunctionDefinition[];
}

interface LLMResponse {
  content: string;
  thinkingContent?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }>;
  usage?: { promptTokens: number; completionTokens: number };
}

interface ILLMProvider {
  readonly name: string;
  readonly modelName: string;
  readonly capabilities: ModelCapabilities;

  chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;
  chatStream(messages: Message[], onChunk: (text: string) => void, options?: ChatOptions): Promise<LLMResponse>;
  countTokens(messages: Message[]): Promise<number>;
  healthCheck(): Promise<boolean>;
  embed?(texts: string[]): Promise<number[][]>;   // 可选，Phase 6 Embedding 搜索使用
  embedQuery?(query: string): Promise<number[]>;   // 可选
}
```

**3 个 Provider：**

| Provider | 模型示例 | 特点 |
|----------|---------|------|
| `DeepSeekProvider` | deepseek-v4-pro, deepseek-v4-flash | 已有重构，提取 reasoning_content |
| `OpenAIProvider` | gpt-5.3-codex | 原生 function calling，支持 embedding |
| `AnthropicProvider` | claude-sonnet-4-6 | 原生 tool_use，支持 prompt caching |

**统一环境变量命名：**
```bash
CODE_AGENT_DEEPSEEK_API_KEY=sk-...
CODE_AGENT_OPENAI_API_KEY=sk-...
CODE_AGENT_ANTHROPIC_API_KEY=sk-ant-...
```

**修改/新建文件：**
- `packages/llm-provider/src/interface.ts` — 接口 + 类型
- `packages/llm-provider/src/providers/deepseek.ts` — 重构
- `packages/llm-provider/src/providers/openai.ts` — **新建**
- `packages/llm-provider/src/providers/anthropic.ts` — **新建**
- `packages/llm-provider/src/index.ts` — 统一导出
- `apps/cli/src/executor.ts` — `private provider: ILLMProvider`

**验收：** `--provider openai --model gpt-5.3-codex` 切换模型；不指定默认 DeepSeek。

---

### Task 1.5 — 流式输出

**问题：** `executor.ts:35` 阻塞等待完整响应，用户长时间无反馈。

**方案：** 通过 `ILLMProvider.chatStream()` 实现逐字输出。thinking/reasoning 内容灰色打印。

**修改文件：**
- `packages/llm-provider/src/providers/deepseek.ts` — `chatStream`（SSE）
- `packages/llm-provider/src/providers/openai.ts` — `chatStream`（SSE）
- `packages/llm-provider/src/providers/anthropic.ts` — `chatStream`（Anthropic SSE）
- `apps/cli/src/executor.ts` — 优先 `chatStream`，fallback `chat`

**验收：** LLM 输出实时逐字显示；thinking 内容灰色且不阻塞正文输出。

---

### Task 1.6 — LLM 调用重试

**问题：** Provider 层网络瞬时故障直接 throw，整个 8 轮任务中断。

**方案：** 在各 Provider 内部添加指数退避重试。

**设计要点：**
- 可重试：5xx、网络错误、429（rate limit）、408（timeout）
- 不可重试：4xx（非 429/408）—— 请求本身有问题
- 退避公式：`baseDelayMs × 2^attempt + random(0, 1000)ms`，最大 3 次

**流式重试的终端回滚（Stream Rollback on Retry）：**

> ⚠️ Task 1.5 的逐字流式输出 + Task 1.6 的指数退避重试 = **控制台乱码冲突**。场景：模型正在流式输出，终端已实时打印了 60 个 Token。网络突然抖动导致 SSE 连接断开，底层 `withRetry` 触发重试。由于 LLM 无法从断点续传，重试必须**从头重新生成这一轮完整响应**，结果终端上出现完全重复的文本直接拼在上一段后面。

**方案 — 流式区块回滚原语（Stream Rollback Primitives）：**
- `chatStream` 的回调契约引入特殊控制信号 `{ type: 'chunk', text: string } | { type: 'reset' }`
- 当 `withRetry` 触发重试时，向终端 UI 层派发 `{ type: 'reset' }` 信号
- 终端 UI 接收到 `reset` → 清空当前轮已经投机性（Speculative）打印的流式文本 → 光标退回本轮输出起始位置 → 渲染重试后的新流

**非 TTY 环境降级（TTY Abstraction Layer）：**

> ⚠️ ANSI escape codes（`\x1b[1G`、`\x1b[A`）在交互式终端中完美工作，但在 CI/CD（GitHub Actions、GitLab CI）或日志重定向（`code-agent > agent.log`）环境中**无法擦除已打印文本**——它们会作为硬字符写入日志，导致 `^[A` 乱码 + 完全重复的多段代码吐字历史，给后期排查带来灾难。

- CLI 初始化时通过 `process.stdout.isTTY` 动态感知运行环境
- **若 `isTTY === false`（CI/CD 或日志重定向模式）：**
  1. 自动关闭投机性逐字流式输出，改为等待 LLM 完整响应后批量输出
  2. 重试时不派发 `reset` 信号，改为打印干净的一行日志：`[Network disruption. Retrying (Attempt 1/3)...]`
  3. 确保 CI/CD 管道日志绝对整洁可读

**修改文件：**
- `packages/llm-provider/src/retry.ts` — `withRetry()` 包装函数，流式模式额外支持 `onReset` 回调
- `packages/llm-provider/src/providers/*.ts` — `chat()`/`chatStream()` 包裹 `withRetry`
- `apps/cli/src/executor.ts` — 处理 `reset` 信号，终端回滚

**验收：** 网络抖动自动重试，终端无重复文本；400 错误不重试直接报错。

---

## Phase 2：代码智能统一化 (P1)

> **目标：** tree-sitter 统一索引+验证，标准 LSP 集成，三层搜索体系补全。
>
> **关键设计 — Tree-sitter 与 LSP 的 Source of Truth 边界 (ADR-13)：**
>
> | 能力 | 首选 Source | 降级 Fallback |
> |------|:---------:|---------|
> | 结构索引（符号提取、代码大纲） | Tree-sitter | — |
> | 语义分析（跳转定义、查找引用） | LSP | Tree-sitter 符号搜索 + 文本匹配 |
> | 编译诊断（类型错误、未使用变量） | LSP | Tree-sitter `hasError()` 语法检查 |
> | 语法验证（修改后文件是否可解析） | Tree-sitter | — |
>
> 查询路由规则：`lsp_definition`/`lsp_references` 优先走 LSP → 不可用降级为 tree-sitter。`search_symbol` 直接走 tree-sitter（不调 LSP）。

### Task 2.1 — tree-sitter 多语言索引器

**问题：** `context-engine/src/indexer.ts` 仅用 `ts.createSourceFile` 解析 TS/JS。

**方案：** 用 tree-sitter 替换。按文件扩展名选择对应 language grammar（WASM 绑定，零原生编译）。初始支持 TypeScript/JavaScript/Python/Rust/Go/Java/C/C++/Ruby/PHP 共 10 种语言。

**设计要点：**
- 每种语言定义 `{ extensions, grammar, symbolNodeTypes }`
- `symbolNodeTypes` 是各语言 AST 中代表"符号"的节点类型
- 从匹配节点提取 `name` 子节点文本作为符号名
- 不认识的扩展名 → 跳过，不报错
- 结果写入现有 SQLite `files` + `symbols` 表

**工程红线 — Worker Thread Pool 隔离 + 文件大小熔断 + 常热预热 (ADR-7)：**

> ⚠️ 每次动态 `new Worker()` 会启动全新 V8 实例 + 重新加载 tree-sitter WASM 运行时 + 编译 10 种语言的 `.wasm` Grammar 文件，产生 **300ms~600ms 的 CPU 密集型冷启动开销**。如果每遇大文件就临时 spawn Worker，非但不能优化性能，反而因频繁线程创建和 WASM 编译将 CPU 烧满。

**方案 — Warm Pool（常热线程池）：**
- 系统初始化时（Phase 1 启动阶段），提前拉起 `poolSize = max(2, os.cpus().length - 1)` 个常驻 Worker 线程
- 每个 Worker 启动时**预编译并常驻加载** 10 种语言的 WASM Grammar 模块
- 主线程与 Worker 仅通过 `postMessage` 传递 `{ filePath, code }` 和接收 `ParseResult`
- 确保 `parseAsync()` 是纯内存 AST 运算，单次响应 < 20ms

**长效内存自愈 — Worker 阈值轮换机制（Self-Healing Recycling）：**

> ⚠️ tree-sitter WASM 绑定底层涉及 C/C++ 内存分配与 WASM 线性内存交互。在数百轮持续重构的长续航场景中，常热 Worker 不断分配/解析/销毁 AST 节点，WASM 内存回收和 V8 Worker 线程的跨边界小对象 GC 不完美，极易发生**内存隐式泄露与堆碎片化**，运行中后期常热线程可能吞噬大量内存甚至无征兆触发 Worker 内 OOM 崩溃。

**方案：**
- 每个常驻 Worker 维护 `processedFilesCount: number` 计数器
- 当某 Worker 累计处理 ≥ 500 个文件解析请求且当前空闲时 → 主线程执行优雅重启：
  1. `worker.terminate()` — 释放全部 WASM 线性内存和 V8 孤立堆
  2. 立即 `spawn` 全新 Worker 并重新加载 10 种语言 WASM Grammar
  3. 重启期间其他 Worker 继续服务（至少保留 1 个活跃 Worker）
- 确保 Agent 连续运行数小时甚至数天时内存曲线保持平稳

**文件大小熔断：**
- `MAX_FILE_SIZE = 1MB`：超限文件直接跳过 tree-sitter 解析
- 大型文件（> 100KB 且 < 1MB）：通过 Warm Pool 异步解析
- 主线程仅处理 < 100KB 的文件

**修改文件：**
- `packages/context-engine/src/indexer.ts` — 重写为 tree-sitter 多语言版 + Worker Pool 集成
- `packages/context-engine/src/worker-pool.ts` — **新建**，`TreeSitterWorkerPool` 类
- `packages/context-engine/package.json` — 添加 tree-sitter 及 grammar 包依赖

**验收：** `.ts`/`.py`/`.rs`/`.go`/`.java` 各提取对应符号类型；`.txt`/`.md` 静默跳过；>1MB 文件跳过不阻塞；大型文件异步解析不卡主线程。

---

### Task 2.2 — tree-sitter 统一语法验证器

**问题：** `syntax-validator.ts` 中 TS/Python/Rust/Go 四种语言各写一遍相同模式：写临时文件 → 调外部编译器 → 正则解析 stderr。8 种语言被注释。此外依赖用户机器安装对应编译器。

**方案：** 利用 tree-sitter 通用特性：任何语言 AST 中语法错误节点 `hasError()` 返回 `true`。一次 DFS 定位所有错误行列号。一套代码覆盖全部 tree-sitter 支持的语言，不依赖外部编译器。

**设计要点：**
- `UnifiedSyntaxValidator` 类：`validate(filePath, sourceCode)` → `{ valid, errors[] }`
- 按文件扩展名选择 tree-sitter grammar
- DFS 遍历 → 收集 `type === 'ERROR'` 或 `isMissing()` 的节点
- 无 grammar 的语言 → 返回 `valid: true`（不阻塞修改）
- 保留 `ValidatorStrategy` 接口，允许用户注册自定义验证器
- **同样受 ADR-7 Worker Pool + 1MB 熔断线约束**，与索引器共享 `TreeSitterWorkerPool`

**tree-sitter vs 编译器验证的权衡：**

| 维度 | tree-sitter 统一验证 | 编译器验证（旧方案） |
|------|---------------------|-------------------|
| 覆盖语言 | 所有 tree-sitter 支持的语言 | 仅用户机器安装了编译器的语言 |
| 外部依赖 | 零（纯 WASM） | 需要 python3/rustc/gofmt/java 等 |
| 验证深度 | 语法（Syntax）级 | 语法 + 类型（但当前方案也只做语法） |
| 错误定位 | 精确行列号 | 依赖正则解析 stderr（各编译器格式不同） |
| 性能 | < 50ms（内存解析） | 500ms+（写临时文件 + 启动编译器进程） |

**修改文件：**
- `packages/tool-kit/src/syntax-validator.ts` — 重写为 tree-sitter 统一验证
- `packages/tool-kit/src/index.ts` — `validateSyntaxMultiLang` 适配新接口

**验收：** TS/Python/Rust/Go/Java/Ruby/PHP 任意语法错误均被捕获并返回行列号；不需要安装任何编译器；语法错误触发 `modifyFileWithDiff` 自动回滚。

---

### Task 2.3 — 标准化 LSP 集成

**问题：** v2 方案在 `LSPConnection` 中手动实现 JSON-RPC 协议：拼接 `Content-Length:` 头、维护 `pending` Map、处理 buffer 分包。这是在重新发明 Microsoft `vscode-jsonrpc` 库，后者已被 VS Code 数百万用户验证。

**方案：** 使用 `vscode-jsonrpc` + `vscode-languageclient` 标准库实现 LSP 客户端。

**关键技术选型：**

```
vscode-jsonrpc (传输层)
    ↕
vscode-languageserver-protocol (协议定义)
    ↕
我们的 LSPManager (语言路由 + 连接池)
```

**LSPManager 设计：**
- 每种语言一个 LSP Server 配置（command + args + installHint）
- 按需启动（首次访问该语言文件时才启动），连接池复用
- 使用 `vscode-languageclient` 的 `LanguageClient` 管理连接生命周期
- 不支持的语言 → 返回 null，Agent 回退到 tree-sitter 索引
- 预置 10+ 语言 Server 配置（TypeScript/pyright/rust-analyzer/gopls/clangd/solargraph/intelephense/sourcekit-lsp/OmniSharp/lua-language-server）

**工程红线 — 进程生命周期看门狗 + 工作区单例路由 (ADR-8)：**

> ⚠️ Swarm 模式下多个并发 Worker 实例可能同时调用 LSP 工具。若每个 Worker 各自 `spawn` 一个 LSP Server，一个 `rust-analyzer` 进程常驻内存 1-4GB，3 个并发 Worker = 3-12GB 内存瞬间被榨干，触发系统 OOM。

- 所有 LSP `spawn` 显式声明 `detached: false`，绑定父进程生命周期
- **工作区单例路由（Workspace-Level Singleton）：** `LSPManager` 跨所有子智能体共享。同一项目根路径（即使在不同 Git Worktree 临时分支中），必须路由到**同一个 LSP Server 进程实例**。LSP 协议原生支持并发 JSON-RPC 请求（通过 `id` 区分），无需启动多个 Server

**LSP 单例 + Git Worktree 绝对路径匹配（关键协议层红线）：**

> ⚠️ 单例路由解决内存问题，但引入 LSP 协议层死穴：Orchestrator 派生的 `Implementer-Worker-A` 在临时 Worktree（路径 `/tmp/worktree-a`）中调用 `lsp_definition` 传入绝对路径 `/tmp/worktree-a/src/index.ts`。但全局单例 LSP Server 在项目根目录（`/workspace`）初始化，它视 `/tmp/worktree-a/...` 为**不属于当前虚拟工作区的孤立文件**，不读取该临时目录下的 `tsconfig.json`/`Cargo.toml`，导致跳转定义、引用查找、诊断等功能**全面失效**（返回空或报错）。

**方案 — LSP 多根工作区（Multi-Root Workspaces）协议：**
- Orchestrator 每次动态拉起新 `SafeWorktree` 临时分支目录时，`LSPManager` 通过标准 JSON-RPC 率先向单例 LSP Server 发送 `workspace/didChangeWorkspaceFolders` 通知，**动态将该临时 Worktree 路径添加为 LSP Server 的新工作区根节点**
- LSP Server 在内存中并行索引新目录，并发 Workers 跨目录代码跳转正常工作
- Worker 销毁时（worktree remove），发送 `workspace/didChangeWorkspaceFolders` 移除该根节点
- 此方案利用 LSP 3.17+ 标准协议特性（`workspace.workspaceFolders` capability），主流 Server（tsserver、rust-analyzer、gopls、clangd）均支持
- **LSP 请求排队锁：** 若子智能体修改代码导致 LSP 需要重建索引，使用轻量读写锁确保 LSP 状态一致性，拒绝多 Worker 实例各跑各的语言服务器
- **TTL 空闲回收**：每个 LSP 连接设置 5 分钟空闲定时器，超时无 Tool Call → 调用 `shutdown()` + `exit()` 回收内存
- **全局退出清理**：`LSPManager.shutdownAll()` 注册到 `process.on('SIGINT')` / `process.on('SIGTERM')` / `process.on('exit')`，遍历连接池 `process.kill(pid)` 强制终结
- 子进程异常退出时自动重连（最多 3 次），重连失败 → 标记不可用 → 返回 null

**注册为 Agent 工具：**

| 工具 | 功能 | 审批 |
|------|------|:----:|
| `lsp_definition` | 跳转到定义 | 否 |
| `lsp_references` | 查找所有引用 | 否 |
| `lsp_diagnostics` | 获取文件诊断 | 否 |

**修改/新建文件：**
- `packages/context-engine/package.json` — 添加 `vscode-jsonrpc`、`vscode-languageclient`、`vscode-languageserver-protocol` 依赖
- `packages/context-engine/src/lsp-manager.ts` — **新建**，使用标准库的 LSP 连接管理
- `packages/agent-core/src/tool-registry.ts` — 注册 3 个 LSP 工具

**验收：** `.ts`→tsserver、`.py`→pyright、`.rs`→rust-analyzer，正常跳转定义和查找引用；某语言 LSP 不可用 → 提示安装而不是崩溃；代码中无手动 `Content-Length:` 字符串拼接。

---

### Task 2.4 — ripgrep 文本搜索 (L2)

**问题：** 当前只有 SQLite `search_symbol`（按符号名搜索），无法按任意文本模式搜索代码内容。

**方案：** 基于 ripgrep 的文本搜索工具，rg 不可用时降级为 `fast-glob` + `fs.readFile`。

**设计要点：**
- `CodeSearcher.grep(pattern, options)` → `[{ file, line, content }]`
- 选项：`path`（限定目录）、`fileTypes`（按扩展名过滤）、`maxResults`（默认 50）、`caseSensitive`
- 注册为 Agent 工具 `grep_search`

**新建文件：** `packages/context-engine/src/searcher.ts`
**验收：** 搜索返回 `file:line:content`；rg 不可用时自动降级。

---

### Task 2.5 — FTS5 全文索引 (L1 增强)

**问题：** `db.ts:58` 使用 `WHERE name LIKE '%query%'` —— O(n) 全表扫描，只搜符号名。

**方案：** SQLite FTS5 虚拟表，索引符号名 + 代码片段，搜索速度 O(log n)。

**修改文件：**
- `packages/context-engine/src/db.ts` — FTS5 虚拟表 + `searchFts(query, limit)` + `insertSymbolToFts()`
- `packages/context-engine/src/indexer.ts` — 索引时同步写入 FTS5
- `packages/agent-core/src/tool-registry.ts` — 注册 `fts_search` 工具

**验收：** `searchFts("auth")` 返回带高亮片段的结果；10000 符号搜索 < 5ms。

---

## Phase 3：多模型与 AI Gateway (P1)

> **目标：** 6 个 Provider + 智能模型路由 + 成本追踪。AI Gateway 是本项目超越竞品的核心差异化能力。
>
> **架构决策 — Gateway 分解为协调器 + 可插拔策略组件 (ADR-15)：**
>
> ```
> AIGateway (协调器·仅编排)
>   ├─ Router            → 路由决策（规则匹配 + 质量升级策略）
>   ├─ CostTracker       → 成本累加与上限检查
>   ├─ HealthManager     → 健康检查与故障标记
>   └─ FallbackManager   → 降级链管理
> ```
>
> 每个组件独立实现、独立测试、可替换。Gateway 不直接处理路由逻辑，只调度。

### Task 3.1 — 补充 Provider 至 6 个

| Provider | 文件 | 模型 | 优先级 |
|----------|------|------|:----:|
| `DeepSeekProvider` | `providers/deepseek.ts` | deepseek-v4-pro/flash | P0（Phase 1 已完成） |
| `OpenAIProvider` | `providers/openai.ts` | gpt-5.3-codex | P0（Phase 1 已完成） |
| `AnthropicProvider` | `providers/anthropic.ts` | claude-sonnet-4-6 | P0（Phase 1 已完成） |
| `GoogleProvider` | `providers/google.ts` | gemini-2.5-pro | P1 |
| `OpenRouterProvider` | `providers/openrouter.ts` | 300+ 模型统一入口 | P1 |
| `OllamaProvider` | `providers/ollama.ts` | 本地开源模型（qwen3 等） | P1 |

**每个 Provider 实现：** `chat()`、`chatStream()`、`countTokens()`、`healthCheck()`。必要时 `embed()` / `embedQuery()`。

**验收：** 6 个 Provider 全部通过 `healthCheck()`；`--provider ollama --model qwen3:14b` 可运行本地模型。

---

### Task 3.2 — AI Gateway 自动路由

**问题：** 竞品（Claude Code、Codex CLI）锁定单一模型。用户面对不同任务（简单搜索 vs 大型重构）被迫用同一个昂贵模型。

**方案：** AI Gateway 分析任务特征 → 按规则自动路由到最优模型。用户也可手动覆盖。

**架构：**

```
用户任务
    │
    ▼
┌──────────────┐
│  TaskAnalyzer │  ← 分析: 复杂度 (simple/medium/complex)
│               │          领域 (search/generation/planning/debugging)
│               │          隐私需求 (containsSecrets → 本地模型)
└──────┬───────┘
       │ TaskAnalysis
       ▼
┌──────────────┐
│  Rule Engine  │  ← 按优先级匹配路由规则
│               │     healthCheck 检查可用性
│               │     故障自动 fallback
└──────┬───────┘
       │ selected provider
       ▼
┌──────────────┐
│ ILLMProvider  │  ← 被选中的模型执行
└──────────────┘
```

**任务分析维度：**
- `complexity`：关键词启发式（simple/medium/complex）
- `domain`：code_search / code_generation / refactoring / planning / debugging
- `containsSecrets`：敏感任务 → 路由到本地模型
- `estimatedTokens`：预估 token 消耗

**默认路由规则：**

| 规则 | 条件 | 目标 Provider | 原因 |
|------|------|-------------|------|
| 简单搜索 | domain=search, complexity=simple | DeepSeek Flash | 成本降低 90% |
| 架构规划 | domain=planning 或 complexity=complex | Anthropic Claude | 最强推理能力 |
| 代码生成 | domain=generation, complexity=medium | OpenAI GPT | 代码专项优化 |
| 调试 | domain=debugging | DeepSeek Pro | 性价比最优 |
| 本地隐私 | containsSecrets=true | Ollama 本地 | 数据不出机器 |
| 默认 | 以上都不匹配 | DeepSeek Pro | 平衡选择 |

**容错机制（三层递进）：**

**L1 — 网络故障容错（healthCheck）：** 首选 Provider healthCheck 失败 → 跳过该规则 → 下一个匹配规则 → 最终 fallback 到默认 Provider。

**L2 — 质量驱动型动态升级（Quality-Driven Escalation Routing）：** 这是本项目的核心差异化。传统 fallback 只处理网络故障，但更危险的是"智商故障"——任务被识别为 simple 并分发给廉价模型，但廉价模型因能力不足持续输出错误代码，导致 Task 2.2 语法验证或编译反复失败，Agent 在 ReAct 循环中陷入"错误死循环"直到财务熔断。

```
[廉价模型生成] → [tree-sitter 验证/编译报错] → [连续失败计数器 +1]
                        │
                        ▼ (连续报错 ≥ 2 次)
[AI Gateway 拦截] → [自动路由升级: Flash→Pro→Sonnet→Opus] → [突破智商墙]
```

- 每个任务维护一个 `consecutiveValidationFailure: number` 计数器
- 同一任务连续 2 次通过语法验证/编译检查失败 → AI Gateway 强制将 Provider 升级一级
- 升级轨迹：DeepSeek Flash → DeepSeek Pro → Claude Sonnet → Claude Opus
- 升级后的结果记录到 `RouteRule` 审计日志，用于优化初始路由规则

**L2 升级与上下文裁剪的冲突解决 — Reflection Snapshot（反思快照）：**

> ⚠️ Task 4.3 的上下文裁剪（token 紧张时仅保留最近 4 轮）+ L2 模型升级 = **智能体失忆症**。当 Flash 连续犯错 2 次触发升级为 Sonnet 后，Sonnet 拿到的是被裁剪后的历史——前几次 Flash 犯错的根本原因和具体 Stderr 报错已被丢弃。高阶模型失去"前车之鉴"，极可能用更高成本完美复刻刚才低阶模型的错误，升级策略彻底失效。

**方案：** 模型升级触发时，`ContextManager` 在裁剪前提取失败轮次的关键信息，压缩为紧凑的反思快照，强制置顶注入到新模型的上下文头部：

```xml
<failed_attempts_summary>
前 2 轮尝试由 {previousModel} 执行，均因以下错误失败：
- Round 1: tool="modify_file" → 语法验证失败: Line 42: Unexpected token '}'
- Round 2: tool="modify_file" → 编译错误: Type 'string' is not assignable to type 'number'
核心问题: {根因分析摘要}
</failed_attempts_summary>
```

该快照在裁剪后、新模型首轮对话前注入，确保高阶模型一上场就能看到战局全貌。

**L3 — 手动覆盖：** `--provider openai` 手动指定 → 跳过全部路由逻辑，直接使用指定模型。

**新建文件：**
- `packages/llm-provider/src/gateway.ts` — `AIGateway`、`TaskAnalyzer`、`RouteRule`

**验收：**
- "搜索用户认证代码" → 自动路由到 DeepSeek Flash
- "重构整个认证系统架构" → 自动路由到 Anthropic Claude
- Provider 宕机 → 自动 fallback 到下一个可用 Provider
- `--provider openai` 手动覆盖 → 跳过路由，直接使用指定模型

---

### Task 3.3 — 成本追踪

**问题：** 无成本可见性。用户不知道一次任务花了多少钱。

**方案：** 在 AI Gateway 层记录每次 LLM 调用的 token 消耗和费用。会话结束时输出汇总。

**定价模型（$/1M tokens）：**

| 模型 | Input | Output |
|------|-------|--------|
| deepseek-v4-flash | $0.14 | $0.28 |
| deepseek-v4-pro | $0.50 | $2.00 |
| gpt-5.3-codex | $1.25 | $10.00 |
| claude-sonnet-4-6 | $3.00 | $15.00 |
| gemini-2.5-pro | $1.25 | $10.00 |
| ollama 本地 | $0 | $0 |

**修改文件：** `packages/llm-provider/src/gateway.ts` — 成本计算 + 会话汇总
**验收：** 会话结束时输出 "总成本: $0.0234 (1,234 tokens)"。

---

## Phase 4：安全与治理 (P1)

> **目标：** 人机协同审批、操作审计追踪、上下文窗口管理。

### Task 4.1 — 权限引擎 + Capability 系统

**问题：** 所有工具无审批机制。Agent 可静默修改文件或执行命令。且子智能体角色限制（Planner 只读/Implementer 完整）目前只能用硬编码工具名列表实现。

**方案：** 统一 Capability 系统 (ADR-18) 作为权限和角色的共同基础。每个 Tool 声明其绑定的 Capability，每个 SubAgent 角色声明其允许的 Capability。权限引擎升级为 Capability 级别的检查。

**Capability 枚举：**
`READ_CODE | WRITE_CODE | SEARCH_SYMBOL | EXECUTE_COMMAND | GIT_OPERATION | LSP_QUERY | MEMORY_ACCESS | MCP_EXTERNAL | EMBEDDING_SEARCH`

**设计要点：**
- 每个 `RegisteredTool` 新增 `capabilities: Capability[]` 字段
- 每个 `SubagentConfig` 新增 `allowedCapabilities: Capability[]` 字段
- `PermissionEngine.check(capability, args)` — 按 Capability 检查权限，而非按工具名
- 三层模型：allow（直接执行）、deny（拒绝）、ask（展示预览，等待用户确认）
- 按路径模式细化（如 `.env` → deny 覆盖 READ_CODE 的默认 allow）
- 配置来源：`.code-agent/permissions.yml`（项目级 → `~/.code-agent/permissions.yml` → 内置默认值）
- 审批交互：终端展示 Diff 预览 → `inquirer confirm` → 用户输入 y/n

**不再需要** `writeToolNames = ['modify_file', 'execute_command', 'git_commit']` 硬编码——Plan Mode 直接注入 `allowedCapabilities: [READ_CODE, SEARCH_SYMBOL, LSP_QUERY]`。

**配置文件结构：**
```yaml
# .code-agent/permissions.yml
defaults:
  read_file: allow
  list_files: allow
  search_symbol: allow
  grep_search: allow
  fts_search: allow
  lsp_definition: allow
  lsp_references: allow
  lsp_diagnostics: allow
  git_status: allow
  git_diff: allow
  modify_file: ask
  execute_command: ask
  git_commit: ask

rules:
  - toolName: read_file
    pathPatterns:
      - pattern: ".env"
        permission: deny
      - pattern: "**/secrets/**"
        permission: deny
  - toolName: execute_command
    commandPatterns:
      - pattern: "pnpm *"
        permission: allow
      - pattern: "npm test*"
        permission: allow
```

**新建文件：** `packages/agent-core/src/permission-engine.ts`
**修改文件：** `packages/agent-core/src/tool-registry.ts` — dispatch 前调用权限检查

**验收：** `modify_file` 触发审批展示 diff → 用户确认后执行；`read_file .env` 被 deny；`search_symbol` 直接执行。

---

### Task 4.2 — 审计日志与会话恢复

**问题：** 无持久化日志。8 轮后熔断或网络错误 → 全部上下文丢失。

**方案：** JSONL 格式审计日志。每行一个 JSON 事件。支持从日志重建完整对话历史。

**事件类型：**
`session_metadata` → `task_start` → `llm_request` → `llm_response` → `tool_call` → `tool_result` → `permission_check` → `error` → `route_decision` → `task_finish`

**关键方法：**
- `AuditLogger.log(event)` — 追加一行 JSON
- `AuditLogger.loadHistory(sessionId)` — 重建 `Message[]`
- `AuditLogger.listSessions()` → `[{ id, date, taskPreview }]`

**新建文件：** `packages/logger/src/audit-logger.ts` — **新建包**
**修改文件：** `apps/cli/src/executor.ts` — 关键节点插入 `logger.log()`；`apps/cli/src/index.ts` — `--resume`、`--list-sessions`

**验收：** 每次运行自动生成 `~/.code-agent/logs/{id}.jsonl`；中断后 `--resume <id>` 完整恢复；`--list-sessions` 列出历史。

---

### Task 4.3 — 动态执行控制与上下文管理

**问题：** 两个相关的问题需要统一解决：

1. **固定 8 轮静态熔断（`executor.ts:12`）：** 业界无一使用。代码修复天然需要高频迭代——修复一个编译错误就可能消耗 7 轮，8 轮限制让稍大任务无法完成。Claude Code 用 `ANTHROPIC_COST_BUDGET` + `/goal` 检测，Codex CLI 用 `token_budget` + 可选 `turn_budget`，Aider 无任何内置轮数限制。

2. **`history` 数组无限增长：** 工具返回可能数千行编译错误，逼近 token 上限。

**方案：** 构建 `ExecutionController` 类，对齐 Claude Code/Codex CLI 的**财务预算 + Goal 检测 + 死循环检测**三层模式，外加上下文管理。

#### 4.3.1 动态执行控制（ExecutionController + 子组件拆分）

**问题：** 当前 ExecutionController 承担 Budget、Goal Detection、Loop Detection、Checkpoint、User Approval 全部职责。随着 SubAgent/Parallel Agent/Worktree/Reviewer/Tester 全部进入调度，单文件将突破 3000+ 行。按 ADR-12 拆分为编排器 + 独立子组件。

**接口契约：**

```typescript
// packages/agent-core/src/execution-controller.ts — 仅做编排

class ExecutionController {
  private loopGuard: LoopGuard;
  private budgetManager: BudgetManager;
  private goalManager: GoalManager;
  private checkpointManager: CheckpointManager;

  // 委托给各子组件，按优先级链式检查
  async evaluate(toolCall: ToolCall, toolResult: string, taskGoal: string): Promise<EvalResult>;
}

// 各子组件独立实现，可单独测试和替换

class LoopGuard {
  // 语义死循环检测：最近 N 轮 ToolCall+Result 哈希比对
  detectDeadLoop(recentCalls: HashEntry[]): DeadLoopResult;
}

class BudgetManager {
  // 财务熔断：对标 Claude Code ANTHROPIC_COST_BUDGET
  checkBudget(usedCostUsd: number, maxBudgetUsd: number): BudgetResult;
}

class GoalManager {
  // Goal 完成检测：对标 Claude Code /goal validator
  // 启发式前置过滤 + 压缩上下文 + 步长节流阀
  async evaluateGoal(taskGoal: string, lastTool: string, lastResult: string, gitDiff: string): Promise<GoalResult>;
}

class CheckpointManager {
  // 人机检查点：每 N 轮阻塞弹窗
  async shouldCheckpoint(loopCount: number): Promise<CheckpointResult>;
}
```

**三层控制架构（对齐业界）：**

```
每一轮工具执行后:

┌──────────────────────────────────────────────┐
│ L1 — 语义死循环检测（对标 Ouro Loop / Loop Breaker）│
│   最近 3 轮 ToolCall+Result 哈希比对             │
│   → 完全相同 → 拦截 + 触发 Re-plan              │
├──────────────────────────────────────────────┤
│ L2 — 财务熔断（对标 Claude Code COST_BUDGET）    │
│   AI Gateway 实时累加费用 ≥ maxBudgetUsd        │
│   → 优雅终止："预算 $X 已用完，已执行 N 轮"        │
├──────────────────────────────────────────────┤
│ L3 — Goal 完成检测（对标 Claude Code /goal）      │
│   每轮用轻量模型（DeepSeek Flash）检查目标是否达成   │
│   → 已达成 → 自动标记 task_finish，不继续消耗轮数   │
├──────────────────────────────────────────────┤
│ L4 — 人机检查点（对标 Codex CLI turn_budget）     │
│   loopCount % 15 === 0                        │
│   → 阻塞弹窗: "已完成 N 轮(成本 $X)，是否继续?"    │
│   → 用户批准 → 继续 / 拒绝 → 优雅终止             │
└──────────────────────────────────────────────┘
```

**Goal 完成检测设计（对标 Claude Code `/goal` validator model）：**

```
每轮 Executor 执行后:
  ┌─────────────────────────────────┐
  │ 轻量检测 Prompt:                 │
  │ "原始任务: {taskGoal}            │
  │  已完成的操作: {recentActions}    │
  │  当前状态: {currentState}         │
  │                                  │
  │  任务目标是否已完全达成?          │
  │  回答: YES (附原因) / NO (附原因)" │
  └─────────────────────────────────┘
           │
           ▼
   YES → 自动注入 task_finish，优雅终止
   NO  → 继续下一轮
```

- 使用最便宜的模型（DeepSeek Flash, $0.14/1M tokens）执行检测
- 单次检测成本极低（< $0.0001）
- 若 Goal 检测模型不可用 → 跳过，回退到财务+死循环检测

**性能优化 — 触发式判定 + 压缩上下文（避免每轮开销风暴）：**

> ⚠️ 两个叠加问题：(1) 即使 Flash 模型单次 API 延迟 0.8s~1.5s，30 轮任务多出 45 秒；(2) **更严重的**——若每轮盲目把全量上下文（数万 Token 的对话历史 + 文件内容 + LSP 诊断 + 终端输出）发给 Goal 检测模型，判定模型累加的 Token 费用甚至会**超过主推理模型本身**。

**规则 1 — 触发式判定（非轮询式）：** 仅以下情况才触发 Goal 检测 LLM：
- Agent 输出了 `<task_finish>` 标记 → 直接视为完成，跳过检测模型
- 上一轮工具是 `git_commit` → 代码已提交，触发检测
- `execute_command` 返回测试通过日志（`exitCode=0` + 含 `PASS`/`ok`）→ 触发检测
- 以上均不满足 → 跳过 LLM 检测，本地直接判定 `goalAchieved = false`

**规则 2 — 判定上下文极致压缩：** 触发检测时，不传入全量对话历史（数万 Token），**仅传入**：
- 用户原始任务描述（Goal）
- 当前最新的 `git diff` 摘要（哪些文件被改了，改了什么）
- 最后一轮工具的执行结果（编译/测试是否通过）
- 将判定上下文从数万 Token 压缩至 **< 500 Token**，单次检测成本从 $0.001 降至 $0.00005

**规则 3 — 步长保底节流阀：** 若上述触发条件均未满足，则每 5 轮允许触发一次轻量 Goal 检测（防止 Agent 在大量小修改中迷失方向但从未触发里程碑）。将盲等 RTT 延迟从 30 轮 × 1s = 30s 压缩至 30 轮 ÷ 5 × 1s = 6s。

**规则 4 — 只读跳过：** `search_symbol`、`grep_search`、`read_file`、`lsp_definition` 等只读工具执行后直接跳过（本地判定 `goalAchieved = false`），零 API 调用，零延迟。

**综合效果：** 纯搜索任务每轮控制流开销 = 0ms + $0；里程碑任务额外增加 1s + $0.00005 检测成本；长任务额外增加步长保底检测。判定模型总体开销 < 主推理模型的 1%。

**为什么用财务预算而非轮数（对标业界决策）：**
- Claude Code: `ANTHROPIC_COST_BUDGET` 是首要限制，不限轮数
- Codex CLI: `token_budget` 是首要限制，`turn_budget` 可选且默认 null=无限
- 学术界（arXiv 2510.16786）："Fixed max_turns lacks adaptability"
- 便宜模型（DeepSeek Flash $0.14/$0.28）跑 50 轮成本几美分，完全可继续
- 贵模型（Claude Opus $15/$75）可能 10 轮就触发 $3 上限
- 财务预算天然适配 AI Gateway 的模型路由：任务越简单→路由到便宜模型→同样预算跑更多轮

#### 4.3.2 上下文窗口管理（ContextManager + ContextSource 抽象）

**问题：** 当前上下文来源单一（history 数组）。未来 Memory、SubAgent 结果、Planner 输出、Reviewer 评论、Embedding 搜索结果、LSP 诊断结果全部需要注入上下文。若用 `if (...) push(history)` 管理，代码将失控。

**方案 — ContextSource 统一抽象：**

```typescript
interface ContextChunk {
  priority: 'system' | 'high' | 'medium' | 'low';  // 裁剪优先级
  content: string;
  tokens: number;
  source: string;  // 'memory' | 'subagent' | 'planner' | 'lsp' | 'tool_result' | ...
}

interface ContextSource {
  readonly name: string;
  collect(executionState: ExecutionState): Promise<ContextChunk[]>;
}
```

所有上下文来源（Memory、SubAgent 摘要、Planner 计划、LSP 诊断、工具结果）实现 `ContextSource` 接口。`ContextManager` 统一收集 → 按优先级排序 → 按 token 预算裁剪 → 注入 System Prompt 前缀。新增上下文来源只需 `contextManager.registerSource(newSource)`，不改核心裁剪逻辑。

**传统三种裁剪策略保留：** Token 计数监控 + Observation 压缩（> 3000 字符截头尾）+ 智能裁剪（token > 75% 时保留 system + 高优先级 chunk + 最近 4 轮）。

**提示词缓存优化：** System Prompt 和工具定义作为静态前缀，放在消息列表最前，匹配 Anthropic/OpenAI prompt caching 的 cache break 边界。

**新建文件：**
- `packages/agent-core/src/execution-controller.ts` — `ExecutionController` 类
- `packages/agent-core/src/context-manager.ts` — `ContextManager` 类

**修改文件：**
- `apps/cli/src/executor.ts` — 用 `while(await controller.evaluate(...))` 替代 `for(i=1; i<=8; i++)`
- `packages/llm-provider/src/gateway.ts` — 暴露 `getSessionCost()` 接口供 ExecutionController 查询

**验收：**
- 简单 typo 修复：3 轮内完成，Goal 检测自动终止
- 复杂多文件重构 + 编译纠偏：可运行 20+ 轮不崩溃
- Agent 对同一命令死磕 3 次 → 语义死循环检测瞬间拦截
- 会话成本达 $3 → 财务熔断触发，优雅终止
- 每 15 轮 → 弹窗询问用户是否继续
- Goal 检测：任务完成后自动停止，不浪费额外轮数
- 5000 行编译错误 → 进入 LLM < 2000 字符；system prompt 始终保留

---

## Phase 5：高级智能体模式 (P2)

> **目标：** Plan Mode 双智能体分离 + 5 种预置子智能体 + 编排器 + Git Worktree 隔离。

### Task 5.1 — Plan Mode（双智能体分离）

**问题：** Agent 直接开始修改代码。复杂任务（"重构认证系统"）无全局理解就盲目改动。

**方案：** 双阶段工作流：
- **Phase A（Planner）：** 仅可调用只读工具，探索代码库后输出结构化 JSON 执行计划
- **用户审批：** 展示计划（目标、涉及文件、步骤、风险、回滚策略），用户确认或拒绝
- **Phase B（Executor）：** 按批准计划逐步执行，每步后验证

**Planner 工具限制实现：** 不再使用 `writeToolNames = ['modify_file', 'execute_command', 'git_commit']` 硬编码工具名列表。直接注入 `allowedCapabilities: [READ_CODE, SEARCH_SYMBOL, LSP_QUERY, EMBEDDING_SEARCH, MEMORY_ACCESS]` —— dispatch 前按 Capability 匹配 → 不在允许列表的工具返回 "Planning mode: 只读模式，此工具不可用"

**执行计划格式：**
```json
{
  "goal": "任务目标",
  "approach": "方案概述",
  "complexity": "simple|medium|complex",
  "filesToModify": ["path/to/file.ts"],
  "filesToCreate": ["path/to/new.ts"],
  "steps": [
    { "id": 1, "description": "...", "tool": "...", "file": "...", "expectedOutcome": "...", "dependsOn": [], "validation": "编译命令" }
  ],
  "risks": ["潜在风险"],
  "rollbackStrategy": "回滚方式"
}
```

**新建文件：** `packages/agent-core/src/planner.ts`
**修改文件：** `apps/cli/src/index.ts` — 新增 `plan` 命令

**验收：** Planner 只能搜索/阅读；计划需用户审批才执行；用户拒绝 → 零副作用。

---

### Task 5.2 — 专属特化子智能体集群 (Subagent Pool)

**设计目标：** 每种角色绑定专属 System Prompt 和工具子集，上下文隔离。不同角色使用不同模型（便宜模型做搜索，强模型做审查）。

**核心设计哲学 — 静态角色定义 + 动态实例派生：**

> 拒绝"完全动态发明角色"的泛 AI Agent 模式（AutoGen、CrewAI Demo）。代码编写是精密工程——一个能稳定输出高质量 Unified Diff 或执行三路 Git 归并的智能体，其 System Prompt 需经过成百上千次微调才能达到工业级可靠性。如果让 LLM 在运行时动态发明新角色并自写 System Prompt，会遇到三个无法逾越的工程死穴：
>
> 1. **安全边界崩溃**：权限引擎（Task 4.1）无法为"未知角色"预判权限——若 LLM 幻觉给只读角色赋予了写权限，可能误删代码库
> 2. **Prompt 退化**：动态生成的 Prompt 退化为"你是一个代码专家"，面对复杂重构时工具调用正确率断崖下跌
> 3. **软件工程天然确定性**：研发生命周期固定（探索→规划→实现→审查→测试→合并），6 种角色已完美覆盖全部节点
>
> **动态性体现在"任务拆解"和"实例克隆"，而非"角色发明"。** 这是 Devin、LangGraph、Sweep 等一线 Code Agent 的共同选择。

**架构：**

```
                       ┌──────────────────────┐
                       │   用户 / Orchestrator  │
                       └──────────┬───────────┘
                                  │
           ┌──────────────────────┼──────────────────────┐
           │                      │                      │
           ▼                      ▼                      ▼
     ┌──────────┐          ┌──────────┐          ┌──────────┐
     │ Explorer │          │ Reviewer │          │  Tester  │
     │ 只读·Flash│          │ 只读·Opus│          │ 读写·均衡│
     └──────────┘          └──────────┘          └──────────┘
           │                      │                      │
           └──────────────────────┼──────────────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼                           ▼
              ┌──────────┐               ┌──────────┐
              │ Planner  │               │Implementer│
              │ 只读·Opus│               │ 读写·Sonnet│
              └──────────┘               └──────────┘
                                  │
                                  ▼
                          ┌──────────────┐
                          │ConflictResolver│
                          │  读写·Opus    │
                          └──────────────┘
```

**6 种子智能体：**

| 角色 | 权限 | 推荐模型 | maxLoops | 职责 |
|------|:----:|---------|:----:|------|
| **Explorer** | 只读 | DeepSeek Flash | 4 | 代码搜索与信息收集，返回精确 file:line |
| **Planner** | 只读 | Anthropic Claude | 8 | 架构分析，输出结构化 JSON 执行计划 |
| **Implementer** | 完整 | OpenAI GPT | 12 | 代码编写，每次修改后验证编译 |
| **Reviewer** | 只读 | Anthropic Claude | 4 | 安全/正确性/性能/风格四维代码审查 |
| **Tester** | 完整 | DeepSeek Pro | 8 | 测试用例生成与执行验证 |
| **ConflictResolver** | 完整 | Anthropic Claude | 4 | Git 合并冲突的三路归并解决 |

**ConflictResolver 设计说明：**

> ⚠️ Task 5.4 中 `safeMerge` 检测到冲突时，Git 会在代码中留下物理冲突标记（`<<<<<<< HEAD`、`=======`、`>>>>>>> branch`）。如果直接将冲突文件交给普通 Implementer 处理，Agent 看到这些标记会陷入困惑，或将其当作正常代码编译引发更大面积语法崩溃。

**ConflictResolver 专属工作流：**
1. 接收冲突文件的三个版本：Base（共同祖先）、Ours（当前分支）、Theirs（合并分支）
2. 分析两分支各自的修改意图（从子智能体的 `SubagentResult.summary` 获取上下文）
3. 生成无冲突标记的干净合并代码
4. 写入文件后执行 `git add` 标记冲突已解决
5. 调用编译验证 → 通过则 `git commit` 完成合并

**推荐使用强推理模型**（Anthropic Claude Sonnet/Opus），因为三路归并需要理解两个分支的语义差异并做出正确取舍。

**接口契约：**

```typescript
// packages/agent-core/src/subagent/types.ts

type SubagentRole = 'explorer' | 'planner' | 'implementer' | 'reviewer' | 'tester' | 'conflictResolver';

interface SubagentConfig {
  role: SubagentRole;
  name: string;                    // 唯一实例标识，如 "implementer-worker-A"
  description: string;
  systemPrompt: string;            // 角色绑定的静态 Prompt（非动态生成）
  provider: ILLMProvider;
  tools: ToolRegistry;             // 独立的工具子集（只读或完整，由角色静态决定）
  maxLoops: number;
  temperature?: number;
}

interface SubagentResult {
  success: boolean;
  role: SubagentRole;
  summary: string;              // 结果摘要（灌回主 Agent，非完整对话）
  findings: string[];
  filesModified: string[];
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
}

class SubagentRunner {
  run(config: SubagentConfig, task: string): Promise<SubagentResult>;
}
```

**上下文隔离机制：** 每个子智能体实例独立创建 `history: Message[]`，独立调用 LLM。同角色不同 Worker（如 Implementer-Worker-A vs Implementer-Worker-B）上下文完全隔离。完成后仅将 `SubagentResult.summary` 灌回 Orchestrator。不共享 conversation history。

**新建文件：**
- `packages/agent-core/src/subagent/types.ts`
- `packages/agent-core/src/subagent/runner.ts`
- `packages/agent-core/src/subagent/builtins.ts` — 6 种内置子智能体的静态 System Prompt 和工具配置

**验收：** 同角色多 Worker 实例上下文互不污染；Explorer 用便宜模型搜索、Reviewer 用强模型审查、ConflictResolver 用强推理模型做三路归并；用户可通过配置文件扩展现有角色的变体（不同模型/不同温度参数），但不能动态发明未知角色类型。

---

### Task 5.3 — 动态多并发编排器 (Orchestrator & Swarm Scheduler)

**问题：** 复杂任务需要多个子智能体协作，当前只能单个 Agent 串行执行。

**方案：** Orchestrator 接收 Planner 的全局规划 → 构建 DAG 任务依赖图 → 动态派生 Worker 实例 → 协调执行并汇总结果。

**核心设计 — 任务 DAG 动态分解 + 同角色多 Worker 并发伸缩：**

> 系统的"动态性"体现在两层：(1) Planner 将巨型任务拆分构建 DAG 依赖图；(2) Orchestrator 对无依赖的并行子任务，动态克隆多个同角色 Worker 实例并发执行。角色定义是静态的（6 种），实例数量是动态的（按任务规模伸缩）。

**三种协作模式（角色固定，派生方式不同）：**

| 模式 | Worker 派生方式 | 适用场景 |
|------|----------------|---------|
| **Orchestrator** | 按 DAG 拓扑序串行委派，每步 1 Worker | 有依赖的多步骤任务 |
| **Pipeline** | 每阶段 1 Worker，流水线传递（A→B→C） | 提取→分析→转换→验证 |
| **Swarm** | 同任务派生 N 个同角色 Worker 并行，评判模型选最优 | 多方案对比选优 |

**执行流程（以复杂任务"重构认证模块（auth.ts + user.ts + logger.ts）"为例）：**

```
1. Planner 子智能体探索 → 构建 DAG 任务依赖图:

   子任务 A (修改 auth.ts 路由) ──┐
   子任务 B (修改 user.ts 模型)  ──┼── 无相互依赖，可并行
   子任务 C (修改 logger.ts 埋点)──┘
                                     │
                                     ▼
                              子任务 D (集成测试验证) ← 依赖 A+B+C 全部完成

2. Orchestrator 动态派生 Worker 实例:
   - Spawn: Implementer-Worker-A → SafeWorktree(分支 agent/A)
   - Spawn: Implementer-Worker-B → SafeWorktree(分支 agent/B)
   - Spawn: Implementer-Worker-C → SafeWorktree(分支 agent/C)
   [三 Worker 并发执行，互斥锁串行化 Git 写操作 (ADR-9)]

3. 三 Worker 全部完成 → SafeMerge 合并回主分支
   → 若冲突 → Spawn ConflictResolver-Worker-1 执行三路归并

4. 进入下一 DAG 层:
   - Spawn: Tester-Worker-D → 运行集成测试验证
   - Spawn: Reviewer-Worker-1 → 审查 A+B+C 全部修改

5. 结果汇总 → 返回给用户
```

**状态机流水线（Pipeline-State-Machine）：**

```
每个 Worker 实例的生命周期:
  [Spawned] → [Running] → [Finished]
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        [Success]     [Needs Review]    [Failed]
              │               │               │
              ▼               ▼               ▼
         下一步骤       Spawn Reviewer   重试/升级/人工介入
                      → [Approved] → 下一步骤
                      → [Rejected] → 打回 Implementer 重做
```

**动态 Worker 数量控制：**
- 并行 Worker 上限 = `max(2, os.cpus().length - 2)`
- 超出上限的子任务排队，按 DAG 依赖优先级调度
- 每个 Worker 独立 `ExecutionController` 实例（财务预算 + 死循环检测独立核算）

**工程红线 — DAG 依赖分析 + 统一合并门禁：**

> ⚠️ ADR-9 的 `AsyncMutex` 解决了 `.git/index.lock` 物理文件锁冲突（Crash），但**不解决逻辑冲突**。若 Worker-1 和 Worker-2 修改了同一文件的不同区域，Worker-1 先 merge 成功，Worker-2 后 merge 触发 Git 冲突 —— 此时不能简单报错终止。

**规则 1 — 拓扑依赖分析：** Planner 在任务拆解阶段必须执行**文件级交集检测**：
- 若两个子任务修改的文件集有交集 → 标记为有依赖 → Orchestrator 编排为**串行流水线**，禁止并发
- 仅完全无交集的模块修改才允许派生动态并发 Worker

**规则 2 — 统一合并门禁（Merge Gate）：** 所有 Worker 完成后：
- 不自行直接 commit 到主分支
- 将各自的分支提交给 Orchestrator 核心工作流
- Orchestrator **串行**执行 `git merge`（同一时刻只有一次 merge 持有 `AsyncMutex`）
- 一旦触发冲突 → 暂停流水线 → 启动 `ConflictResolver` 专属上下文执行三路归并
- 归并修复后 → **必须重新运行全局 Tester 验证**（所有已合并分支的测试必须通过）
- Tester 失败 → 回滚最后一次 merge → 人工介入或重试

**新建文件：** `packages/agent-core/src/orchestrator.ts`
**修改文件：** `packages/agent-core/src/subagent/types.ts` — `SubagentRole` 增加 `'conflictResolver'`

**验收：**
- 简单任务（fix typo）→ 直接 Spawn 1 个 Implementer Worker
- 复杂任务（3 文件重构）→ DAG 拆解为 4 子任务 + 3 个 Implementer Worker 并发
- Swarm 模式 → 同任务 3 个 Implementer Worker 并行出方案，评判模型选最优
- Worker 失败 → 该 Worker 的 worktree 清理，不影响其他 Worker
- Git 合并冲突 → 自动 Spawn ConflictResolver Worker 解决

---

### Task 5.4 — Git Worktree 隔离

**问题：** 多个并行子智能体同时修改同一文件 → 冲突。子智能体修改破坏主工作区 → 难以恢复。

**方案：** 需要修改文件的子智能体获得独立的 git worktree（临时分支），完成后变更通过 git merge 合并回主分支。冲突时 Orchestrator 介入解决。

**核心流程：**
```
1. 为主工作区创建临时分支 agent/{subagentId}-{timestamp}
2. git worktree add → 隔离的工作目录
3. 子智能体在 worktree 中自由修改
4. 完成后 → git add + git commit
5. git merge 回主分支
6. 冲突 → 列出冲突文件 → Orchestrator 介入解决（或 git merge --abort 回退）
7. git worktree remove + git branch -D 清理
```

**工程红线 — Async Mutex 精准锁粒度 (ADR-9)：**

Git Worktree 底层为每个 Worktree 创建独立 index 文件（`.git/worktrees/<name>/index`），不同 Worktree 内的 `git add`/`git commit` 天然并行无冲突。`AsyncMutex` 不应覆盖子智能体内部的 Git 操作（那会把并行拉低成串行），而应精准施加在 `WorktreeManager` 的**工作区生命周期管理方法**上：

```typescript
// packages/agent-core/src/subagent/worktree.ts

import { Mutex } from 'async-mutex';

class SafeWorktreeManager {
  private adminMutex = new Mutex();  // 仅保护全局 refs 管理操作

  async createWorktree(subagentId: string): Promise<WorktreeContext> {
    return this.adminMutex.runExclusive(async () => {
      // git worktree add 操作全局 refs，需加锁
      await execa({ cwd: this.projectRoot })`git worktree add ${path} ${branch}`;
    });
  }

  async destroyWorktree(context: WorktreeContext): Promise<void> {
    return this.adminMutex.runExclusive(async () => {
      // git worktree remove 操作全局 refs，需加锁
      await execa({ cwd: this.projectRoot })`git worktree remove ${context.path} --force`;
      await execa({ cwd: this.projectRoot })`git branch -D ${context.branch}`;
    });
  }

  // 子智能体在各自 Worktree 内的 git add/commit 无需加锁，天然并行
}

// Orchestrator 层的 safeMerge 需要独立的 mergeMutex（合并操作在主仓库执行，操作全局 refs）
```

**新建文件：** `packages/agent-core/src/subagent/worktree.ts` — `SafeWorktreeManager` 类

**冲突解决流程（Orchestrator + ConflictResolver 协作）：**

```
safeMerge() 返回 { success: false, conflicts: ['src/auth.ts', 'src/types.ts'] }
    │
    ▼
Orchestrator 提取冲突文件内容（含 <<<<<<< HEAD / ======= / >>>>>>> 标记）
    │
    ▼
启动 ConflictResolver 子智能体（强推理模型，专属三路归并 System Prompt）:
  输入: 冲突代码块 + 两分支子智能体的 SubagentResult.summary（修改意图）
  输出: 干净的无冲突合并代码
    │
    ▼
ConflictResolver 写入合并代码 → git add → 编译验证 → git commit
    │
    ▼
验证通过 → Orchestrator 继续下一个子任务
验证失败 → 人工介入或回退
```

**验收：** 并行子智能体修改不同文件 → 无冲突合并成功；同时提交 → 互斥锁排队，无 `index.lock` 报错；修改同一文件 → ConflictResolver 自动三路归并解决冲突；子智能体失败 → worktree 清理不影响主工作区。

---

## Phase 6：记忆与知识 (P2)

> **目标：** 跨会话记忆累积 + Embedding 语义搜索（L3）。

### Task 6.1 — 跨会话记忆系统

**问题：** 每次会话从零开始。Agent 不知道上次任务的决策、项目的特定约束、用户的编码偏好。

**方案：** 基于 SQLite + FTS5 的记忆系统。自动从对话中提取有价值的记忆，相关任务时自动注入 System Prompt。

**记忆类型：**
- `project_fact` — 项目架构、模块依存、构建系统
- `user_preference` — 编码风格、命名约定、工具偏好
- `feedback` — 用户纠正记录（"不要改 package-lock.json"）
- `pattern` — 常见问题解决模式

**接口契约：**

```typescript
interface MemoryEntry {
  id: string;
  type: 'project_fact' | 'user_preference' | 'feedback' | 'pattern';
  content: string;
  context: string;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

class MemoryManager {
  remember(type, content, context): Promise<string>;
  recall(query: string, limit?: number): Promise<MemoryEntry[]>;
  injectMemories(systemPrompt: string, task: string): Promise<string>;
  recordFeedback(incorrectBehavior: string, correction: string): Promise<void>;
}
```

**存储：** `~/.code-agent/memory.db`（SQLite + FTS5 全文索引）

**新建包：** `packages/memory/src/memory-manager.ts`
**验收：** 用户纠正 "不要改 lock 文件" → 后续任务 Agent 自动避免；相关记忆自动注入 System Prompt。

---

### Task 6.2 — Embedding 语义搜索 (L3)

**为什么需要 Embedding 搜索（与 FTS5/grep 的关系）：**

```
搜索需求层次:
  L1 (FTS5 符号搜索)    → "找到名为 authenticate 的函数"     → 精确符号名匹配
  L2 (ripgrep 文本搜索)  → "找到所有调用 authenticate 的地方" → 文本模式匹配
  L3 (Embedding 语义搜索) → "找到处理用户登录认证的代码"       → 语义意图匹配
```

L3 解决的核心问题：**用户描述的"意图"和代码中的"实现"使用了不同的词汇。**
- "用户登录认证" ↔ `login()`, `signIn()`, `auth middleware`, `verifyCredentials()`, `passport.authenticate()`
- FTS5 和 grep 搜不到语义相关但文本不同的代码
- Embedding 向量通过余弦相似度可以跨越词汇鸿沟

**方案：** 使用 LLM Provider 的 embedding API 生成代码向量，本地存储并计算余弦相似度。

**设计要点：**
- 代码分块：按函数/类/逻辑块切分，每块 100-500 行
- **层级切块 + 元数据注入 (ADR-10)：** 每个代码块送入 Embedding API 之前，自动拼接上下文头信息：
  ```text
  // File: src/services/auth/middleware.ts
  // Enclosing: class SessionAuthenticator implements IAuth
  // =============================================================
  [原始代码片段]
  ```
  注入文件路径和外层类/函数签名，解决"切块内部全是底层逻辑、不含业务关键词"导致的语义召回失败。此技术可将向量检索精确度提升 40%+。
- 向量生成：调用 `provider.embed(texts)`（OpenAI 原生支持，DeepSeek 后续支持）
- 本地存储：SQLite 存储 `{ id, text, file, line, embedding: JSON }`
- 搜索：用户 query 生成向量 → 与所有代码块计算余弦相似度 → 返回 topK
- embedding API 不可用时：自动降级为 FTS5 搜索（Agent 行为无感知）

**工程红线 — 增量脏文件缓存（Incremental Dirty-File Cache）：**

> ⚠️ 在包含数十轮的大型重构任务中，`Implementer` 可能已修改了 `src/auth/middleware.ts` 的核心逻辑。但 L3 语义搜索的向量库中存储的仍是**重构前的旧代码切块**——Agent 基于过时的语义知识做出错误决策。若每次 `modify_file` 后都重新切块+调 Embedding API+写入向量库，又会导致巨大的网络延迟和 Token 成本。

**方案：**
- 维护一个会话级 `DirtyFileSet`：被 `modify_file` 修改过的文件自动加入
- 语义检索时：先从向量库召回 Top-K 结果 → 检查召回文件是否在 `DirtyFileSet` 中
- 若命中脏文件 → 跳过向量库中的旧切块，**对该文件的最新内存内容进行实时 tree-sitter AST 解析或 FTS5 检索**作为替代
- 会话结束后异步批量更新脏文件的 Embedding 向量（后台任务，不阻塞 Agent）

**注册为 Agent 工具：** `semantic_search` — "用自然语言描述搜索代码"

**新建文件：** `packages/context-engine/src/embeddings.ts` — `EmbeddingSearch` 类
**验收：** 搜索 "用户登录" 命中 `login()`, `signIn()`, `authenticate()` 等文本不同但语义相关的代码；embedding API 不可用时自动降级 FTS5；切块包含文件路径和外层作用域元数据；脏文件自动跳过旧向量，使用实时内容检索。

---

## Phase 7：生态与工程化 (P2)

> **目标：** MCP 生态对接、Hooks/Skills 扩展系统、测试覆盖、CLI 完善。

### Task 7.1 — MCP Server + Client

**MCP Server（暴露我们的工具）：**
- 文件：`packages/tool-kit/src/mcp-server.ts`
- 实现 `initialize`、`tools/list`、`tools/call`
- 传输层：stdio（JSON-RPC 2.0），内部复用 `ToolRegistry.getMCPSchemas()` + `dispatch()`
- 外部 AI 客户端（Claude Desktop、Cursor）可连接我们的 MCP Server

**MCP Client（连接外部工具）：**
- 文件：`packages/agent-core/src/mcp-client.ts`
- 通过 stdio 启动外部 MCP Server 子进程
- 将其工具以 `mcp_{serverName}_` 前缀动态注册到本地 ToolRegistry
- 外部工具默认 requiresApproval: true
- 支持 Streamable HTTP transport（Phase 7 后续）

**验收：** `tools/list` 返回全部工具 schema；连接 GitHub MCP Server 后 Agent 可使用 `mcp_github_*` 工具。

---

### Task 7.2 — Hooks 系统

**问题：** 用户希望在特定事件发生前后执行自定义逻辑（lint 检查、自动格式化、通知）。

**方案：** 事件驱动的 Hook 引擎，支持 6 种事件类型。

| 事件 | 触发时机 | 典型用途 |
|------|---------|---------|
| `on_session_start` | 会话开始时 | 加载项目配置、检查环境 |
| `pre_tool_call` | 工具执行前 | lint 检查、pre-commit 验证 |
| `post_tool_call` | 工具执行后 | 记录日志、触发通知 |
| `pre_task_finish` | 任务完成前 | 运行完整测试套件 |
| `on_error` | 发生错误时 | 错误诊断、自动恢复 |
| `on_session_end` | 会话结束时 | 清理资源、生成报告 |

**Hook 类型：** `command`（执行 shell 命令）和 `prompt`（注入 LLM 提示词）

**配置示例：**
```yaml
# .code-agent/hooks.yml
hooks:
  - name: lint_before_modify
    event: pre_tool_call
    condition: "toolName === 'modify_file'"
    type: command
    action: "pnpm lint"
  - name: build_before_finish
    event: pre_task_finish
    type: command
    action: "pnpm build && pnpm test"
```

**新建文件：** `packages/agent-core/src/hooks.ts` — `HooksEngine` 类
**验收：** `modify_file` 前自动运行 lint；`pre_task_finish` 自动运行构建+测试。

---

### Task 7.3 — Skills 系统

**问题：** 某些任务需要领域特定的工作流引导（如修复 typo、生成 API 文档、迁移数据库 schema）。

**方案：** Skill 是 Markdown 格式的指令文件（frontmatter + 内容体）。系统根据用户任务自动匹配合适的 Skill，将其内容注入 System Prompt。

**Skill 格式：**
```markdown
---
name: fix-typo
description: 修复拼写错误 typo 修正错字
tools: read_file, modify_file, execute_command, lsp_diagnostics
---

## 流程
1. 使用 read_file 读取目标文件
2. 识别拼写错误（变量名、注释、字符串）
3. 使用 modify_file 修正
4. 使用 execute_command 运行编译验证
5. 输出 <task_finish>修正完成</task_finish>
```

**匹配机制：** 将用户任务的词汇与 Skill description 的关键词做交集匹配。

**新建文件：** `packages/agent-core/src/skills.ts` — `SkillLoader`、`SkillMatcher`
**验收：** "修复 typo" 自动匹配 fix-typo skill；用户可自定义 Skill（放在 `.code-agent/skills/` 目录）。

---

### Task 7.4 — 测试覆盖

#### 7.4.1 单元测试

| 测试文件 | 测试内容 | 优先级 |
|---------|---------|:----:|
| `diff-engine/__tests__/diff-engine.test.ts` | parseBlocks（单/多块/空）、applyPatch（精准/回退）、generateUnifiedDiff | P0 |
| `tool-kit/__tests__/path-safety.test.ts` | resolveSafe 路径遍历防护 | P0 |
| `tool-kit/__tests__/syntax-validator.test.ts` | 统一验证器各语言正确/错误/未知扩展名 | P0 |
| `tool-kit/__tests__/sandbox-preflight.test.ts` | 沙箱前置诊断：Bubblewrap 可用/不可用/降级 | P0 |
| `context-engine/__tests__/db.test.ts` | 插入/搜索/清除/FTS5 | P0 |
| `context-engine/__tests__/indexer.test.ts` | tree-sitter 多语言符号提取 + Worker Pool 异步解析 | P0 |
| `agent-core/__tests__/tool-registry.test.ts` | 注册/分发/function calling 生成 | P1 |
| `agent-core/__tests__/context-manager.test.ts` | Token 计数/裁剪/压缩 | P1 |
| `agent-core/__tests__/permission-engine.test.ts` | allow/deny/ask 规则匹配 | P1 |
| `agent-core/__tests__/worktree-mutex.test.ts` | AsyncMutex 串行化：并行提交不冲突 | P1 |
| `llm-provider/__tests__/gateway.test.ts` | 任务分析/路由规则/质量升级/故障切换 | P1 |

#### 7.4.2 E2E 集成回归测试套件 (CI/CD 准入门禁)

单元测试通过无法保证 Agent 在真实项目中能正确完成端到端任务。必须构建 **Mock Project Fixtures** 进行 E2E 验证。

**Mock 项目设计：** 在 `fixtures/mock-projects/` 下创建多语言示例项目：

```
fixtures/mock-projects/
├── calculator-app/           # 混合语言项目
│   ├── ts/calc.ts            # 包含 1 个故意注入的类型错误
│   ├── py/calc.py            # 包含 1 个故意注入的语法错误
│   ├── go/calc.go            # 包含 1 个故意注入的逻辑错误
│   └── tests/                # 部分失败的测试用例
├── broken-api/               # 单语言项目，API 路由有 bug
│   └── src/routes.ts
└── refactor-target/          # 需要跨文件重构的项目
    └── src/**/*.ts
```

**E2E 测试脚本：** 利用 CLI 拉起 Agent，输入真实提示词，验证端到端结果：

```typescript
// tests/e2e/calculator-fix.test.ts (vitest)
describe('E2E: calculator-app bug fix', () => {
  it('should fix all bugs and make tests pass', async () => {
    // 1. 复制 mock 项目到临时目录（避免污染源码）
    // 2. 启动 Agent: code-agent agent --cwd <tmp> "修复 calculator-app 项目中的所有 Bug 并使测试全部通过"
    // 3. 等待 Agent 执行完成
    // 4. 断言: 退出码 = 0
    // 5. 断言: git diff 显示文件被修改
    // 6. 断言: 各语言编译通过 (tsc, python -m py_compile, go build)
    // 7. 断言: 测试全部通过
  });
});
```

**E2E 测试覆盖场景：**

| 场景 | Mock 项目 | 断言标准 |
|------|----------|---------|
| 修复多语言 bug | `calculator-app` | 3 语言编译通过 + 测试通过 |
| API 路由 bug 修复 | `broken-api` | TypeScript 编译通过 + API 测试通过 |
| 跨文件重构 | `refactor-target` | 重构完成 + 原有功能不受影响 |
| 沙箱安全：拒绝读取敏感文件 | 任意项目 | Agent 尝试读 `.env` 被 deny |
| 审批流程：修改文件需用户确认 | 任意项目 | `modify_file` 触发审批 |

**CI/CD 集成：** E2E 测试作为 `pnpm test:e2e` 命令独立运行（耗时长），每次 PR 合并前必须通过。单元测试 `pnpm test` 作为 pre-commit hook 快速检查。

**工程命令：** `pnpm add -D vitest -w`，目标 P0 覆盖率 ≥ 70%，E2E 全场景通过。

**验收：** `pnpm test` 全部通过；`pnpm test:e2e` 全部通过；calculator-app 中 3 个 bug 被 Agent 自动修复。

---

### Task 7.5 — CLI 完善

**新增命令入口：**

```bash
# 核心模式
code-agent agent                     # 交互式 Agent（已有）
code-agent plan "需求描述"            # Plan Mode（新增）
code-agent orchestrate "需求描述"     # 多智能体编排（新增）

# 会话管理
code-agent --resume <session-id>     # 恢复会话（新增）
code-agent --list-sessions           # 列出历史（新增）

# 模型与沙箱
code-agent --provider openai --model gpt-5.3-codex agent
code-agent --sandbox read-only plan "分析代码安全性"

# MCP
code-agent mcp-server                # 启动 MCP Server (stdio)（新增）
```

**修改文件：** `apps/cli/src/index.ts`

**验收：** 所有命令入口可用；参数正确切换 Provider/模型/沙箱模式。

---

### Task 7.6 — CLAUDE.md 生成

**文件：** 项目根 `CLAUDE.md`，描述项目概述、技术栈、包结构、常用命令、代码风格。

**验收：** 外部 AI 助手读取后能快速理解项目并给出正确建议。

---

### Task 7.7 — Metrics 遥测系统

**问题：** Audit Log（Task 4.2）记录了原始事件，但不提供聚合指标。排查"为什么 Agent 成功率下降"时需要手动分析 JSONL 文件。

**方案：** 新增 `MetricsCollector`，监听 EventBus（Task 1.0），实时聚合结构化指标：

```typescript
class MetricsCollector {
  // 会话级指标
  sessionTaskCount: Counter;
  sessionSuccessRate: Gauge;
  sessionAvgLoopsPerTask: Histogram;
  sessionAvgCostPerTask: Histogram;

  // 工具级指标
  toolCallCount: Counter;           // 按 toolName 分组
  toolSuccessRate: Gauge;           // 按 toolName 分组
  toolAvgDurationMs: Histogram;

  // Provider 级指标
  providerCallCount: Counter;       // 按 provider 分组
  providerAvgLatencyMs: Histogram;
  providerRouteHitRate: Gauge;      // AI Gateway 路由命中率

  // 安全指标
  approvalCount: Counter;           // 审批次数
  approvalDenyRate: Gauge;          // 拒绝率
  sandboxDegradationCount: Counter; // 沙箱降级次数

  // 导出
  toJSON(): MetricsSnapshot;
  toPrometheus(): string;           // 可选: Prometheus 格式
}
```

**不依赖 Audit Log 二次分析** — Metrics 直接从 EventBus 消费事件，实时聚合。

**数据流单源模式（防止双写）：**

```
业务代码 → EventBus → AuditLogger（JSONL 日志）
                   → MetricsCollector（聚合指标）
```

永远不允许业务代码直接调 `AuditLogger.log()` 又直接调 `MetricsCollector.increment()`。AuditLogger 和 MetricsCollector 都是 EventBus 的消费者，业务代码只 emit 事件。确保日志和指标从同一事件源派生，数据永远一致。

**新建文件：** `packages/agent-core/src/metrics.ts`
**验收：** 每次会话结束输出 Metrics 摘要；核心指标正确追踪；业务代码无直接 Metrics/Audit 双写调用。

---

## Phase 依赖关系

```
Phase 1 (核心循环) ─────────────────────────────────────────────
  │  无依赖，立即开始
  │  产出: ToolRegistry + ILLMProvider + 流式 + Prompt + 重试
  │
  ├─→ Phase 2 (代码智能) ─────────────────────────────────────
  │    依赖: Phase 1 ToolRegistry（注册搜索工具）
  │    产出: tree-sitter 索引 + 统一验证 + LSP + ripgrep + FTS5
  │
  ├─→ Phase 3 (AI Gateway) ───────────────────────────────────
  │    依赖: Phase 1 ILLMProvider 接口
  │    产出: 6 Provider + 自动路由 + 成本追踪
  │
  ├─→ Phase 4 (安全治理) ─────────────────────────────────────
  │    依赖: Phase 1 ToolRegistry（权限插在 dispatch）
  │    产出: 权限引擎 + 审计日志 + 上下文管理
  │
  ├─→ Phase 5 (高级智能体) ───────────────────────────────────
  │    依赖: Phase 3 ILLMProvider（不同角色不同模型）
  │           Phase 4 权限引擎（Planner 只读限制）
  │    产出: Plan Mode + 5 子智能体 + Orchestrator + Worktree
  │
  ├─→ Phase 6 (记忆与知识) ───────────────────────────────────
  │    依赖: Phase 3 ILLMProvider（embed API）
  │    产出: 跨会话记忆 + Embedding 搜索
  │
  └─→ Phase 7 (生态工程) ─────────────────────────────────────
       依赖: Phase 1-6 稳定 API
       产出: MCP + Hooks + Skills + 测试 + CLI
```

---

## 与 v2 方案对比

| 维度 | v2 | v3 |
|------|----|----|
| Phase 数 | 10 Phase，40+ Task | 7 Phase，25 Task |
| 代码状态 | Phase 0 大量已实现却被当待建 | 开篇列出已完成，只修 bug |
| 语法验证 | 15 语言各一个 Validator 策略类 | 1 个 tree-sitter 通用验证器 |
| LSP 集成 | 手动 spawn + 拼接 `Content-Length:` 头 | `vscode-jsonrpc` + `vscode-languageclient` 标准库 |
| 沙箱 | Seatbelt + Bubblewrap（已实现） | 保留并修 bug，容器作为可选增强 |
| MCP | 内部工具也走 MCP | 仅用于外部生态对接 |
| AI Gateway | 关键词硬编码路由 | 多维任务分析 + 规则引擎 + 故障 fallback |
| Embedding 搜索 | 无 fallback | 有，embedding API 不可用时自动降级 FTS5 |
| 子智能体 | 5 种预置但无上下文隔离说明 | 5 种预置 + 显式上下文隔离 + Worktree |
| 文档风格 | 粘贴数千行实现代码 | 只描述接口契约、设计决策、验收标准 |

---

> 配套文档: [COMPARISON.md](./COMPARISON.md)
