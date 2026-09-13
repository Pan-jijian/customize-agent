---
"@customize-agent/server": minor
---

批 1：导出纯渲染化与数值守恒（A1/A2）+ 规格书写统一与源层卫生（A4/A5）+ 六类数值对账（D4）+ 挂起清单（C1）+ 数值裁决持久化（D3）

- A1 导出纯渲染化：导出链移除三把内容改写刀（normalizeLooseMarkdownTables / normalizeParagraphs / normalizeExportUnits）与 defaultTableHeaders 假表头补丁——导出=纯渲染，交付产物与源 markdown 逐字一致（导出产物与源 diff=0）。新增 DOCUMENT_EXPORT_PURE_RENDER 观测开关（off/observe/enforce，默认 observe：观测期仅计数不阻断）
- A2 守恒断言：导出链端到端「源 md vs 导出产物」守恒断言（去空白口径 diff=0）；表格行双向豁免残片删除规则（修复短表格行经标题形态判断被误判乱码、其数据行被静默删除的历史缺陷）
- A4 规格书写统一器：数字间乘号形态（x/X/*/全角ｘＸ＊，允许水平空白）交付层统一归一「×」——仅匹配左邻数字窗口（1X22/258x16/400*400/M10x100 等实测形态），字母语境 X（X射线/AX100/SX2）天然不命中
- A5 md 源层卫生：A5a 表格块与相邻内容规范为恰好一个空行（纯结构操作、幂等、不改文字）；A5b 表编号体系检查全文档级专属检测器（「表N」引用必须命中同编号表实体，引用↔实体一一对应；表编号重复/孤立引用即 blocker）
- D4 数值对账六类（事实溯源专项机制化）：合计推导 / 规格-数值绑定 / 语义槽位 / 近似口径 / 分项显式 / 名称口径——正文数值 vs 清单事实锁 + 蓝图参数桶的关系型对账（factReconciliation 单一对账源；权威缺失的规则自行跳过；检测器注册 fact-reconciliation 并接入终检）
- C1 挂起清单：门禁失败显式挂起 + 精准人工处理清单（五要素：分类/定位/问题/修复路径/检测器）；三挂载点（reviewMetadata.suspensionChecklist 归档 / agent-final-gate stage 逐条明细 / 阻断清单置顶横幅）；单源构建（finalGate 构建、全链路复用）
- D3 数值裁决结论持久化：numeric-arbiter 裁决 stage（确定性硬替换 / 误报降级 / 无锚留 LLM 三类明细可审计，替代原仅 console.log）
