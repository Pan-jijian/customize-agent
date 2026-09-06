import { describe, expect, it } from 'vitest';
import {
  majorConstructionSkeletonNames,
  parseMajorConstructionPackages,
  scopeEngineeringNames,
} from '../../../src/services/document-workflow/chapterPostProcessing';
import type { DocumentEvidence } from '../../../src/services/document-workflow/types';

const evidenceOf = (content: string): DocumentEvidence[] => [
  { filePath: 'a.txt', roleId: 'reference', score: 0.9, content, processingType: 'text' } as unknown as DocumentEvidence,
];

describe('B7 骨架工作包名清洗（丰乐镇第七轮章失败实测）', () => {
  it('招标范围叙述性句子碎片不被提取为工作包名', () => {
    const projectContext = '招标范围：本项目建设范围覆盖20个自然村，重点实施以下配套基础设施工程：一是交通与照明设施，包括村内道路硬化及亮化提升，涵盖雨污水管网铺设，沟渠清淤及村内菜地整治，配套建设公厕、路灯、生态池等工程。';
    const names = scopeEngineeringNames(projectContext, []);
    // 句子碎片不得入池
    expect(names.join('|')).not.toMatch(/重点实施|包括|涵盖|本项目建设/);
    // 合法工程名保留（含白名单词且无谓词）
    expect(names.some(name => /公厕|路灯|生态池|管网|道路/u.test(name))).toBe(true);
  });

  it('图谱行项目级信息行（项目名形态）不进工作包清单', () => {
    const projectContext = [
      '施工工作包结构化数据： 未提供',
      '1. 2026年度丰乐镇20个美丽宜居自然村建设项目｜范围：本项目全部施工内容｜工程量/材料：按证据展开｜流程：按证据展开｜验收：按规范和资料闭环',
      '2. 道路硬化工程｜范围：村内道路C30混凝土硬化｜工程量/材料：混凝土C30约1200m3｜流程：路基处理→模板支设→浇筑→养护｜验收：强度检测',
    ].join('\n');
    const packages = parseMajorConstructionPackages(projectContext, []);
    const names = packages.map(pkg => pkg.name);
    expect(names.some(name => /2026年度/u.test(name))).toBe(false);
    expect(names).toContain('道路硬化工程');
  });

  it('majorConstructionSkeletonNames 三来源统一过滤垃圾名', () => {
    const projectContext = [
      '1. 2026年度丰乐镇20个美丽宜居自然村建设项目｜范围：本项目全部施工内容｜工程量/材料：按证据展开｜流程：按证据展开｜验收：按规范和资料闭环',
      '招标范围：本项目建设范围覆盖20个自然村，重点实施以下配套基础设施工程：包括村内道路硬化及亮化提升，涵盖雨污水管网铺设',
    ].join('\n');
    const names = majorConstructionSkeletonNames(projectContext, []);
    for (const name of names) {
      expect(name).not.toMatch(/^(?:包括|涵盖|重点实施|实施以下|本项目建设)/u);
      expect(name).not.toMatch(/以下|以上|2026年度/u);
    }
  });

  it('合法骨架名不受清洗误伤', () => {
    const projectContext = '招标范围：土方工程、道路工程、排水工程、绿化工程、公厕工程。';
    const names = scopeEngineeringNames(projectContext, []);
    expect(names).toContain('土方工程');
    expect(names).toContain('道路工程');
    expect(names).toContain('公厕工程');
  });
});
