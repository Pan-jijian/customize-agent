# server

## 4.0.69

### Patch Changes

- 优化文档生成稳定性与生成资源管理：修复生成卡死、中止清理、LLM 超时和轮询取消问题，并将模板生成结果默认登记到生成资源而非自动写入知识库。

## 4.0.68

### Patch Changes

- Harden OCR noise suppression and worker lifecycle, improve workflow abort propagation, and prevent stale workflow auto-start or recovery state from restarting old records.
- Updated dependencies
  - @customize-agent/knowledge@4.0.28

## 4.0.67

### Patch Changes

- Removed redundant explicit outline input prompt from workflow drawer to allow templates to launch automatically.
  Fixed background Tesseract C++ crashes (mutex locks) during high-concurrency image extractions by implementing a sequential queue lock.
  Hardened C++ log interception to completely silence irrelevant OCR warnings.
- Updated dependencies
  - @customize-agent/knowledge@4.0.27

## 4.0.66

### Patch Changes

- Resolve uncaught C++ mutex locking issues with Tesseract.js in multi-threaded workflows by enforcing a strictly sequential worker execution queue, and successfully suppress remaining underlying WASM OCR noise patterns in the console output.
- Updated dependencies
  - @customize-agent/knowledge@4.0.26

## 4.0.65

### Patch Changes

- Remove redundant manual requirement input prompt when running workflows, automatically start the generation process upon running a template, ensuring a smoother user experience.

## 4.0.64

### Patch Changes

- Apply explicit chapter configurations and fallback matchers for project basic facts, and properly restore configured chapter forbidden filters for user explicit outline protection.

## 4.0.63

### Patch Changes

- Fix OUTLINE parsing regression to correctly incorporate strict outline blocks from prompt roles, improve outline formatting compatibility, and ensure missing chapters throw hard errors.

## 4.0.62

### Patch Changes

- Strengthen project and bound-file isolation for document generation, prevent prompt examples from leaking into generated content, and keep CLI knowledge searches scoped to the current project by default.
- Updated dependencies
  - @customize-agent/knowledge@4.0.25

## 4.0.61

### Patch Changes

- Fix streaming tool call propagation, abort handling, background command output retention, and server package assets.
- Updated dependencies
  - @customize-agent/llm@3.0.9

## 4.0.59

### Patch Changes

- Improve document refine interaction to preserve user prompts and strengthen local edit safety.
- Updated dependencies
  - @customize-agent/knowledge@4.0.23

## 4.0.58

### Patch Changes

- Fix document export body limits, improve document refine local editing, and suppress OCR native noise.
- Updated dependencies
  - @customize-agent/knowledge@4.0.22

## 4.0.57

### Patch Changes

- Optimize document workflow generation quality and performance.

## 4.0.56

### Patch Changes

- 允许文档在存在导出风险提示时继续导出，并保留复核提示。

## 4.0.55

### Patch Changes

- 完善文档生成进度状态收敛、共享证据复用，以及长连续文本切片稳定性。
- Updated dependencies
  - @customize-agent/knowledge@4.0.21

## 4.0.54

### Patch Changes

- 加固文档生成进度状态、共享证据去重与长连续文本切片边界。
- Updated dependencies
  - @customize-agent/knowledge@4.0.20

## 4.0.53

### Patch Changes

- 修复文档工作流生成前置阶段进度反馈、共享资料证据池复用，以及图片 OCR 小图/无文字处理噪声。
- Updated dependencies
  - @customize-agent/knowledge@4.0.19

## 4.0.52

### Patch Changes

- Fix dashboard production startup, template-bound material readiness, and stale dashboard health checks.

## 4.0.51

### Patch Changes

- Prevent tiny images from entering OCR during knowledge indexing and publish the fix through the server and CLI packages.
- Updated dependencies
  - @customize-agent/knowledge@4.0.18

## 4.0.50

### Patch Changes

- Improve folder upload resilience and knowledge file listing visibility.

## 4.0.49

### Patch Changes

- Strengthen document budget generation and export gate enforcement.

## 4.0.48

### Patch Changes

- Relax outline title validation for explicit outline input.

## 4.0.47

### Patch Changes

- Improve document generation length handling, PDF export formatting, and targeted chapter-level repair without full-document rewrites.

## 4.0.46

### Patch Changes

- Improve knowledge parsing, chunking, retrieval reranking, and document generation guardrails.
- Updated dependencies
  - @customize-agent/knowledge@4.0.17

## 4.0.45

### Patch Changes

- Release scanned PDF OCR stability fix through the CLI and server packages.

## 4.0.44

### Patch Changes

- Improve document editing workflow and knowledge extraction support.
- Updated dependencies
  - @customize-agent/knowledge@4.0.15

## 4.0.42

### Patch Changes

- Fix generated document navigation consistency and strengthen construction document output quality.

## 4.0.31

### Patch Changes

- Fix construction document export typography and complete recommended brand prompt binding flow.

## 4.0.29

### Patch Changes

- Release formal patch version.
- Updated dependencies
  - @customize-agent/knowledge@4.0.12
  - @customize-agent/llm@3.0.6
  - @customize-agent/runtime@3.0.8

## 4.0.28

### Patch Changes

- Publish the knowledge-base extraction and chunking fixes used by document role/template validation.
- Updated dependencies
  - @customize-agent/knowledge@4.0.11

## 4.0.27

### Patch Changes

- Improve document generation cleanup and make formal-output constraints configurable while using the enhanced knowledge-base parsing and retrieval pipeline.
- Updated dependencies
  - @customize-agent/knowledge@4.0.10

## 4.0.26

### Patch Changes

- Release workflow, document generation, and knowledge extraction improvements.
- Updated dependencies
  - @customize-agent/knowledge@4.0.9
  - @customize-agent/runtime@3.0.7
  - @customize-agent/llm@3.0.5

## 4.0.25

### Patch Changes

- Fix document workflow generation when extracted fact values are arrays or objects, and keep formal document output free of internal evidence sections.

## 4.0.4

### Patch Changes

- Fix namespaced nested translation keys in the server UI.

## 4.0.3

### Patch Changes

- Internationalize knowledge base search labels and improve document workflow guidance.

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
  - @customize-agent/knowledge@4.0.2

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
