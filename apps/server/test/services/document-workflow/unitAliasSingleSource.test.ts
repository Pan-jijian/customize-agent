/**
 * 4.56 改造 3-b「判据单源化」的反重复校验（**可执行的契约，不是注释里的约定**）。
 *
 * 背景：同一个概念——「米/m/延长米 是同一量纲」——此前被各写一份（`factReconciliation` 两张表 +
 * `numericConflictArbiter` 一张 + `resourceBreakdownNumbers` 一组），外加 3 处手抄量词交替串；
 * 靠注释提醒同步，改一处即静默分裂判定（本仓已多次因此出现「检测说一致、修复说冲突」）。
 *
 * 本测试的作用：**再出现第二份单位别名表就红**——把"单源"从注释变成 CI 可拦住的约束。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNIT_ALIAS_GROUPS, normalizeUnitAlias, unitsAreEquivalent } from '@/services/document-workflow/unitAliases';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 递归收集 .ts 源文件（排除测试） */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [full];
  });
}

/** 自带单位别名映射表的文件（键值对形态；应改为 import normalizeUnitAlias） */
function unitAliasTableOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const relative = path.relative(SRC_DIR, file);
    if (relative === 'unitAliases.ts') continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/['"]平方米['"]\s*:\s*['"]m2['"]/u.test(text) || /['"]立方米['"]\s*:\s*['"]m3['"]/u.test(text)) {
      offenders.push(`${relative}：自带单位别名映射（应 import { normalizeUnitAlias } from './unitAliases'）`);
    }
  }
  return offenders;
}

/** 手抄量词交替串的文件（同一行同时含「平方米」「立方米」与 `|`） */
function handCopiedUnitSourceFiles(): string[] {
  const files: string[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const relative = path.relative(SRC_DIR, file);
    if (relative === 'unitAliases.ts') continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
      if (line.includes('平方米') && line.includes('立方米') && (line.match(/\|/gu) ?? []).length >= 2) {
        files.push(relative);
        break;
      }
    }
  }
  return files;
}

describe('4.56 改造 3-b 单位别名单源', () => {
  it('单位别名归一：同量纲等价、跨量纲不等价', () => {
    const pairs: Array<[string, string, boolean]> = [
      ['米', 'm', true], ['延长米', 'm', true], ['平方米', '㎡', true], ['m²', 'm2', true],
      ['立方米', '方', true], ['吨', 't', true], ['公斤', 'kg', true], ['公里', '千米', true],
      // 计数单位之间**不可互认**（实测「水表 4 组」的 4 实为井室「4 座」；互认会静默放行该错位）
      ['座', '组', false], ['个', '套', false],
      // 跨量纲不可互认
      ['m', 'm2', false], ['t', 'kg', false],
    ];
    for (const [left, right, expected] of pairs) {
      expect(unitsAreEquivalent(left, right), `${left} vs ${right}`).toBe(expected);
    }
    expect(normalizeUnitAlias('平方米')).toBe('m2');
    expect(normalizeUnitAlias('未登记单位')).toBe('未登记单位');
  });

  it('别名组只登记**书写形变体**（同量纲），不含跨量纲或计数单位', () => {
    for (const group of UNIT_ALIAS_GROUPS) {
      const canonical = new Set(group.map(unit => normalizeUnitAlias(unit)));
      expect(canonical.size, `组 ${group.join('/')} 归一后应为同一形`).toBe(1);
    }
    const allUnits = UNIT_ALIAS_GROUPS.flat();
    for (const counting of ['座', '组', '个', '套', '台', '根', '块', '樘', '扇', '片', '件', '孔']) {
      expect(allUnits, `计数单位 ${counting} 不得进别名组`).not.toContain(counting);
    }
  });

  it('**反重复（硬约束）**：除 `unitAliases.ts` 外不得再出现单位别名映射表', () => {
    const offenders = unitAliasTableOffenders();
    expect(offenders, `单位别名必须单源：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('**反重复（减量棘轮）**：手抄量词交替串只许变少，新增即红', () => {
    // 4.56 现状：单位**别名表**已单源（上一条硬约束拦截新增）；但量词**交替串**仍有 10 处手抄副本
    //（各副本单位集与顺序略有差异）。一次性改 8 个文件会改动多个扫描器的匹配行为，风险高于收益，
    // 故本批只做**减量棘轮**：名单只许变短——新增第二份即红，未来逐项收敛时同步删除名单项。
    const current = handCopiedUnitSourceFiles();
    const known = [
      'blockQualityExecutors.ts',
      'chapterPostProcessing.ts',
      'documentFactTrace.ts',
      'factReconciliation.ts',
      'helpers/factCoverage.ts',
      'integrity/detectors/detectors.ts',
      'materialResidue.ts',
      'numericConflictArbiter.ts',
      'outline.ts',
      'resourceBreakdownNumbers.ts',
    ];
    const added = current.filter(file => !known.includes(file));
    expect(added, `新增手抄量词串（应 import { MEASURE_UNIT_SOURCE }）：\n${added.join('\n')}`).toEqual([]);
    // 名单里的项被收敛掉了：同步删除名单项（提示而非失败）
    const resolved = known.filter(file => !current.includes(file));
    if (resolved.length > 0) {
      // 收敛是好事——提示维护者把名单收紧
      console.info(`[3-b] 以下文件已不再手抄量词串，请从棘轮名单移除：${resolved.join('、')}`);
    }
  });
});
