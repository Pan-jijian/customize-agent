---
"@customize-agent/knowledge": patch
"@customize-agent/tools": patch
"@customize-agent/engine": patch
"@customize-agent/search": patch
"customize-agent": patch
---

新增本地知识库系统、完善发行说明与零基础用户教程

- **knowledge**: 新增本地知识库核心包，支持项目级隔离、全局共享、多格式解析、增量索引、去重管线、Web Dashboard、多项目管理
- **tools**: 修复 archiver 类型声明，新增跨平台抽象层（shell/process/binary）
- **engine**: 新增子智能体 Git Worktree / Snapshot 文件隔离策略
- **search**: 修复 LSP Manager 与 grep 搜索
- **CLI**: 优化 TUI 多行输入与粘贴，更新 README 与 RELEASE_NOTES，补全零基础用户安装教程
