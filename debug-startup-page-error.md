# Debug Session: startup-page-error

Status: [OPEN]

## Symptoms
- 用户反馈：启动报错，访问页面也报错。

## Hypotheses
1. `.next` 构建产物与 dev server 状态不一致，导致页面 chunk/manifest 缺失。
2. 最新改动引入服务端运行时语法/导入错误，启动后访问页面才触发。
3. 端口上仍有旧进程或 stale server，访问的是旧构建/旧缓存。
4. npm 发布前清理 `.next/cache` 后 dev 模式重新编译失败。
5. 页面/API 访问某个生成文档或配置文件时触发 JSON/路径错误。

## Evidence Log
- `/documents` 返回 500。
- `/api/health` 返回 500。
- Dev server 日志显示：`Cannot find module './chunks/vendor-chunks/next@15.5.19_react-dom@19.2.7_react@19.2.7__react@19.2.7_sass@1.101.0.js'`。

## Current Conclusion
- 已确认不是页面业务逻辑或 API 业务逻辑先报错，而是 Next `.next/server/webpack-runtime.js` 引用的 vendor chunk 缺失。
- H1 `.next` 构建产物与 dev server 状态不一致成立。
- H2/H5 暂无证据支持。

## Fix
- 修改 `apps/server/package.json` 的 `dev` 脚本：启动前删除 `.next`，避免复用损坏/不匹配的 Next 构建产物。

## Post-fix Verification
- `pnpm --filter @customize-agent/server dev` 启动成功。
- 访问 `/documents` 返回 HTTP 200。
- 页面内容不再包含 `500 - Internal Server Error`。
