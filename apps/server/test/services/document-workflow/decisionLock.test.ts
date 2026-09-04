import { describe, expect, it } from 'vitest';
import type { DocumentEvidence, DocumentFact } from '@/services/document-workflow/types';
import { buildDecisionLock, renderDecisionLock } from '@/services/document-workflow/decisionLock';

function evidenceOf(content: string, overrides: Partial<DocumentEvidence> = {}): DocumentEvidence {
  return { chapterId: 'ch-1', filePath: '/data/招标文件.txt', score: 0.9, content, ...overrides };
}

function factOf(overrides: Partial<DocumentFact> = {}): DocumentFact {
  return { key: '垂直运输', value: '塔吊', sourceFile: '/data/招标文件.txt', roleId: 'project_basic_fact', confidence: 0.9, ...overrides };
}

describe('buildDecisionLock', () => {
  it('证据支撑的类目被锁定为对应取值', () => {
    const entries = buildDecisionLock({
      facts: [],
      evidence: [evidenceOf('本工程垂直运输采用塔吊配合施工电梯完成材料与人员运输。')],
    });
    const vertical = entries.find(item => item.id === 'vertical_transport');
    expect(vertical?.values).toEqual(expect.arrayContaining(['塔式起重机', '施工升降机']));
  });

  it('否定子句不计分：不采用自拌混凝土不构成自拌证据', () => {
    const entries = buildDecisionLock({
      facts: [],
      evidence: [evidenceOf('本工程不采用自拌混凝土，现场采用商品混凝土供应。')],
    });
    const concrete = entries.find(item => item.id === 'concrete_supply');
    expect(concrete?.values).toEqual(['商品混凝土（预拌）']);
  });

  it('多源冲突按来源权威度裁决：低权威来源单独提及的取值不入选', () => {
    const entries = buildDecisionLock({
      facts: [],
      evidence: [
        evidenceOf('垂直运输采用塔吊。'),
        evidenceOf('也可考虑物料提升机。', { filePath: '/data/施工笔记.txt', roleId: 'note' }),
      ],
    });
    const vertical = entries.find(item => item.id === 'vertical_transport');
    expect(vertical?.values).toEqual(['塔式起重机']);
  });

  it('无证据支撑的类目省略，不产生编造锁定', () => {
    const entries = buildDecisionLock({ facts: [], evidence: [evidenceOf('本工程质量标准为合格。')] });
    expect(entries).toEqual([]);
  });

  it('事实行作为候选来源参与计分（与证据叠加）', () => {
    const entries = buildDecisionLock({
      facts: [factOf({ key: '基坑支护形式', fieldName: '基坑支护形式', value: '土钉墙支护', confidence: 1 })],
      evidence: [evidenceOf('基坑支护详见专项方案，本工程基坑深度 5m。')],
    });
    const support = entries.find(item => item.id === 'foundation_support');
    expect(support?.values).toContain('土钉墙支护');
  });
});

describe('renderDecisionLock', () => {
  it('空表渲染为空串（不注入）', () => {
    expect(renderDecisionLock([])).toBe('');
  });

  it('渲染含锁定指令与类目行', () => {
    const text = renderDecisionLock([{ id: 'concrete_supply', label: '混凝土供应', values: ['商品混凝土（预拌）'] }]);
    expect(text).toContain('项目关键决策锁定');
    expect(text).toContain('混凝土供应：商品混凝土（预拌）');
    expect(text).toContain('不得另写其他方案');
  });

  it('同证据池乱序输入渲染逐字节一致（prefix cache 友好）', () => {
    const a = evidenceOf('垂直运输采用塔吊。', { filePath: '/data/招标文件A.txt' });
    const b = evidenceOf('人员运输采用施工电梯。', { filePath: '/data/招标文件B.txt' });
    const first = renderDecisionLock(buildDecisionLock({ facts: [], evidence: [a, b] }));
    const second = renderDecisionLock(buildDecisionLock({ facts: [], evidence: [b, a] }));
    expect(first).toBe(second);
    expect(first).toContain('垂直运输方式');
  });

  it('互斥类目（基坑支护）多源冲突只锁最高分唯一值（4.17.8 支护打架根治）', () => {
    // 真实生成回归（4.17.7）：放坡喷锚证据 4 处 + 灌注桩排桩证据 1 处并存，旧逻辑多值全锁 →
    // 写作 LLM 各章任选其一，正文放坡喷锚类 4 段 vs 灌注桩排桩类 1 段跨章打架
    const slope1 = evidenceOf('基坑边坡采用放坡开挖，坡率 1:1.0。', { filePath: '/data/招标文件.txt' });
    const slope2 = evidenceOf('基坑放坡开挖。', { filePath: '/data/招标文件.txt' });
    const pile = evidenceOf('基坑支护采用灌注桩排桩支护。', { filePath: '/data/基坑支护设计图纸.dwg' });
    const entries = buildDecisionLock({ facts: [], evidence: [slope1, slope2, pile] });
    const support = entries.find(entry => entry.id === 'foundation_support');
    expect(support).toBeDefined();
    // 图纸权重 80 > 招标文件 90×2 条？——图纸与招标文件权重同为 80/90，得分累加后放坡更高时锁放坡；
    // 无论锁哪个，互斥类目只允许一个值（旧逻辑会出现两个值并存）
    expect(support!.values.length).toBe(1);
    expect(renderDecisionLock(entries)).toContain('基坑支护形式');
  });

  it('非互斥类目（垂直运输）多值共存锁定语义保留', () => {
    const a = evidenceOf('垂直运输采用塔吊。', { filePath: '/data/招标文件.txt' });
    const b = evidenceOf('人员运输采用施工电梯。', { filePath: '/data/招标文件.txt' });
    const entries = buildDecisionLock({ facts: [], evidence: [a, b] });
    const transport = entries.find(entry => entry.id === 'vertical_transport');
    expect(transport).toBeDefined();
    expect(transport!.values.length).toBe(2);
  });
});
