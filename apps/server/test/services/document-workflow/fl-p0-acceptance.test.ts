import { describe, expect, it } from 'vitest';
import {
  majorConstructionSkeletonNames,
  matchBlockSkeletonNames,
} from '../../../src/services/document-workflow/chapterPostProcessing';
import { buildChapterStructureFromBlueprint } from '../../../src/services/document-workflow/integratedBlueprint';

/**
 * P0 验收实测（丰乐镇真实模板「主要施工方法」章两轮全灭）修复回归：
 * 1. 章级工作包骨架被强加到每个单要点分部块 → 与 coverageList「H3 外壳承担」矛盾 → 章失败
 * 2. 图谱垃圾节点（图签 OCR「工程名称XXX设计阶段施工图」）被提取为工作包名
 * 3. division 章容器块展开骨架名与分部块标题重叠 → 重复成稿 + 写作层清单外必败
 */
describe('P2.7 单要点分部块骨架隔离（P0 验收实测）', () => {
  const chapterLevelPackages = [
    '终端--白水塘、双塘设计阶段施工图',
    '景观工程',
    '污水工程',
    '绿化工程',
  ];

  it('matchBlockSkeletonNames：单要点分部块匹配不到章级工作包 → 骨架不锁（三段式接管）', () => {
    // 「小菜园」分部块 subPoints 仅同名 1 个，章级工作包名不得强加
    expect(matchBlockSkeletonNames(chapterLevelPackages, ['小菜园'])).toEqual([]);
    expect(matchBlockSkeletonNames(chapterLevelPackages, ['门窗工程'])).toEqual([]);
  });

  it('matchBlockSkeletonNames：容器块 subPoints 已骨架展开（同源）→ 全量保留', () => {
    expect(matchBlockSkeletonNames(chapterLevelPackages, chapterLevelPackages)).toEqual(chapterLevelPackages);
  });

  it('matchBlockSkeletonNames：匹配 1-2 个不足 minCount → 视为无骨架可锁', () => {
    // 「景观工程」分部块只匹配到自身 1 个名字，不足 3 个不得锁骨架
    expect(matchBlockSkeletonNames(chapterLevelPackages, ['景观工程'])).toEqual([]);
  });

  it('matchBlockSkeletonNames：归一化包含匹配（工程尾缀差异不误杀）', () => {
    // 仅 1 个匹配不足 minCount → 不锁骨架
    expect(matchBlockSkeletonNames(['门窗安装工程'], ['门窗工程'])).toEqual([]);
    // 容器块 subPoints 已骨架展开（4 个同源）→ 全量保留
    expect(matchBlockSkeletonNames(['门窗安装工程', '玻璃安装工程', '五金件安装工程', '成品保护'], ['门窗安装工程', '玻璃安装工程', '五金件安装工程', '成品保护']))
      .toEqual(['门窗安装工程', '玻璃安装工程', '五金件安装工程', '成品保护']);
    // 与要点无包含关系的名字被过滤
    expect(matchBlockSkeletonNames(['门窗安装工程', '玻璃安装工程', '五金件安装工程'], ['门窗工程', '门窗安装工程', '玻璃安装工程'])).toEqual([]);
  });
});

describe('P2.7 图纸名残片过滤（图签 OCR 垃圾名）', () => {
  it('图签「工程名称XXX设计阶段施工图」不进骨架名池', () => {
    const projectContext = [
      '1. 终端--白水塘、双塘设计阶段施工图｜范围：白水塘、双塘区域施工图设计｜工程量/材料：按证据展开｜流程：按证据展开｜验收：按规范和资料闭环',
      '2. 道路工程｜范围：村内道路硬化｜工程量/材料：混凝土C30约1200m3｜流程：路基处理→浇筑→养护｜验收：强度检测',
      '3. 景观工程｜范围：景观铺装与绿化｜工程量/材料：按证据展开｜流程：按证据展开｜验收：按规范和资料闭环',
    ].join('\n');
    const names = majorConstructionSkeletonNames(projectContext, []);
    expect(names.some(name => /施工图|设计图/u.test(name))).toBe(false);
    // 合法工作包名不受误伤
    expect(names).toContain('道路工程');
    expect(names).toContain('景观工程');
  });

  it('合法骨架名（含「详图」误伤防线词的地名工程）不受误伤', () => {
    const projectContext = '招标范围包括但不限于：道路工程、排水工程、绿化工程、景观工程。';
    const names = majorConstructionSkeletonNames(projectContext, []);
    expect(names).toEqual(expect.arrayContaining(['道路工程', '排水工程', '绿化工程', '景观工程']));
  });
});

describe('P2.7 division 章容器块展开排除分部块标题（P0 验收实测）', () => {
  it('容器块展开的骨架名与已独立成块的分部名重叠 → 排除后不足 3 → 退化为概述块', () => {
    const structure = buildChapterStructureFromBlueprint({
      blueprintChapter: {
        title: '主要施工方法',
        subSections: [
          { title: '道路工程', workPackages: [{ name: '道路工程' }] },
          { title: '景观工程', workPackages: [{ name: '景观工程' }] },
          { title: '绿化工程', workPackages: [{ name: '绿化工程' }] },
        ],
      } as never,
      inputSections: ['道路工程', '景观工程', '绿化工程', '主要分部分项工程施工方案'],
      chapterTitle: '主要施工方法',
      targetWords: 6000,
      projectContext: '项目名称：丰乐镇建设项目。招标范围包括但不限于：道路工程、排水工程、景观工程、绿化工程、污水工程。',
      evidence: [],
    });
    const container = structure.blocks.find(block => block.title === '主要分部分项工程施工方案');
    expect(container).toBeDefined();
    // 排除后骨架名不足 3 → 不展开，保持同名单要点（三段式概述接管）
    expect(container?.subPoints.map(point => point.title)).toEqual(['主要分部分项工程施工方案']);
    // 分部块保持独立成块
    expect(structure.blocks.some(block => block.title === '道路工程')).toBe(true);
    expect(structure.blocks.some(block => block.title === '景观工程')).toBe(true);
    expect(structure.blocks.some(block => block.title === '绿化工程')).toBe(true);
  });
});

describe('4.19.8 division 分部章小块目标动态化（丰乐镇第三轮实测：块质检 1200 目标压垮小分部）', () => {
  const divisionSections = ['楼地面装饰工程', '亮化工程', '外墙保温工程', '屋面防水工程', '门窗安装工程', '栏杆安装工程', '道路工程', '景观绿化工程'];

  it('8 个小分部块（每块 1 要点）→ 块目标按章目标均分（下限 400），不再强制 1200', () => {
    const structure = buildChapterStructureFromBlueprint({
      blueprintChapter: {
        title: '主要施工方法',
        subSections: divisionSections.map(title => ({ title, workPackages: [{ name: title }] })),
      } as never,
      inputSections: divisionSections,
      chapterTitle: '主要施工方法',
      targetWords: 4000,
      projectContext: '项目名称：丰乐镇建设项目。招标范围包括但不限于：楼地面装饰工程、亮化工程。',
      evidence: [],
    });
    const targets = structure.blocks.map(block => block.targetWords);
    // 旧判定（blocks.length > 12）不命中 → 每块下限 1200、达标线 1080，小分部清单事实撑不起 → 重试耗尽章失败
    expect(targets.every(target => target < 1200)).toBe(true);
    // 总目标不随 1200 下限膨胀（旧行为 8×1200=9600 字数雪崩）
    expect(targets.reduce((sum, target) => sum + target, 0)).toBeLessThanOrEqual(5000);
  });
});
