# @customize-agent/llm

## 3.1.2

### Patch Changes

- d51d0ab: LLM 请求硬超时兜底：OpenAI SDK 内建 timeout 仅在响应头到达前生效，DeepSeek HTTP/2 长请求「响应头已回但 body 挂起」会让 fetch Promise 永久悬挂，文档流水线修复循环随之卡死（实测真实生成 20+ 分钟无进展）。provider 层新增 hardTimeoutSignal（AbortSignal.timeout 与调用方 signal 组合，默认 10 分钟，LLM_REQUEST_TIMEOUT_MS 可调）覆盖全链路；超时/abort 类错误纳入瞬态识别重试一次，服务端 stall 后任务可自愈继续而非永久卡死。

## 3.1.1

### Patch Changes

- 修复 npm 安装失败：3.1.0 依赖声明泄漏 workspace: 协议导致下游无法安装。

  用户从 npm 安装 @customize-agent/server 时，依赖解析到 @customize-agent/llm@3.1.0 / @customize-agent/runtime@3.1.0，其 dependencies 声明为 "@customize-agent/types": "workspace:^"（pnpm workspace 内部协议泄漏到 registry），npm/pnpm 在非 workspace 环境解析失败（pnpm 报 ERR_PNPM_WORKSPACE_PKG_NOT_FOUND，npm 静默 exit 1）。

  修复：全部 workspace 源码包的内部依赖由 workspace:^ 改为具体版本号（llm/runtime 依赖 types ^3.0.9；tools/search/engine/cli 同步版本号化），杜绝发布工具转换环节再次泄漏。发布 llm 3.1.1 / runtime 3.1.1 后，server 4.8.4（依赖 ^3.1.0）自动恢复可安装。

## 3.1.0

### Minor Changes

- 思考策略重构 + 并发上限解除（生成提速核心版）

  - 新增模型思考画像注册表（MODEL_THINKING_PROFILES）：deepseek（shared 池可关）、gpt-5（effort none）、gemini 3.x（不可关）、qwen/glm（预留），新增模型只需追加一条画像
  - ChatOptions 新增 disableThinking 与 extraBody：provider 按模型画像翻译厂商参数（thinking disabled / reasoning effort none），不可关模型抛显式能力错误
  - 文档生成管线默认 structuredGeneration 任务模式：全部调用硬关思考（思维链不再抢占正文输出池），正文独占 max_tokens 预算
  - 删除模型名正则猜测与 ×6 预算放大博弈：预算按目标字数直通；思考不可关且共享池的模型保留 relaxed 放大
  - 并发上限解除：全局 LLM 并发默认 64（DOCUMENT_LLM_MAX_CONCURRENCY 可覆盖，0=不限），不再按文档规模 8/16/24/32 分档
  - 失败 streak 降串行阈值 2 → 5：偶发失败不再使并发塌缩
  - deepseek 走专用 Provider 工厂（真实 8192 输出上限声明）

## 3.0.13

### Patch Changes

- 批量发布所有包的 patch 版本
- Updated dependencies
  - @customize-agent/types@3.0.9

## 3.0.9

### Patch Changes

- Fix streaming tool call propagation, abort handling, background command output retention, and server package assets.

## 3.0.6

### Patch Changes

- Release formal patch version.
- Updated dependencies
  - @customize-agent/types@3.0.4

## 3.0.5

### Patch Changes

- Release workflow, document generation, and knowledge extraction improvements.
- Updated dependencies
  - @customize-agent/types@3.0.3

## 3.0.4

### Patch Changes

- Fix dashboard static assets, direct endpoint provider configuration, error logging, and generated document PDF export.

## 3.0.3

### Patch Changes

- Add document multi-stage execution engine, LLM JSON fact extraction, structured table parsing, source traceability, and export gate enforcement.

## 3.0.2

### Patch Changes

- Patch release 3.0.2.
- Updated dependencies
  - @customize-agent/types@3.0.2

## 3.0.1

### Patch Changes

- Patch release 3.0.1.
- Updated dependencies
  - @customize-agent/types@3.0.1

## 3.0.0

### Major Changes

- Release 3.0.0 with updated CLI, web management, knowledge base, prompt, and tool execution behavior.

### Patch Changes

- Updated dependencies
  - @customize-agent/types@3.0.0

## 2.0.4

### Patch Changes

- Fix Windows EBUSY install error by removing postinstall and delaying server setup

  - Remove postinstall script to avoid npm rename conflicts
  - Add ensureServerIsInstalled() function to set up server on first run
  - Enhance kill-server.cjs with more aggressive process killing on Windows
  - Improve error handling and retry logic for file operations

- Updated dependencies
  - @customize-agent/types@2.0.4

## 2.0.3

### Patch Changes

- SUPER AGGRESSIVE Windows EBUSY fix - completely rewritten kill-server.cjs

  - Complete rewrite of kill-server.cjs with super aggressive cleanup on Windows
  - Kills all related Node.js processes multiple times
  - Checks for file locks and waits up to 30 seconds
  - Double-kill strategy to ensure nothing respawns
  - Scans all node.exe processes for any reference to customize-agent
  - Force-kills anything that might be holding file locks

- Updated dependencies
  - @customize-agent/types@2.0.3

## 2.0.2

### Patch Changes

- 修复 Windows 平台的安装和服务器启动问题

  - 增强 kill-server.cjs 脚本，更可靠地终止相关进程并释放文件句柄
  - 修复服务器启动路径问题，正确设置工作目录
  - 优化 setup.js，增强日志和重试机制
  - 改进健康检查 API，更健壮的 BUILD_ID 查找
  - 优化 process.chdir 处理，避免 Windows 文件锁定问题

- Updated dependencies
  - @customize-agent/types@2.0.2

## 2.0.1

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

## 2.0.0

### Major Changes

- 6744afe: 优化、拓展、兼容、新增

### Patch Changes

- Updated dependencies [6744afe]
  - @customize-agent/types@2.0.0

## 1.0.2

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
  - @customize-agent/types@1.0.2

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
