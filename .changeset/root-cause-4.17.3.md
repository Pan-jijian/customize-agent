---
'@customize-agent/server': patch
---

fix(document-workflow): 跨项目污染与修复节点 failed 根因根治（4.17.3）——① 提示词示例数值泄漏实锤：markdownComposer FORMAL_WRITING_RULES 与 overviewRecapIssues/basicInfoScheduleFieldIssues/开挖深度等修复指令中的示例数值（45日历天/4368m²/540日历天/5.85m）被 LLM 当项目事实照抄进正文，庐江与合肥师范两个不同项目同时出现 45 即此根因（非缓存、非召回串染），全部示例改为中性表述；② 修复节点持续 error 三个机制性根因：修复指令 suggestion 携带示例数值→Repairer 照抄→复检残留→failed 恶性循环（①根治）；scheduleDays 锚点正/反向模式字符类排除竖线导致表格行「| 计划工期 | 210日历天 |」永不入池、两套工期体系各带表格时确定性修复零产出（新增表格行模式补盲）；applySpanReplacements 重叠 span 二次替换产生 45→2100 错位（重写为升序单次遍历跳过重叠）；③ 修复侧权威口径升级：extractScheduleAuthority 从 factsModel 计划工期事实卡提取权威值，外部锁定口径 > 表格唯一值，applyNumericConsistencyDeterministicFixes 新增 scheduleAuthority 选项并接入 documentPipeline/globalQualityGates 全部修复轮；④ 召回侧多项目指纹阻断：resolveAgentMaterialScope 在需求匹配与模板绑定两个锁定分支检测 ≥2 个不同项目编号即阻断生成（同项目多文件按 Set 去重不误伤）。
