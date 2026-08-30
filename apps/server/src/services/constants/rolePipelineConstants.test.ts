import { describe, expect, it } from 'vitest';
import type { QualityRepairType } from '../types';
import {
  BLOCKING_CHAPTER_ISSUE_RE,
  QUALITY_REPAIR_INSTRUCTIONS,
  QUALITY_REPAIR_TYPE_RULES,
  REPAIRABLE_QUALITY_ISSUE_RE,
} from './rolePipelineConstants';

describe('BLOCKING_CHAPTER_ISSUE_RE', () => {
  it('命中章节生成后必须阻断的问题', () => {
    expect(BLOCKING_CHAPTER_ISSUE_RE.test('正文缺少章节标题')).toBe(true);
    expect(BLOCKING_CHAPTER_ISSUE_RE.test('空小节')).toBe(true);
    expect(BLOCKING_CHAPTER_ISSUE_RE.test('重复 token')).toBe(true);
    expect(BLOCKING_CHAPTER_ISSUE_RE.test('退化输出')).toBe(true);
  });

  it('不命中可修复类问题', () => {
    expect(BLOCKING_CHAPTER_ISSUE_RE.test('量化参数密度不足')).toBe(false);
  });
});

describe('REPAIRABLE_QUALITY_ISSUE_RE', () => {
  it('命中可局部修复的问题', () => {
    expect(REPAIRABLE_QUALITY_ISSUE_RE.test('正文不足')).toBe(true);
    expect(REPAIRABLE_QUALITY_ISSUE_RE.test('结构化精确参数使用不足')).toBe(true);
    expect(REPAIRABLE_QUALITY_ISSUE_RE.test('事实一致性冲突')).toBe(true);
    expect(REPAIRABLE_QUALITY_ISSUE_RE.test('正式表格不足')).toBe(true);
  });

  it('不命中无关文本', () => {
    expect(REPAIRABLE_QUALITY_ISSUE_RE.test('内容完整')).toBe(false);
  });
});

function repairTypeFor(issue: string) {
  const rule = QUALITY_REPAIR_TYPE_RULES.find(r => r.pattern.test(issue));
  return rule?.type;
}

describe('QUALITY_REPAIR_TYPE_RULES 顺序命中', () => {
  it('结构类优先命中 missing_structure', () => {
    expect(repairTypeFor('二级小节少于要求')).toBe('missing_structure');
  });

  it('闭环类命中 loop_closure', () => {
    expect(repairTypeFor('整改闭环缺失')).toBe('loop_closure');
  });

  it('事实冲突类命中 fact_conflict', () => {
    expect(repairTypeFor('事实一致性冲突')).toBe('fact_conflict');
  });

  it('术语类命中 terminology', () => {
    expect(repairTypeFor('名称不一致')).toBe('terminology');
  });

  it('表格数值类命中 table_numeric', () => {
    expect(repairTypeFor('量化参数密度不足')).toBe('table_numeric');
  });

  it('占位类命中 placeholder', () => {
    expect(repairTypeFor('后台流程话术泄露')).toBe('placeholder');
  });

  it('未命中返回 undefined', () => {
    expect(repairTypeFor('无关描述')).toBeUndefined();
  });
});

describe('QUALITY_REPAIR_INSTRUCTIONS', () => {
  it('覆盖全部修复类型且含关键约束', () => {
    const types = QUALITY_REPAIR_TYPE_RULES.map(r => r.type);
    for (const type of new Set<QualityRepairType>([...types, 'generic'])) {
      expect(QUALITY_REPAIR_INSTRUCTIONS[type]).toBeTruthy();
    }
    expect(QUALITY_REPAIR_INSTRUCTIONS.fact_conflict).toContain('不得引入第三个数值');
    expect(QUALITY_REPAIR_INSTRUCTIONS.table_numeric).toContain('不得编造精确数值');
    expect(QUALITY_REPAIR_INSTRUCTIONS.missing_structure).toContain('不重排一级章节');
  });
});
