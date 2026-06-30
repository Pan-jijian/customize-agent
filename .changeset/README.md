# Changesets

本项目使用 [Changesets](https://github.com/changesets/changesets) 管理版本和 CHANGELOG。

## 工作流

### 1. 创建 Changeset

当你做了一个需要发布的变更（新功能、bug 修复、API 变更等），运行：

```bash
pnpm changeset
```

交互式 CLI 会询问：
- **哪些包需要发布？** 用空格选择（如 `@customize-agent/tools`, `@customize-agent/engine`）
- **版本类型？** `major`（API 变更）、`minor`（新功能）、`patch`（bug 修复）

这会生成一个 `.md` 文件在 `.changeset/` 目录下，**需要提交到 git**。

### 2. 提交 Changeset

```bash
git add .changeset/
git commit -m "chore: add changeset for xxx feature"
```

### 3. CI 自动处理

- PR 合并到 `master` → Changesets Bot 自动创建/更新 "Version Packages" PR
- 合并 "Version Packages" PR → 自动发布到 npm + 生成 CHANGELOG

## 版本类型选择指南

| 类型 | 何时使用 | 示例 |
|------|------|------|
| `major` | 破坏性 API 变更 | 移除/重命名导出函数，变更接口参数 |
| `minor` | 向后兼容的新功能 | 新增工具、新增 Provider、新增 Hook 事件 |
| `patch` | 向后兼容的 bug 修复 | 修复死循环误判、修复权限检查逻辑 |

## 跳过发布

如果变更不需要发布（如仅修改文档、CI 配置），不需要创建 changeset。
