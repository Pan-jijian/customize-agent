/**
 * §L3-1~6 六个检测盲区·判据正反例单测（真实终稿取证见 l3-blindspots-evidence.manual.ts）。
 *
 * 规则（4.56 计划 3-d）：每条判据都要有正例与反例，反例必须是**机制上近邻**的合法形态
 * （同骨架不同数值 / 不同单体 / 表格说明句 / 子节域豁免），否则「零误报」只是判据太钝。
 * 其中 L3-5（paragraph-near-duplicate）已接入终检（detectorFixerRegistry + documentFinalValidation），
 * 其余五条经真实稿实测（零命中或误报类尚存）只保留判据与单测，未接入。
 */
import { describe, expect, it } from 'vitest';
import { gluedClauseIssues, scanStructureDefects, tailOrphanBlockIssues } from '@/services/document-workflow/structureIntegrityRules';
import { scanTableCaptionDefects, scanTableNumberingGaps, tableCaptionDefectIssues, tableNumberingGapIssues } from '@/services/document-workflow/constructionOrgTablePlan';
import { paragraphNearDuplicateIssues, scanParagraphNearDuplicates } from '@/services/document-workflow/integrity/detectors/detectors';
import { sectionProcessChainMixingIssues } from '@/services/document-workflow/constructionOrgQualityRules';
import { detectorEntry } from '@/services/document-workflow/detectorFixerRegistry';
import type { DocumentDraftChapter } from '@/services/document-workflow/types';

const TABLE = ['| 序号 | 项目 | 标准 |', '| --- | --- | --- |', '| 1 | 平整场地 | 241.71m² |'].join('\n');

describe('§L3-1 游离块（尾部无归属正文块）', () => {
  it('正例：文档以「表格 + 无标题管辖的裸块」结尾 → 命中', () => {
    const markdown = [
      '## 第一章 施工组织',
      '### 1.1 交叉施工协调',
      '协调事项按下表逐项锁定责任岗位与检查频次。',
      TABLE,
      '本项目重点难点：我方投标时补充完善危险性较大工程清单并明确相应的安全管理措施；',
    ].join('\n');
    const issues = tailOrphanBlockIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('游离正文块');
    // 硬约束：判据只给定位与处置方向，不产出替代内容
    expect(issues[0].suggestion).not.toContain('本项目重点难点：我方投标时');
  });

  it('反例①：块在最后一个小节标题之前 → 不命中（有归属）', () => {
    const markdown = [
      '## 第一章 施工组织',
      '本项目重点难点：我方投标时补充完善危险性较大工程清单并明确相应的安全管理措施；',
      '### 1.1 交叉施工协调',
      TABLE,
    ].join('\n');
    expect(tailOrphanBlockIssues(markdown)).toEqual([]);
  });

  it('反例②：块是对表格的说明（表格指代）→ 不命中', () => {
    const markdown = [
      '## 第一章 施工组织',
      '### 1.1 交叉施工协调',
      TABLE,
      '上表所列协调事项由生产经理每周组织专项检查，滞后事项限期整改并由技术负责人复查销项。',
    ].join('\n');
    expect(tailOrphanBlockIssues(markdown)).toEqual([]);
  });

  it('反例③：块与末尾表格共享实质数值（在复述表格内容）→ 不命中', () => {
    const markdown = [
      '## 第一章 施工组织',
      '### 1.1 交叉施工协调',
      TABLE,
      '平整场地工程量合计241.71m²，由测量员按检验批复核后报监理单位验收并留存记录。',
    ].join('\n');
    expect(tailOrphanBlockIssues(markdown)).toEqual([]);
  });

  it('反例④：文末裸块过短（<10 汉字，属题注/残片族）→ 不命中', () => {
    const markdown = ['## 第一章 施工组织', '### 1.1 x', TABLE, '详见附图。'].join('\n');
    expect(tailOrphanBlockIssues(markdown)).toEqual([]);
  });
});

describe('§L3-2 章内表号跳号', () => {
  const caption = (no: string, name: string) => `表${no} ${name}\n${TABLE}`;

  it('正例：章内表序 1、2、4 → 命中并列出缺号', () => {
    const markdown = [
      '## 第一章 施工组织',
      caption('1-1', '主要劳动力配置计划表'),
      caption('1-2', '主要材料进场计划表'),
      caption('1-4', '主要施工机械设备配置表'),
    ].join('\n');
    const gaps = scanTableNumberingGaps(markdown);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ chapterNo: 1, sequences: [1, 2, 4], missing: [3] });
    expect(tableNumberingGapIssues(markdown)[0].message).toContain('第 1 章表号跳号');
  });

  it('反例①：章内表序连续 → 不命中', () => {
    const markdown = [
      '## 第一章 施工组织',
      caption('1-1', '主要劳动力配置计划表'),
      caption('1-2', '主要材料进场计划表'),
      caption('1-3', '主要施工机械设备配置表'),
    ].join('\n');
    expect(scanTableNumberingGaps(markdown)).toEqual([]);
  });

  it('反例②：正文行内引用表号（「按表1-9 执行」）不构成题注实体 → 不命中', () => {
    const markdown = [
      '## 第一章 施工组织',
      caption('1-1', '主要劳动力配置计划表'),
      caption('1-2', '主要材料进场计划表'),
      '各工序质量验收标准按表1-9 执行，验收记录由质检员归档。',
    ].join('\n');
    expect(scanTableNumberingGaps(markdown)).toEqual([]);
  });
});

describe('§L3-3 表题残缺', () => {
  it('正例①：题名重复「表」字 → 命中', () => {
    const markdown = ['## 第一章 施工组织', `表1-2 表施工部署关键节点及责任分工表`, TABLE].join('\n');
    const defects = scanTableCaptionDefects(markdown);
    expect(defects).toHaveLength(1);
    expect(defects[0].kind).toBe('duplicated-prefix');
  });

  it('正例②：题名混入组织架构树残留符 → 命中', () => {
    const markdown = ['## 第一章 施工组织', '表2-5 └── 材料员、机械员', TABLE].join('\n');
    const defects = scanTableCaptionDefects(markdown);
    expect(defects).toHaveLength(1);
    expect(defects[0].kind).toBe('tree-residue');
    expect(tableCaptionDefectIssues(markdown)[0].message).toContain('表题残缺');
  });

  it('反例①：正常题注（名词性短语、无重复前缀）→ 不命中', () => {
    const markdown = ['## 第一章 施工组织', '表1-1 主要劳动力配置计划表', TABLE, '表1-2 主要材料进场计划与检验表', TABLE].join('\n');
    expect(scanTableCaptionDefects(markdown)).toEqual([]);
  });

  it('反例②：正文引用句（含句读、非题名）不入题注实体 → 不命中', () => {
    const markdown = ['## 第一章 施工组织', '表2-3 列要求执行，材料员与质检员依据该表纳入施工方案与作业流程管理。'].join('\n');
    expect(scanTableCaptionDefects(markdown)).toEqual([]);
  });
});

describe('§L3-4 句子粘连（整行零句读）', () => {
  it('正例：整行无句末标点 + 多顿号 + 多小句 → 命中', () => {
    const markdown = [
      '## 第一章 施工组织',
      '本工程执行的国家标准、行业标准、地方标准及企业标准共四类，其中《建筑施工组织设计规范》《建设工程施工现场管理规范》作为现场组织依据，施工中采用新技术、新工艺、新设备、新材料时须重新交底并报监理单位确认后实施',
    ].join('\n');
    const issues = gluedClauseIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('句子粘连');
  });

  it('反例①：同样列举但以句号收尾 → 不命中', () => {
    const markdown = [
      '## 第一章 施工组织',
      '本工程执行的国家标准、行业标准、地方标准及企业标准共四类，其中《建筑施工组织设计规范》《建设工程施工现场管理规范》作为现场组织依据，施工中采用新技术、新工艺、新设备、新材料时须重新交底并报监理单位确认后实施。',
    ].join('\n');
    expect(gluedClauseIssues(markdown)).toEqual([]);
  });

  it('反例②：顿号不足（非枚举行）→ 不命中', () => {
    const markdown = [
      '## 第一章 施工组织',
      '本工程执行的国家标准与行业标准作为现场组织依据，施工中采用新技术时须重新交底并报监理单位确认后实施，交底记录由资料员归档保存备查',
    ].join('\n');
    expect(gluedClauseIssues(markdown)).toEqual([]);
  });

  it('反例③：标题行/表格行不入池 → 不命中', () => {
    const markdown = ['## 第一章 施工组织', '| 工序 | 标准 | 责任岗位 |', '| --- | --- | --- |'].join('\n');
    expect(gluedClauseIssues(markdown)).toEqual([]);
  });
});

describe('§L3-5 段落级近似重复（已接入终检）', () => {
  const lineA = '2#门卫零星装饰工程涵盖金属栏杆、玻璃栏板、成品隔断、洗漱台及花岗岩沟盖板等分项，工程量分别为金属栏杆78.7m、玻璃栏板561.92m、成品隔断146.89m、花岗岩沟盖板196.53m，均由施工员按检验批复核后报质检员销项。';
  const lineB = '2#门卫零星装饰工程金属栏杆78.7m、玻璃栏板561.92m、成品隔断146.89m、花岗岩沟盖板196.53m，由施工员按检验批复核后报质检员销项，安装完成后留存影像资料并报监理单位验收。';
  const doc = (left: string, right: string) => ['## 第一章 施工组织', '### 1.1 零星装饰', left, '### 1.2 分项汇总', right].join('\n');

  it('正例：同骨架 + 同批量数值（同对象集）→ 命中', () => {
    const hits = scanParagraphNearDuplicates(doc(lineA, lineB));
    expect(hits).toHaveLength(1);
    expect(hits[0].skeletonJaccard).toBeGreaterThanOrEqual(0.3);
    expect(hits[0].numberOverlap).toBeGreaterThanOrEqual(0.6);
    expect(hits[0]).toMatchObject({ firstLine: 3, secondLine: 5 });
    const issues = paragraphNearDuplicateIssues(doc(lineA, lineB));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'error', severity: 'blocker', category: 'style', owner: 'llm' });
    // 硬约束：只报不删，不产出替代内容（suggestion 只给处置方向，不含任何被报行的原文）
    expect(issues[0].suggestion).not.toContain('金属栏杆78.7m');
    expect(issues[0].message).not.toContain('由施工员按检验批复核后报质检员销项。');
  });

  it('反例①：骨架一致但两处数值只有部分重叠（交并比 <0.6，不同批量）→ 不命中', () => {
    // 骨架 Jaccard 与正例完全相同（掩码把数字整体替换为 `#`，换数字不改骨架），
    // 故是否命中只由「同对象集」（数值交集/交并比）决定 —— 判据②独立于判据①
    const shiftedBatch = lineB.replace(/78\.7m/gu, '91.2m').replace(/561\.92m/gu, '420.1m');
    expect(scanParagraphNearDuplicates(doc(lineA, shiftedBatch))).toEqual([]);
  });

  it('反例②：骨架与数值全同、但只共享 1 个实质数值 → 不命中', () => {
    const oneShared = lineB.replace('玻璃栏板561.92m', '玻璃栏板420.1m').replace('成品隔断146.89m', '成品隔断77.3m').replace('花岗岩沟盖板196.53m', '花岗岩沟盖板88.1m');
    expect(scanParagraphNearDuplicates(doc(oneShared, lineA))).toEqual([]);
  });

  it('反例③：骨架与数值全相同、但两块点名不同单体工程（模板句式）→ 不命中；同单体则命中（对照）', () => {
    const otherUnit = lineB.replace('2#门卫', '3#门卫');
    expect(scanParagraphNearDuplicates(doc(otherUnit, lineA))).toEqual([]);
    // 对照：仅把单体标识改为同值，其余一字不动 → 命中（证明抑制来自单体互斥，而非相似度不足）
    expect(scanParagraphNearDuplicates(doc(lineB, lineA))).toHaveLength(1);
  });

  it('反例④：短行（<40 汉字）不入池 → 不命中', () => {
    const markdown = ['## 第一章 施工组织', '金属栏杆78.7m、玻璃栏板561.92m。', '### 1.2 x', '金属栏杆78.7m、玻璃栏板561.92m。'].join('\n');
    expect(scanParagraphNearDuplicates(markdown)).toEqual([]);
  });

  it('幂等与守恒：同一输入重复扫描结果完全一致，且不修改输入文本', () => {
    const markdown = doc(lineA, lineB);
    const snapshot = markdown;
    expect(scanParagraphNearDuplicates(markdown)).toEqual(scanParagraphNearDuplicates(markdown));
    expect(paragraphNearDuplicateIssues(markdown).length).toBe(paragraphNearDuplicateIssues(markdown).length);
    expect(markdown).toBe(snapshot);
  });

  it('注册表处置声明：无确定性修复器 → 显式 manual（收敛=人工复核载体）', () => {
    expect(detectorEntry('paragraph-near-duplicate')?.fixerDisposition).toBe('manual');
    expect(detectorEntry('paragraph-near-duplicate')?.fixerDispositionReason || '').not.toBe('');
  });
});

describe('§L3-6 工序域混杂（放宽判据：域继承 + 子节域豁免）', () => {
  const chapter = (title: string, content: string) => ([{ id: title, title, content, sections: [] } as unknown as DocumentDraftChapter]);

  it('正例：域内节出现非本域工序词（域词取自节标题，阈值 ≥1）→ 命中', () => {
    const chapters = chapter('## 第一章 市政道路工程', [
      '### 1.1 道路工程施工',
      '本工程道路工程按交通导改、沟槽开挖、管道敷设、水稳基层、沥青面层组织施工，其中塔吊布置须覆盖全部作业面并编制专项方案。',
    ].join('\n'));
    const issues = sectionProcessChainMixingIssues(chapters);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ sectionTitle: '1.1 道路工程施工', domain: 'municipal' });
    expect(issues[0].forbiddenHits).toContain('塔吊');
  });

  it('正例②：节标题无域词时由章标题继承域（同一条内容，章标题提供域）→ 命中', () => {
    const chapters = chapter('## 第二章 老旧小区改造工程', [
      '### 2.3 施工部署',
      '本工程按分区流水组织施工，其中高支模支撑体系须单独编制专项方案并组织专家论证。',
    ].join('\n'));
    const issues = sectionProcessChainMixingIssues(chapters);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ sectionTitle: '2.3 施工部署', domain: 'renovation' });
  });

  it('反例①：禁配工序落在其他域子节内（独立单位工程）→ 子节豁免，不命中', () => {
    const chapters = chapter('## 第一章 3#门卫土建零星装饰工程', [
      '### 1.25 3#门卫土建零星装饰工程',
      '本零星装饰工程含楼地面、墙柱面、天棚及成品保护工序，由质检员逐项验收销项。',
      '#### 1.25.5 沥青道路',
      '沥青道路按路基压实、水稳层摊铺、沥青摊铺工序组织施工。',
    ].join('\n'));
    expect(sectionProcessChainMixingIssues(chapters)).toEqual([]);
  });

  it('反例②：节标题无域词且章标题亦无域词 → 整节豁免，不命中', () => {
    const chapters = chapter('## 第三章 施工部署', [
      '### 3.1 施工顺序安排',
      '本工程按先地下后地上原则组织施工，沥青摊铺安排在道路结构层验收合格后进行。',
    ].join('\n'));
    expect(sectionProcessChainMixingIssues(chapters)).toEqual([]);
  });
});

describe('盲区判据与既有扫描器无重复报出（§L3-1 尾块 vs 截断族）', () => {
  it('尾部裸块若同时是段末无句读行，截断族与游离块各按自身判据报出（族分工，不互相吞并）', () => {
    const markdown = [
      '## 第一章 施工组织',
      '### 1.1 交叉施工协调',
      TABLE,
      '本项目危险性较大的分部分项工程清单：基坑工程、模板支撑体系工程、起重吊装及安装拆卸工程、钢结构安装工程等；',
    ].join('\n');
    expect(tailOrphanBlockIssues(markdown)).toHaveLength(1);
    expect(scanStructureDefects(markdown).blocking.some(defect => defect.kind === 'truncated-line')).toBe(false);
  });
});
