# server

## 4.5.2

### Patch Changes

- 数据口径裁决补漏与校验基准对称：裁决分组对"总"字做归一化（招标正文"建筑面积约 4645㎡"与补疑"总建筑面积约 4646m2"必须归入同组检出，修复非对称口径跨文件漏检）；校验基准直取裁决值（裁决短串"4646m2"无口径词前缀时仍能提取数值条目）；校验侧建设规模口径词与裁决侧对称（"总"字可选并排除地上/地下分层口径）；事实提取层新增嵌入句式模式（补疑/清单等文件"总建筑面积约 4646m2"无"建设规模："标签时也能进入事实主表，触发源级冲突裁决）。

## 4.5.1

### Patch Changes

- 数据口径裁决补漏与校验基准对称：裁决分组对"总"字做归一化（招标正文"建筑面积约 4645㎡"与补疑"总建筑面积约 4646m2"必须归入同组检出，修复非对称口径跨文件漏检）；校验基准直取裁决值（裁决短串"4646m2"无口径词前缀时仍能提取数值条目）；校验侧建设规模口径词与裁决侧对称（"总"字可选并排除地上/地下分层口径）。

## 4.5.0

### Minor Changes

- 53719a6: 修复主题块成稿模式下 Reviewer 锚点错配导致的修复无效循环，并统一证据预算口径、消除导出误报：

  - 主题块成稿失败降级整章紧凑成稿时，清空主题块规划引用（plannedStructureRef/plannedPromptTextsRef/plannedCoverageRef），避免 Reviewer 用 H4 主题块锚点在按原细目组织的正文中定位失败，产生大量"未匹配到独立小节标题"误报并浪费修复轮次
  - extractSectionFuzzy 标题扫描扩展支持 H4（原仅 H2/H3）：主题块正文以 `### 主题块 + #### H4 要点` 组织，Reviewer 的 plannedCoverage 锚点是 H4 要点标题，旧实现导致锚点全部匹配失败、Repairer 修复无效循环
  - 证据池截断排序统一为 evidencePromptImportance 口径（量化值 +8、项目基础事实 +10、requiredFacts +6、标准编号 +3），避免量化关键事实与模板要求事实在 maxItems 截断时被高分泛化块挤出证据池
  - 整章写作注入预算与 generationBudget 证据区间（7k-26k 档）对齐，不再使用默认 8k-36k 的脱节预算
  - 主题块写手第二轮重试反馈针对性列出缺失 H4 要点标题，减少无差别重试失败后被迫拆半或整章降级的 LLM 调用浪费
  - 资料来源罗列话术检查跳过表格行：表格"执行标准"列中的"设计图纸、规范"等合法表内容不再被 Final Gate 误判阻断导出
  - 跨章工期一致性检查剥离表格行并排除"XX 日历天内"时限表达：进度计划表分项持续时间（"第 1 日~第 7 日 7 日历天"）不再被误判为与资料 45 日历天冲突
  - 生成后事实反查跳过表格行数值并将日期 token 归为 soft：机械配置表"第 24~34 天"、计划节点数不再被误判为总量口径数字阻断导出
  - 写作安全规则新增禁止编造具体日期：开工/竣工日期仅在资料提供时才可写入，否则用相对工期（"第 1 日~第 7 日"）表达

- 53719a6: 源级数据口径裁决前置到写作上下文与校验基准，评标必查小节保真，章节生成全并发：

  - 裁决前置到证据切片：补疑/澄清修正后的胜出数值在证据进入写作 LLM 前完成替换，模型不再照抄资料原文旧值（历史缺陷：第 3 章 checkpoint 混用招标正文 4645㎡ 与补疑 4646㎡，只能靠事后全局审查修复）
  - 每章写作 roleContext 注入「数据口径强制约束」锚点，明示补疑修正值与禁止出现的败选数值；新增「数据口径裁决」执行节点向用户展示裁决来源与取值
  - 跨章一致性校验基准与生成裁决同源：建设规模/估算价/工期的期望口径优先取裁决胜出值，避免主表候选排序差异导致误报或漏报
  - 评标必查细目保真：含主要施工内容/工程概况/重点难点/危大工程/应急预案/施工部署/总平面等关键词的输入细目必须保留为独立小节，不得被主题块聚类合并吞并（历史缺陷：「项目主要施工内容」被并入「项目概况与施工内容综述」）
  - 主题块结构粒度动态化：块数下限与 H4 总数按细目数量与必查细目占比动态计算，必查细目不计入压缩预算
  - 章节生成并发不设档位上限：全部章节同批并行启动，在飞调用总量由全局 LLM 并发档位统一约束，审查流水线并发独立缩放；执行节点与生成前体检文案同步更新

## 4.4.0

### Minor Changes

- 文档生成稳定性专项修复（P0-P4）：

  - **P0 证据注入重构**：预算从 6K/18K 提升至 8K/36K（每目标字 12 字符证据，env `DOCUMENT_EVIDENCE_BUDGET_CEILING` 可调）；排序改为事实覆盖驱动（量化参数/项目基础事实/requiredFacts 命中加权），移除 byFile top-1 启发式，单文件上限放宽至 6 条；文本证据保留结构化换行，单条 1200 字符截断标注。
  - **P1 两步生成**：整章一次成稿先由事实规划阶段产出事实大纲 JSON（校验失败退化为单步生成，非模板兜底），Writer 按大纲逐条落位；env `DOCUMENT_TWO_STEP_GENERATION=0` 可关闭。
  - **P2 表格分块行原子性**：超预算表块按行边界拆分并保留表头，数据行不再被窗口硬切；修复共享表头前缀导致的分片偏移计算错误。
  - **P3 提示词事实源**：用户提示词中的事实性表述（工期/规模/质量标准等）提取为最高优先级事实注入；大纲阶段与写作阶段的角色指令分阶段注入。
  - **P4 missingFacts 定向补充检索硬回路**：大纲报告材料缺失事实后自动触发定向补检，命中材料并入证据池并重渲染大纲，覆盖判断基于合并后证据池避免误标。

### Patch Changes

- Updated dependencies
  - @customize-agent/knowledge@4.1.0

## 4.3.1

### Patch Changes

- f4781ee: 文档生成稳定性优化：章级规划驱动管线（Planner 读项目图谱与文档蓝图，重排主题块并语义合并相邻细目，治理目录碎片化）；按文档规模自适应提升全局 LLM 并发上限（8/16/24/32 档）；招标结构生成前审计（评分条目承接校验）；表格计划执行与生成诊断细化。
- Updated dependencies [f4781ee]
  - @customize-agent/knowledge@4.0.44

## 4.3.0

### Minor Changes

- 文档生成治本重构：新增章级 Planner 与块级并发写手，从根源解耦「LLM 调用数 = 输入细目数」，超大显式小节章（30+ 小节）不再逐小节碎片化成稿。

  - 新增章级 Planner（chapterPlanner）：把数十条输入细目聚类为目录级主题块 + H4 要点 + 专属事实分配，代码侧确定性校验 100% 细目覆盖；LLM 规划失败或细目过少时由确定性语义域分组在同一管线内接管，永不回退逐小节路径
  - 新增块级写手（buildPlannedChapterContent）：每主题块一次 LLM 调用（1200~2200 字/块），块间全并发推进；H4 锚点完整性 + 字数下限质检，失败整块重试并支持拆半自愈（仍在块级管线内）
  - 调度接入：useSectionGroup 分支切换为 Planner → 块级并发链路，移除语义组与逐小节回退，失败降级为整章单次生成
  - 并发预算：超大显式小节章章节并发由 2 放宽到 3，允许大章与中小章并行消除长尾
  - 修复：表格载体小节（计划/进度/节点类）含完整数据表时不再被「只有标题或表格无正文」导出门禁误阻断，并在表格计划提示词中强制每表前写引导叙述

- 文档生成性能与数据一致性增强：

  - 并发自适应：全局 LLM 并发按文档规模分档（8/16/24/32），大章节章并发放宽为 2，组间/组内任务并发与修复并发分层提升，深层章节写入任务并行化
  - 源级同口径数值冲突裁决：跨资料文件的建设规模/估算价/工期数值冲突在生成前按资料来源优先级自动裁决（补疑>合同>招标文件>清单>图纸），裁决口径注入文档蓝图并回写事实主表，正文中败选数值确定性统一为裁决值，杜绝 4645㎡/4646㎡ 类并存
  - 数值一致性校验收紧：跨章扫描单位归一化（m2/㎡/m²/平方米同口径），冲突阈值降为出现 1 次即报错并进入修复链，导出门禁新增数值一致性检查项且对跨章一致性冲突硬阻断
  - 全局一致性审查修复闭环：审查发现冲突后先定向修复并复检（最多 2 轮），仍有残留才升级为导出门禁阻断，避免带病导出
  - 工序规格冲突扫描：正文结构层配比/厚度与资料口径不一致时确定性拦截（error 级）
  - 事实字段形态校验：项目编号等字段拒绝带量纲错位值，避免解析错位进入事实主表
  - 全局一致性审查数值清单化：跨章审查输入改为确定性数值清单，问题升级为 error 并强制修复

## 4.2.8

### Patch Changes

- 修复 dev 模式下多路由 chunk 复制模块实例导致任务注册表与进程启动时刻不共享的问题：生成任务注册表挂到 globalThis 跨 chunk 共享，stale 判定增加宽限期豁免，避免首次运行模板的生成任务被轮询接口误判为“生成任务已中断”而直接失败

## 4.2.7

### Patch Changes

- 修复"项目主要施工内容"小节缺失根因：结构门禁增加确定性工作包标签修复与降级验收，Final Gate 扩展缺失小节解析与章节定位兜底，深度验收线与门禁口径统一；清除特定项目硬编码残留

## 4.2.6

### Patch Changes

- 生成链路性能优化（P0/P1 十一项）与参数抽查门禁口径对齐修复：小节检索缓存与短路、确定性兜底改造、量化参数正则统一、深召回合并、基础事实跨章缓存、证据内存节流、SQLite WAL 加固、失败 streak 隔离、参数抽查池对齐章节证据窗口（消除抽样随机性导致的评分漂移）。
- Updated dependencies
  - @customize-agent/knowledge@4.0.43

## 4.2.5

### Patch Changes

- 真实生成（real-gen-20）对比参考施组后修复“项目主要施工内容”节三大问题：

  - 同一工作包被 LLM 按“X 工程”“X 工作包”两种口径重复展开两遍：新增 mergeDuplicateWorkPackageSubsections 确定性后处理——中文 bigram + 停用词过滤三段式语义匹配，把“X 工作包”小节独有的量化参数句（改造面积 4368m2、灰缝饱满度 80%、箱体距地 1.5m 等）并入匹配的“X 工程”小节并删除重复小节，无匹配小节保留并重排编号；LLM 写作指令同步加“每个工作包只展开一次”硬约束
  - 施工方法回避具体数值（“分层厚度按压实设备效能控制”式模糊表述）：新增土方回填工艺知识卡（每层虚铺厚度 ≤300mm、含水率 ±2%、压实系数 ≥0.94 等通用规范参数），并在写作指令中要求每个工作包施工方法落位至少 3 个具体工艺参数
  - 新增 workPackageDedup 真实脏数据回归测试（3 项，含 run-20 双格式重复节）

## 4.2.4

### Patch Changes

- 真实生成（real-gen-19）对比参考施组后，把脏数据清洗上移到情报源头，覆盖 LLM 成稿路径：

  - 结构化数据构建（projectIntelligence addWork）：施工流程只用 LLM 方法步骤，不再用清单条目名前缀拼工序（消除“→ 配电箱”式残尾）；工程量以资源“名称：数量”格式优先，包含已列资源名的清单条目式事实不再重复保留；验收条目必须含真实验收/检测术语（消除门窗五金串入结构加固验收的串台）
  - 提示词层统一清洗（constructionOrganizationPrompt）：工程量多格式条目去重（dedupeQuantityFacts 升级为“型号串/数量标识+首词相同”识别，支持词序不同的“名称：数量”“名称 参数 数量”“名称｜规格”三格式合并）、流程剔除设备型号条目与短残尾（filterConstructionSteps 修复 /u 模式下“台\b”永不匹配的边界问题，新增设备条目规则与短工序词保护）
  - 情报缓存版本 v8→v9，强制重建施工组织图谱，保证清洗逻辑对既有项目生效
  - 新增 projectIntelligenceCleaning 真实脏数据回归测试（3 项）

## 4.2.3

### Patch Changes

- 项目主要施工内容真实生成（real-gen-18）对比参考施组后修复确定性兜底 3 类脏数据问题：

  - 修复结构化数据把工程量清单条目混入施工流程（如“消防动力配电总箱 2 台 非标箱 挂墙安装”被当成工序步骤输出），新增 filterConstructionSteps 按“数字+量词”与“是清单条目子串”双重特征剔除
  - 修复同一对象工程量“名称：数量”“名称 参数 数量”双格式重复罗列，新增 dedupeQuantityFacts 归一化标点后按子串关系保留信息更全的条目
  - 修复 scope 尾部句号重复产生“。。”，概况句尾清理尾部标点；施工方法段不再重复罗列工程量（概况已列），只保留工序链+参数+验收叙述
  - 施工流程过滤后不足 3 步时用工艺知识卡工序链补足，保证流程是真正的工序序列；同步增加真实脏数据回归测试

## 4.2.2

### Patch Changes

- 项目主要施工内容施工方法叙述化与生成速度优化（依据入围施组写法规范提炼）：

  - 修复「项目主要施工内容」节脏事实检查把合法 #### 工作包标题误判为标题污染，导致该节永远回退确定性兜底、施工方法沦为清单参数罗列的完整链条（非法标题层级改为行首锚定 + 检查对象去除节标题）
  - 修复 currentSectionBlock 在文档最后一节被 $ 行尾锚点截断（首个 #### 行截断），改为真正字符串末尾锚点
  - 新增 narrateConstructionMethod：用工艺知识卡把施工方法写成“工序链+工艺参数+检测验收+项目工程量”连贯叙述，替代“xxx：2 台；xxx：1 台”式机械拼接；主要分部分项工程施工方案兜底同步接入
  - 扩展知识卡匹配：新增泛化工作包分组（安装工程/结构加固/装饰工程/室外道排等 9 组）、包含匹配、卡片上限 8→16
  - 升级施工方法过弱判定：区分强动作词与弱词（“安装/挂墙”等会出现在清单条目名里），多处“条目：数量”式标记 + 无强动作词一律判弱回退
  - 专项结构指令新增施工方法写法样例与“严禁清单条目原样罗列”禁令
  - 速度优化：大章节组间并发强制串行（1）改为默认 3、大章节组级目标字数上限 1200→2400，减少修复循环空转

## 4.2.1

### Patch Changes

- 施工组织设计生成质量与稳定性修复（4.2.0 发布后多轮真实生成验证迭代）：

  - 修复 Writer 提示词禁令含具体话术样本导致正文套话污染与章节重复（禁令改为无样本泛化表述）
  - 修复附录 A/B 标题被 normalizeFormalChapterHeadings 降级为章内小节（新增附录标题豁免，附录保持文档末尾 ## 级别）
  - 修复 TOC 小节行首缩进被空白压缩破坏导致目录格式异常
  - 修复双标题叠加（"## ###"粘连）与相邻结构重复标题（removeAdjacentDuplicateHeadings）
  - 修复 Final Gate 重算时 validationIssues 重复累加、warning 线性扣分无上限导致 consistency=0
  - 修复 targetWords 与 criticalMinChars 冲突、思考模型预算不放大（openai 工厂 supportsThinking）
  - 修复校验误报：'后台'禁止词误伤后台权限设置、工程量汇总表误判为基础信息重复、表格清单/设备清单误报、拆除类小节无工艺参数豁免、工程概况表格小节误报
  - 修复 task writer 空壳保护、方法方案确定性兜底、Reviewer 空小节必报 blocker、Repairer 修复目标与 criticalMinChars 对齐
  - 新增附录标题豁免与双层 finalize 回归测试

## 4.2.0

### Minor Changes

- 施工组织设计生成六层专业化重构（L1-L6）：

  - L1 结构引擎：新增评标结构知识库（10 个结构组 + 项目类型扩展组）与前置结构校验，自动补挂缺失小节、限制单章小节膨胀（上限 18 个）
  - L2 知识引擎：新增 28 张施工工艺标准知识卡（土方/桩基/钢筋/混凝土/防水/给排水/电气等），按工作包匹配注入
  - L3 生成管线：新增写作任务书构建器（章节焦点规则 + 事实域 + BOQ 目标），工作包三段式卡片（施工概况/施工流程/施工方法），删除模板化废话段与硬编码样例数据
  - L4 校验体系：新增 6 个专业化校验器（重复段检测/空话段检测/工艺参数密度/卡片结构/表格完整度/评标响应度），升级反空话词表
  - L5 编排导出：封面项目信息表、附图图位索引附录、关键工艺参数汇总附录
  - L6 质量度量：新增 7 维专业度评分（结构完整度/事实落位率/工艺参数密度/表格完整度/废话控制/重复控制/评标响应度），随交付报告输出

## 4.1.20

### Patch Changes

- 批量发布所有包的 patch 版本
- Updated dependencies
  - @customize-agent/knowledge@4.0.42
  - @customize-agent/llm@3.0.13
  - @customize-agent/runtime@3.0.13

## 4.0.122

### Patch Changes

- Fix document section repair loop, export gate blocking, and generation quality safeguards.

## 4.0.121

### Patch Changes

- Improve document readiness scoring diagnostics and responsive workflow layout.

## 4.0.120

### Patch Changes

- Improve longform document generation quality, timeout handling, section fallback content, and polluted heading cleanup.

## 4.0.119

### Patch Changes

- 增强文档生成事实落位、量化参数门禁和模板运行即时反馈交互。

## 4.0.118

### Patch Changes

- 修复服务端生产包启动校验、文档工作流提示词绑定可见性、目录正文清洗和最终导出门禁。

## 4.0.117

### Patch Changes

- Fix server runtime startup artifacts and hydration stability for the web console.

## 4.0.116

### Patch Changes

- Fix documents page development runtime noise by disabling Next dev indicators and keeping Drawer usage compatible with the installed Ant Design version.

## 4.0.115

### Patch Changes

- Fix dashboard documents page runtime warnings by aligning Drawer usage with the installed Ant Design API and simplifying background job status rendering.

## 4.0.114

### Patch Changes

- Fix packaged dashboard startup returning 404 by restoring clean production .next packaging and validating required page routes before start or publish.

## 4.0.113

### Patch Changes

- Improve document generation quality by respecting prompt-driven cover and table-of-contents intent, filtering instruction-like outline headings, strengthening final quality gates, reducing fact noise, and keeping generated tables of contents aligned with final document structure.

## 4.0.112

### Patch Changes

- Improve document workflow prompt execution, export table handling, generation diagnostics, and background job status consistency.

## 4.0.94

### Patch Changes

- Improve document generation table governance and export normalization.

## 4.0.93

### Patch Changes

- Improve project basic fact extraction and section-level quantitative evidence placement.

## 4.0.92

### Patch Changes

- Enforce structural section rules parsed from document prompt roles during section planning and drafting.

## 4.0.91

### Patch Changes

- Improve document generation prompt execution, section-first drafting completeness, long-form budget reliability, and export readiness diagnostics.

## 4.0.90

### Patch Changes

- Restore prompt role execution control and improve longform generation stability.

## 4.0.89

### Patch Changes

- Release document generation fact coverage updates.

## 4.0.88

### Patch Changes

- Refine document generation prompt flow and skip multimodal understanding by default.

## 4.0.87

### Patch Changes

- Optimize document generation with generic chapter fact needs coverage.

## 4.0.86

### Patch Changes

- Improve professional document generation with long-form budget planning, prompt role binding, role configuration persistence, validation noise reduction, and reliable parameter coverage.

## 4.0.85

### Patch Changes

- Fix model provider health checks to use configured model names and avoid GPT gateway stalls caused by tiny max token limits.

## 4.0.84

### Patch Changes

- Improve document generation quality boundaries, diagnostics, and release packaging.
- Updated dependencies
  - @customize-agent/knowledge@4.0.36

## 4.0.83

### Patch Changes

- Improve generated construction document quality gates, resume handling, export reliability, and knowledge/memory workflow stability.
- Updated dependencies
  - @customize-agent/knowledge@4.0.35

## 4.0.80

### Patch Changes

- 发布文档生成质量、结构归一、导出稳定性和长期记忆类型清理相关正式版本。

## 4.0.79

### Patch Changes

- Fix document workflow tertiary heading normalization to renumber generated subsections by the current secondary section and collapse accidental fifth-level headings before DOCX export.

## 4.0.78

### Patch Changes

- Optimize local knowledge-base upload indexing performance while preserving extraction and retrieval quality.

  - Decouple upload staging from synchronous vector indexing.
  - Add explicit upload completion signaling for concurrent batches.
  - Prefer PDF text-layer extraction before OCR and add adaptive high-DPI OCR retry for low-quality pages.
  - Improve deferred incremental vector indexing and batch HNSW cleanup.
  - Increase local embedding batch throughput.

- Updated dependencies
  - @customize-agent/knowledge@4.0.33

## 4.0.77

### Patch Changes

- Make the native hnswlib-node vector index dependency optional so npm install does not fail on machines without native build toolchains.
- Updated dependencies
  - @customize-agent/knowledge@4.0.32

## 4.0.76

### Patch Changes

- Fix npm install compatibility and block degenerate repeated-token document output.
- Updated dependencies
  - @customize-agent/knowledge@4.0.31

## 4.0.75

### Patch Changes

- Fix npm package metadata by publishing workspace dependencies as resolved semver ranges.

## 4.0.74

### Patch Changes

- Optimize document generation budget controls and release updated server and CLI packages.

## 4.0.73

### Patch Changes

- Optimize document generation quality workflow with deterministic local patch repair, structured final review, stronger JSON parsing, diagnostics linkage, and LLM concurrency/performance safeguards.

## 4.0.72

### Patch Changes

- Harden document generation and knowledge-base boundaries: remove implicit indexing during generation/search flows, restrict document evidence retrieval to template-bound indexed files, remove generated-content knowledge-base ingestion paths, and improve workflow concurrency behavior.
- Updated dependencies
  - @customize-agent/knowledge@4.0.30

## 4.0.71

### Patch Changes

- Improve document workflow generation by moving explicit outline subsection planning to LLM-driven preplanning, preserving user-provided primary chapters without hardcoded domain structures.
- Add detailed workflow progress metadata and frontend sub-step rendering so long-running document generation stages show dynamic status, details, and per-chapter progress.
- Updated dependencies
  - @customize-agent/knowledge@4.0.29

## 4.0.70

### Patch Changes

- Refactor server services into modular domains, centralize shared types and constants, and generalize document generation quality rules to avoid domain-specific pollution.

## 4.0.69

### Patch Changes

- 优化文档生成稳定性与生成资源管理：修复生成卡死、中止清理、LLM 超时和轮询取消问题，并将模板生成结果默认登记到生成资源而非自动写入知识库。

## 4.0.68

### Patch Changes

- Harden OCR noise suppression and worker lifecycle, improve workflow abort propagation, and prevent stale workflow auto-start or recovery state from restarting old records.
- Updated dependencies
  - @customize-agent/knowledge@4.0.28

## 4.0.67

### Patch Changes

- Removed redundant explicit outline input prompt from workflow drawer to allow templates to launch automatically.
  Fixed background Tesseract C++ crashes (mutex locks) during high-concurrency image extractions by implementing a sequential queue lock.
  Hardened C++ log interception to completely silence irrelevant OCR warnings.
- Updated dependencies
  - @customize-agent/knowledge@4.0.27

## 4.0.66

### Patch Changes

- Resolve uncaught C++ mutex locking issues with Tesseract.js in multi-threaded workflows by enforcing a strictly sequential worker execution queue, and successfully suppress remaining underlying WASM OCR noise patterns in the console output.
- Updated dependencies
  - @customize-agent/knowledge@4.0.26

## 4.0.65

### Patch Changes

- Remove redundant manual requirement input prompt when running workflows, automatically start the generation process upon running a template, ensuring a smoother user experience.

## 4.0.64

### Patch Changes

- Apply explicit chapter configurations and fallback matchers for project basic facts, and properly restore configured chapter forbidden filters for user explicit outline protection.

## 4.0.63

### Patch Changes

- Fix OUTLINE parsing regression to correctly incorporate strict outline blocks from prompt roles, improve outline formatting compatibility, and ensure missing chapters throw hard errors.

## 4.0.62

### Patch Changes

- Strengthen project and bound-file isolation for document generation, prevent prompt examples from leaking into generated content, and keep CLI knowledge searches scoped to the current project by default.
- Updated dependencies
  - @customize-agent/knowledge@4.0.25

## 4.0.61

### Patch Changes

- Fix streaming tool call propagation, abort handling, background command output retention, and server package assets.
- Updated dependencies
  - @customize-agent/llm@3.0.9

## 4.0.59

### Patch Changes

- Improve document refine interaction to preserve user prompts and strengthen local edit safety.
- Updated dependencies
  - @customize-agent/knowledge@4.0.23

## 4.0.58

### Patch Changes

- Fix document export body limits, improve document refine local editing, and suppress OCR native noise.
- Updated dependencies
  - @customize-agent/knowledge@4.0.22

## 4.0.57

### Patch Changes

- Optimize document workflow generation quality and performance.

## 4.0.56

### Patch Changes

- 允许文档在存在导出风险提示时继续导出，并保留复核提示。

## 4.0.55

### Patch Changes

- 完善文档生成进度状态收敛、共享证据复用，以及长连续文本切片稳定性。
- Updated dependencies
  - @customize-agent/knowledge@4.0.21

## 4.0.54

### Patch Changes

- 加固文档生成进度状态、共享证据去重与长连续文本切片边界。
- Updated dependencies
  - @customize-agent/knowledge@4.0.20

## 4.0.53

### Patch Changes

- 修复文档工作流生成前置阶段进度反馈、共享资料证据池复用，以及图片 OCR 小图/无文字处理噪声。
- Updated dependencies
  - @customize-agent/knowledge@4.0.19

## 4.0.52

### Patch Changes

- Fix dashboard production startup, template-bound material readiness, and stale dashboard health checks.

## 4.0.51

### Patch Changes

- Prevent tiny images from entering OCR during knowledge indexing and publish the fix through the server and CLI packages.
- Updated dependencies
  - @customize-agent/knowledge@4.0.18

## 4.0.50

### Patch Changes

- Improve folder upload resilience and knowledge file listing visibility.

## 4.0.49

### Patch Changes

- Strengthen document budget generation and export gate enforcement.

## 4.0.48

### Patch Changes

- Relax outline title validation for explicit outline input.

## 4.0.47

### Patch Changes

- Improve document generation length handling, PDF export formatting, and targeted chapter-level repair without full-document rewrites.

## 4.0.46

### Patch Changes

- Improve knowledge parsing, chunking, retrieval reranking, and document generation guardrails.
- Updated dependencies
  - @customize-agent/knowledge@4.0.17

## 4.0.45

### Patch Changes

- Release scanned PDF OCR stability fix through the CLI and server packages.

## 4.0.44

### Patch Changes

- Improve document editing workflow and knowledge extraction support.
- Updated dependencies
  - @customize-agent/knowledge@4.0.15

## 4.0.42

### Patch Changes

- Fix generated document navigation consistency and strengthen construction document output quality.

## 4.0.31

### Patch Changes

- Fix construction document export typography and complete recommended brand prompt binding flow.

## 4.0.29

### Patch Changes

- Release formal patch version.
- Updated dependencies
  - @customize-agent/knowledge@4.0.12
  - @customize-agent/llm@3.0.6
  - @customize-agent/runtime@3.0.8

## 4.0.28

### Patch Changes

- Publish the knowledge-base extraction and chunking fixes used by document role/template validation.
- Updated dependencies
  - @customize-agent/knowledge@4.0.11

## 4.0.27

### Patch Changes

- Improve document generation cleanup and make formal-output constraints configurable while using the enhanced knowledge-base parsing and retrieval pipeline.
- Updated dependencies
  - @customize-agent/knowledge@4.0.10

## 4.0.26

### Patch Changes

- Release workflow, document generation, and knowledge extraction improvements.
- Updated dependencies
  - @customize-agent/knowledge@4.0.9
  - @customize-agent/runtime@3.0.7
  - @customize-agent/llm@3.0.5

## 4.0.25

### Patch Changes

- Fix document workflow generation when extracted fact values are arrays or objects, and keep formal document output free of internal evidence sections.

## 4.0.4

### Patch Changes

- Fix namespaced nested translation keys in the server UI.

## 4.0.3

### Patch Changes

- Internationalize knowledge base search labels and improve document workflow guidance.

## 4.0.2

### Patch Changes

- Stabilize the local knowledge base and document workflow release path.

  - Replace the sqlite-vec vector store with a mandatory HNSWLib vector store and install-time native validation.
  - Fix archive upload handling, upload/reindex progress state, and forced reindex behavior.
  - Ensure built-in workflow templates pass preflight validation with seeded knowledge base content.
  - Add workflow template validation, inline diagnostics, editable chapter structure, and generated document/resource knowledge-base backflow.
  - Fix PDF/HTML export image rendering for local knowledge-base resources and harden local image path resolution.
  - Remove production test routes, stale sqlite-vec dependency residue, and stale dist artifacts from package tarballs.

- Updated dependencies
  - @customize-agent/knowledge@4.0.2

## 4.0.1

### Patch Changes

- 优化 UI 体验：统一页面头部风格，角色配置/规范包/文档生成/生成资源/提示词管理等页面卡片网格布局与抽屉编辑器重构，完善标签国际化，修复热更新与 API 请求问题
- Updated dependencies
  - @customize-agent/knowledge@4.0.1

## 4.0.0

### Major Changes

- 优化

### Patch Changes

- Updated dependencies
  - @customize-agent/knowledge@4.0.0

## 3.0.29

### Patch Changes

- 修复 PDF 等大文件上传后因索引器内部限制被跳过并误报“已写入但未入库”的问题，上传错误会透传具体跳过原因。
- Updated dependencies
  - @customize-agent/knowledge@3.0.13

## 3.0.28

### Patch Changes

- 修复已存在知识库文件重复上传时被错误判定为上传失败的问题，并让上传失败提示显示真实后端错误。

## 3.0.27

### Patch Changes

- 更新知识库 DWG WASM 转换和上传入库修复。
- Updated dependencies
  - @customize-agent/knowledge@3.0.12

## 3.0.26

### Patch Changes

- 修复知识库上传成功但解析分块入库不完整的问题，补充上传结果校验并支持嵌套文件夹上传。
- Updated dependencies
  - @customize-agent/knowledge@3.0.11

## 3.0.25

### Patch Changes

- 重新发布 Web 管理控制台和 CLI 安装入口，确保用户安装后启动最新服务。

## 3.0.24

### Patch Changes

- 优化文档生成、知识库文件列表和规范包配置体验。

## 3.0.23

### Patch Changes

- Fix dashboard static assets, direct endpoint provider configuration, error logging, and generated document PDF export.
- Updated dependencies
  - @customize-agent/llm@3.0.4
  - @customize-agent/runtime@3.0.6

## 3.0.22

### Patch Changes

- 修复 Windows 发布包首次访问文件管理页时内置知识库生成依赖 python3 导致 500 的问题，并让文件列表与模型供应商接口返回可诊断错误信息。

## 3.0.21

### Patch Changes

- 细化学习说明页面，补充生成记录、warning 与导出门禁语义、生成资源与知识库关系、生产级生成前检查清单和常见问题处理建议。

## 3.0.20

### Patch Changes

- 优化生成编辑页草稿历史和校验详情展示：草稿历史补充明确删除按钮与整体生成耗时，校验详情改为可换行的卡片列表，避免长文本溢出卡片。

## 3.0.19

### Patch Changes

- Fix export gate semantics so spec-required fact/source-role gaps are review warnings instead of blocking errors, while exports still block on true exportGate blocking issues.

## 3.0.18

### Patch Changes

- Expand built-in prompt management prompts, make generated documents with validation/export gate issues show warning status instead of failed/completed, allow exports with warnings, and display warning reasons in draft history.

## 3.0.17

### Patch Changes

- Fix generated image asset preview by rejecting placeholder responses from image generation, resolving generated asset paths through the global generatedDocuments directory, validating preview image bytes, and add generated draft history deletion in the document editor.

## 3.0.16

### Patch Changes

- Enrich the built-in document generation demo with additional prompt roles, case/style/export file roles, detailed template style guidance, structured resource evidence guidance, export gate guidance, and a more complete document spec package.

## 3.0.15

### Patch Changes

- Add generated document persistence, background generation polling, generated asset management, dynamic spec-driven fact extraction, structured resource evidence, and dynamic generation status steps.

## Unreleased

### Patch Changes

- Enrich built-in document generation demo with more prompt roles, template style guidance, resource evidence guidance, export gate prompts, case reference file roles, style reference file roles, export gate file roles, and a more detailed document spec package.
- Add generated document persistence under `~/.customize-agent/projects/{projectId}/generatedDocuments`, background generation with polling, generated asset management, dynamic spec-driven fact schema extraction, structured resource evidence, and dynamic generation status steps.

## 3.0.14

### Patch Changes

- Fix document export robustness and page navigation performance by sanitizing binary evidence, adding a PDF fallback, and avoiding unnecessary knowledge-base reindexing on page load.
- Updated dependencies
  - @customize-agent/knowledge@3.0.10

## 3.0.13

### Patch Changes

- Make the built-in Delta Force operator guide fully runnable with initialized knowledge-base assets, built-in markers, richer roles/specs, localized spec controls, and verified generation/export flow.
- Updated dependencies
  - @customize-agent/knowledge@3.0.9

## 3.0.12

### Patch Changes

- Add a runnable Delta Force operator guide demo, multi-resource role bindings, clearer role/spec explanations, and safer modal behavior.
- Updated dependencies
  - @customize-agent/knowledge@3.0.8

## 3.0.11

### Patch Changes

- Add configurable document spec packages, deep spreadsheet parsing, configurable export gates, and Word document export support.
- Updated dependencies
  - @customize-agent/knowledge@3.0.7

## 3.0.10

### Patch Changes

- Enhance the user guide with rich staged walkthroughs, guided timelines, detailed operation steps, and completion checklists.

## 3.0.9

### Patch Changes

- Add document generation execution status card and detailed full-flow user guide page.

## 3.0.8

### Patch Changes

- Add document multi-stage execution engine, LLM JSON fact extraction, structured table parsing, source traceability, and export gate enforcement.
- Updated dependencies
  - @customize-agent/llm@3.0.3
  - @customize-agent/knowledge@3.0.6
  - @customize-agent/runtime@3.0.5

## 3.0.7

### Patch Changes

- Add production document workflow capabilities with role execution types, file processing types, structured facts, stricter validation, and formal document layout export.
- Updated dependencies
  - @customize-agent/knowledge@3.0.5
  - @customize-agent/runtime@3.0.4

## 3.0.6

### Patch Changes

- Release document generation workbench, embedding configuration, PDF export, and knowledge-driven document workflow improvements.
- Updated dependencies
  - @customize-agent/runtime@3.0.3
  - @customize-agent/knowledge@3.0.4

## 3.0.5

### Patch Changes

- Improve legacy Word and CAD document ingestion, add batch file deletion controls, and fix terminal thinking status rendering.
- Updated dependencies
  - @customize-agent/knowledge@3.0.3

## 3.0.4

### Patch Changes

- Fix CUSTOMIZE.md system prompt injection for all task modes and make terminal task status append-only instead of erasing progress.

## 3.0.3

### Patch Changes

- Fix packaged dashboard startup by keeping Next.js server output in CommonJS package scope.

## 3.0.2

### Patch Changes

- Patch release 3.0.2.
- Updated dependencies
  - @customize-agent/knowledge@3.0.2
  - @customize-agent/llm@3.0.2
  - @customize-agent/runtime@3.0.2

## 3.0.1

### Patch Changes

- Patch release 3.0.1.
- Updated dependencies
  - @customize-agent/knowledge@3.0.1
  - @customize-agent/llm@3.0.1
  - @customize-agent/runtime@3.0.1

## 3.0.0

### Major Changes

- Release 3.0.0 with updated CLI, web management, knowledge base, prompt, and tool execution behavior.

### Patch Changes

- Updated dependencies
  - @customize-agent/knowledge@3.0.0
  - @customize-agent/llm@3.0.0
  - @customize-agent/runtime@3.0.0

## 0.1.5

### Patch Changes

- Updated dependencies
  - @customize-agent/knowledge@2.1.3
  - @customize-agent/llm@2.0.4
  - @customize-agent/runtime@2.0.4

## 0.1.4

### Patch Changes

- Updated dependencies
  - @customize-agent/knowledge@2.1.2
  - @customize-agent/llm@2.0.3
  - @customize-agent/runtime@2.0.3

## 0.1.3

### Patch Changes

- Updated dependencies
  - @customize-agent/knowledge@2.1.1
  - @customize-agent/llm@2.0.2
  - @customize-agent/runtime@2.0.2

## 0.1.2

### Patch Changes

- ## 🔍 全面审计修复 — 40 项问题全部修复

  ### 🚨 严重问题修复

  - **统一 TypeScript 版本**：server 从 `^5.7.0` 升级至 `^6.0.3`，与 monorepo 其他包保持一致
  - **统一 @types/node 版本**：server 从 `^22.0.0` 升级至 `^25.9.3`
  - **统一 mammoth 版本**：knowledge、cli、server 从 `^1.11.0` 统一为 `^1.12.0`
  - **统一 tesseract.js 版本**：knowledge、cli、server 从 `^6.0.1` 统一为 `^7.0.0`
  - **修复 process.exit 在库代码中调用**：`@customize-agent/tools` 的清理处理器改为设置 `exitCode` 而非强制退出进程
  - **修复 CLI 入口顶层 JSON.parse 无异常处理**：`customize-agent` CLI 入口包裹 try-catch，package.json 损坏时优雅降级
  - **修复 KB_DEBUG 布尔判断错误**：`@customize-agent/knowledge` 中 `if (process.env.KB_DEBUG)` 改为 `=== '1'`

  ### 🔴 高优先级修复

  - **移除未使用依赖 figlet**：`customize-agent` CLI 中未使用的 figlet 依赖已清理
  - **@types/\* 移至 devDependencies**：engine、llm、search、tools 中的 `@types/node` 和 `@types/better-sqlite3` 已移至正确位置
  - **24 个 API 路由添加 405 响应**：server 所有 API 路由对不支持的 HTTP 方法正确返回 405
  - **24 个 API 路由修复错误泄露**：错误响应不再泄露内部堆栈信息，改为安全通用消息
  - **删除死代码 sse.ts**：`@customize-agent/llm` 中完全未被使用的 SSE 工具文件已删除
  - **清理未使用的类型导出**：types、engine、tools 包中无外部消费者的导出已移除
  - **移除 knowledge 包 export \* 通配符**：`@customize-agent/knowledge` 改为显式导出，防止内部类型泄露

  ### 🟡 中优先级修复

  - **注册未文档化的 REPL 命令**：`customize-agent` CLI 的 `/compact` 和 `/context` 命令已加入命令列表和 i18n 翻译
  - **修复孤立的知识库搜索页面**：server 侧边栏添加 `/knowledge/search` 导航链接
  - **添加知识库管理页导航按钮**：server manage 页面添加跳转到 files 和 search 的按钮
  - **删除重复的 .traineddata 文件**：根目录下重复的 Tesseract 语言数据文件（~15MB）已删除
  - **添加 \*.traineddata 到 .gitignore**：防止 OCR 语言数据文件被提交
  - **清理根目录遗留调试文件**：debug-\*.md 文件已删除

  ### 🟢 低优先级修复

  - **所有包添加 "exports" 字段**：8 个包和 CLI 均添加了正式的 exports 映射，锁定公共 API 边界
  - **重命名 misleading .d.ts 文件**：`marked-terminal.d.ts` → `vendor-modules.d.ts`
  - **清理 .npmrc**：移除非标准格式的 access=public 配置
  - **移除 server 中冗余的 @next/eslint-plugin-next**：由根目录统一管理
  - **标记 engine errors.ts 为废弃**：添加注释引导从 `@customize-agent/types` 直接导入

  ### ✅ 验证结果

  - TypeScript 类型检查：17/17 通过，零错误
  - ESLint 检查：10/10 通过，零警告
  - 测试：252/252 全部通过

- Updated dependencies
  - @customize-agent/llm@2.0.1
  - @customize-agent/knowledge@2.1.0
  - @customize-agent/runtime@2.0.1

## 0.1.1

### Patch Changes

- Updated dependencies [6744afe]
  - @customize-agent/knowledge@2.0.0
  - @customize-agent/llm@2.0.0
  - @customize-agent/runtime@2.0.0
  - @customize-agent/types@2.0.0
