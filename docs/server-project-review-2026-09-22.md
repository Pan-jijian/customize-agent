# Server 项目审查报告（2026-09-22）

## 1. 审查范围与结论

本次审查范围以 `apps/server` 为主，同时追踪到其直接依赖的本地包 `packages/knowledge` 中与上传、知识库路径、索引、文件详情相关的实现。

整体判断：这是一个功能已经比较成熟的本地 Web 控制台，核心业务能力集中在“知识库管理 + 文档生成工作流 + 导出交付”。项目有较完整的 TypeScript 严格模式、较多单元测试、知识库索引后台任务、生成文档心跳/恢复、原子写 JSON 等工程化基础。  

但它的安全边界明显依赖“本机可信用户、绑定本地地址”的部署假设。当前若被放到不可信网络、多人共用或公网环境，会暴露较高风险，重点集中在：

- 客户端可传入 `projectRoot`，多处 API 直接信任。
- 文件路径 fallback 分支未统一使用安全解析器。
- DOCX 导出模板路径 `wordTemplatePath` 可读取任意本机 docx。
- 生成资产路径允许绝对路径，后续预览/打开接口可能放大影响。
- API 错误边界、路径校验、响应大小和请求大小限制不统一。

## 2. 已执行验证

本次执行的自动检查结果：

```bash
pnpm --filter @customize-agent/server lint
pnpm --filter @customize-agent/server exec tsc --noEmit
pnpm exec vitest run apps/server/test/services/common apps/server/test/services/knowledge apps/server/test/services/document-core/generatedDocumentService.test.ts apps/server/test/services/document-workflow/documentDeliveryReport.test.ts
pnpm exec vitest run apps/server/test/services/document-workflow/documentFinalValidation.test.ts apps/server/test/services/document-workflow/documentIntegrityChecks.test.ts apps/server/test/services/document-workflow/patchGuard.test.ts
```

结果：

- ESLint：通过。
- TypeScript：通过。
- Vitest 抽样：13 个测试文件通过，539 个测试通过。

说明：基础静态质量较好，现有测试覆盖了不少服务层逻辑；但本次发现的路径安全和导出模板安全问题没有看到对应测试覆盖。

## 3. 项目整体评价

### 3.1 优点

1. Monorepo 结构清晰  
   根目录用 pnpm workspace 管理，server 与 knowledge、llm、runtime、tools 等包分层明确。

2. Server 端领域能力完整  
   `apps/server/src/services` 覆盖知识库、文档核心、文档工作流、文档校验、配置、错误日志等模块。

3. 对长任务有工程化处理  
   生成文档模块包含队列、并发上限、任务心跳、断点续跑、中断判定、原子写入和操作日志，明显经历过实战问题修复。

4. 知识库上传链路较成熟  
   上传已切到 `stageUploadedFilePaths + worker`，避免大文件全部读入内存；上传路径本身通过 `validateUploadRelativePath()` 校验 `..`、空段、长度和非法字符。

5. 测试资产较丰富  
   文档工作流和知识库有大量单测，能支撑复杂业务迭代。

### 3.2 主要问题画像

1. API 层安全策略不统一  
   有些 API 使用 `withApiErrorBoundary`，有些手写 `try/catch`；有些调用 `KnowledgeBaseManager` 的安全路径解析，有些自己拼路径。

2. 本地控制台与 Web 服务边界混杂  
   代码里有很多“打开本机文件”“传 projectRoot 操作任意项目”的能力。这对本地工具合理，但必须明确只允许本机可信访问。

3. 文档工作流模块过重  
   `apps/server/src/services/document-workflow/integrity/detectors/detectors.ts` 达 4700+ 行，`qualityValidation.ts` 3000+ 行，`fixers.ts` 2200+ 行，后续维护和定位风险会持续上升。

4. 导出层承担了太多职责  
   `apps/server/src/pages/api/documents/export.ts` 约 1300 行，包含 Markdown 清洗、HTML、DOCX、PDF、图片内联、模板处理、门禁阻断、审计归档等，建议拆分为服务层。

## 4. 主要风险与 Bug

### P0 / 高优先级：DOCX 导出模板可读取任意本机 docx

位置：

- `apps/server/src/pages/api/documents/export.ts:812`
- `apps/server/src/pages/api/documents/export.ts:815`
- `apps/server/src/pages/api/documents/export.ts:1292`

问题：

`body.wordTemplatePath` 直接从请求体传入，`buildDocx()` 中只判断 `fs.existsSync(templatePath)`，随后 `fs.readFileSync(templatePath)` 并作为 zip/docx 返回。没有限制模板必须位于项目目录、知识库目录、生成资产目录或专门模板目录。

影响：

- 如果服务被不可信用户访问，攻击者可指定本机任意 `.docx` 路径并下载转换后的内容。
- 即使不是 docx，也会尝试 JSZip 解析，造成异常和资源消耗。

建议修复：

1. 不接受任意绝对路径。
2. 建立“模板管理目录”，模板必须先上传/登记，导出接口只接受模板 ID。
3. 最低限度也应做：
   - `path.resolve(templatePath)`。
   - 限制在允许根目录内。
   - 限制扩展名为 `.docx`。
   - 限制文件大小。
   - 解析失败返回通用错误，不暴露本机路径。

建议测试：

- 传入 `/etc/passwd` 或任意非 docx 文件应返回 400。
- 传入知识库外 docx 应返回 403。
- 传入已登记模板 ID 能正常导出。

### P0 / 高优先级：知识库文件详情 fallback 存在路径穿越风险

位置：

- `apps/server/src/pages/api/kb/files/detail.ts:23`
- `apps/server/src/pages/api/kb/files/detail.ts:25`
- `apps/server/src/pages/api/kb/files/detail.ts:26`
- `apps/server/src/pages/api/kb/files/detail.ts:30`

问题：

`fallbackFileDetail()` 使用：

```ts
const absolutePath = path.join(kbRoot, relativePath);
if (!absolutePath.startsWith(kbRoot) || !fs.existsSync(absolutePath) ...)
```

这里没有 `path.resolve()` 后再做 `path.relative()` 判定。`path.join(kbRoot, '../...')` 生成的字符串仍可能以 `kbRoot` 开头，但文件系统访问会解析 `..`，从而逃出知识库目录。

影响：

- 当 `project.getFileDetail(relativePath)` 找不到索引记录时，会进入 fallback。
- 若服务暴露给不可信访问者，可能读取知识库外的文本文件作为预览内容返回。

建议修复：

1. 抽出统一 helper，例如：

```ts
function resolveInside(root: string, input: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, input);
  const rel = path.relative(resolvedRoot, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('invalid path');
  return resolved;
}
```

2. `fallbackFileDetail()` 必须使用该 helper。
3. 对 fallback 预览加大小限制，避免一次性读入大文件。

### P0 / 高优先级：打开文件 API 的 fallback 路径未校验

位置：

- `apps/server/src/pages/api/kb/files/open.ts:27`
- `apps/server/src/pages/api/kb/files/open.ts:30`
- `apps/server/src/pages/api/kb/files/open.ts:33`

问题：

当索引详情不存在时，代码直接：

```ts
const fallbackPath = path.join(getProjectKbRoot(projectRoot), relativePath);
...
openPath(targetPath).unref();
```

没有确保 fallbackPath 仍在知识库根目录内。

影响：

- 本机控制台场景下，“打开路径”是有用能力。
- 但如果接口被不可信请求触发，攻击者可能诱导服务端打开知识库外路径。

建议修复：

- 与文件详情接口共用 `resolveInside()`。
- 对 `target` 做白名单。
- 对不存在索引记录的文件，建议只允许打开 `listKnowledgeFiles(projectRoot)` 能列出的路径。

### P1 / 中高优先级：`projectRoot` 广泛由客户端传入且未统一校验

位置示例：

- `apps/server/src/pages/api/documents/export.ts:1231`
- `apps/server/src/pages/api/documents/generated/index.ts:13`
- `apps/server/src/pages/api/kb/files/index.ts:8`
- `apps/server/src/pages/api/kb/files/detail.ts:64`
- `apps/server/src/pages/api/kb/upload/index.ts:92`

问题：

大量 API 接收 `query.projectRoot` 或 `body.projectRoot`，然后直接用于 `getProject(projectRoot)`、`getProjectKbRoot(projectRoot)`、生成文档目录哈希等。

这在“本地单用户工具”里可以接受，但缺少统一边界声明和校验实现。`kbService.ts` 里已经有 `resolveProjectRoot()`，但 API 使用并不一致。

影响：

- 多人共用时，一个用户可能通过 projectRoot 访问/操作另一个项目的数据。
- 暴露到网络时，攻击者可让服务为任意存在路径创建项目记录、扫描目录或写入用户数据目录。

建议修复：

1. 建立 `requireProjectRoot(req)` helper，统一处理：
   - 默认项目。
   - 已登记项目。
   - 禁止内部残留目录。
   - 是否允许未登记路径。
2. 生产模式下建议只允许已登记项目。
3. UI 需要新增项目时走单独“打开项目/登记项目”接口。

### P1 / 中高优先级：生成资产路径允许绝对路径

位置：

- `apps/server/src/services/document-core/generatedDocumentService.ts:323`
- `apps/server/src/services/document-core/generatedDocumentService.ts:325`
- `apps/server/src/pages/api/assets/generated/preview.ts:31`
- `apps/server/src/pages/api/assets/generated/index.ts:33`

问题：

`generatedAssetAbsolutePath()` 中：

```ts
if (path.isAbsolute(asset.path)) return asset.path;
```

后续 preview 会读取该路径并检查是否为图片；open 接口会打开该路径。

影响：

- 如果 `assets.json` 被污染，或生成流程写入了非预期绝对路径，预览/打开接口会访问知识库或生成资产之外的本机路径。
- 当前测试还明确把“绝对路径原样返回”作为预期，这说明这是刻意行为，但需要重新评估安全边界。

建议修复：

- 生成资产只允许两类路径：
  - `generatedDocuments/assets/...`
  - 知识库相对路径
- 禁止绝对路径，或仅在开发模式允许。
- `deleteGeneratedAsset()` 中的 `absolutePath.startsWith(generatedRoot(projectRoot))` 也应改成 `path.relative()` 判定。

### P1 / 中优先级：上传/预览/导出存在资源消耗风险

位置示例：

- `apps/server/src/pages/api/kb/upload/index.ts:38`
- `apps/server/src/pages/api/kb/files/detail.ts:30`
- `apps/server/src/pages/api/kb/files/preview-pdf-page.ts:23`
- `apps/server/src/pages/api/documents/export.ts:149`
- `apps/server/src/pages/api/documents/export.ts:1292`

问题：

- 上传默认 `CUSTOMIZE_KB_UPLOAD_MAX_BYTES` 为 4GB。
- fallback 详情预览对非图片文件直接 `readFileSync(file, 'utf-8')`。
- PDF 预览直接 `readFileSync(detail.absolutePath)`。
- 导出图片内联虽然有单图/总量限制，但部分路径仍先 stat/read。

影响：

- 大文件可能导致 server 阻塞或内存飙升。
- 多个并发请求可能放大 DoS 风险。

建议修复：

- 文件预览只读取前 N KB，并返回 `truncated: true`。
- PDF 预览加文件大小限制和页码上限。
- 上传大小默认改为较保守值，例如 512MB，并允许配置放大。
- 大文件操作优先用 stream。

### P2 / 中优先级：API 错误处理不统一且可能泄露内部错误

位置：

- `apps/server/src/services/common/apiErrorBoundary.ts:14`
- 多个 API 未使用 `withApiErrorBoundary`，例如 `assets/generated/*`、`kb/upload/*`、`kb/files/detail.ts`、`prompt.ts` 等。

问题：

`withApiErrorBoundary` 会把 `error.message` 返回给客户端；部分手写 `catch` 也返回原始 message。错误 message 可能包含本机路径、外部服务返回、配置细节。

建议修复：

- API 响应统一为 `{ error, message?, requestId? }`。
- 默认不返回原始错误；仅 debug/dev 模式返回。
- 所有 API 接入统一错误边界。
- 错误日志内部记录完整堆栈。

### P2 / 中优先级：构建忽略 ESLint

位置：

- `apps/server/next.config.ts:20`
- `apps/server/next.config.ts:21`

问题：

`ignoreDuringBuilds: true` 会让 lint 问题不阻断生产构建。当前 lint 通过，所以不是现存故障，但后续容易让问题进入包产物。

建议修复：

- CI 中强制执行 `pnpm --filter @customize-agent/server lint`。
- 如果发布流程已经保证 lint，可以保留；否则建议关闭 `ignoreDuringBuilds`。

### P2 / 中优先级：超大业务文件影响长期维护

热点文件：

- `apps/server/src/services/document-workflow/integrity/detectors/detectors.ts`：4704 行。
- `apps/server/src/services/document-workflow/qualityValidation.ts`：3052 行。
- `apps/server/src/services/document-workflow/integrity/fixers/fixers.ts`：2298 行。
- `apps/server/src/pages/api/documents/export.ts`：1325 行。
- `apps/server/src/pages/documents/index.tsx`：1604 行。

影响：

- 新增规则时容易误伤旧逻辑。
- 单测虽然多，但人脑定位成本高。
- API handler 混入大量渲染逻辑，不利于复用和测试。

建议拆分：

- `document-workflow/integrity/detectors/` 按问题域拆为多个 detector 文件。
- `export.ts` 拆为：
  - `exportMarkdownService`
  - `docxExportService`
  - `pdfExportService`
  - `exportGateService`
  - `exportAuditService`
- 页面 `documents/index.tsx` 拆组件和 hooks。

## 5. 细节观察

### 5.1 知识库上传路径主链路是安全的

`packages/knowledge/src/core/knowledge-base-manager.ts` 中上传路径通过：

- `getUploadRelativePath()`
- `validateUploadRelativePath()`
- `resolveKbRelativePath()`

校验并限制在知识库根目录内。这部分比 API fallback 分支更安全。建议不要在 API 层自行拼路径，应复用同一套路径解析规则。

### 5.2 文档生成状态管理较成熟

`generatedDocumentService.ts` 有：

- queued/generating/completed/warning/failed/aborted 状态。
- heartbeat/stale 判定。
- 原子写 JSON。
- 生成队列并发控制。
- 断点续跑和 checkpoint。

这部分是项目的强项。后续优化重点不是重写，而是给关键状态迁移补更多测试。

### 5.3 导出层已有“门禁阻断”的正确意识

`documents/export.ts` 中已恢复导出门禁阻断，且注释写清了历史问题。这是正确方向。建议继续把“门禁结论单源化”推进到 UI，避免前端绕过。

## 6. 建议修复路线

### 第一阶段：安全边界修复（优先）

1. 新增统一路径工具：
   - `resolveInside(root, relativePath)`
   - `assertSafeProjectRoot(projectRoot)`
   - `resolveKbFilePath(projectRoot, relativePath)`

2. 替换以下接口中的手写路径拼接：
   - `kb/files/detail.ts`
   - `kb/files/open.ts`
   - `assets/generated/preview.ts`
   - `assets/generated/index.ts`
   - `documents/export.ts` 的 `wordTemplatePath`

3. 禁止绝对 asset path。

4. DOCX 模板改为模板 ID，不再传本机路径。

### 第二阶段：API 一致性

1. 所有 API 接入 `withApiErrorBoundary`。
2. 统一错误响应，不默认暴露原始错误 message。
3. 统一 `projectRoot` 解析策略。
4. 给请求体加最小 schema 校验，可用轻量手写或引入 zod。

### 第三阶段：稳定性与性能

1. 文件预览、PDF 预览、DOCX 模板加大小限制。
2. 大文件读取改 stream。
3. 给长耗时 API 加超时/取消控制。
4. 增加操作日志与 requestId 串联。

### 第四阶段：维护性拆分

1. 拆 `export.ts`。
2. 拆 detector/fixer。
3. 页面按 hooks/components 分解。
4. 针对规则型模块建立“规则注册表 + 独立测试 fixture”。

## 7. 建议补充测试

高价值测试清单：

1. `kb/files/detail`：
   - `relativePath=../outside.txt` 应返回 400/404，不能读取知识库外文件。

2. `kb/files/open`：
   - fallback 路径穿越应被拒绝。
   - 只能打开知识库内已登记或已扫描文件。

3. `documents/export`：
   - `wordTemplatePath` 指向项目外应返回 403。
   - 非 docx 应返回 400。
   - 超大模板应返回 413。

4. `generatedAssetAbsolutePath`：
   - 绝对路径应被拒绝或返回 null。
   - `generatedDocuments/assets/../x` 应被拒绝。

5. API 错误边界：
   - 生产模式不泄露内部错误 message。
   - 返回 requestId 且日志存在。

## 8. 总体评分

| 维度 | 评分 | 说明 |
| --- | --- | --- |
| 功能完整度 | 8/10 | 知识库、文档生成、导出链路完整 |
| 类型与静态质量 | 8/10 | strict TS + lint/typecheck 通过 |
| 测试覆盖 | 7/10 | 服务层测试多，但 API 安全边界缺口明显 |
| 安全性 | 5/10 | 本地可信场景可用，不适合直接暴露网络 |
| 可维护性 | 6/10 | 业务能力强，但文件过大、职责偏重 |
| 运行稳定性 | 7/10 | 长任务机制成熟，但大文件/同步 IO 风险仍在 |

## 9. 最终建议

短期不要把该 server 当作公网 Web 服务部署。它当前更像“本机可信控制台”，应绑定 `127.0.0.1`，避免被不可信网络访问。

如果要继续产品化，建议优先完成：

1. 统一路径安全 helper。
2. 修复 DOCX 模板任意路径读取。
3. 收紧 `projectRoot` 的来源与允许范围。
4. 禁止生成资产绝对路径。
5. 给以上问题补 API 层回归测试。

这几项修完后，项目的风险面会明显下降，后续再处理模块拆分和性能优化会更稳。
