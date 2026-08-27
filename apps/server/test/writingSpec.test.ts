import { describe, expect, it } from 'vitest';
import {
  chapterAnchoredRules,
  criticalSectionBlockerMinChars,
  CRITICAL_SECTION_ANCHORS,
  DIVISION_SECTION_QUALITY,
  isCriticalDeepSectionTitle,
  isCriticalSectionTitle,
  sectionAnchoredRules,
} from '../src/services/document-workflow/writingSpec';
import { DEFAULT_WORKFLOW_RULES } from '../src/services/document-workflow/workflowRules';

describe('锚定清单与关键小节判别', () => {
  it('锚定清单含分部分项两条（分部分项错位根治）', () => {
    expect(CRITICAL_SECTION_ANCHORS).toContain('主要分部分项工程施工方案');
    expect(CRITICAL_SECTION_ANCHORS).toContain('主要施工方法');
    expect(CRITICAL_SECTION_ANCHORS).toContain('主要施工内容');
    expect(CRITICAL_SECTION_ANCHORS).toHaveLength(10);
  });

  it('isCriticalSectionTitle 命中锚定关键词', () => {
    expect(isCriticalSectionTitle('主要分部分项工程施工方案')).toBe(true);
    expect(isCriticalSectionTitle('工程质量保证措施')).toBe(false);
  });

  it('锚定清单与 workflowRules 配置同源（收口后不复制副本）', () => {
    expect(CRITICAL_SECTION_ANCHORS).toBe(DEFAULT_WORKFLOW_RULES.writingSpec.criticalSectionAnchors);
  });
});

describe('小节锚定专项规则注入', () => {
  it('主要施工内容小节注入工作包专项规则', () => {
    const rules = sectionAnchoredRules('项目主要施工内容');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('项目主要施工内容专项结构');
    expect(rules[0]).toContain('#### 工作包名称');
  });

  it('分部分项小节注入三段式专项规则', () => {
    const rules = sectionAnchoredRules('主要分部分项工程施工方案');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('主要分部分项工程施工方案专项要求');
    expect(rules[0]).toContain('施工概况');
  });

  it('无命中小节返回空数组（不注入）', () => {
    expect(sectionAnchoredRules('工程概况')).toEqual([]);
    expect(sectionAnchoredRules('质量保证措施')).toEqual([]);
  });

  it('chapterAnchoredRules 按章标题+小节清单整体判别并去重（主题块管线同源注入）', () => {
    const rules = chapterAnchoredRules('施工方案', ['主要分部分项工程施工方案', '主要施工方法', '主要分部分项工程施工方案']);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('主要分部分项工程施工方案专项要求');
  });
});

describe('深度关键小节判别与生成门槛', () => {
  it('isCriticalDeepSectionTitle 判别深度关键小节', () => {
    expect(isCriticalDeepSectionTitle('项目主要施工内容')).toBe(true);
    expect(isCriticalDeepSectionTitle('主要分部分项工程施工方案')).toBe(true);
    expect(isCriticalDeepSectionTitle('工程概况')).toBe(false);
  });

  it('criticalSectionBlockerMinChars 分档门槛与配置同源', () => {
    expect(criticalSectionBlockerMinChars('危大工程专项施工方案审批流程')).toBe(650);
    expect(criticalSectionBlockerMinChars('项目主要施工内容')).toBe(1800);
    expect(criticalSectionBlockerMinChars('主要分部分项工程施工方案')).toBe(1200);
    expect(criticalSectionBlockerMinChars('项目重点难点分析')).toBe(1500);
    expect(criticalSectionBlockerMinChars('工程概况')).toBe(0);
  });
});

describe('分部分项验收阈值单点', () => {
  it('阈值与 workflowRules 配置同源', () => {
    expect(DIVISION_SECTION_QUALITY.blockerMinPackages).toBe(3);
    expect(DIVISION_SECTION_QUALITY.minPackages).toBe(5);
    expect(DIVISION_SECTION_QUALITY.minParamsPerPackage).toBe(4);
    expect(DIVISION_SECTION_QUALITY.minArrowChainLength).toBe(4);
    expect(DIVISION_SECTION_QUALITY.blockerMinPackages).toBe(DEFAULT_WORKFLOW_RULES.writingSpec.divisionQuality.blockerMinPackages);
  });
});
