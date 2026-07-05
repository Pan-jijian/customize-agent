# @customize-agent/server

Customize Agent Web 管理控制台，基于 Next.js。该包随 CLI 一起安装，CLI 启动时会自动启动它并等待 `/api/health` 就绪。

## 定位

`@customize-agent/server` 负责提供：

- 知识库文件上传、搜索、管理和统计页面
- Provider 与模型配置页面
- Prompt 管理页面
- 生成编辑、生成资源管理和多格式导出页面
- 基于文档规范包、文件角色、提示词角色的动态 schema 生成流程
- 短期/长期上下文管理页面
- 系统统计与健康检查 API

CLI 主包 `customize-agent` 通过 npm 依赖安装本包，并使用 `next start` 启动已构建的 `.next` 产物。

## 开发命令

在仓库根目录运行：

```bash
pnpm --filter @customize-agent/server dev
pnpm --filter @customize-agent/server build
pnpm --filter @customize-agent/server start
pnpm --filter @customize-agent/server lint
```

默认端口：`17321`。

## CLI 自动启动机制

CLI 启动时会：

1. 通过 `require.resolve('@customize-agent/server/package.json')` 定位本包。
2. 通过 server 包路径解析 `next/dist/bin/next`。
3. 执行 `node <next-bin> start -p <port> -H 127.0.0.1`。
4. 轮询 `GET /api/health`，成功后输出 Web 控制台地址。
5. 若端口被占用且未显式指定端口，会自动尝试后续端口。

## 页面路由

| 页面 | 路径 |
| --- | --- |
| 首页 | `/` |
| 概览 | `/overview` |
| 知识库总览 | `/knowledge` |
| 文件列表 | `/knowledge/files` |
| 文件详情 | `/knowledge/file-detail` |
| 知识库管理 | `/knowledge/manage` |
| 知识库搜索 | `/knowledge/search` |
| 模型配置 | `/models` |
| Prompt 管理 | `/prompt` |
| 生成编辑 | `/documents` |
| 生成资源 | `/asset-library` |
| 学习说明 | `/guide` |
| 设置 | `/settings` |
| 短期上下文 | `/context/short-term` |
| 长期上下文 | `/context/long-term` |

## API 路由

| API | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查，返回 uptime、buildId、pid |
| `GET /api/kb/stats` | 知识库统计 |
| `GET /api/kb/files` | 文件列表 |
| `DELETE /api/kb/files` | 删除知识库文件 |
| `GET /api/kb/files/detail` | 文件详情、chunks、标签、关系 |
| `POST /api/kb/files/reindex` | 单文件重建索引 |
| `POST /api/kb/files/open` | 打开文件或目录 |
| `GET /api/kb/files/preview-pdf-page` | PDF 页面预览 |
| `POST /api/kb/upload` | 上传文件并入库 |
| `GET /api/kb/upload/progress` | 查询上传进度 |
| `GET /api/kb/search` | 知识库搜索 |
| `POST /api/kb/reindex` | 全量重建索引 |
| `GET /api/kb/categories` | 分类统计 |
| `GET /api/kb/tags` | 标签列表 |
| `GET /api/kb/ignore` | 忽略规则列表 |
| `POST /api/kb/ignore` | 追加忽略规则 |
| `GET /api/kb/duplicates` | 重复/关系数据 |
| `GET /api/kb/features` | 知识库能力信息 |
| `GET /api/kb/operations` | 知识库操作记录 |
| `GET /api/config/providers` | Provider 列表 |
| `POST /api/config/providers` | 保存 Provider |
| `GET /api/config/providers/:provider` | Provider 详情 |
| `DELETE /api/config/providers/:provider` | 删除 Provider |
| `GET /api/config/models` | 模型配置 |
| `PUT /api/config/models` | 保存模型配置 |
| `POST /api/config/healthCheck` | Provider 连通性检查 |
| `GET /api/context` | 上下文列表或统计 |
| `POST /api/context` | 压缩/清理上下文 |
| `PUT /api/context` | 更新上下文 |
| `DELETE /api/context` | 删除上下文 |
| `GET /api/system/stats` | 系统统计 |
| `GET/POST /api/prompt` | Prompt 管理 |
| `POST /api/documents/generate` | 创建后台文档生成任务，返回 `documentId/taskId` |
| `GET/PUT/DELETE /api/documents/generated/:id` | 生成记录轮询、更新和删除 |
| `POST /api/documents/export` | 按 `documentId` 或 Markdown 导出 Markdown/HTML/DOCX/PDF |
| `GET/POST/DELETE /api/assets/generated` | 生成资源列表、手动入库、打开和删除 |
| `GET /api/assets/generated/preview` | 生成图片资源预览 |

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `CUSTOMIZE_PROJECT_ROOT` | 当前控制台管理的用户项目根目录 |
| `INIT_CWD` | 未显式设置项目根时的候选目录 |
| `CUSTOMIZE_AGENT_HOME` | 用户级数据目录，默认 `~/.customize-agent` |
| `CUSTOMIZE_DASHBOARD_PORT` | CLI 启动控制台时使用的端口 |
| `CUSTOMIZE_DASHBOARD_START_TIMEOUT_MS` | CLI 等待控制台启动的超时时间 |
| `CUSTOMIZE_DASHBOARD_BUILD_ID` | 覆盖 `/api/health` 返回的 buildId |
| `CUSTOMIZE_AGENT_DISABLE_OCR` | 禁用 OCR |
| `KB_PDF_OCR_PAGE_LIMIT` | PDF OCR 页数限制 |
| `KB_RETRIEVAL_*` | 检索权重、召回、rerank 相关配置 |
| `CUSTOMIZE_AGENT_{PROVIDER}_API_KEY` | Provider API Key |

## 数据与项目根解析

Web API 需要知道当前用户项目根目录。解析优先级：

1. 请求参数中的 `projectRoot`。
2. `CUSTOMIZE_PROJECT_ROOT`。
3. `INIT_CWD`。
4. `~/.customize-agent/projects/registry.db` 中最近打开的项目。

内部目录如 `~/.customize-agent`、`apps/server`、`apps/cli` 会被过滤，避免 Web 控制台错误管理自身包目录。

生成编辑页创建的文档记录、草稿、导出来源和生成资源统一保存在：

```text
~/.customize-agent/projects/{projectId}/generatedDocuments
```

其中 `index.json` 保存生成记录索引，`drafts/` 保存文档详情，`assets.json` 保存生成资源元数据，`assets/` 保存本地化生成资源。生成资源默认不进入知识库索引，必须由用户在生成资源页手动加入。

## 发布注意事项

本包发布到 npm 时需要包含生产启动所需的 Next.js 构建产物：

- `.next/BUILD_ID`
- `.next/server`
- `.next/static`
- `.next/required-server-files.json`
- Next manifest 文件
- `next.config.ts`
- `postcss.config.mjs`
- `package.json`

构建脚本会删除 `.next/cache`，避免发布缓存文件。

发布或打包前建议执行：

```bash
pnpm --filter @customize-agent/server build
npm pack --dry-run
```

## 常见问题

### Web 控制台未启动

查看 CLI 输出中的 dashboard log 路径。常见原因包括端口占用、依赖未安装完整、Next 构建产物缺失。

可以显式指定端口：

```bash
CUSTOMIZE_DASHBOARD_PORT=17322 customize
```

Windows PowerShell：

```powershell
$env:CUSTOMIZE_DASHBOARD_PORT="17322"; customize
```

### API 返回找不到项目

显式传入或设置项目根：

```bash
CUSTOMIZE_PROJECT_ROOT=/path/to/project customize
```

### OCR 导致启动或上传较慢

CI 或无 OCR 需求场景可以禁用：

```bash
CUSTOMIZE_AGENT_DISABLE_OCR=1 customize
```
