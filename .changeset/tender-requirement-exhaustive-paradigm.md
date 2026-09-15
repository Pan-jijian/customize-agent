---
"@customize-agent/server": minor
---

4.39.0 招标要求全量条款穷举范式 + 一体化蓝图唯一权威分发（终极方案）：

- 提取范式重构（tenderRequirements）：旧 10 字段「必提清单」归纳式提取整体删除（awardObjectives/specialQualityStandards/awardClauses/greenBuildingGrade/smartSiteGrade/assemblyRate/systematicBenchmarks/frontScheduleClauses/dateFabricationProhibited/prohibitionNotes），改为全量条款穷举——绑定资料条款化（确定性结构切分，不预筛不剔除任何单元）→ 逐条判定（LLM 批量 + 序号严格对齐，每条必出判定）→ 三态归宿（entries 要写的 / excluded 不要的（non_requirement 目录导语 / out_of_scope 投标程序资格评标规则 / no_value 条款值为无 / duplicate 重复合并四类原因逐条留痕）/ 重复合并）→ 提取对账闭合（条款总数 = entries + excluded + merged + undecided，未判定必须为 0）；对账未闭合时缓存不落盘并显式告警；磁盘缓存 v4（对账闭合门禁 + 全内容指纹哈希）；旧预筛/窄通道召回/字段补提/复核通道/条目上限全删除
- 条目模型（TenderRequirementEntry）：text 忠实引用条款原文、coreTerms 命中检测核心词、sources 多来源聚合（招标/补疑重复出现合并不丢来源）、category（招标语义自命名类别）、policy 三态（respond=正文显性响应 / comply=遵守类（工期基准/禁编日期等，不逐条抄写但不得违背）/ qualitative=商务定性（保证金/付款/结算等按合同约定定性响应，不落商务数字参数））、global 全文档性约束同步进入全局写作口径区
- 蓝图统一分配（唯一权威源与唯一分发器）：阶段 3 蓝图构建时 assignTenderRequirementsToChapters 为每条要求分配唯一主责章（argmax 语义路由 + 低置信标记 <0.45 供审计，未分配恒为 0），分配对账 assignments.length === entries.length 不成立即抛错，落盘 requirement-assignments.json 审计资产；章级写作注入改用分配切片（renderChapterRequirementSlice），旧 requirementsRoutes 路由与前附表响应清单注入整链删除
- 章级验收（修复前移）：章收口前对本章责任要求逐条核验（判定=修复同源 clauseSatisfied 三通道：锚点全覆盖 / 条款原文分句全落位 / 投标人口吻转换后分句全落位），零响应/部分响应在章内即时确定性补写（终局补写器降级为安全网，消费同一份分配）；「或/及/任选其一」锚点关系批量判定防误报；商务条款走 15 分支定性响应句表（关键词+按合同约定窗口判定，检测/补写/清洗三端同源）
- 终局全量对账：documentFinalValidation 的 requirements-coverage 检测器换装 requirementAcceptanceIssues（全部条目对账，按 policy 分流：respond 语义+锚点三通道 / qualitative 定性响应句存在性 / comply 数据一致性域核验）；奖项白名单源（fabricatedAwardIssues）改用 entries 条款原文
- 消费链随动：stageUnderstanding 提取链删除预筛与窄通道（直读全量切片即提取输入）；stageOutlinePlanning 删除路由与 writingTaskBrief 前附表行；generationSession/finalizeSession/documentGenerator/rebuildAndRecompute 全链传递 requirementAssignments；factsModel.tenderRequirements 字段与装配率权威的备用分支删除
- 未使用符号全量清零：全仓 tsc --noUnusedLocals --noUnusedParameters 归零（212 条 finding 全量处置）——死导入（documentPipeline 单文件 -56 行）、死函数、死参数签名收口（bodyTableDismantleIssue/parseMajorConstructionPackages/boqRowTraceIssues/fallbackWorkPackagesFromExisting/specificityScore/pushReplacement 等）、死状态链（models 页面 webAccess 整条路径）删除及全部调用点（src + 测试）同步适配，无兼容兜底层；废弃诊断测试 fl-diag6b.test.ts 删除
- 验证：tsc 零错误、全量 13017 用例通过（258 文件，1 skipped）
