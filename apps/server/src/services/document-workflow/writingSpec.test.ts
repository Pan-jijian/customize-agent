/**
 * writingSpec 单测：写作规范单点——评标必查细目锚定、关键小节判别、专项写法规则查表、
 * 深度门槛（blockerMinChars）与分部分项验收阈值配置。全部值源自 workflowRules 默认配置。
 */
import { describe, expect, it } from 'vitest';
import {
  chapterAnchoredRules, criticalSectionBlockerMinChars, CRITICAL_SECTION_ANCHORS,
  DIVISION_SECTION_QUALITY, isCriticalDeepSectionTitle, isCriticalSectionTitle, sectionAnchoredRules,
} from './writingSpec';

describe('CRITICAL_SECTION_ANCHORS / isCriticalSectionTitle', () => {
  it('评标必查细目锚定清单含关键标题词', () => {
    expect(CRITICAL_SECTION_ANCHORS).toContain('主要施工内容');
    expect(CRITICAL_SECTION_ANCHORS).toContain('危大工程');
    expect(isCriticalSectionTitle('项目主要施工内容')).toBe(true);
    expect(isCriticalSectionTitle('工程概况与编制依据')).toBe(true);
    expect(isCriticalSectionTitle('无关小节')).toBe(false);
  });
});

describe('sectionAnchoredRules', () => {
  it('主要施工内容标题注入专项结构规则', () => {
    const rules = sectionAnchoredRules('项目主要施工内容');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('项目主要施工内容专项结构');
  });

  it('分部分项方案标题注入分项专项规则', () => {
    const rules = sectionAnchoredRules('主要分部分项工程施工方案');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('主要分部分项工程施工方案专项要求');
  });

  it('普通标题无规则', () => {
    expect(sectionAnchoredRules('现场环境管理')).toEqual([]);
  });
});

describe('chapterAnchoredRules', () => {
  it('章标题与小节清单整体判别并去重', () => {
    const rules = chapterAnchoredRules('主要施工方法', ['主要分部分项工程施工方案', '主要施工方法']);
    // 章标题与两条小节都命中 division 规则，去重后仅 1 条
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('专项要求');
  });
});

describe('isCriticalDeepSectionTitle', () => {
  it('深度关键小节命中', () => {
    expect(isCriticalDeepSectionTitle('项目特点、重点与难点分析')).toBe(true);
    expect(isCriticalDeepSectionTitle('项目主要施工内容')).toBe(true);
    expect(isCriticalDeepSectionTitle('主要分部分项工程施工方案')).toBe(true);
    expect(isCriticalDeepSectionTitle('危大工程专项施工方案审批流程')).toBe(true);
    expect(isCriticalDeepSectionTitle('原材料进场复试')).toBe(true);
    expect(isCriticalDeepSectionTitle('普通小节')).toBe(false);
  });
});

describe('criticalSectionBlockerMinChars', () => {
  it('紧急细目 650、主要施工内容 1800、分部分项 1200、重点难点 1500、其他 0', () => {
    expect(criticalSectionBlockerMinChars('危大工程专项施工方案审批流程')).toBe(650);
    expect(criticalSectionBlockerMinChars('见证取样')).toBe(650);
    expect(criticalSectionBlockerMinChars('项目主要施工内容')).toBe(1800);
    expect(criticalSectionBlockerMinChars('主要分部分项工程施工方案')).toBe(1200);
    expect(criticalSectionBlockerMinChars('主要施工方法')).toBe(1200);
    expect(criticalSectionBlockerMinChars('项目特点、重点难点分析')).toBe(1500);
    expect(criticalSectionBlockerMinChars('普通小节')).toBe(0);
  });
});

describe('DIVISION_SECTION_QUALITY', () => {
  it('分部分项验收阈值与 workflowRules 默认配置一致', () => {
    expect(DIVISION_SECTION_QUALITY.blockerMinPackages).toBe(3);
    expect(DIVISION_SECTION_QUALITY.minPackages).toBe(5);
    expect(DIVISION_SECTION_QUALITY.minParamsPerPackage).toBe(4);
    expect(DIVISION_SECTION_QUALITY.minPackageChars).toBe(150);
    expect(DIVISION_SECTION_QUALITY.balanceRatio).toBe(1 / 3);
  });
});
