---
"@customize-agent/server": minor
"@customize-agent/knowledge": minor
---

4.51.0 招标评分达标攻坚（丰乐镇真实模板 r13→r19 连轮复审：五维加权 61→94 分、终门禁阻断 13→0）+ 资料包取数链：

**knowledge — 资料包（Material Pack）取数与检索链**

- 资料包 ID 派生 material-pack：包 ID = 知识库顶层目录名，与 material_root 列/selectedRoots 同口径（顶层散文件剔除、SQL 回填表达式统一）；切片/父块/文件全链路落 material_root 列（含一次性回填迁移标记与会话/文件记录写路径）
- 检索按资料包直接取数：ChunkSearchFilters.materialRoots（filePaths 与 materialRoots 同传时 AND 双锁）、countIndexedChunks/searchChunks 系列按包过滤（取代千级文件白名单 IN 过滤的间接取数）

**server — 评分体系达标（r14 轮，五维从 61→93）**

- 评分器块切分精度：标题边界 + 可执行块阈值校准（executability 91）
- factDistribution 扩规则：项目名称/编号/工期周期/资源配置四类事实跨章分布 + label 感知 + 噪声排除（specificity 88）
- fiveElementClosureBoost 五要素闭合块补强（措施块 岗位/时限/数值/闭环要素）
- 规范术语显性落位链尾锚句（canonicalTermAnchors）
- 事实一致性：表格派生角色排除 + 标签前缀剥离 + 粘连过滤

**server — 终门禁阻断清零（r13 11 项 + r14 3 项全量定因）**

- B1 链尾蓝图引用数值收口重放：stageFactDistribution 的 rebuildFinalMarkdown 从章 drafts 重拼会回退字符串级替换——replayBlueprintCitationNumericFixes 封装并在最后净变更点与终门禁之间重放（无蓝图/零锚/零处零成本静默，幂等）
- B2 参数概念泛量词豁免：光杆总量词（总长/全长）无对象不参与聚类（防「，总长8205.53m」与「砌筑渠道总长4800m」跨对象 bge 误聚阻断）
- B3 工伤保险表述确定性改写器：办理意外伤害保险 → 并列表述含「办理工伤保险（按建设项目参保）」；无可改写句时按工伤保险标题小节插入兜底（与检测器词面门控同源，幂等）
- 表格边界归一（相邻表插空行 + 引导句 + 同表头堆叠降维）；F14 偏差语境豁免扩围（规范偏差误报）；合计值无源删除 / 前期动作时限改写 / 清单口径词去词
- 链尾要求响应收口循环化（≤3 轮全量句集）；段落复读修复器块级同源化；工程概况复述确定性修复
- 编制依据法规漏列链尾修复轮（basisRegulationsRepair：照抄招标引用法规 + 按分部选列现行规范）；近名小节确定性合并 drafts 级兜底
- 清单分部覆盖（青砖步道/过路涵）：规划层注入 + billLock 分部保底采样 + 链尾兜底补段

**server — 生成端加固**

- 劳资小节任务卡触发词扩围（+工伤）：工伤保险参保表述写作层显性落位

**server — r15→r19 复审攻坚（丰乐镇真实模板连轮清零）**

- r15 5 项 + r16 8 项终门禁阻断清零：条约引导语/条件截断句/自卸汽车配套比/方法词表扩展/参数单位座；条件截断两轮扫描/方法框架剥离与实例豁免/复合 H4 标题归一
- 内容深度补写轮残差口径细分（r16c 实机归因：1191→1749 字真实补写被聚合条数口径误判「未下降」提前停止）：critical-section-depth 改字数缺口量化（criticalSectionDeficitTotal）、construction-org-major-content 改缺陷项数求和（majorContentDeficitCount）；关键小节深度门槛表单源化 CRITICAL_SECTION_DEPTH_RULES
- 检测器误报豁免：计划总工期管理程序时限（合理期限/书面技术要求/响应闭环）不入工期互斥池；人员证书准入校验句（「未完成前不得上岗」结构）不入自伤候选
- 写作层与词表：主要施工内容写作规则追加 2200 字目标；工序顺序词表补「X前…X后」自然成文形态；要素不全 blocker 消息携带逐块缺维明细
- r17 5 项 + r18 6 项终门禁阻断清零：无源数值组和替换（spec-quantity-binding）/设备批次值去残留数字（equipment-batch-values）；自伤程序型动作表并入「扣减」；参数单位座补 m²/m³/㎡（脚手架 76.62m² 上标截断误生口径冲突）；参数概念总量分解句豁免（总量=分项相加）；危险作业表空单元格按列就近非空填充；终检小节提取 markdown 优先（drafts 残块假阳性）；「按设计确定」概括话术硬软分层（硬词表直报、软词表仅在块内参数不足时报）
- 参数概念冲突根因闭环（r18）：PARAM_TOKEN_RE 单位交替补齐后窗口位移 +1 致 union-find 链式聚类分裂——① 责任时限框架剥离扩围（「由」可选）；② 前缀尾随数字并回（「、15cm」值误取 5 → 并回 15）

**验证**：全量 vitest 13118 用例 + typecheck + turbo build（41 chunks / 64 pages）全绿；丰乐镇真实模板 r19 生成复审实测：gate 阻断 0（passed=true）、五维加权 93.8 → overall 94（completeness 100 / specificity 83 / compliance 99 / executability 92 / normalization 94 / uniqueness 92）。
