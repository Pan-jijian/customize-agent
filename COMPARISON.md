# Code Agent vs Claude Code vs Codex CLI — 全面对比分析与演进路线

> 📅 2026-06-13 | 基于当前项目代码 (v1.0 MVP) 与竞品 2026 年最新版本对比

---

## 目录

1. [项目当前架构回顾](#1-项目当前架构回顾)
2. [竞品深度剖析](#2-竞品深度剖析)
3. [能力差距矩阵](#3-能力差距矩阵)
4. [核心缺失能力与补充方案](#4-核心缺失能力与补充方案)
5. [如何超越 — 通用型多模型 Agent 愿景](#5-如何超越--通用型多模型-agent-愿景)
6. [目标架构设计](#6-目标架构设计)
7. [实施路线图](#7-实施路线图)
8. [关键差异化技术方案](#8-关键差异化技术方案)

---

## 1. 项目当前架构回顾

### 1.1 拓扑结构

```
code-agent/ (pnpm Monorepo, 6 包, ~800 行 TS)
│
├── apps/cli/                       ← 用户入口
│   ├── index.ts                    ← CLI 启动 + 交互菜单 + AST 索引扫描
│   ├── executor.ts                 ← ReAct 自治循环 (最多 8 轮)
│   └── prompt.ts                   ← 系统提示词 (自定义 XML 工具协议)
│
└── packages/
    ├── shared/                     ← Message, LLMResponse 类型
    ├── llm-provider/               ← DeepSeek API 封装 (OpenAI SDK)
    ├── context-engine/             ← SQLite + TS AST 符号索引
    ├── diff-engine/                ← SEARCH/REPLACE 文本 diff 解析
    └── tool-kit/                   ← 文件读写、终端执行、Git 操作
```

### 1.2 核心循环

```
while (loop < 8 && !task_finish):
    response = LLM.chat(history)
    if <task_finish> → break
    observation = dispatchTool(response)    // 解析 <call_tool> XML
    history.push(assistant, observation)
```

### 1.3 当前工具集 (4 个)

| 工具 | 实现 | 状态 |
|------|------|------|
| `search_symbol` | SQLite LIKE 模糊搜索 AST 符号 | ✅ 基础可用 |
| `read_file` | fs.readFile 直接读取 | ✅ 无路径保护 |
| `modify_file` | SEARCH/REPLACE → fs.writeFile | ⚠️ 无回滚、无语法验证 |
| `execute_command` | execa shell 执行 | ⚠️ 黑名单式安全 |

### 1.4 已知限制

- 仅支持 DeepSeek 模型（硬编码）
- 自定义 XML 工具协议（非标准，LLM 可能输出非法格式）
- 无流式输出
- 无权限/审批系统
- 无日志持久化
- 无 LSP 集成（仅 AST 符号提取）
- 无子智能体/并行任务
- 无 MCP 协议支持
- 零测试覆盖

---

## 2. 竞品深度剖析

### 2.1 Claude Code (Anthropic)

| 维度 | 详情 |
|------|------|
| **定位** | "Senior Developer" — 缜密、协作、高质量 |
| **默认模型** | Claude Opus 4.8 / Sonnet 4.6 / Haiku 4.5 |
| **上下文窗口** | 200K–1M tokens |
| **架构** | 三层模型：核心层 → 委托层 → 扩展层 |
| **开源** | 闭源 |
| **SWE-bench** | 88.6% (业界最高) |
| **价格** | $20–$200/月 |

#### 核心能力

**三层架构：**

```
┌─────────────────────────────────────────┐
│          EXTENSION LAYER                 │
│  MCP (300+ 服务) | Hooks | Skills        │
├─────────────────────────────────────────┤
│          DELEGATION LAYER                │
│  Subagents (Explore/Plan/General)        │
│  Agent Teams (多智能体协作)               │
│  Dynamic Workflows (大规模编排)           │
├─────────────────────────────────────────┤
│          CORE LAYER                      │
│  ReAct Loop + 工具集 + 权限系统           │
│  记忆系统 + 上下文管理 + 流式输出          │
└─────────────────────────────────────────┘
```

**关键差异化特性：**
- **子智能体系统**: Explore (快速搜索)、Plan (架构规划)、General-purpose (通用任务)、自定义子智能体
- **Agent Teams**: 多智能体对等协作，共享任务列表，独立 git worktree
- **Dynamic Workflows**: 编写编排脚本，生成数十到数百个并行子智能体
- **MCP 生态**: 300+ 外部服务连接，Streamable HTTP 传输
- **Hooks 系统**: PreToolUse / PostToolUse / Stop 事件钩子
- **Skills 系统**: Markdown 定义的技能包，自动触发或 `/` 调用
- **权限系统**: 7 层 allow/deny/ask，支持通配符，层级继承
- **记忆系统**: 跨会话持久化记忆，自动关联召回
- **Plan Mode**: 先规划后实施的结构化工作流
- **流式输出**: 实时 token 级流式
- **多模态**: 图片理解、PDF 阅读
- **IDE 集成**: VS Code、JetBrains、桌面应用、Web

### 2.2 Codex CLI (OpenAI)

| 维度 | 详情 |
|------|------|
| **定位** | "Fast Intern" — 快速、轻量、自主 |
| **默认模型** | GPT-5.3-Codex / GPT-5.5 |
| **上下文窗口** | ~400K tokens |
| **架构** | Cloud-first + 本地 CLI (Rust 原生) |
| **开源** | Apache 2.0 (Rust, 71,700+ Stars) |
| **Terminal-Bench 2.0** | 82.7% |
| **价格** | $20–$200/月 |

#### 核心能力

**沙箱架构（OS 级隔离）：**

| 平台 | 技术 |
|------|------|
| macOS | Apple Seatbelt (`/usr/bin/sandbox-exec`) |
| Linux | Landlock + seccomp + Bubblewrap |
| Windows | Restricted Tokens |

三种沙箱模式：`read-only` / `workspace-write` / `danger-full-access`

**关键差异化特性：**
- **OS 级沙箱**: 不是权限提示，而是内核级强制隔离
- **Rust 原生**: 冷启动 <200ms，单二进制，零运行时依赖
- **Cloud-first**: 任务可在云端持续运行，终端断开不影响
- **自动压缩**: 上下文超限时自动调用 compaction 端点
- **Prompt 缓存**: 静态内容前置以命中缓存，推理成本线性化
- **MCP 集成**: 与内置工具同等的 schema 验证和沙箱限制
- **/goal 命令**: 持久化目标，跨进程重启

### 2.3 两者共同的能力基线 (2026 年标配)

这些是**任何一个成熟的 Coding Agent 都必须具备**的能力：

| 能力 | Claude Code | Codex CLI | 本项目 |
|------|:----------:|:---------:|:------:|
| ReAct 循环 | ✅ | ✅ | ✅ |
| 文件读写 | ✅ | ✅ | ✅ |
| 终端命令执行 | ✅ | ✅ | ✅ |
| 代码搜索 (grep/glob) | ✅ | ✅ | ❌ |
| Git 集成 | ✅ | ✅ | ⚠️ 已实现未注册 |
| 流式输出 | ✅ | ✅ | ❌ |
| 权限/审批系统 | ✅ | ✅ | ❌ |
| MCP 协议 | ✅ | ✅ | ❌ |
| 子智能体/多智能体 | ✅ | ✅ | ❌ |
| 上下文窗口管理 | ✅ | ✅ | ❌ |
| LSP 代码理解 | ⚠️ 间接 | ⚠️ 间接 | ❌ (仅 AST) |
| 沙箱/隔离执行 | ⚠️ 权限式 | ✅ OS 级 | ❌ |
| Plan Mode | ✅ | ✅ | ❌ |
| 记忆/学习 | ✅ | ❌ | ❌ |
| Hooks/事件系统 | ✅ | ❌ | ❌ |
| Skills/插件系统 | ✅ | ❌ | ❌ |
| 多模态 (图片/PDF) | ✅ | ✅ | ❌ |
| IDE 集成 | ✅ | ✅ | ❌ |
| 开源 | ❌ | ✅ Apache 2.0 | ✅ |
| 多模型支持 | ❌ (仅 Anthropic) | ❌ (仅 OpenAI) | ⚠️ 仅 DeepSeek |

---

## 3. 能力差距矩阵

### 3.1 差距分类

```
🟢 已有基础    🟡 部分具备    🔴 完全缺失
```

| 类别 | 能力 | 本项目 | Claude Code | Codex CLI | 差距 |
|------|------|:------:|:----------:|:---------:|:----:|
| **核心循环** | ReAct Agent Loop | 🟢 | 🟢 | 🟢 | — |
| | 多轮对话历史 | 🟢 | 🟢 | 🟢 | — |
| | 工具调用协议 | 🟡 XML | 🟢 JSON Tool Use | 🟢 JSON Tool Use | 🔴 |
| **代码理解** | 符号搜索 | 🟡 AST+SQLite | 🟢 LSP+MCP | 🟢 Grep+Embedding | 🔴 |
| | 正则/grep 搜索 | 🔴 | 🟢 | 🟢 | 🔴 |
| | 文件 glob 匹配 | 🟢 | 🟢 | 🟢 | — |
| | 语义搜索 (embedding) | 🔴 | 🟢 | 🟢 | 🔴 |
| **代码修改** | 文件读取 | 🟢 | 🟢 | 🟢 | — |
| | 文件写入/编辑 | 🟡 无回滚 | 🟢 | 🟢 | 🔴 |
| | Diff 预览 | 🟡 仅成功消息 | 🟢 | 🟢 | 🔴 |
| | 修改回滚 | 🔴 | 🟢 checkpoint | 🟢 sandbox | 🔴 |
| **安全** | 路径沙箱 | 🔴 | 🟢 | 🟢 OS级 | 🔴 |
| | 命令白名单/沙箱 | 🟡 黑名单 | 🟢 权限系统 | 🟢 OS级 | 🔴 |
| | 审批工作流 | 🔴 | 🟢 | 🟢 | 🔴 |
| | 密钥保护 | 🔴 | 🟢 | 🟢 | 🔴 |
| **智能体** | 子智能体/委派 | 🔴 | 🟢 | 🟢 | 🔴 |
| | 并行执行 | 🔴 | 🟢 | 🟢 | 🔴 |
| | 多智能体协作 | 🔴 | 🟢 Teams | 🔴 | 🔴 |
| **LLM** | 流式输出 | 🔴 | 🟢 | 🟢 | 🔴 |
| | 多模型支持 | 🟡 仅DeepSeek | 🔴 仅Anthropic | 🔴 仅OpenAI | 🟡 |
| | 模型切换/路由 | 🔴 | 🔴 | 🔴 | 🟢 机会! |
| | Thinking/推理展示 | 🟡 丢弃了 | 🟢 | 🟢 | 🟡 |
| | 重试/退避 | 🔴 | 🟢 | 🟢 | 🔴 |
| **上下文** | Token 管理 | 🔴 无界增长 | 🟢 自动总结 | 🟢 自动压缩 | 🔴 |
| | Prompt 缓存 | 🔴 | 🟢 | 🟢 | 🔴 |
| | 记忆持久化 | 🔴 | 🟢 | 🔴 | 🔴 |
| **扩展** | MCP 协议 | 🔴 | 🟢 | 🟢 | 🔴 |
| | Hooks/事件 | 🔴 | 🟢 | 🔴 | 🔴 |
| | Skills/插件 | 🔴 | 🟢 | 🔴 | 🔴 |
| | 自定义子智能体 | 🔴 | 🟢 | 🔴 | 🔴 |
| **工程化** | 日志/审计 | 🔴 | 🟢 | 🟢 | 🔴 |
| | 测试覆盖 | 🔴 | 🟢 | 🟢 | 🔴 |
| | 会话恢复 | 🔴 | 🟢 | 🟢 | 🔴 |
| | 配置系统 | 🟡 硬编码 | 🟢 | 🟢 | 🔴 |

---

## 4. 核心缺失能力与补充方案

### 4.1 🔴 P0 — 安全基础设施 (不补则危)

#### 4.1.1 路径沙箱

**现状:** `path.resolve(cwd, llmProvidedPath)` 无任何校验，LLM 可读取 `../../.env`。

**方案:** 在 `ToolKit` 层添加统一的路径解析守卫：
```typescript
private resolveSafe(relativePath: string): string {
  const resolved = path.resolve(this.cwd, relativePath);
  const root = path.resolve(this.cwd);
  if (!resolved.startsWith(root)) {
    throw new Error(`[Security] Path traversal blocked: "${relativePath}"`);
  }
  return resolved;
}
```

#### 4.1.2 命令执行安全

**现状:** 黑名单正则（5 条规则），`curl | bash` 可绕过。

**方案:** 三级递进：
1. **短期**: 扩展黑名单 + 命令注入转义
2. **中期**: 命令模板模式（LLM 选模板 + 填参数，而非自由生成）
3. **长期**: OS 级沙箱（参考 Codex CLI 的 Seatbelt/Landlock 方案）

#### 4.1.3 审批工作流

**方案:** 分层权限配置：
```yaml
# .code-agent/permissions.yml
permissions:
  read_file:
    default: allow                # 读文件默认允许
    deny_paths: [".env", "*.key", "**/secrets/**"]
  modify_file:
    default: ask                  # 修改文件默认询问
    allow_paths: ["src/**"]
    deny_paths: [".env", "package-lock.json"]
  execute_command:
    default: ask
    allow_patterns: ["pnpm *", "npm *", "git *", "ls *"]
    deny_patterns: ["rm -rf *", "sudo *", "curl * | *"]
```

### 4.2 🔴 P0 — 代码修改安全保障

#### 4.2.1 修改回滚 + 语法验证

**方案:**
```
修改文件流程:
  1. 备份原文件 → .agent-backup/{file}.bak
  2. 应用 SEARCH/REPLACE
  3. 验证语法 (TS: ts.createProgram 诊断)
  4. 语法通过 → 删除备份 ✅
  5. 语法失败 → 回滚到备份 ❌
```

#### 4.2.2 Diff 预览

**方案:** 修改前展示 unified diff，让用户确认：
```diff
--- a/src/index.ts
+++ b/src/index.ts
@@ -30,7 +30,7 @@
-    const cleanSearch = search.tirm();
+    const cleanSearch = search.trim();
```

### 4.3 🟠 P1 — 核心能力补全

#### 4.3.1 标准工具协议 → MCP

**现状:** 自定义 `<call_tool name="...">` XML 协议，LLM 可能输出非法格式。

**方案:** 采用 MCP (Model Context Protocol) 作为工具协议标准。

```
当前:  LLM → <call_tool> XML → 正则解析 → switch-case → 工具执行
目标:  LLM → JSON Tool Call → MCP Client → MCP Server → 工具执行
```

**为什么 MCP:**
- Anthropic + OpenAI + Google + Microsoft 共同支持的标准
- 10,000+ 现成的 MCP Server 可复用
- 工具定义与执行解耦，换模型不影响工具
- 支持动态工具发现（`list_tools`）

**实现步骤:**
1. 在 `tool-kit` 中实现 MCP Server 协议（stdio transport）
2. 将现有 4 个工具包装为 MCP tools
3. LLM Provider 层支持 Function Calling 格式
4. 兼容非 Function Calling 模型（回退到 XML 或 JSON prompt）

#### 4.3.2 多模型通用适配器

**现状:** `DeepSeekProvider` 硬编码，无法切换模型。

**方案:** 抽象 LLM Provider 接口：

```typescript
interface ILLMProvider {
  readonly name: string;
  readonly capabilities: ModelCapabilities;  // streaming, vision, function_calling, etc.
  
  chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;
  chatStream(messages: Message[], onChunk: ChunkCallback, options?: ChatOptions): Promise<LLMResponse>;
  countTokens(messages: Message[]): Promise<number>;
}

interface ModelCapabilities {
  maxContextTokens: number;
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean;
  supportsVision: boolean;
  supportsThinking: boolean;
}
```

**实现多个 Provider:**
```
packages/llm-provider/
├── src/
│   ├── interface.ts          ← ILLMProvider 接口
│   ├── gateway.ts            ← 模型路由器 (按 use-case/cost/capability 选择)
│   ├── providers/
│   │   ├── deepseek.ts       ← DeepSeek (已有, 重构)
│   │   ├── openai.ts         ← OpenAI GPT-5, o3, etc.
│   │   ├── anthropic.ts      ← Claude Opus/Sonnet/Haiku
│   │   ├── google.ts         ← Gemini
│   │   ├── openrouter.ts     ← 300+ 模型统一入口
│   │   └── ollama.ts         ← 本地开源模型
│   └── index.ts
```

#### 4.3.3 流式输出

**方案:** 在 `ILLMProvider` 接口中增加 `chatStream` 方法，executor 层支持流式展示。

#### 4.3.4 代码搜索增强

**现状:** 只有 AST 符号名模糊搜索。

**方案:** 三层搜索体系：
| 层级 | 技术 | 用途 |
|------|------|------|
| 文本搜索 | ripgrep / grep | 正则模式匹配 |
| 符号搜索 | SQLite FTS5 | 函数/类/接口定义 |
| 语义搜索 | Embedding + 向量搜索 | "找到处理用户认证的代码" |

#### 4.3.5 工具注册表重构

**方案:** 将 `executor.ts:85-106` 的 switch-case 替换为注册表模式，让工具可插拔：
```typescript
interface ToolDefinition {
  name: string;
  description: string;        // 用于 LLM 的 function description
  parameters: JSONSchema;     // 参数 schema
  requiresApproval: boolean;  // 是否需要用户确认
  handler: (args: any) => Promise<string>;
}

class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  
  register(tool: ToolDefinition): void;
  getTool(name: string): ToolDefinition | undefined;
  listTools(): ToolDefinition[];           // 给 LLM 的可用工具列表
  getToolSchemas(): FunctionDefinition[];  // OpenAI/Anthropic function calling 格式
}
```

### 4.4 🟡 P2 — 上下文与记忆

#### 4.4.1 上下文窗口管理

**问题:** 当前 `history` 数组无界增长，最终超出模型上下文限制。

**方案:**
1. **Token 计数**: 每次追加消息后计算总 token 数
2. **智能裁剪**: 超过阈值时保留 system prompt + 最近 N 轮 + 关键 Observation 摘要
3. **Observation 压缩**: 大的工具输出（如完整文件内容）自动摘要后再灌回
4. **Prompt 缓存**: 静态内容（system prompt、工具定义）前置，命中 API 缓存

#### 4.4.2 跨会话记忆

**方案:**
```typescript
// packages/memory/
interface AgentMemory {
  // 项目记忆：代码库结构、约定、用户偏好
  rememberProject(key: string, value: string): void;
  recallProject(query: string): MemoryEntry[];
  
  // 用户反馈：用户纠正过的错误、偏好风格
  rememberFeedback(correction: string): void;
  recallFeedback(context: string): MemoryEntry[];
  
  // 自动注入相关记忆到 system prompt
  injectRelevantMemories(context: string): string;
}
```

#### 4.4.3 会话日志与恢复

**方案:** JSONL 格式持久化每一轮交互：
```jsonl
{"ts":"2026-06-13T01:30:00Z","type":"task","content":"修复拼写错误"}
{"ts":"2026-06-13T01:30:02Z","type":"llm_request","messages":[...],"tokens":1234}
{"ts":"2026-06-13T01:30:05Z","type":"llm_response","content":"<call_tool...>","tokens":567}
{"ts":"2026-06-13T01:30:06Z","type":"tool_call","tool":"read_file","args":{...}}
{"ts":"2026-06-13T01:30:06Z","type":"observation","content":"..."}
```

支持 `--resume <session-id>` 恢复中断的会话。

### 4.5 🟢 P3 — 高级智能体能力

#### 4.5.1 子智能体系统

**设计:**
```
Main Agent (Orchestrator)
├── Explore Agent    — 只读代码搜索 (快速、便宜模型)
├── Plan Agent       — 架构分析与方案设计 (强推理模型)
├── Implement Agent  — 代码编写与修改 (平衡模型)
├── Review Agent     — 代码审查 (安全/性能视角)
└── Test Agent       — 测试生成与验证
```

每个子智能体:
- 独立的上下文窗口（不污染主对话）
- 可配置模型（便宜任务用 flash 模型）
- 可配置工具集（Explore Agent 只有读权限）
- 结果摘要返回主智能体

#### 4.5.2 Plan Mode

**方案:**
```
用户输入任务
  → Planner 阶段: 只读探索 → 生成结构化执行计划
    → 用户审批计划
      → Executor 阶段: 按计划逐步执行
        → 每步完成后验证
          → 全部完成后总结
```

**Planner 工具集:** `search_symbol`, `read_file`, `list_files`, `git_diff` (只读)
**Executor 工具集:** 全部工具

#### 4.5.3 Hooks 系统

**方案:**
```yaml
# .code-agent/hooks.yml
hooks:
  pre_modify_file:
    - command: "pnpm lint ${FILE_PATH}"     # 修改前 lint
  post_execute_command:
    - command: "echo 'Command executed: ${COMMAND}' >> .agent.log"
  pre_task_finish:
    - command: "pnpm build && pnpm test"   # 完成前必须编译+测试通过
  on_error:
    - prompt: "分析错误并建议恢复方案"       # 出错时 LLM 辅助诊断
```

### 4.6 工程化补全

| 项目 | 方案 |
|------|------|
| **测试** | vitest + 优先测 diff-engine (纯函数) 和 context-engine (集成) |
| **配置系统** | `.code-agent/config.yml` + 环境变量 + CLI 参数三层覆盖 |
| **CLAUDE.md** | 项目根创建，描述架构、约定、常见任务 |
| **错误处理** | 分类错误（可重试/不可重试），指数退避重试 |
| **可观测性** | 结构化日志 + token 消耗追踪 + 会话耗时统计 |

---

## 5. 如何超越 — 通用型多模型 Agent 愿景

### 5.1 竞品的结构性弱点

| 竞品 | 核心弱点 | 我们的机会 |
|------|---------|-----------|
| **Claude Code** | 🔒 仅 Anthropic 模型；闭源 | ✅ 接入任何模型 |
| **Codex CLI** | 🔒 仅 OpenAI 模型；Cloud-first | ✅ 本地优先 + 隐私 |
| **两者共同** | 模型锁定 = 无法利用不同模型的比较优势 | ✅ 模型路由 |

### 5.2 我们的差异化定位

```
                    Claude Code          Codex CLI           Our Code Agent
                    ───────────          ─────────           ──────────────
模型开放性           ❌ 仅 Anthropic      ❌ 仅 OpenAI         ✅ 任何模型
开源                 ❌ 闭源              ✅ Apache 2.0        ✅ 开源
安全模式             ⚠️ 权限审批          ✅ OS 沙箱           ✅ OS 沙箱 + 审批
代码理解             🟢 LSP+MCP          🟢 Grep+Embedding   🟢 LSP+FTS5+Embedding
本地/云端            本地                云端优先             本地优先 + 可选云端
智能体协作           🟢 Teams            🟢 并行沙箱          🟢 层次化子智能体
扩展性               🟢 MCP+Hooks+Skills 🟢 MCP               🟢 MCP+Hooks+Plugins
多模态               🟢                  🟢                   🟢 (通过模型能力)
成本控制             🔴 高价              🟡 token高效         🟢 模型路由降本
```

### 5.3 核心竞争优势

#### 优势 1: 通用模型适配器 — 消除 Vendor Lock-in

```
用户任务 → AI Gateway (模型路由器)
              ├── 简单搜索 → DeepSeek Flash (便宜)
              ├── 代码生成 → Claude Sonnet (质量)
              ├── 架构设计 → Claude Opus (推理)
              ├── 快速迭代 → GPT-5.3-Codex (速度)
              └── 离线场景 → Ollama + Qwen (隐私)
```

**核心价值:**
- 不绑定任何模型厂商
- 按任务类型/成本/延迟自动路由
- 厂商涨价/停服 → 一行配置切换
- 敏感代码可用本地模型（不出机器）

#### 优势 2: MCP-Native 架构

**核心价值:**
- 复用 10,000+ 现有 MCP 工具（数据库、API、文件系统...）
- 工具生态不依赖我们开发
- 与 Claude Code / Codex CLI / Cursor 共享同一套 MCP Server

#### 优势 3: 本地优先 + 可选云端

**核心价值:**
- 代码永不出本地（与 Codex CLI 的本质差异）
- 敏感项目可用本地 Ollama 模型
- 需要云端算力时可切换到 API

#### 优势 4: 层次化安全

```
Layer 1: OS 沙箱 (Seatbelt/Landlock)     ← 内核级隔离
Layer 2: 路径沙箱                         ← 文件系统边界
Layer 3: 权限审批                          ← 用户可见的确认
Layer 4: 审计日志                          ← 事后可追溯
```

---

## 6. 目标架构设计

### 6.1 总览

```
┌─────────────────────────────────────────────────────────────┐
│                     apps/cli (用户入口)                       │
│  · CLI 界面 (commander + inquirer)                           │
│  · TUI 界面 (ink/react)                                     │
│  · Web UI (可选)                                             │
│  · IDE 插件 (可选)                                            │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                  packages/agent-core                          │
│                                                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ ReAct Loop  │  │ Plan Mode   │  │ Subagent Orchester  │  │
│  │ (执行者)     │  │ (规划者)     │  │ (委派/并行)         │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │              │
│  ┌──────▼────────────────▼─────────────────────▼──────────┐  │
│  │                  Tool Registry (工具注册表)              │  │
│  │  · 内置工具  · MCP 工具  · 自定义工具  · Skill 包装     │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           │                                   │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │              Permission Engine (权限引擎)                │  │
│  │  · allow/deny/ask  · 路径通配符  · 层级继承             │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │           Context Manager (上下文管理器)                  │  │
│  │  · Token 计数  · 智能裁剪  · 记忆注入  · Prompt 缓存     │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   packages/llm-provider                       │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              AI Gateway (模型路由器)                      │  │
│  │  · 按任务路由  · 按成本路由  · 按延迟路由  · 故障切换     │  │
│  └────────┬──────────┬──────────┬──────────┬──────────────┘  │
│           │          │          │          │                  │
│  ┌────────▼──┐ ┌────▼───┐ ┌────▼───┐ ┌────▼──────────┐      │
│  │ Anthropic │ │ OpenAI │ │ DeepSeek│ │ Ollama/Local  │      │
│  │ Provider  │ │Provider │ │Provider │ │ Provider      │      │
│  └───────────┘ └────────┘ └────────┘ └───────────────┘      │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   packages/context-engine                     │
│                                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
│  │ FTS5     │  │ AST      │  │ Embedding│  │ LSP Client  │  │
│  │ 全文搜索  │  │ 符号索引  │  │ 语义搜索  │  │ 语言服务器   │  │
│  └──────────┘  └──────────┘  └──────────┘  └─────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 包结构演进

```
code-agent/
├── apps/
│   └── cli/                        ← CLI + TUI 入口
├── packages/
│   ├── shared/                     ← 共享类型 (保留, 扩展)
│   ├── llm-provider/               ← 多模型适配器 (重构)
│   │   └── providers/
│   │       ├── anthropic.ts
│   │       ├── openai.ts
│   │       ├── deepseek.ts
│   │       ├── google.ts
│   │       ├── openrouter.ts
│   │       └── ollama.ts
│   ├── agent-core/                 ← 🆕 智能体核心 (从 cli 提取)
│   │   ├── loop.ts                 ← ReAct 循环
│   │   ├── planner.ts              ← Plan Mode
│   │   ├── orchestrator.ts         ← 子智能体编排
│   │   ├── tool-registry.ts        ← 工具注册表
│   │   └── permission-engine.ts    ← 权限引擎
│   ├── context-engine/             ← 代码理解 (保留, 增强)
│   │   ├── indexer.ts              ← AST 符号 (已有)
│   │   ├── fts.ts                  ← 🆕 FTS5 全文搜索
│   │   ├── embeddings.ts           ← 🆕 语义搜索
│   │   └── lsp-client.ts           ← 🆕 LSP 集成
│   ├── diff-engine/                ← Diff 解析 (保留, 加固)
│   ├── tool-kit/                   ← 工具集 (保留, 增强)
│   │   ├── mcp-server.ts           ← 🆕 MCP Server 实现
│   │   └── sandbox.ts              ← 🆕 OS 沙箱
│   ├── memory/                     ← 🆕 记忆系统
│   └── logger/                     ← 🆕 日志系统
├── .code-agent/                    ← 🆕 项目配置
│   ├── config.yml
│   ├── permissions.yml
│   └── hooks.yml
└── COMPARISON.md                   ← 本文档
```

---

## 7. 实施路线图

### Phase 1: Foundation (4-6 周) — 达到安全可用基线

```
Week 1-2: 安全 + 稳定性
├── ✅ 路径沙箱 (resolveSafe)
├── ✅ 修改回滚 + 语法验证
├── ✅ 命令注入修复 (Git commit 等)
├── □ 命令执行安全升级 (扩展黑名单 + 模板模式)
├── □ 权限审批系统 v1 (allow/deny/ask 配置)
└── □ LLM 重试机制 (指数退避)

Week 3-4: 模型抽象 + 工具标准化
├── □ ILLMProvider 接口定义
├── □ 重构 DeepSeekProvider 实现接口
├── □ 新增 OpenAI Provider
├── □ 新增 Anthropic Provider
├── □ 工具注册表模式重构
├── □ MCP Server 协议 (stdio transport)
└── □ 将现有工具包装为 MCP tools

Week 5-6: 核心体验
├── □ 流式输出 (chatStream)
├── □ Thinking/Reasoning 展示
├── □ 代码搜索增强 (grep + FTS5)
├── □ Git 工具正式接入 Agent
├── □ 会话日志 (JSONL)
└── □ 配置系统 (.code-agent/config.yml)
```

**Phase 1 产出:** 一个安全的、支持多模型的、有权限控制的 Code Agent v2.0

### Phase 2: Competitive (6-8 周) — 达到竞品水平

```
Week 7-8: 上下文 + 记忆
├── □ Token 计数 + 智能裁剪
├── □ Observation 压缩 (大文件输出自动摘要)
├── □ Prompt 缓存优化
├── □ 跨会话记忆系统
└── □ 会话恢复 (--resume)

Week 9-10: 子智能体系统
├── □ Subagent 框架 (独立上下文 + 工具集)
├── □ Explore Agent (只读, Haiku/flash 模型)
├── □ Plan Agent (规划, Opus/强推理模型)
├── □ 子智能体结果摘要返回
└── □ 并行子智能体执行

Week 11-12: 扩展系统
├── □ Plan Mode (先规划后执行)
├── □ Hooks 系统 (PreToolUse / PostToolUse / Stop)
├── □ Skills 系统 (Markdown 定义的可复用技能)
├── □ 语义搜索 (Embedding + 向量存储)
└── □ MCP Client (连接外部 MCP Server)

Week 13-14: 工程化
├── □ diff-engine 单元测试
├── □ context-engine 集成测试
├── □ agent-core 端到端测试
├── □ 错误分类与智能恢复
└── □ 性能基准测试
```

**Phase 2 产出:** 一个功能齐全、对标 Claude Code/Codex CLI 的 Code Agent v3.0

### Phase 3: Differentiated (8-12 周) — 超越竞品

```
Week 15-16: 高级智能体
├── □ 多智能体协作 (Agent Teams 模式)
├── □ Dynamic Workflows (LLM 编写编排脚本)
├── □ 对抗性验证 (子智能体验证其他智能体的结果)
└── □ 自动回退与自我修复

Week 17-18: OS 沙箱
├── □ macOS Seatbelt 集成
├── □ Linux Landlock/seccomp 集成
└── □ 沙箱模式配置 (read-only / workspace-write / full-access)

Week 19-20: 模型路由
├── □ AI Gateway (按任务/成本/延迟自动路由)
├── □ 故障自动切换 (provider A 宕机 → provider B)
├── □ 成本追踪与优化建议
└── □ 本地模型支持 (Ollama 集成)

Week 21-24: 生态扩展
├── □ VS Code 插件
├── □ Web UI
├── □ MCP Server 市场集成
├── □ 社区 Skills 仓库
└── □ CI/CD 集成 (GitHub Actions, GitLab CI)
```

**Phase 3 产出:** 业界首个通用型、多模型、OS 沙箱化的开源 Code Agent

---

## 8. 关键差异化技术方案

### 8.1 通用模型适配器 — 消除 Vendor Lock-in

这是本项目**最核心的差异化优势**。Claude Code 和 Codex CLI 都绑定各自的模型，而我们的目标是让用户自由选择。

```typescript
// AI Gateway 伪代码
class AIGateway {
  async route(task: Task, context: Context): Promise<ModelSelection> {
    // 决策维度
    const requirements = {
      complexity: this.assessComplexity(task),     // simple | medium | complex
      domain: this.classifyDomain(task),            // code_gen | refactor | search | plan
      privacy: context.containsSecrets,             // true → 本地模型
      costBudget: context.budget,                   // 用户设定的成本上限
      latencyTarget: context.latencyMs,             // 用户设定的延迟上限
    };

    // 路由规则
    if (requirements.privacy) return 'ollama/qwen';
    if (requirements.domain === 'search' && requirements.complexity === 'simple')
      return 'deepseek-v4-flash';                   // 最便宜
    if (requirements.domain === 'code_gen')
      return requirements.complexity === 'complex'
        ? 'claude-sonnet-4-6'                       // 质量优先
        : 'gpt-5.3-codex';                          // 速度优先
    if (requirements.domain === 'plan')
      return 'claude-opus-4-8';                     // 推理最强

    return 'deepseek-v4-pro';                       // 默认平衡选项
  }
}
```

**效果:**
- 简单搜索 → 用 cheap 模型（成本降低 90%）
- 核心代码生成 → 用最强模型（质量保证）
- 敏感项目 → 用本地模型（数据不出机器）
- 某厂商宕机 → 自动切换（高可用）

### 8.2 MCP-Native 工具生态

**架构:**
```
我们的 Agent
  ├── 内置工具 (文件、终端、Git) → 直接调用
  ├── MCP Client (stdio/HTTP) → 连接外部 MCP Server
  │   ├── GitHub MCP Server → Issues, PRs, Actions
  │   ├── Postgres MCP Server → 数据库查询
  │   ├── Playwright MCP Server → 浏览器自动化
  │   └── ... 10,000+ 社区 Server
  └── 自定义 Skills → Markdown 定义的复合工作流
```

**与竞品的不同:**
- Claude Code: 有 MCP，但不开源，无法二次开发
- Codex CLI: 有 MCP，但绑定 OpenAI 模型
- **我们: 开源 + MCP + 任意模型 = 最大灵活性**

### 8.3 层次化安全模型

```
Level 4: 审计日志 (所有操作可追溯)
Level 3: 权限审批 (用户可见的 allow/deny/ask)
Level 2: 路径沙箱 (文件系统边界)
Level 1: OS 沙箱 (Seatbelt/Landlock 内核强制)
```

与竞品的差异:
- Claude Code: Level 2+3，无 Level 1
- Codex CLI: Level 1+2，无 Level 4
- **我们: Level 1+2+3+4 全覆盖**

### 8.4 成本优化 — 模型路由降本

Token 成本的巨大差异：

| 模型 | 输入 $/MTok | 输出 $/MTok | 适用场景 |
|------|------------|------------|---------|
| DeepSeek v4-flash | $0.14 | $0.28 | 简单搜索、文件读取 |
| GPT-5.3-Codex | $1.25 | $10.00 | 代码生成 |
| Claude Sonnet 4.6 | $3.00 | $15.00 | 复杂重构 |
| Claude Opus 4.8 | $15.00 | $75.00 | 架构设计 |
| Ollama/Qwen (本地) | $0 | $0 | 敏感/离线 |

通过智能路由，**成本可降至单模型方案的 20-30%**，同时保持甚至提升输出质量。

---

## 9. 总结

### 9.1 项目现状

我们有一个**正确的架构骨架**（ReAct 循环 + Monorepo 分层），但当前处于 MVP 原型阶段。与 Claude Code 和 Codex CLI 相比，在安全、工具协议、智能体协作、代码理解、工程化等维度存在系统性差距。

### 9.2 超越路径

竞品的**结构性弱点**是模型锁定（Claude Code → Anthropic, Codex CLI → OpenAI）。我们的核心机会是：

> **做业界第一个真正通用型、多模型、开源、MCP-Native 的 AI Coding Agent**

这意味着：
1. **模型自由** — 用户可以选择任何 LLM，按任务智能路由，不绑定厂商
2. **安全透明** — OS 沙箱 + 开源代码审计，企业级信任
3. **生态互通** — MCP 协议与 10,000+ 工具兼容，不造封闭花园
4. **成本最优** — 简单任务用 cheap 模型，复杂任务用强模型，总成本降低 70-80%
5. **隐私可控** — 敏感代码可用本地模型，永不出机器

### 9.3 立即行动

| 优先级 | 行动 | 预计工时 |
|--------|------|---------|
| **本周** | 路径沙箱 + 命令注入修复 + 修改回滚 | 5h |
| **本月** | ILLMProvider 接口 + 多 Provider 实现 | 8h |
| **本月** | MCP 协议集成 + 工具注册表 | 6h |
| **本月** | 流式输出 + Thinking 展示 | 3h |
| **下月** | 权限审批系统 + 日志系统 | 8h |
| **下月** | 上下文管理 + 记忆系统 | 8h |
| **季度** | 子智能体系统 + Plan Mode | 16h |
| **季度** | OS 沙箱 + AI Gateway | 16h |

---

> 📄 本文档将随项目演进持续更新。下一步：从 Phase 1 的路径沙箱和修改回滚开始实施。
