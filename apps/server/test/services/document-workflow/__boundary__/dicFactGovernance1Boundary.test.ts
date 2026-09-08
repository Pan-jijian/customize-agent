/**
 * t3-mf FG1 组：factGovernance 评分链 + 字段规范矩阵。
 * 覆盖：PROJECT_BASIC_FIELD_SPECS 13 字段结构 / SUPPORT_FORM_LEXICON 6 词 /
 * scoreFactCandidate 评分链（归一化→空值过长→条款噪声→字段串位→引用弱值→值型评分→
 * 来源加成→补疑权威→招标可信→生成扣分）/ fieldSpecForFact / collectStructuredFactCandidates
 * （含 excavation_depth 图纸标注补抽）/ extractDrawingAnnotationFacts（深度回看上一行/
 * 坑底H排除/比较式排除/支护形式采样去重）/ collectMarkdownTableCandidates /
 * resolveCanonicalFacts / buildCanonicalFacts。
 * 全部断言按源码实现逐条推导，真实行为锁定（不修改实现迎合用例）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildCanonicalFacts,
  collectMarkdownTableCandidates,
  collectStructuredFactCandidates,
  extractDrawingAnnotationFacts,
  fieldSpecForFact,
  PROJECT_BASIC_FIELD_SPECS,
  resolveCanonicalFacts,
  scoreFactCandidate,
  SUPPORT_FORM_LEXICON,
  type FieldSpec,
} from '@/services/document-workflow/factGovernance';
import type { DocumentFact, FactSourceRef } from '@/services/document-workflow/types';

const specOf = (key: string): FieldSpec => PROJECT_BASIC_FIELD_SPECS.find(item => item.key === key)!;
const textSpec = (key = 'custom_text'): FieldSpec => ({ key, label: '自定义', aliases: [], valueType: 'text' });
const cand = (fieldKey: string, value: string, extra: Partial<Parameters<typeof scoreFactCandidate>[0]> = {}) =>
  scoreFactCandidate({ fieldKey, label: 'L', value, sourceType: 'structured_fact', ...extra }, specOf(fieldKey));

// ═══════ P1 PROJECT_BASIC_FIELD_SPECS 字段结构 ═══════
describe('P1 PROJECT_BASIC_FIELD_SPECS 字段结构', () => {
  it('共 13 个基础字段槽位', () => {
    expect(PROJECT_BASIC_FIELD_SPECS).toHaveLength(13);
  });

  it('关键字段 key/valueType 配对', () => {
    const pairs = PROJECT_BASIC_FIELD_SPECS.map(item => `${item.key}:${item.valueType}`);
    expect(pairs).toEqual([
      'project_name:text', 'project_code:identifier', 'owner:organization', 'project_location:location',
      'project_scale:scale', 'schedule_requirement:duration', 'quality_standard:standard',
      'project_investment_estimate:money', 'labor_peak:count', 'assembly_rate:percentage',
      'foundation_support_form:text', 'excavation_depth:text', 'award_clause:award',
    ]);
  });

  it('project_name 别名含工程名称/招标项目名称', () => {
    expect(specOf('project_name').aliases).toEqual(['项目名称', '工程名称', '招标项目名称']);
  });

  it('schedule_requirement 别名含六个工期口径词', () => {
    expect(specOf('schedule_requirement').aliases).toEqual(['计划工期', '合同工期', '总工期', '工期', '实施周期', '服务期限']);
  });

  it('excavation_depth 别名含图纸标注形态词（坡底线/坑底）', () => {
    expect(specOf('excavation_depth').aliases).toContain('坡底线');
    expect(specOf('excavation_depth').aliases).toContain('坑底');
  });

  it('owner 别名含五类招标人角色', () => {
    expect(specOf('owner').aliases).toEqual(['招标人', '项目业主', '建设单位', '发包人', '采购人']);
  });

  it('money 字段别名含最高投标限价/招标控制价/预算金额', () => {
    expect(specOf('project_investment_estimate').aliases).toContain('最高投标限价');
    expect(specOf('project_investment_estimate').aliases).toContain('招标控制价');
    expect(specOf('project_investment_estimate').aliases).toContain('预算金额');
  });
});

// ═══════ P2 SUPPORT_FORM_LEXICON 支护形式封闭词表 ═══════
describe('P2 SUPPORT_FORM_LEXICON 支护形式封闭词表', () => {
  it('六项映射齐全', () => {
    expect(SUPPORT_FORM_LEXICON.map(item => item.form)).toEqual(['土钉墙', '锚杆支护', '喷锚支护', '放坡开挖', '地下连续墙', '支护桩']);
  });

  it('土钉模式命中钢管土钉/钢花管土钉', () => {
    const { pattern } = SUPPORT_FORM_LEXICON[0];
    expect(pattern.test('钢管土钉开孔大样')).toBe(true);
    expect(pattern.test('钢花管土钉')).toBe(true);
    expect(pattern.test('钢管桩')).toBe(false);
  });

  it('锚杆模式命中锚杆与锚索', () => {
    const { pattern } = SUPPORT_FORM_LEXICON[1];
    expect(pattern.test('锚杆支护')).toBe(true);
    expect(pattern.test('预应力锚索')).toBe(true);
  });
});

// ═══════ S1 scoreFactCandidate 评分链 ═══════
describe('S1 scoreFactCandidate 评分链', () => {
  describe('duration 工期分支', () => {
    it('180日历天 → 75 不拒绝', () => {
      const r = cand('schedule_requirement', '180日历天');
      expect(r.rejected).toBe(false);
      expect(r.confidence).toBe(75);
      expect(r.reasons).toContain('包含明确工期数值和时间单位');
    });

    it('约2年 → 75', () => {
      expect(cand('schedule_requirement', '约2年').confidence).toBe(75);
    });

    it('12个月 → 75', () => {
      expect(cand('schedule_requirement', '12个月').confidence).toBe(75);
    });

    it('违约条款命中延误 → 拒绝 -105（叠加发包人串位）', () => {
      const r = cand('schedule_requirement', '工期延误56天以上发包人可切除剩余工程量');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-105);
      expect(r.reasons).toContain('命中工期违约条款而非计划工期');
    });

    it('逾期罚款无数值单位 → 缺单位拒绝', () => {
      const r = cand('schedule_requirement', '每逾期一天罚款1000元');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-50);
    });

    it('180个工作日 → 缺单位拒绝 -50', () => {
      const r = cand('schedule_requirement', '180个工作日');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-50);
    });

    it('无数字 → 缺单位拒绝', () => {
      expect(cand('schedule_requirement', '工期').rejected).toBe(true);
    });

    it('含其他字段名串位 → -45 但值型仍通过', () => {
      const r = cand('schedule_requirement', '计划工期365天，质量标准合格');
      expect(r.confidence).toBe(30 - 45 + 45);
      expect(r.reasons).toContain('包含其他字段名，疑似字段串位');
    });

    it('引用型弱值叠加缺单位', () => {
      const r = cand('schedule_requirement', '详见招标文件');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-85);
    });
  });

  describe('money 金额分支', () => {
    it('约500万元 → 75', () => {
      expect(cand('project_investment_estimate', '约500万元').confidence).toBe(75);
    });

    it('工程总投资约2.8亿元 → 75', () => {
      expect(cand('project_investment_estimate', '工程总投资约2.8亿元').confidence).toBe(75);
    });

    it('综合单价120元 → 明细拒绝 -60', () => {
      const r = cand('project_investment_estimate', '综合单价120元');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-60);
      expect(r.reasons).toContain('命中非目标商务明细');
    });

    it('增值税税率9% → 无金额单位拒绝', () => {
      expect(cand('project_investment_estimate', '增值税税率9%').rejected).toBe(true);
    });

    it('500元 → 75', () => {
      expect(cand('project_investment_estimate', '500元').confidence).toBe(75);
    });

    it('投资估算约500万 → 缺单位拒绝 -50', () => {
      expect(cand('project_investment_estimate', '投资估算约500万').rejected).toBe(true);
    });
  });

  describe('standard 标准分支', () => {
    it('合格 → 70', () => {
      expect(cand('quality_standard', '合格').confidence).toBe(70);
    });

    it('工程质量达到合格标准 → 70', () => {
      expect(cand('quality_standard', '工程质量达到合格标准').confidence).toBe(70);
    });

    it('一次性验收合格 → 70', () => {
      expect(cand('quality_standard', '一次性验收合格').confidence).toBe(70);
    });

    it('合格但混入工期词 → -105（工期别名串位叠加）', () => {
      const r = cand('quality_standard', '合格，工期365日历天');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-105);
    });

    it('投标有效期90天 → 条款噪声+缺标准表达 -140', () => {
      const r = cand('quality_standard', '投标有效期90天');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-140);
      expect(r.reasons).toContain('大段条款或 Markdown 噪声');
    });

    it('详见合同约定 → 引用弱值+缺表达 -75', () => {
      const r = cand('quality_standard', '详见合同约定');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-75);
    });
  });

  describe('location 地点分支', () => {
    it('合肥市蜀山区 → 65', () => {
      expect(cand('project_location', '合肥市蜀山区').confidence).toBe(65);
    });

    it('经开区繁华大道 → 65', () => {
      expect(cand('project_location', '经开区繁华大道').confidence).toBe(65);
    });

    it('项目现场 → 20 不拒绝', () => {
      const r = cand('project_location', '项目现场');
      expect(r.rejected).toBe(false);
      expect(r.confidence).toBe(20);
    });

    it('详见招标文件 → 引用型双扣 -45 不拒绝', () => {
      const r = cand('project_location', '详见招标文件');
      expect(r.rejected).toBe(false);
      expect(r.confidence).toBe(-45);
      expect(r.reasons).toContain('引用型地点弱值');
    });
  });

  describe('organization 组织分支', () => {
    it('合肥市重点工程建设管理局 → 65', () => {
      expect(cand('owner', '合肥市重点工程建设管理局').confidence).toBe(65);
    });

    it('投标人 → 角色串位拒绝 -60', () => {
      const r = cand('owner', '投标人');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-60);
    });

    it('评标委员会 → 角色串位拒绝', () => {
      expect(cand('owner', '评标委员会').rejected).toBe(true);
    });

    it('合肥职业技术学院 → 院 特征 65', () => {
      expect(cand('owner', '合肥职业技术学院').confidence).toBe(65);
    });

    it('王明 → 弱特征 35', () => {
      expect(cand('owner', '王明').confidence).toBe(35);
    });
  });

  describe('identifier 编号分支', () => {
    it('HFGQ2024-001 → 65', () => {
      expect(cand('project_code', 'HFGQ2024-001').confidence).toBe(65);
    });

    it('ABC_1.2（3）→ 全角括号合法 65', () => {
      expect(cand('project_code', 'ABC_1.2（3）').confidence).toBe(65);
    });

    it('ABC 123 → 空格非法 -40', () => {
      const r = cand('project_code', 'ABC 123');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-40);
    });

    it('12345平方米 → 格式非法 -40（量纲检查在格式合法后）', () => {
      const r = cand('project_code', '12345平方米');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-40);
    });

    it('HFGQ2024（暂定）→ 汉字非法 -40', () => {
      expect(cand('project_code', 'HFGQ2024（暂定）').rejected).toBe(true);
    });
  });

  describe('scale 规模分支', () => {
    it('总建筑面积约28570.36平方米 → 60', () => {
      expect(cand('project_scale', '总建筑面积约28570.36平方米').confidence).toBe(60);
    });

    it('总建筑面积2.8万㎡ → 万不在单位表 → 文本描述 35', () => {
      expect(cand('project_scale', '总建筑面积2.8万㎡').confidence).toBe(35);
    });

    it('中型项目 → 文本描述 35', () => {
      expect(cand('project_scale', '中型项目').confidence).toBe(35);
    });
  });

  describe('count 人数分支', () => {
    it('劳动力高峰120人 → 70', () => {
      expect(cand('labor_peak', '劳动力高峰120人').confidence).toBe(70);
    });

    it('约50人 → 70', () => {
      expect(cand('labor_peak', '约50人').confidence).toBe(70);
    });

    it('2000平方米 → 缺人数拒绝 -50', () => {
      const r = cand('labor_peak', '2000平方米');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-50);
    });

    it('150人，面积2000平方米 → 混量纲拒绝 -40', () => {
      const r = cand('labor_peak', '150人，面积2000平方米');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-40);
    });
  });

  describe('percentage 百分比分支', () => {
    it('装配率30% → 70', () => {
      expect(cand('assembly_rate', '装配率30%').confidence).toBe(70);
    });

    it('装配率38.4％ → 全角百分号 70', () => {
      expect(cand('assembly_rate', '装配率38.4％').confidence).toBe(70);
    });

    it('约三分之一 → 缺百分比拒绝 -50', () => {
      expect(cand('assembly_rate', '约三分之一').rejected).toBe(true);
    });

    it('30%，工期180天 → 混量纲+工期别名串位 -85', () => {
      const r = cand('assembly_rate', '30%，工期180天');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-85);
    });
  });

  describe('award 奖项分支', () => {
    it('合肥市优质工程奖 → 70', () => {
      expect(cand('award_clause', '合肥市优质工程奖').confidence).toBe(70);
    });

    it('创优奖惩：获得市优奖奖励10万元 → 70', () => {
      expect(cand('award_clause', '创优奖惩：获得市优奖奖励10万元').confidence).toBe(70);
    });

    it('鲁班杯 → 70', () => {
      expect(cand('award_clause', '鲁班杯').confidence).toBe(70);
    });

    it('按评标办法执行 → 缺特征拒绝 -40', () => {
      expect(cand('award_clause', '按评标办法执行').rejected).toBe(true);
    });

    it('获市优奖，详见评标细则 → 引用弱值+评标污染 -95', () => {
      const r = cand('award_clause', '获市优奖，详见评标细则');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-95);
    });
  });

  describe('project_name 文本特例', () => {
    it('某大学新校区学生宿舍楼施工总承包工程 → 65', () => {
      expect(cand('project_name', '某大学新校区学生宿舍楼施工总承包工程').confidence).toBe(65);
    });

    it('存在部位风险等级管控措施 → 表头噪声拒绝 -60', () => {
      const r = cand('project_name', '存在部位风险等级管控措施');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-60);
    });

    it('基础设施建设 → 无工程词拒绝 -40', () => {
      expect(cand('project_name', '基础设施建设').rejected).toBe(true);
    });

    it('教学楼项目 → 65', () => {
      expect(cand('project_name', '教学楼项目').confidence).toBe(65);
    });
  });

  describe('foundation_support_form 文本特例', () => {
    it('土钉墙 → 60', () => {
      expect(cand('foundation_support_form', '土钉墙').confidence).toBe(60);
    });

    it('放坡+喷锚 → 60', () => {
      expect(cand('foundation_support_form', '放坡+喷锚').confidence).toBe(60);
    });

    it('挂网喷浆 → 通用喷字 60', () => {
      expect(cand('foundation_support_form', '挂网喷浆').confidence).toBe(60);
    });

    it('检测监测频次要求 → 无支护特征拒绝 -40（监测检查在其后）', () => {
      const r = cand('foundation_support_form', '检测监测频次要求');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-40);
    });

    it('平面布置图 → 无支护特征拒绝 -40', () => {
      expect(cand('foundation_support_form', '平面布置图').rejected).toBe(true);
    });
  });

  describe('excavation_depth 文本特例', () => {
    it('5.15m → 60', () => {
      expect(cand('excavation_depth', '5.15m').confidence).toBe(60);
    });

    it('基坑开挖深度约5.2米 → 60', () => {
      expect(cand('excavation_depth', '基坑开挖深度约5.2米').confidence).toBe(60);
    });

    it('监测频次要求 → 无数值拒绝 -40', () => {
      expect(cand('excavation_depth', '监测频次要求').rejected).toBe(true);
    });

    it('5m，监测频次每2小时一次 → 监测污染拒绝 -50', () => {
      const r = cand('excavation_depth', '5m，监测频次每2小时一次');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-50);
    });
  });

  describe('普通 text 分支', () => {
    it('单字 → -20 不拒绝 10', () => {
      const r = scoreFactCandidate({ fieldKey: 'foo', label: 'L', value: '简', sourceType: 'structured_fact' }, textSpec());
      expect(r.rejected).toBe(false);
      expect(r.confidence).toBe(10);
    });

    it('长文本 → +10 40', () => {
      expect(scoreFactCandidate({ fieldKey: 'foo', label: 'L', value: '较长的文本描述', sourceType: 'structured_fact' }, textSpec()).confidence).toBe(40);
    });
  });

  describe('空值与过长', () => {
    it('空字符串 → 拒绝 -150（叠加缺单位）', () => {
      const r = cand('schedule_requirement', '');
      expect(r.rejected).toBe(true);
      expect(r.confidence).toBe(-150);
      expect(r.reasons).toContain('空值或过长');
    });

    it('超过 260 字符 → 拒绝', () => {
      const r = cand('schedule_requirement', '长'.repeat(261));
      expect(r.rejected).toBe(true);
      expect(r.reasons).toContain('空值或过长');
    });

    it('恰好 260 字符 → 不因长度拒绝', () => {
      const r = scoreFactCandidate({ fieldKey: 'foo', label: 'L', value: '字'.repeat(260), sourceType: 'structured_fact' }, textSpec());
      expect(r.reasons).not.toContain('空值或过长');
    });
  });

  describe('条款噪声 hasClauseNoise', () => {
    it.each([
      '### 投标文件的编制',
      '投标有效期90天',
      '备选投标方案',
      '投标人提供',
      '评标委员会',
      '招标人有权核查',
      '电子交易系统',
      '中标候选',
    ])('%s → 拒绝 -100 起步', (value) => {
      const r = cand('schedule_requirement', value);
      expect(r.rejected).toBe(true);
      expect(r.reasons).toContain('大段条款或 Markdown 噪声');
    });
  });

  describe('引用型弱值 isReferenceOnly（text spec 隔离）', () => {
    it('详见招标文件 → -35 后仍 +10 → 5', () => {
      const r = scoreFactCandidate({ fieldKey: 'foo', label: 'L', value: '详见招标文件', sourceType: 'structured_fact' }, textSpec());
      expect(r.confidence).toBe(5);
      expect(r.reasons).toContain('引用型弱值');
    });

    it('按合同约定执行 → 引用型 5', () => {
      expect(scoreFactCandidate({ fieldKey: 'foo', label: 'L', value: '按合同约定执行', sourceType: 'structured_fact' }, textSpec()).confidence).toBe(5);
    });

    it('独立文本内容 → 非引用型 40', () => {
      expect(scoreFactCandidate({ fieldKey: 'foo', label: 'L', value: '独立文本内容', sourceType: 'structured_fact' }, textSpec()).confidence).toBe(40);
    });
  });

  describe('来源加成链', () => {
    it('evidence 来源 +20', () => {
      const r = cand('schedule_requirement', '180日历天', { sourceType: 'evidence' });
      expect(r.confidence).toBe(95);
      expect(r.reasons).toContain('来源为证据原文');
    });

    it('补疑类 sourceName +35', () => {
      const r = cand('schedule_requirement', '180日历天', { sourceName: '补疑文件' });
      expect(r.confidence).toBe(110);
      expect(r.reasons).toContain('补疑/澄清类修正文件，权威最高');
    });

    it('澄清函 +35', () => {
      expect(cand('schedule_requirement', '180日历天', { sourceName: '澄清函' }).confidence).toBe(110);
    });

    it('招标文件正文 +15', () => {
      const r = cand('schedule_requirement', '180日历天', { sourceName: '招标文件正文' });
      expect(r.confidence).toBe(90);
      expect(r.reasons).toContain('来源文件可信');
    });

    it('generated_markdown -10', () => {
      expect(cand('schedule_requirement', '180日历天', { sourceType: 'generated_markdown' }).confidence).toBe(65);
    });

    it('补疑+招标词叠加双加成 125', () => {
      expect(cand('schedule_requirement', '180日历天', { sourceName: '补疑文件（含招标文件条款）' }).confidence).toBe(125);
    });

    it('补疑+evidence 叠加 130', () => {
      expect(cand('schedule_requirement', '180日历天', { sourceType: 'evidence', sourceName: '补疑文件' }).confidence).toBe(130);
    });
  });

  describe('normalizeOcrFactText 归一化入值', () => {
    it('汉字间空格合并+数字单位黏合 → 75', () => {
      const r = cand('schedule_requirement', '计 划 工 期 365 天');
      expect(r.value).toBe('计划工期 365天');
      expect(r.confidence).toBe(75);
    });

    it('约 500 万元 → 约 500万元', () => {
      expect(cand('project_investment_estimate', '约 500 万元').value).toBe('约 500万元');
    });
  });
});

// ═══════ F1 fieldSpecForFact ═══════
describe('F1 fieldSpecForFact', () => {
  const fact = (extra: Partial<DocumentFact>): DocumentFact => ({
    key: 'k', value: 'v', sourceFile: 'f', roleId: 'r', confidence: 0.5, ...extra,
  });

  it('fieldId 直配 project_name', () => {
    expect(fieldSpecForFact(fact({ fieldId: 'project_name' }))?.key).toBe('project_name');
  });

  it('fieldName 别名命中工程名称', () => {
    expect(fieldSpecForFact(fact({ fieldName: '工程名称' }))?.key).toBe('project_name');
  });

  it('key 命中坡底线 → excavation_depth', () => {
    expect(fieldSpecForFact(fact({ key: '坡底线' }))?.key).toBe('excavation_depth');
  });

  it('find 顺序遍历：fieldName 别名先命中 project_name（数组序优先于 fieldId 直配）', () => {
    expect(fieldSpecForFact(fact({ fieldId: 'labor_peak', fieldName: '工程名称' }))?.key).toBe('project_name');
  });

  it('无任何命中 → undefined', () => {
    expect(fieldSpecForFact(fact({ key: '备注', fieldName: '其他' }))).toBeUndefined();
  });

  it('招标人 → owner', () => {
    expect(fieldSpecForFact(fact({ fieldName: '招标人' }))?.key).toBe('owner');
  });
});

// ═══════ C1 collectStructuredFactCandidates ═══════
describe('C1 collectStructuredFactCandidates', () => {
  const fact = (extra: Partial<DocumentFact>): DocumentFact => ({
    key: 'k', value: 'v', sourceFile: '招标文件正文', roleId: 'r', confidence: 0.9, ...extra,
  });

  it('直配字段产生候选，来源可信加成 80', () => {
    const list = collectStructuredFactCandidates([fact({ fieldId: 'project_name', value: '某大学宿舍楼工程' })]);
    expect(list).toHaveLength(1);
    expect(list[0].fieldKey).toBe('project_name');
    expect(list[0].confidence).toBe(80);
  });

  it('无 spec 的事实跳过', () => {
    expect(collectStructuredFactCandidates([fact({ key: '备注', value: 'x' })])).toHaveLength(0);
  });

  it('excavation_depth 补抽：坡底线标注形态', () => {
    const list = collectStructuredFactCandidates([fact({ key: '图纸语义', value: '-5.150 坡底线', sourceFile: '基坑图.dwg' })]);
    expect(list).toHaveLength(1);
    expect(list[0].fieldKey).toBe('excavation_depth');
    expect(list[0].value).toBe('5.15m（图纸标注：-5.150 坡底线）');
    expect(list[0].confidence).toBe(60);
  });

  it('补抽取绝对值最大（电梯井最深）', () => {
    const list = collectStructuredFactCandidates([fact({ key: '标注', value: '坡底线 -5.150，电梯井 -7.100', sourceFile: 'a.dwg' })]);
    expect(list[0].value).toBe('7.1m（图纸标注：坡底线 -5.150，电梯井 -7.100）');
  });

  it('fieldId=excavation_depth 直配不重复补抽', () => {
    const list = collectStructuredFactCandidates([fact({ fieldId: 'excavation_depth', value: '-5.150 坡底线', sourceFile: 'a.dwg' })]);
    expect(list).toHaveLength(1);
  });

  it('数值 0.3m → 范围过滤无候选', () => {
    expect(collectStructuredFactCandidates([fact({ key: '标注', value: '-0.300 坡底线', sourceFile: 'a.dwg' })])).toHaveLength(0);
  });

  it('数值 120m → 范围过滤无候选', () => {
    expect(collectStructuredFactCandidates([fact({ key: '标注', value: '-120.000 坑底', sourceFile: 'a.dwg' })])).toHaveLength(0);
  });

  it('补抽 sourceName 回退 drawing_annotation', () => {
    const list = collectStructuredFactCandidates([fact({ key: '标注', value: '-5.150 坡底线', sourceFile: '' })]);
    expect(list[0].sourceName).toBe('drawing_annotation');
  });

  it('数字 value 经 stringifyFactValue 处理', () => {
    const f: DocumentFact = { ...fact({ fieldId: 'labor_peak' }), value: 120 as unknown as string };
    const list = collectStructuredFactCandidates([f]);
    expect(list).toHaveLength(1);
    expect(list[0].rejected).toBe(true);
  });
});

// ═══════ D1 extractDrawingAnnotationFacts ═══════
describe('D1 extractDrawingAnnotationFacts', () => {
  const ev = (content: string, extra: Partial<{ filePath: string; processingType: string; sectionTitle: string; roleId: string }> = {}): Parameters<typeof extractDrawingAnnotationFacts>[0][number] => ({
    filePath: extra.filePath ?? 'a.dwg', content, processingType: extra.processingType ?? 'drawing', roleId: extra.roleId, sectionTitle: extra.sectionTitle,
  });

  it('CAD 语义标注分两行：回看上一行纯数值', () => {
    const facts = extractDrawingAnnotationFacts([ev('CAD 语义标注\n-5.150\n坡底线')]);
    expect(facts).toHaveLength(1);
    expect(facts[0].fieldId).toBe('excavation_depth');
    expect(facts[0].value).toBe('5.15m（图纸标注：-5.150 坡底线）');
    expect(facts[0].sourceFile).toBe('图纸标注');
    expect(facts[0].confidence).toBe(90);
  });

  it('processingType=drawing 无需 CAD 语义标注标记', () => {
    const facts = extractDrawingAnnotationFacts([ev('-5.150\n坡底线', { filePath: 'b.dwg' })]);
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toBe('5.15m（图纸标注：-5.150 坡底线）');
  });

  it('坑底H-1500 形态排除（集水井大样非标高语义）', () => {
    expect(extractDrawingAnnotationFacts([ev('坑底H-1500', { filePath: 'c.dwg' })])).toHaveLength(0);
  });

  it('比较式条文排除（危大目录阈值）', () => {
    expect(extractDrawingAnnotationFacts([ev('开挖深度16m及以上的人工挖孔桩工程', { filePath: 'd.dwg' })])).toHaveLength(0);
  });

  it('坡比 1:0.75 排除比值误采', () => {
    const facts = extractDrawingAnnotationFacts([ev('坡底线 5.2\n坡比 1:0.75', { filePath: 'e.dwg' })]);
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toContain('5.2m');
  });

  it('1# 编号不误采（next 为 #）', () => {
    const facts = extractDrawingAnnotationFacts([ev('1# 基坑开挖深度 5.2m', { filePath: 'f.dwg' })]);
    expect(facts[0].value).toContain('5.2m');
  });

  it('多处深度取最大值（坑底标高也是深度标签）', () => {
    const facts = extractDrawingAnnotationFacts([ev('坡底线 -5.150\n坑底标高 -7.100', { filePath: 'g.dwg' })]);
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toBe('7.1m（图纸标注：坡底线 -5.150；坑底标高 -7.100）');
  });

  it('支护形式采样：钢管土钉 → 土钉墙', () => {
    const facts = extractDrawingAnnotationFacts([ev('钢管土钉开孔大样', { filePath: 'h.dwg' })]);
    expect(facts).toHaveLength(1);
    expect(facts[0].fieldId).toBe('foundation_support_form');
    expect(facts[0].value).toBe('土钉墙（图纸标注：钢管土钉开孔大样）');
  });

  it('一行多形式：放坡 + 锚杆 → 按词表序排列且逐形式采样（同语境重复入集）', () => {
    const facts = extractDrawingAnnotationFacts([ev('放坡 + 锚杆', { filePath: 'i.dwg' })]);
    expect(facts[0].value).toBe('锚杆支护、放坡开挖（图纸标注：放坡 + 锚杆；放坡 + 锚杆）');
  });

  it('同词多行去重', () => {
    const facts = extractDrawingAnnotationFacts([ev('钢管土钉大样\n钢花管土钉剖面', { filePath: 'j.dwg' })]);
    expect(facts[0].value).toContain('土钉墙');
    expect(facts[0].value).not.toContain('、土钉墙');
  });

  it('深度+支护同证据 → 两条事实', () => {
    const facts = extractDrawingAnnotationFacts([ev('-5.150\n坡底线\n钢管土钉开孔大样', { filePath: 'k.dwg' })]);
    expect(facts).toHaveLength(2);
  });

  it('非图纸非标注证据跳过', () => {
    expect(extractDrawingAnnotationFacts([ev('普通说明文字', { filePath: 'l.txt', processingType: 'text' })])).toHaveLength(0);
  });

  it('图纸证据但无标签无形式词 → 空', () => {
    expect(extractDrawingAnnotationFacts([ev('普通说明文字', { filePath: 'm.dwg' })])).toHaveLength(0);
  });

  it('sectionTitle 含 dwg 也视为图纸证据', () => {
    const facts = extractDrawingAnnotationFacts([ev('坡底线 -5.150', { filePath: '', sectionTitle: '基坑图.dwg' })]);
    expect(facts).toHaveLength(1);
  });
});

// ═══════ T1 collectMarkdownTableCandidates ═══════
describe('T1 collectMarkdownTableCandidates', () => {
  it('两列表格 → label/value 提取，generated_markdown 扣分 55', () => {
    const list = collectMarkdownTableCandidates('| 项目名称 | 某大学宿舍楼工程 |');
    expect(list).toHaveLength(1);
    expect(list[0].fieldKey).toBe('project_name');
    expect(list[0].value).toBe('某大学宿舍楼工程');
    expect(list[0].confidence).toBe(55);
    expect(list[0].sourceType).toBe('generated_markdown');
  });

  it('序号四列形态 → label=列2 value=列3 source=列4', () => {
    const list = collectMarkdownTableCandidates('| 序号 | 项目名称 | 某大学宿舍楼工程 | 招标文件 |');
    expect(list[0].fieldKey).toBe('project_name');
    expect(list[0].value).toBe('某大学宿舍楼工程');
    expect(list[0].sourceName).toBe('招标文件');
    expect(list[0].confidence).toBe(70);
  });

  it('分隔行跳过', () => {
    expect(collectMarkdownTableCandidates('| --- | --- |')).toHaveLength(0);
  });

  it('无 spec 标签跳过', () => {
    expect(collectMarkdownTableCandidates('| 备注 | 暂无 |')).toHaveLength(0);
  });

  it('占位值跳过', () => {
    expect(collectMarkdownTableCandidates('| 项目名称 | 资料未明确 |')).toHaveLength(0);
  });

  it('粗体单元格剥离 **', () => {
    const list = collectMarkdownTableCandidates('| **项目名称** | **某工程** |');
    expect(list).toHaveLength(1);
    expect(list[0].value).toBe('某工程');
  });

  it('非表格行跳过', () => {
    expect(collectMarkdownTableCandidates('项目名称：某工程')).toHaveLength(0);
  });

  it('基坑开挖深度表格行 → 50', () => {
    const list = collectMarkdownTableCandidates('| 基坑开挖深度 | 5.15m |');
    expect(list[0].confidence).toBe(50);
  });

  it('三列表格（非序号）→ 第三列为来源', () => {
    const list = collectMarkdownTableCandidates('| 项目名称 | 某大学宿舍楼工程 | 招标文件正文 |');
    expect(list[0].sourceName).toBe('招标文件正文');
    expect(list[0].confidence).toBe(70);
  });

  it('项目编号表格行 → identifier 55', () => {
    const list = collectMarkdownTableCandidates('| 项目编号 | HFGQ2024-001 |');
    expect(list[0].confidence).toBe(55);
  });
});

// ═══════ R1 resolveCanonicalFacts ═══════
describe('R1 resolveCanonicalFacts', () => {
  it('空候选 → 空 map', () => {
    expect(resolveCanonicalFacts([]).size).toBe(0);
  });

  it('按 confidence 降序选最高非拒绝候选', () => {
    const spec = specOf('project_name');
    const list = [
      scoreFactCandidate({ fieldKey: 'project_name', label: spec.label, value: '低分工程', sourceType: 'structured_fact' }, spec),
      scoreFactCandidate({ fieldKey: 'project_name', label: spec.label, value: '高分项目', sourceType: 'evidence', sourceName: '招标文件' }, spec),
    ];
    const result = resolveCanonicalFacts(list);
    expect(result.get('project_name')?.value).toBe('高分项目');
    expect(result.get('project_name')?.selectedReason).toBe(list[1].reasons.join('；'));
  });

  it('rejected 候选不入选', () => {
    const spec = specOf('schedule_requirement');
    const list = [
      scoreFactCandidate({ fieldKey: 'schedule_requirement', label: spec.label, value: '无效值', sourceType: 'structured_fact' }, spec),
    ];
    const result = resolveCanonicalFacts(list);
    expect(result.has('schedule_requirement')).toBe(false);
  });

  it('confidence<=0 不入选', () => {
    const spec = specOf('project_location');
    const list = [
      scoreFactCandidate({ fieldKey: 'project_location', label: spec.label, value: '详见招标文件', sourceType: 'structured_fact' }, spec),
    ];
    const result = resolveCanonicalFacts(list);
    expect(result.has('project_location')).toBe(false);
  });

  it('自定义 specs 只处理传入字段', () => {
    const result = resolveCanonicalFacts([cand('project_name', '某工程')], [specOf('project_name')]);
    expect([...result.keys()]).toEqual(['project_name']);
  });

  it('source = sourceName || sourceType', () => {
    const spec = specOf('project_name');
    const a = scoreFactCandidate({ fieldKey: 'project_name', label: spec.label, value: '某工程', sourceType: 'structured_fact' }, spec);
    const b = scoreFactCandidate({ fieldKey: 'project_name', label: spec.label, value: '某项目', sourceType: 'structured_fact', sourceName: '招标文件' }, spec);
    expect(resolveCanonicalFacts([a]).get('project_name')?.source).toBe('structured_fact');
    expect(resolveCanonicalFacts([b]).get('project_name')?.source).toBe('招标文件');
  });
});

// ═══════ B1 buildCanonicalFacts ═══════
describe('B1 buildCanonicalFacts', () => {
  const fact = (extra: Partial<DocumentFact>): DocumentFact => ({
    key: 'k', value: 'v', sourceFile: '招标文件正文', roleId: 'r', confidence: 0.9, ...extra,
  });

  it('结构化事实与 markdown 表格合并', () => {
    const result = buildCanonicalFacts({
      facts: [fact({ fieldId: 'project_name', value: '某大学宿舍楼工程' })],
      markdown: '| 计划工期 | 180日历天 |',
    });
    expect(result.get('project_name')?.value).toBe('某大学宿舍楼工程');
    expect(result.get('schedule_requirement')?.value).toBe('180日历天');
  });

  it('空输入 → 空 map', () => {
    expect(buildCanonicalFacts({ facts: [] }).size).toBe(0);
  });

  it('markdown 表格候选与结构化候选同字段时取 confidence 高者', () => {
    const result = buildCanonicalFacts({
      facts: [fact({ fieldId: 'project_name', value: '某工程', sourceFile: '招标文件正文' })],
      markdown: '| 项目名称 | 某大学宿舍楼工程 | 招标文件 |',
    });
    // 结构化：30+35+15=80；表格：30+35+15-10=70 → 结构化胜
    expect(result.get('project_name')?.value).toBe('某工程');
  });

  it('无 spec 事实与无 spec 表格行均不产生候选', () => {
    const result = buildCanonicalFacts({
      facts: [fact({ key: '备注', value: 'x' })],
      markdown: '| 备注 | 暂无 |',
    });
    expect(result.size).toBe(0);
  });
});
