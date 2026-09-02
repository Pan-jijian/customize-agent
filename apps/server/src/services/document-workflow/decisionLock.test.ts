import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentEvidence, DocumentFact } from './types';
import { buildDecisionLock, renderDecisionLock } from './decisionLock';

function evidenceOf(content: string, overrides: Partial<DocumentEvidence> = {}): DocumentEvidence {
  return { chapterId: 'ch-1', filePath: '/data/招标文件.txt', score: 0.9, content, ...overrides };
}

function factOf(overrides: Partial<DocumentFact> = {}): DocumentFact {
  return { key: '垂直运输', value: '塔吊', sourceFile: '/data/招标文件.txt', roleId: 'project_basic_fact', confidence: 0.9, ...overrides };
}

afterEach(() => {
  delete process.env.DOCUMENT_DECISION_LOCK;
});

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

  it('env DOCUMENT_DECISION_LOCK=0 整体回退', () => {
    process.env.DOCUMENT_DECISION_LOCK = '0';
    const entries = buildDecisionLock({ facts: [], evidence: [evidenceOf('垂直运输采用塔吊。')] });
    expect(entries).toEqual([]);
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
});
