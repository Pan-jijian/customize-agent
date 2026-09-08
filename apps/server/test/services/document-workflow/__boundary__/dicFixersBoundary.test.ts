/**
 * 确定性修复器边界矩阵（P1 第 6 批）
 * 覆盖：fixAdjacentPhraseDuplication（文本粘连三模式）/ fixSelfUnderminingCandidates（18 句式自伤改写）/
 * fixHazardIdentificationGaps（危大遗漏补写）/ fixSixHundredPercentCoverage（六个百分百补写）/
 * fixInternalTerminology（内部术语清洗）/ fixHeaderlessTables（无表头表格）/
 * fixAmbiguousEitherOrCandidates（两可归一）/ fixForbiddenConfigurationTerms（禁止词清洗）/
 * fixTocFromBody（目录重建）/ fixQuantityAuthorityConflicts（清单工程量五重豁免）/
 * applyNumericConsistencyDeterministicFixes（五步管线：峰值→节点→材料设备→支护→清单）/
 * crossChapterSemanticDuplicateIssues+stripCrossChapterSemanticDuplicateParagraphs（跨章语义重复）
 * 原则：每条用例独立断言意义；真实实现行为一律锁定，不迎合用例改实现。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyNumericConsistencyDeterministicFixes, crossChapterSemanticDuplicateIssues,
  fixAdjacentPhraseDuplication, fixAmbiguousEitherOrCandidates,
  fixForbiddenConfigurationTerms, fixHazardIdentificationGaps,
  fixHeaderlessTables, fixInternalTerminology, fixPlaceholderTableCells,
  fixQualityAssuranceCoverage, fixQuantityAuthorityConflicts,
  fixSelfUnderminingCandidates, fixSixHundredPercentCoverage, fixTocFromBody,
  stripCrossChapterSemanticDuplicateParagraphs,
} from '@/services/document-workflow/documentIntegrityChecks';
import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';
import type { DocumentDraftChapter } from '@/services/document-workflow/types';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

/** D 段（六个百分百）词面模拟语义：query 与句子共享领域词即高分（同检测器词表口径） */
const SIX_PERCENT_SIM = async (_leftTexts: string[], _rightTexts: string[]) => (left: string, right: string): number => {
  const kw = ['围挡', '覆盖', '冲洗', '硬化', '湿法', '密闭'];
  return kw.some(word => left.includes(word) && right.includes(word)) ? 0.9 : 0.1;
};
/** L 段（跨章语义）数值指纹模拟语义：两段共享 ≥2 个数字串即高分（阈值 0.82） */
const CHAPTER_SIM = async (_leftTexts: string[], _rightTexts: string[]) => (left: string, right: string): number => {
  if (left === right) return 1;
  const leftNums = new Set(left.match(/\d+/gu) || []);
  const rightNums = new Set(right.match(/\d+/gu) || []);
  const shared = [...leftNums].filter(num => rightNums.has(num)).length;
  return shared >= 2 ? 0.9 : 0.1;
};

beforeEach(() => {
  vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
});

// ── A. fixAdjacentPhraseDuplication 文本粘连三模式 ──

// A0 句级相邻整句重复折叠（丰乐镇第十二轮实锤：2.2.1/2.2.2 同小节内相邻整句重复两遍全漏）：
// 跨「。」句界的相邻 fragment 整句重复由 split 后 cleanSentence 独立清洗漏网，模式 0 补齐
const DUP_LONG = '每道工序完成后由质检员当日验收，不合格由施工员在4小时内组织整改，质检员复查合格后销项方可进入下道工序。';

describe('A0 模式0 相邻整句重复折叠（跨句界）', () => {
  it('A0 相邻整句两遍重复：折叠为一句', () => {
    const result = fixAdjacentPhraseDuplication(`${DUP_LONG}${DUP_LONG}`);
    expect(result.markdown).toBe(DUP_LONG);
    expect(result.fixedCount).toBe(1);
  });
  it('A0 三连重复：折叠为一句', () => {
    const result = fixAdjacentPhraseDuplication(`${DUP_LONG}${DUP_LONG}${DUP_LONG}`);
    expect(result.markdown).toBe(DUP_LONG);
    expect(result.fixedCount).toBe(2);
  });
  it('A0 软换行空格残留版重复（去空白归一后相等）同样折叠', () => {
    const spaced = DUP_LONG.replace('组织整改', '组织整 改');
    const result = fixAdjacentPhraseDuplication(`${spaced}${DUP_LONG}`);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe(spaced);
  });
  it('A0 空行隔开的跨段落相同长句不折叠（段落内去重边界）', () => {
    const result = fixAdjacentPhraseDuplication(`${DUP_LONG}\n\n${DUP_LONG}`);
    expect(result.fixedCount).toBe(0);
  });
  it('A0 短句（<20字）相邻重复不折叠（模板化短句豁免）', () => {
    const result = fixAdjacentPhraseDuplication('质检员当日验收。质检员当日验收。');
    expect(result.markdown).toBe('质检员当日验收。质检员当日验收。');
    expect(result.fixedCount).toBe(0);
  });
  it('A0 表格行相邻相同不折叠', () => {
    const result = fixAdjacentPhraseDuplication('| 施工 | 施工 |\n| 施工 | 施工 |');
    expect(result.fixedCount).toBe(0);
  });
  it('A0 不同句相邻不折叠', () => {
    const result = fixAdjacentPhraseDuplication(`${DUP_LONG}具体工序为：测量放线→挖沟槽土方→基底验槽。`);
    expect(result.fixedCount).toBe(0);
  });
});

describe('A1 模式1 相邻重复块折叠（L16→4 递减）', () => {
  it('A1 L4 中文块折叠', () => {
    const result = fixAdjacentPhraseDuplication('施工进度施工进度。');
    expect(result.markdown).toBe('施工进度。');
    expect(result.fixedCount).toBe(1);
  });
  it('A1 L4 数字块折叠', () => {
    expect(fixAdjacentPhraseDuplication('进度20242024。').markdown).toBe('进度2024。');
  });
  it('A1 中文+数字混合块（L5）折叠', () => {
    expect(fixAdjacentPhraseDuplication('养护14天养护14天。').markdown).toBe('养护14天。');
  });
  it('A1 L3 块不折叠（长度下限 4）', () => {
    expect(fixAdjacentPhraseDuplication('进度123123。').markdown).toBe('进度123123。');
  });
  it('A1 纯字母块不折叠（无数字无中文）', () => {
    expect(fixAdjacentPhraseDuplication('型号ABAB。').markdown).toBe('型号ABAB。');
  });
  it('A1 纯标点块不折叠', () => {
    expect(fixAdjacentPhraseDuplication('分隔----。').markdown).toBe('分隔----。');
  });
  it('A1 长块优先+迭代折叠（16字→8字→4字）', () => {
    const result = fixAdjacentPhraseDuplication('1234123412341234');
    expect(result.markdown).toBe('1234');
    expect(result.fixedCount).toBe(2);
  });
  it('A1 仅首次相邻重复折叠（三连重复先折前两块）', () => {
    expect(fixAdjacentPhraseDuplication('执行执行执行执行。').markdown).toBe('执行执行。');
  });
  it('A1 跨句各自折叠（句尾标点保留）', () => {
    const result = fixAdjacentPhraseDuplication('施工进度施工进度。养护周期养护周期。');
    expect(result.markdown).toBe('施工进度。养护周期。');
    expect(result.fixedCount).toBe(2);
  });
  it('A1 句内多组不同块折叠', () => {
    expect(fixAdjacentPhraseDuplication('模板安装模板安装与支撑加固支撑加固。').markdown).toBe('模板安装与支撑加固。');
  });
  it('A1 表格行不折叠（| 开头）', () => {
    const result = fixAdjacentPhraseDuplication('| 施工 | 施工 |');
    expect(result.markdown).toBe('| 施工 | 施工 |');
    expect(result.fixedCount).toBe(0);
  });
  it('A1 标题行不折叠（# 开头）', () => {
    expect(fixAdjacentPhraseDuplication('## 施工施工').markdown).toBe('## 施工施工');
  });
  it('A1 无重复不动（fixedCount 0）', () => {
    const result = fixAdjacentPhraseDuplication('正常文本内容。');
    expect(result.markdown).toBe('正常文本内容。');
    expect(result.fixedCount).toBe(0);
    expect(result.details).toEqual([]);
  });
});

describe('A2 模式2 隔位重复短语保留首现', () => {
  it('A2 纯中文长短语（L≥12）删除第二处', () => {
    const phrase = '按主体结构与装饰装修穿插施工阶段高峰';
    const result = fixAdjacentPhraseDuplication(`${phrase}应急抢险人员${phrase}配置。`);
    expect(result.markdown).toBe(`${phrase}应急抢险人员配置。`);
    expect(result.fixedCount).toBe(1);
  });
  it('A2 纯中文 11 字短语不删（长度下限 12）', () => {
    const p11 = '主体结构与装饰装修穿插'; // 11 字
    const md = `${p11}部署人员${p11}调整。`;
    expect(fixAdjacentPhraseDuplication(md).markdown).toBe(md);
  });
  it('A2 数字短语（中文开头含数字 L≥9）删除第二处', () => {
    const md = '高峰期应急抢险人员按高峰人数186人的16%配置，不少于30人的16%配置，不少于30人。';
    const result = fixAdjacentPhraseDuplication(md);
    expect(result.fixedCount).toBeGreaterThan(0);
  });
  it('A2 数字短语 L8 不删（长度下限 9）', () => {
    const p8 = '高峰186人配置'; // 8 字
    const md = `${p8}，${p8}。`;
    expect(fixAdjacentPhraseDuplication(md).markdown).toBe(md);
  });
  it('A2 短语结尾纯数字豁免', () => {
    const p = '里程碑节点第311'; // 结尾 '1' 纯数字
    const md = `${p}，${p}。`;
    expect(fixAdjacentPhraseDuplication(md).markdown).toBe(md);
  });
  it('A2 短语含 → 结构符号豁免', () => {
    const p = '第311日）→主体结构封顶';
    const md = `${p}。${p}。`;
    expect(fixAdjacentPhraseDuplication(md).markdown).toBe(md);
  });
  it('A2 短语含破折号豁免', () => {
    const p = '施工部署阶段—主体结构封顶';
    const md = `${p}。${p}。`;
    expect(fixAdjacentPhraseDuplication(md).markdown).toBe(md);
  });
  it('A2 短语含连字符豁免', () => {
    const p = '质量管理-验收环节控制';
    const md = `${p}。${p}。`;
    expect(fixAdjacentPhraseDuplication(md).markdown).toBe(md);
  });
  it('A2 三现删除后两处', () => {
    const p = '高峰阶段应急抢险人员按186人';
    const md = `${p}${p}${p}。`;
    const result = fixAdjacentPhraseDuplication(md);
    expect(result.markdown).toBe(`${p}。`);
    expect(result.fixedCount).toBe(2);
  });
  it('A2 首现检查（非首现位置不触发）', () => {
    const p = '冬季热负荷71.2kW';
    const md = `测量${p}值后记录${p}值。`;
    const result = fixAdjacentPhraseDuplication(md);
    // L12 最长优先：含尾「值」的 12 字短语「冬季热负荷71.2kW值」为实际删除对象（仅删第二处）
    expect(result.markdown).toBe('测量冬季热负荷71.2kW值后记录。');
  });
});

describe('A3 模式3 数值+单位无分隔粘连折叠', () => {
  const units = ['kW', 'kVA', 'MPa', '㎡', 'm²', 'm³', 'mm', 'cm', '%'];
  it.each(units)('A3 单位%s粘连折叠保留首块', (unit) => {
    const result = fixAdjacentPhraseDuplication(`负荷71.2${unit}182.5${unit}。`);
    expect(result.markdown).toBe(`负荷71.2${unit}。`);
  });
  it('A3 实测形态 71.2kW182.5kW', () => {
    const result = fixAdjacentPhraseDuplication('冬季热负荷71.2kW182.5kW，冬季热负荷71.2kW。');
    expect(result.fixedCount).toBeGreaterThan(0);
  });
  it('A3 空格分隔粘连也折叠', () => {
    expect(fixAdjacentPhraseDuplication('负荷71.2kW 182.5kW。').markdown).toBe('负荷71.2kW。');
  });
  it('A3 整数百分比粘连', () => {
    expect(fixAdjacentPhraseDuplication('比例16%30%。').markdown).toBe('比例16%。');
  });
  it('A3 单值无粘连不动', () => {
    expect(fixAdjacentPhraseDuplication('负荷71.2kW。').markdown).toBe('负荷71.2kW。');
  });
  it('A3 不同单位粘连也折叠（锁定真实行为）', () => {
    // glueRe 只校验「数值+单位」形态不校验单位一致：200mm 与 5cm 粘连仍折叠（潜在数据丢失边界，
    // 待 t5-combo 缺陷回归谱系阶段评估）
    expect(fixAdjacentPhraseDuplication('厚度200mm5cm。').markdown).toBe('厚度200mm。');
  });
});

describe('A4 残留重复标点归一', () => {
  it('A4 双逗号归一', () => {
    expect(fixAdjacentPhraseDuplication('段落，，内容。').markdown).toBe('段落，内容。');
  });
  it('A4 双句号归一', () => {
    expect(fixAdjacentPhraseDuplication('段落。。').markdown).toBe('段落。');
  });
  it('A4 逗号+句号归一为句号', () => {
    expect(fixAdjacentPhraseDuplication('段落，。').markdown).toBe('段落。');
  });
  it('A4 多标点混合（；；→；）', () => {
    expect(fixAdjacentPhraseDuplication('措施；；实施。').markdown).toBe('措施；实施。');
  });
  it('A4 叹号双连归一', () => {
    expect(fixAdjacentPhraseDuplication('注意！！').markdown).toBe('注意！');
  });
});

describe('A5 句级拆分边界', () => {
  it('A5 分号分句', () => {
    expect(fixAdjacentPhraseDuplication('施工进度施工进度；施工进度施工进度。').markdown).toBe('施工进度；施工进度。');
  });
  it('A5 换行分句', () => {
    expect(fixAdjacentPhraseDuplication('施工进度施工进度\n施工进度施工进度').markdown).toBe('施工进度\n施工进度');
  });
  it('A5 叹号/问号分句', () => {
    expect(fixAdjacentPhraseDuplication('施工进度施工进度！施工进度施工进度？').markdown).toBe('施工进度！施工进度？');
  });
  it('A5 句尾标点不出现在折叠块内（不误删标点）', () => {
    const result = fixAdjacentPhraseDuplication('验收合格。验收合格。');
    expect(result.markdown).toBe('验收合格。验收合格。');
    expect(result.fixedCount).toBe(0);
  });
  it('A5 空串不动', () => {
    const result = fixAdjacentPhraseDuplication('');
    expect(result.markdown).toBe('');
    expect(result.fixedCount).toBe(0);
  });
  it('A5 details 上限 8 条', () => {
    const md = Array.from({ length: 12 }, (_, index) => `条目${index}条目${index}。`).join('');
    const result = fixAdjacentPhraseDuplication(md);
    expect(result.details.length).toBeLessThanOrEqual(8);
  });
});

// ── B. fixSelfUnderminingCandidates 自伤表述 18 句式谱系 ──

describe('B1 危大「如涉及」假设表述（句式1）', () => {
  it.each(['未经审批不得实施', '后方可实施', '方可实施'])('B1 尾形态“%s”命中改写', (tail) => {
    const result = fixSelfUnderminingCandidates(`施工过程中如涉及危险性较大的分部分项工程，${tail}`);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('逐项辨识、分级管控');
    expect(result.details[0]).toContain('如涉及');
  });
  it('B1 无尾锚点不命中', () => {
    expect(fixSelfUnderminingCandidates('施工过程中如涉及危险性较大的分部分项工程，编制专项方案。').fixedCount).toBe(0);
  });
});

describe('B2 踏勘补测类负面假设（句式2）', () => {
  it('B2 缺项+2小时+补测 命中', () => {
    const result = fixSelfUnderminingCandidates('发现检查数据存在缺项时在2小时内补测。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('记录经复核确认完整、数据准确后归档保存。');
  });
  it('B2 「小时」不带「内」也命中', () => {
    expect(fixSelfUnderminingCandidates('发现数据矛盾时在24小时补录。').fixedCount).toBe(1);
  });
  it('B2 无小时窗不命中', () => {
    expect(fixSelfUnderminingCandidates('发现数据缺项立即补测。').fixedCount).toBe(0);
  });
  it('B2 缺项词谱系命中', () => {
    expect(fixSelfUnderminingCandidates('发现记录遗漏后在1小时内补记。').fixedCount).toBe(1);
  });
});

describe('B3 现场条件一致性两可暗示（句式3）', () => {
  it('B3 命中改写为确认相符', () => {
    const result = fixSelfUnderminingCandidates('确保现场踏勘成果与施工组织设计的一致性。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('确认现场条件与施工组织设计相符。');
  });
  it('B3 「与本施工组织设计」变体命中', () => {
    expect(fixSelfUnderminingCandidates('确保数据与施工组织设计的一致性。').fixedCount).toBe(1);
  });
  it('B3 无一致性词不命中', () => {
    expect(fixSelfUnderminingCandidates('确保施工组织设计编制质量。').fixedCount).toBe(0);
  });
});

describe('B4 「不允许分包」短板暗示（句式4）', () => {
  it('B4 命中改写为自主组织正向表述', () => {
    const result = fixSelfUnderminingCandidates('本工程不允许分包，由我公司项目部组织实施。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('严禁违法分包、转包及挂靠行为');
  });
  it('B4 无组织实施锚点不命中', () => {
    expect(fixSelfUnderminingCandidates('本工程不允许分包。').fixedCount).toBe(0);
  });
});

describe('B5 设计图纸不一致负面假设（句式5）', () => {
  it('B5 命中改写为对照复核程序', () => {
    const result = fixSelfUnderminingCandidates('针对踏勘中发现的与设计图纸不一致或设计未明确的事项，按以下口径处理。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('项目部对照施工图与现场条件逐项复核，按以下程序处理。');
  });
  it('B5 无按口径处理锚点不命中', () => {
    expect(fixSelfUnderminingCandidates('针对踏勘中发现的与设计图纸不一致的事项，组织复核。').fixedCount).toBe(0);
  });
});

describe('B6 组价缺失短板暴露（句式6）', () => {
  it('B6 命中改写为开工前核对闭环', () => {
    const result = fixSelfUnderminingCandidates('杜绝施工过程中以工程量组价缺失为由提出变更申请');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('开工前完成工程量与清单核对，施工过程中严格按合同约定计量计价');
  });
  it('B6 变体不命中', () => {
    expect(fixSelfUnderminingCandidates('杜绝施工过程中以工程量清单错误为由提出变更申请').fixedCount).toBe(0);
  });
});

describe('B7 危大「涉及」假设句式（句式7，$1 回写）', () => {
  it('B7 命中改写且依据回写', () => {
    const result = fixSelfUnderminingCandidates('涉及危险性较大的分部分项工程，我公司将依据住房和城乡建设部令第37号规定，在施工前单独编制专项施工方案并履行审批程序。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('管理执行');
    expect(result.markdown).toContain('履行审批程序后实施');
  });
  it('B7 句式缺前半不命中', () => {
    expect(fixSelfUnderminingCandidates('我公司将依据第37号规定编制专项施工方案。').fixedCount).toBe(0);
  });
});

describe('B8 「后续落位」延迟承诺（句式8）', () => {
  it('B8 命中改写为统一控制基准', () => {
    const result = fixSelfUnderminingCandidates('上述参数在后续各分项施工方案中逐项落位执行。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('上述参数作为全文统一控制基准，各分项施工方案均按此执行。');
  });
  it('B8 变体不命中', () => {
    expect(fixSelfUnderminingCandidates('上述参数在各分项施工方案中落位。').fixedCount).toBe(0);
  });
});

describe('B9 补疑修正负面暗示（句式9，$1 回写）', () => {
  it('B9 命中改写且修正内容回写', () => {
    const result = fixSelfUnderminingCandidates('补疑文件对施工内容作出以下明确修正：调整土方开挖分层方案。上述修正内容已纳入本施工组织设计对应分项方案，施工过程中不再另行变更。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('招标文件补疑明确：调整土方开挖分层方案。上述内容已纳入本施工组织设计对应分项方案并统一执行。');
  });
  it('B9 缺尾句不命中', () => {
    expect(fixSelfUnderminingCandidates('补疑文件对施工内容作出以下明确修正：调整方案。').fixedCount).toBe(0);
  });
});

describe('B10 安全人员配备短板暗示（句式10）', () => {
  it('B10 命中改写为配足配齐', () => {
    const result = fixSelfUnderminingCandidates('项目部按《建筑施工企业、工程项目安全生产管理机构设置及安全生产管理人员配备办法》（建质规〔2025〕3号）配备专职安全生产管理人员，公司分管安全负责人每月带班检查不得少于两次');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('配足配齐');
    expect(result.markdown).toContain('留存检查记录');
  });
  it('B10 变体不命中', () => {
    expect(fixSelfUnderminingCandidates('项目部配备专职安全生产管理人员。').fixedCount).toBe(0);
  });
});

describe('B11 竣工验收赶工暗示（句式11，$1$2 回写）', () => {
  it('B11 命中改写为按计划组织', () => {
    const result = fixSelfUnderminingCandidates('项目部在开工令下发后第270日亮化及附属设施安装完成后，随即启动竣工清理与验收移交程序，确保开工令下发后第300日完成全部验收移交工作');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('开工令下发后第270日完成');
    expect(result.markdown).toContain('开工令下发后第300日全部验收移交工作完成');
  });
  it('B11 数字变体（单位数）命中', () => {
    expect(fixSelfUnderminingCandidates('项目部在开工令下发后第7日亮化及附属设施安装完成后，随即启动竣工清理与验收移交程序，确保开工令下发后第10日完成全部验收移交工作').fixedCount).toBe(1);
  });
  it('B11 缺第二半不命中', () => {
    expect(fixSelfUnderminingCandidates('项目部在开工令下发后第270日亮化及附属设施安装完成后启动移交。').fixedCount).toBe(0);
  });
});

describe('B12 隐蔽验收重复检验自伤（句式12，$1 回写）', () => {
  it('B12 命中改写为验收闭环', () => {
    const result = fixSelfUnderminingCandidates('隐蔽工程在施工过程中已按24小时提前通知要求完成验收，竣工阶段不再重复检验，但须将全部隐蔽验收影像资料纳入竣工资料归档');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('隐蔽工程按24小时提前通知要求组织验收，验收合格后方可进入下道工序，全部隐蔽验收影像资料纳入竣工资料归档');
  });
  it('B12 变体不命中', () => {
    expect(fixSelfUnderminingCandidates('隐蔽工程在施工过程中已按24小时提前通知要求完成验收。').fixedCount).toBe(0);
  });
});

describe('B13 编制边界两可暗示（句式13）', () => {
  it('B13 命中改写为编制依据一致性', () => {
    const result = fixSelfUnderminingCandidates('本施工组织设计的编制边界为：本项目位于安徽省合肥市肥西县丰乐镇，以补疑澄清文件对清单及图纸的修正口径为优先执行依据。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('编制依据包括招标文件');
  });
  it('B13 地点最短 2 字命中', () => {
    expect(fixSelfUnderminingCandidates('本施工组织设计的编制边界为：本项目位于某县，以补疑澄清文件对清单及图纸的修正口径为优先执行依据。').fixedCount).toBe(1);
  });
  it('B13 地点 1 字不命中', () => {
    expect(fixSelfUnderminingCandidates('本施工组织设计的编制边界为：本项目位于皖，以补疑澄清文件对清单及图纸的修正口径为优先执行依据。').fixedCount).toBe(0);
  });
});

describe('B14 招标范围短板暗示（句式14）', () => {
  it('B14 命中改写为覆盖范围一致性', () => {
    const result = fixSelfUnderminingCandidates('施工组织设计覆盖从开工令下发至竣工验收合格后移交保修的全过程管理，不包含招标范围以外的工程内容。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('全过程管理内容与招标范围一致');
  });
  it('B14 变体不命中', () => {
    expect(fixSelfUnderminingCandidates('施工组织设计覆盖全过程管理。').fixedCount).toBe(0);
  });
});

describe('B15 交通开放负面表述（句式15）', () => {
  it('B15 命中改写为达到条件后开放', () => {
    const result = fixSelfUnderminingCandidates('面层混凝土弯拉强度达到设计强度且填缝完成前不得开放交通，由试验员按每检验批留置试块并送检，强度报告归档闭环。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('填缝完成后开放交通');
    expect(result.markdown).toContain('质量闭环');
  });
  it('B15 变体不命中', () => {
    expect(fixSelfUnderminingCandidates('面层混凝土弯拉强度达到设计强度后开放交通。').fixedCount).toBe(0);
  });
});

describe('B16 新技术短板自曝（句式16）', () => {
  it('B16 命中改写为成熟工艺正向表述', () => {
    const result = fixSelfUnderminingCandidates('本项目以成熟可靠的常规工艺为主，未采用新技术、新材料、新工艺或新设备。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('经工程实践验证的成熟工艺');
  });
  it('B16 「行业认定的」变体命中', () => {
    expect(fixSelfUnderminingCandidates('本项目以成熟可靠的常规工艺为主，未采用行业认定的新技术、新材料、新工艺或新设备。').fixedCount).toBe(1);
  });
  it('B16 无未采用表述不命中', () => {
    expect(fixSelfUnderminingCandidates('本项目以成熟可靠的常规工艺为主。').fixedCount).toBe(0);
  });
});

describe('B17 否定式自述分包（句式17）', () => {
  it('B17 命中改写为自主组织正向表述', () => {
    const result = fixSelfUnderminingCandidates('本招标项目不允许分包。本工程不进行分包，全部施工内容由我方自行组织完成。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('本招标项目严禁转包和违法分包，本工程全部施工任务由我公司项目部自行组织实施');
  });
  it('B17 单句不命中（两句缺一）', () => {
    expect(fixSelfUnderminingCandidates('本工程不进行分包，全部施工内容由我方自行组织完成。').fixedCount).toBe(0);
  });
});

describe('B18 收尾阶段赶工暗示（句式18）', () => {
  it('B18 命中改写为按计划组织', () => {
    const result = fixSelfUnderminingCandidates('收尾阶段安排10个日历天，项目经理组织各分组施工员进行内部预验收，预验收通过后组织竣工验收。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('按总进度计划组织实施');
    expect(result.markdown).toContain('复查销项后申请正式竣工验收');
  });
  it('B18 「亮化与」前缀变体命中', () => {
    expect(fixSelfUnderminingCandidates('亮化与收尾阶段安排10个日历天，项目经理组织各分组施工员进行内部预验收，预验收通过后组织竣工验收。').fixedCount).toBe(1);
  });
  it('B18 无竣工验收锚点不命中', () => {
    expect(fixSelfUnderminingCandidates('收尾阶段安排10个日历天，项目经理组织各分组施工员进行内部预验收。').fixedCount).toBe(0);
  });
});

describe('B19 组合与统计边界', () => {
  it('B19 多条句式同文命中（逐条应用+计数累加）', () => {
    const md = '确保数据与施工组织设计的一致性。杜绝施工过程中以工程量组价缺失为由提出变更申请';
    const result = fixSelfUnderminingCandidates(md);
    expect(result.fixedCount).toBe(2);
    expect(result.details.length).toBe(2);
  });
  it('B19 同句式两处命中（replace 全局+计数）', () => {
    const md = '确保数据与施工组织设计的一致性。确保方案与施工组织设计的一致性。';
    const result = fixSelfUnderminingCandidates(md);
    expect(result.fixedCount).toBe(2);
    expect(result.details[0]).toContain('2 处');
  });
  it('B19 无命中不动（fixedCount 0/details 空/markdown 原样）', () => {
    const md = '项目部按计划组织施工，各项管理措施落实到位。';
    const result = fixSelfUnderminingCandidates(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
    expect(result.details).toEqual([]);
  });
});

// ── C. fixHazardIdentificationGaps 危大遗漏补写 ──

/** 危大清单骨架：标题 + 六行识别区 */
const DANGER_DOC = (aliases: string[], extra = '') => `## 第五章 危大工程管理

### 5.1 危大工程辨识清单

${aliases.join('\n')}
${extra}`;

/** 前提句含别名时远离危大行放置：7 行填充使前提句落在危大行 ±6 行辨识区外，
 * 避免 extractDangerZone 窗口内前提句自我闭环（窗口内别名视为已辨识不再补写） */
const DANGER_DOC_FAR = (premise: string, aliases: string[]) => `${premise}\n${'本工程共分三个施工区段，各分区流水作业。\n'.repeat(7)}\n${DANGER_DOC(aliases)}`;

describe('C1 基坑支护与降水工程（深度 3m 门槛）', () => {
  it('C1 开挖深度 3m 适用且清单漏辨识 → 补写', () => {
    const md = DANGER_DOC(['吊装作业：按起重吊装及安装拆卸工程辨识。']);
    const result = fixHazardIdentificationGaps(`基坑开挖深度约为3m。\n${md}`);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('基坑支护与降水工程');
    expect(result.details[0]).toContain('基坑支护与降水工程');
  });
  it('C1 深度 2.9m 不适用 → 不补写', () => {
    const result = fixHazardIdentificationGaps(`基坑开挖深度约2.9m。\n${DANGER_DOC(['吊装作业。'])}`);
    expect(result.fixedCount).toBe(0);
  });
  it('C1 小数深度 3.5m 适用', () => {
    const result = fixHazardIdentificationGaps(`基坑开挖深度达3.5m。\n${DANGER_DOC(['吊装作业。'])}`);
    expect(result.fixedCount).toBe(1);
  });
  it('C1 别名「基坑支护」已列入 → 不补写', () => {
    const result = fixHazardIdentificationGaps(`基坑开挖深度约4m。\n${DANGER_DOC(['基坑支护：按基坑支护与降水工程辨识。'])}`);
    expect(result.fixedCount).toBe(0);
  });
  it.each(['基坑工程', '降排水', '降水井'])('C1 别名“%s”命中即闭环', (alias) => {
    const result = fixHazardIdentificationGaps(`基坑开挖深度约4m。\n${DANGER_DOC([`${alias}：已辨识。`])}`);
    expect(result.fixedCount).toBe(0);
  });
});

describe('C2 高大模板支撑工程（高度/荷载/词面三前提）', () => {
  it('C2 支撑搭设高度 8m 适用', () => {
    const result = fixHazardIdentificationGaps(`支撑搭设高度为8m。\n${DANGER_DOC(['吊装作业。'])}`);
    expect(result.fixedCount).toBe(1);
  });
  it('C2 高度 7.9m 不适用', () => {
    const result = fixHazardIdentificationGaps(`模板支撑体系搭设高度为7.9m。\n${DANGER_DOC(['吊装作业。'])}`);
    expect(result.fixedCount).toBe(0);
  });
  it('C2 施工总荷载 10kN 适用', () => {
    const result = fixHazardIdentificationGaps(`施工总荷载为10kN。\n${DANGER_DOC(['吊装作业。'])}`);
    expect(result.fixedCount).toBe(1);
  });
  it('C2 荷载 9.9kN 不适用', () => {
    const result = fixHazardIdentificationGaps(`模板支撑集中线荷载约9.9kN。\n${DANGER_DOC(['吊装作业。'])}`);
    expect(result.fixedCount).toBe(0);
  });
  it('C2 词面「高支模」直接适用', () => {
    const result = fixHazardIdentificationGaps(DANGER_DOC_FAR('高支模区域单独交底。', ['吊装作业。']));
    expect(result.fixedCount).toBe(1);
  });
  it.each(['高大模板', '高支模', '模板支撑体系', '模板支撑'])('C2 别名“%s”命中即闭环', (alias) => {
    const result = fixHazardIdentificationGaps(`模板支撑搭设高度为9m。\n${DANGER_DOC([`${alias}：已辨识。`])}`);
    expect(result.fixedCount).toBe(0);
  });
});

describe('C3 脚手架工程（高度 15m/悬挑词面）', () => {
  it('C3 落地式脚手架搭设高度 15m 适用', () => {
    const result = fixHazardIdentificationGaps(DANGER_DOC_FAR('落地式钢管脚手架搭设高度为15m。', ['吊装作业。']));
    expect(result.fixedCount).toBe(1);
  });
  it('C3 高度 14m 不适用', () => {
    const result = fixHazardIdentificationGaps(`落地式钢管脚手架搭设高度为14m。\n${DANGER_DOC(['吊装作业。'])}`);
    expect(result.fixedCount).toBe(0);
  });
  it('C3 悬挑式脚手架词面直接适用', () => {
    const result = fixHazardIdentificationGaps(DANGER_DOC_FAR('悬挑式脚手架分段搭设。', ['吊装作业。']));
    expect(result.fixedCount).toBe(1);
  });
  it.each(['脚手架', '落地式钢管脚手架', '悬挑式脚手架', '悬挑脚手架'])('C3 别名“%s”命中即闭环', (alias) => {
    const result = fixHazardIdentificationGaps(`脚手架搭设高度为16m。\n${DANGER_DOC([`${alias}：已辨识。`])}`);
    expect(result.fixedCount).toBe(0);
  });
});

describe('C4 起重吊装及安装拆卸工程（设备+作业形态词双覆盖）', () => {
  // 设备词含别名的（前提句在辨识区内自我闭环）→ DANGER_DOC_FAR 远置
  const aliasDeviceWords = ['塔吊', '塔式起重机', '汽车吊', '履带吊', '起重机械', '物料提升机', '提升机'];
  it.each(aliasDeviceWords)('C4 别名设备词“%s”适用', (word) => {
    const result = fixHazardIdentificationGaps(DANGER_DOC_FAR(`现场配置${word}。`, ['基坑支护：已辨识。']));
    expect(result.fixedCount).toBe(1);
  });
  const plainDeviceWords = ['吊车', '起重设备', '起重机', '卷扬机', '电动葫芦'];
  it.each(plainDeviceWords)('C4 设备词“%s”适用', (word) => {
    const result = fixHazardIdentificationGaps(`现场配置${word}。\n${DANGER_DOC(['基坑支护：已辨识。'])}`);
    expect(result.fixedCount).toBe(1);
  });
  const activityWords = ['起重伤害', '垂直运输'];
  it.each(activityWords)('C4 作业形态词“%s”适用', (word) => {
    const result = fixHazardIdentificationGaps(`材料运输涉及${word}作业。\n${DANGER_DOC(['基坑支护：已辨识。'])}`);
    expect(result.fixedCount).toBe(1);
  });
  it('C4 别名作业形态词“吊装”适用', () => {
    const result = fixHazardIdentificationGaps(DANGER_DOC_FAR('材料运输涉及吊装作业。', ['基坑支护：已辨识。']));
    expect(result.fixedCount).toBe(1);
  });
  it.each(['起重吊装', '塔吊', '塔式起重机', '汽车吊', '履带吊', '起重机械安拆', '物料提升机', '提升机', '起重机械', '吊装'])('C4 别名“%s”命中即闭环', (alias) => {
    const result = fixHazardIdentificationGaps(`现场配置塔吊。\n${DANGER_DOC([`${alias}：已辨识。`])}`);
    expect(result.fixedCount).toBe(0);
  });
});

describe('C5 吊篮作业工程', () => {
  it('C5 吊篮词面适用', () => {
    const result = fixHazardIdentificationGaps(DANGER_DOC_FAR('外墙作业采用吊篮。', ['基坑支护：已辨识。']));
    expect(result.fixedCount).toBe(1);
  });
  it.each(['吊篮', '高处作业吊篮', '电动吊篮'])('C5 别名“%s”命中即闭环', (alias) => {
    const result = fixHazardIdentificationGaps(`外墙作业采用吊篮。\n${DANGER_DOC([`${alias}：已辨识。`])}`);
    expect(result.fixedCount).toBe(0);
  });
});

describe('C6 拆除工程', () => {
  it('C6 拆除工程词面适用', () => {
    const result = fixHazardIdentificationGaps(DANGER_DOC_FAR('既有建筑物拆除工程先拆后建。', ['基坑支护：已辨识。']));
    expect(result.fixedCount).toBe(1);
  });
  it('C6 爆破拆除词面适用', () => {
    const result = fixHazardIdentificationGaps(DANGER_DOC_FAR('爆破拆除专项管控。', ['基坑支护：已辨识。']));
    expect(result.fixedCount).toBe(1);
  });
  it('C6 仅「拆除」无「工程」不适用（词面封闭）', () => {
    const result = fixHazardIdentificationGaps(`临时设施拆除后清理。\n${DANGER_DOC(['基坑支护：已辨识。'])}`);
    expect(result.fixedCount).toBe(0);
  });
  it.each(['拆除工程', '爆破拆除', '机械拆除'])('C6 别名“%s”命中即闭环', (alias) => {
    const result = fixHazardIdentificationGaps(`拆除工程按专项方案实施。\n${DANGER_DOC([`${alias}：已辨识。`])}`);
    expect(result.fixedCount).toBe(0);
  });
});

describe('C7 辨识区边界与锚点', () => {
  it('C7 别名在危大词行后第 6 行内命中（窗口内）', () => {
    const md = `基坑开挖深度约4m。

## 危大工程辨识清单

前置说明。

${'占位行。\n'.repeat(2)}基坑支护：已辨识。`;
    const result = fixHazardIdentificationGaps(md);
    expect(result.fixedCount).toBe(0);
  });
  it('C7 别名在危大词行 7 行外不命中（窗口外 → 补写）', () => {
    const md = `基坑开挖深度约4m。

## 危大工程辨识清单

${'占位行。\n'.repeat(7)}基坑支护：已辨识。`;
    const result = fixHazardIdentificationGaps(md);
    expect(result.fixedCount).toBe(1);
  });
  it('C7 全文无「危大」词 → 不补写（锚点缺失）', () => {
    const result = fixHazardIdentificationGaps('基坑开挖深度约4m。现场配置塔吊。');
    expect(result.fixedCount).toBe(0);
  });
  it('C7 无适用前提 → 不补写', () => {
    const result = fixHazardIdentificationGaps(DANGER_DOC(['吊装作业：已辨识。']));
    expect(result.fixedCount).toBe(0);
  });
  it('C7 多适用项全漏 → 一次补全（fixedCount=缺失数）', () => {
    const md = `基坑开挖深度约4m。现场配置塔吊。

## 危大工程辨识清单

起重吊装：已辨识。`;
    const result = fixHazardIdentificationGaps(md);
    expect(result.fixedCount).toBe(1);
    expect(result.details[0]).toContain('基坑支护与降水工程');
  });
  it('C7 补写插入在危大标题行之后', () => {
    const md = `基坑开挖深度约4m。

### 危大工程辨识清单
起重吊装：已辨识。`;
    const result = fixHazardIdentificationGaps(md);
    const lines = result.markdown.split('\n');
    const titleIndex = lines.findIndex(line => line.includes('危大工程辨识清单'));
    expect(lines[titleIndex + 1]).toContain('基坑支护与降水工程：');
  });
  it('C7 无标题行时回退最后一个含危大的正文行', () => {
    const md = `基坑开挖深度约4m。

正文说明：危大工程逐项辨识。

起重吊装：已辨识。`;
    const result = fixHazardIdentificationGaps(md);
    expect(result.fixedCount).toBe(1);
    const lines = result.markdown.split('\n');
    const anchorIndex = lines.findIndex(line => line.includes('危大工程逐项辨识'));
    expect(lines[anchorIndex + 1]).toContain('基坑支护与降水工程：');
  });
});

// ── D. fixSixHundredPercentCoverage 六个百分百补写 ──

describe('D1 词面命中兜底（六项 LEXICAL 谱系）', () => {
  const lexicalSamples: Array<[string, string]> = [
    ['100%围挡', '施工工地周边100%围挡'],
    ['物料堆放100%覆盖', '物料堆放100%覆盖'],
    ['出入车辆100%冲洗', '出入车辆100%冲洗'],
    ['施工现场地面100%硬化', '施工现场地面100%硬化'],
    ['拆迁工地100%湿法作业', '拆迁工地100%湿法作业'],
    ['渣土车辆100%密闭运输', '渣土车辆100%密闭运输'],
  ];
  it.each(lexicalSamples)('D1 词面“%s”+其余五项缺失 → 只补其余', async (lexical, full) => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const md = `## 扬尘治理六个百分百\n\n本工程落实${lexical}，严格抑尘。`;
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.fixedCount).toBe(5);
    // 已命中项不重复补写（输入原文不保留为补写句，补写块不含已命中项）
    expect(result.markdown).not.toContain(`${full}：`);
    // 其余五项补写句齐备
    for (const [, otherFull] of lexicalSamples.filter(([, other]) => other !== full)) {
      expect(result.markdown).toContain(`${otherFull}：`);
    }
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
  it('D1 词面变体谱系逐项闭环', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const variants = [
      '施工工地周边100%围挡、', '物料堆放全部采用密目网覆盖、', '出入车辆均通过冲洗点冲洗、',
      '施工现场地面100%硬化、', '拆迁区域湿法作业同步降尘、', '渣土车辆实行密闭运输。',
    ];
    const md = `## 扬尘治理\n\n${variants.join('')}`;
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.fixedCount).toBe(0);
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
});

describe('D2 语义判定路径（词面不命中、语义命中）', () => {
  it('D2 语义命中「围挡」（无 100% 词面）→ 该项不补写', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const md = `## 扬尘治理\n\n场地四周全部使用连续围挡进行封闭管理。`;
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.markdown).not.toContain('施工工地周边100%围挡：');
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
  it('D2 语义缺失六项 → 全补写', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const md = `## 扬尘治理\n\n现场安排专人清扫保洁，防止扬尘污染环境。`;
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.fixedCount).toBe(6);
    expect(result.details[0]).toContain('施工工地周边100%围挡');
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
  it('D2 长句语义稀释形态（对照实现注释）→ 逐项独立短句判定', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const md = `## 扬尘治理\n\n现场出入口设置车辆冲洗设施，冲洗干净后方可上路行驶。`;
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.markdown).not.toContain('出入车辆100%冲洗：');
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
});

describe('D3 拆迁工地豁免', () => {
  const exemptPrefixes = ['本项目', '本工程', '该工程', '该项目', '本标段', '本施工项目'];
  const exemptCores = ['无拆迁', '不涉及拆迁', '无房屋拆除', '无拆除'];
  it('D3 豁免句谱系 → 拆迁项不补写（只补其余 5 项）', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    for (const prefix of exemptPrefixes) {
      for (const core of exemptCores) {
        const md = `## 扬尘治理\n\n${prefix}${core}，扬尘治理按六项措施落实。`;
        const result = await fixSixHundredPercentCoverage(md);
        expect(result.markdown).not.toContain('拆迁工地100%湿法作业：');
        expect(result.fixedCount).toBe(5);
      }
    }
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
  it('D3 无工程主语的不涉及拆迁不豁免', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const md = `## 扬尘治理\n\n临时设施布置不涉及拆迁补偿，扬尘治理按六项措施落实。`;
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.markdown).toContain('拆迁工地100%湿法作业：');
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
});

describe('D4 补写锚点', () => {
  it('D4 主锚点：六个百分百正文行后插入', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const md = `## 扬尘治理\n\n本工程严格执行扬尘治理六个百分百要求。\n\n后文内容。`;
    const result = await fixSixHundredPercentCoverage(md);
    const lines = result.markdown.split('\n');
    const anchorIndex = lines.findIndex(line => line.includes('六个百分百要求'));
    expect(lines[anchorIndex + 1]).toContain('施工工地周边100%围挡：');
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
  it('D4 兜底：扬尘小节标题尾部插入', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const md = `## 第五章 文明施工\n\n### 5.1 扬尘防治措施\n\n安排专人清扫。\n\n### 5.2 噪声控制\n\n控制施工噪声。`;
    const result = await fixSixHundredPercentCoverage(md);
    const lines = result.markdown.split('\n');
    const noiseIndex = lines.findIndex(line => line.includes('噪声控制'));
    // 插入块六行：块首围挡句在标题前 8 行范围内，块尾密闭句紧邻噪声标题
    const inserted = lines.slice(Math.max(0, noiseIndex - 8), noiseIndex).join('\n');
    expect(inserted).toContain('施工工地周边100%围挡：');
    expect(inserted).toContain('渣土车辆100%密闭运输：');
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
  it('D4 兜底：环保标题尾部插入', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const md = `## 第五章 环保管理\n\n安排专人清扫保洁。\n\n## 第六章 安全\n\n安全管理内容。`;
    const result = await fixSixHundredPercentCoverage(md);
    const lines = result.markdown.split('\n');
    const safetyIndex = lines.findIndex(line => line.includes('第六章'));
    const inserted = lines.slice(Math.max(0, safetyIndex - 8), safetyIndex).join('\n');
    expect(inserted).toContain('施工工地周边100%围挡：');
    expect(inserted).toContain('渣土车辆100%密闭运输：');
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
  it('D4 兜底：无任何标题 → 文档末尾插入', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    // 不含主锚点词（六个百分百/100%围挡/扬尘治理）：只触发环保预检，走文末兜底
    const md = '本工程严格执行环保措施要求。\n安排专人清扫保洁。';
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.markdown.trimEnd().endsWith('装载高度不超过车厢挡板。')).toBe(true);
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
});

describe('D5 预检与句池过滤', () => {
  it('D5 无扬尘/环保/文明施工/绿色施工词 → 不补写', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const result = await fixSixHundredPercentCoverage('## 安全文明管理\n\n本工程落实各项管理措施。');
    expect(result.fixedCount).toBe(0);
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
  it('D5 标题行不进句池（标题含围挡也不判定）', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const md = `## 扬尘治理\n\n### 施工工地周边100%围挡\n\n后文。`;
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.markdown).toContain('施工工地周边100%围挡：');
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
  it('D5 表格行不进句池', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const md = `## 扬尘治理\n\n| 措施 | 100%围挡 |\n| --- | --- |\n后文。`;
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.markdown).toContain('施工工地周边100%围挡：');
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
  it('D5 过短句（<8 字）不进句池', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const md = `## 扬尘治理\n\n围挡。\n\n后文。`;
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.markdown).toContain('施工工地周边100%围挡：');
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
  it('D5 无预筛词行不进句池', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
    const md = `## 扬尘治理\n\n安排专人负责日常管理事务。\n\n后文。`;
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.fixedCount).toBe(6);
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
});

// ── E. fixInternalTerminology 内部术语清洗 ──

describe('E1 五条术语替换谱系', () => {
  const terms: Array<[string, string]> = [
    ['全文唯一劳动力峰值口径', '全文劳动力峰值基准'],
    ['统一控制口径', '统一控制基准'],
    ['按以下口径处理', '按以下程序处理'],
    ['拆除工程工作包', '拆除工程'],
    ['按工作包逐项说明', '按专业工程逐项说明'],
  ];
  it.each(terms)('E1 “%s”→“%s”', (from, to) => {
    const result = fixInternalTerminology(`正文规定${from}。`);
    expect(result.markdown).toContain(to);
    expect(result.markdown).not.toContain(from);
    expect(result.fixedCount).toBe(1);
  });
  it('E1 管道口径语境不替换（非锁定短语）', () => {
    const result = fixInternalTerminology('管道口径为DN200，按设计执行。');
    expect(result.markdown).toBe('管道口径为DN200，按设计执行。');
    expect(result.fixedCount).toBe(0);
  });
  it('E1 多术语同文逐条替换', () => {
    const result = fixInternalTerminology('统一控制口径。拆除工程工作包按以下口径处理。');
    expect(result.fixedCount).toBe(3);
    expect(result.details.length).toBe(3);
  });
  it('E1 同术语两处计数', () => {
    const result = fixInternalTerminology('统一控制口径。统一控制口径。');
    expect(result.fixedCount).toBe(2);
    expect(result.details[0]).toContain('2 处');
  });
  it('E1 无命中不动', () => {
    const md = '按专业工程逐项说明，口径统一。';
    const result = fixInternalTerminology(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
    expect(result.details).toEqual([]);
  });
});

// ── F. fixHeaderlessTables 无表头表格 ──

describe('F1 补表头基本形态', () => {
  it('F1 分隔线+数据行 → 补「项目|内容」表头', () => {
    const result = fixHeaderlessTables('正文段落\n| --- | --- |\n| 数据A | 数据B |');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('正文段落\n| 项目 | 内容 |\n| --- | --- |\n| 数据A | 数据B |');
  });
  it('F1 上一行是表格行（正常表格）→ 跳过', () => {
    const md = '| 表头A | 表头B |\n| --- | --- |\n| 数据A | 数据B |';
    const result = fixHeaderlessTables(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('F1 下一行非数据行 → 跳过', () => {
    const md = '正文段落\n| --- | --- |\n\n正文继续。';
    const result = fixHeaderlessTables(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('F1 分隔线在文末（无后续行）→ 跳过', () => {
    expect(fixHeaderlessTables('正文\n| --- |').fixedCount).toBe(0);
  });
  it('F1 单列分隔线 colCount<2 → 跳过', () => {
    const md = '正文\n| --- |\n| 数据 |';
    const result = fixHeaderlessTables(md);
    expect(result.fixedCount).toBe(0);
  });
  it('F1 三列表格补「项目|内容|备注」', () => {
    const result = fixHeaderlessTables('正文\n| --- | --- | --- |\n| A | B | C |');
    expect(result.markdown).toContain('| 项目 | 内容 | 备注 |');
  });
  it('F1 四列表格补两个备注列', () => {
    const result = fixHeaderlessTables('正文\n| --- | --- | --- | --- |\n| A | B | C | D |');
    expect(result.markdown).toContain('| 项目 | 内容 | 备注 | 备注 |');
  });
  it.each(['| --- | --- |', '|:---|---:|', '| ---: | :--- |'])('F1 分隔线变体“%s”识别', (sep) => {
    const result = fixHeaderlessTables(`正文\n${sep}\n| A | B |`);
    expect(result.fixedCount).toBe(1);
  });
  it('F1 多处无表头表格全补', () => {
    const md = '段一\n| --- | --- |\n| A | B |\n\n段二\n| --- | --- |\n| C | D |';
    const result = fixHeaderlessTables(md);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown.match(/\| 项目 \| 内容 \|/gu)?.length).toBe(2);
  });
  it('F1 无分隔线不动', () => {
    const md = '正文段落\n| 数据A | 数据B |';
    const result = fixHeaderlessTables(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
    expect(result.details).toEqual([]);
  });
});

// ── G. fixAmbiguousEitherOrCandidates 两可归一 ──

describe('G1 三条两可归一谱系', () => {
  it('G1 钢板桩或型钢支撑支护 → 钢板桩支护', () => {
    const result = fixAmbiguousEitherOrCandidates('基坑采用钢板桩或型钢支撑支护。');
    expect(result.markdown).toBe('基坑采用钢板桩支护。');
    expect(result.fixedCount).toBe(1);
  });
  it('G1 放坡或钢板桩支护 → 1:0.5放坡加钢板桩支护', () => {
    const result = fixAmbiguousEitherOrCandidates('基坑采用放坡或钢板桩支护。');
    expect(result.markdown).toBe('基坑采用1:0.5放坡加钢板桩支护。');
  });
  it('G1 放坡或支护 → 放坡支护', () => {
    const result = fixAmbiguousEitherOrCandidates('基坑采用放坡或支护。');
    expect(result.markdown).toBe('基坑采用放坡支护。');
  });
  it('G1 组合句逐条应用（先钢板桩型钢、后放坡钢板桩、最后放坡支护）', () => {
    const md = '方案一：钢板桩或型钢支撑支护；方案二：放坡或钢板桩支护；方案三：放坡或支护。';
    const result = fixAmbiguousEitherOrCandidates(md);
    expect(result.markdown).toBe('方案一：钢板桩支护；方案二：1:0.5放坡加钢板桩支护；方案三：放坡支护。');
    expect(result.fixedCount).toBe(3);
  });
  it('G1 变体不命中（钢板桩或型钢支撑）', () => {
    expect(fixAmbiguousEitherOrCandidates('基坑采用钢板桩或型钢支撑。').fixedCount).toBe(0);
  });
  it('G1 放坡与支护间隔远不命中', () => {
    expect(fixAmbiguousEitherOrCandidates('基坑采用放坡开挖，另有支护体系。').fixedCount).toBe(0);
  });
  it('G1 无命中不动', () => {
    const md = '基坑采用钢板桩支护。';
    const result = fixAmbiguousEitherOrCandidates(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
    expect(result.details).toEqual([]);
  });
});

// ── H. fixForbiddenConfigurationTerms 禁止词清洗 ──

describe('H1 公共资源交易监督管理替换', () => {
  it('H1 命中 → 主语归属招标人按程序处理', () => {
    const result = fixForbiddenConfigurationTerms('发现违法行为的，将报公共资源交易监督管理部门处理。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('发现违法行为的，由招标人按招标文件规定程序处理。');
  });
  it('H1 变体不命中（仅监督管理部门）', () => {
    const md = '接受公共资源交易监督管理部门的监督。';
    const result = fixForbiddenConfigurationTerms(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('H1 无命中不动 details 空', () => {
    const result = fixForbiddenConfigurationTerms('投标人按招标文件规定程序办理。');
    expect(result.markdown).toBe('投标人按招标文件规定程序办理。');
    expect(result.fixedCount).toBe(0);
    expect(result.details).toEqual([]);
  });
});

// ── I. fixTocFromBody 目录按正文重建 ──

const TOC_DOC = (toc: string, body: string) => `## 目录\n\n${toc}\n\n<div class="page-break"></div>\n\n${body}`;

describe('I1 章序谱系识别', () => {
  const cnOrdinals: Array<[string, number]> = [['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10]];
  it.each(cnOrdinals)('I1 第%s章（中文单字）', (ordinal, n) => {
    const md = TOC_DOC('旧目录内容', `## 第${ordinal}章 施工部署\n\n### ${n}.1 小节\n\n内容。`);
    const result = fixTocFromBody(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain(`第${ordinal}章 施工部署`);
    expect(result.markdown).toContain(`  ${n}.1 小节`);
  });
  it.each([['十一', 11], ['十五', 15], ['十九', 19]] as Array<[string, number]>)('I1 第%s章（十X 形态）', (ordinal, n) => {
    const md = TOC_DOC('旧目录内容', `## 第${ordinal}章 施工部署\n\n### ${n}.1 小节\n\n内容。`);
    const result = fixTocFromBody(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain(`第${ordinal}章 施工部署`);
    expect(result.markdown).toContain(`  ${n}.1 小节`);
  });
  it.each([['1', 1], ['5', 5], ['10', 10]] as Array<[string, number]>)('I1 第%s章（阿拉伯数字）', (ordinal, n) => {
    const md = TOC_DOC('旧目录内容', `## 第${ordinal}章 施工部署\n\n### ${n}.1 小节\n\n内容。`);
    const result = fixTocFromBody(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain(`第${ordinal}章 施工部署`);
    expect(result.markdown).toContain(`  ${n}.1 小节`);
  });
  it('I1 第二十章（二十）不识别 → 章节被过滤', () => {
    const md = TOC_DOC('旧目录内容', '## 第二十章 附则\n\n### 20.1 小节\n\n内容。');
    const result = fixTocFromBody(md);
    expect(result.fixedCount).toBe(0);
  });
});

describe('I2 重建结构', () => {
  it('I2 目录与正文不一致 → 重建（fixedCount 1）', () => {
    const md = TOC_DOC('第一章 工程概况\n  1.1 项目概况\n第二章 施工部署\n  2.1 总体部署\n  2.2 已删除小节',
      '## 第一章 工程概况\n\n### 1.1 项目概况\n\n内容。\n\n## 第二章 施工部署\n\n### 2.1 总体部署\n\n内容。');
    const result = fixTocFromBody(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('## 目录\n\n第一章 工程概况\n  1.1 项目概况\n第二章 施工部署\n  2.1 总体部署');
    expect(result.markdown).not.toContain('2.2 已删除小节');
  });
  it('I2 重建后幂等（二次调用 fixedCount 0）', () => {
    const body = '## 第一章 工程概况\n\n### 1.1 项目概况\n\n内容。';
    const first = fixTocFromBody(TOC_DOC('旧目录内容', body));
    expect(first.fixedCount).toBe(1);
    const second = fixTocFromBody(first.markdown);
    expect(second.fixedCount).toBe(0);
    expect(second.markdown).toBe(first.markdown);
  });
  it('I2 小节挂靠所属章（major 分组）', () => {
    const body = '## 第一章 工程概况\n\n### 1.1 概况\n\n## 第二章 施工部署\n\n### 2.1 部署\n\n### 2.2 计划';
    const result = fixTocFromBody(TOC_DOC('旧目录', body));
    expect(result.markdown).toContain('第一章 工程概况\n  1.1 概况\n第二章 施工部署\n  2.1 部署\n  2.2 计划');
  });
  it('I2 无对应章的小节不出现在目录', () => {
    const body = '## 第一章 工程概况\n\n### 1.1 概况\n\n### 3.1 孤儿小节';
    const result = fixTocFromBody(TOC_DOC('旧目录', body));
    // 正文仍保留孤儿小节，仅目录块部分不得出现
    const tocPart = result.markdown.split('<div class="page-break"></div>')[0];
    expect(tocPart).not.toContain('3.1 孤儿小节');
  });
  it('I2 章标题保留原文（阿拉伯章序不转中文）', () => {
    const body = '## 第11章 附则\n\n### 11.1 保修\n\n内容。';
    const result = fixTocFromBody(TOC_DOC('旧目录', body));
    expect(result.markdown).toContain('第11章 附则');
  });
  it('I2 目录块后紧跟 ##（无 page-break）也重建', () => {
    const md = '## 目录\n\n旧目录内容\n\n## 第一章 工程概况\n\n### 1.1 概况\n\n内容。';
    const result = fixTocFromBody(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('## 目录\n\n第一章 工程概况\n  1.1 概况');
  });
});

describe('I3 不动场景', () => {
  it('I3 无目录块 → 不动', () => {
    const md = '## 第一章 工程概况\n\n### 1.1 概况\n\n内容。';
    const result = fixTocFromBody(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('I3 有目录但正文无章 → 不动', () => {
    const md = TOC_DOC('第一章 工程概况', '正文只有段落，无章标题。');
    const result = fixTocFromBody(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('I3 有章但无小节 → 不动', () => {
    const md = TOC_DOC('第一章 工程概况', '## 第一章 工程概况\n\n正文段落。');
    const result = fixTocFromBody(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('I3 目录已是正文投影 → 首调重建一次后幂等', () => {
    // TOC_BLOCK_LOCAL_RE 的 tocMatch[0] 含尾部换行而 rebuilt 不含 → 首次必重建 1 次；
    // 重建后目录块与 rebuilt 逐字一致 → 二次调用幂等 0
    const md = TOC_DOC('第一章 工程概况\n  1.1 概况', '## 第一章 工程概况\n\n### 1.1 概况\n\n内容。');
    const first = fixTocFromBody(md);
    expect(first.fixedCount).toBe(1);
    const second = fixTocFromBody(first.markdown);
    expect(second.fixedCount).toBe(0);
    expect(second.markdown).toBe(first.markdown);
  });
  it('I3 小节编号非 x.y 形态不采', () => {
    const md = TOC_DOC('第一章 工程概况', '## 第一章 工程概况\n\n### 概况说明\n\n内容。');
    const result = fixTocFromBody(md);
    expect(result.fixedCount).toBe(0);
  });
});

// ── J. fixQuantityAuthorityConflicts 清单工程量五重豁免 ──

describe('J1 基础校正与单位变体', () => {
  it('J1 正文漂移值 → 权威值替换', () => {
    const result = fixQuantityAuthorityConflicts('级配碎石18949.52m³。', [{ name: '级配碎石', value: 20931.02, unit: 'm³' }]);
    expect(result.markdown).toBe('级配碎石20931.02m³。');
    expect(result.fixedCount).toBe(1);
    expect(result.details[0]).toContain('20931.02');
  });
  it.each(['㎡', 'm²', 'm2'])('J1 单位变体“%s”互配', (unit) => {
    const result = fixQuantityAuthorityConflicts(`栽植色带90${unit}。`, [{ name: '栽植色带', value: 120, unit: '㎡' }]);
    expect(result.markdown).toBe(`栽植色带120${unit}。`);
  });
  it.each(['m³', 'm3'])('J1 体积单位变体“%s”互配', (unit) => {
    const result = fixQuantityAuthorityConflicts(`挖方4040.45${unit}。`, [{ name: '挖方', value: 4187.38, unit: 'm³' }]);
    expect(result.markdown).toBe(`挖方4187.38${unit}。`);
  });
  it.each(['吨', 't'])('J1 重量单位变体“%s”互配', (unit) => {
    const result = fixQuantityAuthorityConflicts(`钢筋32${unit}。`, [{ name: '钢筋', value: 45.5, unit: 't' }]);
    expect(result.markdown).toBe(`钢筋45.5${unit}。`);
  });
  it('J1 大写单位兼容（i 标志）', () => {
    const result = fixQuantityAuthorityConflicts('混凝土面积50M2。', [{ name: '混凝土', value: 80, unit: '㎡' }]);
    expect(result.markdown).toBe('混凝土面积80M2。');
  });
  it('J1 无权威列表 → 不动', () => {
    const result = fixQuantityAuthorityConflicts('级配碎石18949.52m³。');
    expect(result.markdown).toBe('级配碎石18949.52m³。');
    expect(result.fixedCount).toBe(0);
  });
});

describe('J2 名称弹性匹配（括号三态）', () => {
  it.each(['栽植色带（生态池外围一圈）', '栽植色带(生态池外围一圈)'])('J2 正文名称“%s”匹配权威条目', (bodyName) => {
    const result = fixQuantityAuthorityConflicts(`${bodyName}90m²。`, [{ name: '栽植色带（生态池外围一圈）', value: 120, unit: '㎡' }]);
    expect(result.markdown).toBe(`${bodyName}120m²。`);
  });
  it('J2 无括号形态不匹配括号权威 → 锁定不动', () => {
    // flexNamePattern 括号 [（(]? 可省略但括号内容必填：权威条目含括号内容时，
    // 正文无括号形态不构成弹性匹配 → fixedCount 0
    const md = '栽植色带90m²。';
    const result = fixQuantityAuthorityConflicts(md, [{ name: '栽植色带（生态池外围一圈）', value: 120, unit: '㎡' }]);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('J2 名称部分匹配（子串命中）', () => {
    const result = fixQuantityAuthorityConflicts('人行道板安砌114.8m。', [{ name: '人行道板', value: 150, unit: 'm' }]);
    expect(result.markdown).toBe('人行道板安砌150m。');
  });
});

describe('J3 最长条目名优先', () => {
  it('J3 长短条目并存 → 长条目命中不误改', () => {
    const result = fixQuantityAuthorityConflicts('塑料管铺设8205.53m。', [
      { name: '塑料管铺设', value: 8205.53, unit: 'm' },
      { name: '塑料管', value: 7525.01, unit: 'm' },
    ]);
    expect(result.markdown).toBe('塑料管铺设8205.53m。');
    expect(result.fixedCount).toBe(0);
  });
  it('J3 长条目漂移 → 长条目权威校正', () => {
    const result = fixQuantityAuthorityConflicts('塑料管铺设7000m。', [
      { name: '塑料管铺设', value: 8205.53, unit: 'm' },
      { name: '塑料管', value: 7525.01, unit: 'm' },
    ]);
    expect(result.markdown).toBe('塑料管铺设8205.53m。');
  });
  it('J3 短条目独占命中（无更长条目时照常修复）', () => {
    const result = fixQuantityAuthorityConflicts('级配碎石基层18949.52m³。', [{ name: '级配碎石', value: 20931.02, unit: 'm³' }]);
    expect(result.markdown).toBe('级配碎石基层20931.02m³。');
  });
});

describe('J4 表格行豁免', () => {
  it('J4 表格行数值不校正', () => {
    const md = '| 分部 | 级配碎石 | m³ | 18949.52 |';
    const result = fixQuantityAuthorityConflicts(md, [{ name: '级配碎石', value: 20931.02, unit: 'm³' }]);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
});

describe('J5 村名/分部语境豁免', () => {
  it.each(['郢', '庄', '岗', '塘', '圩', '坝', '池', '井'])('J5 名称前 12 字含“%s”豁免（D2 收紧词表）', (hint) => {
    const md = `马老${hint}分项级配碎石18949.52m³。`;
    const result = fixQuantityAuthorityConflicts(md, [{ name: '级配碎石', value: 20931.02, unit: 'm³' }]);
    expect(result.markdown).toBe(md);
  });
  it.each(['村', '组', '集', '区', '段', '栋', '楼'])('J5 收紧剔除词“%s”12 字内 → 不再豁免 → 替换（D2 反漂移）', (hint) => {
    const md = `马老${hint}分项级配碎石18949.52m³。`;
    const result = fixQuantityAuthorityConflicts(md, [{ name: '级配碎石', value: 20931.02, unit: 'm³' }]);
    expect(result.markdown).toBe(`马老${hint}分项级配碎石20931.02m³。`);
    expect(result.fixedCount).toBe(1);
  });
  it('J5 段落级村名豁免（村名距条目名超 12 字）', () => {
    const md = '本段落涉及殷郢组等多个自然村。本分项工程量为：级配碎石18949.52m³。';
    const result = fixQuantityAuthorityConflicts(md, [{ name: '级配碎石', value: 20931.02, unit: 'm³' }]);
    expect(result.markdown).toBe(md);
  });
  it('J5 段落级豁免字符集外的词不豁免', () => {
    // 前缀 12 字不得含豁免字符集（村郢组庄岗塘圩集坝分区段栋号楼池）任一字符
    const md = '依据本条。级配碎石18949.52m³。';
    const result = fixQuantityAuthorityConflicts(md, [{ name: '级配碎石', value: 20931.02, unit: 'm³' }]);
    expect(result.markdown).toContain('20931.02');
  });
});

describe('J6 规格限定词豁免', () => {
  it('J6 前置规格（直径450）豁免', () => {
    const md = '直径450塑料检查井40座。';
    const result = fixQuantityAuthorityConflicts(md, [{ name: '塑料检查井', value: 555, unit: '座' }]);
    expect(result.markdown).toBe(md);
  });
  it.each(['DN200', 'DN110', 'Φ16', 'φ10'])('J6 后置规格“%s”豁免', (spec) => {
    const md = `钢带PE增强螺旋波纹管${spec}铺设2170m。`;
    const result = fixQuantityAuthorityConflicts(md, [{ name: '波纹管', value: 3000, unit: 'm' }]);
    expect(result.markdown).toBe(md);
  });
  it('J6 规格词在 8 字窗口外不豁免', () => {
    const md = '直径450管道采用波纹管铺设2170m。';
    const result = fixQuantityAuthorityConflicts(md, [{ name: '波纹管', value: 3000, unit: 'm' }]);
    expect(result.markdown).toContain('3000');
  });
});

describe('J7 24 字窗口截断', () => {
  it('J7 名称后紧跟列举分隔符截断窗口（无候选不动）', () => {
    const md = '主要工程量包括墙面彩绘、小微菜园围栏、生态菜园等内容。';
    const result = fixQuantityAuthorityConflicts(md, [{ name: '墙面彩绘', value: 20931.02, unit: 'm' }]);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('J7 窗口内差异最小候选胜出', () => {
    const md = '级配碎石基层厚度200mm且总工程量18949.52m³。';
    const result = fixQuantityAuthorityConflicts(md, [{ name: '级配碎石', value: 20931.02, unit: 'm³' }]);
    expect(result.markdown).toBe('级配碎石基层厚度200mm且总工程量20931.02m³。');
  });
});

describe('J8 阈值与跳过', () => {
  it('J8 D2 零豁免：差异 0.87% 四舍五入口径差替换', () => {
    const result = fixQuantityAuthorityConflicts('级配碎石20750m³。', [{ name: '级配碎石', value: 20931.02, unit: 'm³' }]);
    expect(result.markdown).toBe('级配碎石20931.02m³。');
    expect(result.fixedCount).toBe(1);
  });
  it('J8 与权威相等跳过', () => {
    const result = fixQuantityAuthorityConflicts('级配碎石20931.02m³。', [{ name: '级配碎石', value: 20931.02, unit: 'm³' }]);
    expect(result.fixedCount).toBe(0);
  });
  it('J8 数值左边界（1e3 不截取 3）', () => {
    const result = fixQuantityAuthorityConflicts('换算系数1e3。', [{ name: '换算系数', value: 1000, unit: 'm' }]);
    expect(result.markdown).toBe('换算系数1e3。');
  });
  it('J8 千分位数值校正', () => {
    const result = fixQuantityAuthorityConflicts('石方开挖1,500m³。', [{ name: '石方开挖', value: 2000, unit: 'm³' }]);
    expect(result.markdown).toBe('石方开挖2000m³。');
  });
});

describe('J9 句级口径豁免', () => {
  it('J9 句内多候选全大漂移 → 分部量列举句不归一', () => {
    const md = '本句挖一般土方146.93m³、级配碎石480.5m³、水泥混凝土572.3m³。';
    const result = fixQuantityAuthorityConflicts(md, [
      { name: '挖一般土方', value: 800, unit: 'm³' },
      { name: '级配碎石', value: 2000, unit: 'm³' },
      { name: '水泥混凝土', value: 1800, unit: 'm³' },
    ]);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('J9 句内大漂移与小差异并存 → 不触发豁免（大漂移仍修）', () => {
    const md = '拆除路面633m³，级配碎石18949.52m³。';
    const result = fixQuantityAuthorityConflicts(md, [
      { name: '拆除路面', value: 2134, unit: 'm³' },
      { name: '级配碎石', value: 20931.02, unit: 'm³' },
    ]);
    expect(result.fixedCount).toBeGreaterThan(0);
  });
});

describe('J10 组合与统计', () => {
  it('J10 多条目同文校正（occupied 防重叠）', () => {
    const md = '拆除路面633m³，级配碎石18949.52m³。';
    const result = fixQuantityAuthorityConflicts(md, [
      { name: '拆除路面', value: 2134, unit: 'm³' },
      { name: '级配碎石', value: 20931.02, unit: 'm³' },
    ]);
    expect(result.markdown).toBe('拆除路面2134m³，级配碎石20931.02m³。');
    expect(result.fixedCount).toBe(2);
  });
  it('J10 名称完全重叠时先到先得（occupied）', () => {
    const result = fixQuantityAuthorityConflicts('塑料管铺设8205.53m。', [
      { name: '塑料管铺设', value: 9000, unit: 'm' },
      { name: '塑料管', value: 7525.01, unit: 'm' },
    ]);
    expect(result.markdown).toBe('塑料管铺设9000m。');
    expect(result.fixedCount).toBe(1);
  });
});

// ── Jb. fixPlaceholderTableCells 工程概况套话填充 ──

describe('JB1 表格套话填充', () => {
  it('JB1 建设规模套话 → 面积摘要', () => {
    const result = fixPlaceholderTableCells('| 建设规模 | 按施工图设计文件确定 |', { areaSummary: '建筑面积5000平方米、地上3层' });
    expect(result.markdown).toBe('| 建设规模 | 建筑面积5000平方米、地上3层 |');
    expect(result.fixedCount).toBe(1);
  });
  it('JB1 工期套话 → N个日历天', () => {
    const result = fixPlaceholderTableCells('| 工期 | 按合同约定工期执行 |', { scheduleDays: 210 });
    expect(result.markdown).toBe('| 工期 | 210个日历天 |');
  });
  it('JB1 两项套话同文全填', () => {
    const md = '| 建设规模 | 按施工图设计文件确定 |\n| 工期 | 按合同约定工期执行 |';
    const result = fixPlaceholderTableCells(md, { areaSummary: '建筑面积5000平方米', scheduleDays: 210 });
    expect(result.fixedCount).toBe(2);
  });
  it('JB1 无 areaSummary 不填面积套话', () => {
    const md = '| 建设规模 | 按施工图设计文件确定 |';
    const result = fixPlaceholderTableCells(md, { scheduleDays: 210 });
    expect(result.markdown).toBe(md);
  });
  it('JB1 scheduleDays 非正不填', () => {
    const md = '| 工期 | 按合同约定工期执行 |';
    const result = fixPlaceholderTableCells(md, { scheduleDays: 0 });
    expect(result.markdown).toBe(md);
  });
  it('JB1 正文（非表格行）不替换', () => {
    const md = '建设规模按施工图设计文件确定。';
    const result = fixPlaceholderTableCells(md, { areaSummary: '建筑面积5000平方米' });
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('JB1 无套话无选项不动', () => {
    const result = fixPlaceholderTableCells('| 建设规模 | 建筑面积5000平方米 |');
    expect(result.markdown).toBe('| 建设规模 | 建筑面积5000平方米 |');
    expect(result.fixedCount).toBe(0);
  });
});

// ── Jc. fixQualityAssuranceCoverage 6.1 质量保障补全 ──

describe('JC1 核心术语门与补写', () => {
  it('JC1 六术语全缺 → 块尾补写协同段', () => {
    const md = '### 6.1 施工部署与施工流水组织\n\n本工程以安全文明为主线组织施工。\n\n### 6.2 施工平面布置\n\n平面布置内容。';
    const result = fixQualityAssuranceCoverage(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('质量保障体系与安全文明管理同频运行');
    const injectIndex = result.markdown.indexOf('质量保障体系');
    const nextSectionIndex = result.markdown.indexOf('### 6.2');
    expect(injectIndex).toBeLessThan(nextSectionIndex);
  });
  it('JC1 命中 3 术语不动（门槛 3）', () => {
    const md = '### 6.1 施工部署与施工流水组织\n\n本工程实行三检制，推行样板引路，落实隐蔽验收。\n\n### 6.2 施工平面布置';
    const result = fixQualityAssuranceCoverage(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('JC1 命中 2 术语补写', () => {
    const md = '### 6.1 施工部署与施工流水组织\n\n本工程实行三检制，推行样板引路。\n\n### 6.2 施工平面布置';
    const result = fixQualityAssuranceCoverage(md);
    expect(result.fixedCount).toBe(1);
  });
  it('JC1 无 6.1 标题不动', () => {
    const md = '### 6.1 施工平面布置\n\n本工程组织施工。';
    const result = fixQualityAssuranceCoverage(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('JC1 补写后幂等（注入段含术语）', () => {
    const md = '### 6.1 施工部署与施工流水组织\n\n本工程以安全文明为主线。\n\n### 6.2 施工平面布置';
    const first = fixQualityAssuranceCoverage(md);
    expect(first.fixedCount).toBe(1);
    const second = fixQualityAssuranceCoverage(first.markdown);
    expect(second.fixedCount).toBe(0);
  });
  it('JC1 块至 ## 第六章边界（块尾为章尾）', () => {
    const md = '### 6.1 施工部署与施工流水组织\n\n本工程组织施工。\n\n## 第六章 施工平面布置\n\n平面布置。';
    const result = fixQualityAssuranceCoverage(md);
    expect(result.fixedCount).toBe(1);
    const injectIndex = result.markdown.indexOf('质量保障体系');
    expect(injectIndex).toBeLessThan(result.markdown.indexOf('## 第六章'));
  });
});

// ── K. applyNumericConsistencyDeterministicFixes 五步管线 ──

describe('K1 第1步 劳动力峰值（fixLaborPeakConflicts）', () => {
  it('K1 正文峰值与跨章权威差 >30% → 替换为表峰值', () => {
    const result = applyNumericConsistencyDeterministicFixes('施工高峰期总人数68人。', { laborPeakAuthority: 186 });
    expect(result.markdown).toBe('施工高峰期总人数186人。');
    expect(result.fixedCount).toBe(1);
  });
  it('K1 D2 零豁免：差异 19%（150 vs 186）替换', () => {
    const result = applyNumericConsistencyDeterministicFixes('施工高峰期总人数150人。', { laborPeakAuthority: 186 });
    expect(result.markdown).toBe('施工高峰期总人数186人。');
    expect(result.fixedCount).toBe(1);
  });
  it('K1 偏低方向（62 vs 186）同样替换', () => {
    const result = applyNumericConsistencyDeterministicFixes('高峰，投入62人。', { laborPeakAuthority: 186 });
    expect(result.markdown).toBe('高峰，投入186人。');
  });
  it('K1 管理口径不替换（laborGroupOf 隔离）', () => {
    const md = '管理人员18人，高峰期286人。';
    const result = applyNumericConsistencyDeterministicFixes(md, { laborPeakAuthority: 186 });
    expect(result.markdown).toContain('管理人员18人');
  });
  it('K1 工种口径不替换', () => {
    const md = '主体结构阶段配置钢筋工60人。';
    const result = applyNumericConsistencyDeterministicFixes(md, { laborPeakAuthority: 186 });
    expect(result.markdown).toBe(md);
  });
  it('K1 阶段限定峰值豁免', () => {
    const md = '主体结构阶段高峰人数200人。';
    const result = applyNumericConsistencyDeterministicFixes(md, { laborPeakAuthority: 186 });
    expect(result.markdown).toBe(md);
  });
  it('K1 表格行内阶段数值不替换', () => {
    const md = '| 施工准备阶段 | 劳动力62人 |';
    const result = applyNumericConsistencyDeterministicFixes(md, { laborPeakAuthority: 186 });
    expect(result.markdown).toBe(md);
  });
  it('K1 控制上限低于表峰值 → 上限改为表峰值', () => {
    const result = applyNumericConsistencyDeterministicFixes('高峰期人数控制在120人以内。', { laborPeakAuthority: 186 });
    expect(result.markdown).toBe('高峰期人数控制在186人以内。');
  });
  it('K1 控制上限不低于表峰值 → 不动', () => {
    const md = '高峰期人数控制在200人以内。';
    const result = applyNumericConsistencyDeterministicFixes(md, { laborPeakAuthority: 186 });
    expect(result.markdown).toBe(md);
  });
  it('K1 无权威无表格 → 不动', () => {
    const md = '高峰期人数68人。';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('K1 无表格时从表格列提取权威（tablePeakLabor）', () => {
    const md = '| 施工阶段 | 高峰人数 |\n| --- | --- |\n| 主体阶段 | 186人 |\n\n正文高峰期总人数68人。';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('正文高峰期总人数186人。');
  });
});

describe('K2 第2步 节点工期（fixNodeScheduleConflicts）体系缩放', () => {
  it('K2 总工期 540 与体系 365 → 全文缩放', () => {
    const result = applyNumericConsistencyDeterministicFixes('开工令下发后第365日完成全部工作。', { scheduleAuthority: 540 });
    expect(result.markdown).toContain('第540日');
  });
  it('K2 体系缩放逐节点比例换算（100/200 → 270/540）', () => {
    // 单节点时 systemMax=自身导致 scale=权威/自身（100→540）；双节点以最大节点为体系终点
    const md = '开工令下发后第100日完成基坑支护，开工令下发后第200日主体结构封顶。';
    const result = applyNumericConsistencyDeterministicFixes(md, { scheduleAuthority: 540 });
    expect(result.markdown).toContain('第270日');
    expect(result.markdown).toContain('第540日');
  });
  it('K2 体系终点 ≥ 权威×0.9 → 不缩放', () => {
    const md = '开工令下发后第500日完成全部工作。';
    const result = applyNumericConsistencyDeterministicFixes(md, { scheduleAuthority: 540 });
    expect(result.markdown).toBe(md);
  });
  it('K2 竣工验收语境裸第N日缩放（正向）', () => {
    // 裸「第N日竣工验收」无开工令锚点 → absoluteDays 空不缩放；前置开工令锚点建立体系
    const md = '开工令下发后第365日完成全部工作。第360日竣工验收。';
    const result = applyNumericConsistencyDeterministicFixes(md, { scheduleAuthority: 540 });
    expect(result.markdown).toContain('第540日完成全部工作');
    expect(result.markdown).toContain('第533日竣工验收');
  });
  it('K2 竣工验收语境括号形态缩放', () => {
    const md = '开工令下发后第365日完成全部工作。全部工程竣工验收合格（第365日）。';
    const result = applyNumericConsistencyDeterministicFixes(md, { scheduleAuthority: 540 });
    expect(result.markdown).toContain('（第540日）');
  });
  it('K2 相对量句「竣工验收合格后第90日」不缩放', () => {
    const md = '竣工验收合格后第90日内完成整改。';
    const result = applyNumericConsistencyDeterministicFixes(md, { scheduleAuthority: 540 });
    expect(result.markdown).toContain('第90日');
  });
  it('K2 无 scheduleAuthority 不缩放', () => {
    const md = '开工令下发后第365日完成全部工作。';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toBe(md);
  });
});

describe('K3 三列进度表链式重算', () => {
  it('K3 缩放后开始/持续列链式自洽', () => {
    const md = '| 基础施工 | 开工令下发后第10日 | 开工令下发后第15日 | 6日 |\n| 主体施工 | 开工令下发后第20日 | 开工令下发后第30日 | 11日 |';
    const result = applyNumericConsistencyDeterministicFixes(md, { scheduleAuthority: 540 });
    // systemMax=30 → scale=18 → 10/15/20/30 → 180/270/360/540；链式重算：开始=上行结束+1、持续=结束-开始+1
    expect(result.markdown).toContain('开工令下发后第180日 | 开工令下发后第270日 | 91日');
    expect(result.markdown).toContain('开工令下发后第271日 | 开工令下发后第540日 | 270日');
  });
});

describe('K4 权威表提取与多表对齐', () => {
  const authorityTable = '### 施工总进度计划表\n\n| 关键节点 | 完成时间 |\n| --- | --- |\n| 主体结构封顶 | 开工令下发后第230日 |\n| 竣工验收 | 开工令下发后第365日 |';
  it('K4 非权威表行 ≥5 天差 → 替换为权威值', () => {
    const md = `${authorityTable}\n\n### 关键节点表\n\n| 节点 | 时间 |\n| --- | --- |\n| 主体结构封顶 | 第300日 |`;
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('主体结构封顶 | 第230日');
  });
  it('K4 差 4 天（<5 门）不动', () => {
    const md = `${authorityTable}\n\n### 关键节点表\n\n| 节点 | 时间 |\n| --- | --- |\n| 主体结构封顶 | 第234日 |`;
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('主体结构封顶 | 第234日');
  });
  it('K4 权威表自身行不动（authoritySpans 内）', () => {
    const result = applyNumericConsistencyDeterministicFixes(authorityTable);
    expect(result.markdown).toBe(authorityTable);
  });
  it('K4 权威表标题谱系全命中', () => {
    const headers = ['总进度计划', '施工总进度', '总进度安排', '总工期控制', '总工期'];
    for (const header of headers) {
      const md = `### ${header}表\n\n| 节点 | 时间 |\n| --- | --- |\n| 主体结构封顶 | 开工令下发后第230日 |\n\n### 其他表\n\n| 节点 | 时间 |\n| --- | --- |\n| 主体结构封顶 | 第300日 |`;
      const result = applyNumericConsistencyDeterministicFixes(md);
      expect(result.markdown).toContain('主体结构封顶 | 第230日');
    }
  });
});

describe('K5 正文三形态定点替换', () => {
  const doc = '### 施工总进度计划表\n\n| 节点 | 时间 |\n| --- | --- |\n| 主体结构封顶 | 开工令下发后第230日 |\n| 竣工验收 | 开工令下发后第365日 |';
  it('K5 形态A 正序完成式「第N日完成X」', () => {
    const md = `${doc}\n\n第300日完成主体结构封顶。`;
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('第230日完成主体结构封顶。');
  });
  it('K5 形态C 倒序锁定式「封顶节点第N日」', () => {
    const md = `${doc}\n\n主体结构封顶节点第300日为刚性控制点。`;
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('第230日');
  });
  it('K5 形态D 竣工验收倒序式', () => {
    const md = `${doc}\n\n竣工验收节点第400日。`;
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('第365日');
  });
  it('K5 相对量句「主体结构封顶后第10日」不动', () => {
    const md = `${doc}\n\n主体结构封顶后第10日完成砌体。`;
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('封顶后第10日');
  });
});

describe('K6 nodeAuthorities 注入覆盖', () => {
  it('K6 生成前锁定口径与文档权威冲突 ≥5 天 → 主表值覆盖并清空权威表 span', () => {
    const md = '### 施工总进度计划表\n\n| 节点 | 时间 |\n| --- | --- |\n| 主体结构封顶 | 开工令下发后第230日 |';
    const result = applyNumericConsistencyDeterministicFixes(md, { nodeAuthorities: [{ node: '主体结构封顶', offset: '第300日' }] });
    expect(result.markdown).toContain('主体结构封顶 | 开工令下发后第300日');
  });
  it('K6 注入与文档权威一致 → 不动', () => {
    const md = '### 施工总进度计划表\n\n| 节点 | 时间 |\n| --- | --- |\n| 主体结构封顶 | 开工令下发后第230日 |';
    const result = applyNumericConsistencyDeterministicFixes(md, { nodeAuthorities: [{ node: '主体结构封顶', offset: '第231日' }] });
    expect(result.markdown).toBe(md);
  });
  it('K6 节点名不匹配锚点表 → 忽略', () => {
    const md = '### 施工总进度计划表\n\n| 节点 | 时间 |\n| --- | --- |\n| 主体结构封顶 | 开工令下发后第230日 |';
    const result = applyNumericConsistencyDeterministicFixes(md, { nodeAuthorities: [{ node: '未知节点名', offset: '第300日' }] });
    expect(result.markdown).toBe(md);
  });
  it('K6 偏移值超界（>3000）忽略', () => {
    const md = '### 施工总进度计划表\n\n| 节点 | 时间 |\n| --- | --- |\n| 主体结构封顶 | 开工令下发后第230日 |';
    const result = applyNumericConsistencyDeterministicFixes(md, { nodeAuthorities: [{ node: '主体结构封顶', offset: '第9999日' }] });
    expect(result.markdown).toBe(md);
  });
});

describe('K7 第3步 材料/设备数量（fixCrossSectionNumericConflicts）外部权威', () => {
  it('K7 计划总工期外部锁定（45→210）', () => {
    const result = applyNumericConsistencyDeterministicFixes('计划工期45日历天。', { scheduleAuthority: 210 });
    expect(result.markdown).toBe('计划工期210日历天。');
  });
  it('K7 装配率外部锁定（38.4%→30%）', () => {
    const result = applyNumericConsistencyDeterministicFixes('本工程装配率38.4%。', { assemblyRateAuthority: 30 });
    expect(result.markdown).toContain('装配率30%');
  });
  it('K7 自然村数量锁定（9→20）', () => {
    const result = applyNumericConsistencyDeterministicFixes('本项目覆盖9个自然村。', { villageCountAuthority: 20 });
    expect(result.markdown).toContain('20个自然村');
  });
  it('K7 机动工期锁定（10→25）', () => {
    const result = applyNumericConsistencyDeterministicFixes('机动工期预留10天。', { slackDaysAuthority: 25 });
    expect(result.markdown).toContain('预留25天');
  });
  it('K7 设备台数锁定（塔吊2→1）', () => {
    const result = applyNumericConsistencyDeterministicFixes('现场配置塔吊2台。', { machineAuthorities: { towerCrane: 1 } });
    expect(result.markdown).toBe('现场配置塔吊1台。');
  });
  it('K7 标号外部锁定（垫层C15→C20）', () => {
    const result = applyNumericConsistencyDeterministicFixes('垫层采用C15混凝土。', { codeAuthorities: { cushion: 'C20' } });
    expect(result.markdown).toContain('垫层采用C20');
  });
  it('K7 无外部权威且无表格 → 不动', () => {
    const md = '计划工期45日历天。';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toBe(md);
  });
});

describe('K8 表格唯一值/设备兜底/众数兜底', () => {
  it('K8 表格唯一值作权威（灭火器 2→12）', () => {
    const md = '| 灭火器 | 12具 |\n\n正文配置灭火器2具。';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('灭火器12具。');
  });
  it('K8 差异 ≤20% 不动（10 vs 12）', () => {
    const md = '| 灭火器 | 12具 |\n\n正文配置灭火器10具。';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('灭火器10具。');
  });
  it('K8 塔吊多表冲突 → 设备兜底取保守台数', () => {
    const md = '| 塔吊 | 2台 |\n| 塔吊 | 1台 |';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('塔吊 | 1台');
  });
  it('K8 灭火器多表互斥 → 众数兜底（2具→12具）', () => {
    const md = '| 灭火器 | 12具 |\n| 灭火器 | 12具 |\n| 灭火器 | 2具 |';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown.match(/\| 灭火器 \| 12具 \|/gu)?.length).toBe(3);
    expect(result.markdown).not.toContain('| 2具 |');
  });
  it('K8 分部位表格行不参与众数归一', () => {
    const md = '| 灭火器 | 12具 | 材料库 |\n| 灭火器 | 2具 | 配电箱旁 |';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('2具');
  });
});

describe('K9 部位组/否定声明/枚举豁免', () => {
  it('K9 部位组正文值不参与差异判定', () => {
    const md = '| 灭火器 | 12具 |\n\n办公区配置灭火器4具。';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('灭火器4具。');
  });
  it('K9 否定声明句数值不替换', () => {
    const md = '| 灭火器 | 12具 |\n\n现场统一配置灭火器12具，不再出现灭火器2具等矛盾表述。';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('不再出现灭火器2具');
  });
  it('K9 枚举形态（4具/2具）实际行为锁定（F15 意图缺口）', () => {
    // F15 注释意图「分区灭火器 4具/2具 不参与」与实现有缺口：LOCATION_WORD_SOURCE 不含「分区」，
    // ENUMERATION_VALUE_RE 只查 match[0] 前 40 字（'灭火器 4具'），后置 '/2具' 永不豁免 → 4→12 被替换。
    // 锁定真实行为，待 t5-combo 缺陷回归谱系阶段评估是否修实现
    const md = '| 灭火器 | 12具 |\n\n分区配置灭火器 4具/2具。';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toContain('12具/2具');
  });
});

describe('K10 第4步 支护体系（fixSupportSystemConflicts）管线集成', () => {
  it('K10 slope 权威 → 纯桩句删除', () => {
    const result = applyNumericConsistencyDeterministicFixes('基坑采用钻孔灌注桩支护。', { supportAuthority: 'slope' });
    expect(result.fixedCount).toBeGreaterThan(0);
  });
  it('K10 无 authority → 不动', () => {
    const md = '基坑采用钻孔灌注桩支护。';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toBe(md);
  });
});

describe('K11 第5步 清单工程量与管线聚合', () => {
  it('K11 quantityAuthorities 管线内生效', () => {
    const result = applyNumericConsistencyDeterministicFixes('级配碎石18949.52m³。', { quantityAuthorities: [{ name: '级配碎石', value: 20931.02, unit: 'm³' }] });
    expect(result.markdown).toBe('级配碎石20931.02m³。');
  });
  it('K11 五步管线顺序执行互不重叠（峰值+设备+清单同文）', () => {
    const md = '高峰期总人数68人。现场配置塔吊2台。级配碎石18949.52m³。';
    const result = applyNumericConsistencyDeterministicFixes(md, {
      laborPeakAuthority: 186,
      machineAuthorities: { towerCrane: 1 },
      quantityAuthorities: [{ name: '级配碎石', value: 20931.02, unit: 'm³' }],
    });
    expect(result.markdown).toBe('高峰期总人数186人。现场配置塔吊1台。级配碎石20931.02m³。');
    expect(result.fixedCount).toBe(3);
  });
  it('K11 details 上限 12 条', () => {
    const md = '高峰期总人数68人。现场配置塔吊2台。计划工期45日历天。机动工期预留10天。级配碎石18949.52m³。';
    const result = applyNumericConsistencyDeterministicFixes(md, {
      laborPeakAuthority: 186,
      machineAuthorities: { towerCrane: 1 },
      scheduleAuthority: 210,
      slackDaysAuthority: 25,
      quantityAuthorities: [{ name: '级配碎石', value: 20931.02, unit: 'm³' }],
    });
    expect(result.details.length).toBeLessThanOrEqual(12);
  });
  it('K11 无任何 options → 不动（fixedCount 0/details 空）', () => {
    const md = '高峰期总人数68人。';
    const result = applyNumericConsistencyDeterministicFixes(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
    expect(result.details).toEqual([]);
  });
  it('K11 零值权威忽略（scheduleAuthority 0 不进权威）', () => {
    const md = '计划工期45日历天。';
    const result = applyNumericConsistencyDeterministicFixes(md, { scheduleAuthority: 0 });
    expect(result.markdown).toBe(md);
  });
});

// ── L. crossChapterSemanticDuplicateIssues + stripCrossChapterSemanticDuplicateParagraphs ──

/** 章工厂：补齐 DocumentDraftChapter 必填字段（evidence/missingFacts 不参与本检测） */
const chapterOf = (id: string, title: string, content: string): DocumentDraftChapter => ({ id, title, content, evidence: [], missingFacts: [] });

/** 60 字门槛以上字段落（CROSS_CHAPTER_SEMANTIC_DUP_MIN_CHARS=60）：
 * P1（65 字）与 P2（62 字）共享数字指纹 {30,200,14,7}，密度 P1=12/65 < P2=12/62 → 密度低者 P1 被报/删 */
const L_P1 = '本工程混凝土强度等级为C30，浇筑厚度为200mm，养护周期为14天，防水等级为二级，抗震设防烈度为7度，结构类型为框架结构体系。';
const L_P2 = '结构层混凝土采用C30强度等级，浇筑厚度200mm，养护周期14天，防水等级为二级，抗震设防烈度为7度，结构形式为框架结构。';
/** P3 为 P1 去「本工程」前缀（62 字），与 P1/P2 均共享指纹 → 三章两对 */
const L_P3 = '混凝土强度等级为C30，浇筑厚度为200mm，养护周期为14天，防水等级为二级，抗震设防烈度为7度，结构类型为框架结构体系。';
/** 迭代收敛三段（均 60+ 字）：A∩B 第 1 轮命中（共享 30/200）删 B；A∩C 第 2 轮特殊条件命中删 C */
const L_IA = '本工程主体结构混凝土强度30浇筑200，层高3.6米，柱距8.4米，基础埋深2.5米，外墙采用保温装饰一体板，屋面设置两道防水层，地下室侧墙设置卷材防水并砌筑保护墙。';
const L_IB = '本工程混凝土强度等级C30，浇筑厚度200mm，施工工艺参数按统一基准执行，各分项施工方案均以此为准组织现场施工并验收。';
const L_IC = '现场浇筑200养护14天，防水等级二级，抗震设防烈度为7度，结构采用框架结构体系，屋面防水等级为二级，建筑耐火等级为二级。';

describe('L1 crossChapterSemanticDuplicateIssues 语义重复检测', () => {
  it('L1 两章段落共享数字指纹（相似度 0.9）→ 报', async () => {
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', L_P1),
      chapterOf('ch2', '第二章 施工部署', L_P2),
    ];
    const issues = await crossChapterSemanticDuplicateIssues(chapters);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('blocker');
    // 报密度低者（P1 65 字密度 0.1846 < P2 62 字密度 0.1935）
    expect(issues[0].chapterId).toBe('ch1');
    expect(issues[0].message).toContain('第二章 施工部署');
    expect(issues[0].message).toContain('0.90');
  });
  it('L1 数字指纹不共享 → 不报', async () => {
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', '本工程混凝土强度等级C30，浇筑厚度200mm。'),
      chapterOf('ch2', '第二章 施工部署', '现场配置挖掘机3台，管理人员5名。'),
    ];
    expect(await crossChapterSemanticDuplicateIssues(chapters)).toEqual([]);
  });
  it('L1 同章两段重复 → 不报（仅跨章判定）', async () => {
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', '本工程混凝土强度等级C30，浇筑厚度200mm。\n\n本工程混凝土采用C30强度，浇筑200mm厚度。'),
    ];
    expect(await crossChapterSemanticDuplicateIssues(chapters)).toEqual([]);
  });
  it('L1 逐字相等对 → 不双报', async () => {
    const text = '本工程混凝土强度等级C30，浇筑厚度200mm。';
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', text),
      chapterOf('ch2', '第二章 施工部署', text),
    ];
    expect(await crossChapterSemanticDuplicateIssues(chapters)).toEqual([]);
  });
  it('L1 段落 <60 字不入池 → 不报', async () => {
    const short = '混凝土C30。';
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', short),
      chapterOf('ch2', '第二章 施工部署', short),
    ];
    expect(await crossChapterSemanticDuplicateIssues(chapters)).toEqual([]);
  });
  it('L1 标题/表格/列表块不入池', async () => {
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', '## 施工部署\n\n本工程混凝土强度等级C30，浇筑厚度200mm。'),
      chapterOf('ch2', '第二章 施工部署', '| 项目 | 内容 |\n| --- | --- |\n| 混凝土 | C30 |\n\n- 本工程混凝土采用C30强度，浇筑200mm厚度。'),
    ];
    expect(await crossChapterSemanticDuplicateIssues(chapters)).toEqual([]);
  });
  it('L1 三章两对命中 → 报两条（drop 密度低者）', async () => {
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', L_P1),
      chapterOf('ch2', '第二章 施工部署', L_P2),
      chapterOf('ch3', '第三章 施工方案', L_P3),
    ];
    const issues = await crossChapterSemanticDuplicateIssues(chapters);
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
  it('L1 单章无段落 → 不报', async () => {
    expect(await crossChapterSemanticDuplicateIssues([])).toEqual([]);
  });
  it('L1 DOCUMENT_CROSS_CHAPTER_DEDUP=0 回退', async () => {
    const previous = process.env.DOCUMENT_CROSS_CHAPTER_DEDUP;
    process.env.DOCUMENT_CROSS_CHAPTER_DEDUP = '0';
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', '本工程混凝土强度等级C30，浇筑厚度200mm。'),
      chapterOf('ch2', '第二章 施工部署', '结构层混凝土采用C30强度等级，浇筑200mm厚度控制。'),
    ];
    const issues = await crossChapterSemanticDuplicateIssues(chapters);
    process.env.DOCUMENT_CROSS_CHAPTER_DEDUP = previous;
    expect(issues).toEqual([]);
  });
});

describe('L2 stripCrossChapterSemanticDuplicateParagraphs 跨章重复删除', () => {
  it('L2 单对重复 → 删除低密度段', async () => {
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', L_P1),
      chapterOf('ch2', '第二章 施工部署', L_P2),
    ];
    const removed = await stripCrossChapterSemanticDuplicateParagraphs(chapters);
    expect(removed).toBe(1);
    expect(chapters[0].content).toBe('');
  });
  it('L2 密度高者保留（低密度章段被删）', async () => {
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', L_P2), // 高密度 12/62=0.1935
      chapterOf('ch2', '第二章 施工部署', L_P1), // 低密度 12/65=0.1846
    ];
    const removed = await stripCrossChapterSemanticDuplicateParagraphs(chapters);
    expect(removed).toBe(1);
    expect(chapters[0].content).toContain('结构层混凝土采用C30');
    expect(chapters[1].content).toBe('');
  });
  it('L2 迭代收敛（首轮删除后新段落对命中）', async () => {
    let call = 0;
    vi.mocked(buildSemanticSimilarity).mockImplementation(async () => {
      call += 1;
      return (left: string, right: string): number => {
        const specialPair = (a: string, b: string) =>
          (a.includes('强度30浇筑200') && b.includes('浇筑200养护14')) || (b.includes('强度30浇筑200') && a.includes('浇筑200养护14'));
        if (call >= 2 && specialPair(left, right)) return 0.9;
        if (left === right) return 1;
        const leftNums = new Set(left.match(/\d+/gu) || []);
        const rightNums = new Set(right.match(/\d+/gu) || []);
        return [...leftNums].filter(num => rightNums.has(num)).length >= 2 ? 0.9 : 0.1;
      };
    });
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', L_IA),
      chapterOf('ch2', '第二章 施工部署', L_IB),
      chapterOf('ch3', '第三章 施工方案', L_IC),
    ];
    const removed = await stripCrossChapterSemanticDuplicateParagraphs(chapters);
    expect(removed).toBe(2);
    vi.mocked(buildSemanticSimilarity).mockImplementation(CHAPTER_SIM);
  });
  it('L2 删除后幂等（二次 strip 0）', async () => {
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', L_P1),
      chapterOf('ch2', '第二章 施工部署', L_P2),
    ];
    const first = await stripCrossChapterSemanticDuplicateParagraphs(chapters);
    expect(first).toBe(1);
    const second = await stripCrossChapterSemanticDuplicateParagraphs(chapters);
    expect(second).toBe(0);
  });
  it('L2 无重复 → 0', async () => {
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', '本工程混凝土强度等级C30，浇筑厚度200mm。'),
      chapterOf('ch2', '第二章 施工部署', '现场配置挖掘机3台，管理人员5名。'),
    ];
    expect(await stripCrossChapterSemanticDuplicateParagraphs(chapters)).toBe(0);
  });
  it('L2 同章不删、标题块不删', async () => {
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', '## 混凝土工程\n\n本工程混凝土强度等级C30，浇筑厚度200mm。\n\n## 钢筋工程\n\n本工程混凝土采用C30强度，浇筑200mm厚度。'),
    ];
    expect(await stripCrossChapterSemanticDuplicateParagraphs(chapters)).toBe(0);
  });
  it('L2 空内容章不崩', async () => {
    const chapters = [
      chapterOf('ch1', '第一章 工程概况', ''),
      chapterOf('ch2', '第二章 施工部署', ''),
    ];
    expect(await stripCrossChapterSemanticDuplicateParagraphs(chapters)).toBe(0);
  });
});
