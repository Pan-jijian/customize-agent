import { describe, expect, it } from 'vitest';
import {
  appendixKindAndSource,
  bidCompositionSummary,
  bidCompositionWritingRules,
  bodyTableDismantleIssue,
  extractBidCompositionSpec,
  isBodyTableForbidden,
  stripRequiredTableRuleLine,
} from '@/services/document-workflow/bidComposition';

/**
 * 暗标招标文件 fixture（舒城语序浓缩）：勾选证据 + 正文禁表双证据 + 6 项文末附表 +
 * 格式要求全项 + 身份禁语，覆盖判定链全部命中分支。
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

/** 最小暗标（仅勾选证据：无格式要求/附表/身份禁语） */
const MINIMAL_BLIND = '本项目施工组织设计采用：☑暗标。';

describe('extractBidCompositionSpec（标书类型识别）', () => {
  const spec = extractBidCompositionSpec({ tenderTexts: [BLIND_TENDER] });

  it('勾选证据优先：☑暗标 → blind + 正文禁表禁图 + 证据逐条留存', () => {
    expect(spec.bidType).toBe('blind');
    expect(spec.bodyTablePolicy).toBe('forbidden');
    expect(spec.bodyFigurePolicy).toBe('forbidden');
    expect(spec.evidence.some(item => item.includes('标书类型勾选证据'))).toBe(true);
    expect(spec.evidence.some(item => item.includes('正文内不允许'))).toBe(true);
    expect(spec.evidence.some(item => item.includes('除文字表述外可附下列图表'))).toBe(true);
  });

  it('文末附表清单 6 项且编号/分类/数据源逐项绑定', () => {
    expect(spec.appendixPlan.map(item => [item.no, item.kind, item.dataSource])).toEqual([
      ['一', 'table', 'blueprint.equipment'],
      ['二', 'table', 'blueprint.testInstruments'],
      ['三', 'table', 'blueprint.labor'],
      ['四', 'figure', 'manual'],
      ['五', 'figure', 'manual'],
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

  it('☑明标 → open：正文表格放开且不注入写作约束', () => {
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

describe('extractBidCompositionSpec（冲突裁决：招标 > 提示词 > 默认）', () => {
  it('暗标正文禁表 vs 提示词必需表格：可对应附表的收敛入文末，其余取消表格形式', () => {
    const spec = extractBidCompositionSpec({
      tenderTexts: [BLIND_TENDER],
      requiredTables: ['主要施工设备表', '劳动力计划表', '质量关键节点控制表'],
    });
    expect(spec.conflicts).toHaveLength(3);
    expect(spec.conflicts.find(item => item.rule.includes('主要施工设备表'))?.resolution)
      .toContain('收敛入文末《附表一 拟投入本标段的主要施工设备表》');
    expect(spec.conflicts.find(item => item.rule.includes('劳动力计划表'))?.resolution)
      .toContain('收敛入文末《附表三 拟配备本标段的劳动力计划表》');
    expect(spec.conflicts.find(item => item.rule.includes('质量关键节点控制表'))?.resolution)
      .toBe('招标暗标正文禁表：该表取消表格形式，数据以对应章节文字表述呈现');
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
  it('表类按语义绑蓝图数据源，图类与未识别项归编制人人工补充', () => {
    expect(appendixKindAndSource('拟投入本标段的主要施工设备表')).toEqual({ kind: 'table', dataSource: 'blueprint.equipment' });
    expect(appendixKindAndSource('拟配备本标段的试验和检测仪器设备表')).toEqual({ kind: 'table', dataSource: 'blueprint.testInstruments' });
    expect(appendixKindAndSource('拟配备本标段的劳动力计划表')).toEqual({ kind: 'table', dataSource: 'blueprint.labor' });
    expect(appendixKindAndSource('临时用地表')).toEqual({ kind: 'table', dataSource: 'blueprint.tempLand' });
    expect(appendixKindAndSource('计划开、竣工日期和施工进度网络图')).toEqual({ kind: 'figure', dataSource: 'manual' });
    expect(appendixKindAndSource('施工总平面图')).toEqual({ kind: 'figure', dataSource: 'manual' });
    expect(appendixKindAndSource('质量关键节点控制表')).toEqual({ kind: 'table', dataSource: 'manual' });
  });
});

describe('写作约束与门禁渲染', () => {
  const blind = extractBidCompositionSpec({ tenderTexts: [BLIND_TENDER] });

  it('bidCompositionWritingRules：暗标注入 4 条硬约束（含身份禁语）', () => {
    const rules = bidCompositionWritingRules(blind);
    expect(rules).toContain('【正文编制口径（招标文件暗标要求，硬性验收项）】');
    expect(rules).toContain('不得输出任何 Markdown 表格或管道符表格结构');
    expect(rules).toContain('4. 不得出现任何明示或暗示具体投标人的说明及标记');
  });

  it('无身份禁语的暗标仅注入 3 条（不带身份禁语行）', () => {
    const minimal = extractBidCompositionSpec({ tenderTexts: [MINIMAL_BLIND] });
    const rules = bidCompositionWritingRules(minimal);
    expect(rules).not.toContain('4. 不得出现');
    expect(rules).toContain('3. 结构化数据表由系统在文末附表区按招标附表清单统一生成');
    expect(bidCompositionSummary(minimal).message).toContain('未识别文末附表清单');
  });

  it('isBodyTableForbidden：仅暗标正文禁表为真（undefined 安全）', () => {
    expect(isBodyTableForbidden(blind)).toBe(true);
    expect(isBodyTableForbidden(extractBidCompositionSpec({ tenderTexts: ['本项目施工组织设计采用：☑明标。'] }))).toBe(false);
    expect(isBodyTableForbidden(undefined)).toBe(false);
  });

  it('bodyTableDismantleIssue：拆表指令带章节与表格数', () => {
    const issue = bodyTableDismantleIssue('第五章 施工组织设计', 3);
    expect(issue).toContain('暗标正文禁表');
    expect(issue).toContain('本章正文出现 3 处 Markdown 表格结构');
    expect(issue).toContain('段落式连贯叙述');
  });

  it('stripRequiredTableRuleLine：移除「必须输出以下正式 Markdown 表格」规则行', () => {
    const text = '1. 必须输出以下正式 Markdown 表格：劳动力计划表、主要施工设备表\n2. 其它规则保留';
    expect(stripRequiredTableRuleLine(text)).toBe('2. 其它规则保留');
    expect(stripRequiredTableRuleLine('普通规则文本')).toBe('普通规则文本');
    expect(stripRequiredTableRuleLine('')).toBe('');
  });

  it('bidCompositionSummary：暗标全项摘要显性可审计', () => {
    const summary = bidCompositionSummary(blind);
    expect(summary.status).toBe('success');
    expect(summary.message).toContain('标书类型：暗标');
    expect(summary.message).toContain('正文纯文字（禁表格/禁图片）');
    expect(summary.message).toContain('文末附表 6 项（表类 4 / 图类 2）');
    expect(summary.message).toContain('总页数上限 200 页');
    expect(summary.details.some(item => item.includes('格式：装订线 0.3-0.6cm、行距固定值25磅'))).toBe(true);
    expect(summary.details.some(item => item.includes('身份禁语'))).toBe(true);
  });
});
