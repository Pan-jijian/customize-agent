# @customize-agent/knowledge

## 4.3.7

### Patch Changes

- fix: 全量发布——补齐上版产物遗漏的源码改动并修复知识库重新索引误报

  - fix(document-workflow): 确定性修复管线扩展——① 节点工期修复升级三阶段管线：体系缩放（「开工令下发后第 N 日」按权威工期等比缩放）+ 权威总进度计划表提取 + 多表/正文对齐，三列进度表行链式重算保证缩放后表内自洽；② 装配率权威口径统一（实测 38.4% vs 招标锁定 30% 两套口径由外部权威裁决），长窗口「装配率…计算为 N%」形态补盲，反向形态排除逗号防相邻指标（内隔墙 54.0%）误采；③ 工程规模摘要提取修复一览表套话填充；④ blocker 修复锚点分类：补写类缺陷注入确定性 append 锚点（章节尾/小节尾定位句），结构类缺陷注入区间锚点（小节标题+下一同级标题整节重写）；⑤ 全文重建函数单一定义（消除 5 处 300+ 字符重复表达式）；⑥ Final Gate 空小节补写改为单轮修复（每缺陷单次尝试失败即放弃，删除升级指令二修，修复占比显著下降）；⑦ 工作包型小节补写标签不再是硬性要求（内容要素齐全即可）
  - fix(知识库): 文件管理导出补充修复——导出文本剥离 CAD 解析元数据行（图层/块/实体类型汇总与「CAD 语义标注文本」节标题）只保留图纸真实文字；上传与导出均过滤 ~$ Office 锁文件；根目录导出空 prefix 匹配全部文件不再报 no files matched
  - fix(知识库): 重新索引误报根治——Next.js 多 bundle 实例化下操作日志恢复逻辑把刚提交的新任务误标为「服务重启导致任务中断」导致前端弹报错（任务实际正常运行）。恢复判定加进程启动时间阈值（仅标记早于本进程启动的 processing 记录），日志缓存改为文件 mtime 校验（mtime 变化重读磁盘），消除多实例缓存互踩
  - fix(knowledge): CAD 图纸清洗修复——纯数字行不再整行排除（尺寸/标高/门窗表数值是真实数据），图层/块名纯数字单独排除；CAD 图纸豁免页眉页脚高重复行与纯页码规则；判空口径只统计文字标注（图层/块名是内部结构信息）；dxf-parser 残缺实体死循环防御（无标注实体跳过 parseSync 直接判空）

## 4.3.6

### Patch Changes

- fix(知识库): 图纸入库与文件管理导出修复——① 图纸入库不准确不全面根治：DXF 解析补 ATTRIB 块属性（组码 2 标签+组码 1 值）与 MTEXT 组码 3 续段全收集，CAD 内部行过滤移除纯数字误杀（尺寸/标高/门窗表数值是真实数据），图层/块名收紧为可读值且排除纯数字，dxf-parser 对残缺实体死循环防御（无标注实体直接走文本结构抽取）；② 空图纸不入库：判空口径只统计文字标注（图层/块名是内部结构信息），低于阈值判空不产生分块；③ 清洗误杀修复：CAD 图纸豁免页眉页脚高重复行与纯页码规则（标注重复是数据本身）；④ 文件管理导出修复：上传与导出均过滤 ~$ Office 锁文件（Word 临时文件乱码内容不再入库/导出），根目录导出不再报 no files matched，导出文本剥离 CAD 解析元数据行（图层/块/实体类型汇总）只保留图纸真实文字，空图纸导出判空跳过。

## 4.3.5

### Patch Changes

- 检索重排修复「C35 混凝土」类字母数字+汉字查询的排序缺陷：重排层 queryTerms 与 FTS 层一致按汉字边界拆词，识别清单特征块双词命中；表格块与计价表标题行惩罚条件化（命中查询词的不吃 -80/-140）；双词命中 boost 18→30；时间类查询下含具体日期/时刻的 chunk 提权 60。实测「C35 混凝土」清单特征块排第 3 领先绿建专篇（原为绿建 0 分条目霸榜），反验证查询 top1 回归前附表。

## 4.3.4

### Patch Changes

- 招标文件电子投标程序句清洗增强：新增 查询/登录/进行/公示 动词，并支持 PDF 提取折行的跨行拼接删除（行末无标点 + 跳过夹层空行 + 接续行非编号开头 + 拼接后含具体时间/地点证据不删），程序句残留由 24 行收敛至 15 行（其中 12 行为名称/电话/免责/法规定义的正确保留）。

## 4.3.3

### Patch Changes

- 招标文件电子投标程序句动词集再扩展：新增 提交/开标/导入/拒绝/制作/中断/在线，并将程序对象到程序动词的间距上限从 30 放宽至 45（覆盖含系统 URL 的长句），清除重索引后残留的 16 个程序句 chunk 中可删部分。

## 4.3.2

### Patch Changes

- 扩展招标文件电子投标程序句动词集：新增 获取/发布/提出/发出/发送/下载/拒收/查看/接收，覆盖「在线获取招标文件」「以询标函的形式发送」等剩余程序句句式，清除重索引后残留的 19 个程序句 chunk。

## 4.3.1

### Patch Changes

- 修复 CAD 控制码还原在整体回退保护下失效的问题：

  纯图纸文件（标高/图元枚举行占比高）的行级启发式删除常超过原文 70%，触发 30% 回退保护使整个清洗作废——挂在行级规则里的控制码还原（%%U/%%% 等）随之失效，「1%%%」「均按%%U %%U 设计」等残留入库。

  现控制码还原前置为确定性无损替换（在行级规则与回退保护之前执行），回退保护返回的原文同样已还原，保证两类路径均生效。

## 4.3.0

### Minor Changes

- 修复三处知识库检索与清洗问题：

  1. **「C35 混凝土」类查询检索排序缺陷**：字母数字与汉字连续查询串（如「C35 混凝土」）此前只能作为 trigram 短语整体匹配，精确项「C35」被淹没，导致清单特征块（「混凝土强度等级：C35」）排序落后于仅命中「混凝土」的低相关文档。现按边界拆分出独立 token（c35 + 混凝土），双词命中的精确块排前。

  2. **CAD 文本格式控制码未还原**：DWG/DXF 提取文本中的 AutoCAD 控制码（%%U/%%O 格式开关、%%D/%%P/%%C 符号、%%% 百分号转义）逐字保留，字段占位「%%U %%U」污染检索语义与生成引用。现入库清洗层对 CAD 类文件做控制码还原（「95%%%」→「95%」、格式开关删除）。

  3. **K2 清洗边界扩展**：招标文件投标人须知中的电子投标程序句（加密/解密/上传/撤回/签号/病毒防范等操作句）此前不在公告程序段规则覆盖内，低分命中反验证查询。现新增行级规则（程序动词 + 程序对象双重信号防误删），仅招标文件生效。

## 4.2.0

### Minor Changes

- 入库清洗与图谱缺口治理：CAD 图元枚举降噪、文件头去除、施组无关 gap 过滤

  - CAD 语义节点输出改造：逐实体枚举的图元属性包装（图层/块/实体类型/坐标/关联对象/状态）替换为「图纸节点锚定 + 纯标注文本」列表，消除 32000+ 图纸块的结构模板噪音，恢复「混凝土强度」等实质查询的语义召回
  - 文件头去除：extractor 成功路径不再拼接「资料类型/MIME/文件大小」元数据头，chunker 不再注入资料类型头部（元数据通道承载），切片文本更纯净
  - 清洗兜底（K3）：新增 CAD 图元属性枚举行规则（管道符表格形态「| 图层:| 实体类型:| 坐标:」与「└── 标注文本:」），覆盖专业转换器/历史版本产物形态
  - 图谱缺口治理：新增 isIrrelevantProjectGap 确定性过滤（评标办法/地质勘察/土壤氡类施组无关缺口），图谱合并与生成注入双处生效，防止无关缺口残留注入生成上下文

## 4.1.5

### Patch Changes

- 项目理解缓存真实数据修复：意图证据章节映射失效（真实施组模板 6 章仅 2 章拿到证据）、图谱证据前缀 16 块取样覆盖盲区（工期/质量标准等核心条款进缺口）、contentFacts 元数据噪音（编号/资料类型/标题残留）。knowledge 包新增 listChunksSampled 步长均匀取样（强制含最后一块），server 侧 chapterIntentTags 标签扩展、cleanSignal 增强、isMetadataSentence 过滤。

## 4.1.4

### Patch Changes

- 入库清洗扩展至图纸/清单专门噪声（K3）：

  - 图纸图框标题栏信息行（图号/比例/日期/设计/制图/审核签名行，负向词保护设计说明等实质标题）
  - CAD 属性行（图层/颜色/线型/块名等转换产物）
  - 清单纯报价表格段（费汇总/暂估单价/规费/税金/计日工标题 + 段内金额行 ≥2 双重证据；分部分项清单的名称/特征/工程量是施组核心数据，绝不删）
  - 清单扉页签章段（工程量清单标题 + 造价签章证据）
  - 新增 bill 文档类型判定（文件名/文首清单特征），清单规则适用于清单文件与招标文件内清单章节

## 4.1.3

### Patch Changes

- 修复 DeepSeek prefix cache 命中率与入库数据质量两大问题：

  **缓存命中率修复（F 系列）**

  - F1/F2：factCoverageContext 与 missingFacts 从 L3 块级变化段上移 L2 章级共享段（章级恒定值不再每块重复注入）
  - F3：capFactCoverageContext 预算封顶（默认 26000 字符按行完整截断，DOCUMENT_FACT_COVERAGE_CAP=0 关闭）——全局资料事实索引全量注入是 L3 爆炸主因
  - F5/F9：块路径与逐小节管线首块预热循环——首块单独执行建立共享前缀缓存，后续并发块命中（规避 cache 写入秒级延迟导致并发互盲）
  - F6：两步生成大纲调用前缀收敛（章级恒定段前置）+ contextLayers 分层统计
  - F7/F8：规划轮与全局审查调用 contextLayers 补齐（unlayeredChars 归因）

  **入库前数据清洗（K1，源头治理）**

  - 新增 text-cleaner 模块：解析完成后、分块入库前移除确定性噪声
  - 通用：页眉/页脚高重复行、纯页码行、目录区段、连续空行
  - 招标文件：投标函格式模板段、泛化引用行
  - 补疑/答疑：零信息回复行；图纸：无汉字纯坐标数字行
  - 保守策略：多重证据判定、30% 整体回退保护、KB_TEXT_CLEANING=0 关闭、清洗统计 写入索引记录

  **入库前内容无关数据清洗（K2，章节/段落级）**

  - 合同通用条款整章（标题 + 规模证据 + 止于专用合同条款边界，专用条款与协议书保留）
  - 招标公告程序段（文件获取/递交/开标，段内含时间地点证据才删）
  - 评标商务评审细则段（段内出现技术评审/施组关键词则整体保留，宁多勿丢）
  - 章节级删除置信度高：不参与 30% 行级回退判定，仅保留 10% 极端防全删

## 4.1.2

### Patch Changes

- 75fdb31: 施组技术文件评分报告（21）两项否决级/中风险问题修复闭环：

  1. 「确保黄山杯」零响应回归根治：4.12.4 修复循环配额截断（others.slice(0,8)）导致评分项要求未响应 blocker 永不进入修复循环——移除截断全量参与修复；小节写作紧凑上下文（compactSectionProjectContext）增加「招标文件评分项要求」段置顶保护，评分项要求不再因 2000 字符尾部截断丢失

  2. 正文禁止出现投标/评标纪律内容（商务投标函内容三明治治理）：utils 新增单一来源词表 BID_DISCIPLINE_PHRASES（11 词）与 isBidDisciplineSentence 句级判定（覆盖「纪律管理+投标活动合法合规」类无禁词词面变体，不误伤劳动纪律/施工纪律）；提取层过滤纪律条款（frontScheduleClauses/prohibitionNotes）；响应分类确定性兜底（纪律条款强制 responsive=false）；写作硬约束追加第 8 条禁写商务投标函内容；清洗层 stripBidDisciplineSentences 句级复用同口径判定；检测层 Reviewer 词表展开同口径并新增纪律语境句 blocker

  3. knowledge 检索性能修复：FTS 迁移 trigram tokenizer（中文子串可命中索引），LIKE 全表兜底拆分小列/短词两组，消除大库 40 term × 7 列全表扫描阻塞事件循环数分钟的问题

## 4.1.1

### Patch Changes

- 文档生成链路六项质量修复（真实生成实测闭环）：

  - 修复器证据预算 + 400 上下文超长降级重试：审查/优化节点不再因全量注入证据触发上下文超长而全线失败（此前每节点仅运行数秒即 error）
  - HNSW 空壳/旧索引加载防护与重建：hnswlib v3 空索引 loadIndex 清零 max_elements 导致 addPoint 报错、documents sidecar 丢失导致召回静默为零的问题，加载时自动检测并重建
  - 目录三级小节提取修复：有 sections 的章节在目录重建时不再短路返回原始内容，H4 编号规范化后提取三级行
  - OUTLINE 脏标题净化：招标条款句碎片（如「如我方中标，我方承诺」「委员会确定中」）不再混入章节大纲
  - 评分项门禁字面命中兜底：语义相似度未过阈值但专有名词（黄山杯等）/数字参数/具名奖项字面命中正文时不再误报零响应
  - 逐节写手输出池扩容：小节正文含多个三级小节时输出池按字数系数放大，靠后小节不再被 maxTokens 截断

## 4.1.0

### Minor Changes

- 文档生成稳定性专项修复（P0-P4）：

  - **P0 证据注入重构**：预算从 6K/18K 提升至 8K/36K（每目标字 12 字符证据，env `DOCUMENT_EVIDENCE_BUDGET_CEILING` 可调）；排序改为事实覆盖驱动（量化参数/项目基础事实/requiredFacts 命中加权），移除 byFile top-1 启发式，单文件上限放宽至 6 条；文本证据保留结构化换行，单条 1200 字符截断标注。
  - **P1 两步生成**：整章一次成稿先由事实规划阶段产出事实大纲 JSON（校验失败退化为单步生成，非模板兜底），Writer 按大纲逐条落位；env `DOCUMENT_TWO_STEP_GENERATION=0` 可关闭。
  - **P2 表格分块行原子性**：超预算表块按行边界拆分并保留表头，数据行不再被窗口硬切；修复共享表头前缀导致的分片偏移计算错误。
  - **P3 提示词事实源**：用户提示词中的事实性表述（工期/规模/质量标准等）提取为最高优先级事实注入；大纲阶段与写作阶段的角色指令分阶段注入。
  - **P4 missingFacts 定向补充检索硬回路**：大纲报告材料缺失事实后自动触发定向补检，命中材料并入证据池并重渲染大纲，覆盖判断基于合并后证据池避免误标。

## 4.0.44

### Patch Changes

- f4781ee: 修复 CAD 图纸解析乱码残留：GBK 编码标注被 Latin-1 误读的多种形态过滤（纯扩展拉丁短行、GBK 误读标点混入 ASCII、分数符号误读），语义节点图层/块名补全可读性过滤，$AUDIT_BAD 内部审计标记剔除，U+FFFF 非字符全局清理；图纸无字符数据时不再入库。

## 4.0.43

### Patch Changes

- 生成链路性能优化（P0/P1 十一项）与参数抽查门禁口径对齐修复：小节检索缓存与短路、确定性兜底改造、量化参数正则统一、深召回合并、基础事实跨章缓存、证据内存节流、SQLite WAL 加固、失败 streak 隔离、参数抽查池对齐章节证据窗口（消除抽样随机性导致的评分漂移）。

## 4.0.42

### Patch Changes

- 批量发布所有包的 patch 版本

## 4.0.36

### Patch Changes

- Improve document generation quality boundaries, diagnostics, and release packaging.

## 4.0.35

### Patch Changes

- Improve generated construction document quality gates, resume handling, export reliability, and knowledge/memory workflow stability.

## 4.0.33

### Patch Changes

- Optimize local knowledge-base upload indexing performance while preserving extraction and retrieval quality.

  - Decouple upload staging from synchronous vector indexing.
  - Add explicit upload completion signaling for concurrent batches.
  - Prefer PDF text-layer extraction before OCR and add adaptive high-DPI OCR retry for low-quality pages.
  - Improve deferred incremental vector indexing and batch HNSW cleanup.
  - Increase local embedding batch throughput.

## 4.0.32

### Patch Changes

- Make the native hnswlib-node vector index dependency optional so npm install does not fail on machines without native build toolchains.

## 4.0.31

### Patch Changes

- Fix npm install compatibility and block degenerate repeated-token document output.

## 4.0.30

### Patch Changes

- Harden document generation and knowledge-base boundaries: remove implicit indexing during generation/search flows, restrict document evidence retrieval to template-bound indexed files, remove generated-content knowledge-base ingestion paths, and improve workflow concurrency behavior.

## 4.0.29

### Patch Changes

- Add generation-mode knowledge search options to reduce query rewriting overhead and allow workflow searches to skip redundant freshness checks when appropriate.

## 4.0.28

### Patch Changes

- Harden OCR noise suppression and worker lifecycle, improve workflow abort propagation, and prevent stale workflow auto-start or recovery state from restarting old records.

## 4.0.27

### Patch Changes

- Removed redundant explicit outline input prompt from workflow drawer to allow templates to launch automatically.
  Fixed background Tesseract C++ crashes (mutex locks) during high-concurrency image extractions by implementing a sequential queue lock.
  Hardened C++ log interception to completely silence irrelevant OCR warnings.

## 4.0.26

### Patch Changes

- Resolve uncaught C++ mutex locking issues with Tesseract.js in multi-threaded workflows by enforcing a strictly sequential worker execution queue, and successfully suppress remaining underlying WASM OCR noise patterns in the console output.

## 4.0.25

### Patch Changes

- Strengthen project and bound-file isolation for document generation, prevent prompt examples from leaking into generated content, and keep CLI knowledge searches scoped to the current project by default.

## 4.0.23

### Patch Changes

- Improve document refine interaction to preserve user prompts and strengthen local edit safety.

## 4.0.22

### Patch Changes

- Fix document export body limits, improve document refine local editing, and suppress OCR native noise.

## 4.0.21

### Patch Changes

- 完善文档生成进度状态收敛、共享证据复用，以及长连续文本切片稳定性。

## 4.0.20

### Patch Changes

- 加固文档生成进度状态、共享证据去重与长连续文本切片边界。

## 4.0.19

### Patch Changes

- 修复文档工作流生成前置阶段进度反馈、共享资料证据池复用，以及图片 OCR 小图/无文字处理噪声。

## 4.0.18

### Patch Changes

- Prevent tiny images from entering OCR during knowledge indexing and publish the fix through the server and CLI packages.

## 4.0.17

### Patch Changes

- Improve knowledge parsing, chunking, retrieval reranking, and document generation guardrails.

## 4.0.16

### Patch Changes

- Improve scanned PDF OCR stability and clean up Tesseract worker logging.

## 4.0.15

### Patch Changes

- Improve document editing workflow and knowledge extraction support.

## 4.0.12

### Patch Changes

- Release formal patch version.

## 4.0.11

### Patch Changes

- Fix PDF extraction fallback so valid pdfjs text is not replaced by raw binary text, add OCR augmentation for low-quality PDF text layers, and harden chunking for small sections and long unbroken text.

## 4.0.10

### Patch Changes

- Enhance PDF text extraction, chunk structure preservation, SQLite search schema, FTS coverage, vector indexing context, and hybrid retrieval ranking for more accurate knowledge-base usage.

## 4.0.9

### Patch Changes

- Release workflow, document generation, and knowledge extraction improvements.

## 4.0.8

### Patch Changes

- Normalize repeated Windows-style upload path separators before validating uploaded knowledge-base paths.

## 4.0.2

### Patch Changes

- Stabilize the local knowledge base and document workflow release path.

  - Replace the sqlite-vec vector store with a mandatory HNSWLib vector store and install-time native validation.
  - Fix archive upload handling, upload/reindex progress state, and forced reindex behavior.
  - Ensure built-in workflow templates pass preflight validation with seeded knowledge base content.
  - Add workflow template validation, inline diagnostics, editable chapter structure, and generated document/resource knowledge-base backflow.
  - Fix PDF/HTML export image rendering for local knowledge-base resources and harden local image path resolution.
  - Remove production test routes, stale sqlite-vec dependency residue, and stale dist artifacts from package tarballs.

## 4.0.1

### Patch Changes

- 优化 UI 体验：统一页面头部风格，角色配置/规范包/文档生成/生成资源/提示词管理等页面卡片网格布局与抽屉编辑器重构，完善标签国际化，修复热更新与 API 请求问题

## 4.0.0

### Major Changes

- 优化

## 3.0.13

### Patch Changes

- 修复上传接口与知识库索引器文件大小限制不一致导致大 PDF 写入后被跳过的问题，默认索引上限调整为 500MB，并增加 PDF 上传回归测试。

## 3.0.12

### Patch Changes

- 修复内置 dwgdxf WASM 在 Node 环境下默认 WASM 路径错误的问题，并用真实 DWG 样本覆盖转换、解析、分块、入库回归测试。

## 3.0.11

### Patch Changes

- 修复单文件、批量文件和嵌套文件夹上传后未可靠解析、分块、入库的问题，并内置基于 WASM 的 DWG→DXF 转换器。

## 3.0.10

### Patch Changes

- Fix document export robustness and page navigation performance by sanitizing binary evidence, adding a PDF fallback, and avoiding unnecessary knowledge-base reindexing on page load.

## 3.0.9

### Patch Changes

- Make the built-in Delta Force operator guide fully runnable with initialized knowledge-base assets, built-in markers, richer roles/specs, localized spec controls, and verified generation/export flow.

## 3.0.8

### Patch Changes

- Add a runnable Delta Force operator guide demo, multi-resource role bindings, clearer role/spec explanations, and safer modal behavior.

## 3.0.7

### Patch Changes

- Add configurable document spec packages, deep spreadsheet parsing, configurable export gates, and Word document export support.

## 3.0.6

### Patch Changes

- Add document multi-stage execution engine, LLM JSON fact extraction, structured table parsing, source traceability, and export gate enforcement.

## 3.0.5

### Patch Changes

- Add production document workflow capabilities with role execution types, file processing types, structured facts, stricter validation, and formal document layout export.

## 3.0.4

### Patch Changes

- Release document generation workbench, embedding configuration, PDF export, and knowledge-driven document workflow improvements.

## 3.0.3

### Patch Changes

- Improve legacy Word and CAD document ingestion, add batch file deletion controls, and fix terminal thinking status rendering.

## 3.0.2

### Patch Changes

- Patch release 3.0.2.

## 3.0.1

### Patch Changes

- Patch release 3.0.1.

## 3.0.0

### Major Changes

- Release 3.0.0 with updated CLI, web management, knowledge base, prompt, and tool execution behavior.

## 2.1.3

### Patch Changes

- Fix Windows EBUSY install error by removing postinstall and delaying server setup

  - Remove postinstall script to avoid npm rename conflicts
  - Add ensureServerIsInstalled() function to set up server on first run
  - Enhance kill-server.cjs with more aggressive process killing on Windows
  - Improve error handling and retry logic for file operations

## 2.1.2

### Patch Changes

- SUPER AGGRESSIVE Windows EBUSY fix - completely rewritten kill-server.cjs

  - Complete rewrite of kill-server.cjs with super aggressive cleanup on Windows
  - Kills all related Node.js processes multiple times
  - Checks for file locks and waits up to 30 seconds
  - Double-kill strategy to ensure nothing respawns
  - Scans all node.exe processes for any reference to customize-agent
  - Force-kills anything that might be holding file locks

## 2.1.1

### Patch Changes

- 修复 Windows 平台的安装和服务器启动问题

  - 增强 kill-server.cjs 脚本，更可靠地终止相关进程并释放文件句柄
  - 修复服务器启动路径问题，正确设置工作目录
  - 优化 setup.js，增强日志和重试机制
  - 改进健康检查 API，更健壮的 BUILD_ID 查找
  - 优化 process.chdir 处理，避免 Windows 文件锁定问题

## 2.1.0

### Minor Changes

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

## 2.0.0

### Major Changes

- 6744afe: 优化、拓展、兼容、新增

## 1.0.1

### Patch Changes

- 98c179b: 新增本地知识库系统、完善发行说明与零基础用户教程

  - **knowledge**: 新增本地知识库核心包，支持项目级隔离、全局共享、多格式解析、增量索引、去重管线、Web Dashboard、多项目管理
  - **tools**: 修复 archiver 类型声明，新增跨平台抽象层（shell/process/binary）
  - **engine**: 新增子智能体 Git Worktree / Snapshot 文件隔离策略
  - **search**: 修复 LSP Manager 与 grep 搜索
  - **CLI**: 优化 TUI 多行输入与粘贴，更新 README 与 RELEASE_NOTES，补全零基础用户安装教程
