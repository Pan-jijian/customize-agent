/**
 * h13c normalizeProductionText 清洗单测：平方笔误（「28570.36平方2.8」形态）与
 * 「原则上」原则词清洗；前瞻边界验证不破坏「平方公里」类合法词。
 */
import { describe, expect, it } from 'vitest';
import { normalizeProductionText } from './markdownComposer';

describe('normalizeProductionText 平方笔误清洗（h13c）', () => {
  it('「28570.36平方2.8」→ 残留数字一并吸收，仅保留平方米', () => {
    expect(normalizeProductionText('单体建筑面积28570.36平方2.8')).toBe('单体建筑面积28570.36平方米');
  });

  it('「28570.36平方」无残片 → 平方米', () => {
    expect(normalizeProductionText('单体建筑面积28570.36平方，其中地上24783.39平方米。')).toContain('28570.36平方米');
  });

  it('「平方公里」合法词不被破坏', () => {
    expect(normalizeProductionText('项目占地约1.5平方公里。')).toContain('1.5平方公里');
  });
});

describe('normalizeProductionText 原则词清洗（h13c）', () => {
  it('「原则上」被移除', () => {
    expect(normalizeProductionText('模板拆除原则上按先支后拆顺序进行。')).toBe('模板拆除按先支后拆顺序进行。');
  });

  it('无原则词文本原样返回', () => {
    expect(normalizeProductionText('模板拆除按先支后拆顺序进行。')).toBe('模板拆除按先支后拆顺序进行。');
  });
});
