import { describe, expect, it } from 'vitest';
import type { CanonicalFactModel, CanonicalFact } from '@/services/document-workflow/types';
import { alignPlanDataToMaster, buildPlanDataMaster, renderBasicFactsForMaster, renderPlanDataMaster, type PlanDataMaster } from '@/services/document-workflow/planDataMaster';

function canonicalFactOf(overrides: Partial<CanonicalFact> = {}): CanonicalFact {
  return {
    key: 'project_scale',
    label: '建设规模',
    value: '总建筑面积 12.6 万平方米',
    normalizedValue: '总建筑面积12.6万平方米',
    sourceType: 'tender',
    sourceFile: '招标文件.pdf',
    confidence: 0.9,
    priority: 10,
    locked: true,
    ...overrides,
  };
}

function canonicalOf(facts: CanonicalFact[]): CanonicalFactModel {
  const byKey: Record<string, CanonicalFact> = {};
  for (const fact of facts) byKey[fact.key] = fact;
  return {
    projectIdentity: {}, projectScope: {}, schedule: {}, quality: {}, safety: {},
    resources: {}, environment: {}, constraints: {}, byKey,
    conflicts: [], gaps: [], scopeConflicts: [],
  };
}

function masterOf(overrides: Partial<PlanDataMaster> = {}): PlanDataMaster {
  return {
    laborPeak: { count: 350, phase: '主体施工阶段' },
    laborByPhase: [{ phase: '基础施工阶段', count: 180 }, { phase: '主体施工阶段', count: 350 }],
    machines: [
      { name: '塔吊', spec: 'QTZ80', count: 3 },
      { name: '汽车吊', spec: '25t', count: 2 },
    ],
    materialBatches: [{ name: '钢材', batchDesc: '分 3 批进场' }],
    inspectionBatches: [{ scope: '主体结构', planDesc: '按楼层每层一个检验批' }],
    scheduleNodes: [{ node: '桩基工程完成', offset: '开工令下发后第 45 日' }],
    ...overrides,
  };
}

describe('renderBasicFactsForMaster', () => {
  it('按 priority 降序渲染 canonical 事实为紧凑文本', () => {
    const canonical = canonicalOf([
      canonicalFactOf({ key: 'a', label: '低优先', value: '低', priority: 1 }),
      canonicalFactOf({ key: 'b', label: '高优先', value: '高', priority: 50 }),
    ]);
    const text = renderBasicFactsForMaster(canonical);
    expect(text).toContain('- 高优先：高');
    expect(text).toContain('- 低优先：低');
    expect(text.indexOf('高优先')).toBeLessThan(text.indexOf('低优先'));
  });

  it('空 canonical 返回空串', () => {
    expect(renderBasicFactsForMaster(canonicalOf([]))).toBe('');
  });
});

describe('renderPlanDataMaster', () => {
  it('渲染六类槽位与唯一数据源声明', () => {
    const text = renderPlanDataMaster(masterOf());
    expect(text).toContain('计划数据主表');
    expect(text).toContain('劳动力峰值：高峰期总人数 350 人（主体施工阶段）');
    expect(text).toContain('分阶段劳动力：基础施工阶段 180 人、主体施工阶段 350 人');
    expect(text).toContain('主要机械：塔吊（QTZ80） 3 台、汽车吊（25t） 2 台');
    expect(text).toContain('材料进场批次：钢材——分 3 批进场');
    expect(text).toContain('检验批划分：主体结构：按楼层每层一个检验批');
    expect(text).toContain('进度节点：桩基工程完成（开工令下发后第 45 日）');
  });

  it('空数组槽位省略对应行', () => {
    const text = renderPlanDataMaster(masterOf({ machines: [], materialBatches: [], inspectionBatches: [], scheduleNodes: [] }));
    expect(text).not.toContain('主要机械');
    expect(text).not.toContain('材料进场批次');
    expect(text).not.toContain('检验批划分');
    expect(text).not.toContain('进度节点');
  });
});

describe('alignPlanDataToMaster', () => {
  it('劳动力峰值锚定词人数不一致时按主表回填（只换数字不动句式）', () => {
    const { markdown, fixed } = alignPlanDataToMaster('本工程高峰期总人数为 320 人，其中钢筋工 60 人。', masterOf());
    expect(markdown).toBe('本工程高峰期总人数为 350 人，其中钢筋工 60 人。');
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toEqual({ anchor: '劳动力峰值', from: '320人', to: '350人' });
  });

  it('劳动力峰值/高峰投入锚定词同样对齐', () => {
    const master = masterOf();
    expect(alignPlanDataToMaster('劳动力峰值控制在 300 人', master).markdown).toBe('劳动力峰值控制在 350 人');
    expect(alignPlanDataToMaster('高峰投入约 300 人', master).markdown).toBe('高峰投入约 350 人');
  });

  it('与主表一致的人数不动且不记录 fixed', () => {
    const { markdown, fixed } = alignPlanDataToMaster('高峰期总人数为 350 人。', masterOf());
    expect(markdown).toBe('高峰期总人数为 350 人。');
    expect(fixed).toHaveLength(0);
  });

  it('机械名后 20 字符内的台数与主表不一致时回填', () => {
    const { markdown, fixed } = alignPlanDataToMaster('塔吊 QTZ80 配置 2 台，覆盖主楼吊装。', masterOf());
    expect(markdown).toBe('塔吊 QTZ80 配置 3 台，覆盖主楼吊装。');
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toEqual({ anchor: '塔吊', from: '2台', to: '3台' });
  });

  it('非槽位锚定的数值不动', () => {
    const { markdown, fixed } = alignPlanDataToMaster('混凝土浇筑 200 立方米，钢筋用量 150 吨，作业人员 80 人。', masterOf());
    expect(markdown).toBe('混凝土浇筑 200 立方米，钢筋用量 150 吨，作业人员 80 人。');
    expect(fixed).toHaveLength(0);
  });

  it('标题行不参与对齐', () => {
    const markdown = '### 劳动力配置\n\n高峰期总人数为 320 人。';
    const result = alignPlanDataToMaster(markdown, masterOf());
    expect(result.markdown).toBe('### 劳动力配置\n\n高峰期总人数为 350 人。');
  });
});

describe('buildPlanDataMaster', () => {
  it('DOCUMENT_PLAN_DATA_MASTER=0 时整体回退（不调用 LLM）', async () => {
    process.env.DOCUMENT_PLAN_DATA_MASTER = '0';
    try {
      expect(await buildPlanDataMaster({ basicFacts: '- 建设规模：x', chapterTitles: ['一'] })).toBeUndefined();
    } finally {
      delete process.env.DOCUMENT_PLAN_DATA_MASTER;
    }
  });

  it('输入为空时直接返回 undefined', async () => {
    expect(await buildPlanDataMaster({ basicFacts: '', chapterTitles: [] })).toBeUndefined();
  });
});
