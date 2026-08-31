---
"@customize-agent/server": patch
---

修复真实生成暴露的三大 P0 质量问题：目录畸形条目（tenderClauseFragment 标题过滤增补三类模式）、数据一致性盲区（总量上限 vs 分阶段峰值矛盾检测）、上下文矛盾/指令泄漏（口径与落位锚点扩充 + 泄漏句清洗 + 修复 prompt 措辞）。同时落地二三四期优化：评审轮 patch 前置校验与跨系统缺陷去重（observe 阶段）、bge 嵌入全局 LRU 缓存、上下文分层统计 L0-L3、消除 projectUnderstanding.prompt 双份注入、scoped 上下文专用紧凑化、Writer system 前缀统一、小节量化参数落位清单注入（零 LLM）、确定性一致性修复收敛（3 处→2 处）。
