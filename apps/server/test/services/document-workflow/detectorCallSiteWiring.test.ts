/**
 * 检测器「登记 ⇔ 调用点」一致性检查（4.55.36 §L3-11 关键反复发措施）。
 *
 * 背景：`assertDetectorUsageCoverage` 是运行时检查，只覆盖「本次真的跑到的路径」；
 * 「登记表里有、源码里零 `det()` 调用点」是静态事实，任何一次运行都不会报警，
 * 于是 6 个检测器（truncated-sentence / atlas-reference-phrase / source-enumeration /
 * meta-discourse-declaration / finish-thickness / formula-residue）长期只登记不生效，
 * 用户可见缺陷直接漏进交付物。
 *
 * 本用例以源码树为输入，断言「凡登记必有调用点，凡调用点必先登记」（双向），
 * 让「空头承诺」在 CI 阶段就红，而不是等交付物被人工发现。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUXILIARY_DETECTORS,
  DETECTOR_CALL_SITE_EXEMPTIONS,
  allDetectorIds,
  assertDetectorCallSites,
  detectorCallSiteErrors,
  detectorCallSiteIds,
} from '../../../src/services/document-workflow/detectorFixerRegistry';

const SRC_ROOT = path.resolve(__dirname, '../../../src');

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...collectTsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) files.push(full);
  }
  return files;
}

/** §L3-11 实测零调用点的六个检测器：接线后必须永久保有调用点（回归锁） */
const L3_11_WIRED_IDS = [
  'truncated-sentence',
  'atlas-reference-phrase',
  'source-enumeration',
  'meta-discourse-declaration',
  'finish-thickness',
  'formula-residue',
] as const;

describe('检测器登记-调用点一致性', () => {
  const files = collectTsFiles(SRC_ROOT);
  const sources = files.map(file => readFileSync(file, 'utf8'));

  it('源码树中每个登记检测器都有 det()/detSafe() 调用点（无空头承诺）', () => {
    const declared = allDetectorIds();
    // 防扫描空转：声明表规模与源码文件数须是真实量级，否则「零错误」可能只是因为什么都没扫到
    expect(sources.length).toBeGreaterThan(200);
    expect(declared.length).toBeGreaterThan(140);

    const errors = detectorCallSiteErrors({ declaredIds: declared, sources });
    expect(errors).toEqual([]);
    expect(() => assertDetectorCallSites(sources)).not.toThrow();
  });

  it('§L3-11 六个检测器均在声明表内且均有调用点（回归锁）', () => {
    const declared = new Set(allDetectorIds());
    const called = new Set(detectorCallSiteIds(sources));
    for (const id of L3_11_WIRED_IDS) {
      expect(declared.has(id), `${id} 已从声明表消失`).toBe(true);
      expect(called.has(id), `${id} 无 det() 调用点（哑火回归）`).toBe(true);
    }
  });

  it('豁免表为空：新登记条目不得靠豁免表绕过接线', () => {
    expect([...DETECTOR_CALL_SITE_EXEMPTIONS]).toEqual([]);
  });

  it('AUXILIARY 组（含块级执行器与终检复核检测器）全部有调用点', () => {
    // 此前该组是唯一不受任何静默逃逸检查覆盖的组（assertDetectorUsageCoverage 明确排除 AUXILIARY）
    const called = new Set(detectorCallSiteIds(sources));
    const missing = AUXILIARY_DETECTORS.map(entry => entry.id).filter(id => !called.has(id));
    expect(missing).toEqual([]);
  });

  it('判定器本身：声明无调用点报错 / 调用未登记报错 / 注释里的 det() 不算调用点', () => {
    const declaredIds = ['wired-detector', 'silent-detector'];
    // 正常接线
    expect(detectorCallSiteErrors({ declaredIds, sources: [`...det('wired-detector', () => [])`] }))
      .toEqual([`检测器 silent-detector 已登记但源码中无 det()/detSafe() 调用点（登记即空头承诺：请接线，或从声明表删除，或在 DETECTOR_CALL_SITE_EXEMPTIONS 书面登记其真实消费点）`]);
    // detSafe 形态与 await 形态同样算接线
    expect(detectorCallSiteErrors({ declaredIds: ['silent-detector'], sources: [`await detSafe('silent-detector', async () => [])`] }))
      .toEqual([]);
    // 注释里的接线是文字不是接线：不得算作调用点
    expect(detectorCallSiteErrors({ declaredIds: ['silent-detector'], sources: [`// 已接 det('silent-detector')\nconst x = 1;`] }))
      .toHaveLength(1);
    expect(detectorCallSiteErrors({ declaredIds: ['silent-detector'], sources: [`/* det('silent-detector') */\nconst x = 1;`] }))
      .toHaveLength(1);
    // 调用点未登记：逃逸同样报错
    expect(detectorCallSiteErrors({ declaredIds: [], sources: [`det('ghost-detector', () => [])`] }))
      .toEqual([`det()/detSafe() 调用了未登记的检测器 ghost-detector（调用点必须先登记声明）`]);
    // 豁免仅在书面登记时生效
    expect(detectorCallSiteErrors({ declaredIds: ['silent-detector'], sources: [''], exemptions: ['silent-detector'] }))
      .toEqual([]);
    // 动态 id（变量）无法静态核对：以「无调用点」暴露，属刻意保守
    expect(detectorCallSiteErrors({ declaredIds: ['silent-detector'], sources: [`det(detectorId, () => [])`] }))
      .toHaveLength(1);
  });
});
