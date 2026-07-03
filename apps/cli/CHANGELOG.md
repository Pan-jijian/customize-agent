# customize-agent

## 2.1.8

### Patch Changes

- ## ✨ 内容区域自适应宽度 + 响应式断点优化

  ### 变更

  - 移除 `.mainInner` 固定 `max-width: 1480px`，内容填充整个可用宽度
  - 内边距改用 `clamp(16px, 2.5vw, 40px)` 流式响应
  - 新增 640px / 860px / 1024px 三档响应式断点
  - 侧边栏、顶栏、内容区均适配桌面/平板/手机

## 2.1.7

### Patch Changes

- ## 🐛 修复 Windows 跨平台兼容 + i18n 补齐

  ### 🔍 问题

  1. **Windows 所有 API 500**：npm 包中的 `dist/server/node_modules/` 包含 macOS 构建的原生模块（better-sqlite3、tree-sitter 等），Windows 无法加载
  2. **tree-sitter peer dependency 警告**：语法包版本不统一（部分需 ^0.21.1，部分需 ^0.22.1）
  3. **知识库搜索侧边栏 i18n 缺失**：`nav.knowledgeSearch` 键未定义

  ### 🔧 修复

  1. **跨平台原生模块**：
     - 添加 `postinstall` 脚本：`npm rebuild` 在 `dist/server/` 中为目标平台重新编译原生模块
     - 生成 `dist/server/package.json`（35 个运行时依赖），供 `npm rebuild` 使用
     - macOS/Windows/Linux 均可正常使用
  2. **tree-sitter 版本**：使用 `^0.22.0`，配合 `postinstall` 的 `npm rebuild` 确保原生模块正确构建
  3. **i18n 补齐**：zh-CN.json 和 en-US.json 添加 `nav.knowledgeSearch` 键

  ### ✅ 验证

  - 252 测试全部通过
  - macOS 本地所有页面 HTTP 200
  - Windows `npm rebuild` 自动构建原生模块

## 2.1.6

### Patch Changes

- ## 🐛 修复 Web 服务 Internal Server Error（根因修复）

  ### 🔍 根因

  `bundle-server.mjs` 将 `node_modules` 重命名为 `vendor` 并通过 CJS `Module._resolveFilename` monkey-patch 解析依赖。**这只对 CJS `require()` 有效**，ESM `import`（如 `next-themes`）不走此通道，导致 `ERR_MODULE_NOT_FOUND` → Internal Server Error。

  ### 🔧 修复

  1. **保留 `node_modules` 目录名**：不再重命名为 `vendor`，Node.js 原生 CJS+ESM 解析器从 `dist/server/apps/server/` 向上查找到 `../../node_modules/` 即可自然解析所有依赖
  2. **移除 CJS monkey-patch**：不再注入 `Module._resolveFilename` 补丁代码到 `server.js`
  3. **修复 tree-sitter 版本**：`^0.21.1` → `^0.22.0`（新版语法包 `tree-sitter-c@0.23.6` 等已升级 peer dep 范围）

  ### ✅ 验证

  - 所有 Web 页面 HTTP 200：`/overview`、`/knowledge/files`、`/knowledge/manage`、`/models`、`/settings`
  - API 正常：`/api/health`、`/api/kb/stats`
  - 252 测试全部通过
  - 零服务端错误

- Updated dependencies
  - @customize-agent/search@2.0.3
  - @customize-agent/tools@2.1.2
  - @customize-agent/engine@2.1.2

## 2.1.5

### Patch Changes

- ## 🐛 修复 Web 服务 Internal Server Error — 自动打包所有依赖

  ### 🔍 根因

  `bundle-server.mjs` 只手动复制了 `tesseract.js` 和 `@napi-rs/canvas` 两个动态依赖，遗漏了 knowledge/search/tools 包的其他外部依赖（tree-sitter 系列、mammoth、xlsx、jszip、pdf-parse、chromadb 等 20+ 个包），导致 vendor 目录缺失关键模块，服务端 require 失败。

  ### 🔧 修复

  `bundle-server.mjs` 改为**自动读取 knowledge/search/tools 包的 package.json**，将其所有 `dependencies`（排除 `@customize-agent/*` workspace 内部包）批量复制到 vendor 目录。新增 `ensureWorkspaceDeps()` 函数，未来新增依赖无需手动维护打包脚本。

  ### 📦 vendor 包数量

  - 修复前：27 个包
  - 修复后：50 个包（新增 23 个缺失依赖）

  ### ✅ 验证

  - 所有 API 端点正常（/api/health、/overview、/api/kb/stats、/api/kb/features、/api/config/providers）
  - TypeScript 编译通过
  - 252 测试全部通过

## 2.1.4

### Patch Changes

- ## 🐛 紧急修复 — 打包后 Web 服务 Internal Server Error

  ### 🔍 根因

  Next.js standalone 模式将 workspace 包（`@customize-agent/knowledge`、`llm`、`runtime`、`types`）输出到 `packages/` 顶层目录，而非 `node_modules/@customize-agent/` scope 下。`bundle-server.mjs` 在打包时未创建 scope 软链接，导致运行时 `require('@customize-agent/knowledge')` 找不到包，所有 API 路由返回 500。

  ### 🔧 修复

  `bundle-server.mjs` 新增 `linkWorkspacePackages()` 函数：将 `packages/{knowledge,llm,runtime,types}` 复制到 `node_modules/@customize-agent/` scope 下，再随 `node_modules` → `vendor` 迁移流程一同打包。

  ### ✅ 验证

  - TypeScript 编译：通过
  - 测试：252/252 全部通过
  - 打包后 vendor 目录包含 `@customize-agent/knowledge`、`llm`、`runtime`、`types` 四个包

## 2.1.3

### Patch Changes

- ## 🐛 紧急修复 — EPERM 崩溃 + tree-sitter peer dependency 警告

  ### 🚨 EPERM 崩溃修复

  - **修复 `search-tools.ts` `visit` 函数**：`fs.readdir` 访问系统保护目录（如 macOS `~/Library/Accounts`）时抛出 `EPERM` 导致 CLI 启动崩溃，现已添加 try-catch 静谧跳过无权限目录
  - **修复 `path-utils.ts` `walk` 函数**：同样添加 `EPERM`/`EACCES` 异常处理，跨平台兼容（macOS/Linux/Windows）

  ### 🔧 tree-sitter peer dependency 警告修复

  - **降级 `tree-sitter` 版本**：`^0.22.0` → `^0.21.1`，与所有 tree-sitter 语法包（`tree-sitter-c`、`tree-sitter-cpp` 等 `^0.23.0`）的 `peerOptional` 要求一致，消除 npm 安装时的 `ERESOLVE overriding peer dependency` 警告

  ### ✅ 验证结果

  - TypeScript 类型检查：通过
  - 测试：252/252 全部通过

- Updated dependencies
  - @customize-agent/tools@2.1.1
  - @customize-agent/search@2.0.2
  - @customize-agent/engine@2.1.1

## 2.1.2

### Patch Changes

- ## 🔍 全面审计修复 — 40 项问题全部修复

  ### 🚨 严重问题修复

  - **统一 TypeScript 版本**：server 从 `^5.7.0` 升级至 `^6.0.3`，与 monorepo 其他包保持一致
  - **统一 @types/node 版本**：server 从 `^22.0.0` 升级至 `^25.9.3`
  - **统一 mammoth 版本**：knowledge、cli、server 从 `^1.11.0` 统一为 `^1.12.0`
  - **统一 tesseract.js 版本**：knowledge、cli、server 从 `^6.0.1` 统一为 `^7.0.0`
  - **修复 process.exit 在库代码中调用**：`@customize-agent/tools` 的清理处理器改为设置 `exitCode` 而非强制退出进程
  - **修复 CLI 入口顶层 JSON.parse 无异常处理**：`customize-agent` CLI 入口包裹 try-catch，package.json 损坏时优雅降级
  - **修复 KB_DEBUG 布尔判断错误**：`@customize-agent/knowledge` 中 `if (process.env.KB_DEBUG)` 改为 `=== '1'`

  ### 🔴 高优先级修复

  - **移除未使用依赖 figlet**：`customize-agent` CLI 中未使用的 figlet 依赖已清理
  - **@types/\* 移至 devDependencies**：engine、llm、search、tools 中的 `@types/node` 和 `@types/better-sqlite3` 已移至正确位置
  - **24 个 API 路由添加 405 响应**：server 所有 API 路由对不支持的 HTTP 方法正确返回 405
  - **24 个 API 路由修复错误泄露**：错误响应不再泄露内部堆栈信息，改为安全通用消息
  - **删除死代码 sse.ts**：`@customize-agent/llm` 中完全未被使用的 SSE 工具文件已删除
  - **清理未使用的类型导出**：types、engine、tools 包中无外部消费者的导出已移除
  - **移除 knowledge 包 export \* 通配符**：`@customize-agent/knowledge` 改为显式导出，防止内部类型泄露

  ### 🟡 中优先级修复

  - **注册未文档化的 REPL 命令**：`customize-agent` CLI 的 `/compact` 和 `/context` 命令已加入命令列表和 i18n 翻译
  - **修复孤立的知识库搜索页面**：server 侧边栏添加 `/knowledge/search` 导航链接
  - **添加知识库管理页导航按钮**：server manage 页面添加跳转到 files 和 search 的按钮
  - **删除重复的 .traineddata 文件**：根目录下重复的 Tesseract 语言数据文件（~15MB）已删除
  - **添加 \*.traineddata 到 .gitignore**：防止 OCR 语言数据文件被提交
  - **清理根目录遗留调试文件**：debug-\*.md 文件已删除

  ### 🟢 低优先级修复

  - **所有包添加 "exports" 字段**：8 个包和 CLI 均添加了正式的 exports 映射，锁定公共 API 边界
  - **重命名 misleading .d.ts 文件**：`marked-terminal.d.ts` → `vendor-modules.d.ts`
  - **清理 .npmrc**：移除非标准格式的 access=public 配置
  - **移除 server 中冗余的 @next/eslint-plugin-next**：由根目录统一管理
  - **标记 engine errors.ts 为废弃**：添加注释引导从 `@customize-agent/types` 直接导入

  ### ✅ 验证结果

  - TypeScript 类型检查：17/17 通过，零错误
  - ESLint 检查：10/10 通过，零警告
  - 测试：252/252 全部通过

- Updated dependencies
  - @customize-agent/types@2.0.1
  - @customize-agent/llm@2.0.1
  - @customize-agent/memory@2.0.1
  - @customize-agent/knowledge@2.1.0
  - @customize-agent/runtime@2.0.1
  - @customize-agent/search@2.0.1
  - @customize-agent/tools@2.1.0
  - @customize-agent/engine@2.1.0

## 2.1.1

### Patch Changes

- 6218da2: - 优化 bundle-server 脚本，补充 static/public 目录拷贝
  - 重构 dashboard 启动逻辑，新增日志文件支持与 waitForDashboard 辅助函数

## 2.1.0

### Minor Changes

- 5175c85: - Web Dashboard 捆绑到 CLI npm 包，终端用户安装后即可自动启动管理控制台
  - server 目录重命名（customize-agent-server → server）
  - 使用 Next.js standalone 模式实现自包含生产构建
  - 优化 findDashboardServerDir 路径解析逻辑，兼容 npm 安装和 monorepo 开发两种模式

## 2.0.0

### Major Changes

- 6744afe: 优化、拓展、兼容、新增

### Patch Changes

- Updated dependencies [6744afe]
  - @customize-agent/engine@2.0.0
  - @customize-agent/knowledge@2.0.0
  - @customize-agent/llm@2.0.0
  - @customize-agent/memory@2.0.0
  - @customize-agent/runtime@2.0.0
  - @customize-agent/search@2.0.0
  - @customize-agent/tools@2.0.0
  - @customize-agent/types@2.0.0

## 1.0.5

### Patch Changes

- 98c179b: 新增本地知识库系统、完善发行说明与零基础用户教程

  - **knowledge**: 新增本地知识库核心包，支持项目级隔离、全局共享、多格式解析、增量索引、去重管线、Web Dashboard、多项目管理
  - **tools**: 修复 archiver 类型声明，新增跨平台抽象层（shell/process/binary）
  - **engine**: 新增子智能体 Git Worktree / Snapshot 文件隔离策略
  - **search**: 修复 LSP Manager 与 grep 搜索
  - **CLI**: 优化 TUI 多行输入与粘贴，更新 README 与 RELEASE_NOTES，补全零基础用户安装教程

- Updated dependencies [98c179b]
  - @customize-agent/knowledge@1.0.1
  - @customize-agent/tools@1.0.3
  - @customize-agent/engine@1.0.3
  - @customize-agent/search@1.0.3

## 1.0.4

### Patch Changes

- 修复并优化：

  - **CLI**: 修复 TUI 多行输入、粘贴模式和渲染问题；修复 task-input-capture 逻辑
  - **Tools**: 新增跨平台抽象层（Shell、进程管理、二进制解析）；修复 archiver 类型声明；修复 shell-tools floating promise 和 process cleanup 警告
  - **Engine**: 新增 Git Worktree / Snapshot 隔离策略；修复 Orchestrator 编排逻辑；增强权限引擎
  - **Search**: 修复 LSP Manager；优化 grep 搜索
  - **Types**: 新增统一错误类型定义
  - **Runtime**: 修复遥测审计日志
  - 所有包: 消除 lint 警告，通过 typecheck

- Updated dependencies
  - @customize-agent/tools@1.0.2
  - @customize-agent/engine@1.0.2
  - @customize-agent/search@1.0.2
  - @customize-agent/llm@1.0.2
  - @customize-agent/memory@1.0.2
  - @customize-agent/runtime@1.0.2
  - @customize-agent/types@1.0.2

## 1.0.3

### Patch Changes

- 修复 Commander 程序名统一为 `customize`（与 bin 入口保持一致）

## 1.0.2

### Patch Changes

- 修复 CLI 缺少 shebang 导致 `bin` 入口无法直接执行的问题

## 1.0.1

### Patch Changes

- 3ab2cbf: 🎉 初始发布 — 通用终端 AI 助手首次公开发布

  - 7 个核心包 + 1 个 CLI 应用
  - 6 个 LLM Provider 支持（OpenAI / DeepSeek / Anthropic / Google / OpenRouter / Ollama）
  - 50+ 内置工具（文件操作、搜索、终端、Git、多媒体、导出等）
  - 三级模型分层架构
  - 双语 TUI 界面（中文/英文）
  - 内核级沙箱安全隔离
  - MCP 协议支持（Server + Client）
  - 子智能体编排系统
  - 跨会话记忆系统

- Updated dependencies [3ab2cbf]
  - @customize-agent/types@1.0.1
  - @customize-agent/llm@1.0.1
  - @customize-agent/tools@1.0.1
  - @customize-agent/search@1.0.1
  - @customize-agent/engine@1.0.1
  - @customize-agent/runtime@1.0.1
  - @customize-agent/memory@1.0.1
