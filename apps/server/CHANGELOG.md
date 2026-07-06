# server

## 4.0.1

### Patch Changes

- 优化 UI 体验：统一页面头部风格，角色配置/规范包/文档生成/生成资源/提示词管理等页面卡片网格布局与抽屉编辑器重构，完善标签国际化，修复热更新与 API 请求问题
- Updated dependencies
  - @customize-agent/knowledge@4.0.1

## 4.0.0

### Major Changes

- 优化

### Patch Changes

- Updated dependencies
  - @customize-agent/knowledge@4.0.0

## 3.0.29

### Patch Changes

- 修复 PDF 等大文件上传后因索引器内部限制被跳过并误报“已写入但未入库”的问题，上传错误会透传具体跳过原因。
- Updated dependencies
  - @customize-agent/knowledge@3.0.13

## 3.0.28

### Patch Changes

- 修复已存在知识库文件重复上传时被错误判定为上传失败的问题，并让上传失败提示显示真实后端错误。

## 3.0.27

### Patch Changes

- 更新知识库 DWG WASM 转换和上传入库修复。
- Updated dependencies
  - @customize-agent/knowledge@3.0.12

## 3.0.26

### Patch Changes

- 修复知识库上传成功但解析分块入库不完整的问题，补充上传结果校验并支持嵌套文件夹上传。
- Updated dependencies
  - @customize-agent/knowledge@3.0.11

## 3.0.25

### Patch Changes

- 重新发布 Web 管理控制台和 CLI 安装入口，确保用户安装后启动最新服务。

## 3.0.24

### Patch Changes

- 优化文档生成、知识库文件列表和规范包配置体验。

## 3.0.23

### Patch Changes

- Fix dashboard static assets, direct endpoint provider configuration, error logging, and generated document PDF export.
- Updated dependencies
  - @customize-agent/llm@3.0.4
  - @customize-agent/runtime@3.0.6

## 3.0.22

### Patch Changes

- 修复 Windows 发布包首次访问文件管理页时内置知识库生成依赖 python3 导致 500 的问题，并让文件列表与模型供应商接口返回可诊断错误信息。

## 3.0.21

### Patch Changes

- 细化学习说明页面，补充生成记录、warning 与导出门禁语义、生成资源与知识库关系、生产级生成前检查清单和常见问题处理建议。

## 3.0.20

### Patch Changes

- 优化生成编辑页草稿历史和校验详情展示：草稿历史补充明确删除按钮与整体生成耗时，校验详情改为可换行的卡片列表，避免长文本溢出卡片。

## 3.0.19

### Patch Changes

- Fix export gate semantics so spec-required fact/source-role gaps are review warnings instead of blocking errors, while exports still block on true exportGate blocking issues.

## 3.0.18

### Patch Changes

- Expand built-in prompt management prompts, make generated documents with validation/export gate issues show warning status instead of failed/completed, allow exports with warnings, and display warning reasons in draft history.

## 3.0.17

### Patch Changes

- Fix generated image asset preview by rejecting placeholder responses from image generation, resolving generated asset paths through the global generatedDocuments directory, validating preview image bytes, and add generated draft history deletion in the document editor.

## 3.0.16

### Patch Changes

- Enrich the built-in document generation demo with additional prompt roles, case/style/export file roles, detailed template style guidance, structured resource evidence guidance, export gate guidance, and a more complete document spec package.

## 3.0.15

### Patch Changes

- Add generated document persistence, background generation polling, generated asset management, dynamic spec-driven fact extraction, structured resource evidence, and dynamic generation status steps.

## Unreleased

### Patch Changes

- Enrich built-in document generation demo with more prompt roles, template style guidance, resource evidence guidance, export gate prompts, case reference file roles, style reference file roles, export gate file roles, and a more detailed document spec package.
- Add generated document persistence under `~/.customize-agent/projects/{projectId}/generatedDocuments`, background generation with polling, generated asset management, dynamic spec-driven fact schema extraction, structured resource evidence, and dynamic generation status steps.

## 3.0.14

### Patch Changes

- Fix document export robustness and page navigation performance by sanitizing binary evidence, adding a PDF fallback, and avoiding unnecessary knowledge-base reindexing on page load.
- Updated dependencies
  - @customize-agent/knowledge@3.0.10

## 3.0.13

### Patch Changes

- Make the built-in Delta Force operator guide fully runnable with initialized knowledge-base assets, built-in markers, richer roles/specs, localized spec controls, and verified generation/export flow.
- Updated dependencies
  - @customize-agent/knowledge@3.0.9

## 3.0.12

### Patch Changes

- Add a runnable Delta Force operator guide demo, multi-resource role bindings, clearer role/spec explanations, and safer modal behavior.
- Updated dependencies
  - @customize-agent/knowledge@3.0.8

## 3.0.11

### Patch Changes

- Add configurable document spec packages, deep spreadsheet parsing, configurable export gates, and Word document export support.
- Updated dependencies
  - @customize-agent/knowledge@3.0.7

## 3.0.10

### Patch Changes

- Enhance the user guide with rich staged walkthroughs, guided timelines, detailed operation steps, and completion checklists.

## 3.0.9

### Patch Changes

- Add document generation execution status card and detailed full-flow user guide page.

## 3.0.8

### Patch Changes

- Add document multi-stage execution engine, LLM JSON fact extraction, structured table parsing, source traceability, and export gate enforcement.
- Updated dependencies
  - @customize-agent/llm@3.0.3
  - @customize-agent/knowledge@3.0.6
  - @customize-agent/runtime@3.0.5

## 3.0.7

### Patch Changes

- Add production document workflow capabilities with role execution types, file processing types, structured facts, stricter validation, and formal document layout export.
- Updated dependencies
  - @customize-agent/knowledge@3.0.5
  - @customize-agent/runtime@3.0.4

## 3.0.6

### Patch Changes

- Release document generation workbench, embedding configuration, PDF export, and knowledge-driven document workflow improvements.
- Updated dependencies
  - @customize-agent/runtime@3.0.3
  - @customize-agent/knowledge@3.0.4

## 3.0.5

### Patch Changes

- Improve legacy Word and CAD document ingestion, add batch file deletion controls, and fix terminal thinking status rendering.
- Updated dependencies
  - @customize-agent/knowledge@3.0.3

## 3.0.4

### Patch Changes

- Fix CUSTOMIZE.md system prompt injection for all task modes and make terminal task status append-only instead of erasing progress.

## 3.0.3

### Patch Changes

- Fix packaged dashboard startup by keeping Next.js server output in CommonJS package scope.

## 3.0.2

### Patch Changes

- Patch release 3.0.2.
- Updated dependencies
  - @customize-agent/knowledge@3.0.2
  - @customize-agent/llm@3.0.2
  - @customize-agent/runtime@3.0.2

## 3.0.1

### Patch Changes

- Patch release 3.0.1.
- Updated dependencies
  - @customize-agent/knowledge@3.0.1
  - @customize-agent/llm@3.0.1
  - @customize-agent/runtime@3.0.1

## 3.0.0

### Major Changes

- Release 3.0.0 with updated CLI, web management, knowledge base, prompt, and tool execution behavior.

### Patch Changes

- Updated dependencies
  - @customize-agent/knowledge@3.0.0
  - @customize-agent/llm@3.0.0
  - @customize-agent/runtime@3.0.0

## 0.1.5

### Patch Changes

- Updated dependencies
  - @customize-agent/knowledge@2.1.3
  - @customize-agent/llm@2.0.4
  - @customize-agent/runtime@2.0.4

## 0.1.4

### Patch Changes

- Updated dependencies
  - @customize-agent/knowledge@2.1.2
  - @customize-agent/llm@2.0.3
  - @customize-agent/runtime@2.0.3

## 0.1.3

### Patch Changes

- Updated dependencies
  - @customize-agent/knowledge@2.1.1
  - @customize-agent/llm@2.0.2
  - @customize-agent/runtime@2.0.2

## 0.1.2

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
  - @customize-agent/llm@2.0.1
  - @customize-agent/knowledge@2.1.0
  - @customize-agent/runtime@2.0.1

## 0.1.1

### Patch Changes

- Updated dependencies [6744afe]
  - @customize-agent/knowledge@2.0.0
  - @customize-agent/llm@2.0.0
  - @customize-agent/runtime@2.0.0
  - @customize-agent/types@2.0.0
