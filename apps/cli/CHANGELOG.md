# customize-agent

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
