---
"customize-agent": minor
---

- Web Dashboard 捆绑到 CLI npm 包，终端用户安装后即可自动启动管理控制台
- server 目录重命名（customize-agent-server → server）
- 使用 Next.js standalone 模式实现自包含生产构建
- 优化 findDashboardServerDir 路径解析逻辑，兼容 npm 安装和 monorepo 开发两种模式
