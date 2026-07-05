# @customize-agent/knowledge

## 3.0.3

### Patch Changes

- Improve legacy Word and CAD document ingestion, add batch file deletion controls, and fix terminal thinking status rendering.

## 3.0.2

### Patch Changes

- Patch release 3.0.2.

## 3.0.1

### Patch Changes

- Patch release 3.0.1.

## 3.0.0

### Major Changes

- Release 3.0.0 with updated CLI, web management, knowledge base, prompt, and tool execution behavior.

## 2.1.3

### Patch Changes

- Fix Windows EBUSY install error by removing postinstall and delaying server setup

  - Remove postinstall script to avoid npm rename conflicts
  - Add ensureServerIsInstalled() function to set up server on first run
  - Enhance kill-server.cjs with more aggressive process killing on Windows
  - Improve error handling and retry logic for file operations

## 2.1.2

### Patch Changes

- SUPER AGGRESSIVE Windows EBUSY fix - completely rewritten kill-server.cjs

  - Complete rewrite of kill-server.cjs with super aggressive cleanup on Windows
  - Kills all related Node.js processes multiple times
  - Checks for file locks and waits up to 30 seconds
  - Double-kill strategy to ensure nothing respawns
  - Scans all node.exe processes for any reference to customize-agent
  - Force-kills anything that might be holding file locks

## 2.1.1

### Patch Changes

- 修复 Windows 平台的安装和服务器启动问题

  - 增强 kill-server.cjs 脚本，更可靠地终止相关进程并释放文件句柄
  - 修复服务器启动路径问题，正确设置工作目录
  - 优化 setup.js，增强日志和重试机制
  - 改进健康检查 API，更健壮的 BUILD_ID 查找
  - 优化 process.chdir 处理，避免 Windows 文件锁定问题

## 2.1.0

### Minor Changes

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

## 2.0.0

### Major Changes

- 6744afe: 优化、拓展、兼容、新增

## 1.0.1

### Patch Changes

- 98c179b: 新增本地知识库系统、完善发行说明与零基础用户教程

  - **knowledge**: 新增本地知识库核心包，支持项目级隔离、全局共享、多格式解析、增量索引、去重管线、Web Dashboard、多项目管理
  - **tools**: 修复 archiver 类型声明，新增跨平台抽象层（shell/process/binary）
  - **engine**: 新增子智能体 Git Worktree / Snapshot 文件隔离策略
  - **search**: 修复 LSP Manager 与 grep 搜索
  - **CLI**: 优化 TUI 多行输入与粘贴，更新 README 与 RELEASE_NOTES，补全零基础用户安装教程
