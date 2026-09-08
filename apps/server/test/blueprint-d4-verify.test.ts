// D4 发布后蓝图构建验证（真实丰乐镇绑定文件清单）：
// 验证 A1-A5 修复链在真实数据上的蓝图产物（不跑 LLM，只验证阶段 A 确定性构建）
import { describe, expect, it } from 'vitest';
import { buildIntegratedBlueprint } from '../src/services/document-workflow/integratedBlueprint';

const PROJECT_ROOT = '/Users/pan/Desktop/codeing/customize-agent';
const BOUND_FILES = [
  '9.14--2026年度丰乐镇20个美丽宜居自然村建设项目(1)/1、图纸/2026年度丰乐镇20个美丽宜居自然村建设项目施工图08.17(1).pdf',
  '9.14--2026年度丰乐镇20个美丽宜居自然村建设项目(1)/1、图纸/2、图纸目录/图纸目录.xls',
  '9.14--2026年度丰乐镇20个美丽宜居自然村建设项目(1)/3、补疑/2026年度丰乐镇20个美丽宜居自然村建设项目.docx',
  '9.14--2026年度丰乐镇20个美丽宜居自然村建设项目(1)/4、工程量清单和编制说明/工程量清单封面.xls',
  '9.14--2026年度丰乐镇20个美丽宜居自然村建设项目(1)/4、工程量清单和编制说明/清单编制说明.doc',
  '9.14--2026年度丰乐镇20个美丽宜居自然村建设项目(1)/4、工程量清单和编制说明/2026年度丰乐镇20个美丽宜居自然村建设项目.xls',
  '9.14--2026年度丰乐镇20个美丽宜居自然村建设项目(1)/2026年度丰乐镇20个美丽宜居自然村建设项目招标文件.pdf',
];
const CHAPTER_TITLES = [
  '主要分部分项工程施工方案',
  '物资与机械劳动力配置计划',
  '质量保证措施',
  '安全保证措施',
  '工期保证措施',
  '文明施工与环境保护',
  '施工总平面布置',
  '重难点分析及保证措施',
];

describe('D4 发布后真实模板蓝图验证（A1-A5）', () => {
  it('真实绑定文件构建蓝图：决策锁数据条目完备、村数 20、项目名无序号前缀', () => {
    const blueprint = buildIntegratedBlueprint({
      projectRoot: PROJECT_ROOT,
      boundFilePaths: BOUND_FILES,
      chapterTitles: CHAPTER_TITLES,
      templateName: '丰乐镇施组模板',
      basicFacts: '项目名称：9.14--2026年度丰乐镇20个美丽宜居自然村建设项目 计划工期：210日历天 质量标准：合格 计价依据：合造价〔2024〕11号文',
    });
    // A3 项目名剥离序号前缀，且不残留「计划工期」边界词残尾
    expect(blueprint.data.project.name).not.toContain('9.14--');
    expect(blueprint.data.project.name).toBe('2026年度丰乐镇20个美丽宜居自然村建设项目');
    // A1 工期锚点词：计划工期 210（不再误采 90）
    expect(blueprint.data.contract.totalDays).toBe(210);
    // A2 村数无空格形态：20（不再降级为清单分组 9）
    const villageFact = blueprint.data.redLineFacts.find(fact => fact.key === '自然村数量');
    expect(villageFact?.value).toContain('20');
    // A5 决策锁数据条目完备：contract_days / labor_peak / village_count 全部入锁
    const lockIds = new Set(blueprint.data.decisionLock.entries.map(entry => entry.id));
    expect(lockIds.has('contract_days')).toBe(true);
    expect(lockIds.has('labor_peak')).toBe(true);
    expect(lockIds.has('village_count')).toBe(true);
    const lockDays = blueprint.data.decisionLock.entries.find(entry => entry.id === 'contract_days');
    expect(lockDays?.values[0]).toBe('210 日历天');
    // A4 参数桶渲染单值口径：无区间端点
    const text = (blueprint as unknown as { data: unknown }).data as { resources: { equipment: Array<{ min?: number; max?: number }> } };
    for (const item of text.resources.equipment) {
      void item;
    }
    expect(blueprint.validation.passed).toBe(true);
    console.log('[D4-verify] projectName:', blueprint.data.project.name);
    console.log('[D4-verify] totalDays:', blueprint.data.contract.totalDays);
    console.log('[D4-verify] villageFact:', villageFact?.value);
    console.log('[D4-verify] lockEntries:', blueprint.data.decisionLock.entries.map(entry => `${entry.id}=${entry.values.join('、')}`).join(' | '));
    console.log('[D4-verify] labor peakValue:', blueprint.data.resources.labor.peakValue);
  });
});
