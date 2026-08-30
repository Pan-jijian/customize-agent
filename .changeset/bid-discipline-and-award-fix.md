---
"@customize-agent/server": patch
"@customize-agent/knowledge": patch
---

施组技术文件评分报告（21）两项否决级/中风险问题修复闭环：

1. 「确保黄山杯」零响应回归根治：4.12.4 修复循环配额截断（others.slice(0,8)）导致评分项要求未响应 blocker 永不进入修复循环——移除截断全量参与修复；小节写作紧凑上下文（compactSectionProjectContext）增加「招标文件评分项要求」段置顶保护，评分项要求不再因 2000 字符尾部截断丢失

2. 正文禁止出现投标/评标纪律内容（商务投标函内容三明治治理）：utils 新增单一来源词表 BID_DISCIPLINE_PHRASES（11 词）与 isBidDisciplineSentence 句级判定（覆盖「纪律管理+投标活动合法合规」类无禁词词面变体，不误伤劳动纪律/施工纪律）；提取层过滤纪律条款（frontScheduleClauses/prohibitionNotes）；响应分类确定性兜底（纪律条款强制 responsive=false）；写作硬约束追加第 8 条禁写商务投标函内容；清洗层 stripBidDisciplineSentences 句级复用同口径判定；检测层 Reviewer 词表展开同口径并新增纪律语境句 blocker

3. knowledge 检索性能修复：FTS 迁移 trigram tokenizer（中文子串可命中索引），LIKE 全表兜底拆分小列/短词两组，消除大库 40 term × 7 列全表扫描阻塞事件循环数分钟的问题
