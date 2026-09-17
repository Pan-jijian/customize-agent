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
    // 4.35 容器块归并屏障：4 块超 maxBlocks=3（6000/1800）时相邻分部块归并成块，
    // 容器块独立成组不被归并吸收（保持单要点总述语义——P2.5/P2.7 契约）
    expect(structure.blocks.length).toBeLessThanOrEqual(Math.floor(6000 / 1800));
    // 分部名零丢失：独立成块或被归并块的要点承载（归并不丢点）
    const carried = new Set(structure.blocks.flatMap(block => [block.title, ...block.subPoints.map(point => point.title)]));
    for (const name of ['道路工程', '景观工程', '绿化工程']) expect(carried.has(name)).toBe(true);
  });
});

describe('4.19.8 division 分部章容量规划（丰乐镇第三轮实测：块质检 1200 目标压垮小分部）', () => {
  const divisionSections = ['楼地面装饰工程', '亮化工程', '外墙保温工程', '屋面防水工程', '门窗安装工程', '栏杆安装工程', '道路工程', '景观绿化工程'];

  it('8 个小分部块（每块 1 要点）→ 容量规划归并到章容量内（Σ 块预算精确守恒 4000）', () => {
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
    // 容量规划一次成型：块数 ≤ floor(章目标/1800)（旧行为 8 块各下限 1200 → 9600 字数雪崩）
    expect(structure.blocks.length).toBeLessThanOrEqual(Math.floor(4000 / 1800));
    // Σ块预算 = 章目标精确守恒（4.35 下限保护 + Σ守恒收口，规划层无事后归并/拆半）
    expect(targets.reduce((sum, target) => sum + target, 0)).toBe(4000);
    // 单块预算落在单次输出安全区（0, 4500]
    expect(targets.every(target => target > 0 && target <= 4500)).toBe(true);
  });
});

describe('C2 气候类要点独立成块（4.44 丰乐镇实机两轮：此类要点被写作模型系统性拒写 H4）', () => {
  it('工期章蓝图块内的气候要点提取为独立单点块（原块保留其余要点，要点零丢失）', () => {
    const structure = buildChapterStructureFromBlueprint({
      blueprintChapter: {
        title: '确保工期的技术组织措施',
        subSections: [
          { title: '工期滞后纠偏闭环', workPackages: [{ name: '工期滞后动态纠偏' }, { name: '特殊时段工期应对' }] },
          { title: '总控计划与节点时限', workPackages: [{ name: '进度计划编制' }, { name: '异常气候工期应对' }] },
        ],
      } as never,
      inputSections: ['工期滞后纠偏闭环', '总控计划与节点时限'],
      chapterTitle: '确保工期的技术组织措施',
      targetWords: 8000,
    });
    // 独立单点同名块（块标题=要点标题）：写作层同名过滤 → sectionTitles 空集 → 「缺 H4 要点」判定结构性为空
    const climate = structure.blocks.find(block => block.title === '特殊时段工期应对');
    expect(climate?.subPoints.map(point => point.title)).toEqual(['特殊时段工期应对']);
    // 原块保留其余要点、不再携带气候要点（故障模式消灭）
    const origin = structure.blocks.find(block => block.title === '工期滞后纠偏闭环');
    expect(origin?.subPoints.map(point => point.title)).toEqual(['工期滞后动态纠偏']);
    // 第二处气候要点同样提取
    expect(structure.blocks.some(block => block.title === '异常气候工期应对' && block.subPoints.length === 1)).toBe(true);
    // 要点零丢失（提取块承载 sources 原样）
    const carried = structure.blocks.flatMap(block => block.subPoints.map(point => point.title));
    for (const name of ['工期滞后动态纠偏', '特殊时段工期应对', '进度计划编制', '异常气候工期应对']) expect(carried).toContain(name);
  });

  it('边界：同名点与已有同题块不重复提取（防结构抖动），非气候要点不误伤', () => {
    const structure = buildChapterStructureFromBlueprint({
      blueprintChapter: {
        title: '工期保证措施',
        subSections: [
          { title: '特殊时段工期应对', workPackages: [{ name: '特殊时段工期应对' }] },
          { title: '工期管理', workPackages: [{ name: '特殊时段工期应对' }, { name: '进度考核' }] },
        ],
      } as never,
      inputSections: [],
      chapterTitle: '工期保证措施',
      // 4000（份额 2666≤拆块阈值 2800）：避开既有 §1.5 对半拆块，聚焦 C2 边界
      targetWords: 4000,
    });
    // 同名单点块保持原形态；第二个同名要点因已有同题块不再拆出（无新块、无改写）
    expect(structure.blocks.length).toBe(2);
    expect(structure.blocks.filter(block => block.title === '特殊时段工期应对').length).toBe(1);
    // 「工期管理」块原样保留两个要点（气候要点未被抽走）
    expect(structure.blocks.find(block => block.title === '工期管理')?.subPoints.length).toBe(2);
  });

  it('非气候工期要点不误伤（普通块结构原样）', () => {
    const structure = buildChapterStructureFromBlueprint({
      blueprintChapter: {
        title: '工期计划',
        subSections: [{ title: '工期管理', workPackages: [{ name: '进度考核' }, { name: '工期奖惩制度' }] }],
      } as never,
      inputSections: [],
      chapterTitle: '工期计划',
      // 2500（单块份额 2500≤拆块阈值 2800）：避开容量拆块阈值，与本修复无关
      targetWords: 2500,
    });
    expect(structure.blocks.length).toBe(1);
    expect(structure.blocks[0]?.subPoints.length).toBe(2);
  });

  it('编号前缀要点同样命中（「3、雨季施工措施」不因编号漏判）', () => {
    const structure = buildChapterStructureFromBlueprint({
      blueprintChapter: {
        title: '季节性施工保障',
        subSections: [{ title: '季节性施工组织', workPackages: [{ name: '3、雨季施工措施' }, { name: '组织保障' }] }],
      } as never,
      inputSections: [],
      chapterTitle: '季节性施工保障',
      targetWords: 6000,
    });
    const climate = structure.blocks.find(block => block.title === '3、雨季施工措施');
    expect(climate?.subPoints.map(point => point.title)).toEqual(['3、雨季施工措施']);
  });

  it('容量归并屏障：章块超容量归并时气候单点块保持独立（不被邻块吸收复活 H4 要求），Σ预算守恒', () => {
    const divisions = ['楼地面装饰工程', '门窗安装工程', '栏杆安装工程', '外墙保温工程', '屋面防水工程'];
    const structure = buildChapterStructureFromBlueprint({
      blueprintChapter: {
        title: '工期计划与保证',
        subSections: [
          ...divisions.map(title => ({ title, workPackages: [{ name: title }] })),
          { title: '工期管理', workPackages: [{ name: '进度考核' }, { name: '雨季施工与不利天气应对' }] },
        ],
      } as never,
      inputSections: [],
      chapterTitle: '工期计划与保证',
      targetWords: 4000,
    });
    // 归并后气候块仍以独立单点同名块存在（归并屏障不被吸收）
    const climate = structure.blocks.find(block => block.title === '雨季施工与不利天气应对');
    expect(climate?.subPoints.map(point => point.title)).toEqual(['雨季施工与不利天气应对']);
    // Σ块预算守恒不受屏障影响
    expect(structure.blocks.reduce((sum, block) => sum + block.targetWords, 0)).toBe(4000);
  });
});
