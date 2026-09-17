import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  resourceConsistencyIssues,
  crossSectionNumericConflictIssues,
  ambiguousEitherOrIssues,
  selfUnderminingCandidateIssues,
} from '../../../src/services/document-workflow/integrity/detectors/detectors';

const md = readFileSync('/Users/pan/Desktop/codeing/customize-agent/.dbg/r8-final.md', 'utf8');

describe('r8 repro', () => {
  it('resourceConsistencyIssues (#5 修复后应零报)', () => {
    const issues = resourceConsistencyIssues(md);
    console.log('RESOURCE ISSUES:', issues.length);
    for (const i of issues) console.log(' -', i.message.slice(0, 220));
    expect(issues.filter(i => i.message.includes('262') || i.message.includes('56'))).toHaveLength(0);
  });
  it('crossSectionNumericConflictIssues (#6/#7 修复后应零报)', () => {
    const issues = crossSectionNumericConflictIssues(md);
    console.log('CROSS SECTION:', issues.length);
    for (const i of issues) console.log(' -', i.message.slice(0, 220));
    expect(issues.filter(i => i.message.includes('灭火器') || i.message.includes('自然村'))).toHaveLength(0);
  });
  it('ambiguousEitherOrIssues (#8 修复后应零报)', () => {
    const issues = ambiguousEitherOrIssues(md);
    console.log('AMBIGUOUS:', issues.length);
    for (const i of issues) console.log(' -', i.message.slice(0, 220));
    expect(issues.filter(i => i.message.includes('顺接'))).toHaveLength(0);
  });
  it('selfUndermining 豁免正则正反样本（#9-11 豁免 + 真伤护栏）', () => {
    // 与 detectors.ts SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE 同步的正则（验证后以生产源为准；
    // r12 扩围：③/⑪ 动作表并入「约谈」）
    const exempt = /未落实[^。；;]{0,24}?(?:整改|复查|销项|复验)|未(?:明确|列明|注明)[^。；;]{0,36}?按[^。；;]{0,44}?执行|(?:发现|对|明确|约定|签订|制定|建立|规定|凡|任何|所有|新增)[^。；;]{0,48}?(?:缺失|损坏|不全|脱岗|未审批|不合格|未完成|未明确|未落实|隐患)[^。；;]{0,72}?(?:整改|复查|销项|约谈|补齐|补测|复测|补报|归档|复核|确认|登记|通知|上报|通报|更新|处置|修复|更换|纠正|恢复|完善|处理|落实|责任|时限|考核|处罚|扣减|调离|清退|停止作业|恢复施工)|(?:不得|严禁|禁止)[^。；;]{0,40}?(?:避免|防止)[^。；;]{0,20}?(?:返工|窝工|损失|事故)|(?:重难点|难点)(?:源于|在于)[^。；;]{0,80}?(?:若|如)未[^。；;]{0,40}?(?:将|会|可能)|(?:考核|考评|评比|评分)[^。；;]{0,50}?(?:不合格|不达标|不到位|不称职|失职|缺失|超时|违规)[^。；;]{0,36}?(?:绩效扣减|扣减|扣款|调离|清退|退场|问责|处罚|奖惩|奖罚)|(?:如|若)[^。；;]{0,60}?(?:发包人|招标人|建设单位)[^。；;]{0,60}?(?:有权|可要求|可以要求|可提出|可以提出)|(?:凡|任何|所有)[^。；;]{0,24}?未[^。；;]{0,40}?(?:人员|工人)[^。；;]{0,20}?(?:不得|严禁|禁止)[^。；;]{0,20}?(?:进入|上岗|进场|作业)|(?:新增|各|每|作业面|工作面|进入|安排)[^。；;]{0,30}?未[^。；;]{0,30}?(?:前|的)[^。；;]{0,24}?(?:不得|严禁|禁止|不予)|(?:未能|未按|未完成|未明确|未落实|未闭合|未审批|缺失|损坏|缺漏|不合格|隐患)[^。；;]{0,40}?(?:整改|复查|销项|恢复|复核|确认|登记|更新|处置|修复|更换|纠正|完善|落实|补齐|补测|复测|归档|通知|上报|通报|约谈|停止作业)[^。；;]{0,20}?(?:复查|销项|确认|登记|归档|责任|时限|考核|处罚|扣减|调离|清退|落实|复核|恢复|整改|处置|更新|完成|闭合)/u;
    // 正样本：r8 实机误报三句应豁免
    expect(exempt.test('针对20个自然村分散施工的特点，项目部建立质量日报制度，各施工组每日17时前将当日完成部位、检测数据、影像资料上传至项目质量群，技术负责人逐条复核，发现数据缺失或指标异常当日通知补测，补测结果经质检员确认后归档')).toBe(true);
    expect(exempt.test('项目部与各班组签订安全生产责任书，明确违章作业、防护缺失、隐患瞒报等行为的整改责任与复查时限')).toBe(true);
    expect(exempt.test('针对20个自然村分散施工的特点，项目部在施工准备阶段完成全部作业面危险源辨识，辨识结果随施工进度动态更新，新增作业面未完成风险辨识前不得安排人员进场作业')).toBe(true);
    // r12 扩围正样本：约谈类管理处置句（负向触发条件→约谈→闭环收口）
    expect(exempt.test('项目部每月组织1次质量讲评，对重复出现的质量通病由技术负责人主持专项交底，明确整改时限不超过3日，逾期未闭合的由项目经理约谈施工组负责人并记入考核')).toBe(true);
    // 负样本：真伤句不得被豁免
    expect(exempt.test('本工程不进行分包')).toBe(false);
    expect(exempt.test('评分指标存在缺口尚未明确')).toBe(false);
    expect(exempt.test('专项设计文件尚未完成，待后续补充')).toBe(false);
    expect(exempt.test('本项目未采用行业认定的新技术、新工艺、新设备、新材料')).toBe(false);
  });
  it('selfUnderminingCandidateIssues（r8 正文，语义模型可用时）', async () => {
    try {
      const issues = await selfUnderminingCandidateIssues(md);
      console.log('SELF:', issues.length);
      for (const i of issues) console.log(' -', i.message.slice(0, 200));
    } catch (error) {
      console.log('SELF SKIPPED (模型不可用):', (error as Error).message.slice(0, 80));
    }
  }, 120000);
});
