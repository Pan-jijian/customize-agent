# Customize Agent

通用终端 AI 助手，支持 `CUSTOMIZE.md` 角色定制、原生 Function Calling、双语 TUI、三级模型分层、本地知识库和 Web 管理控制台。

当前仓库是 pnpm monorepo：8 个核心 packages + 2 个 apps（CLI 与 Next.js Web 控制台）。

## 快速安装

### npm 用户

```bash
npm install -g customize-agent
customize
```

安装后会暴露两个等价命令：

```bash
customize
customize-agent
```

CLI 启动时会自动拉起 Web 控制台，默认地址为：

```text
http://127.0.0.1:17321/overview
```

如端口被占用，CLI 会自动尝试后续端口；也可以通过 `CUSTOMIZE_DASHBOARD_PORT` 指定固定端口。

### 源码开发

```bash
git clone https://github.com/Pan-jijian/customize-agent.git
cd customize-agent
pnpm install
pnpm run build
pnpm start:cli
```

常用开发命令：

```bash
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm test
pnpm --filter @customize-agent/server dev
```

## 环境要求

- Node.js：建议使用 22+；CI 当前覆盖 Node 24。
- pnpm：仓库使用 `pnpm@10.26.1`。
- 平台：macOS、Windows、Linux。
- 可选：Docker，用于容器沙箱。

## 首次配置

进入 REPL 后配置 Provider 和模型：

```text
/model add action deepseek deepseek-v4-flash
/model key deepseek sk-xxx
```

高级用法可以分别配置三层模型：

```text
/model add reader deepseek deepseek-chat
/model add reasoning deepseek deepseek-v4-pro
/model add action deepseek deepseek-v4-flash
/model key deepseek sk-xxx
```

模型层级：

| 层级 | 用途 |
| --- | --- |
| `reader` | 读取文件、搜索代码、浏览上下文 |
| `reasoning` | 分析、规划、复杂推理 |
| `action` | 修改文件、执行命令、调用工具 |

未配置的层级会自动回退到可用模型。

## CUSTOMIZE.md 角色定制

在用户项目根目录创建 `CUSTOMIZE.md`：

```markdown
# CUSTOMIZE

## 角色
你是一个 React + TypeScript 前端专家。

## 规则
- 组件使用函数式组件和 Hooks
- 不使用 any
- 修改后运行类型检查和测试
```

启动时 CLI 会读取项目根目录的 `CUSTOMIZE.md` 并注入系统提示词。首次启动会创建示例文件；已有文件不会被覆盖。

## 项目结构

```text
customize-agent/
├── apps/
│   ├── cli/                    # npm 包 customize-agent，终端入口与 TUI
│   └── server/                 # npm 包 @customize-agent/server，Next.js Web 控制台
├── packages/
│   ├── types/                  # 跨包类型契约
│   ├── llm/                    # LLM Provider 与协议适配
│   ├── tools/                  # 文件、终端、搜索、Git、媒体、MCP 等工具
│   ├── search/                 # ripgrep、tree-sitter、LSP、语义搜索
│   ├── knowledge/              # 本地知识库、解析、向量化、sqlite-vec
│   ├── engine/                 # Agent 执行循环、权限、编排、Hooks、MCP
│   ├── runtime/                # 配置、模型注册、审计日志
│   └── memory/                 # 跨会话记忆
├── docs/                       # 设计文档
├── .github/workflows/          # CI 与发布流程
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

## 包说明

| 包 | 说明 |
| --- | --- |
| `customize-agent` | CLI 主包，提供 `customize` 与 `customize-agent` 命令 |
| `@customize-agent/server` | Web 管理控制台，CLI 会自动启动 |
| `@customize-agent/types` | 公共类型定义 |
| `@customize-agent/llm` | OpenAI、DeepSeek、Anthropic、Google、OpenRouter、Ollama 等 Provider |
| `@customize-agent/tools` | Agent 工具集合 |
| `@customize-agent/search` | 文本搜索、符号索引、LSP 与语义搜索 |
| `@customize-agent/knowledge` | 本地知识库、多格式解析、sqlite-vec 向量检索 |
| `@customize-agent/engine` | Agent 核心执行引擎 |
| `@customize-agent/runtime` | 配置和模型注册 |
| `@customize-agent/memory` | SQLite + FTS5 跨会话记忆 |

## CLI 用法

### 交互式 REPL

```bash
customize
```

源码模式：

```bash
pnpm start:cli
```

### 单次执行

```bash
customize -p "审查 src 目录下的代码"
customize -p "实现一个快速排序" --plan
```

### MCP Server

```bash
customize mcp-server
```

可供 Claude Desktop、Cursor 等 MCP 客户端通过 stdio JSON-RPC 调用。

## Web 控制台

Web 控制台由 `@customize-agent/server` 提供，是 Next.js 应用。CLI 启动后会自动启动控制台，并等待 `/api/health` 就绪。

主要页面：

| 页面 | 路径 |
| --- | --- |
| 首页 | `/` |
| 概览 | `/overview` |
| 知识库总览 | `/knowledge` |
| 文件列表 | `/knowledge/files` |
| 知识库管理 | `/knowledge/manage` |
| 知识库搜索 | `/knowledge/search` |
| 模型配置 | `/models` |
| Prompt 管理 | `/prompt` |
| 设置 | `/settings` |
| 短期上下文 | `/context/short-term` |
| 长期上下文 | `/context/long-term` |

源码开发时也可以单独启动：

```bash
pnpm --filter @customize-agent/server dev
pnpm --filter @customize-agent/server build
pnpm --filter @customize-agent/server start
```

更多说明见 [apps/server/README.md](file:///Users/pan/Desktop/codeing/customize-agent/apps/server/README.md)。

## 本地知识库

知识库由 `@customize-agent/knowledge` 提供，默认使用本地 SQLite + sqlite-vec，不需要额外启动 Chroma、Qdrant 等外部向量数据库。

首次启动会在用户项目根目录创建：

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

支持 PDF、Word、Excel、图片 OCR、图纸/模型文件、JSON/YAML/XML/HTML、Markdown、代码和压缩包清单等格式。

常用命令：

```text
/kb overview
/kb status
/kb list [keyword]
/kb search <query>
/kb reindex
/kb dash
/kb dashboard
```

`/kb dash` 和 `/kb dashboard` 都会打开 Web 管理页面。

## 主要 API

Web 控制台提供的主要 API：

| API | 说明 |
| --- | --- |
| `GET /api/health` | 控制台健康检查 |
| `GET /api/kb/stats` | 知识库统计 |
| `GET /api/kb/files` | 文件列表 |
| `POST /api/kb/upload` | 上传并索引文件 |
| `GET /api/kb/upload/progress` | 上传进度 |
| `GET /api/kb/search` | 知识库搜索 |
| `POST /api/kb/reindex` | 重新索引 |
| `GET /api/kb/categories` | 分类统计 |
| `GET /api/kb/tags` | 标签列表 |
| `GET /api/kb/duplicates` | 重复/关系信息 |
| `GET /api/kb/operations` | 知识库操作记录 |
| `GET /api/config/providers` | Provider 配置 |
| `GET /api/config/models` | 模型配置 |
| `GET /api/context` | 上下文管理 |
| `GET /api/system/stats` | 系统统计 |
| `GET/POST /api/prompt` | Prompt 管理 |

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `CUSTOMIZE_AGENT_HOME` | 覆盖用户级数据目录，默认 `~/.customize-agent` |
| `CUSTOMIZE_PROJECT_ROOT` | 指定当前 Web 控制台关联的用户项目根目录 |
| `CUSTOMIZE_DASHBOARD_PORT` | 指定 Web 控制台端口 |
| `CUSTOMIZE_DASHBOARD_START_TIMEOUT_MS` | CLI 等待 Web 控制台启动的超时时间 |
| `CUSTOMIZE_AGENT_E2E_DASHBOARD` | E2E 模式：控制台失败时 CLI 直接非零退出 |
| `CUSTOMIZE_AGENT_DISABLE_OCR` | 禁用 OCR，适合 CI 或无图像识别需求场景 |
| `KB_PDF_OCR_PAGE_LIMIT` | PDF OCR 页数限制 |
| `KB_RETRIEVAL_*` | 知识库检索权重和召回相关配置 |
| `CUSTOMIZE_AGENT_{PROVIDER}_API_KEY` | Provider API Key 环境变量 |

## CI 与验证

当前重点 CI：

- `.github/workflows/ci.yml`：基础构建、类型检查、测试。
- `.github/workflows/cli-e2e.yml`：macOS 与 Windows 上安装依赖、构建、打包 CLI、启动 CLI 自动拉起 Web、访问页面、调用 API、验证上传与 sqlite-vec 入库。
- `.github/workflows/release.yml`：Changesets/npm 发布流程。

本地常用验证：

```bash
pnpm run typecheck
pnpm run build
pnpm --filter @customize-agent/server build
```

## 发布

仓库使用 Changesets 管理版本：

```bash
pnpm changeset
pnpm version-packages
pnpm run build
pnpm changeset publish
```

发布 CLI 前需要确保：

1. 内部包版本已经发布或依赖范围正确。
2. `@customize-agent/server` 已构建并包含 `.next` 运行产物。
3. CLI 包依赖的是 npm registry 可解析版本，不是 `workspace:*`。
4. macOS 与 Windows E2E 通过。

## 故障排除

### Web 控制台未启动

1. 查看终端输出中的 dashboard log 路径。
2. 检查端口是否被占用，或设置新端口：

```bash
CUSTOMIZE_DASHBOARD_PORT=17322 customize
```

Windows PowerShell：

```powershell
$env:CUSTOMIZE_DASHBOARD_PORT="17322"; customize
```

3. 增加启动等待时间：

```bash
CUSTOMIZE_DASHBOARD_START_TIMEOUT_MS=180000 customize
```

### 知识库未找到项目

Web 控制台优先使用 `CUSTOMIZE_PROJECT_ROOT`，其次读取最近打开过的项目注册表。必要时显式指定：

```bash
CUSTOMIZE_PROJECT_ROOT=/path/to/project customize
```

### OCR 依赖较重或 CI 运行慢

```bash
CUSTOMIZE_AGENT_DISABLE_OCR=1 customize
```

## 代码审查结论

本轮审查已处理的项目一致性问题：

- 补齐 `apps/server` README。
- 更新根 README，移除旧的“8 包 + 1 App”、WSL-only Windows、旧 Express dashboard 等过期描述。
- `/kb dashboard` 已接入为 `/kb dash` 的别名。
- 修复 `TreeSitterWorkerPool` 在 ESM 下使用 `__dirname` 和错误 worker 文件名的问题。
- 删除 CLI 中未引用的 ripgrep 二进制工具包装文件，CLI 不再直接依赖 `@vscode/ripgrep`；实际搜索能力保留在 `@customize-agent/search`。
- `@customize-agent/server` 发布文件列表补充 `postcss.config.mjs`。
