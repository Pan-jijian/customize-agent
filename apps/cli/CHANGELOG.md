# customize-agent

## 4.0.50

### Patch Changes

- Improve document refine interaction to preserve user prompts and strengthen local edit safety.
- Updated dependencies
  - @customize-agent/server@4.0.59
  - @customize-agent/knowledge@4.0.23
  - @customize-agent/tools@3.0.15

## 4.0.49

### Patch Changes

- Fix document export body limits, improve document refine local editing, and suppress OCR native noise.
- Updated dependencies
  - @customize-agent/server@4.0.58
  - @customize-agent/knowledge@4.0.22
  - @customize-agent/tools@3.0.14

## 4.0.48

### Patch Changes

- Optimize document workflow generation quality and performance.
- Updated dependencies
  - @customize-agent/server@4.0.57

## 4.0.47

### Patch Changes

- 允许文档在存在导出风险提示时继续导出，并保留复核提示。
- Updated dependencies
  - @customize-agent/server@4.0.56

## 4.0.46

### Patch Changes

- 完善文档生成进度状态收敛、共享证据复用，以及长连续文本切片稳定性。
- Updated dependencies
  - @customize-agent/server@4.0.55
  - @customize-agent/knowledge@4.0.21

## 4.0.45

### Patch Changes

- 加固文档生成进度状态、共享证据去重与长连续文本切片边界。
- Updated dependencies
  - @customize-agent/server@4.0.54
  - @customize-agent/knowledge@4.0.20

## 4.0.44

### Patch Changes

- 修复文档工作流生成前置阶段进度反馈、共享资料证据池复用，以及图片 OCR 小图/无文字处理噪声。
- Updated dependencies
  - @customize-agent/server@4.0.53
  - @customize-agent/knowledge@4.0.19

## 4.0.43

### Patch Changes

- Fix dashboard production startup, template-bound material readiness, and stale dashboard health checks.
- Updated dependencies
  - @customize-agent/server@4.0.52

## 4.0.42

### Patch Changes

- Prevent tiny images from entering OCR during knowledge indexing and publish the fix through the server and CLI packages.
- Updated dependencies
  - @customize-agent/knowledge@4.0.18
  - @customize-agent/server@4.0.51

## 4.0.41

### Patch Changes

- Improve folder upload resilience and knowledge file listing visibility.
- Updated dependencies
  - @customize-agent/server@4.0.50

## 4.0.40

### Patch Changes

- Strengthen document budget generation and export gate enforcement.
- Updated dependencies
  - @customize-agent/server@4.0.49

## 4.0.39

### Patch Changes

- Release CLI with updated server package.

## 4.0.38

### Patch Changes

- Improve document generation length handling, PDF export formatting, and targeted chapter-level repair without full-document rewrites.
- Updated dependencies
  - @customize-agent/server@4.0.47

## 4.0.37

### Patch Changes

- Update bundled workspace dependency resolution for the latest knowledge and server packages.

## 4.0.36

### Patch Changes

- Release scanned PDF OCR stability fix through the CLI and server packages.
- Updated dependencies
  - @customize-agent/server@4.0.45

## 4.0.35

### Patch Changes

- Improve document editing workflow and knowledge extraction support.
- Updated dependencies
  - @customize-agent/server@4.0.44
  - @customize-agent/knowledge@4.0.15

## 4.0.33

### Patch Changes

- Fix generated document navigation consistency and strengthen construction document output quality.
- Updated dependencies
  - @customize-agent/server@4.0.42

## 4.0.25

### Patch Changes

- Release formal patch version.
- Updated dependencies
  - @customize-agent/server@4.0.29
  - @customize-agent/engine@3.0.4
  - @customize-agent/knowledge@4.0.12
  - @customize-agent/llm@3.0.6
  - @customize-agent/memory@3.0.4
  - @customize-agent/runtime@3.0.8
  - @customize-agent/search@3.0.4
  - @customize-agent/tools@3.0.12
  - @customize-agent/types@3.0.4

## 4.0.24

### Patch Changes

- Improve CLI startup visibility and avoid long silent waits when the Web dashboard health check fails.

## 4.0.23

### Patch Changes

- Release workflow, document generation, and knowledge extraction improvements.
- Updated dependencies
  - @customize-agent/server@4.0.26
  - @customize-agent/knowledge@4.0.9
  - @customize-agent/tools@3.0.11
  - @customize-agent/types@3.0.3
  - @customize-agent/search@3.0.3
  - @customize-agent/memory@3.0.3
  - @customize-agent/runtime@3.0.7
  - @customize-agent/llm@3.0.5
  - @customize-agent/engine@3.0.3

## 4.0.3

### Patch Changes

- Fix the interactive CLI banner to display the published package version instead of a stale hardcoded version.

## 4.0.2

### Patch Changes

- Stabilize the local knowledge base and document workflow release path.

  - Replace the sqlite-vec vector store with a mandatory HNSWLib vector store and install-time native validation.
  - Fix archive upload handling, upload/reindex progress state, and forced reindex behavior.
  - Ensure built-in workflow templates pass preflight validation with seeded knowledge base content.
  - Add workflow template validation, inline diagnostics, editable chapter structure, and generated document/resource knowledge-base backflow.
  - Fix PDF/HTML export image rendering for local knowledge-base resources and harden local image path resolution.
  - Remove production test routes, stale sqlite-vec dependency residue, and stale dist artifacts from package tarballs.

- Updated dependencies
  - @customize-agent/server@4.0.2
  - @customize-agent/knowledge@4.0.2

## 4.0.1

### Patch Changes

- 优化 UI 体验：统一页面头部风格，角色配置/规范包/文档生成/生成资源/提示词管理等页面卡片网格布局与抽屉编辑器重构，完善标签国际化，修复热更新与 API 请求问题
- Updated dependencies
  - @customize-agent/server@4.0.1
  - @customize-agent/knowledge@4.0.1

## 4.0.0

### Major Changes

- 优化

### Patch Changes

- Updated dependencies
  - @customize-agent/knowledge@4.0.0
  - @customize-agent/server@4.0.0

## 3.0.22

### Patch Changes

- 更新服务端 PDF/大文件上传入库修复。
- Updated dependencies
  - @customize-agent/server@3.0.29
  - @customize-agent/knowledge@3.0.13

## 3.0.21

### Patch Changes

- 更新服务端知识库重复上传修复。
- Updated dependencies
  - @customize-agent/server@3.0.28

## 3.0.20

### Patch Changes

- 发布真实 DWG 样本验证后的知识库上传与转换修复。
- Updated dependencies
  - @customize-agent/server@3.0.27
  - @customize-agent/knowledge@3.0.12

## 3.0.19

### Patch Changes

- 发布知识库上传和内置 DWG 转换修复。
- Updated dependencies
  - @customize-agent/server@3.0.26
  - @customize-agent/knowledge@3.0.11

## 3.0.18

### Patch Changes

- 重新发布 Web 管理控制台和 CLI 安装入口，确保用户安装后启动最新服务。
- Updated dependencies
  - @customize-agent/server@3.0.25

## 3.0.17

### Patch Changes

- 更新 CLI 安装入口依赖的 Web 管理控制台版本。

## 3.0.16

### Patch Changes

- Fix dashboard static assets, direct endpoint provider configuration, error logging, and generated document PDF export.
- Updated dependencies
  - @customize-agent/server@3.0.23
  - @customize-agent/llm@3.0.4
  - @customize-agent/runtime@3.0.6

## 3.0.15

### Patch Changes

- Fix document export robustness and page navigation performance by sanitizing binary evidence, adding a PDF fallback, and avoiding unnecessary knowledge-base reindexing on page load.
- Updated dependencies
  - @customize-agent/server@3.0.14
  - @customize-agent/knowledge@3.0.10
  - @customize-agent/tools@3.0.9

## 3.0.14

### Patch Changes

- Make the built-in Delta Force operator guide fully runnable with initialized knowledge-base assets, built-in markers, richer roles/specs, localized spec controls, and verified generation/export flow.
- Updated dependencies
  - @customize-agent/server@3.0.13
  - @customize-agent/knowledge@3.0.9
  - @customize-agent/tools@3.0.8

## 3.0.13

### Patch Changes

- Add a runnable Delta Force operator guide demo, multi-resource role bindings, clearer role/spec explanations, and safer modal behavior.
- Updated dependencies
  - @customize-agent/server@3.0.12
  - @customize-agent/knowledge@3.0.8
  - @customize-agent/tools@3.0.7

## 3.0.12

### Patch Changes

- Add configurable document spec packages, deep spreadsheet parsing, configurable export gates, and Word document export support.
- Updated dependencies
  - @customize-agent/server@3.0.11
  - @customize-agent/knowledge@3.0.7
  - @customize-agent/tools@3.0.6

## 3.0.11

### Patch Changes

- Enhance the user guide with rich staged walkthroughs, guided timelines, detailed operation steps, and completion checklists.
- Updated dependencies
  - @customize-agent/server@3.0.10

## 3.0.10

### Patch Changes

- Add document generation execution status card and detailed full-flow user guide page.
- Updated dependencies
  - @customize-agent/server@3.0.9

## 3.0.9

### Patch Changes

- Add document multi-stage execution engine, LLM JSON fact extraction, structured table parsing, source traceability, and export gate enforcement.
- Updated dependencies
  - @customize-agent/server@3.0.8
  - @customize-agent/llm@3.0.3
  - @customize-agent/knowledge@3.0.6
  - @customize-agent/runtime@3.0.5
  - @customize-agent/tools@3.0.5

## 3.0.8

### Patch Changes

- Add production document workflow capabilities with role execution types, file processing types, structured facts, stricter validation, and formal document layout export.
- Updated dependencies
  - @customize-agent/server@3.0.7
  - @customize-agent/knowledge@3.0.5
  - @customize-agent/runtime@3.0.4
  - @customize-agent/tools@3.0.4

## 3.0.7

### Patch Changes

- Release document generation workbench, embedding configuration, PDF export, and knowledge-driven document workflow improvements.
- Updated dependencies
  - @customize-agent/server@3.0.6
  - @customize-agent/runtime@3.0.3
  - @customize-agent/knowledge@3.0.4
  - @customize-agent/tools@3.0.3

## 3.0.6

### Patch Changes

- Improve legacy Word and CAD document ingestion, add batch file deletion controls, and fix terminal thinking status rendering.
- Updated dependencies
  - @customize-agent/server@3.0.5
  - @customize-agent/knowledge@3.0.3

## 3.0.5

### Patch Changes

- Fix CUSTOMIZE.md system prompt injection for all task modes and make terminal task status append-only instead of erasing progress.
- Updated dependencies
  - @customize-agent/server@3.0.4

## 3.0.4

### Patch Changes

- Fix terminal input recovery after task execution, command prompts, and interrupt handling.

## 3.0.3

### Patch Changes

- Fix packaged dashboard startup by keeping Next.js server output in CommonJS package scope.
- Updated dependencies
  - @customize-agent/server@3.0.3

## 3.0.2

### Patch Changes

- Patch release 3.0.2.
- Updated dependencies
  - @customize-agent/server@3.0.2
  - @customize-agent/engine@3.0.2
  - @customize-agent/knowledge@3.0.2
  - @customize-agent/llm@3.0.2
  - @customize-agent/memory@3.0.2
  - @customize-agent/runtime@3.0.2
  - @customize-agent/search@3.0.2
  - @customize-agent/tools@3.0.2
  - @customize-agent/types@3.0.2

## 3.0.1

### Patch Changes

- Patch release 3.0.1.
- Updated dependencies
  - @customize-agent/server@3.0.1
  - @customize-agent/engine@3.0.1
  - @customize-agent/knowledge@3.0.1
  - @customize-agent/llm@3.0.1
  - @customize-agent/memory@3.0.1
  - @customize-agent/runtime@3.0.1
  - @customize-agent/search@3.0.1
  - @customize-agent/tools@3.0.1
  - @customize-agent/types@3.0.1

## 3.0.0

### Major Changes

- Release 3.0.0 with updated CLI, web management, knowledge base, prompt, and tool execution behavior.

### Patch Changes

- Updated dependencies
  - @customize-agent/server@3.0.0
  - @customize-agent/engine@3.0.0
  - @customize-agent/knowledge@3.0.0
  - @customize-agent/llm@3.0.0
  - @customize-agent/memory@3.0.0
  - @customize-agent/runtime@3.0.0
  - @customize-agent/search@3.0.0
  - @customize-agent/tools@3.0.0
  - @customize-agent/types@3.0.0

## 2.1.18

### Patch Changes

- Fix Windows EBUSY install error by removing postinstall and delaying server setup

  - Remove postinstall script to avoid npm rename conflicts
  - Add ensureServerIsInstalled() function to set up server on first run
  - Enhance kill-server.cjs with more aggressive process killing on Windows
  - Improve error handling and retry logic for file operations

- Updated dependencies
  - @customize-agent/engine@2.1.5
  - @customize-agent/knowledge@2.1.3
  - @customize-agent/llm@2.0.4
  - @customize-agent/memory@2.0.4
  - @customize-agent/runtime@2.0.4
  - @customize-agent/search@2.0.6
  - @customize-agent/tools@2.1.5
  - @customize-agent/types@2.0.4

## 2.1.17

### Patch Changes

- SUPER AGGRESSIVE Windows EBUSY fix - completely rewritten kill-server.cjs

  - Complete rewrite of kill-server.cjs with super aggressive cleanup on Windows
  - Kills all related Node.js processes multiple times
  - Checks for file locks and waits up to 30 seconds
  - Double-kill strategy to ensure nothing respawns
  - Scans all node.exe processes for any reference to customize-agent
  - Force-kills anything that might be holding file locks

- Updated dependencies
  - @customize-agent/engine@2.1.4
  - @customize-agent/knowledge@2.1.2
  - @customize-agent/llm@2.0.3
  - @customize-agent/memory@2.0.3
  - @customize-agent/runtime@2.0.3
  - @customize-agent/search@2.0.5
  - @customize-agent/tools@2.1.4
  - @customize-agent/types@2.0.3

## 2.1.16

### Patch Changes

- 修复 Windows 平台的安装和服务器启动问题

  - 增强 kill-server.cjs 脚本，更可靠地终止相关进程并释放文件句柄
  - 修复服务器启动路径问题，正确设置工作目录
  - 优化 setup.js，增强日志和重试机制
  - 改进健康检查 API，更健壮的 BUILD_ID 查找
  - 优化 process.chdir 处理，避免 Windows 文件锁定问题

- Updated dependencies
  - @customize-agent/engine@2.1.3
  - @customize-agent/knowledge@2.1.1
  - @customize-agent/llm@2.0.2
  - @customize-agent/memory@2.0.2
  - @customize-agent/runtime@2.0.2
  - @customize-agent/search@2.0.4
  - @customize-agent/tools@2.1.3
  - @customize-agent/types@2.0.2

## 2.1.15

### Patch Changes

- 架构级修复：Server 移出 npm 包目录 + kill-server 全重写

  ### 根因

  无论 CWD 是 `dist/server/` 还是 `dist/server/apps/server/`，都在 npm 包目录下。
  Windows 锁定整个路径链 → npm 升级时无法重命名 → EBUSY。

  ### 修复：Server 迁移到 `~/.customize-agent/server/`

  ```
  旧: C:\Users\...\npm\node_modules\customize-agent\dist\server\  ← EBUSY
  新: C:\Users\...\.customize-agent\server\                        ← 永不冲突
  ```

  1. `bundle-server.mjs`: 打包到 `dist/server-bundle/`(种子)
  2. `setup.js` (postinstall): 按 BUILD_ID 增量复制到 `~/.customize-agent/server/`
  3. `index.ts`: `findDashboardServerDir` 优先查找 `~/.customize-agent/server/`
  4. `kill-server.cjs`: 使用 `Get-CimInstance Win32_Process`(最可靠) + `WMIC` fallback + `netstat` + `pgrep`

## 2.1.14

### Patch Changes

- ## 🎯 修复 EBUSY 根因：杀 CLI 进程 + Ctrl+C 清理子进程

  ### 🔍 2.1.13 为什么仍然 EBUSY？

  2.1.13 的 `kill-server.cjs` 只杀 server 进程，但 **CLI 进程仍在运行**。
  CLI 检测到 server 端口不可达时会自动重启它 → npm 重命名目录时再次 EBUSY。

  ```
  preinstall: kill server ✓ → CLI 检测 server 挂了 → CLI 重启 server → npm 重命名 → EBUSY ✗
  ```

  ### 🔧 修复 ①：kill-server.cjs — 先杀 CLI，再杀 server

  ```
  preinstall: kill CLI ✓ → CLI 无法重启 server → kill server ✓ → npm 重命名 → 成功 ✓
  ```

  | 改进项      | 说明                                                      |
  | ----------- | --------------------------------------------------------- |
  | 执行顺序    | **先杀 CLI 进程**（`killCLIProcess()`），再杀 server 进程 |
  | 输出方式    | stderr 输出，npm install 时强制可见                       |
  | 日志内容    | 输出被杀的 PID 和来源（PowerShell/wmic/端口）             |
  | macOS/Linux | 新增 `pkill -f` 匹配命令行杀进程                          |

  ### 🔧 修复 ②：index.ts — 退出时清理所有子进程

  用户 Ctrl+C / 关闭终端 / `/exit` 时，CLI 自动杀掉 dashboard server + chroma：

  - `spawnedPids` Set 追踪所有子进程 PID
  - `process.on('exit')` — 正常退出时 `taskkill /F`（Win）或 `process.kill(SIGTERM)`（Unix）
  - `SIGHUP` / `SIGTERM` — 终端关闭或被 kill 时也触发清理
  - 双重 Ctrl+C 退出也保证 server 不残留

  ### ⚠️ 升级说明

  从旧版本升级时，如果仍有 EBUSY，请先手动关闭终端中的 `customize` CLI：

  ```powershell
  taskkill /F /IM node.exe /FI "CMDLINE ne cmd.exe"
  npm i -g customize-agent@latest
  ```

  升级到 2.1.14+ 后，此问题不会再出现。

## 2.1.13

### Patch Changes

- ## 🐛 彻底修复 Windows EBUSY + workspace:\* 协议错误

  ### 🔍 问题

  2.1.11 / 2.1.12 存在两个阻断性安装问题：

  1. **EBUSY 未根除**：旧版 server 进程将 cwd 锁在 `dist\server\apps\server\`，`kill-server.cjs` busy-wait 占满 CPU 且杀后不等句柄释放
  2. **EUNSUPPORTEDPROTOCOL**：tarball 中 `dist/server/packages/*/package.json` 和 `dist/server/apps/server/package.json` 残留 `workspace:*` 协议，npm 安装时拒绝处理

  ### 🔧 修复 ①：kill-server.cjs 彻底重写

  | 修复项         | 旧行为                    | 新行为                                                            |
  | -------------- | ------------------------- | ----------------------------------------------------------------- |
  | CPU 占用       | busy-wait 100% CPU        | `timeout /t` / `sleep` 系统命令，零 CPU                           |
  | Windows 杀进程 | 仅 `netstat` + `taskkill` | **3 层策略**：PowerShell → netstat 兜底 → 按命令行查杀 `node.exe` |
  | 重试           | 单次                      | 3 轮，每轮间隔 2s 真实 sleep                                      |
  | 句柄释放       | 杀完立即退出              | 最终 3s 等待（Windows）                                           |

  ### 🔧 修复 ②：bundle-server.mjs 清除 workspace:\* 残留

  - 自动遍历 `dist/server/` 所有 `package.json`
  - 将 `workspace:*` 替换为对应 `@customize-agent/*` 包的实际版本号（如 `^2.1.0`）
  - 同时 patch `server.js` 移除 `process.chdir(__dirname)`（配合 ③ 避免文件锁）

  ### 🔧 修复 ③：index.ts spawn cwd 调整

  - Bundled 模式：cwd `dist/server/apps/server/` → `dist/server/`（不锁定子目录）
  - Dev 模式：保持 `serverDir` 不变（`next start` 需在此目录找 `.next`）

  ### 📦 已失效版本

  `2.1.11` / `2.1.12` 已损坏，请使用 `2.1.13+`

## 2.1.12

## 2.1.12

### Patch Changes

- ## 🚑 紧急修复 — 改用 pnpm publish 发布

  ### 🔍 问题

  2.1.11 使用 `npm publish` 发布，导致 `package.json` 中 `workspace:*` 协议未被转换为实际版本号，用户安装报错：

  ```
  EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:": workspace:*
  ```

  ### 🔧 修复

  - 改用 `pnpm publish` 发布（pnpm 会自动将 `workspace:*` 转换为实际版本号，如 `^2.1.0`）
  - 功能变更与 2.1.11 完全相同

## 2.1.11

### Patch Changes

- ## 🐛 彻底修复 Windows EBUSY — 三层防御

  ### 🔍 问题

  2.1.10 的 `preinstall` 杀进程方案未能完全解决 Windows 升级时的 `EBUSY: resource busy or locked` 错误：

  - 旧版 server 进程将 **cwd 锁定在** `dist\server\apps\server\` 目录上
  - `kill-server.cjs` **busy-wait 占满 CPU 100%**，且杀进程后未等待 Windows 释放文件句柄
  - 仅按端口杀进程不够 — 端口已释放但目录锁仍存在的边缘情况

  ### 🔧 三层防御链

  **① 安装前 — `kill-server.cjs` 彻底重写**

  - 真实 `sleep()`：用 `timeout /t`（Win）/ `sleep`（Unix）阻塞等待，不再占 CPU
  - Windows **3 层杀进程策略**：
    1. `PowerShell Get-NetTCPConnection` — 按端口杀（主力）
    2. `netstat + taskkill /F` — 兜底（精确端口匹配，避免 17321 误匹配 173210）
    3. `wmic`/`PowerShell` — **按命令行查杀** `node.exe` 进程（匹配 `server.js` / `customize-agent`），捕获端口断开但进程仍持文件句柄的边缘情况
  - 重试 **3 轮**，每轮间隔 2s 真实 sleep
  - **最终 3s 等待**（Windows）— 给系统时间回收 `taskkill /F` 后的文件句柄

  **② 打包时 — `bundle-server.mjs` 移除 `process.chdir`**

  - 自动 patch Next.js standalone `server.js`：注释掉 `process.chdir(__dirname)`
  - 新版 server 不再主动 chdir 到 `apps/server/`，避免锁定子目录

  **③ 运行时 — `index.ts` 修改 spawn cwd**

  - Bundled 模式：cwd 从 `dist/server/apps/server/` → `dist/server/`（父目录）
  - 配合 patch，server 进程不锁定 `apps/server/` 子目录

  ### 📦 升级体验

  ```
  升级前                              升级后
  ─────────────────────────────────────────
  EBUSY 频繁 → 安装失败              根除 → 安装成功
  busy-wait 100% CPU                 真实 sleep，零 CPU
  仅杀端口 → 边缘情况漏网             3 策略层层递进
  杀后不等待 → 句柄未释放             3s 最终等待
  ```

## 2.1.10

### Patch Changes

- ## 🐛 修复 Windows EBUSY + 美化 Logo

  ### 🔧 EBUSY 修复

  - 新增 `preinstall` 脚本：安装/升级前自动终止旧版 server 进程（端口 17321/17322）
  - `scripts/kill-server.cjs` 跨平台实现：
    - Windows: `netstat` + `taskkill /F`
    - macOS/Linux: `lsof` + `SIGTERM`
  - 彻底消除 `EBUSY: resource busy or locked` 错误

  ### ✨ UI 美化

  - 移除侧边栏 logo 图标
  - 标题 "Customize Agent" 改为渐变色：
    - 浅色主题: `#007aff → #5856d6 → #af52de`
    - 深色主题: `#0a84ff → #5e5ce6 → #bf5af2`

## 2.1.9

### Patch Changes

- ## 🔧 重构打包策略 — postinstall 安装依赖

  ### 🔍 问题

  - npm 包捆绑 `dist/server/node_modules/`（50 个包含原生模块），tarball 3000+ 文件
  - Windows 安装 EBUSY：文件锁定 + 大目录 rename 超时
  - 跨平台：预编译的原生模块不兼容

  ### 🔧 重构

  1. **npm tarball 仅含纯 JS**（455 文件，~6MB，不含 node_modules）
  2. **postinstall 运行 setup.js**：自动 `npm install` 平台正确的依赖 + 链接 workspace 包
  3. **`files` 字段排除**：`!dist/server/node_modules` 确保不打包原生模块

  ### 📦 对比

  |                | 重构前     | 重构后   |
  | -------------- | ---------- | -------- |
  | tarball 文件数 | ~3000+     | 455      |
  | 包大小         | ~200MB     | ~6MB     |
  | Windows EBUSY  | 频繁       | 根除     |
  | 跨平台兼容     | 需 rebuild | 原生安装 |

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
