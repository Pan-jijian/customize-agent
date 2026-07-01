# Customize Agent v1.0.4 发行说明

发布日期：2026-07-01

## 项目简介

Customize Agent 是一个可定制的本地智能体 CLI。它通过项目根目录的 `CUSTOMIZE.md` 定义智能体角色、规则和项目偏好，并结合本地知识库、代码工具、记忆系统、Web Dashboard 和子智能体编排能力，帮助开发者完成检索、分析、编码、审查和资料问答。

本版本重点完善本地知识库，让项目资料可以通过本地文件夹、Web 页面和智能体工具统一使用。

## 核心特性

- **项目级规则**：首次启动自动生成 `CUSTOMIZE.md` 示例文件，已有文件不会被覆盖。
- **本地知识库**：自动生成 `knowledgeBase`，支持 Web 上传和本地文件夹双向同步。
- **多格式解析**：支持 PDF、Office、表格、图片 OCR、CAD/图纸、代码、数据文件、网页、图表和压缩包。
- **智能体检索**：主智能体自动使用知识库上下文，子智能体可通过 `knowledge_search` 检索同一份知识库。
- **Web Dashboard**：支持总览、搜索、上传、文件管理、失败文件处理、语言切换和重新同步。
- **子智能体编排**：支持研究、实现、审查、测试等任务拆分和协作。
- **跨会话记忆**：保存项目经验、规则和偏好，后续会话继续使用。

## 零基础从零开始教程

本教程面向非技术用户。你不需要懂编程，只需要按照步骤操作即可。

### 第一步：安装 Node.js

Customize Agent 基于 Node.js 运行，需要先安装它。

**macOS 用户：**

打开终端（在"启动台 → 其他 → 终端"），粘贴以下命令：

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

关闭终端重新打开，然后执行：

```bash
nvm install 22
```

**Windows 用户：**

1. 打开浏览器访问 **https://nodejs.org**
2. 点击左侧绿色的 **LTS** 按钮下载安装包
3. 双击下载的文件，一直点"下一步"完成安装
4. 安装完成后**重启电脑**

**Linux 用户 (Ubuntu/Debian)：**

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

**验证安装成功：** 打开终端（Windows 打开 PowerShell），输入 `node --version`，看到版本号（如 v22.x.x）即表示成功。

### 第二步：安装 Customize Agent

在终端中输入以下命令（复制粘贴即可）：

```bash
npm install -g customize-agent
```

等待安装完成。安装成功后，输入以下命令验证：

```bash
customize --help
```

看到欢迎信息即表示安装成功。

### 第三步：进入你的项目文件夹

在终端中，进入到你的工作文件夹。例如你的项目在桌面上的 `my-work` 文件夹中：

```bash
cd ~/Desktop/my-work
```

> 如果没有项目文件夹，先创建一个：
> ```bash
> mkdir ~/Desktop/my-work
> cd ~/Desktop/my-work
> ```

### 第四步：启动 Customize Agent

```bash
customize
```

首次启动会自动在你的项目文件夹中生成两个内容：

- **`CUSTOMIZE.md`** — 智能体的角色和规则说明文件。你可以用记事本或任何文本编辑器打开它，用自然语言告诉智能体"你是做什么的、要遵守什么规则"。
- **`knowledgeBase/`** — 本地知识库文件夹。里面已经按类型创建好了子文件夹，你可以把工作中用到的 PDF、Word 文档、Excel 表格、图片、图纸等资料直接放进去。

启动后你会看到欢迎界面，底部有一个输入框，在这里你可以像聊天一样向智能体提问题或布置任务。

### 第五步：配置 API Key（只需做一次）

智能体需要连接大模型才能工作。以 DeepSeek 为例（性价比高，推荐国内用户）：

1. 打开浏览器访问 **https://platform.deepseek.com**
2. 注册账号并登录
3. 点击左侧 **API Keys** → **创建 API Key**
4. 复制生成的 `sk-xxx...` 密钥

回到 Customize Agent 的终端，输入以下两条命令：

```
/model add action deepseek deepseek-chat
/model key deepseek 粘贴你的API Key到这里
```

配置完成！现在就可以正常使用了。

### 第六步：开始使用

**向智能体提问或布置任务：**

直接在输入框打字即可，例如：

```
帮我写一份项目周报，参考知识库里的周报模板
```

```
帮我分析一下 knowledgeBase 里的销售数据表格，找出上个月增长最快的产品
```

```
看一下我的 CUSTOMIZE.md，然后根据项目规则审查这个方案是否合规
```

**把工作资料放进知识库：**

直接把文件复制到 `knowledgeBase` 对应的子文件夹中即可。支持的类型包括 PDF、Word、Excel、PPT、图片、CAD 图纸、代码文件等。放进文件夹后，智能体会自动发现并索引新文件。

你也可以打开 Web 管理页面上传和管理资料：

```
/kb dashboard
```

浏览器会自动打开管理页面，在这里你可以搜索知识库、上传文件、查看文件列表、处理解析失败的文件。

**常用命令：**

| 命令 | 作用 |
|------|------|
| `CUSTOMIZE.md` 文件 | 用自然语言定义智能体的角色、工作规则和偏好 |
| `/kb dashboard` | 打开 Web 管理页面 |
| `/kb overview` | 查看知识库统计概览 |
| `/kb list` | 列出已入库的文件 |
| `/kb search <关键词>` | 搜索知识库中的内容 |
| `/model` | 查看和切换模型 |
| `/language` | 切换界面语言（中文/英文） |
| `/help` | 查看所有可用命令 |
| `/exit` | 退出程序 |

**日常使用技巧：**

- 把常用的合同模板、报告格式、公司规范放进 `knowledgeBase`，智能体会在相关任务中自动参考。
- 用 `CUSTOMIZE.md` 写清楚你的角色要求，比如"你是一个金融分析师，回答要包含数据支撑"。
- 每次有新资料，直接放进 `knowledgeBase` 文件夹即可，不需要手动重建索引。
- 知识库支持增量同步：新增、修改、删除文件都会被自动检测和处理。

## 平台支持

- **macOS**：完整支持所有功能。
- **Windows**：完整支持所有功能。推荐使用 Windows Terminal（Microsoft Store 免费下载）获得最佳显示效果。
- **Linux**：完整支持所有功能。

系统要求：Node.js 18 或以上版本。

## 本版本新增与改进

### 新增

- 新增用户项目根目录初始化。
- 新增 Web Dashboard 文件管理和失败文件列表。
- 新增本地文件夹与 Web 上传双向同步。
- 新增 Dashboard 语言切换。
- 新增自定义模态弹窗，替代浏览器原生弹窗。
- 新增 `knowledge_search` 工具，支持子智能体检索本地知识库。

### 改进

- 改进项目根目录识别，避免文件生成到 CLI 包目录。
- 改进 PDF、表格、图片 OCR 和图纸解析稳定性。
- 改进文件管理按钮语义，将“移除”调整为更明确的“删除”。
- 合并 Web Dashboard 的刷新与重新索引入口为“同步知识库”。
- 改进 Web Dashboard 国际化和下拉框视觉对齐。
- 改进主智能体与子智能体的知识库一致性。

### 修复

- 修复正常 PDF 被误判解析失败的问题。
- 修复损坏图片触发 OCR worker 崩溃导致 CLI 启动失败的问题。
- 修复 Web 文件管理不显示本地新增知识库文件的问题。
- 修复部分 Dashboard 文案显示 `[object Object]` 或 `undefined` 的问题。
- 修复 Web 下拉菜单被下方卡片遮挡的问题。

## 常见问题

### 上传文件后为什么没有入库？

只有成功解析出正文的文件才会入库。解析失败的文件会出现在 Web Dashboard 的“入库失败文件”列表中，并显示失败原因。

### 入库失败文件可以怎么处理？

可以删除无效文件，或修复文件内容后点击“重新入库”。

### 可以直接把文件放进 `knowledgeBase` 吗？

可以。Web 文件管理、搜索和智能体检索前会自动同步本地新增、修改和删除的文件。

### 知识库文件夹在哪里？

启动 Customize Agent 后，会在你当前所在的文件夹中自动生成 `knowledgeBase` 目录。你可以直接在里面看到按类型分类的子文件夹。

### `CUSTOMIZE.md` 会覆盖已有规则吗？

不会。只有文件不存在时才会生成示例文件。

### 子智能体能使用知识库吗？

可以。子智能体通过 `knowledge_search` 检索与主智能体相同的用户项目知识库。

## 升级提示

- 已有 `CUSTOMIZE.md` 不会被覆盖。
- 旧知识库会在访问文件管理、搜索或同步知识库时自动增量同步。
- 如果解析失败，请在 Web Dashboard 的失败文件列表中查看原因。
- 升级方式：`npm update -g customize-agent`，然后重新启动即可。
