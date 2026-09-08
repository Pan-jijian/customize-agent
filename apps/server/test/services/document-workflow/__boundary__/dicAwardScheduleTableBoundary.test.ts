/**
 * dicAwardScheduleTableBoundary：奖项白名单（fabricatedAwardIssues，无基线全新检测器）+
 * 节点工期互斥（nodeScheduleConsistencyIssues）+ 表格重复（duplicateTableIssues）增量深挖（V 组）。
 * 覆盖增量维度（与 dicCommercialBoundary F 段 / dicTextStructureBoundary H1 段基线互补，不重复）：
 *  - V1 奖项白名单：白名单空宁漏报、facts 三源谱系、tenderRequirements 三源谱系、
 *    前导剥离词 14 词谱系+循环叠加、GENERIC 10 词豁免谱系、负向前瞻 5 词谱系（历史缺陷回归）、
 *    奖项名 2-11 字长度边界+截断行为、多编造聚合去重；
 *  - V2 节点工期：跨形态全组合（B+C/B+D/C+C/D+D/A+D）、同 day 跨形态豁免、3 口径 message、
 *    多锚点聚合、slice(0,4) 截断、raws slice(0,4)、同 raw 去重、六锚点 label 谱系；
 *  - V3 表格重复：三判定分支各自边界（headerSim 恰 0.7/0.6、dataSim 恰 0.6、textCell 双向覆盖
 *    0.5 豁免）、数字 cell 互补表豁免（历史缺陷回归）、无数据行表不入池、行号展示、
 *    数据重合降序排序、slice(0,5)、无分隔行切分后不同内容不误报。
 * 全部为确定性正则/集合比较，无语义依赖。
 */
import { describe, expect, it } from 'vitest';
import {
  duplicateTableIssues, fabricatedAwardIssues, nodeScheduleConsistencyIssues,
} from '@/services/document-workflow/documentIntegrityChecks';
import type { TenderRequirementItem, TenderRequirementModel } from '@/services/document-workflow/types';
import { factOf, factsOf } from './boundaryKit';

const EMPTY_FACTS = factsOf({});
const ITEM = (text: string): TenderRequirementItem => ({ text, coreTerms: [] });
const TENDER_REQ = (partial: Partial<TenderRequirementModel> = {}): TenderRequirementModel => ({
  awardObjectives: [],
  specialQualityStandards: [],
  awardClauses: [],
  systematicBenchmarks: [],
  dateFabricationProhibited: false,
  prohibitionNotes: [],
  frontScheduleClauses: [],
  extracted: true,
  ...partial,
});

// ── V1. fabricatedAwardIssues：白名单判定谱系 ──

describe('V1 奖项白名单：白名单空宁漏报', () => {
  it('V1-1 白名单空 + 正文「确保黄山杯」→ 不报（宁漏报不误报）', () => {
    expect(fabricatedAwardIssues('本工程确保黄山杯。', EMPTY_FACTS)).toEqual([]);
  });
  it('V1-2 白名单空 + 正文 GENERIC「优质工程奖」→ 不报', () => {
    expect(fabricatedAwardIssues('本工程争创优质工程奖。', EMPTY_FACTS)).toEqual([]);
  });
  it('V1-3 白名单空 + 空正文 → 不报', () => {
    expect(fabricatedAwardIssues('', EMPTY_FACTS)).toEqual([]);
  });
});

describe('V1 奖项白名单：factsModel 三源谱系', () => {
  const SOURCES = ['quality', 'project', 'schedule'] as const;
  it.each(SOURCES)('V1-4 白名单来自 %s 事实 → 正文同词不报', (slot) => {
    const facts = factsOf({ [slot]: [factOf({ value: '黄山杯' })] });
    expect(fabricatedAwardIssues('争创黄山杯。', facts)).toEqual([]);
  });
  it('V1-5 事实值「确保黄山杯」→ 白名单存剥离后词 → 正文「黄山杯」不报', () => {
    const facts = factsOf({ quality: [factOf({ value: '确保黄山杯' })] });
    expect(fabricatedAwardIssues('争创黄山杯。', facts)).toEqual([]);
  });
  it('V1-6 事实值含多奖项（黄山杯、鲁班奖）→ 双词入白名单 → 正文鲁班奖不报', () => {
    const facts = factsOf({ quality: [factOf({ value: '黄山杯、鲁班奖' })] });
    expect(fabricatedAwardIssues('争创鲁班奖。', facts)).toEqual([]);
  });
  it('V1-7 事实值无奖项词（白名单仍空）→ 正文奖项不报', () => {
    const facts = factsOf({ quality: [factOf({ value: '合格标准' })] });
    expect(fabricatedAwardIssues('争创黄山杯。', facts)).toEqual([]);
  });
});

describe('V1 奖项白名单：编造判定', () => {
  it('V1-8 白名单黄山杯 + 正文鲁班奖 → 报 1 条', () => {
    const facts = factsOf({ quality: [factOf({ value: '黄山杯' })] });
    const issues = fabricatedAwardIssues('本工程确保鲁班奖。', facts);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('鲁班奖');
  });
  it('V1-9 多编造聚合 → 1 条 issue 含两者', () => {
    const facts = factsOf({ quality: [factOf({ value: '黄山杯' })] });
    const issues = fabricatedAwardIssues('本工程确保鲁班奖。本工程确保飞天奖。', facts);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('鲁班奖');
    expect(issues[0].message).toContain('飞天奖');
  });
  it('V1-10 同编造词重复 → Set 去重只列一次', () => {
    const facts = factsOf({ quality: [factOf({ value: '黄山杯' })] });
    const issues = fabricatedAwardIssues('本工程确保鲁班奖。本工程确保鲁班奖。', facts);
    expect(issues).toHaveLength(1);
    expect(issues[0].message.match(/鲁班奖/gu)).toHaveLength(1);
  });
  it('V1-11 正文白名单词+编造词混排 → message 只列编造词', () => {
    const facts = factsOf({ quality: [factOf({ value: '黄山杯' })] });
    const issues = fabricatedAwardIssues('确保黄山杯。确保鲁班奖。', facts);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('鲁班奖');
    expect(issues[0].message).not.toContain('黄山杯');
  });
  it('V1-11b 贪婪前缀吞入锁定：正文上下文汉字被 {2,10} 吞入奖项名 → 报且 message 含完整上下文（真实行为）', () => {
    const facts = factsOf({ quality: [factOf({ value: '黄山杯' })] });
    const issues = fabricatedAwardIssues('本工程争创飞天奖。', facts);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('本工程争创飞天奖');
  });
});

describe('V1 奖项白名单：前导剥离词谱系', () => {
  const LEAD_WORDS = ['争创', '争取', '力争', '争获', '确保', '获得', '创建', '力创', '评为', '荣获', '标为', '目标为', '承诺', '为'] as const;
  it.each(LEAD_WORDS)('V1-12 前导“%s”剥离后命中白名单 → 不报', (word) => {
    const facts = factsOf({ quality: [factOf({ value: '黄山杯' })] });
    expect(fabricatedAwardIssues(`${word}黄山杯。`, facts)).toEqual([]);
  });
  it('V1-13 双前导叠加「确保获得」→ 循环剥离两轮 → 不报', () => {
    const facts = factsOf({ quality: [factOf({ value: '黄山杯' })] });
    expect(fabricatedAwardIssues('确保获得黄山杯。', facts)).toEqual([]);
  });
  it('V1-14 白名单无前导词 + 正文带前导「目标为」→ 剥离后命中 → 不报', () => {
    const facts = factsOf({ quality: [factOf({ value: '黄山杯' })] });
    expect(fabricatedAwardIssues('目标为黄山杯。', facts)).toEqual([]);
  });
});

describe('V1 奖项白名单：GENERIC 通用目标豁免谱系', () => {
  const GENERIC_WORDS = ['优质工程', '文明工地', '样板', '标准化', '观摩', '示范', '精品工程', '结构优质', '省优', '市优'] as const;
  it.each(GENERIC_WORDS)('V1-15 GENERIC“%s奖”在白名单非空时豁免 → 不报', (word) => {
    const facts = factsOf({ quality: [factOf({ value: '黄山杯' })] });
    expect(fabricatedAwardIssues(`本工程争创${word}奖。`, facts)).toEqual([]);
  });
});

describe('V1 奖项白名单：负向前瞻排除谱系（历史缺陷回归）', () => {
  const NON_AWARD_TAILS = ['奖励', '奖金', '奖惩', '奖罚', '奖项'] as const;
  it.each(NON_AWARD_TAILS)('V1-16 “创优%s”的奖字被负向前瞻排除 → 不报', (tail) => {
    const facts = factsOf({ quality: [factOf({ value: '黄山杯' })] });
    expect(fabricatedAwardIssues(`本工程建立创优${tail}管理台账。`, facts)).toEqual([]);
  });
});

describe('V1 奖项白名单：奖项名长度与形态边界', () => {
  const facts = factsOf({ quality: [factOf({ value: '黄山杯' })] });
  it('V1-17 2汉字+奖（安全奖）→ 匹配并报', () => {
    expect(fabricatedAwardIssues('安全奖。', facts)).toHaveLength(1);
  });
  it('V1-18 1汉字+奖（金奖）→ {2,10}不匹配 → 不报', () => {
    expect(fabricatedAwardIssues('金奖。', facts)).toEqual([]);
  });
  it('V1-19 2汉字+杯（质量杯）→ 匹配并报', () => {
    expect(fabricatedAwardIssues('质量杯。', facts)).toHaveLength(1);
  });
  it('V1-20 10汉字+杯（长度上限）→ 匹配并报', () => {
    expect(fabricatedAwardIssues('甲乙丙丁戊己庚辛壬癸杯。', facts)).toHaveLength(1);
  });
  it('V1-21 11汉字+杯 → 截断为10字窗口仍匹配 → 报（锁定截断行为）', () => {
    expect(fabricatedAwardIssues('甲乙丙丁戊己庚辛壬癸子杯。', facts)).toHaveLength(1);
  });
  it('V1-22 数字混入（2026杯）→ 汉字前缀不足2字 → 不报', () => {
    expect(fabricatedAwardIssues('2026杯。', facts)).toEqual([]);
  });
  it('V1-23 鲁班奖杯（奖后非排除字）→ 匹配鲁班奖 → 报', () => {
    expect(fabricatedAwardIssues('鲁班奖杯。', facts)).toHaveLength(1);
  });
});

describe('V1 奖项白名单：tenderRequirements 三源谱系', () => {
  it('V1-24 awardObjectives 源 → 正文同词不报', () => {
    const req = TENDER_REQ({ awardObjectives: [ITEM('确保黄山杯')] });
    expect(fabricatedAwardIssues('争创黄山杯。', EMPTY_FACTS, req)).toEqual([]);
  });
  it('V1-25 specialQualityStandards 源 → 正文同词不报', () => {
    const req = TENDER_REQ({ specialQualityStandards: [ITEM('鲁班奖')] });
    expect(fabricatedAwardIssues('争创鲁班奖。', EMPTY_FACTS, req)).toEqual([]);
  });
  it('V1-26 awardClauses 源 → 正文同词不报', () => {
    const req = TENDER_REQ({ awardClauses: [ITEM('飞天奖')] });
    expect(fabricatedAwardIssues('争创飞天奖。', EMPTY_FACTS, req)).toEqual([]);
  });
  it('V1-27 extracted=false → 源2不启用 → 白名单空不报', () => {
    const req = TENDER_REQ({ extracted: false, awardObjectives: [ITEM('确保黄山杯')] });
    expect(fabricatedAwardIssues('本工程争创黄山杯。', EMPTY_FACTS, req)).toEqual([]);
  });
});

// ── V2. nodeScheduleConsistencyIssues：跨形态组合与聚合 ──

describe('V2 nodeSchedule 跨形态全组合（基线未覆盖形态对）', () => {
  it('V2-1 形态B短词封顶 + 形态C倒序锁定 → 报', () => {
    const md = '主体封顶完成 | 第210天。主体结构封顶节点锁定在开工后第230日。';
    expect(nodeScheduleConsistencyIssues(md)).toHaveLength(1);
  });
  it('V2-2 形态B短词封顶 + 形态D表格行 → 报', () => {
    const md = '主体封顶完成 | 第210天。\n| 主体结构封顶 | 开工后第230日 |';
    expect(nodeScheduleConsistencyIssues(md)).toHaveLength(1);
  });
  it('V2-3 形态C倒序锁定两处不同日 → 报', () => {
    const md = '主体结构封顶节点锁定在开工后第230日。主体结构封顶节点锁定在开工后第240日。';
    expect(nodeScheduleConsistencyIssues(md)).toHaveLength(1);
  });
  it('V2-4 形态D表格行两处不同日 → 报', () => {
    const md = '| 主体结构封顶 | 开工后第230日 |\n| 主体结构封顶 | 开工后第240日 |';
    expect(nodeScheduleConsistencyIssues(md)).toHaveLength(1);
  });
  it('V2-5 形态A 60 + 形态D 65（差恰5）→ 报', () => {
    const md = '第60日完成基坑支护及土方外运。\n| 基坑支护及土方外运 | 开工后第65日 |';
    expect(nodeScheduleConsistencyIssues(md)).toHaveLength(1);
  });
  it('V2-6 形态A 60 + 形态B 65（差恰5）→ 报', () => {
    const md = '第60日完成基坑支护及土方外运。基坑支护完成 | 第65天。';
    expect(nodeScheduleConsistencyIssues(md)).toHaveLength(1);
  });
  it('V2-7 形态A 60 + 形态B 64（差4）→ 不报', () => {
    const md = '第60日完成基坑支护及土方外运。基坑支护完成 | 第64天。';
    expect(nodeScheduleConsistencyIssues(md)).toEqual([]);
  });
});

describe('V2 nodeSchedule 同 day 跨形态豁免', () => {
  it('V2-8 形态A 60 + 形态B 60 → days 单值 → 不报', () => {
    const md = '第60日完成基坑支护及土方外运。基坑支护完成 | 第60天。';
    expect(nodeScheduleConsistencyIssues(md)).toEqual([]);
  });
  it('V2-9 形态A 60 + 形态D 60 → 不报', () => {
    const md = '第60日完成基坑支护及土方外运。\n| 基坑支护及土方外运 | 开工后第60日 |';
    expect(nodeScheduleConsistencyIssues(md)).toEqual([]);
  });
  it('V2-10 同句同 raw 重复 → 提取去重后组<2 → 不报', () => {
    const md = '第60日完成基坑支护及土方外运。第60日完成基坑支护及土方外运。';
    expect(nodeScheduleConsistencyIssues(md)).toEqual([]);
  });
});

describe('V2 nodeSchedule 聚合与截断', () => {
  it('V2-11 3 口径 → message 三值以「与」连接', () => {
    const issues = nodeScheduleConsistencyIssues('第60日完成主体结构封顶。第75日完成主体结构封顶。第90日完成主体结构封顶。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('60日 与 75日 与 90日');
  });
  it('V2-12 3 样本 2 口径（60/60/75）→ 报', () => {
    const md = '第60日完成主体结构封顶。第60日完成主体结构封顶。第75日完成主体结构封顶。';
    expect(nodeScheduleConsistencyIssues(md)).toHaveLength(1);
  });
  it('V2-13 两锚点各自冲突 → 2 条 issue', () => {
    const md = '第60日完成基坑支护及土方外运。第75日完成基坑支护及土方外运。第210日完成地下结构出正负零。第215日完成地下结构出正负零。';
    expect(nodeScheduleConsistencyIssues(md)).toHaveLength(2);
  });
  it('V2-14 5 锚点冲突 → slice(0,4) 截断为 4 条', () => {
    const md = '第60日完成基坑支护及土方外运。第75日完成基坑支护及土方外运。'
      + '第60日完成地下结构出正负零。第75日完成地下结构出正负零。'
      + '第60日完成主体结构封顶。第75日完成主体结构封顶。'
      + '第60日完成装饰装修及幕墙。第75日完成装饰装修及幕墙。'
      + '第60日完成机电安装及智能化调试。第75日完成机电安装及智能化调试。';
    expect(nodeScheduleConsistencyIssues(md)).toHaveLength(4);
  });
  it('V2-15 5 口径 raws slice(0,4) → 第5个 raw 不入 message', () => {
    const issues = nodeScheduleConsistencyIssues(
      '第60日完成主体结构封顶。第65日完成主体结构封顶。第70日完成主体结构封顶。第75日完成主体结构封顶。第80日完成主体结构封顶。',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('80日');
    expect(issues[0].message).not.toContain('第80日完成主体结构封顶');
  });
});

describe('V2 nodeSchedule 六锚点 label 谱系', () => {
  const NODE_LABELS: Array<[string, string]> = [
    ['excavation', '基坑支护及土方外运'],
    ['zero', '地下结构出正负零'],
    ['topping', '主体结构封顶'],
    ['decoration', '装饰装修及幕墙'],
    ['mep', '机电安装及智能化调试'],
    ['completion', '室外工程及竣工验收'],
  ];
  it.each(NODE_LABELS)('V2-16 “%s”冲突 message 含节点 label', (_key, node) => {
    const issues = nodeScheduleConsistencyIssues(`第60日完成${node}。第75日完成${node}。`);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(`“${node}”节点`);
  });
});

// ── V3. duplicateTableIssues：三判定分支精确边界 ──

/** 表格构造：header 表头 + rows 数据行（自动生成分隔行） */
function tbl(header: string[], rows: string[][]): string {
  const head = `| ${header.join(' | ')} |`;
  const sep = `| ${header.map(() => '---').join(' | ')} |`;
  return [head, sep, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n');
}

describe('V3 duplicateTable 判定分支②：表头相似度阈值', () => {
  const SHARED7 = ['共一', '共二', '共三', '共四', '共五', '共六', '共七'];
  it('V3-1 headerSim 恰 0.7（7交集/10并集）+ 首列重合 → 报', () => {
    const a = tbl([...SHARED7, '独A'], [['基坑', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7']]);
    const b = tbl([...SHARED7, '独B1', '独B2'], [['基坑', 'Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'Y6', 'Y7', 'Y8']]);
    expect(duplicateTableIssues(`${a}\n\n${b}`)).toHaveLength(1);
  });
  it('V3-2 headerSim 0.6（<0.7）+ 首列不重合 → 不报', () => {
    const shared6 = SHARED7.slice(0, 6);
    const a = tbl([...shared6, '独A1', '独A2'], [['基坑']]);
    const b = tbl([...shared6, '独B1', '独B2'], [['主体']]);
    expect(duplicateTableIssues(`${a}\n\n${b}`)).toEqual([]);
  });
});

describe('V3 duplicateTable 判定分支③：首列重合 + 文本cell双向覆盖', () => {
  it('V3-3 表头全异 + 首列重合1.0 + 文本覆盖1.0 → 报', () => {
    const a = tbl(['列甲'], [['基坑'], ['支护'], ['监测']]);
    const b = tbl(['列乙'], [['基坑'], ['支护'], ['监测'], ['预警']]);
    expect(duplicateTableIssues(`${a}\n\n${b}`)).toHaveLength(1);
  });
  it('V3-4 表头全异 + 首列重合1.0 + 文本覆盖0.5（<0.6）→ 不报', () => {
    const a = tbl(['名称', '参数'], [['基坑', '支护'], ['监测', '预警']]);
    const b = tbl(['名称', '规格'], [['基坑', '其他一'], ['监测', '其他二']]);
    expect(duplicateTableIssues(`${a}\n\n${b}`)).toEqual([]);
  });
  it('V3-5 互补表共享数字cell+首列不同 → 不报（历史缺陷回归：共享数字非重复证据）', () => {
    const a = tbl(['工种', '人数'], [['钢筋工', '20人'], ['木工', '10人']]);
    const b = tbl(['类别', '峰值'], [['高峰期', '20人'], ['平均值', '10人']]);
    expect(duplicateTableIssues(`${a}\n\n${b}`)).toEqual([]);
  });
});

describe('V3 duplicateTable 判定分支①：表头完全相同', () => {
  it('V3-6 表头同 + dataSim 恰 0.6（3交集/5并集）→ 报', () => {
    const a = tbl(['名称', '数量'], [['挖掘机', '2台'], ['装载机', '1台']]);
    const b = tbl(['名称', '数量'], [['挖掘机', '2台'], ['压路机', '1台']]);
    expect(duplicateTableIssues(`${a}\n\n${b}`)).toHaveLength(1);
  });
  it('V3-7 表头同 + 数据全异 → 三分支均不成立 → 不报', () => {
    const a = tbl(['名称', '数量'], [['挖掘机', '2台']]);
    const b = tbl(['名称', '数量'], [['装载机', '1台']]);
    expect(duplicateTableIssues(`${a}\n\n${b}`)).toEqual([]);
  });
});

describe('V3 duplicateTable 聚合/排序/结构边界', () => {
  const same = tbl(['名称', '型号', '数量'], [['挖掘机', 'X', '2台'], ['装载机', 'Y', '1台']]);
  it('V3-8 完全重复两表 → message 含行号区间', () => {
    const issues = duplicateTableIssues(`${same}\n\n${same}`);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('第 1~4 行');
    expect(issues[0].message).toContain('第 6~9 行');
  });
  it('V3-9 6 张同表 → 15 对候选 → slice(0,5) 截断为 5 条', () => {
    const md = Array.from({ length: 6 }, () => same).join('\n\n');
    expect(duplicateTableIssues(md)).toHaveLength(5);
  });
  it('V3-10 无数据行表不入池 → 不报', () => {
    const a = tbl(['名称'], [['挖掘机']]);
    const bare = '| 名称 |\n| --- |';
    expect(duplicateTableIssues(`${a}\n\n${bare}`)).toEqual([]);
  });
  it('V3-11 表头5列 → message 展示前3列', () => {
    const five = tbl(['列一', '列二', '列三', '列四', '列五'], [['挖掘机', 'X', 'Y', 'Z', 'W']]);
    const issues = duplicateTableIssues(`${five}\n\n${five}`);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('列一|列二|列三');
  });
  it('V3-12 数据重合降序排序 → 100% 重合对排首位', () => {
    const shared7 = ['共一', '共二', '共三', '共四', '共五', '共六', '共七'];
    const lowA = tbl([...shared7, '独A'], [['基坑', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7']]);
    const lowB = tbl([...shared7, '独B1', '独B2'], [['基坑', 'Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'Y6', 'Y7', 'Y8']]);
    const issues = duplicateTableIssues(`${same}\n\n${same}\n\n${lowA}\n\n${lowB}`);
    expect(issues.length).toBeGreaterThan(1);
    expect(issues[0].message).toContain('数据重合 100%');
  });
  it('V3-13 无分隔行切分后数据不同 → 不误报', () => {
    const md = '| 名称 | 型号 |\n| --- | --- |\n| 挖掘机 | X |\n| 名称 | 型号 |\n| 装载机 | Y |';
    expect(duplicateTableIssues(md)).toEqual([]);
  });
});
