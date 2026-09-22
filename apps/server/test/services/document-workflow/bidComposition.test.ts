import { describe, expect, it } from 'vitest';
import {
  appendixKindAndSource,
  bidCompositionSummary,
  bidCompositionWritingRules,
  bodyTableDismantleIssue,
  extractBidCompositionSpec,
  isBodyFigureForbidden,
  isBodyTableForbidden,
  unplannedBodyTableIssue,
  applyFormatRulesToExportSettings,
} from '@/services/document-workflow/bidComposition';

/**
 * 暗标招标文件 fixture（舒城语序浓缩）：勾选证据 + 禁符号句（排版条款）+ 表格允许句 + 6 项文末附表 +
 * 格式要求全项 + 身份禁语。C1 口径：该 fixture 无显式禁表句——「正文内不允许出现非文字需要的其他
 * 任何符号和标志」属排版条款，正文表格政策应为 allowed（与舒城招标实证一致：招标明确允许正文图表）。
 */
const BLIND_TENDER = [
  '本项目施工组织设计采用：□明标。☑暗标。',
  '暗标评审项目的编制要求：正文内不允许出现非文字需要的其他任何符号和标志。不得有图片和扉页。',
  '除文字表述外可附下列图表，图表及格式要求附后。',
  '附表一 拟投入本标段的主要施工设备表',
  '附表二 拟配备本标段的试验和检测仪器设备表',
  '附表三 拟配备本标段的劳动力计划表',
  '附表四 计划开、竣工日期和施工进度网络图',
  '附表五 施工总平面图',
  '附表六 临时用地表',
  '正文一律采用小四号宋体，大标题用小三号黑体。',
  '装订线 0.3-0.6cm，行间距为固定值25磅。',
  '总页数上限：200 页。一律单黑色，不设内封面，不需编制页眉、页脚、页码。',
  '任何部位、任何条文出现明示或暗示具体投标人的说明及标记（包括以往的施工业绩等）。',
].join('\n');

/**
 * 显式禁表句 fixture（C1 三态判定之 forbidden 态）：勾选证据 + 显式禁表句 + 文末附表引导句 + 3 项附表，
 * 与 BLIND_TENDER 的允许口径形成正反对照（冲突裁决与拆表/写作规则口径的测试输入）。
 */
const EXPLICIT_FORBID_TENDER = [
  '本项目施工组织设计采用：☑暗标。',
  '正文不得出现表格。',
  '本项目需提交下列附表，图表及格式要求附后。',
  '附表一 拟投入本标段的主要施工设备表',
  '附表二 拟配备本标段的试验和检测仪器设备表',
  '附表三 拟配备本标段的劳动力计划表',
].join('\n');

/** 最小暗标（仅勾选证据：无格式要求/附表/身份禁语） */
const MINIMAL_BLIND = '本项目施工组织设计采用：☑暗标。';

describe('extractBidCompositionSpec（标书类型识别）', () => {
  const spec = extractBidCompositionSpec({ tenderTexts: [BLIND_TENDER] });

  it('勾选证据优先：☑暗标 → blind；正文表格按允许句判 allowed（舒城实证）；禁图片；证据逐条留存', () => {
    expect(spec.bidType).toBe('blind');
    expect(spec.bodyTablePolicy).toBe('allowed');
    expect(spec.bodyFigurePolicy).toBe('forbidden');
    expect(spec.evidence.some(item => item.includes('标书类型勾选证据'))).toBe(true);
    expect(spec.evidence.some(item => item.includes('正文内不允许'))).toBe(true);
    expect(spec.evidence.some(item => item.includes('除文字表述外可附下列图表'))).toBe(true);
  });

  it('文末附表清单 6 项且编号/分类/数据源逐项绑定（C2：图类附表亦绑蓝图数据源）', () => {
    expect(spec.appendixPlan.map(item => [item.no, item.kind, item.dataSource])).toEqual([
      ['一', 'table', 'blueprint.equipment'],
      ['二', 'table', 'blueprint.testInstruments'],
      ['三', 'table', 'blueprint.labor'],
      ['四', 'figure', 'blueprint.schedule'],
      ['五', 'figure', 'blueprint.tempLand'],
      ['六', 'table', 'blueprint.tempLand'],
    ]);
    expect(spec.appendixPlan[0].title).toBe('附表一 拟投入本标段的主要施工设备表');
  });

  it('格式要求全项提取（字体/装订线/行距/页数上限/单黑色/封面/页眉页脚）+ 身份禁语', () => {
    expect(spec.formatRules).toMatchObject({
      bodySize: '小四号',
      bodyFont: '宋体',
      headingSize: '小三号',
      headingFont: '黑体',
      gutter: '0.3-0.6cm',
      lineHeight: '固定值25磅',
      pageLimit: 200,
      monoColor: true,
      cover: 'forbidden',
      headersFooters: 'forbidden',
    });
    expect(spec.identityMarksForbidden).toBe(true);
  });

  it('无勾选标记时的结构证据：「暗标评审项目的编制要求」章节同样判定为盲标', () => {
    const structured = extractBidCompositionSpec({
      tenderTexts: ['本工程执行暗标评审项目的编制要求，投标文件分为明标和暗标两部分。'],
    });
    expect(structured.bidType).toBe('blind');
    expect(structured.evidence.some(item => item.includes('结构证据'))).toBe(true);
  });

  it('☑明标 → open：正文表格默认允许且不注入写作约束', () => {
    const open = extractBidCompositionSpec({ tenderTexts: ['本项目施工组织设计采用：☑明标。□暗标。'] });
    expect(open.bidType).toBe('open');
    expect(open.bodyTablePolicy).toBe('allowed');
    expect(open.bodyFigurePolicy).toBe('allowed');
    expect(bidCompositionWritingRules(open)).toBe('');
  });

  it('无任何标书类型证据 → unknown：不猜测（证据为空、摘要 skipped）', () => {
    const unknown = extractBidCompositionSpec({ tenderTexts: ['本项目施工组织设计内容应完整、方案合理可行。'] });
    expect(unknown.bidType).toBe('unknown');
    expect(unknown.bodyTablePolicy).toBe('allowed');
    expect(unknown.evidence).toEqual([]);
    expect(bidCompositionSummary(unknown).status).toBe('skipped');
  });

  it('requirement 用户需求文本纳入判定（用户直接声明标书类型）', () => {
    const spec = extractBidCompositionSpec({ tenderTexts: [], requirement: MINIMAL_BLIND });
    expect(spec.bidType).toBe('blind');
  });
});

describe('正文表格口径三态判定（C1 证据驱动，不按标书类型硬推）', () => {
  const extract = (text: string) => extractBidCompositionSpec({ tenderTexts: [text] });

  it('显式禁表句 → forbidden：三种中文语序全覆盖（正文在前/否定词在前/表格在前）', () => {
    const forbidSamples = [
      '正文不得出现表格。',
      '正文部分不得使用任何图表。',
      '正文一律纯文字表述。',
      '表格不得出现在正文中。',
      '禁止在正文中使用框图。',
      '不得在正文中出现表格。',
    ];
    for (const text of forbidSamples) {
      const spec = extract(text);
      expect(spec.bodyTablePolicy, text).toBe('forbidden');
      expect(spec.evidence.some(item => item.includes('正文禁表证据')), text).toBe(true);
    }
  });

  it('允许句 → allowed 且逐条记允许证据（舒城真实招标语序）', () => {
    const allowSamples = [
      '施工组织设计采用文字并结合图表形式编制。',
      '除文字表述外可附下列图表，图表及格式要求附后。',
      '横道图、网络图及一些表格和框图采用何种软件编制自行确定。',
      '表格可采用A3幅面。',
      '施工进度表可采用网络图或横道图。',
      '图表、框图一律单黑色表述。',
      '图表及格式要求附后。',
    ];
    for (const text of allowSamples) {
      const spec = extract(text);
      expect(spec.bodyTablePolicy, text).toBe('allowed');
      expect(spec.evidence.some(item => item.includes('正文表格允许证据')), text).toBe(true);
    }
  });

  it('反样本（防误伤守护）：禁符号句为排版条款；颜色句距离超窗；颜色/无关修饰命中即豁免', () => {
    // ① 禁无关系符号句（舒城原文）：排版格式条款，不构成正文禁表
    const symbolOnly = extract('正文内不允许出现非文字需要的其他任何符号和标志。');
    expect(symbolOnly.bodyTablePolicy).toBe('allowed');
    expect(symbolOnly.evidence.some(item => item.includes('排版格式证据'))).toBe(true);
    expect(symbolOnly.evidence.some(item => item.includes('正文禁表证据'))).toBe(false);

    // ② 颜色格式句（舒城「不得有其他颜色的文字和图表出现」）：动作词与「正文」距离 17 字超窗 + 颜色豁免双保险
    const colorSentence = extract('正文及各类型图表，框图一律单黑色表述，不得有其他颜色的文字和图表出现。');
    expect(colorSentence.bodyTablePolicy).toBe('allowed');
    expect(colorSentence.evidence.some(item => item.includes('正文禁表证据'))).toBe(false);

    // ③ 颜色豁免：禁表句式命中但含颜色修饰（排版格式条款）→ 不判禁表
    const colorExempt = extract('正文内不得出现彩色表格。');
    expect(colorExempt.bodyTablePolicy).toBe('allowed');
    expect(colorExempt.evidence.some(item => item.includes('正文禁表证据'))).toBe(false);

    // ④ 无关豁免：禁表句式命中但指向无关内容（范围条款）→ 不判禁表
    const unrelatedExempt = extract('正文不得出现无关表格。');
    expect(unrelatedExempt.bodyTablePolicy).toBe('allowed');
    expect(unrelatedExempt.evidence.some(item => item.includes('正文禁表证据'))).toBe(false);
  });

  it('无表格证据 → allowed 默认（C1 根因回归：不得按标书类型硬推禁表）', () => {
    const minimal = extract(MINIMAL_BLIND);
    expect(minimal.bidType).toBe('blind');
    expect(minimal.bodyTablePolicy).toBe('allowed');
    expect(minimal.bodyFigurePolicy).toBe('forbidden');

    const open = extract('本项目施工组织设计采用：☑明标。□暗标。');
    expect(open.bodyTablePolicy).toBe('allowed');
  });
});

describe('extractBidCompositionSpec（冲突裁决：招标 > 提示词 > 默认）', () => {
  it('显式禁表句 vs 提示词必需表格：可对应附表的收敛入文末，其余取消表格形式', () => {
    const spec = extractBidCompositionSpec({
      tenderTexts: [EXPLICIT_FORBID_TENDER],
      requiredTables: ['主要施工设备表', '劳动力计划表', '质量关键节点控制表'],
    });
    expect(spec.bodyTablePolicy).toBe('forbidden');
    expect(spec.conflicts).toHaveLength(3);
    expect(spec.conflicts.find(item => item.rule.includes('主要施工设备表'))?.resolution)
      .toContain('收敛入文末《附表一 拟投入本标段的主要施工设备表》');
    expect(spec.conflicts.find(item => item.rule.includes('劳动力计划表'))?.resolution)
      .toContain('收敛入文末《附表三 拟配备本标段的劳动力计划表》');
    expect(spec.conflicts.find(item => item.rule.includes('质量关键节点控制表'))?.resolution)
      .toBe('招标正文禁表（显式禁表句）：该表取消表格形式，数据以对应章节文字表述呈现');
  });

  it('允许口径（暗标允许句）时必需表格不产生冲突（表格计划正常纳入）', () => {
    const spec = extractBidCompositionSpec({
      tenderTexts: [BLIND_TENDER],
      requiredTables: ['主要施工设备表'],
    });
    expect(spec.bodyTablePolicy).toBe('allowed');
    expect(spec.conflicts).toEqual([]);
  });

  it('明标（正文表格放开）时必需表格不产生冲突', () => {
    const spec = extractBidCompositionSpec({
      tenderTexts: ['本项目施工组织设计采用：☑明标。'],
      requiredTables: ['主要施工设备表'],
    });
    expect(spec.conflicts).toEqual([]);
  });
});

describe('appendixKindAndSource（附表分类与数据源绑定）', () => {
  it('表类按语义绑蓝图数据源；C2 图类（进度/总平面）绑蓝图数据源表格化落位；未识别项归编制人人工补充', () => {
    expect(appendixKindAndSource('拟投入本标段的主要施工设备表')).toEqual({ kind: 'table', dataSource: 'blueprint.equipment' });
    expect(appendixKindAndSource('拟配备本标段的试验和检测仪器设备表')).toEqual({ kind: 'table', dataSource: 'blueprint.testInstruments' });
    expect(appendixKindAndSource('拟配备本标段的劳动力计划表')).toEqual({ kind: 'table', dataSource: 'blueprint.labor' });
    expect(appendixKindAndSource('临时用地表')).toEqual({ kind: 'table', dataSource: 'blueprint.tempLand' });
    expect(appendixKindAndSource('计划开、竣工日期和施工进度网络图')).toEqual({ kind: 'figure', dataSource: 'blueprint.schedule' });
    expect(appendixKindAndSource('施工总平面图')).toEqual({ kind: 'figure', dataSource: 'blueprint.tempLand' });
    expect(appendixKindAndSource('质量关键节点控制表')).toEqual({ kind: 'table', dataSource: 'manual' });
  });
});

describe('写作约束与门禁渲染', () => {
  const blind = extractBidCompositionSpec({ tenderTexts: [BLIND_TENDER] });
  const explicitForbid = extractBidCompositionSpec({ tenderTexts: [EXPLICIT_FORBID_TENDER] });

  it('bidCompositionWritingRules：允许口径注入（表格按计划输出 + 禁图 + 单黑色 + 身份禁语共 5 条）', () => {
    const rules = bidCompositionWritingRules(blind);
    expect(rules).toContain('【正文编制口径（招标文件要求，硬性验收项）】');
    expect(rules).toContain('1. 正文表格按系统表格计划输出');
    expect(rules).toContain('2. 图类数据（进度/网络/横道/平面布置等）以表格化数据表达');
    expect(rules).toContain('3. 不得插入图片、Markdown 图片语法或图件占位');
    expect(rules).toContain('4. 表格与文字一律单黑色');
    expect(rules).toContain('5. 不得出现任何明示或暗示具体投标人的说明及标记');
  });

  it('bidCompositionWritingRules：显式禁表句注入纯文字口径（文末附表区统一承接）', () => {
    const rules = bidCompositionWritingRules(explicitForbid);
    expect(rules).toContain('1. 正文一律纯文字表述');
    expect(rules).toContain('不得输出任何 Markdown 表格或管道符表格结构');
    expect(rules).toContain('2. 结构化数据表由系统在文末附表区按招标附表清单统一生成');
    expect(rules).toContain('3. 不得插入图片');
  });

  it('无身份禁语的暗标（仅禁图）注入 3 条（不带身份禁语行）', () => {
    const minimal = extractBidCompositionSpec({ tenderTexts: [MINIMAL_BLIND] });
    const rules = bidCompositionWritingRules(minimal);
    expect(rules).toContain('1. 正文表格按系统表格计划输出');
    expect(rules).toContain('3. 不得插入图片');
    expect(rules).not.toContain('不得出现任何明示或暗示');
    expect(bidCompositionSummary(minimal).message).toContain('未识别文末附表清单');
  });

  it('isBodyTableForbidden/isBodyFigureForbidden：按证据三态判定（undefined 安全）', () => {
    expect(isBodyTableForbidden(blind)).toBe(false);
    expect(isBodyTableForbidden(explicitForbid)).toBe(true);
    expect(isBodyFigureForbidden(blind)).toBe(true);
    expect(isBodyTableForbidden(extractBidCompositionSpec({ tenderTexts: ['本项目施工组织设计采用：☑明标。'] }))).toBe(false);
    expect(isBodyTableForbidden(undefined)).toBe(false);
    expect(isBodyFigureForbidden(undefined)).toBe(false);
  });

  it('bodyTableDismantleIssue：显式禁表口径拆表指令带表格数（评标后果显性）', () => {
    const issue = bodyTableDismantleIssue(3);
    expect(issue).toContain('招标正文禁表（显式禁表句，违反即施工组织设计部分不得分）');
    expect(issue).toContain('本章正文出现 3 处 Markdown 表格结构');
    expect(issue).toContain('段落式连贯叙述');
  });

  it('unplannedBodyTableIssue：允许口径下无计划表格的修复指令（表格计划统一裁决）', () => {
    const issue = unplannedBodyTableIssue(2);
    expect(issue).toContain('本章正文出现 2 处 Markdown 表格结构，但本章未列入系统表格计划');
    expect(issue).toContain('确属必要的表格由系统在表格计划中补齐');
  });

  it('bidCompositionSummary：暗标全项摘要显性可审计（口径三态展示）', () => {
    const summary = bidCompositionSummary(blind);
    expect(summary.status).toBe('success');
    expect(summary.message).toContain('标书类型：暗标');
    expect(summary.message).toContain('正文表格：允许（表格按系统表格计划输出）');
    expect(summary.message).toContain('正文图片：禁图片（图类数据化输出）');
    expect(summary.message).toContain('文末附表 6 项（表类 4 / 图类 2）');
    expect(summary.message).toContain('总页数上限 200 页');
    expect(summary.details.some(item => item.includes('格式：装订线 0.3-0.6cm、行距固定值25磅'))).toBe(true);
    expect(summary.details.some(item => item.includes('身份禁语'))).toBe(true);
  });

  it('bidCompositionSummary：显式禁表口径展示为「禁表格（招标显式禁表句）」', () => {
    const summary = bidCompositionSummary(explicitForbid);
    expect(summary.message).toContain('正文表格：禁表格（招标显式禁表句）');
    expect(summary.message).toContain('正文图片：禁图片（图类数据化输出）');
  });
});

describe('F-T1 标书类型判定加固（双通道 + 显性告警）', () => {
  it('勾选标记字符变体全族命中（☑√✔✓■●◼☒⊠▣）', () => {
    for (const mark of ['☑', '√', '✔', '✓', '■', '●', '◼', '☒', '⊠', '▣']) {
      const spec = extractBidCompositionSpec({ tenderTexts: [`本项目施工组织设计采用：□明标。${mark}暗标。`] });
      expect(spec.bidType).toBe('blind');
    }
  });

  it('字符混淆变体：字间距/括号包裹/emoji 变体选择符/词后标记均命中', () => {
    const variants = [
      '本项目施工组织设计采用：☑ 暗 标。',
      '本项目施工组织设计采用：☑（暗标）。',
      '本项目施工组织设计采用：√【暗标】。',
      '本项目施工组织设计采用：☑\uFE0F暗标。',
      '本项目施工组织设计采用：暗标（√）。',
    ];
    for (const text of variants) {
      expect(extractBidCompositionSpec({ tenderTexts: [text] }).bidType).toBe('blind');
    }
  });

  it('未勾选空框不触发：「□暗标」单独出现仍为 unknown（空框≠勾选）', () => {
    const spec = extractBidCompositionSpec({ tenderTexts: ['本项目施工组织设计采用：□暗标。'] });
    expect(spec.bidType).toBe('unknown');
  });

  it('语义通道兜底：无勾选标记时按语义条款判定（暗标侧）', () => {
    const cases = [
      '本项目施工组织设计按暗标要求编制，投标文件匿名递交。',
      '本工程采用暗标评审方式，技术标不得出现投标人信息。',
      '本项目执行暗标编制程序。',
    ];
    for (const text of cases) {
      const spec = extractBidCompositionSpec({ tenderTexts: [text] });
      expect(spec.bidType).toBe('blind');
      expect(spec.evidence.some(item => item.includes('结构证据') && item.includes('语义判定通道'))).toBe(true);
    }
  });

  it('语义通道兜底：明标侧（按明标要求编制）→ 明标', () => {
    const spec = extractBidCompositionSpec({ tenderTexts: ['本项目施工组织设计按明标要求编制，允许正文插图。'] });
    expect(spec.bidType).toBe('open');
    expect(spec.bodyTablePolicy).toBe('allowed');
  });

  it('否定语境不误判：「不按暗标要求编制」不触发暗标语义通道', () => {
    const spec = extractBidCompositionSpec({ tenderTexts: ['本项目不按暗标要求编制，正文可使用表格。'] });
    expect(spec.bidType).toBe('unknown');
  });

  it('舒城真实语序（换行拆分 + 相邻条款标题）→ 暗标；无禁表句不判正文禁表（C1 根因回归）', () => {
    const shucheng = ['7.本项目施工组织设计采用：', '', '□明标。', '', '☑暗标。', '', '8.施工组织设计采用暗标评审项目的编制要求'].join('\n');
    const spec = extractBidCompositionSpec({ tenderTexts: [shucheng] });
    expect(spec.bidType).toBe('blind');
    expect(spec.bodyTablePolicy).toBe('allowed');
    expect(spec.evidence.some(item => item.includes('正文禁表证据'))).toBe(false);
    expect(spec.evidence.some(item => item.includes('标书类型勾选证据：☑暗标'))).toBe(true);
  });

  it('unknown 显性告警：摘要带告警与风险后果，核查指引可查（不静默退化）', () => {
    const spec = extractBidCompositionSpec({ tenderTexts: ['本项目施工组织设计内容应完整、方案合理可行。'] });
    const summary = bidCompositionSummary(spec);
    expect(summary.status).toBe('skipped');
    expect(summary.message).toContain('⚠ 标书类型未判定（告警）');
    expect(summary.message).toContain('重跑');
    expect(summary.details.some(item => item.includes('核查指引'))).toBe(true);
    expect(summary.details.some(item => item.includes('标记字符变体'))).toBe(true);
  });
});

/**
 * 招标规定排版 → 导出设置（4.55.22）。
 * 此前 formatRules 只用于进度展示，招标强制的字体/字号/行距/装订线**从未落到导出物**上。
 * 关键风险在此：抽取值是中文排版惯用写法（号数名/带括注字体名/「固定值28磅」），
 * 直接赋值会产出**非法 CSS**（如 `font-size: 小四`）——故必须换算。
 */
describe('applyFormatRulesToExportSettings（招标排版落到导出物）', () => {
  it('中文号数名换算为磅值（小四→12pt、三号→16pt），不产出非法 CSS 字号', () => {
    const { settings, applied } = applyFormatRulesToExportSettings(undefined, { bodySize: '小四', headingSize: '三号' });
    expect(settings?.typography?.bodySize).toBe('12pt');
    expect(settings?.typography?.titleSize).toBe('16pt');
    expect(applied.join('、')).toContain('正文字号=12pt');
  });

  it('带括注字体名取正名并给出回退族', () => {
    const { settings } = applyFormatRulesToExportSettings(undefined, { bodyFont: '仿宋_GB2312（GB2312）' });
    expect(settings?.typography?.bodyFont).toContain('仿宋_GB2312');
    expect(settings?.typography?.bodyFont).toContain('serif');
    expect(settings?.typography?.bodyFont).not.toContain('（');
  });

  it('行距「固定值28磅」归一为 28pt；装订线与页数上限直通', () => {
    const { settings, applied } = applyFormatRulesToExportSettings(undefined, { lineHeight: '固定值28磅', gutter: '0.5cm', pageLimit: 60 });
    expect(settings?.typography?.lineHeight).toBe('28pt');
    expect(settings?.page?.gutter).toBe('0.5cm');
    expect(settings?.targetPages?.max).toBe(60);
    expect(applied).toHaveLength(3);
  });

  it('招标优先于模板：模板已有排版被招标值覆盖，未规定的项保留模板值', () => {
    const template = { typography: { bodyFont: 'SimSun', lineHeight: '18pt' }, page: { paper: 'A4' } };
    const { settings } = applyFormatRulesToExportSettings(template, { lineHeight: '固定值28磅' });
    expect(settings?.typography?.lineHeight).toBe('28pt');   // 招标覆盖
    expect(settings?.typography?.bodyFont).toBe('SimSun');   // 招标未规定 → 保留模板
    expect(settings?.page?.paper).toBe('A4');
  });

  it('无格式要求时不改动任何设置（零副作用）', () => {
    const template = { typography: { bodyFont: 'SimSun' } };
    const { settings, applied } = applyFormatRulesToExportSettings(template, {});
    expect(applied).toEqual([]);
    expect(settings?.typography?.bodyFont).toBe('SimSun');
  });
});
