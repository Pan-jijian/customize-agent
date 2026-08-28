import { describe, expect, it } from 'vitest';
import { comparableSectionHeadingMatches, extractSection } from '../src/services/document-workflow/utils';
import { normalizeWorkPackageLabels } from '../src/services/document-workflow/documentGeneratorHelpers';
import { buildFinalGateRepairQualityFeedback, replaceMarkdownSection } from '../src/services/document-workflow/documentPipeline';

// 九度实测缺陷复现：fuzzy 定位短串误命中——
// ①“主要施工方法”与“施工方法”归一化同为“方法”（先删“施工”再删“主要”），=== 命中把“#### 施工方法”H4 块（360 字）
//   误当“主要施工方法”小节报“正文不足 blocker”，而 Final Gate 补写的 4600 字稿被 replaceMarkdownSection
//   反向包含（sectionTitle.includes(headingTitle)）替换进该 H4 块且标题被剥离后丢失；
// ②“危大工程专项施工方案审批流程”归一化为“危大方案审批流程”，comparableTitle.includes('流程') 把
//   “#### 施工流程”块（79 字）误当危大小节报“正文不足 blocker”（真正危大小节在另一章 1900 字达标）。
// 修复：comparableSectionHeadingMatches 空串/短串（<4 字）排除，三处替换定位同口径收敛。

describe('comparableSectionHeadingMatches（空串/短串误命中防护）', () => {
  it('“主要施工方法”与“施工方法”归一化为同短串“方法”时不匹配任何标题', () => {
    expect(comparableSectionHeadingMatches('施工方法', '主要施工方法')).toBe(false);
    expect(comparableSectionHeadingMatches('主要分部分项工程施工方案', '主要施工方法')).toBe(false);
    expect(comparableSectionHeadingMatches('施工流程', '主要施工方法')).toBe(false);
  });

  it('“#### 施工方法”标题不匹配“主要施工方法”（九度 4600 字稿丢失根因）', () => {
    expect(comparableSectionHeadingMatches('施工方法', '主要施工方法')).toBe(false);
  });

  it('短串“流程”不命中“危大工程专项施工方案审批流程”（九度 79 字误报根因）', () => {
    expect(comparableSectionHeadingMatches('施工流程', '危大工程专项施工方案审批流程')).toBe(false);
  });

  it('归一化 ≥4 字的可比标题仍能命中（语义重写场景不回归）', () => {
    expect(comparableSectionHeadingMatches('项目重点难点分析', '项目特点、重点、难点分析')).toBe(true);
  });

  it('包含判断命中保留（双方归一化长度均 ≥4）', () => {
    expect(comparableSectionHeadingMatches('专项方案审批流程', '危大工程专项施工方案审批流程')).toBe(true);
  });
});

describe('extractSection fuzzy（九度 blocker4/5 误报修复）', () => {
  const content = [
    '### 全线现场踏勘与地下管线探测',
    '',
    '#### 踏勘范围与管线探测对象',
    '本项目位于历史文化街区核心区，施工前由技术负责人组织踏勘。',
    '',
    '#### 施工概况',
    '本工程为徽光阁既有建筑改造项目，总建筑面积约4646㎡。',
    '',
    '#### 施工流程',
    '原结构表面清理→裂缝普查与标识→加固部位放线定位→基层凿毛处理→植筋钻孔→清孔除尘→注胶植筋→钢筋绑扎→模板支设→灌浆料浇筑→养护→外观及强度检测→隐蔽验收。',
    '',
    '#### 施工方法',
    '我公司项目部对开裂结构及墙体加固补强作为本工程质量控制关键环节。施工前由技术负责人组织施工员、质检员对原结构裂缝逐条普查，采用裂缝宽度观测仪量测，裂缝宽度大于0.3mm的采用压力注浆封闭，注浆压力控制在0.2～0.4MPa。植筋钻孔直径按钢筋直径加4mm控制，钻孔深度不小于15d（d为钢筋直径），清孔采用压缩空气吹孔不少于3次，植筋胶饱满度以孔口溢胶为准。新增混凝土采用C35灌浆料浇筑，浇筑厚度每层不大于500mm，振捣采用φ30mm插入式振捣棒，振捣间距不大于400mm。模板拆除后养护不少于7天，同条件试块抗压强。',
    '',
    '#### 管线保护与损坏处置',
    '对施工影响范围内的既有杆线，按“先支撑、后开挖、再回填”顺序实施保护。',
  ].join('\n');

  it('无“主要施工方法”标题时 fuzzy 不再把“#### 施工方法”块误当小节（360 字误报根因）', () => {
    expect(extractSection(content, '主要施工方法', { fuzzy: true })).toBe('');
  });

  it('“危大工程专项施工方案审批流程”不再误命中“#### 施工流程”块（79 字误报根因）', () => {
    expect(extractSection(content, '危大工程专项施工方案审批流程', { fuzzy: true })).toBe('');
  });

  it('真实存在的标题仍能 fuzzy 命中（语义重写场景不回归）', () => {
    const rewritten = '### 项目重点难点分析\n本工程位于历史文化街区核心区，涉及室外道排改造及室内外水电接驳，重点难点在于营业商铺保障与既有管线保护，难点集中在分段围蔽与交通疏导。';
    const hit = extractSection(rewritten, '项目特点、重点、难点分析', { fuzzy: true });
    expect(hit.length).toBeGreaterThan(0);
  });
});

describe('normalizeWorkPackageLabels（畸形标签归一化）', () => {
  it('粗体伪标签归一为纯文本标签', () => {
    const input = '**施工概况**：本工程位于历史文化街区。\n**施工流程**：基层清理→放线定位→养护→验收\n**施工方法**：采用专用机具，养护7天。';
    const normalized = normalizeWorkPackageLabels(input);
    expect(normalized).toContain('施工概况：本工程位于历史文化街区');
    expect(normalized).toContain('施工流程：基层清理→放线定位→养护→验收');
    expect(normalized).toContain('施工方法：采用专用机具，养护7天');
    expect(normalized).not.toContain('**施工概况**');
    expect(normalized).not.toContain('**施工流程**');
    expect(normalized).not.toContain('**施工方法**');
  });

  it('重复标签形态归一为单标签', () => {
    const input = '施工概况：**施工概况**：本工程结构加固改造对象为地上三层框架结构既有建筑。';
    const normalized = normalizeWorkPackageLabels(input);
    expect(normalized).toBe('施工概况：本工程结构加固改造对象为地上三层框架结构既有建筑。');
  });

  it('正文中非标签粗体不受影响', () => {
    const input = '施工概况：本工程按**先内后外**顺序组织施工。';
    expect(normalizeWorkPackageLabels(input)).toBe(input);
  });

  it('纯文本标签原样保留', () => {
    const input = '施工概况：本工程位于历史文化街区。\n施工流程：A→B→C→D\n施工方法：内容。';
    expect(normalizeWorkPackageLabels(input)).toBe(input);
  });
});

describe('replaceMarkdownSection（反向包含误命中修复）', () => {
  const content = [
    '### 全线现场踏勘与地下管线探测',
    '',
    '#### 踏勘范围与管线探测对象',
    '本项目位于历史文化街区核心区。',
    '',
    '#### 施工方法',
    '施工前由技术负责人组织施工员对原结构裂缝逐条普查。',
    '',
    '#### 管线保护与损坏处置',
    '对施工影响范围内的既有杆线实施保护。',
  ].join('\n');

  it('“#### 施工方法”H4 块不再被“主要施工方法”补写稿误替换', () => {
    const replacement = '### 主要施工方法\n补写正文内容，落位量化参数与检查验收要求。';
    const next = replaceMarkdownSection(content, '主要施工方法', replacement);
    // 未定位到真实“### 主要施工方法”标题：原文保持不变（此前反向包含会误替换 H4 块并剥离标题）
    expect(next).toBe(content);
    expect(next).toContain('#### 施工方法');
  });

  it('真实标题小节仍能正常替换', () => {
    const content2 = '### 施工部署\n部署内容。\n\n### 主要施工方法\n旧方法内容。';
    const next = replaceMarkdownSection(content2, '主要施工方法', '### 主要施工方法\n新方法内容，含量化参数。');
    expect(next).toContain('新方法内容，含量化参数');
    expect(next).not.toContain('旧方法内容');
  });
});

describe('buildFinalGateRepairQualityFeedback（九度 prompt 强化）', () => {
  it('分部分项小节注入标签形态禁令与链回退要求', () => {
    const feedback = buildFinalGateRepairQualityFeedback('主要分部分项工程施工方案');
    expect(feedback).toContain('严禁粗体包裹');
    expect(feedback).toContain('重复前缀');
    expect(feedback).toContain('施工流程段至少 1 条');
    expect(feedback).toContain('施工方法段内也必须包含一条工序链');
  });

  it('小分项参数类型示例注入（拆除/门窗维修类）', () => {
    const feedback = buildFinalGateRepairQualityFeedback('主要分部分项工程施工方案');
    expect(feedback).toContain('拆除面积㎡');
    expect(feedback).toContain('启闭力N');
    expect(feedback).toContain('更换数量樘');
  });
});
