---
"@customize-agent/server": patch
---

语义管线重构（四期落地）：
- 证据承接语义化：evaluationTexts 条目对象化供给、承接判定改 bge-small 余弦相似度（删除二字滑窗与停用词表）、小节检索打开 reranker + 语义排序、selectEvidenceByBudget 语义排序取 top-k + 预算兜底、后置校验评分条目关键词命中兜底
- LLM 输出 schema 化：callDocumentLlmJson 接入 JSON Schema 校验（失败可诊断截断位置/缺失字段）、规划失败降级为块级重试而非原样重试同规模任务、空响应重试提示词追加缩短思考收敛
- 任务小步化：chapter-plan 改逐主题块小步规划（语义聚类出块候选 + 每块 ≤2000 token 小调用 + 块间并发 + 块级失败隔离）、块成稿输出预算按目标字数 1:1.2 设置且不走思考放大、块级 checkpoint 快照写盘、章间流水保留
- 预算可观测化：新增预算裁剪报告 stage 与后台诊断 schemaFailures 统计、清理失效软限制
