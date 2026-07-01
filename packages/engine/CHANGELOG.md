# @customize-agent/engine

## 1.0.3

### Patch Changes

- 98c179b: 新增本地知识库系统、完善发行说明与零基础用户教程

  - **knowledge**: 新增本地知识库核心包，支持项目级隔离、全局共享、多格式解析、增量索引、去重管线、Web Dashboard、多项目管理
  - **tools**: 修复 archiver 类型声明，新增跨平台抽象层（shell/process/binary）
  - **engine**: 新增子智能体 Git Worktree / Snapshot 文件隔离策略
  - **search**: 修复 LSP Manager 与 grep 搜索
  - **CLI**: 优化 TUI 多行输入与粘贴，更新 README 与 RELEASE_NOTES，补全零基础用户安装教程

- Updated dependencies [98c179b]
  - @customize-agent/tools@1.0.3

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
  - @customize-agent/tools@1.0.2
  - @customize-agent/llm@1.0.2
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
  - @customize-agent/llm@1.0.1
