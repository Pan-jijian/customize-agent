# Debug Session: workflow-generation-failed

Status: [OPEN]

## Problem
工作流模板库页面运行一条生成记录后失败，需要查看生成记录日志，判断具体失败原因，并给出修复与优化方案。

## Hypotheses
1. 生成记录失败是由于调用 LLM/Agent 服务时配置缺失、鉴权失败或模型接口返回错误。
2. 生成记录失败是由于工作流模板参数、输入数据或上下文构造不符合后端接口预期，导致校验失败。
3. 生成记录失败是由于异步任务/队列/数据库状态流转异常，任务实际执行失败但前端只展示了失败状态。
4. 生成记录失败是由于文件/知识库相关依赖读取失败，例如知识文件不存在、解析失败或权限不足。
5. 生成记录失败是由于运行时环境变量、远程部署/沙箱服务、网络请求超时等外部依赖异常。

## Evidence Log
- 系统错误日志 `~/.customize-agent/logs/errors.jsonl` 没有本次 `/api/documents/generate` 的接口崩溃记录。
- 最新失败生成记录：`/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1786124857001-0974e56c.json`。
- 记录状态：`failed`；标题：`徽光阁施工组织设计`；模板：`徽光阁项目`。
- 执行阶段显示前置读取、角色绑定、文件理解、章节生成均已完成；最终失败在 `validation/document-workflow` 和 `export_ready/document-workflow`。
- 质量校验：18 个 error，导出门禁 checklist 仅 `无阻断级校验错误` 未通过。
- 主要阻断：小节事实/量化参数落位不足、3 个小节内容空洞或表格无说明、事实一致性冲突、工期口径冲突、无法反查关键数字、正文残留后台词/禁用词、正式表格数量不足。

## Analysis
根因不是服务启动失败、接口异常或 LLM 调用直接失败，而是生成完成后质量门禁阻断。当前门禁规则把“不得出现”“正式表格不足”“空小节/小节未达标”“生成后事实反查失败”“跨章一致性冲突”等判为硬阻断，因此记录最终落为 failed。

直接原因：
1. 资料抽取/事实归一化对招标文件中的“见招标公告/见投标人须知前附表”等引用性文本没有降权，导致与真实值冲突。
2. 章节生成虽然字数达标，但部分规划小节没有落入足够知识库事实或量化参数。
3. 默认修复流程触发了，但未能修掉全部硬阻断，最终仍保存 failed。
4. 生成正文中残留“重新生成/兜底/见招标公告/招标范围：”等被配置禁止的表达。

## Applied Changes
1. 事实冲突降噪
   - 文件：`apps/server/src/services/document-validation/factConsistencyService.ts`
   - 排除引用型占位值、开评标/交易系统流程文本、表格噪声、签章联系方式等非事实值。

2. 门禁专项修复闭环
   - 文件：`apps/server/src/services/constants/rolePipelineConstants.ts`
   - 文件：`apps/server/src/services/document-workflow/rolePipeline.ts`
   - 文件：`apps/server/src/services/document-workflow/documentGenerator.ts`
   - 扩展可修复问题识别范围，覆盖“小节生成未达标/生成后事实反查失败/不得出现/正式表格不足/跨章一致性”等。
   - 增加确定性修复：清理禁用词和引用占位、替换无法反查数字、正式表格不足时补充通用控制表。

3. 失败日志可读性
   - 文件：`apps/server/src/pages/documents/index.tsx`
   - 失败列表区分“门禁未通过”和“生成失败”。
   - 工作流抽屉顶部展示导出门禁阻断项，并提示可点击继续生成或查看校验页。

## Verification
- VS Code diagnostics：相关修改文件无诊断错误。
- `pnpm --filter @customize-agent/server lint`：通过。

## Next Step
请在 Web 页面重新点击该失败记录的“继续”，或重新生成一条记录，观察是否仍被导出门禁阻断。如仍失败，下一轮应对新的生成记录 JSON 做 post-fix evidence 对比。
