# Customize Agent v1.0.3 — 发行说明

> 🎉 通用终端 AI 助手 — 跨平台抽象层、子智能体隔离、CI/CD 自动化发布
> 发布日期：2026-06-30

---

## 目录

1. [项目简介](#1-项目简介)
2. [版本信息](#2-版本信息)
3. [核心特性](#3-核心特性)
4. [架构总览](#4-架构总览)
5. [从零开始教程](#5-从零开始教程)
   - [5.1 环境准备 — macOS](#51-环境准备--macos)
   - [5.2 环境准备 — Windows](#52-环境准备--windows)
   - [5.3 环境准备 — Linux](#53-环境准备--linux)
   - [5.4 安装 Customize Agent](#54-安装-customize-agent)
   - [5.5 首次启动](#55-首次启动)
   - [5.6 配置 API Key 与 Provider](#56-配置-api-key-与-provider)
   - [5.7 模型三层架构配置（进阶）](#57-模型三层架构配置进阶)
   - [5.8 第一个任务](#58-第一个任务)
   - [5.9 角色定制（CUSTOMIZE.md）](#59-角色定制customizemd)
   - [5.10 日常使用技巧](#510-日常使用技巧)
   - [5.11 单次执行模式](#511-单次执行模式)
   - [5.12 MCP Server 模式](#512-mcp-server-模式)
6. [完整功能列表](#6-完整功能列表)
7. [npm 包清单](#7-npm-包清单)
8. [平台支持说明](#8-平台支持说明)
9. [常见问题](#9-常见问题)
10. [从源码构建](#10-从源码构建)

---

## 1. 项目简介

**Customize Agent** 是一个运行在终端里的通用 AI 编程助手。

与 ChatGPT/Claude 网页版不同，Customize Agent 直接运行在**你的电脑上**，能**读写你的本地文件、执行终端命令、操作 Git**，是真正的"AI 同事"而非聊天机器人。

核心理念：**一个工具，无数种角色**。通过在项目根目录放置一份 `CUSTOMIZE.md` 文件，你可以随时切换 Agent 的身份——React 前端专家、Python 数据科学家、DevOps 工程师，或者任何你需要的角色。

**跨平台支持：** macOS、Windows、Linux 全部原生支持。macOS/Linux 享内核级沙箱隔离，Windows 使用 VFS-Guard 进程级沙箱。

---

## 2. 版本信息

| 项目 | 信息 |
|------|------|
| 版本号 | **v1.0.3** |
| 代号 | 🔧 跨平台抽象层 + 子智能体隔离 |
| 发布类型 | 功能增强 + 质量修复 |
| Node.js 要求 | >= 18（推荐 22 LTS） |
| 包管理器 | pnpm 10+（开发）/ npm（用户安装） |
| CLI 命令 | `customize` |
| npm 包名 | `customize-agent` |

### 本次更新亮点（v1.0.3）

| 类别 | 更新内容 |
|------|---------|
| **跨平台抽象层** | 新增 Shell 命令翻译（Windows CMD/PowerShell 自动适配）、进程管理、二进制路径解析（`packages/tools/src/core/platform/`） |
| **子智能体隔离** | 新增 Git Worktree 隔离 和 内存快照隔离 两种策略，子 Agent 可在完全独立的文件系统中运行 |
| **TUI 多行输入** | 修复多行粘贴、输入渲染问题，优化按键处理 |
| **代码质量** | 消除全部 lint 警告和 typecheck 错误，ESLint 0 warning |
| **CI/CD** | 完善 Changesets 版本管理 + Release 自动发布流程 |

### npm 包清单（8 个包）

| # | npm 包名 | 版本 | 说明 |
|---|------|:--:|------|
| 1 | `customize-agent` | 1.0.3 | 🎯 **主程序** — `npx customize-agent` 安装，`customize` 启动 |
| 2 | `@customize-agent/types` | 1.0.1 | 跨包类型契约层，零外部依赖 |
| 3 | `@customize-agent/llm` | 1.0.1 | AI 模型提供商 — 6 个 Provider，统一接口 |
| 4 | `@customize-agent/tools` | 1.0.1 | Agent 工具集 — 50+ 内置工具，沙箱执行 |
| 5 | `@customize-agent/search` | 1.0.1 | 代码智能 — tree-sitter / ripgrep / LSP 三层搜索 |
| 6 | `@customize-agent/engine` | 1.0.1 | 核心引擎 — 权限、编排、上下文管理 |
| 7 | `@customize-agent/runtime` | 1.0.1 | 运行时 — 配置持久化、模型注册、审计日志 |
| 8 | `@customize-agent/memory` | 1.0.1 | 跨会话记忆 — SQLite + FTS5 全文搜索 |

---

## 3. 核心特性

### 🤖 AI 能力

| 特性 | 说明 |
|------|------|
| **6 个 LLM Provider** | OpenAI、DeepSeek、Anthropic Claude、Google Gemini、OpenRouter（聚合网关）、Ollama（本地模型） |
| **三级模型分层** | 读取层 / 推理层 / 执行层各自独立配置不同模型，按任务类型自动路由，大幅降低 token 成本 |
| **Provider 独立管理** | API Key 绑定 Provider 而非模型，同厂商多模型共享一个 Key |
| **协议自动推断** | Provider 协议（OpenAI/Anthropic/Google）自动识别，第三方 API 可手动覆盖 |
| **流式输出** | SSE 流式接收，实时显示 AI 思考过程（think）和回复内容 |
| **Token 估算与费用控制** | 实时估算 token 消耗，累计费用超限自动熔断 |

### 🛠 工具能力

| 类别 | 数量 | 典型工具 |
|------|:--:|------|
| 文件操作 | 12 | read_file, write_file, edit_file, multi_edit, delete_file, move_file, copy_file, mkdir, stat_file, inspect_file, list_files, tree |
| 全文搜索 | 4 | search (ripgrep), symbol_search (tree-sitter), dependency_graph, repo_map |
| 终端执行 | 7 | execute_command, run_background, check_command, stop_command, run_test, run_build, run_lint |
| Git 操作 | 7 | git_status, git_diff, git_log, git_stash, git_commit, git_apply_patch, git_create_patch |
| 网络 | 5 | web_search, web_fetch, download_file, browser_open, open_preview |
| 多媒体 | 10 | extract_text, extract_pdf_text, extract_docx_text, extract_xlsx_data, ocr_image, transcribe_audio, video_metadata, convert_file, compress_image, generate_thumbnail |
| 导出 | 6 | export_markdown, export_json, export_html, export_pdf, export_session, zip_files |
| LSP | 3 | lsp_definition, lsp_references, lsp_diagnostics |
| MCP | 5 | mcp_list, mcp_add, mcp_remove, mcp_tools, plugin_list, plugin_install |
| 检查点 | 4 | checkpoint_create, checkpoint_list, checkpoint_restore, checkpoint_delete |
| 其他 | 5 | todo_write, doctor, version, tool_health, orchestrate_agents |

### 🔐 安全

```
┌─────────────────────────────────────────────────────────┐
│  执行前:  PermissionEngine 检查                          │
│    1. 角色能力检查 (ROLE_CAPABILITY_MAP)                 │
│    2. 路径 glob 匹配 (拦截 .env / ~/.ssh / /etc 等)      │
│    3. 命令模式匹配 (拦截 rm -rf / / chmod 777 / sudo 等) │
│    4. 默认策略 → allow / deny / ask                      │
├─────────────────────────────────────────────────────────┤
│  执行中:  SandboxExecutor 隔离                           │
│    macOS  → Seatbelt (sandbox-exec)   内核级隔离         │
│    Linux  → Bubblewrap (bwrap)       内核级隔离          │
│    Windows → VFS-Guard               进程级隔离          │
│    降级   → VFS-Guard                纯 JS 虚拟沙箱      │
├─────────────────────────────────────────────────────────┤
│  执行后:  ExecutionController 评估                       │
│    L1 LoopGuard     → 死循环检测 (3轮相同→replan)        │
│    L2 BudgetManager → 费用熔断 ($5上限)                  │
│    L3 GoalManager   → 任务完成判断                       │
│    L4 Checkpoint    → 每15轮人工确认                     │
└─────────────────────────────────────────────────────────┘
```

### 🎨 终端界面（TUI）

| 功能 | 触发方式 | 说明 |
|------|------|------|
| 像素字欢迎横幅 | 自动 | 4×6 像素字标题，天蓝(#00BFFF)→紫(#8B00FF)渐变 |
| 文件模糊补全 | `@` | `git ls-files` 毫秒扫描，子串匹配评分，Top 12 |
| 命令菜单 | `/` | ↑↓ 选择，Enter 确认，带提示栏 |
| 审批弹窗 | 自动 | 敏感操作弹窗确认，显示工具名 + 参数摘要 |
| 思考链 | 自动 | 流式输出时实时显示，带 spinner 动画 |
| Markdown 渲染 | 自动 | 代码块语法高亮、表格、列表 |
| 状态栏 | 始终 | Token 使用率 / 模型 / 语言 / 费用 |
| 上下文用量 | `/context` | 显示各类型消息占比 |
| 工具调用折叠 | 自动 | 同类型多工具调用折叠显示 `N × tool_name` |

### 🧠 高级特性

| 特性 | 说明 |
|------|------|
| **CUSTOMIZE.md 角色定制** | 项目根目录放置一份 Markdown 文件，定义 Agent 角色、规则、技术栈 |
| **跨会话记忆** | SQLite + FTS5 全文搜索，4 种记忆类型（项目事实、用户偏好、纠正反馈、解决模式） |
| **子智能体编排** | 三种模式 — Orchestrator DAG / Pipeline / Swarm |
| **Hooks 系统** | 6 个生命周期事件（session_start/pre_tool/post_tool/pre_finish/error/session_end） |
| **上下文自动压缩** | 三级水位 — 60% 警告 → 75% 截断旧结果 → 85% LLM 摘要 |
| **Plan 模式** | 只读探索，先出计划再执行 |
| **Git Worktree 隔离** | 子智能体在独立 worktree 中运行，互不干扰 |
| **MCP 协议** | 双向 — 可作为 Server 暴露工具，也可作为 Client 接入外部工具 |
| **零启动扫描** | 文件索引全部懒加载，`git ls-files` 毫秒级 |
| **双语 i18n** | 141 个翻译键，中/英文即时切换 |

---

## 4. 架构总览

### 整体分层架构

```
┌──────────────────────────────────────────────────────────────┐
│                     customize CLI 应用层                      │
│                                                                │
│   index.ts          bootstrap.ts       agent/executor.ts      │
│   (Commander入口)   (组装/依赖注入)    (Agent主循环)           │
│                                                                │
│   repl/repl.ts      tui/renderer.ts    i18n/manager.ts        │
│   (REPL交互)        (ANSI渲染引擎)     (双语管理)             │
├──────────────────────────────────────────────────────────────┤
│                        Engine 引擎层                           │
│                                                                │
│   ToolRegistry     PermissionEngine   ExecutionController     │
│   (工具注册/分发)   (三层权限检查)     (四层执行控制)          │
│                                                                │
│   ContextManager   PlanModeManager    SubagentRunner          │
│   (上下文压缩)      (只读探索模式)     (子智能体运行器)        │
│                                                                │
│   Orchestrator     McpServer/McpClient  HooksEngine           │
│   (多智能体编排)    (MCP协议)           (生命周期钩子)         │
├──────────────┬──────────────┬──────────────┬──────────────────┤
│    Tools     │    Search    │     LLM      │     Memory       │
│  50+ 工具    │  tree-sitter │  6 Provider  │   SQLite + FTS5  │
│  沙箱/Git    │  ripgrep     │  流式/重试    │   4种记忆类型    │
│  多媒体/导出 │  LSP/语义    │  Token估算   │   FNV-1a去重     │
├──────────────┴──────────────┴──────────────┴──────────────────┤
│                      Runtime + Types                           │
│   ConfigStore  │  ModelRegistry  │  AuditLogger               │
│   LifecycleAware  │  EventBus  │  StateMachine               │
└──────────────────────────────────────────────────────────────┘
```

### Agent 主循环

```
while (任务未完成) {
  1. 构建系统提示词
     ┌─ 内置规则（安全红线/工具规范/质量要求）
     ├─ CUSTOMIZE.md（角色/领域/技术栈，优先级更高）
     └─ repoMap（项目结构快照）

  2. ContextManager.compactMessages()
     ┌─ 收集 → 排序 → 裁剪(75%) → 压缩(85%)

  3. Provider.chatStream(messages, tools)
     ┌─ SchemaAdapter 将 ToolRegistry 转为原生 Function Calling 格式
     └─ 流式接收 (content + thinkingContent + toolCalls)

  4. 如果有 toolCalls → 逐个执行
     ├─ ToolRegistry.dispatch(toolCall)
     ├─ PermissionEngine.check(tool, args) → allow/deny/ask
     ├─ 如 ask → TUI 审批弹窗
     └─ 执行工具 → 收集结果

  5. ExecutionController.evaluate()
     ├─ L1 LoopGuard     → 死循环? → replan
     ├─ L2 BudgetManager → 超预算? → stop
     ├─ L3 GoalManager   → 已完成? → 返回结果
     └─ L4 CheckpointManager → 到检查点? → pause

  6. 继续循环或返回最终结果
}
```

---

## 5. 从零开始教程

### 5.1 环境准备 — macOS

#### 检查是否已安装 Node.js

打开 **终端**（Terminal.app），输入：

```bash
node --version
```

如果输出版本号（如 `v22.12.0`）且 >= 18，直接跳到 [5.4 安装 Customize Agent](#54-安装-customize-agent)。

#### 方式一：官网安装包（最简单）

1. 打开浏览器访问 **https://nodejs.org**
2. 点击左侧 **LTS** 版本下载（推荐 22.x）
3. 双击下载的 `.pkg` 文件，按向导安装
4. 安装完成后，**关闭并重新打开终端**
5. 验证安装：

```bash
node --version   # 应输出 v22.x.x
npm --version    # 应输出 10.x.x
```

#### 方式二：Homebrew（推荐，方便后续管理）

```bash
# 如果没有 Homebrew，先安装
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 安装 Node.js 22 LTS
brew install node@22

# 添加到 PATH（根据 Homebrew 提示操作，通常是）
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

#### 方式三：nvm（多版本管理）

```bash
# 安装 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# 重启终端，然后安装 Node.js
nvm install 22
nvm use 22
nvm alias default 22
```

---

### 5.2 环境准备 — Windows

Customize Agent **完整支持 Windows 10/11**（无需 WSL2），推荐使用 **Windows Terminal** 获得最佳 TUI 体验。

> **沙箱说明：** Windows 上使用 VFS-Guard 进程级虚拟沙箱（纯 JavaScript 实现），安全级别等同：拦截敏感路径、危险命令模式匹配、提权命令强制拦截。macOS/Linux 则可额外享内核级沙箱。

#### 检查是否已安装 Node.js

打开 **PowerShell** 或 **命令提示符**（cmd），输入：

```powershell
node --version
```

如果输出版本号且 >= 18，直接跳到 [5.4 安装 Customize Agent](#54-安装-customize-agent)。

#### 方式一：官网安装包（最简单，推荐新手）

1. 打开浏览器访问 **https://nodejs.org**
2. 点击左侧 **LTS** 版本下载 Windows Installer（`.msi` 文件，推荐 22.x）
3. 双击 `.msi` 文件，按向导安装
   - ✅ 勾选 **"Automatically install the necessary tools"**（自动安装编译工具）
   - 其余选项保持默认
4. 安装完成后，**重启电脑**（确保 PATH 生效）
5. 打开 PowerShell，验证：

```powershell
node --version   # 应输出 v22.x.x
npm --version    # 应输出 10.x.x
```

#### 方式二：nvm-windows（多版本管理，推荐进阶用户）

1. 打开浏览器访问 **https://github.com/coreybutler/nvm-windows/releases**
2. 下载最新 `nvm-setup.exe`
3. 双击安装，保持默认选项
4. 打开 **PowerShell（以管理员身份运行）**：

```powershell
# 查看可安装的 Node.js 版本
nvm list available

# 安装 Node.js 22 LTS
nvm install 22.12.0

# 使用此版本
nvm use 22.12.0
```

#### 安装 Windows Terminal（强烈推荐）

Windows Terminal 提供完整的 ANSI 转义序列支持，Customize Agent 的 TUI 界面（像素字、颜色、下拉菜单）在 Windows Terminal 中能达到最佳效果。

1. 打开 **Microsoft Store**
2. 搜索 **"Windows Terminal"**
3. 点击 **安装**
4. 安装完成后，在 Windows Terminal 中打开 PowerShell 使用

> **PowerShell 也可以用** — Customize Agent 兼容 PowerShell 5.1+ 和 PowerShell 7+。只是 Windows Terminal 提供更好的颜色渲染。

---

### 5.3 环境准备 — Linux

#### Ubuntu / Debian

```bash
# 方式一：通过 NodeSource 安装（推荐）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证安装
node --version
npm --version
```

#### 通过 nvm 安装（多版本管理）

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc

# 安装并使用 Node.js 22
nvm install 22
nvm use 22
nvm alias default 22
```

#### CentOS / Fedora / RHEL

```bash
# 通过 NodeSource
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo yum install -y nodejs
```

#### Arch Linux

```bash
sudo pacman -S nodejs npm
```

---

### 5.4 安装 Customize Agent

#### 方式一：npx 直接运行（推荐，免安装）

```bash
npx customize-agent
```

首次运行会自动下载 npm 包，之后每次启动都会检查是否有更新。

> **注意：** npm 包名为 `customize-agent`，安装后的命令为 `customize`。

#### 方式二：全局安装

```bash
# 全局安装
npm install -g customize-agent

# 安装后，在任意目录直接执行
customize
```

#### 方式三：指定版本安装

```bash
npm install -g customize-agent@1.0.3
```

#### 验证安装

```bash
customize --help
```

输出应显示：

```
Usage: customize [options] [command]

Customize Agent v1.0.3 — interactive REPL

Options:
  -p, --prompt <text>  Single-shot execution mode
  --plan               Plan mode: read-only exploration (requires -p)
  -h, --help           display help for command

Commands:
  mcp-server           Start MCP Server (stdio JSON-RPC)
```

---

### 5.5 首次启动

在终端执行：

```bash
customize
```

你会看到如下欢迎界面：

```
╭──────────────────────────────────────────╮
│      ██  █  █  ███  ████  ███           │
│     █  █ █  █ █    █  █ █  █           │
│     █  █ █  █  ██  █  █ █  █           │
│     █  █ █  █    █ █  █ █  █           │
│     █  █ █  █    █ █  █ █  █           │
│      ██   ███  ███  ████  ███           │
│                                          │
│               v1.0.3                     │
│        Provider  No model configured     │
│                                          │
│    ▶  输入任务开始  @ 引用文件  / 命令    │
╰──────────────────────────────────────────╯
  AGENT  │  ➜ _
```

底部 `AGENT │ ➜` 是输入位置。提示栏的含义：
- `▶ 输入任务` — 直接打字即可向 Agent 发送任务
- `@ 引用文件` — 输入 `@` 触发文件模糊搜索和补全
- `/ 命令` — 输入 `/` 打开命令菜单

---

### 5.6 配置 API Key 与 Provider

#### 步骤 1：获取 API Key

**DeepSeek（推荐国内用户，性价比最高）：**

1. 打开 https://platform.deepseek.com
2. 注册并登录
3. 左侧菜单 → **API Keys**
4. 点击 **创建 API Key**，输入名称（如 `customize-agent`）
5. 复制生成的 `sk-xxx...`

**OpenAI：**

1. 打开 https://platform.openai.com/api-keys
2. 登录后点击 **Create new secret key**
3. 复制生成的 `sk-proj-xxx...`

**Anthropic Claude：**

1. 打开 https://console.anthropic.com
2. 登录后进入 **API Keys**
3. 点击 **Create Key**
4. 复制生成的 `sk-ant-xxx...`

**Google Gemini：**

1. 打开 https://aistudio.google.com/apikey
2. 点击 **Create API Key**
3. 复制生成的 key

**Ollama（本地运行，完全免费，无需 API Key）：**

1. 下载安装：https://ollama.com
2. 拉取模型：
```bash
ollama pull qwen2.5-coder:7b
ollama pull llama3.2:3b
```
3. 无需 API Key，直接使用 `/model add action ollama qwen2.5-coder:7b`

#### 步骤 2：在 Agent 中配置

启动 `customize` 进入 REPL 后，执行：

**最简配置（单模型）：**

```
/model add action deepseek deepseek-chat
/model key deepseek sk-your-deepseek-api-key
```

完成后会看到配置成功的提示。

**多 Provider 配置：**

```
# 配置 DeepSeek
/model add action deepseek deepseek-chat
/model key deepseek sk-your-deepseek-key

# 同时配置 OpenAI
/model add action openai gpt-4o
/model key openai sk-your-openai-key
```

然后用 `/model set action <model-name>` 切换激活的模型。

#### Provider 与协议速查表

| Provider | 协议 | 默认 API 地址 | 需要 API Key |
|----------|:--:|------|:--:|
| `deepseek` | OpenAI 兼容 | api.deepseek.com/v1 | 是 |
| `openai` | OpenAI | api.openai.com/v1 | 是 |
| `anthropic` | Anthropic 原生 | api.anthropic.com/v1 | 是 |
| `google` | Google 原生 | generativelanguage.googleapis.com | 是 |
| `openrouter` | OpenAI 兼容 | openrouter.ai/api/v1 | 是 |
| `ollama` | OpenAI 兼容 | localhost:11434/v1 | 否 |
| 自定义 | 手动指定 | 手动指定 | 视情况 |

系统会根据 Provider 名称**自动推断协议**，无需手动配置。如果你用的是第三方 OpenAI 兼容 API：

```
/model add action my-api my-model
/provider protocol my-api openai
/provider url my-api https://my-api.example.com/v1
/model key my-api sk-xxx
```

---

### 5.7 模型三层架构配置（进阶）

为不同任务类型配置不同模型，在性能、速度和成本之间取得平衡：

```
Reader (读取层)    →  Reasoning (推理层)  →  Action (执行层)
  读文件                分析代码                修改文件
  搜索符号              设计方案                执行命令
  浏览代码              整合信息                Git 操作
  便宜 + 快速           强推理 + 准确           精准 + 可靠
```

| 层级 | 职责 | 推荐模型要求 | 典型使用场景 |
|------|------|------|------|
| **Reader** | 浏览代码、读文件、搜索符号 | 便宜、快、大上下文 | 读 API 文档、搜索代码库 |
| **Reasoning** | 分析逻辑、设计方案、定位 bug | 推理能力强 | 代码审查、架构设计 |
| **Action** | 写代码、改文件、执行命令 | 精准、工具调用可靠 | 编写功能、修复 bug |

**完整三层配置示例：**

```
# 读取层 — DeepSeek-chat（便宜 + 大上下文 128K）
/model add reader deepseek deepseek-chat

# 推理层 — DeepSeek-reasoner（强推理，包含思考链）
/model add reasoning deepseek deepseek-reasoner

# 执行层 — DeepSeek-chat（快速响应，工具调用稳定）
/model add action deepseek deepseek-chat

# 三个层共用一个 Key
/model key deepseek sk-your-deepseek-api-key
```

**混合 Provider 配置示例（OpenAI + Anthropic + DeepSeek）：**

```
# 读取层 — 用 DeepSeek 省钱
/model add reader deepseek deepseek-chat
/model key deepseek sk-your-deepseek-key

# 推理层 — 用 Claude 强推理
/model add reasoning anthropic claude-sonnet-4-6
/model key anthropic sk-ant-your-anthropic-key

# 执行层 — 用 GPT-4o 精准执行
/model add action openai gpt-4o
/model key openai sk-your-openai-key
```

**Ollama 本地模型三层配置（完全免费，数据不出本机）：**

```
# 读取层 — 小模型，速度快
/model add reader ollama qwen2.5-coder:1.5b

# 推理层 — 中等模型，推理能力够用
/model add reasoning ollama qwen2.5-coder:7b

# 执行层 — 同推理层
/model add action ollama qwen2.5-coder:7b
```

**回退规则：** 某层未配置 → `reasoning → action → reader` 优先查找。如果只配了一层，三层全部共用。

查看回退路径：
```
/model fallback
```

**费用优化提示：**
- 读取层用 DeepSeek-chat（约 $0.07/百万 token 输入），省 90% 成本
- 推理层用 Claude Sonnet / DeepSeek-reasoner，只在需要深度分析时触发
- 本地开发可全部用 Ollama，零费用

---

### 5.8 第一个任务

配置好 API Key 后，直接在输入框输入自然语言任务。

#### 示例 1：写代码

```
用 TypeScript 写一个冒泡排序函数，包含 JSDoc 注释和单元测试
```

Agent 会：
1. 🤔 分析任务需求
2. 📖 查看当前项目结构和文件（如果有关联文件）
3. ✍️ 生成代码并写入文件
4. 🧪 运行测试验证
5. ✅ 确认通过后汇报

#### 示例 2：代码审查

```
审查 src/utils/ 目录下的所有 .ts 文件，找出潜在的性能问题和类型安全隐患
```

#### 示例 3：数据分析

```
读取 data.csv 文件，分析销售趋势，生成包含图表的分析报告并导出为 markdown
```

#### 示例 4：文档生成

```
为 src/api/ 目录下的所有函数生成 API 文档，导出为 markdown
```

#### 示例 5：Git 操作

```
查看最近 10 次提交，总结变更内容，生成 release notes
```

---

### 5.9 角色定制（CUSTOMIZE.md）

在项目根目录创建 `CUSTOMIZE.md`，Agent 启动时自动读取。

#### 示例 1：React 前端专家

```markdown
# CUSTOMIZE

## 角色
你是一个资深 React + TypeScript 前端工程师，专精于 Next.js 14 App Router 生态。

## 规则
- 组件一律使用函数式组件 + React Hooks
- 严禁使用 any 类型，使用 unknown 替代
- 每次文件修改后必须运行 `pnpm typecheck && pnpm test`
- CSS 使用 Tailwind CSS utility classes，不创建 .css 文件
- 组件文件放在 `src/components/` 目录下
- 数据获取使用 Server Components，避免不必要的 useEffect
- 不修改 `next.config.ts` 和 `pnpm-lock.yaml`

## 项目约定
- 页面路由：`src/app/` — App Router 文件路由
- 通用组件：`src/components/` — 可复用 UI 组件
- 工具函数：`src/lib/` — 纯函数、API 客户端
- 类型定义：`src/types/` — 全局 TypeScript 类型
- 服务端操作：`src/actions/` — Server Actions
```

#### 示例 2：Python 数据科学家

```markdown
# CUSTOMIZE

## 角色
你是一个 Python 数据科学家，擅长 pandas、numpy 和 matplotlib。

## 规则
- 使用 Python 3.11+ 语法
- 数据分析用 pandas，可视化用 matplotlib + seaborn
- 代码写在 Jupyter Notebook (.ipynb) 或 .py 脚本中
- 每个分析步骤添加注释说明
- 生成图表时设置中文字体支持
- 不修改 data/ 目录下的原始数据文件

## 项目约定
- 原始数据：`data/raw/`
- 处理后的数据：`data/processed/`
- 图表输出：`outputs/figures/`
- 分析脚本：`scripts/`
```

#### 示例 3：DevOps / 运维工程师

```markdown
# CUSTOMIZE

## 角色
你是一个资深 DevOps 工程师，专精于 Docker、Kubernetes 和 CI/CD。

## 规则
- Dockerfile 使用多阶段构建，slim/alpine 基础镜像
- Kubernetes YAML 必须包含 resources.limits 和 liveness probe
- CI 流水线中必须包含 lint、test、build 三个步骤
- 修改生产配置前需先输出 dry-run 结果供确认
- 敏感信息使用 k8s secrets，不硬编码

## 项目约定
- Docker 配置：`docker/`
- K8s manifests：`k8s/`
- CI 流水线：`.github/workflows/`
- 部署脚本：`scripts/deploy/`
```

---

### 5.10 日常使用技巧

#### 文件引用：`@` 触发模糊搜索

```
你：帮我看一下 @src/utils/hel
```

输入 `@` 后触发文件索引（毫秒级 `git ls-files`），继续输入字符进行子串匹配，按 `Tab` 选择文件。

#### 命令菜单：`/` 打开

常用命令：
- `/model` — 模型分层管理
- `/language` — 中英文切换
- `/plan <任务>` — Plan 模式
- `/context` — 查看 token 使用量
- `/compact` — 手动压缩上下文
- `/clear` — 清空当前会话
- `/export markdown` — 导出为 Markdown
- `/checkpoint` — 管理快照
- `/exit` — 退出

#### 多轮对话

Agent 记住当前会话所有上下文：

```
你：分析一下 src/api/user.ts 这个文件
（Agent 读取并分析）
你：把里面的 fetchUser 函数改成 async/await 风格
（Agent 定位函数并修改）
你：加一个错误重试逻辑
（Agent 继续修改）
你：运行测试确认一下
（Agent 执行 pnpm test）
```

#### 语言切换

```
/language      # 打开语言选择面板
/language zh   # 直接切到中文
/language en   # 直接切到英文
```

---

### 5.11 单次执行模式

不需要进入交互 REPL，直接在命令行执行单个任务：

```bash
customize -p "用 TypeScript 写一个快速排序函数"
```

Plan 模式（只读探索，生成执行计划但不修改任何文件）：

```bash
customize -p "重构 src/services/ 目录" --plan
```

单次执行模式适合：
- 脚本化集成（CI/CD 中自动执行）
- 快速问答
- 批量任务处理

---

### 5.12 MCP Server 模式

可以将 Customize Agent 作为 MCP Server，暴露其全部 50+ 工具给 Claude Desktop、Cursor 等 MCP 客户端使用。

#### 启动 MCP Server

```bash
customize mcp-server
```

启动后通过 stdio JSON-RPC 协议提供：
- `initialize` — 握手
- `tools/list` — 返回全部工具及 schema
- `tools/call` — 调用指定工具
- `ping` — 健康检查

#### 配置 Claude Desktop 使用

编辑 Claude Desktop 的配置：

```json
{
  "mcpServers": {
    "customize-agent": {
      "command": "node",
      "args": ["/path/to/customize-agent/dist/index.js", "mcp-server"]
    }
  }
}
```

配置后 Claude Desktop 即可调用 Customize Agent 的所有工具。

---

## 6. 完整功能列表

### 6.1 文件操作（12 个工具）

| 工具 | 功能 | 详细说明 | 审批 |
|------|------|------|:--:|
| `read_file` | 读取文件 | 自动分页、二进制检测、路径沙箱 | — |
| `write_file` | 创建/覆盖 | 写入前自动备份，支持回滚 | ✓ |
| `edit_file` | 精确修改 | SEARCH/REPLACE 语义（唯一字符串匹配） | ✓ |
| `multi_edit` | 多处编辑 | 单文件多位置编辑，事务性原子提交 | ✓ |
| `delete_file` | 删除文件 | 移入回收站（可恢复） | ✓ |
| `move_file` | 移动/重命名 | 支持跨目录移动 | ✓ |
| `copy_file` | 复制 | — | — |
| `mkdir` | 创建目录 | 自动创建父目录 | — |
| `stat_file` | 元信息 | 大小、权限、修改时间 | — |
| `inspect_file` | 文件检测 | 行数、编码、是否二进制 | — |
| `list_files` | 列出文件 | .gitignore 感知 + 自定义规则 | — |
| `tree` | 目录树 | 可视化目录结构 | — |

### 6.2 搜索（4 个工具）

| 工具 | 后端 | 功能 |
|------|------|------|
| `search` | ripgrep | 正则搜索 + 文件类型过滤，回退 JS 实现 |
| `symbol_search` | tree-sitter AST + SQLite FTS5 | 函数/类/变量定义搜索，12 种语言 |
| `dependency_graph` | tree-sitter | 模块导入/导出关系图谱 |
| `repo_map` | git ls-files + tree-sitter | 项目结构快照 + 关键符号摘要 |

### 6.3 终端执行（7 个工具）

| 工具 | 功能 | 沙箱 | 审批 |
|------|------|:--:|:--:|
| `execute_command` | 执行任意命令 | ✓ | ✓ |
| `run_background` | 后台长时间运行 | ✓ | ✓ |
| `check_command` | 查询后台任务状态 | — | — |
| `stop_command` | 终止后台任务 | — | ✓ |
| `run_test` | 运行项目测试 | ✓ | ✓ |
| `run_build` | 运行项目构建 | ✓ | ✓ |
| `run_lint` | 运行代码检查 | ✓ | — |

### 6.4 Git 操作（7 个工具）

| 工具 | 功能 |
|------|------|
| `git_status` | 查看工作区状态（modified/staged/untracked） |
| `git_diff` | 查看差异（支持 --staged, 指定文件） |
| `git_log` | 查看提交历史（支持 --oneline, -n, --author） |
| `git_stash` | 暂存当前修改 / 恢复暂存 |
| `git_commit` | `git add` + `git commit`（自动生成 Conventional Commits 格式信息） |
| `git_apply_patch` | 应用 unified diff patch |
| `git_create_patch` | 将当前修改生成 patch 文件 |

### 6.5 网络（5 个工具）

| 工具 | 功能 |
|------|------|
| `web_search` | 网络搜索，返回标题+URL+摘要 |
| `web_fetch` | 抓取 URL 内容并转为 Markdown |
| `download_file` | 下载文件到工作区 |
| `browser_open` | 在默认浏览器中打开 URL |
| `open_preview` | 在工作区启动本地 HTTP 预览 |

### 6.6 多媒体处理（10 个工具）

| 工具 | 后端库 | 功能 |
|------|------|------|
| `extract_text` | 自动检测 | 通用文本提取（自动识别文件类型） |
| `extract_pdf_text` | pdf-parse | PDF 文本提取 |
| `extract_docx_text` | mammoth | Word 文档文本提取 |
| `extract_xlsx_data` | xlsx | Excel 表格数据提取为 JSON |
| `ocr_image` | Tesseract.js | 图片 OCR 文字识别 |
| `transcribe_audio` | — | 音频转写 |
| `video_metadata` | — | 视频元信息提取（时长、分辨率） |
| `convert_file` | — | 文件格式转换 |
| `compress_image` | sharp | 图片压缩和缩放 |
| `generate_thumbnail` | sharp | 缩略图生成 |

### 6.7 LSP 代码智能（3 个工具）

| 工具 | 功能 | 支持语言 |
|------|------|------|
| `lsp_definition` | 跳转到符号定义位置 | TypeScript, Python, Go, Rust, Java, C/C++, Ruby, PHP, JSON |
| `lsp_references` | 查找所有符号引用 | 同上 |
| `lsp_diagnostics` | 获取诊断信息（错误/警告/提示） | 同上 |

### 6.8 导出与打包（6 个工具）

| 工具 | 功能 |
|------|------|
| `export_markdown` | 导出当前对话为 Markdown |
| `export_json` | 导出当前对话为 JSON |
| `export_html` | 导出当前对话为 HTML |
| `export_pdf` | 导出当前对话为 PDF |
| `export_session` | 导出完整会话（含工具调用记录） |
| `zip_files` | 打包指定文件/目录为 ZIP |

### 6.9 MCP/Plugin 管理（6 个工具）

| 工具 | 功能 |
|------|------|
| `mcp_list` | 列出已连接的 MCP 服务器 |
| `mcp_add` | 添加 MCP 服务器配置 |
| `mcp_remove` | 移除 MCP 服务器 |
| `mcp_tools` | 查看某个 MCP 服务器提供的工具列表 |
| `plugin_list` | 列出已安装的插件 |
| `plugin_install` | 安装插件 |

### 6.10 检查点（4 个工具）

| 工具 | 功能 |
|------|------|
| `checkpoint_create` | 创建当前工作区快照 |
| `checkpoint_list` | 列出所有快照（含时间戳） |
| `checkpoint_restore` | 恢复到指定快照 |
| `checkpoint_delete` | 删除快照 |

### 6.11 其他工具（6 个）

| 工具 | 功能 |
|------|------|
| `todo_write` | 写入/更新当前会话任务列表 |
| `doctor` | 诊断工具链状态（沙箱可用性、ripgrep 版本等） |
| `version` | 显示当前版本和系统信息 |
| `tool_health` | 检查各工具模块健康状态 |
| `check_update` | 检查 npm 上是否有新版本 |
| `update` | 自动更新到最新版本 |
| `orchestrate_agents` | 启动多智能体协作编排 |

---

## 7. npm 包清单

| # | 包名 | npm 上名称 | 版本 | 内部依赖 | 发布状态 |
|---|------|------|:--:|------|:--:|
| 1 | CLI | `customize-agent` | 1.0.3 | engine, llm, memory, runtime, search, tools, types | ✅ |
| 2 | Engine | `@customize-agent/engine` | 1.0.1 | llm, types | ✅ |
| 3 | LLM | `@customize-agent/llm` | 1.0.1 | types | ✅ |
| 4 | Tools | `@customize-agent/tools` | 1.0.1 | search | ✅ |
| 5 | Search | `@customize-agent/search` | 1.0.1 | llm, types | ✅ |
| 6 | Runtime | `@customize-agent/runtime` | 1.0.1 | types | ✅ |
| 7 | Memory | `@customize-agent/memory` | 1.0.1 | 无内部依赖 | ✅ |
| 8 | Types | `@customize-agent/types` | 1.0.1 | 零依赖 | ✅ |

---

## 8. 平台支持说明

| 平台 | 沙箱 | TUI | 最高安全级别 |
|------|------|:--:|------|
| **macOS** | Seatbelt (sandbox-exec) | ✅ Terminal.app / iTerm2 / Warp | 内核级 |
| **Linux** | Bubblewrap (bwrap) | ✅ GNOME Terminal / Konsole / Alacritty | 内核级 |
| **Windows 10/11** | VFS-Guard | ✅ Windows Terminal / PowerShell | 进程级 |
| **Windows (WSL2)** | Bubblewrap | ✅ WSL2 内终端 | 内核级 |

**Windows 说明：**
- **完全原生支持**，无需安装 WSL2
- 推荐使用 **Windows Terminal**（Microsoft Store 免费下载）获得最佳 TUI 渲染效果
- PowerShell 5.1+ 和 PowerShell 7+ 均可正常使用
- 沙箱使用 VFS-Guard（纯 JS 实现）：拦截敏感路径、危险命令模式匹配、提权命令强制拦截
- 如需内核级沙箱隔离，可在 WSL2 内安装 Linux 版本

---

## 9. 常见问题

### Q: 支持哪些编程语言的代码智能？

**tree-sitter AST 解析（12 种）：**
C, C++, Go, Java, JavaScript, TypeScript, PHP, Python, Ruby, Rust, TSX, Bash

**LSP 代码智能（9 种）：**
TypeScript/JavaScript, Python, Go, Rust, Java, C/C++, Ruby, PHP, JSON

### Q: 如何免费使用？

使用本地 Ollama 模型完全免费且数据不出本机：

```bash
# 安装 Ollama
# macOS/Linux: curl -fsSL https://ollama.com/install.sh | sh
# Windows: 从 https://ollama.com 下载安装

# 拉取模型
ollama pull qwen2.5-coder:7b

# 配置 Customize Agent
/model add action ollama qwen2.5-coder:7b
```

### Q: Agent 会读取我的 .env 和密钥文件吗？

不会。内置安全机制自动拦截：
- 以 `.env` 开头的文件
- 包含 `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD` 关键词的文件
- `~/.ssh/`, `~/.aws/`, `~/.config/` 等敏感目录

如需访问会弹出审批弹窗，由你决定。

### Q: 命令执行是否安全？

默认在内核级沙箱中执行：

| 平台 | 沙箱技术 | 隔离方式 |
|------|------|------|
| macOS | Seatbelt | 限制文件系统访问范围 |
| Linux | Bubblewrap | unprivileged user namespaces |
| Windows | VFS-Guard | 纯 JS 路径虚拟化 + 命令意图扫描 |

沙箱不可用时**自动降级**到 VFS-Guard，并打印安全警告。

### Q: Token 消耗太快怎么办？

1. **配三级模型：** Reader 层用 DeepSeek-chat（¥0.07/百万 token），省 90%
2. **手动压缩：** `/compact`
3. **查看用量：** `/context`
4. **调整水位：** 在 `~/.customize-agent/config.json` 中修改 `contextCompressRatio`

### Q: 如何更新到最新版本？

```bash
npm update -g customize-agent
```

### Q: MCP 是什么？怎么用？

MCP（Model Context Protocol）是 AI 工具交互的标准协议。

**作为 Server（暴露工具给其他 AI 客户端）：**
```bash
customize mcp-server
```

**作为 Client（接入外部 MCP 工具）：**
编辑 `~/.customize-agent/mcp.json`：
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
重启 Agent 后外部工具可用。

---

## 10. 从源码构建

```bash
# 克隆仓库
git clone https://github.com/Pan-jijian/customize-agent.git
cd customize-agent

# 安装依赖（需要 pnpm）
npm install -g pnpm
pnpm install

# 全量构建
pnpm run build

# 启动
pnpm start:cli

# 运行测试
pnpm run test

# 全量检查
pnpm run check     # = typecheck + lint + test
```

### 开发命令

| 命令 | 功能 |
|------|------|
| `pnpm run build` | 构建所有 8 个包 |
| `pnpm run typecheck` | 全量 TypeScript 类型检查 |
| `pnpm run lint` | ESLint 检查 |
| `pnpm run test` | 运行 46 个测试用例 |
| `pnpm run check` | typecheck + lint + test 一键检查 |
| `pnpm start:cli` | 启动 CLI（开发模式） |
| `pnpm run dev` | 构建并启动 |
| `pnpm changeset` | 创建变更记录 |
| `pnpm --filter <包名> run build` | 单包构建 |

---

<p align="center">
  <b>Customize Agent</b> — 你的终端 AI 伙伴<br>
  <sub>跨平台 · 安全 · 可定制 · 开源</sub><br>
  <sub>Made with ❤️ by Pan-jijian</sub>
</p>
