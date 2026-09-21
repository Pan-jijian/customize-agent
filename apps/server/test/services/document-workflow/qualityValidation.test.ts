/**
 * qualityValidation 单测：截断词表扩展 + 占位式表达 + 跨章设备台数一致性（r15 B3 配套比豁免）。
 * 均为 L2 确定性结构检测，无需语义通道。
 */
import { describe, expect, it, vi } from 'vitest';
import { applyDeterministicConsistencyFixesToMarkdown, basisRegulationsCoverageIssues, boqPlacementIssues, resourceBreakdownConsistencyIssues, collectSectionContentGaps, crossChapterConsistencyIssues, criticalPreciseTokens, degenerateContentIssues, evaluationCriteriaCoreKeywords, formalContentIntegrityIssues, formalHeadingHierarchyIssues, formalPlaceholderIssues, isNonExemptTablePlaceholderCell, markdownTableQualityIssues, missingCriticalPreciseTokens, preciseFactUsageIssues, processSpecConflictIssues, punctuationArtifactIssues, scanTablePlaceholderCells } from '@/services/document-workflow/qualityValidation';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';
import type { DocumentDraftChapter, DocumentFactsModel } from '@/services/document-workflow/types';

// 语义兜底 stub：测试环境不加载本地嵌入模型（@huggingface/transformers 缺席），
// 返回 0 相似度使 boqPlacementIssues 的语义路径退化为「无命中」确定性行为
vi.mock('@/services/document-workflow/semanticSimilarity', async importOriginal => {
  const actual = await importOriginal<typeof import('@/services/document-workflow/semanticSimilarity')>();
  return { ...actual, buildSemanticSimilarity: async () => () => 0 };
});

/** 工序规格事实卡 mock（specifications 单条，其余数组空） */
function specFactsModel(specValue: string): DocumentFactsModel {
  return {
    project: [], schedule: [], quality: [], safety: [], resources: [], tables: [],
    drawings: [], rules: [], bills: [], preciseFacts: [], schemaFacts: {}, factIndex: {},
    missing: [], conflicts: [],
    specifications: [{ key: '工艺规格', fieldName: '', value: specValue, sourceFile: '清单.xlsx', roleId: 'specification', confidence: 90 }],
    canonical: { byKey: {} },
  } as unknown as DocumentFactsModel;
}

// 语义 gate 全零向量：不触发动作词扩围/撤销，归属判定走确定性词面路径
const embedDocuments = async (texts: string[]) => texts.map(() => [0, 0]);

describe('boqPlacementIssues 口径行排除（V5 P6 run1 实测）', () => {
  function tablesFactsModel(headers: string[], rows: string[][]): DocumentFactsModel {
    return {
      project: [], schedule: [], quality: [], safety: [], resources: [],
      drawings: [], rules: [], bills: [], preciseFacts: [], schemaFacts: {}, factIndex: {},
      missing: [], conflicts: [], specifications: [], canonical: { byKey: {} },
      tables: [{ headers, rows }],
    } as unknown as DocumentFactsModel;
  }

  it('分部小计/合计口径行与空残片行不计入分母（明细全落位不报）', async () => {
    const model = tablesFactsModel(['项目编码', '项目名称', '单位', '工程量'], [
      ['030901010001', '挖一般土方', 'm3', '100'],
      ['030901010002', '回填方', 'm3', '50'],
      ['', '分部小计', '', ''],
      ['', '合计', '', ''],
      ['', '', '', ''],
    ]);
    const issues = await boqPlacementIssues('本工程完成挖一般土方与回填方施工，铺装层改造同步推进。', [], model);
    expect(issues).toEqual([]);
    // 口径行未被排除时：分母 4、分部小计+合计未落位 → 2/4=50% <60% 报 error
  });

  it('真实未落位明细仍报（口径行排除不掩盖真缺陷）', async () => {
    const model = tablesFactsModel(['项目编码', '项目名称', '单位', '工程量'], [
      ['030901010001', '挖一般土方', 'm3', '100'],
      ['030901010002', '混凝土管铺设', 'm', '80'],
      ['', '分部小计', '', ''],
    ]);
    const issues = await boqPlacementIssues('本工程完成挖一般土方施工。', [], model);
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain('清单项落位不足');
    expect(issues[0]!.message).toContain('/2 项');
    expect(issues[0]!.message).toContain('混凝土管铺设');
  });
});

describe('C-T5 落位口径（90% 阈值 + 显性说明审计 + 责任章标注）', () => {
  function tablesFactsModel(headers: string[], rows: string[][]): DocumentFactsModel {
    return {
      project: [], schedule: [], quality: [], safety: [], resources: [],
      drawings: [], rules: [], bills: [], preciseFacts: [], schemaFacts: {}, factIndex: {},
      missing: [], conflicts: [], specifications: [], canonical: { byKey: {} },
      tables: [{ headers, rows }],
    } as unknown as DocumentFactsModel;
  }

  const boqModel = (names: string[]) => tablesFactsModel(
    ['项目编码', '项目名称', '单位', '工程量'],
    names.map((name, index) => [`0309010100${String(index + 1).padStart(2, '0')}`, name, 'm3', '10']),
  );

  it('有效行处置率 85% 报不足（90% 阈值），90% 边界达标不报', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `测试条目${String(index + 1).padStart(2, '0')}`);
    const model = boqModel(names);
    const notEnough = await boqPlacementIssues(`本工程完成${names.slice(0, 17).join('、')}等施工。`, [], model);
    expect(notEnough).toHaveLength(1);
    expect(notEnough[0]!.message).toContain('/20 项');
    expect(notEnough[0]!.message).toContain('85%');
    const boundary = await boqPlacementIssues(`本工程完成${names.slice(0, 18).join('、')}等施工。`, [], model);
    expect(boundary).toEqual([]);
  });

  it('显性说明与豁免行登记进落位审计（区分说明式处置与施工内容落位）', async () => {
    const model = tablesFactsModel(['项目编码', '项目名称', '单位', '工程量'], [
      ['030901010001', '挖一般土方', 'm3', '100'],
      ['030901010002', '混凝土管铺设', 'm', '80'],
      ['030901010003', '回填方', 'm3', '50'],
      ['', '分部小计', '', ''],
    ]);
    const issues = await boqPlacementIssues('本工程完成挖一般土方施工。原有混凝土管铺设利旧使用，不另列施工方案。', [], model);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('2/3 项');
    expect(issues[0]!.suggestion).toContain('口径行 1 行');
    expect(issues[0]!.suggestion).toContain('显性说明 1 行');
  });

  it('未落位项标注责任章（行级任务清单驱动修复定位）', async () => {
    const model = tablesFactsModel(['项目编码', '项目名称', '单位', '工程量'], [
      ['030901010001', '排水管道铺设', 'm', '80'],
    ]);
    const chapters: DocumentDraftChapter[] = [
      { id: 'ch-3', title: '第三章 组织机构与资源配置', content: '', evidence: [], missingFacts: [] },
      { id: 'ch-5', title: '第五章 排水工程施工方案', content: '', evidence: [], missingFacts: [] },
    ];
    const issues = await boqPlacementIssues('本工程完成其他工作。', chapters, model);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('建议落位「第五章 排水工程施工方案」');
  });

  it('C3-5 挂靠锚点：error 带 provenance/blocker/repairability，未落位行按 unique 名称归并（×N 形态）', async () => {
    const model = tablesFactsModel(['项目编码', '项目名称', '单位', '工程量'], [
      ['030901010001', '混凝土管铺设', 'm', '80'],
      ['030901010002', '混凝土管铺设', 'm', '75'],
      ['030901010003', '混凝土管铺设', 'm', '70'],
      ['030901010004', '回填方', 'm3', '50'],
    ]);
    const issues = await boqPlacementIssues('本工程完成回填方施工。', [], model);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('error');
    expect(issues[0]!.severity).toBe('blocker');
    expect(issues[0]!.owner).toBe('llm');
    expect(issues[0]!.repairability).toBe('llm_repairable');
    expect(issues[0]!.provenance?.detectorId).toBe('boq-placement');
    // unique 名称归并：同名 3 行合并为 1 类（message 前 30 项截断窗口不被同类重复项占满，修复轮拿到完整义务清单）
    expect(issues[0]!.message).toContain('共3行/1类');
    expect(issues[0]!.message).toContain('混凝土管铺设×3');
  });
});

describe('formalContentIntegrityIssues 截断词表扩展（h13c）', () => {
  it('以「复查合格后」结尾且无句号 → 报截断句', () => {
    const issues = formalContentIntegrityIssues('材料进场检查发现不合格品立即隔离退场，复查合格后');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(true);
  });

  it('以「设计风」结尾（行尾截断形态）→ 报截断句', () => {
    const issues = formalContentIntegrityIssues('风管严密性试验压力按系统工作压力确定，实测风量与设计风');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(true);
  });

  it('完整成句（句号收尾）→ 不报截断句', () => {
    const issues = formalContentIntegrityIssues('质检员每周对库存材料进行1次状态检查，复查合格后方可投入使用。');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(false);
  });

  it('页码元信息：任何「PDF 第」形态（含空格数字完整引用）均报残留', () => {
    // 清洗链已归一完整引用并删残片，最终校验文本出现「PDF 第」即清洗缺口，不分形态全部报出
    expect(formalContentIntegrityIssues('详见招标文件PDF 第 3 页。').some(issue => /正文残留资料页码元信息/u.test(issue.message))).toBe(true);
    expect(formalContentIntegrityIssues('详见招标文件PDF 第。').some(issue => /正文残留资料页码元信息/u.test(issue.message))).toBe(true);
  });

  it('页码元信息：无 PDF 前缀的「第N页」引用同样报残留（第二分支）', () => {
    expect(formalContentIntegrityIssues('详见工程量清单第 5 页。').some(issue => /正文残留资料页码元信息/u.test(issue.message))).toBe(true);
  });

  it('页码元信息：页码范围「第 5-8 页」报残留', () => {
    expect(formalContentIntegrityIssues('详见施工图设计文件第 5-8 页。').some(issue => /正文残留资料页码元信息/u.test(issue.message))).toBe(true);
  });

  it('页码元信息：清洗后的正常引用「相关资料」不误报', () => {
    const issues = formalContentIntegrityIssues('详见招标文件、施工图设计文件、工程量清单及相关资料。');
    expect(issues.some(issue => /正文残留资料页码元信息/u.test(issue.message))).toBe(false);
  });
});

describe('formalPlaceholderIssues 占位式表达（h13c 词表扩展 + D-T5 口径统一）', () => {
  it('「依据本项目已确认资料」占位式表达 → 报', () => {
    const issues = formalPlaceholderIssues('锚杆注浆压力依据本项目已确认资料确定。');
    expect(issues.some(issue => /占位式表达/u.test(issue.message))).toBe(true);
  });

  it('正常事实表述 → 不报', () => {
    const issues = formalPlaceholderIssues('锚杆注浆压力按0.4MPa～0.6MPa控制。');
    expect(issues.some(issue => /占位式表达/u.test(issue.message))).toBe(false);
  });

  it('D-T5 #41：按资料/按文件/按说明 为留白 → 报（round-27 口径保留）', () => {
    expect(formalPlaceholderIssues('回填工艺按资料确定。').some(issue => /占位式表达/u.test(issue.message))).toBe(true);
    expect(formalPlaceholderIssues('管道基础处理按文件执行。').some(issue => /占位式表达/u.test(issue.message))).toBe(true);
  });

  it('D-T5 #41：按规范/按方案/按标准/按要求 为正常施组表述 → 不报（r28f 实测「按规范留置试块/按方案配置」误报归因）', () => {
    expect(formalPlaceholderIssues('试验员按规范留置标养与同条件试块。').some(issue => /占位式表达/u.test(issue.message))).toBe(false);
    expect(formalPlaceholderIssues('论证通过后按方案实施，应急物资按方案配置。').some(issue => /占位式表达/u.test(issue.message))).toBe(false);
  });

  it('D-T5 #42：表格数据格占位符豁免口径单源（豁免列「—」不报、非豁免列「待定/无」报）', () => {
    const exempted = [
      '| 序号 | 机械或设备名称 | 规格型号 | 数量 |',
      '| --- | --- | --- | --- |',
      '| 1 | 挖掘机 | — | 5台 |',
    ].join('\n');
    expect(formalPlaceholderIssues(exempted).some(issue => /占位式表达/u.test(issue.message))).toBe(false);
    const pending = [
      '| 序号 | 机械或设备名称 | 规格型号 | 数量 |',
      '| --- | --- | --- | --- |',
      '| 1 | 挖掘机 | — | 待定 |',
    ].join('\n');
    expect(formalPlaceholderIssues(pending).some(issue => /占位式表达：表格数据格占位符/u.test(issue.message))).toBe(true);
    const bareWu = [
      '| 序号 | 机械或设备名称 | 规格型号 | 数量 |',
      '| --- | --- | --- | --- |',
      '| 1 | 挖掘机 | 0.6~1.0m³ | 无 |',
    ].join('\n');
    expect(formalPlaceholderIssues(bareWu).some(issue => /占位式表达：表格数据格占位符/u.test(issue.message))).toBe(true);
  });

  it('D-T5 #42：合计行「—」豁免（不适用语义，警告层同源不报）', () => {
    const md = [
      '| 项目 | 数量 | 备注 |',
      '| --- | --- | --- |',
      '| 合计 | — | — |',
    ].join('\n');
    expect(formalPlaceholderIssues(md).some(issue => /占位式表达/u.test(issue.message))).toBe(false);
  });

  it('r28f 实测机械设备附表（9 列）逐字回归：#42 零误报（D-T5 验收形态）', () => {
    const table = [
      '| 序号 | 机械或设备名称 | 规格型号 | 数量 | 国别产地 | 制造年份 | 额定功率 | 生产能力 | 用于施工部位 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 1 | 挖掘机 | — | 5台 | 国产 | 2023 | — | — | 土方开挖、树穴开挖 |',
      '| 6 | 洒水车 | — | 5台 | 国产 | 2023 | — | 8m³/车 | 绿化养护浇水、降尘 |',
    ].join('\n');
    expect(formalPlaceholderIssues(table).filter(issue => /占位式表达/u.test(issue.message))).toEqual([]);
    expect(markdownTableQualityIssues(table).filter(issue => /占位符/u.test(issue.message))).toEqual([]);
  });

  it('C5 扩围：设备/仪器附表投产信息列「—」全豁免（s28l 实机 8 行×3 列 24 处误报；生成端如实留空不编造 vs 检测端阻断的口径冲突消解）', () => {
    // composeAppendices renderEquipmentAppendix/renderInstrumentAppendix 对国别产地/制造年份/
    // 额定功率/生产能力/用于施工部位硬编码「—」（投产信息如实留空不造数据），检测端豁免列未含
    // 投产信息列致阻断——豁免列与附表生成端表头对齐后生成端直出形态零命中
    const equipmentTable = [
      '| 序号 | 设备名称 | 型号规格 | 数量 | 国别产地 | 制造年份 | 额定功率（kW） | 生产能力 | 用于施工部位 | 备注 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 1 | 挖掘机 | 0.6~1.0m³ | 4-6 | — | — | — | — | — | 人机配合开挖 |',
      '| 2 | 振动压路机 | — | 4 | — | — | — | — | — | 路基碾压 |',
    ].join('\n');
    expect(scanTablePlaceholderCells(equipmentTable)).toEqual([]);
    expect(formalPlaceholderIssues(equipmentTable).filter(issue => /占位符/u.test(issue.message))).toEqual([]);
    expect(markdownTableQualityIssues(equipmentTable).filter(issue => /占位符/u.test(issue.message))).toEqual([]);
  });

  it('C5 扩围反例：豁免列仅认破折号形态 + 非豁免列占位词照报（防豁免过宽）', () => {
    // ①非豁免列（备注）「待定」——占位词任何行任何列不豁免
    const pendingRemark = [
      '| 序号 | 设备名称 | 型号规格 | 数量 | 国别产地 | 备注 |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 1 | 挖掘机 | — | 5台 | 国产 | 待定 |',
    ].join('\n');
    expect(scanTablePlaceholderCells(pendingRemark).some(hit => hit.cell === '待定')).toBe(true);
    // ②豁免列填非破折号占位词（「若干」）——投产信息列豁免仅限单个/多个破折号形态
    const vagueOrigin = [
      '| 序号 | 设备名称 | 型号规格 | 数量 | 国别产地 | 备注 |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 1 | 挖掘机 | 0.6~1.0m³ | 5台 | 若干 | 人机配合开挖 |',
    ].join('\n');
    expect(scanTablePlaceholderCells(vagueOrigin).some(hit => hit.cell === '若干')).toBe(true);
    expect(formalPlaceholderIssues(vagueOrigin).some(issue => /占位式表达：表格数据格占位符/u.test(issue.message))).toBe(true);
  });

  // ── C8 S4-③：业务过程记录列「无」豁免（r28m' 维保台账实锤：存在问题/整改措施/复查结果的「无」
  // 是业务判断结论（无问题/无需整改），非内容缺失占位符；豁免仅限「无」类，不扩到模糊量词） ──
  it('S4-③ 正样本：台账过程记录列「无」不判占位（表级零命中 + 函数级豁免，阻断层同源不报）', () => {
    const ledger = [
      '| 序号 | 检查部位 | 存在问题 | 整改措施 | 复查结果 |',
      '| --- | --- | --- | --- | --- |',
      '| 1 | 配电箱接线 | 无 | 无 | 合格 |',
      '| 2 | 临时用电线路 | 无 | 无 | 合格 |',
    ].join('\n');
    expect(scanTablePlaceholderCells(ledger)).toEqual([]);
    expect(markdownTableQualityIssues(ledger).filter(issue => /占位符/u.test(issue.message))).toEqual([]);
    expect(isNonExemptTablePlaceholderCell('无', { headerCell: '存在问题', cellIndex: 2 })).toBe(false);
    expect(isNonExemptTablePlaceholderCell('无', { headerCell: '整改措施', cellIndex: 3 })).toBe(false);
    expect(isNonExemptTablePlaceholderCell('无', { headerCell: '复查结果', cellIndex: 4 })).toBe(false);
  });

  it('S4-③ 反例：非业务列/无表头/非「无」占位词照报（防豁免过宽；「待定」类在任何列不豁免）', () => {
    expect(isNonExemptTablePlaceholderCell('无', { headerCell: '数量', cellIndex: 3 })).toBe(true);
    expect(isNonExemptTablePlaceholderCell('无', { cellIndex: 0 })).toBe(true);
    expect(isNonExemptTablePlaceholderCell('待定', { headerCell: '整改措施', cellIndex: 3 })).toBe(true);
    expect(isNonExemptTablePlaceholderCell('待补充', { headerCell: '复查结果', cellIndex: 4 })).toBe(true);
    const numberCellNone = [
      '| 序号 | 物资名称 | 规格 | 数量 | 备注 |',
      '| --- | --- | --- | --- | --- |',
      '| 1 | 中砂 | 中粗砂 | 无 | 按计划进场 |',
    ].join('\n');
    expect(scanTablePlaceholderCells(numberCellNone).some(hit => hit.cell === '无' && hit.cellIndex === 3)).toBe(true);
  });
});

describe('evaluationCriteriaCoreKeywords（4.12.12 核心词剥离残余条款编号）', () => {
  it('「1发包人…」编号残留被剥离，核心词不含「1」', () => {
    const keywords = evaluationCriteriaCoreKeywords('1发包人委派的发包人代表或监理工程师');
    expect(keywords.some(keyword => keyword.includes('发包人'))).toBe(true);
    expect(keywords.every(keyword => !/^\d/u.test(keyword))).toBe(true);
  });

  it('多级编号「1.1 拟采用的新技术」剥离编号（编号在前时前缀保留）', () => {
    expect(evaluationCriteriaCoreKeywords('1.1拟采用的新技术、新工艺')).toEqual(['拟采用的新技术', '新工艺']);
  });

  it('无编号标题核心词不受影响', () => {
    const keywords = evaluationCriteriaCoreKeywords('确保黄山杯奖项创建目标实现');
    expect(keywords.some(keyword => keyword.includes('黄山杯'))).toBe(true);
  });
});

describe('collectLayerNumbers 层厚度物理边界（4.19.5 真实回归：面层…2000mm 误当厚度权威）', () => {
  it('资料「面层平整度偏差不大于2000mm」+ 正文「面层厚度20mm」→ 不报冲突（2000 非厚度语义不成权威）', async () => {
    const issues = await processSpecConflictIssues('地面面层厚度20mm，随打随抹平。', specFactsModel('面层平整度偏差不大于2000mm'), embedDocuments);
    expect(issues).toHaveLength(0);
  });

  it('修复侧同源：正文 20mm 不被批量替换为 2000mm', async () => {
    const fixed = await applyDeterministicConsistencyFixesToMarkdown('地面面层厚度20mm，随打随抹平。', specFactsModel('面层平整度偏差不大于2000mm'), undefined, embedDocuments);
    expect(fixed.fixedCount).toBe(0);
    expect(fixed.markdown).toContain('20mm');
  });

  it('正常厚度（找平层 20mm vs 正文 15mm）仍报冲突并确定性替换', async () => {
    const issues = await processSpecConflictIssues('找平层厚度15mm，随浇随抹。', specFactsModel('找平层厚20mm'), embedDocuments);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('20mm');
    const fixed = await applyDeterministicConsistencyFixesToMarkdown('找平层厚度15mm，随浇随抹。', specFactsModel('找平层厚20mm'), undefined, embedDocuments);
    expect(fixed.markdown).toContain('20mm');
    expect(fixed.markdown).not.toContain('15mm');
  });

  it('边界内大厚度（垫层 800mm，<1000）仍参与一致性判定', async () => {
    const issues = await processSpecConflictIssues('混凝土垫层厚200mm。', specFactsModel('垫层厚800mm'), embedDocuments);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('800mm');
  });
});

describe('formalHeadingHierarchyIssues（P5 复选框符号残留检测）', () => {
  it('小节标题残留 ☑ 符号 → error/blocker（评分报告目录「8.2 ☑电子保函」串章回归）', () => {
    const markdown = [
      '## 目录',
      '',
      '## 第一章 工程概况',
      '### 1.1 编制依据',
      '## 第八章 其他说明',
      '### 8.1 农民工工资支付保障',
      '### 8.2 ☑电子保函',
    ].join('\n');
    const issues = formalHeadingHierarchyIssues(markdown);
    expect(issues.some(issue => issue.message.includes('复选框') && issue.severity === 'blocker')).toBe(true);
  });

  it('✓/□/○ 等变体符号同样命中', () => {
    const markdown = ['## 第一章 工程概况', '### 1.1 编制依据', '### ✓1.2 施工部署', '### □1.3 质量保证措施'].join('\n');
    const issues = formalHeadingHierarchyIssues(markdown);
    expect(issues.some(issue => issue.message.includes('复选框'))).toBe(true);
  });

  it('干净标题零报告', () => {
    const markdown = ['## 第一章 工程概况', '### 1.1 编制依据', '### 1.2 施工部署'].join('\n');
    expect(formalHeadingHierarchyIssues(markdown)).toEqual([]);
  });
});

describe('collectSectionContentGaps 分部章容器小节豁免（4.19.3 回归）', () => {
  it('division 章容器小节空壳被确定性删除后不报 missing_planned_section', () => {
    const markdown = ['## 第二章 主要施工方法', '### 绿化工程', '绿化工程正文'].join('\n');
    const gaps = collectSectionContentGaps(markdown, [
      { title: '主要施工方法', content: '### 绿化工程\n绿化工程正文', sections: ['绿化工程', '主要分部分项工程施工方案'] },
    ]);
    expect(gaps.some(gap => gap.reason === 'missing_planned_section' && /主要分部分项/u.test(gap.sectionTitle))).toBe(false);
  });

  it('非 division 章的容器小节缺失仍正常报 missing_planned_section', () => {
    const gaps = collectSectionContentGaps('### 1.1 编制依据\n编制依据正文', [
      { title: '工程概况', content: '### 1.1 编制依据\n编制依据正文', sections: ['项目主要施工内容'] },
    ]);
    expect(gaps.some(gap => gap.reason === 'missing_planned_section' && /项目主要施工内容/u.test(gap.sectionTitle))).toBe(true);
  });
});

describe('collectSectionContentGaps 近形小节判定（r28g A：规划/成稿一字差不再误判缺节）', () => {
  it('规划「安全责任体系与目标落位」 vs 成稿「…目标落实」→ 不报 missing_planned_section', () => {
    const body = ['### 7.1 安全责任体系与目标落实', '本章逐级签订安全生产责任书，明确各岗位安全职责与考核标准。'].join('\n');
    const gaps = collectSectionContentGaps(body, [
      { title: '安全责任体系与目标落实', content: body, sections: ['安全责任体系与目标落位', '安全生产费用保障与使用'] },
    ]);
    expect(gaps.some(gap => gap.reason === 'missing_planned_section' && /落位/u.test(gap.sectionTitle))).toBe(false);
  });

  it('反例：差异 ≥2 字（8 字标题预算 1）仍判真缺节（近形判定未过宽）', () => {
    const body = ['### 7.1 安全隐患排查制度', '每月开展隐患排查，建立台账并跟踪整改。'].join('\n');
    const gaps = collectSectionContentGaps(body, [
      { title: '安全隐患排查制度', content: body, sections: ['安全隐患排查治理'] },
    ]);
    expect(gaps.some(gap => gap.reason === 'missing_planned_section' && /排查治理/u.test(gap.sectionTitle))).toBe(true);
  });
});

describe('formalContentIntegrityIssues 列表形态豁免（B2）', () => {
  it('列表引导句行尾冒号不判截断', () => {
    const issues = formalContentIntegrityIssues('**编制依据**：招标文件与补疑补遗按以下类别列出：');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(false);
  });

  it('列表项行尾分号不判截断', () => {
    const issues = formalContentIntegrityIssues('- 招标文件及补疑补遗：招标文件、答疑纪要、补疑补遗文件；');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(false);
  });

  it('数字列表行行尾冒号不判截断', () => {
    const issues = formalContentIntegrityIssues('1. 招标文件及补疑补遗：招标文件、答疑纪要；');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(false);
  });

  it('普通段落行尾冒号且无引导词仍判截断（豁免不误伤）', () => {
    const issues = formalContentIntegrityIssues('施工现场平面布置原则：');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(true);
  });

  it('普通段落以「如下」结尾无句号仍判截断', () => {
    const issues = formalContentIntegrityIssues('本工程主要施工内容如下');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(true);
  });
});

/** 编制依据小节法规/规范完整性检测：法规由写作模型自行列写，检测只兑底「具体条目存在」（十度实测缺陷） */
describe('basisRegulationsCoverageIssues 编制依据法规/规范完整性兑底', () => {
  const blueprint = (location: string, basisRegulations: string[] = []): BlueprintData => ({ project: { location }, basisRegulations } as unknown as BlueprintData);
  const section = (body: string) => `## 第一章 编制依据与说明\n${body}\n## 第二章 工程概况`;

  it('完整法规清单（法+条例+规范）→ 无 issue', () => {
    const markdown = section('依据《中华人民共和国建筑法》（主席令第91号）、《建设工程质量管理条例》（国务院令第279号）、《给水排水管道工程施工及验收规范》（GB 50268-2008）等编制。');
    expect(basisRegulationsCoverageIssues(markdown)).toEqual([]);
  });

  it('无编制依据小节 → 静默跳过（模板结构差异不误伤）', () => {
    expect(basisRegulationsCoverageIssues('## 第一章 工程概况\n本项目位于肥西县。')).toEqual([]);
  });

  it('只写类别话术（无书名号法规）→ 报缺少国家法律法规与条例', () => {
    const markdown = section('本施组编制依据国家现行法律、行政法规、地方性法规及施工验收规范。');
    const issues = basisRegulationsCoverageIssues(markdown);
    expect(issues.some(issue => issue.message.includes('国家法律法规'))).toBe(true);
    expect(issues.some(issue => issue.message.includes('条例'))).toBe(true);
  });

  it('有法+条例但无验收规范 → 报缺少施工验收规范', () => {
    const markdown = section('依据《中华人民共和国建筑法》、《建设工程质量管理条例》编制。');
    const issues = basisRegulationsCoverageIssues(markdown);
    expect(issues.some(issue => issue.message.includes('验收规范'))).toBe(true);
  });

  it('规范只写编号形态（无书名号）同样通过', () => {
    const markdown = section('依据《中华人民共和国建筑法》、《建设工程质量管理条例》，施工质量验收执行 GB 50268-2008 等现行规范。');
    expect(basisRegulationsCoverageIssues(markdown)).toEqual([]);
  });

  it('建设地点含省/市但缺地方性法规 → 报缺少地方性法规', () => {
    const markdown = section('依据《中华人民共和国建筑法》、《建设工程质量管理条例》、《给水排水管道工程施工及验收规范》（GB 50268-2008）编制。');
    const issues = basisRegulationsCoverageIssues(markdown, blueprint('安徽省合肥市肥西县丰乐镇'));
    expect(issues.some(issue => issue.message.includes('地方性法规'))).toBe(true);
  });

  it('建设地点含省且列出含省名法规 → 通过', () => {
    const markdown = section('依据《中华人民共和国建筑法》、《建设工程质量管理条例》、《安徽省建筑市场管理条例》、《给水排水管道工程施工及验收规范》（GB 50268-2008）编制。');
    expect(basisRegulationsCoverageIssues(markdown, blueprint('安徽省合肥市肥西县丰乐镇'))).toEqual([]);
  });

  it('招标文件引用法规全部漏写 → 报未列招标文件引用法规', () => {
    const markdown = section('依据《中华人民共和国建筑法》、《建设工程质量管理条例》、《给水排水管道工程施工及验收规范》（GB 50268-2008）编制。');
    const issues = basisRegulationsCoverageIssues(markdown, blueprint('', ['《合肥市公共资源交易管理条例》']));
    expect(issues.some(issue => issue.message.includes('招标文件引用法规'))).toBe(true);
  });

  it('招标文件引用法规部分照抄 → 不阻断（≥1 条出现）', () => {
    const markdown = section('依据《中华人民共和国建筑法》、《合肥市公共资源交易管理条例》、《给水排水管道工程施工及验收规范》（GB 50268-2008）编制。');
    const issues = basisRegulationsCoverageIssues(markdown, blueprint('', ['《合肥市公共资源交易管理条例》']));
    expect(issues).toEqual([]);
  });

  it('r16 丰乐镇 B3-B7 复合标题抢占修复：「编制说明与工程概况」在前、「编制依据」在后 → 检查到依据小节', () => {
    // 修复前：单轮包含匹配命中首个「编制说明与工程概况」小节（无书名号）→ 5 项法规全报缺；
    // 修复后：两轮扫描先精确「编制依据」候选 → 真实依据小节被检查 → 零输出
    const markdown = '## 第一章 工程概况\n#### 1.1.1 编制说明与工程概况\n本工程为丰乐镇美丽宜居自然村建设项目，覆盖道路、污水、绿化三个板块。\n#### 1.1.2 编制依据\n依据《中华人民共和国建筑法》、《建设工程质量管理条例》、《给水排水管道工程施工及验收规范》（GB 50268-2008）编制。';
    expect(basisRegulationsCoverageIssues(markdown)).toEqual([]);
  });

  it('r16 B3-B7 反例：仅「编制说明」小节无书名号 → 仍按依据小节检查报缺（不静默漏检）', () => {
    // 无「编制依据」候选时退回「编制说明/编制原则/编制目的」候选，类别话术照报缺失
    const markdown = '## 第一章 工程概况\n#### 1.1.1 编制说明与工程概况\n本工程按国家现行法律、行政法规、地方性法规组织施工。';
    const issues = basisRegulationsCoverageIssues(markdown);
    expect(issues.some(issue => issue.message.includes('国家法律法规'))).toBe(true);
  });

  it('r28j 词锚第三轮：标题段无条目、真实清单以正文行+表格落在相邻标题段内 → 并集检查通过（消除误报）', () => {
    // r28i 工程概况实测形态（修复前 3 类缺失误报）：二轮「编制说明」段 0 书名号，真实清单表格在无关键词标题段内（正文行「编制依据涵盖…」词锚指向）
    const markdown = [
      '## 第一章 工程概况',
      '#### 1.1.1 编制说明与工程基本信息',
      '本工程位于安徽省合肥市肥西县，新建雨污水管网及道路硬化工程。',
      '#### 1.2 其他分部分项工程施工要点',
      '编制依据涵盖国家法律法规、地方法规、条例及施工验收规范：',
      '施工组织设计编制依据清单',
      '| 依据类别 | 具体名称及文号/编号 |',
      '| --- | --- |',
      '| 国家法律 | 《中华人民共和国建筑法》（主席令第29号） |',
      '| 行政法规 | 《建设工程质量管理条例》（国务院令第279号） |',
      '| 施工验收规范 | 《给水排水管道工程施工及验收规范》（GB 50268-2008） |',
    ].join('\n');
    expect(basisRegulationsCoverageIssues(markdown)).toEqual([]);
  });

  it('r28j 目录词锚防御：目录条目含「编制依据」字样但正文无清单 → 静默跳过（不误报）', () => {
    // 词锚行上方标题含「目录」→ 不参与候选；三路均无有效候选 → 静默（模板差异不误伤）
    const markdown = ['## 目录', '  1.1 编制依据', '## 第一章 工程概况', '本工程概况描述。'].join('\n');
    expect(basisRegulationsCoverageIssues(markdown)).toEqual([]);
  });

  it('r28j 词锚距离防护：词锚行距上方标题超过 60 行 → 不并入候选、照常报缺', () => {
    const filler = Array.from({ length: 62 }, (_, i) => `第 ${i} 行普通正文内容。`).join('\n');
    const markdown = [
      '## 第一章 工程概况',
      '#### 1.1.1 编制说明与工程概况',
      '本工程按国家现行法律、行政法规、地方性法规组织施工。',
      '#### 1.2 施工要点',
      filler,
      '编制依据涵盖如下：《中华人民共和国建筑法》、《建设工程质量管理条例》、《给水排水管道工程施工及验收规范》（GB 50268-2008）。',
    ].join('\n');
    const issues = basisRegulationsCoverageIssues(markdown);
    expect(issues.some(issue => issue.message.includes('国家法律法规'))).toBe(true);
  });

  it('r28j 词锚距离防护对偶：词锚行距上方标题 ≤60 行 → 并入候选、通过', () => {
    const filler = Array.from({ length: 50 }, (_, i) => `第 ${i} 行普通正文内容。`).join('\n');
    const markdown = [
      '## 第一章 工程概况',
      '#### 1.1.1 编制说明与工程概况',
      '本工程按国家现行法律、行政法规、地方性法规组织施工。',
      '#### 1.2 施工要点',
      filler,
      '编制依据涵盖如下：《中华人民共和国建筑法》、《建设工程质量管理条例》、《给水排水管道工程施工及验收规范》（GB 50268-2008）。',
    ].join('\n');
    expect(basisRegulationsCoverageIssues(markdown)).toEqual([]);
  });
});

/** 资源章数值拆分一致性兑底：工种构成/机械台数/同名多规格材料拆分与蓝图权威漂移即 error（十度实测缺陷） */
describe('resourceBreakdownConsistencyIssues 资源拆分一致性兑底', () => {
  const bp = (labor: any, equipment: any[] = [], materialsPlan: any[] = []): BlueprintData => ({ resources: { labor, equipment }, materialsPlan } as unknown as BlueprintData);

  it('工种构成与蓝图一致 → 无 issue', () => {
    const data = bp({ composition: [{ trade: '混凝土工', count: 12, basis: '' }, { trade: '钢筋工', count: 8, basis: '' }] });
    expect(resourceBreakdownConsistencyIssues('高峰期投入混凝土工12人、钢筋工8人。', data)).toEqual([]);
  });

  it('工种构成漂移 → 报不一致', () => {
    const data = bp({ composition: [{ trade: '混凝土工', count: 12, basis: '' }] });
    const issues = resourceBreakdownConsistencyIssues('高峰期投入混凝土工15人。', data);
    expect(issues.some(issue => issue.message.includes('工种构成'))).toBe(true);
  });

  it('「钢筋混凝土工」不误命「混凝土工」（前置汉字边界跳过）', () => {
    const data = bp({ composition: [{ trade: '混凝土工', count: 12, basis: '' }] });
    expect(resourceBreakdownConsistencyIssues('钢筋混凝土工班组负责主体结构。', data)).toEqual([]);
  });

  it('词表含复合工种「钢筋混凝土工」时不按子串「混凝土工」重复比对', () => {
    const data = bp({ composition: [{ trade: '钢筋混凝土工', count: 15, basis: '' }, { trade: '混凝土工', count: 12, basis: '' }] });
    expect(resourceBreakdownConsistencyIssues('高峰期投入钢筋混凝土工15人。', data)).toEqual([]);
  });

  it('机械台数与蓝图一致 → 无 issue', () => {
    const data = bp({ composition: [] }, [{ name: '挖掘机', quantity: 2, spec: '' }]);
    expect(resourceBreakdownConsistencyIssues('土方阶段配置挖掘机2台。', data)).toEqual([]);
  });

  it('机械台数漂移 → 报不一致', () => {
    const data = bp({ composition: [] }, [{ name: '挖掘机', quantity: 2, spec: '' }]);
    const issues = resourceBreakdownConsistencyIssues('土方阶段配置挖掘机3台。', data);
    expect(issues.some(issue => issue.message.includes('机械台数'))).toBe(true);
  });

  it('同名多规格机械按规格语境单独比对（不互串）', () => {
    const data = bp({ composition: [] }, [{ name: '挖掘机', quantity: 2, spec: '0.6m³' }, { name: '挖掘机', quantity: 1, spec: '1.0m³' }]);
    expect(resourceBreakdownConsistencyIssues('配置挖掘机（0.6m³）2台、挖掘机（1.0m³）1台。', data)).toEqual([]);
  });

  it('材料同名多规格拆分与蓝图一致 → 无 issue', () => {
    const data = bp({ composition: [] }, [], [{ name: '一般路灯', spec: '100W', quantity: 109, unit: '套', basis: '' }, { name: '一般路灯', spec: '120W', quantity: 9, unit: '套', basis: '' }]);
    expect(resourceBreakdownConsistencyIssues('一般路灯 100W 109套 + 120W 9套。', data)).toEqual([]);
  });

  it('材料拆分数量漂移 → 报不一致（丰乐镇实测 118=111+7 分配缺陷）', () => {
    const data = bp({ composition: [] }, [], [{ name: '一般路灯', spec: '100W', quantity: 109, unit: '套', basis: '' }, { name: '一般路灯', spec: '120W', quantity: 9, unit: '套', basis: '' }]);
    const issues = resourceBreakdownConsistencyIssues('一般路灯 100W 111套 + 120W 7套。', data);
    expect(issues.some(issue => issue.message.includes('材料规格拆分'))).toBe(true);
  });

  it('合计行豁免（组合计 118 套不按单规格比对）', () => {
    const data = bp({ composition: [] }, [], [{ name: '一般路灯', spec: '100W', quantity: 109, unit: '套', basis: '' }, { name: '一般路灯', spec: '120W', quantity: 9, unit: '套', basis: '' }]);
    expect(resourceBreakdownConsistencyIssues('| 合计 | 一般路灯 100W+120W | 118套 |', data)).toEqual([]);
  });

  it('阶段部署段落豁免（退场期 25+10+5+3=43=阶段总数）→ 无 issue', () => {
    const data = bp({ composition: [
      { trade: '普工', count: 45, basis: '' },
      { trade: '混凝土工', count: 88, basis: '' },
      { trade: '管道工', count: 34, basis: '' },
      { trade: '绿化工', count: 48, basis: '' },
    ] });
    const markdown = '亮化与收尾工程阶段投入43人，为退场收口期。普工25人负责收尾整修，混凝土工10人负责零星构件，管道工5人配合排查，绿化工3人进行场地恢复。';
    expect(resourceBreakdownConsistencyIssues(markdown, data)).toEqual([]);
  });

  it('机械分配语境（基线「其中3台」「1台转入」）→ 不误报', () => {
    const data = bp({ composition: [] }, [{ name: '挖掘机', quantity: 5, spec: '' }]);
    const markdown = '施工准备与清杂拆除阶段投入全部5台挖掘机，其中3台用于房前屋后整理与清杂，2台用于拆除路面及基层。污水管网工程阶段保留5台挖掘机用于沟槽开挖，1台转入沟塘清淤。';
    expect(resourceBreakdownConsistencyIssues(markdown, data)).toEqual([]);
  });

  it('同条目多处偏离 → 每条目最多一条 issue（label 去重）', () => {
    const data = bp({ composition: [{ trade: '混凝土工', count: 88, basis: '' }] });
    const issues = resourceBreakdownConsistencyIssues('投入混凝土工10人。\n\n另处混凝土工12人。', data);
    expect(issues.filter(issue => issue.message.includes('工种构成'))).toHaveLength(1);
  });

  it('无蓝图 → 静默跳过', () => {
    expect(resourceBreakdownConsistencyIssues('高峰期投入200人。')).toEqual([]);
  });
});

describe('punctuationArtifactIssues（十度：断句/残句/拼接错误确定性兑底）', () => {
  it('句读标点叠用「。；」 → error（丰乐镇实测「销项。；污水」形态）', () => {
    const issues = punctuationArtifactIssues('整改结果由项目经理复查确认后闭合。；污水管网工程阶段同时安排土方开挖。');
    expect(issues.some(issue => /句读标点叠用/u.test(issue.message))).toBe(true);
    expect(issues.every(issue => issue.level === 'error')).toBe(true);
  });

  it('连续句号「。。」 → error（省略号误写形态）', () => {
    const issues = punctuationArtifactIssues('质检员复查确认后销项。。材料员在每批材料进场后完成外观检查。');
    expect(issues.some(issue => /句读标点叠用/u.test(issue.message))).toBe(true);
  });

  it('全角括号不闭合（拼接丢失） → error', () => {
    const markdown = '国家法律法规包括《中华人民共和国建筑法》（主席令第91号公布，2019年修正）、《中华人民共和国招标投标法》（主席令第21号公布，2017安全生产法》（主席令第70号公布，2021年修正）。';
    const issues = punctuationArtifactIssues(markdown);
    expect(issues.some(issue => issue.message.includes('全角括号不闭合'))).toBe(true);
  });

  it('书名号不闭合（拼接丢失） → error（丰乐镇实测第 80 行）', () => {
    const markdown = '国家法律法规包括《中华人民共和国建筑法》（主席令第91号公布，2019年修正）、《中华人民共和国招标投标法》（主席令第21号公布，2017安全生产法》（主席令第70号公布，2021年修正）。';
    const issues = punctuationArtifactIssues(markdown);
    expect(issues.some(issue => issue.message.includes('书名号不闭合'))).toBe(true);
  });

  it('正常成稿（括号书名号成对、无标点叠用） → 零 issue', () => {
    const markdown = [
      '国家法律法规包括《中华人民共和国建筑法》（主席令第91号公布，2019年修正）、《建设工程质量管理条例》（国务院令第279号）。',
      '施工验收规范标准包括《城镇道路工程施工与质量验收规范》（CJJ 1-2008）。',
    ].join('\n');
    expect(punctuationArtifactIssues(markdown)).toEqual([]);
  });

  it('句号+右引号「。”」与省略号「……」不误报', () => {
    const markdown = '标准要求：“质量合格。”踏勘发现各自然村道路宽度普遍较窄……后续逐村复核。';
    expect(punctuationArtifactIssues(markdown)).toEqual([]);
  });

  it('表格行与标题行的标点形态不参与叠用检测（口径豁免）', () => {
    const markdown = '## 第1章 工程概况\n| 序号 | 内容 |\n| --- | --- |\n| 1 | 建设规模：道路硬化及亮化提升。； |\n';
    expect(punctuationArtifactIssues(markdown)).toEqual([]);
  });
});

// ── #44 关键参数抽查池类目轮转（4.44 根治：丰乐镇 4.43 实测「关键参数抽查 0/10（缺失如 103㎡、106㎡、1072㎡）」） ──

describe('criticalPreciseTokens 抽查池类目轮转（#44 根治）', () => {
  // 4.43 实测结构：面积小值（103/106/1072）、面积大值（28570.36/4646）、
  // 管径（DN1000/400/200）、规范编号（GB50647/GB13693）、强度（15.50kPa）、工期（90天）
  const poolInput = ['103㎡', '106㎡', '1072㎡', '28570.36㎡', '4646㎡', '15.50kPa', '90天', 'DN1000', 'DN200', 'DN400', 'GB50647-2011', 'GB13693-2005'];

  it('小面积值不再霸榜：类内数值降序使大值核心参数优先入选', () => {
    const pool = criticalPreciseTokens(poolInput);
    expect(pool).not.toContain('103㎡');
    expect(pool).not.toContain('106㎡');
    expect(pool).not.toContain('1072㎡');
    expect(pool).toContain('28570.36㎡');
    expect(pool).toContain('4646㎡');
  });

  it('跨类轮转：各类目代表均进入抽查池（规范编号/管径/强度/工期/面积）', () => {
    const pool = criticalPreciseTokens(poolInput);
    expect(pool).toEqual(['GB50647-2011', 'DN1000', '15.50kPa', '90天', '28570.36㎡', 'GB13693-2005', 'DN400', '4646㎡']);
  });

  it('确定性：同一集合不同输入顺序重跑池与顺序完全一致（消除提取顺序随机性）', () => {
    const shuffled = [...poolInput].reverse();
    expect(criticalPreciseTokens(shuffled)).toEqual(criticalPreciseTokens(poolInput));
  });

  it('边界：无 critical token 时回退常规 token 字典序前 2（0.01mm/0.5cm 回归）', () => {
    expect(criticalPreciseTokens(['0.5cm', '0.01mm'])).toEqual(['0.01mm', '0.5cm']);
  });
});

describe('preciseFactUsageIssues 端到端（#44 根治：缺失示例从字面序小值改为大值核心参数）', () => {
  const precisionFactsModel = (values: string[]): DocumentFactsModel => ({
    project: [], schedule: [], quality: [], safety: [], resources: [], tables: [],
    drawings: [], rules: [], bills: [], schemaFacts: {}, factIndex: {},
    missing: [], conflicts: [], specifications: [], canonical: { byKey: {} },
    preciseFacts: values.map(value => ({ key: '工程参数', fieldName: '', value, sourceFile: '清单.xlsx', roleId: 'precise_fact', confidence: 90 })),
  } as unknown as DocumentFactsModel);

  const poolValues = ['103㎡', '106㎡', '1072㎡', '28570.36㎡', '4646㎡', '15.50kPa', '90天', 'DN1000', 'DN200', 'DN400', 'GB50647-2011', 'GB13693-2005'];

  it('4.43 场景复现：命中 2/8 时缺失示例为大值面积/编号（小值 103㎡ 不再出现）', async () => {
    const message = (await preciseFactUsageIssues('管径DN1000，混凝土强度15.50kPa。', precisionFactsModel(poolValues)))
      .find(issue => issue.message.includes('关键参数抽查'))?.message ?? '';
    expect(message).toContain('关键参数抽查 2/8');
    expect(message).toContain('28570.36㎡');
    expect(message).not.toContain('103㎡');
  });

  it('对照：核心参数全部写入正文时命中率达标 → 不报关键参数 error', async () => {
    const markdown = '本项目总建筑面积28570.36㎡，道路铺装面积4646㎡，混凝土强度15.50kPa，设计管径DN1000、DN400、DN200，总工期90天，执行GB50647-2011与GB13693-2005。';
    const issues = await preciseFactUsageIssues(markdown, precisionFactsModel(poolValues));
    expect(issues.some(issue => issue.message.includes('关键参数抽查'))).toBe(false);
  });
});

// ── 4.49 r9 #12 根治：关键参数池清洗（裸单位碎片）+ 归一化匹配（形态假缺口） ──

describe('precise 抽查池清洗与归一匹配（4.49 r9 #12 根治）', () => {
  // 资料证据窗口（剔噪后 ≥20 token 池；含 2.4t/cm3 的裸单位碎片 cm3，改造前因含 m3 子串挤占体积类目抽查名额）
  const EVIDENCE_CONTENT = '素混凝土密度约2.4t/cm3，管径DN1000，混凝土强度15.50kPa，总建筑面积28570.36㎡，设计工期90天，道路铺装面积4646㎡，水稳层厚度200mm，压实度98%，沥青摊铺温度160℃，排水管DN400，检查井直径1250mm，沟槽深度3m，回填分层300mm，闭水试验压力0.1MPa，路灯间距30m，缆线规格YJV-4x25，人行道宽2m，标线宽150mm，路面厚度4cm，管线埋深1.2m，执行GB51192-2016与GB13693-2005等现行规范。';

  const evidenceChapter = (): DocumentDraftChapter => ({
    id: 'ev-1', title: '工程概况', content: '', missingFacts: [], sections: [],
    evidence: [{ chapterId: 'ev-1', filePath: '资料.pdf', score: 1, roleId: 'spec', content: EVIDENCE_CONTENT }],
  });

  const factsModel = { preciseFacts: [] } as unknown as DocumentFactsModel;

  it('裸单位碎片剔除：2.4t/cm3 的 cm3 不进抽查池（r9 实机「缺失如 cm3」归因）', () => {
    const missing = missingCriticalPreciseTokens('与参数无关的正文。', factsModel, [evidenceChapter()]);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).not.toContain('cm3');
  });

  it('归一化命中：平方米/日历天/破折号变体不再算缺失（形态假缺口消除）', () => {
    const markdown = '总建筑面积28570.36平方米，设计工期90日历天，执行GB51192—2016等现行国家规范。';
    const missing = missingCriticalPreciseTokens(markdown, factsModel, [evidenceChapter()]);
    expect(missing).not.toContain('28570.36㎡');
    expect(missing).not.toContain('90天');
    expect(missing).not.toContain('GB51192-2016');
  });
});

// ── r15 丰乐镇 B3：跨章设备台数配套比豁免（配套结构「每台挖掘机配1台自卸汽车」不采为口径值） ──

describe('crossChapterConsistencyIssues 设备台数配套比豁免（r15 丰乐镇 B3 根治）', () => {
  const emptyFacts = {
    project: [], schedule: [], quality: [], safety: [], resources: [], tables: [],
    drawings: [], rules: [], bills: [], preciseFacts: [], schemaFacts: {}, factIndex: {},
    missing: [], conflicts: [], specifications: [], canonical: { byKey: {} },
  } as unknown as DocumentFactsModel;

  it('配套比结构「每台挖掘机配1台自卸汽车」不采为台数口径（5 vs 1 假冲突收口，实况复刻）', async () => {
    // r15 实机阻断：全项目口径「挖掘机5台」与配套比「每台挖掘机配1台自卸汽车」的 1台 被正则
    // 同采为「挖掘机」口径 → [5,1] 互斥误报；isUnitPairRatioMatch 豁免后配套数不入互斥池
    const markdown = '主要机械台数执行全项目统一口径：挖掘机5台、自卸车5台、压路机5台。沟槽开挖采用挖掘机分组作业，每台挖掘机配1台自卸汽车循环装运。';
    const issues = await crossChapterConsistencyIssues(markdown, emptyFacts, undefined, undefined, embedDocuments);
    expect(issues.some(issue => /配置台数/u.test(issue.message))).toBe(false);
  });

  it('反例：无配套比语境的同设备多值仍报冲突（豁免不误放行）', async () => {
    const markdown = '主要机械台数执行全项目统一口径：挖掘机5台。沟槽开挖投入挖掘机1台。';
    const issues = await crossChapterConsistencyIssues(markdown, emptyFacts, undefined, undefined, embedDocuments);
    expect(issues.some(issue => /配置台数/u.test(issue.message))).toBe(true);
  });
});

// ── C-T4：跨章机械矩阵泛化（固定 7 词表 → 通用机械名抽取，共享 scanEquipmentCountClaims 单源） ──

describe('crossChapterConsistencyIssues 机械矩阵泛化（C-T4）', () => {
  const emptyFactsC4 = {
    project: [], schedule: [], quality: [], safety: [], resources: [], tables: [],
    drawings: [], rules: [], bills: [], preciseFacts: [], schemaFacts: {}, factIndex: {},
    missing: [], conflicts: [], specifications: [], canonical: { byKey: {} },
  } as unknown as DocumentFactsModel;
  const embedNone = async (texts: string[]) => texts.map(() => [0, 0]);

  it('词表外机械（提升泵）跨句台数多值互斥 → 报 error（泛化检测生效）', async () => {
    const markdown = '施工部署：土方阶段投入提升泵 2 台，主体阶段提升泵 3 台。';
    const issues = await crossChapterConsistencyIssues(markdown, emptyFactsC4, undefined, undefined, embedNone);
    expect(issues.some(issue => issue.message.includes('提升泵') && issue.level === 'error')).toBe(true);
  });

  it('配套比结构「每2台挖掘机配1台自卸汽车」不采为口径值（豁免在泛化后仍生效）', async () => {
    const markdown = '全项目统一口径：自卸汽车5辆、压路机5台。沟槽开挖采用每2台挖掘机配1台自卸汽车循环装运。';
    const issues = await crossChapterConsistencyIssues(markdown, emptyFactsC4, undefined, undefined, embedNone);
    expect(issues.some(issue => /配置台数|分组口径/u.test(issue.message))).toBe(false);
  });

  it('否定分句（不使用/无需）不采为口径宣称，正常配置保留不互斥', async () => {
    const markdown = '本项目不使用塔式起重机，无需另配发电机 1 台，现场配置发电机 2 台。';
    const issues = await crossChapterConsistencyIssues(markdown, emptyFactsC4, undefined, undefined, embedNone);
    expect(issues.filter(issue => issue.message.includes('发电机'))).toEqual([]);
  });
});

// ── C8 S4-①b：设备分组/调度声明豁免（s28m' 「按全项目总表调度」声明词与分组词同权） ──

describe('crossChapterConsistencyIssues 设备调度声明豁免（C8 S4-①b）', () => {
  const emptyFactsS4 = {
    project: [], schedule: [], quality: [], safety: [], resources: [], tables: [],
    drawings: [], rules: [], bills: [], preciseFacts: [], schemaFacts: {}, factIndex: {},
    missing: [], conflicts: [], specifications: [], canonical: { byKey: {} },
  } as unknown as DocumentFactsModel;
  const embedNone = async (texts: string[]) => texts.map(() => [0, 0]);

  it('正样本：数值后置的「按全项目总表调度」声明（不含「组」字）与分组词同权 → 降级 warning 不阻断', async () => {
    // s28m' 实锤：全项目口径 33台 与声明口径 8台 并存——「按全项目总表调度」声明词在数值之后
    // （s28m' 原文形态），此前仅按「组|村」窗口分类致声明不亮、普通池仍多值误报 blocker；
    // 声明词与分组词同权识别后同设备整体按分组口径提示降级（合法分层不硬阻断）
    const markdown = '全项目配置高清网络球形摄像机33台。高清网络球形摄像机8台按全项目总表调度。';
    const issues = await crossChapterConsistencyIssues(markdown, emptyFactsS4, undefined, undefined, embedNone);
    const equipment = issues.filter(issue => issue.message.includes('高清网络球形摄像机'));
    expect(equipment).toHaveLength(1);
    expect(equipment[0]!.level).toBe('warning');
    expect(equipment[0]!.message).toContain('设备分组口径提示');
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('高清网络球形摄像机'))).toBe(false);
  });

  it('反例：无任何声明语境的同设备多值维持 blocker（真冲突照报，零放松）', async () => {
    const markdown = '全项目配置高清网络球形摄像机33台。高清网络球形摄像机8台。';
    const issues = await crossChapterConsistencyIssues(markdown, emptyFactsS4, undefined, undefined, embedNone);
    const blocked = issues.filter(issue => issue.message.includes('高清网络球形摄像机'));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.severity).toBe('blocker');
    expect(blocked[0]!.message).toContain('配置台数出现互相矛盾的取值');
  });
});

// ── C8-7：声明句归因（非邻接形态）+ 清单多条目分层感知（s28m' 组2 复算残留误报） ──

describe('crossChapterConsistencyIssues 声明句归因与清单多条目分层（C8-7）', () => {
  const baseFactsC87 = {
    project: [], schedule: [], quality: [], safety: [], resources: [], tables: [],
    drawings: [], rules: [], bills: [], preciseFacts: [], schemaFacts: {}, factIndex: {},
    missing: [], conflicts: [], specifications: [], canonical: { byKey: {} },
  } as unknown as DocumentFactsModel;
  const embedNone = async (texts: string[]) => texts.map(() => [0, 0]);

  it('D 正样本：设备名与「本组配置…按全项目总表调度」同句但不邻接（声明计数不入 claim 扫描）→ 整体降级 warning', async () => {
    // s28m' 实锤：声明计数的设备名在上一分句（桥接超 12 字且含逗号/数字，claim 扫描不捕获该计数）——
    // 声明句归因按整句（。；;\n 边界）识别句内设备名，名称与声明同句即整体归因（与邻接形态同权）
    const markdown = '全项目配置高清网络球形摄像机11台，交通监控子系统配置高清网络球形摄像机8台。高清网络球形摄像机全景视频图像分辨率不小于3680×1656，内置不少于2个GPU芯片，本组配置8台，按全项目总表调度。';
    const issues = await crossChapterConsistencyIssues(markdown, baseFactsC87, undefined, undefined, embedNone);
    const equipment = issues.filter(issue => issue.message.includes('高清网络球形摄像机'));
    expect(equipment).toHaveLength(1);
    expect(equipment[0]!.level).toBe('warning');
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('高清网络球形摄像机'))).toBe(false);
  });

  it('D 反例：无声明句的同设备多值维持 blocker（真冲突照报，零放松）', async () => {
    const markdown = '全项目配置高清网络球形摄像机11台，交通监控子系统配置高清网络球形摄像机8台。';
    const issues = await crossChapterConsistencyIssues(markdown, baseFactsC87, undefined, undefined, embedNone);
    const equipment = issues.filter(issue => issue.message.includes('高清网络球形摄像机'));
    expect(equipment).toHaveLength(1);
    expect(equipment[0]!.severity).toBe('blocker');
  });

  it('B 正样本：清单多条目（8+3）且正文取值不超条目总和 → 降级 warning（清单原生分层）', async () => {
    // s28m' 实锤：摄像机清单 2 条（交通视频监控 8台 + 视频控制识别 3台），正文「部位明细+汇总」复述
    // 属清单原生分层（与 extractStreetLightAuthority 路灯多条目求和同源模式）
    const facts = {
      ...(baseFactsC87 as object),
      billItemFacts: [
        { key: '清单条目：交通视频监控', fieldName: '清单条目', value: '名称：高清网络球形摄像机（含云台功能）｜工程量：8台' },
        { key: '清单条目：视频控制识别', fieldName: '清单条目', value: '名称：高清网络球形摄像机（含云台功能）｜工程量：3台' },
      ],
    } as unknown as DocumentFactsModel;
    const markdown = '全项目配置高清网络球形摄像机11台，交通监控子系统配置高清网络球形摄像机8台。';
    const issues = await crossChapterConsistencyIssues(markdown, facts, undefined, undefined, embedNone);
    const equipment = issues.filter(issue => issue.message.includes('高清网络球形摄像机'));
    expect(equipment).toHaveLength(1);
    expect(equipment[0]!.level).toBe('warning');
  });

  it('B 反例：正文取值超清单条目总和 → 维持 blocker（零放松：超清单总量必为错误）', async () => {
    const facts = {
      ...(baseFactsC87 as object),
      billItemFacts: [
        { key: '清单条目：交通视频监控', fieldName: '清单条目', value: '名称：高清网络球形摄像机（含云台功能）｜工程量：8台' },
        { key: '清单条目：视频控制识别', fieldName: '清单条目', value: '名称：高清网络球形摄像机（含云台功能）｜工程量：3台' },
      ],
    } as unknown as DocumentFactsModel;
    const markdown = '全项目配置高清网络球形摄像机33台，交通监控子系统配置高清网络球形摄像机8台。';
    const issues = await crossChapterConsistencyIssues(markdown, facts, undefined, undefined, embedNone);
    const equipment = issues.filter(issue => issue.message.includes('高清网络球形摄像机'));
    expect(equipment).toHaveLength(1);
    expect(equipment[0]!.severity).toBe('blocker');
  });

  it('B 反例：清单仅单条目（无分层数据源）→ 维持 blocker（分母治理）', async () => {
    const facts = {
      ...(baseFactsC87 as object),
      billItemFacts: [
        { key: '清单条目：交通视频监控', fieldName: '清单条目', value: '名称：高清网络球形摄像机（含云台功能）｜工程量：11台' },
      ],
    } as unknown as DocumentFactsModel;
    const markdown = '全项目配置高清网络球形摄像机11台，交通监控子系统配置高清网络球形摄像机8台。';
    const issues = await crossChapterConsistencyIssues(markdown, facts, undefined, undefined, embedNone);
    const equipment = issues.filter(issue => issue.message.includes('高清网络球形摄像机'));
    expect(equipment).toHaveLength(1);
    expect(equipment[0]!.severity).toBe('blocker');
  });
});

// ── r28h M5：附表区（系统直出文末附表）不参与非法 H2 判定（s28h2 21 号误报回归） ──

describe('formalHeadingHierarchyIssues 附表区 H2 豁免', () => {
  const APPENDIX_MARKDOWN = [
    '## 第一章 工程概况',
    '### 1.1 编制依据',
    '## 附表一 拟投入本标段的主要施工设备表',
    '',
    '| 序号 | 设备名称 |',
    '| --- | --- |',
    '| 1 | 挖掘机 |',
    '## 附表二 拟配备本标段的试验和检测仪器设备表',
    '## 附表三 劳动力计划表',
  ].join('\n');

  it('附表一~N H2 与目录/附录同豁免，非正式章二级标题零报告', () => {
    const issues = formalHeadingHierarchyIssues(APPENDIX_MARKDOWN).filter(issue => issue.message.includes('非正式章二级标题'));
    expect(issues).toEqual([]);
  });

  it('负向对照：真非法 H2（无第X章/附录/附表前缀）仍上报', () => {
    const issues = formalHeadingHierarchyIssues(`${APPENDIX_MARKDOWN}\n## 悬挂小节标题\n\n正文`).filter(issue => issue.message.includes('非正式章二级标题'));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('悬挂小节标题');
  });
});

// ── r28h M7：重复 token 检测相邻性判定（s28h2 32/33 号误报回归） ──

describe('degenerateContentIssues 重复 token 相邻性（规格枚举不误报/真退化不丢失）', () => {
  /** s28h2 实测原文形态：DN 壁厚枚举 + 电缆规格枚举——数字与短单位在 token 表外，
   * 旧口径下「壁厚」「规格」伪相邻（全文 maxRun=15）双报 blocker */
  const SPEC_ENUMERATION = [
    '## 第一章 工程概况',
    '### 1.1 安装辅材与管材管件准备',
    '电缆保护管按规格分批组织，其中Φ110管（根）、DN32壁厚110mm管、DN50壁厚3.8mm管、DN150壁厚6mm管、DN80壁厚5mm管、DN25管、DN50壁厚3.0mm管100m、DN20壁厚2.75mm管36.07m，其余规格管材数量按各敷设区段设计长度与工程量清单锁定值分批核定。材料员在每批管材进场当日核对出厂合格证与规格标识，质检员按每批不少于1次抽测壁厚与外观，发现锈蚀、变形或壁厚偏差超标的整批退场。',
    '电力电缆总量14249.23m，其中3×10规格5260.98m、5×6规格3600m、5×10规格2204.02m、3×16规格575.14m、4×50规格360.21m、4×240规格320m、5×16规格300.58m、3×6规格269.45m、3×25规格267.17m、4×95规格210m、4×150规格155m、4×185规格90m、4×6规格80m、4×16规格70m、4×120规格10m，材料员按单体建立辅材台账同步核对。',
  ].join('\n');

  it('规格枚举行零报告（数字/短单位分隔的同名 token 不构成连续 run）', () => {
    expect(degenerateContentIssues(SPEC_ENUMERATION, [])).toEqual([]);
  });

  it('章节作用域：枚举形态在章/小节级同样零报告', () => {
    const chapters = [{ title: '工程概况', content: SPEC_ENUMERATION, sections: ['安装辅材与管材管件准备'] }] as unknown as DocumentDraftChapter[];
    expect(degenerateContentIssues(SPEC_ENUMERATION, chapters)).toEqual([]);
  });

  it('真退化护栏：空白分隔的紧邻重复 run≥12 仍报（召回不丢失）', () => {
    const filler = '施工准备、测量放线、材料进场、人员到场、设备调试、安全交底、技术交底、质量验收。'.repeat(4);
    const markdown = `## 第一章 测试章\n\n${filler}规格 规格 规格 规格 规格 规格 规格 规格 规格 规格 规格 规格 规格 规格全部按清单执行。`;
    const issues = degenerateContentIssues(markdown, []);
    expect(issues.some(issue => issue.message.includes('重复 token'))).toBe(true);
  });
});
