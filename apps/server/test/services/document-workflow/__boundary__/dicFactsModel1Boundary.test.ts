/**
 * t3-mf FG3 组：factsModel 前半纯函数族矩阵。
 * 覆盖：cleanPdfHeadingNoise / normalizeOcrFactText（全归一规则链）/ fieldExtractionPattern /
 * isValidProjectBasicFactValue（13 字段分支）/ extractProjectBasicFactsFromEvidence（14 模式+
 * 跨行合并+商务行过滤+去重+目标句负分支）/ extractBillItemFacts / buildSpecAuthorityMap /
 * normalizedFactValue / reliableFactForTarget。
 * 全部断言按源码实现逐条推导，真实行为锁定（不修改实现迎合用例）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildSpecAuthorityMap,
  cleanPdfHeadingNoise,
  extractBillItemFacts,
  extractProjectBasicFactsFromEvidence,
  fieldExtractionPattern,
  isValidProjectBasicFactValue,
  normalizedFactValue,
  normalizeOcrFactText,
  reliableFactForTarget,
} from '@/services/document-workflow/factsModel';
import type { DocumentEvidence, DocumentFact, FactSourceRef, StructuredTableFact } from '@/services/document-workflow/types';

const ev = (content: string, extra: Partial<DocumentEvidence> = {}): DocumentEvidence => ({
  chapterId: 'c1', filePath: extra.filePath ?? '招标文件.txt', score: extra.score ?? 0.9, content, roleId: extra.roleId, processingType: extra.processingType ?? 'text', sectionTitle: extra.sectionTitle,
});

// ═══════ A1 cleanPdfHeadingNoise ═══════
describe('A1 cleanPdfHeadingNoise', () => {
  it('夹断句重闭合：平方\\n\\n### 米 → 平方米', () => {
    expect(cleanPdfHeadingNoise('28570.36平方\n\n### 米')).toBe('28570.36平方米');
  });

  it('行首标题标记移除', () => {
    expect(cleanPdfHeadingNoise('### 1.1项目概况')).toBe('1.1项目概况');
    expect(cleanPdfHeadingNoise('# 一级标题')).toBe('一级标题');
    expect(cleanPdfHeadingNoise('###### 六级')).toBe('六级');
  });

  it('全角＃同移除', () => {
    expect(cleanPdfHeadingNoise('＃＃＃ 全角标记')).toBe('全角标记');
  });

  it('句中标记也移除（正文#中）', () => {
    expect(cleanPdfHeadingNoise('正文#中')).toBe('正文中');
  });

  it('无标记原样返回', () => {
    expect(cleanPdfHeadingNoise('普通内容')).toBe('普通内容');
  });

  it('非字符串经 stringifyFactValue 转字符串', () => {
    expect(cleanPdfHeadingNoise(123 as unknown as string)).toBe('123');
  });
});

// ═══════ A2 normalizeOcrFactText ═══════
describe('A2 normalizeOcrFactText', () => {
  it('全角/不间断空格转普通空格', () => {
    expect(normalizeOcrFactText('甲\u3000乙\u00A0丙')).toBe('甲乙 丙');
  });

  it('汉字间空格合并', () => {
    expect(normalizeOcrFactText('计 划 工 期')).toBe('计划工期');
  });

  it('数字与单位黏合', () => {
    expect(normalizeOcrFactText('365 天')).toBe('365天');
    expect(normalizeOcrFactText('500 万元')).toBe('500万元');
  });

  it('估算价形态归一', () => {
    expect(normalizeOcrFactText('合同 估 算 价格')).toBe('合同估算价');
    expect(normalizeOcrFactText('投资估算 价')).toBe('投资估算价');
  });

  it('字段词空白归一', () => {
    expect(normalizeOcrFactText('计划 工 期')).toBe('计划工期');
    expect(normalizeOcrFactText('合同 工期')).toBe('合同工期');
    expect(normalizeOcrFactText('质量 标准')).toBe('质量标准');
    expect(normalizeOcrFactText('建设 地点')).toBe('建设地点');
    expect(normalizeOcrFactText('建设 规模')).toBe('建设规模');
    expect(normalizeOcrFactText('招标 范围')).toBe('招标范围');
  });

  it('限价/控制价空白归一', () => {
    expect(normalizeOcrFactText('最高 投标 限价')).toBe('最高投标限价');
    expect(normalizeOcrFactText('招标 控制 价')).toBe('招标控制价');
  });

  it('冒号后空白收紧', () => {
    expect(normalizeOcrFactText('建设规模： 4645㎡')).toBe('建设规模：4645㎡');
  });

  it('多余空白归一为单空格并 trim（replace 非重叠扫描真行为）', () => {
    expect(normalizeOcrFactText('  甲  乙  丙  ')).toBe('甲乙 丙');
  });

  it('组合：计划 工 期 365 天 → 计划工期 365天', () => {
    expect(normalizeOcrFactText('计划 工 期 365 天')).toBe('计划工期 365天');
  });

  it('null → 空串', () => {
    expect(normalizeOcrFactText(null as unknown as string)).toBe('');
  });

  it('数字转字符串', () => {
    expect(normalizeOcrFactText(500 as unknown as string)).toBe('500');
  });

  it('汉字间空格合并使万/元合并后数字黏合（约 500 万 元 → 约 500万元）', () => {
    expect(normalizeOcrFactText('约 500 万 元')).toBe('约 500万元');
  });
});

// ═══════ A3 fieldExtractionPattern ═══════
describe('A3 fieldExtractionPattern', () => {
  it('普通字段：短窗口停于换行/逗号/句号', () => {
    const re = fieldExtractionPattern('质量标准');
    expect(re.exec('质量标准：合格')?.[1]).toBe('合格');
    expect(re.exec('质量标准：合格，且优良')?.[1]).toBe('合格');
  });

  it('规模字段：长窗口跨逗号', () => {
    const re = fieldExtractionPattern('建设规模');
    expect(re.exec('建设规模：项目总占地面积约10970平方米，单体建筑面积28570.36平方米')?.[1])
      .toBe('项目总占地面积约10970平方米，单体建筑面积28570.36平方米');
  });

  it('工期字段：长窗口', () => {
    const re = fieldExtractionPattern('计划工期');
    expect(re.exec('计划工期：开工后540日历天')?.[1]).toBe('开工后540日历天');
  });

  it('特殊字符转义', () => {
    const re = fieldExtractionPattern('质量（目标）');
    expect(re.exec('质量（目标）：合格')?.[1]).toBe('合格');
    expect(re.test('质量X目标：合格')).toBe(false);
  });

  it('冒号/空格/为/是 分隔', () => {
    const re = fieldExtractionPattern('项目名称');
    expect(re.exec('项目名称 某工程')?.[1]).toBe('某工程');
  });

  it('长窗口最小 2 字符', () => {
    const re = fieldExtractionPattern('建设规模');
    expect(re.exec('建设规模：A')?.[1]).toBeUndefined();
  });
});

// ═══════ A4 isValidProjectBasicFactValue ═══════
describe('A4 isValidProjectBasicFactValue', () => {
  it('无 fieldId → false', () => {
    expect(isValidProjectBasicFactValue(undefined, '某值')).toBe(false);
  });

  it('空值 → false', () => {
    expect(isValidProjectBasicFactValue('project_name', '')).toBe(false);
  });

  it('超 260 字符 → false', () => {
    expect(isValidProjectBasicFactValue('project_name', '长'.repeat(261))).toBe(false);
  });

  it('PDF 标记/页码 → false', () => {
    expect(isValidProjectBasicFactValue('project_name', '某工程第46页共47页')).toBe(false);
    expect(isValidProjectBasicFactValue('project_name', '### 1.1项目概况')).toBe(false);
  });

  it('程序性词（签章/联系人/保证金）→ false', () => {
    expect(isValidProjectBasicFactValue('project_name', '联系人：张三')).toBe(false);
    expect(isValidProjectBasicFactValue('project_name', '投标保证金账户')).toBe(false);
  });

  it('schedule_requirement：数值+单位才过', () => {
    expect(isValidProjectBasicFactValue('schedule_requirement', '180日历天')).toBe(true);
    expect(isValidProjectBasicFactValue('schedule_requirement', '按时完成')).toBe(false);
    expect(isValidProjectBasicFactValue('schedule_requirement', `${'长'.repeat(91)}`)).toBe(false);
  });

  it('quality_standard：合格词+无工期词', () => {
    expect(isValidProjectBasicFactValue('quality_standard', '合格')).toBe(true);
    expect(isValidProjectBasicFactValue('quality_standard', '国家现行验收规范验收合格')).toBe(true);
    expect(isValidProjectBasicFactValue('quality_standard', '合格，工期365天')).toBe(false);
    expect(isValidProjectBasicFactValue('quality_standard', 'C30')).toBe(false);
  });

  it('owner：组织特征词+长度≥4', () => {
    expect(isValidProjectBasicFactValue('owner', '合肥市重点工程建设管理局')).toBe(true);
    expect(isValidProjectBasicFactValue('owner', '王明')).toBe(false);
    expect(isValidProjectBasicFactValue('owner', '投标人')).toBe(false);
  });

  it('project_location：排除引用型', () => {
    expect(isValidProjectBasicFactValue('project_location', '合肥市蜀山区')).toBe(true);
    expect(isValidProjectBasicFactValue('project_location', '详见招标公告')).toBe(false);
    expect(isValidProjectBasicFactValue('project_location', '投标地点')).toBe(false);
  });

  it('project_scope：排除序号开头/资格条款/引用型', () => {
    expect(isValidProjectBasicFactValue('project_scope', '施工图范围内全部工程')).toBe(true);
    expect(isValidProjectBasicFactValue('project_scope', '（1）施工')).toBe(false);
    expect(isValidProjectBasicFactValue('project_scope', '具备安全生产考核合格证书')).toBe(false);
    expect(isValidProjectBasicFactValue('project_scope', '见招标文件')).toBe(false);
  });

  it('project_code：编号字符集', () => {
    expect(isValidProjectBasicFactValue('project_code', '2026AFAGZ50906')).toBe(true);
    expect(isValidProjectBasicFactValue('project_code', '编号 123')).toBe(false);
  });

  it('project_investment_estimate：金额单位', () => {
    expect(isValidProjectBasicFactValue('project_investment_estimate', '约500万元')).toBe(true);
    expect(isValidProjectBasicFactValue('project_investment_estimate', '500万')).toBe(false);
  });

  it('labor_peak：人数', () => {
    expect(isValidProjectBasicFactValue('labor_peak', '120人')).toBe(true);
    expect(isValidProjectBasicFactValue('labor_peak', '较多')).toBe(false);
  });

  it('assembly_rate：百分比', () => {
    expect(isValidProjectBasicFactValue('assembly_rate', '30%')).toBe(true);
    expect(isValidProjectBasicFactValue('assembly_rate', '三分之一')).toBe(false);
  });

  it('foundation_support_form：支护特征词', () => {
    expect(isValidProjectBasicFactValue('foundation_support_form', '采用放坡开挖')).toBe(true);
    expect(isValidProjectBasicFactValue('foundation_support_form', '土钉墙')).toBe(false);
    expect(isValidProjectBasicFactValue('foundation_support_form', '地下连续墙')).toBe(false);
  });

  it('award_clause：金额+无评标', () => {
    expect(isValidProjectBasicFactValue('award_clause', '10万元')).toBe(true);
    expect(isValidProjectBasicFactValue('award_clause', '创优目标')).toBe(false);
    expect(isValidProjectBasicFactValue('award_clause', '奖励10万元，详见评标办法')).toBe(false);
  });

  it('默认分支（project_name）：长度≤220 即可', () => {
    expect(isValidProjectBasicFactValue('project_name', '合肥某大学宿舍楼工程')).toBe(true);
    expect(isValidProjectBasicFactValue('project_name', '长'.repeat(221))).toBe(false);
  });
});

// ═══════ A5 extractProjectBasicFactsFromEvidence ═══════
describe('A5 extractProjectBasicFactsFromEvidence', () => {
  it('项目名称标签句', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('项目名称：合肥某大学宿舍楼工程')]);
    expect(facts).toHaveLength(1);
    expect(facts[0].fieldId).toBe('project_name');
    expect(facts[0].value).toBe('合肥某大学宿舍楼工程');
    expect(facts[0].confidence).toBe(0.9);
  });

  it('工程名称为分隔形态', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('工程名称 为合肥某工程')]);
    expect(facts[0].fieldId).toBe('project_name');
    expect(facts[0].value).toBe('合肥某工程');
  });

  it('项目编号', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('项目编号：2026AFAGZ50906')]);
    expect(facts[0].fieldId).toBe('project_code');
    expect(facts[0].value).toBe('2026AFAGZ50906');
  });

  it('招标人（owner）', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('招标人：合肥市重点工程建设管理局')]);
    expect(facts[0].fieldId).toBe('owner');
  });

  it('建设地点', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('建设地点：合肥市蜀山区')]);
    expect(facts[0].fieldId).toBe('project_location');
  });

  it('建设规模长句（混合口径整句捕获）', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('建设规模：项目总占地面积约10970平方米，单体建筑面积28570.36平方米')]);
    expect(facts[0].fieldId).toBe('project_scale');
    expect(facts[0].value).toBe('项目总占地面积约10970平方米，单体建筑面积28570.36平方米');
  });

  it('嵌入句式：总建筑面积约4646m2 补抽', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('总建筑面积约4646m2')]);
    expect(facts[0].fieldId).toBe('project_scale');
    expect(facts[0].value).toBe('总建筑面积约4646m2');
  });

  it('目标性表述负分支：拟建设总建筑面积不捕获', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('拟建设总建筑面积约5000㎡')]);
    expect(facts).toHaveLength(0);
  });

  it('计划工期', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('计划工期：540日历天')]);
    expect(facts[0].fieldId).toBe('schedule_requirement');
    expect(facts[0].value).toBe('540日历天');
  });

  it('合同工期分隔形态', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('合同工期为365天')]);
    expect(facts[0].value).toBe('365天');
  });

  it('质量标准', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('质量标准：合格')]);
    expect(facts[0].fieldId).toBe('quality_standard');
    expect(facts[0].value).toBe('合格');
  });

  it('合同估算价（约字被分隔符贪婪吃掉）', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('合同估算价：约500万元')]);
    expect(facts[0].fieldId).toBe('project_investment_estimate');
    expect(facts[0].value).toBe('500万元');
  });

  it('最高投标限价', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('最高投标限价 2000万元')]);
    expect(facts[0].fieldId).toBe('project_investment_estimate');
    expect(facts[0].value).toBe('2000万元');
  });

  it('劳动力高峰（前置形态）', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('劳动力高峰约120人')]);
    expect(facts[0].fieldId).toBe('labor_peak');
    expect(facts[0].value).toBe('120人');
  });

  it('劳动力高峰（高峰期人数形态）', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('高峰期人数约120人')]);
    expect(facts[0].fieldId).toBe('labor_peak');
  });

  it('装配率', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('装配率：30%')]);
    expect(facts[0].fieldId).toBe('assembly_rate');
    expect(facts[0].value).toBe('30%');
  });

  it('基坑支护形式：采用放坡开挖', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('基坑支护形式：采用放坡开挖')]);
    expect(facts[0].fieldId).toBe('foundation_support_form');
    expect(facts[0].value).toBe('采用放坡开挖');
  });

  it('基坑支护形式：土钉墙 → 特征词缺失不产出（真行为）', () => {
    expect(extractProjectBasicFactsFromEvidence([ev('基坑支护形式：土钉墙')])).toHaveLength(0);
  });

  it('创优奖惩金额', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('创优奖惩：获得市优奖奖励10万元')]);
    expect(facts[0].fieldId).toBe('award_clause');
    expect(facts[0].value).toBe('10万元');
  });

  it('争创鲁班奖金额（第二模式）', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('争创鲁班奖，奖励10万元')]);
    expect(facts[0].fieldId).toBe('award_clause');
  });

  it('跨行合并：540\\n日历天', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('计划工期：540\n日历天')]);
    expect(facts[0].value).toBe('540日历天');
  });

  it('跨行合并：28570.36平方\\n米', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('总建筑面积约28570.36平方\n米')]);
    expect(facts[0].value).toBe('总建筑面积约28570.36平方米');
  });

  it('PDF 标题噪声行内清理', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('总建筑面积约28570.36平方\n\n### 米')]);
    expect(facts[0].value).toBe('总建筑面积约28570.36平方米');
  });

  it('商务明细行过滤（报价明细行不采）', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('报价明细表\n计划工期：180日历天')]);
    expect(facts).toHaveLength(1);
    expect(facts[0].fieldId).toBe('schedule_requirement');
  });

  it('商务豁免：投资估算行含关键词不滤', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('投资估算：500万元')]);
    expect(facts[0].fieldId).toBe('project_investment_estimate');
  });

  it('同文件同字段同值去重', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('项目名称：合肥某大学宿舍楼工程\n项目名称：合肥某大学宿舍楼工程')]);
    expect(facts).toHaveLength(1);
  });

  it('页码污染值拒收', () => {
    expect(extractProjectBasicFactsFromEvidence([ev('项目名称：某工程第46页共47页')])).toHaveLength(0);
  });

  it('低分证据 confidence 保底 0.82', () => {
    const facts = extractProjectBasicFactsFromEvidence([ev('项目名称：合肥某工程', { score: 0.5 })]);
    expect(facts[0].confidence).toBe(0.82);
  });
});

// ═══════ A6 extractBillItemFacts ═══════
describe('A6 extractBillItemFacts', () => {
  const table = (headers: string[], rows: string[][]): StructuredTableFact => ({
    tableType: 'bill_of_quantities', sheet: '分部分项', headers, rows, sourceFile: '清单.xlsx', sourceRange: 'A1:F10',
  });
  const stdHeaders = ['序号', '项目编码', '项目名称', '项目特征描述', '计量单位', '工程量'];

  it('单行清单条目 → 行级事实', () => {
    const facts = extractBillItemFacts([table(stdHeaders, [['1', '010101001', '垫层', '1.混凝土种类:商品混凝土 2.混凝土强度等级:C15', 'm3', '100']])]);
    expect(facts).toHaveLength(1);
    expect(facts[0].key).toBe('清单条目：垫层');
    expect(facts[0].fieldId).toBe('bill_item');
    expect(facts[0].value).toBe('1.混凝土种类:商品混凝土 2.混凝土强度等级:C15｜工程量：100m3');
    expect(facts[0].roleId).toBe('bill_of_quantities');
    expect(facts[0].confidence).toBe(0.92);
  });

  it('序号非纯整数行跳过', () => {
    const facts = extractBillItemFacts([table(stdHeaders, [['1.5', '010101001', '垫层', 'C15', 'm3', '100']])]);
    expect(facts).toHaveLength(0);
  });

  it('名称为空跳过', () => {
    const facts = extractBillItemFacts([table(stdHeaders, [['1', '010101001', '', 'C15', 'm3', '100']])]);
    expect(facts).toHaveLength(0);
  });

  it('特征为空跳过', () => {
    const facts = extractBillItemFacts([table(stdHeaders, [['1', '010101001', '垫层', '', 'm3', '100']])]);
    expect(facts).toHaveLength(0);
  });

  it('表头噪声行跳过（工程名称）', () => {
    const facts = extractBillItemFacts([table(stdHeaders, [['1', '010101001', '工程名称', 'C15', 'm3', '100']])]);
    expect(facts).toHaveLength(0);
  });

  it('无序号列不按序号过滤', () => {
    const headers = ['项目名称', '项目特征描述', '计量单位', '工程量'];
    const facts = extractBillItemFacts([table(headers, [['垫层', 'C15', 'm3', '100']])]);
    expect(facts).toHaveLength(1);
  });

  it('无计量单位时工程量部分退化', () => {
    const facts = extractBillItemFacts([table(stdHeaders, [['1', '010101001', '垫层', 'C15', '', '100']])]);
    expect(facts[0].value).toBe('C15｜工程量：100');
  });

  it('无工程量但单位存在 → 工程量部分只含单位（真行为）', () => {
    const facts = extractBillItemFacts([table(stdHeaders, [['1', '010101001', '垫层', 'C15', 'm3', '']])]);
    expect(facts[0].value).toBe('C15｜工程量：m3');
  });

  it('表无名称/特征列 → 整表跳过', () => {
    const facts = extractBillItemFacts([table(['列A', '列B'], [['x', 'y']])]);
    expect(facts).toHaveLength(0);
  });

  it('多行产出多条事实', () => {
    const rows = [['1', '010101001', '垫层', 'C15', 'm3', '100'], ['2', '010101002', '主体', 'C30', 'm3', '200']];
    expect(extractBillItemFacts([table(stdHeaders, rows)])).toHaveLength(2);
  });

  it('sourceRef 携带工作表名', () => {
    const facts = extractBillItemFacts([table(stdHeaders, [['1', '010101001', '垫层', 'C15', 'm3', '100']])]);
    expect(facts[0].sourceRef?.sectionTitle).toBe('分部分项');
    expect(facts[0].sourceRef?.filePath).toBe('清单.xlsx');
  });
});

// ═══════ A7 buildSpecAuthorityMap ═══════
describe('A7 buildSpecAuthorityMap', () => {
  const bill = (key: string, value: string): DocumentFact => ({
    key, value, sourceFile: '清单.xlsx', roleId: 'bill_of_quantities', confidence: 0.92,
  });

  it('分句标签归维（分号分隔）', () => {
    const map = buildSpecAuthorityMap([bill('清单条目：垫层', '1.混凝土强度等级:C15；2.砂浆强度等级:M5')]);
    expect(map['混凝土强度等级']).toEqual([{ location: '垫层', spec: 'C15', quantity: undefined, sourceFile: '清单.xlsx' }]);
    expect(map['砂浆强度等级']?.[0].spec).toBe('M5');
  });

  it('空格分隔不拆句（真行为）：单句吞并列', () => {
    const map = buildSpecAuthorityMap([bill('清单条目：垫层', '1.混凝土强度等级:C15 2.砂浆强度等级:M5')]);
    expect(map['混凝土强度等级']?.[0].spec).toBe('C15 2.砂浆强度等级:M5');
  });

  it('无分句结构 token 兜底归维', () => {
    const map = buildSpecAuthorityMap([bill('清单条目：主体结构', 'C30商品混凝土')]);
    expect(map['混凝土强度等级']?.[0]).toEqual({ location: '主体结构', spec: 'C30', quantity: undefined, sourceFile: '清单.xlsx' });
  });

  it('标签非维度词但值含 token → token 归维', () => {
    const map = buildSpecAuthorityMap([bill('清单条目：垫层', '主要材料:商品混凝土 C30')]);
    expect(map['混凝土强度等级']?.[0].spec).toBe('C30');
  });

  it('标签维度名即键（找平层厚度），token 兜底归厚度规格', () => {
    const map = buildSpecAuthorityMap([bill('清单条目：找平层', '找平层厚度:120mm')]);
    expect(map['找平层厚度']?.[0].spec).toBe('120mm');
    const map2 = buildSpecAuthorityMap([bill('清单条目：找平层', '120mm')]);
    expect(map2['厚度规格']?.[0].spec).toBe('120mm');
  });

  it('钢筋牌号 HRB400', () => {
    const map = buildSpecAuthorityMap([bill('清单条目：梁', 'HRB400')]);
    expect(map['钢筋牌号']?.[0].spec).toBe('HRB400');
  });

  it('抗渗等级 P6', () => {
    const map = buildSpecAuthorityMap([bill('清单条目：底板', 'P6')]);
    expect(map['抗渗等级']?.[0].spec).toBe('P6');
  });

  it('砌块强度等级 MU10', () => {
    const map = buildSpecAuthorityMap([bill('清单条目：墙体', 'MU10')]);
    expect(map['砌块强度等级']?.[0].spec).toBe('MU10');
  });

  it('未知 token 归规格', () => {
    const map = buildSpecAuthorityMap([bill('清单条目：钢梁', 'Q235')]);
    expect(map['规格']?.[0].spec).toBe('Q235');
  });

  it('工程量捕获', () => {
    const map = buildSpecAuthorityMap([bill('清单条目：垫层', 'C15｜工程量：100m3')]);
    expect(map['混凝土强度等级']?.[0].quantity).toBe('100m3');
  });

  it('spec 尾部逗号清洗', () => {
    const map = buildSpecAuthorityMap([bill('清单条目：垫层', '1.混凝土强度等级:C30,')]);
    expect(map['混凝土强度等级']?.[0].spec).toBe('C30');
  });

  it('同部位同规格去重', () => {
    const map = buildSpecAuthorityMap([bill('清单条目：垫层', '1.混凝土强度等级:C15'), bill('清单条目：垫层', '1.混凝土强度等级:C15')]);
    expect(map['混凝土强度等级']).toHaveLength(1);
  });

  it('同物多规格按部位区分（C15 垫层/C30 主体）', () => {
    const map = buildSpecAuthorityMap([bill('清单条目：垫层', 'C15'), bill('清单条目：主体结构', 'C30')]);
    expect(map['混凝土强度等级']).toHaveLength(2);
  });

  it('空输入 → 空 map', () => {
    expect(buildSpecAuthorityMap([])).toEqual({});
  });
});

// ═══════ A8 normalizedFactValue ═══════
describe('A8 normalizedFactValue', () => {
  it('小写化', () => {
    expect(normalizedFactValue('C30')).toBe('c30');
  });

  it('平方米归一 m2', () => {
    expect(normalizedFactValue('500平方米')).toBe('500m2');
  });

  it('全角符号半角化', () => {
    expect(normalizedFactValue('３０％')).toBe('30%');
  });

  it('非字符串 stringify', () => {
    expect(normalizedFactValue(12 as unknown as string)).toBe('12');
  });
});

// ═══════ A9 reliableFactForTarget ═══════
describe('A9 reliableFactForTarget', () => {
  const target = { id: 'project_name', name: '项目名称', required: true, sourceRoleIds: [] as string[], extractionHint: '' };
  const fact = (extra: Partial<DocumentFact>): DocumentFact => ({
    key: '项目名称', value: '某工程', sourceFile: 'f', roleId: 'project_basic_fact', confidence: 0.9, ...extra,
  });

  it('project_basic_fact 角色 0.55 阈值', () => {
    expect(reliableFactForTarget(fact({ fieldId: 'project_name', confidence: 0.6 }), target)).toBe(true);
    expect(reliableFactForTarget(fact({ fieldId: 'project_name', confidence: 0.5 }), target)).toBe(false);
  });

  it('普通角色 0.75 阈值', () => {
    expect(reliableFactForTarget(fact({ fieldId: 'project_name', roleId: 'unknown', confidence: 0.8 }), target)).toBe(true);
    expect(reliableFactForTarget(fact({ fieldId: 'project_name', roleId: 'unknown', confidence: 0.7 }), target)).toBe(false);
  });

  it('sourceRef.filePath 走 0.55 阈值', () => {
    const sourceRef: FactSourceRef = { filePath: 'a.txt', roleId: 'r' };
    expect(reliableFactForTarget(fact({ fieldId: 'project_name', roleId: 'unknown', confidence: 0.6, sourceRef }), target)).toBe(true);
  });

  it('空值/单字值 → false', () => {
    expect(reliableFactForTarget(fact({ fieldId: 'project_name', value: '' }), target)).toBe(false);
    expect(reliableFactForTarget(fact({ fieldId: 'project_name', value: '字' }), target)).toBe(false);
  });

  it('超长低置信 → false', () => {
    expect(reliableFactForTarget(fact({ fieldId: 'project_name', value: '长'.repeat(221), confidence: 0.6 }), target)).toBe(false);
  });

  it('超长高置信 → 继续判定', () => {
    expect(reliableFactForTarget(fact({ fieldId: 'project_name', value: '长'.repeat(221), confidence: 0.9 }), target)).toBe(true);
  });

  it('身份不匹配 target → false', () => {
    expect(reliableFactForTarget(fact({ fieldId: 'other', key: '其他', fieldName: '其他' }), target)).toBe(false);
  });
});
