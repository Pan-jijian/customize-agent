/**
 * 边界矩阵（P1 第 34 批 · UU 组 · 奖项白名单 + 危大清单一致性）
 * 断言按探测锁定的真实行为推导（probeUU 已删）。
 *  - U1 fabricatedAwardIssues：AWARD_NAME_RE 贪婪前缀吞噬/动词剥离/通用豁免/白名单来源
 *  - U2 dangerousListConsistencyIssues：标题谱系/条目正则/归一化/30 行窗口/集合差
 */
import { describe, expect, it } from 'vitest';
import { dangerousListConsistencyIssues, fabricatedAwardIssues } from '@/services/document-workflow/documentIntegrityChecks';
import type { DocumentFactsModel, TenderRequirementModel } from '@/services/document-workflow/types';

const factOf = (key: string, value: string): any => ({ key, value, sourceFile: 's', roleId: 'r' });
const whitelistModel = (src: 'quality' | 'project' | 'schedule', text: string): DocumentFactsModel =>
  ({ quality: src === 'quality' ? [factOf('创优', text)] : [], project: src === 'project' ? [factOf('创优', text)] : [], schedule: src === 'schedule' ? [factOf('创优', text)] : [] }) as unknown as DocumentFactsModel;

// ── U1. fabricatedAwardIssues 谱系 ──

describe('U1 奖项白名单：动词剥离与通用豁免', () => {
  it('U1 白名单「确保黄山杯」× 正文干净句「确保黄山杯。」→ 0', () => {
    expect(fabricatedAwardIssues('确保黄山杯。', whitelistModel('quality', '确保黄山杯'))).toHaveLength(0);
  });
  it('U1 白名单「确保黄山杯」× 正文带前缀「本项目目标为确保黄山杯」→ 1（贪婪前缀吞噬锁定）', () => {
    expect(fabricatedAwardIssues('本项目目标为确保黄山杯', whitelistModel('quality', '确保黄山杯'))).toHaveLength(1);
  });
  it('U1 正文「确保获得黄山杯。」剥离链命中白名单 → 0', () => {
    expect(fabricatedAwardIssues('确保获得黄山杯。', whitelistModel('quality', '确保黄山杯'))).toHaveLength(0);
  });
  it('U1 正文「争创鲁班奖。」不在白名单 → 1', () => {
    expect(fabricatedAwardIssues('争创鲁班奖。', whitelistModel('quality', '确保黄山杯'))).toHaveLength(1);
  });
  it('U1 白名单空 → 不检测 0 条', () => {
    expect(fabricatedAwardIssues('鲁班奖。', { quality: [], project: [], schedule: [] } as unknown as DocumentFactsModel)).toHaveLength(0);
  });
  it.each(['确保省优工程。', '争创优质工程。', '创建文明工地。', '样板工程。', '标准化示范。', '观摩工地。', '示范工程。', '精品工程。', '结构优质。', '省优工程。', '市优工程。'])('U1 通用目标「%s」→ 0 条豁免', (body) => {
    expect(fabricatedAwardIssues(body, whitelistModel('quality', '确保黄山杯'))).toHaveLength(0);
  });
  it('U1 「工程质量奖励」负向前瞻不匹配 → 0 条', () => {
    expect(fabricatedAwardIssues('工程质量奖励。', whitelistModel('quality', '确保黄山杯'))).toHaveLength(0);
  });
  it('U1 「工程质量奖牌」→ 牌不在负向前瞻 → 1 条', () => {
    expect(fabricatedAwardIssues('工程质量奖牌。', whitelistModel('quality', '确保黄山杯'))).toHaveLength(1);
  });
  it('U1 两处不同伪造奖项 → 1 条（集合去重）', () => {
    const issues = fabricatedAwardIssues('鲁班奖。詹天佑奖。', whitelistModel('quality', '确保黄山杯'));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('鲁班奖');
    expect(issues[0].message).toContain('詹天佑奖');
  });
  it('U1 同一伪造奖项出现多次 → 1 条', () => {
    expect(fabricatedAwardIssues('鲁班奖。鲁班奖。鲁班奖。', whitelistModel('quality', '确保黄山杯'))).toHaveLength(1);
  });
  it('U1 「杯」前仅 1 字（奖杯）→ 不匹配 0 条', () => {
    expect(fabricatedAwardIssues('奖杯。', whitelistModel('quality', '确保黄山杯'))).toHaveLength(0);
  });
  it('U1 奖项名 11 字+杯 → 前缀吞噬仍报 1 条（行为锁定）', () => {
    expect(fabricatedAwardIssues('一二三四五六七八九十几杯。', whitelistModel('quality', '确保黄山杯'))).toHaveLength(1);
  });
});

describe('U1 奖项白名单：来源谱系', () => {
  it('U1 白名单来自 project 卡 → 命中 0', () => {
    expect(fabricatedAwardIssues('确保黄山杯。', whitelistModel('project', '确保黄山杯'))).toHaveLength(0);
  });
  it('U1 白名单来自 schedule 卡 → 命中 0', () => {
    expect(fabricatedAwardIssues('确保黄山杯。', whitelistModel('schedule', '确保黄山杯'))).toHaveLength(0);
  });
  it('U1 白名单 value 为数组对象 → JSON 文本参与匹配', () => {
    const model = { quality: [{ key: '创优', value: ['争创舜耕杯'], sourceFile: 's', roleId: 'r' }], project: [], schedule: [] } as unknown as DocumentFactsModel;
    expect(fabricatedAwardIssues('争创舜耕杯。', model)).toHaveLength(0);
  });
  it('U1 tender awardObjectives 文本入白名单 → 0', () => {
    const tender = { extracted: true, awardObjectives: [{ text: '争创舜耕杯' }], specialQualityStandards: [], awardClauses: [] } as unknown as TenderRequirementModel;
    expect(fabricatedAwardIssues('争创舜耕杯。', { quality: [], project: [], schedule: [] } as unknown as DocumentFactsModel, tender)).toHaveLength(0);
  });
  it('U1 tender specialQualityStandards 入白名单 → 0', () => {
    const tender = { extracted: true, awardObjectives: [], specialQualityStandards: [{ text: '确保鲁班奖' }], awardClauses: [] } as unknown as TenderRequirementModel;
    expect(fabricatedAwardIssues('确保鲁班奖。', { quality: [], project: [], schedule: [] } as unknown as DocumentFactsModel, tender)).toHaveLength(0);
  });
  it('U1 tender awardClauses 入白名单 → 0', () => {
    const tender = { extracted: true, awardObjectives: [], specialQualityStandards: [], awardClauses: [{ text: '争创鲁班奖' }] } as unknown as TenderRequirementModel;
    expect(fabricatedAwardIssues('争创鲁班奖。', { quality: [], project: [], schedule: [] } as unknown as DocumentFactsModel, tender)).toHaveLength(0);
  });
  it('U1 tender extracted=false → 白名单空不检测 0', () => {
    const tender = { extracted: false, awardObjectives: [{ text: '争创舜耕杯' }], specialQualityStandards: [], awardClauses: [] } as unknown as TenderRequirementModel;
    expect(fabricatedAwardIssues('争创舜耕杯。', { quality: [], project: [], schedule: [] } as unknown as DocumentFactsModel, tender)).toHaveLength(0);
  });
});

// ── U2. dangerousListConsistencyIssues 谱系 ──

const lists = (a: string[], b: string[]): string => `## 危大工程辨识清单\n${a.join('\n')}\n\n## 危大工程识别表\n${b.join('\n')}`;

describe('U2 危大清单一致性：条目归一化', () => {
  it('U2 完全一致 → 0 条', () => {
    expect(dangerousListConsistencyIssues(lists(['- 深基坑工程', '- 高大模板支撑工程'], ['1. 深基坑工程', '2. 高大模板支撑工程']))).toHaveLength(0);
  });
  it('U2 一处差异 → 1 条', () => {
    expect(dangerousListConsistencyIssues(lists(['- 深基坑工程', '- 高大模板支撑工程'], ['1. 深基坑工程', '2. 脚手架工程']))).toHaveLength(1);
  });
  it('U2 括号标注归一 → 0 条', () => {
    expect(dangerousListConsistencyIssues(lists(['- 1.（开挖深度超5米）深基坑工程', '- 高大模板'], ['- 深基坑工程', '- 高大模板']))).toHaveLength(0);
  });
  it('U2 施工尾缀归一 → 0 条', () => {
    expect(dangerousListConsistencyIssues(lists(['- 土方开挖施工', '- 桩基作业'], ['- 土方开挖', '- 桩基']))).toHaveLength(0);
  });
  it('U2 内部空白归一 → 0 条', () => {
    expect(dangerousListConsistencyIssues(lists(['- 深基坑 工程'], ['- 深基坑工程']))).toHaveLength(0);
  });
  it('U2 编号形态谱系（1./2、/3)/（4）/-/*/•）归一 → 0 条', () => {
    expect(dangerousListConsistencyIssues(lists(
      ['1. 深基坑工程', '2、高大模板', '3) 脚手架工程', '(4) 塔吊工程', '- 吊篮工程', '* 拆除工程', '• 降水工程'],
      ['- 深基坑工程', '- 高大模板', '- 脚手架工程', '- 塔吊工程', '- 吊篮工程', '- 拆除工程', '- 降水工程'],
    ))).toHaveLength(0);
  });
  it('U2 全角①编号不剥离 → 与无编号清单判差异 1 条（行为锁定）', () => {
    expect(dangerousListConsistencyIssues(lists(['- ①深基坑工程', '- 高大模板'], ['- 深基坑工程', '- 高大模板']))).toHaveLength(1);
  });
  it('U2 单清单 → 0 条', () => {
    expect(dangerousListConsistencyIssues('## 危大工程辨识清单\n- 深基坑工程\n- 高大模板')).toHaveLength(0);
  });
  it('U2 第二清单标题非危大类 → 不计 → 0 条', () => {
    expect(dangerousListConsistencyIssues(lists(['- 深基坑工程', '- 高大模板'], ['- 深基坑工程', '- 脚手架工程']).replace('## 危大工程识别表', '## 施工部署'))).toHaveLength(0);
  });
  it('U2 三清单两两差异 → 3 条', () => {
    expect(dangerousListConsistencyIssues('## 危大清单\n- 深基坑工程\n- 高大模板\n\n## 危大识别\n- 深基坑工程\n- 脚手架\n\n## 危大辨识\n- 塔吊工程\n- 吊篮工程')).toHaveLength(3);
  });
  it('U2 差异 message 含两侧独有项', () => {
    const issues = dangerousListConsistencyIssues(lists(['- 深基坑工程', '- 高大模板'], ['- 深基坑工程', '- 脚手架工程']));
    expect(issues[0].message).toContain('高大模板');
    expect(issues[0].message).toContain('脚手架工程');
  });
  it('U2 一侧为另一侧真子集 → 独有项写「无」', () => {
    const issues = dangerousListConsistencyIssues(lists(['- 深基坑工程', '- 高大模板', '- 脚手架'], ['- 深基坑工程', '- 高大模板']));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('脚手架');
    expect(issues[0].message).toContain('无】');
  });
});

describe('U2 危大清单一致性：标题谱系与条目边界', () => {
  it.each(['## 危大工程辨识清单', '### 1.2 危大工程识别', '#### 危大及超危大清单', '### 危大工程清单', '## 2 危大识别'])('U2 标题「%s」识别为清单 → 1 条', (heading) => {
    const body = `${heading}\n- 深基坑工程\n- 高大模板\n\n${heading}\n- 深基坑工程\n- 脚手架工程`;
    expect(dangerousListConsistencyIssues(body)).toHaveLength(1);
  });
  it.each(['# 危大工程清单', '##### 危大工程清单', '## 危大分部工程', '## 危大工程', '## 超危大专项方案'])('U2 标题「%s」不识别 → 0 条', (heading) => {
    const body = `${heading}\n- 深基坑工程\n- 高大模板\n\n${heading}\n- 深基坑工程\n- 脚手架工程`;
    expect(dangerousListConsistencyIssues(body)).toHaveLength(0);
  });
  it('U2 条目遇新标题 break（标题后条目不计入前清单）', () => {
    const body = '## 危大工程辨识清单\n- 深基坑工程\n- 高大模板\n## 其他标题\n- 脚手架工程\n\n## 危大工程识别表\n- 深基坑工程\n- 高大模板';
    expect(dangerousListConsistencyIssues(body)).toHaveLength(0);
  });
  it('U2 条目 40 字收、41 字不收', () => {
    const forty = '深'.repeat(40);
    const fortyOne = '深'.repeat(41);
    const a = dangerousListConsistencyIssues(lists([`- ${forty}`, '- 高大模板'], ['- 高大模板', '- 脚手架']));
    expect(a).toHaveLength(1);
    const b = dangerousListConsistencyIssues(lists([`- ${fortyOne}`, '- 高大模板'], ['- 高大模板', '- 脚手架']));
    expect(b).toHaveLength(0);
  });
  it('U2 条目 2 字收、裸行 1 字不收', () => {
    const a = dangerousListConsistencyIssues(lists(['- 深坑', '- 高大模板'], ['- 高大模板', '- 脚手架']));
    expect(a).toHaveLength(1);
    const b = dangerousListConsistencyIssues(lists(['坑', '- 高大模板'], ['- 高大模板', '- 脚手架']));
    expect(b).toHaveLength(0);
  });
  it('U2 「- 坑」前缀+空格凑 3 字符被解析为条目（归一后「坑」）→ 1 条（行为锁定）', () => {
    expect(dangerousListConsistencyIssues(lists(['- 坑', '- 高大模板'], ['- 高大模板', '- 脚手架']))).toHaveLength(1);
  });
  it('U2 条目 <2 条的清单不计入 → 0 条', () => {
    expect(dangerousListConsistencyIssues('## 危大工程辨识清单\n- 深基坑工程\n\n## 危大工程识别表\n- 深基坑工程')).toHaveLength(0);
  });
  it('U2 条目距标题 29 行窗口：28 行内两条目全收、29 行只收首条', () => {
    const near = dangerousListConsistencyIssues('## 危大工程辨识清单\n' + 'x\n'.repeat(27) + '- 深基坑工程\n- 高大模板\n\n## 危大工程识别表\n- 深基坑工程\n- 脚手架');
    expect(near).toHaveLength(1);
    const far = dangerousListConsistencyIssues('## 危大工程辨识清单\n' + 'x\n'.repeat(28) + '- 深基坑工程\n- 高大模板\n\n## 危大工程识别表\n- 深基坑工程\n- 脚手架');
    expect(far).toHaveLength(0);
  });
  it('U2 条目含句号/分号/竖线 → 不收', () => {
    expect(dangerousListConsistencyIssues(lists(['- 深基坑工程。', '- 高大模板'], ['- 深基坑工程', '- 脚手架']))).toHaveLength(0);
  });
  it('U2 清单内重复条目去重（Set）→ 0 条', () => {
    expect(dangerousListConsistencyIssues(lists(['- 深基坑工程', '- 深基坑工程', '- 高大模板'], ['- 深基坑工程', '- 高大模板']))).toHaveLength(0);
  });
  it('U2 5 清单全差异 → slice(0,3) 截断 3 条', () => {
    const body = ['深基坑', '高大模板', '脚手架', '塔吊', '吊篮'].map((item) => `## 危大清单\n- ${item}工程\n- 其他工程`).join('\n\n');
    expect(dangerousListConsistencyIssues(body)).toHaveLength(3);
  });
});
