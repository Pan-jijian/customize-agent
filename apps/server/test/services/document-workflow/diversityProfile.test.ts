/**
 * 文档级多样性画像单测：
 * 1. deriveDiversityProfile——seed 确定性散列 + 同模板历史轮换去重；
 * 2. 画像历史落盘（CUSTOMIZE_AGENT_HOME 隔离目录读写）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIVERSITY_PLANNING_TEMPERATURE, deriveDiversityProfile, loadDiversityHistory, recordDiversityUsage } from '@/services/document-workflow/diversityProfile';

describe('deriveDiversityProfile（seed 派生 + 历史轮换去重）', () => {
  it('同 seed 派生结果确定', () => {
    const first = deriveDiversityProfile('doc-abc-123');
    const second = deriveDiversityProfile('doc-abc-123');
    expect(first.id).toBe(second.id);
    expect(first.perspective).toBe(second.perspective);
    expect(first.style).toBe(second.style);
  });

  it('提示词包含组织主线与命名风格，温度常量 0.85', () => {
    const profile = deriveDiversityProfile('doc-abc-123');
    expect(profile.prompt).toContain('组织主线');
    expect(profile.prompt).toContain('命名风格');
    expect(DIVERSITY_PLANNING_TEMPERATURE).toBe(0.85);
  });

  it('命中起点组合时按历史轮换跳到下一组合', () => {
    const base = deriveDiversityProfile('doc-abc-123');
    const rotated = deriveDiversityProfile('doc-abc-123', [base.id]);
    expect(rotated.id).not.toBe(base.id);
  });

  it('历史覆盖全部 30 组合时回退起点（不死循环）', () => {
    const allIds: string[] = [];
    for (let perspective = 0; perspective < 6; perspective += 1) {
      for (let style = 0; style < 5; style += 1) allIds.push(`${perspective}-${style}`);
    }
    const profile = deriveDiversityProfile('doc-abc-123', allIds);
    expect(allIds).toContain(profile.id);
  });

  it('不同 seed 组合可散开（抽样 12 个 seed 至少 2 种组合）', () => {
    const ids = new Set<string>();
    for (let index = 0; index < 12; index += 1) ids.add(deriveDiversityProfile(`doc-${index}`).id);
    expect(ids.size).toBeGreaterThanOrEqual(2);
  });
});

describe('画像历史落盘（CUSTOMIZE_AGENT_HOME 隔离）', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'diversity-test-'));
  const previousHome = process.env.CUSTOMIZE_AGENT_HOME;

  beforeAll(() => {
    process.env.CUSTOMIZE_AGENT_HOME = tempHome;
  });

  afterAll(() => {
    if (previousHome === undefined) delete process.env.CUSTOMIZE_AGENT_HOME;
    else process.env.CUSTOMIZE_AGENT_HOME = previousHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('记录后读取（新在前，重复记录去重置顶）', () => {
    expect(loadDiversityHistory('tpl-1')).toEqual([]);
    recordDiversityUsage('tpl-1', '2-3');
    recordDiversityUsage('tpl-1', '0-1');
    recordDiversityUsage('tpl-1', '2-3');
    expect(loadDiversityHistory('tpl-1')).toEqual(['2-3', '0-1']);
  });

  it('模板维度隔离', () => {
    recordDiversityUsage('tpl-2', '4-4');
    expect(loadDiversityHistory('tpl-1')).toEqual(['2-3', '0-1']);
    expect(loadDiversityHistory('tpl-2')).toEqual(['4-4']);
  });

  it('历史滚动裁剪（每模板最多 12 条）', () => {
    for (let index = 0; index < 20; index += 1) recordDiversityUsage('tpl-3', `0-${index}`);
    const history = loadDiversityHistory('tpl-3');
    expect(history.length).toBe(12);
    expect(history[0]).toBe('0-19');
  });
});
