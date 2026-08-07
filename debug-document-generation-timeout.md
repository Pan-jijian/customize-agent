# Debug Session: document-generation-timeout

Status: [OPEN]

## Symptom
用户反馈 Web 服务已启动，刚跑了一条文档生成记录，耗费将近半小时且文档生成未完成。

## Constraints
- Steps 1-4 不修改业务逻辑。
- 优先分析现有运行日志、任务状态和持久化记录。
- 如现有证据不足，第一处代码变更只能是 instrumentation 日志上报。

## Hypotheses
1. 生成卡在章节并发/修复循环，某个 LLM 调用长时间未返回或反复超时。
2. 文档质量增强后 validation/repair 触发过多，导致多轮补写与最终修复耗时异常。
3. 知识库检索/文件理解/事实抽取耗时过高，生成前阶段已消耗大量时间。
4. 生成任务状态已失败或被阻塞，但前端轮询未正确展示完成/失败状态。
5. 新增质量报告/事实追踪逻辑在大文档/大量事实下计算量异常。

## Evidence Log
- `/api/jobs?active=1` 返回 `jobs: []`，说明当前没有仍在运行的生成任务。
- 最近任务 `task-1786107764777-2824360d`：`status=warning`、`stage=done`、`percent=100`、耗时 1619 秒。
- 任务失败消息：`OUTLINE 指定 3 章，实际只生成 2 章：工程重点难点及危大工程的保障体系 大模型未返回有效章节正文`。
- 任务详情：第一章进入 `已压缩证据与上下文后重新请求模型生成` 后仍无有效正文；第二章耗时 1146 秒；第三章耗时 1498 秒。
- 代码证据：`documentGenerator.ts` 当前章节流程为小节并发首轮 -> 整章 fallback -> compact fallback；每章 fallback timeout 可到 300000ms，compact 继续按 `timeoutMsForChapter(targetWords)`。

## Findings
- H1 confirmed：主要卡点在章节 LLM 生成与 fallback 重试，第一章多轮空返回导致最终只生成 2/3 章。
- H2 partially confirmed：事实密度/小节风险很多，但不是最终半小时未完成的首要原因；它会扩大扩写和质量提示成本。
- H3 rejected for this case：知识库检索准备阶段很快完成，日志没有显示检索长耗时。
- H4 confirmed in UX sense：后端任务已结束为 warning，但用户看到的是“文档生成未完成”，属于失败/警告状态表达不清。
- H5 rejected for this case：新增质量报告阶段未进入，卡点发生在章节生成阶段。

## Fix Applied
- `chapterGeneration.ts`: `allowPartialResult=true` 时，只要小节并发已有部分成功结果，就立即返回可审查章节；失败小节保留明确“未达标需重新生成”标记，交给质量门禁阻断，不再整章空等。
- `chapterGeneration.ts`: 缩短章节 LLM 超时梯度，避免单章长时间卡住。
- `documentGenerator.ts`: fallback 目标从 75% 降到 55%，上限 6000；compact retry 上限 3600，timeout 上限 150s。
- `documentGenerator.ts`: 增加 debug server 上报 `chapter-generation-start`，用于复测时记录每章 target/timeout/fallback 配置。

## Verification
- VS Code diagnostics: pass.
- `pnpm --filter @customize-agent/server lint`: pass.
- `pnpm --filter @customize-agent/server build`: pass.
- Debug server health: ok.
- Post-fix attempt `task-1786110331664-bf4db66d` showed remaining issue: service still entered `小节并发未完整返回，改用整章重试生成` and then `正在压缩上下文后重试生成`.
- Debug logs confirmed `sectionFirstTimeoutMs=180000` while section batch can internally need more time, so outer timeout returned `null` before partial section content could be returned.

## Follow-up Fix
- `documentGenerator.ts`: 小节优先模式下，外层 timeout 改为内部章节小节总控 timeout + 30s buffer，避免提前截断部分结果。
- `documentGenerator.ts`: 小节优先模式下若仍无结果，直接标记章节阻断并跳过整章重试，不再进入整章 fallback/compact fallback。
- `chapterGeneration.ts`: `allowPartialResult` 时首轮结束即返回章节内容，未成功小节用未达标标记进入质量门禁，不再进入小节重试瀑布。
- Follow-up verification: diagnostics/lint/build all pass.

## Next Step
- 当前正在跑的任务已进入旧代码 compact retry，建议中止该任务，重启服务后重新生成同一记录，再收集 post-fix2 日志。
