---
'@customize-agent/server': minor
---

s1-slim 生成链路瘦身批次（单块输入 ≤4 万字符达标 + schema 失败归因 + 并发复核 + 撞名/全维度评审治理）：

- 块级上下文瘦身（方案 2.3）：蓝图参数桶按块内 token 条目级筛选 + 字符封顶（施工机具 9000 / 材料 7000）；章级切片改块级切片（只展开块相关工作包，默认封顶 6000）；事实覆盖段 cap 26000→6000、章材料池 8000→5000；探针实测单块确定性分项合计 35275 字符（验收线 40000；参数桶 36413→2412、切片 103488→5856）
- 事实覆盖段段序重排：参数密度硬依赖段（材料规格-部位对照 / 精确参数 / 未确认需求 / 模板缺项）前置入截断保护区；长文本全量事实索引降至截断牺牲区（绑定材料证据可兜底）
- schema 失败治理：callBreakdown 按 prefixKey 归因 schemaFailures（重试 3 次全失败时逐类定位），进度页摘要/详情展示「（schema失败N）/ schema 失败 N 次」；重试链路复核（3 次尝试 + 失败原因回注 + 截断类 maxTokens ×1.5 放大 + 截断 JSON 确定性修复）；最近真实运行 schema 失败率 3.2%~7.4%（旧基线 22%）
- 撞名治理：移除「撞名整章重规划」，降为局部候选名替换（一次轻量改名调用 maxTokens 600，仅本章小节清单 + 撞名对照，确定性校验后替换）
- 移除全维度评审：qingtianReview / fullDimensionReview / qingtianReviewSpec / crossChapterDataScan 链路全量删除（源码 + 测试 7 文件 + DOCUMENT_QINGTIAN_REVIEW_ROUNDS env 注册项），独有检出项已逐项对照注册表确认无缺口
- 死字段清理：blueprintDataText 链路移除（stageBlueprint 赋值 / generationSession 声明 / documentGenerator 初始化），章切片渲染改由块级聚焦承接
- 并发复核：块级并发 ≥8 达标（llm 并发无上限 + 首块串行预热 + 分批全并发；实测峰值 36）
