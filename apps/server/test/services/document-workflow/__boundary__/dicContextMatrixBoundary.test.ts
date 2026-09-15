/**
 * 边界矩阵（P1 第 31 批 · NN 组 · 语境/谱系矩阵铺开）
 * 每个用例 =（入口, 维度词, 语境）组合，断言按探测锁定的真实行为推导。
 *  - N1 excavationDepthFromFacts × 18 数值格式（≥1且<50 过滤、千分位截尾、科学计数截尾）
 *  - N2 excavationHazardClassificationIssues × 18 格式（深度≥3 → 缺危大标注报 1）
 *  - N3 fixTocFromBody 中文章序数谱系（二十/三十/一百等 → chapterOrdinal undefined → 章被滤除）
 *  - N4 contextTemplates 12 语境模板 × 锚点直连（S5：语境形态零影响，坐标切片替换）
 *  - N5 SPEC_WORDS 6 规格词前缀 → 零豁免照替换（裁决在判定层）
 *  - N6 NEGATION_PREFIXES 8 前缀 → 照替换（锁定）
 *  - N7 括号三态 × 名称形态无关（名称仅作修复说明，不参与匹配）
 *  - N8 LIST_SEPARATORS 4 分隔符 × 锚点照替换
 */
import { describe, expect, it } from 'vitest';
import {
  excavationDepthFromFacts,
  excavationHazardClassificationIssues,
  fixQuantityAuthorityConflicts,
  fixTocFromBody,
} from '@/services/document-workflow/documentIntegrityChecks';
import type { QuantityConflictAnchor } from '@/services/document-workflow/integratedBlueprint';
import { contextTemplates, factOf, factsOf, LIST_SEPARATORS, NEGATION_PREFIXES, SPEC_WORDS } from './boundaryKit';

/** 锚点构造：从名称之后定位原文数值串（生产由判定层裁决产出；值 == 权威不入候选） */
function anchorAfter(markdown: string, name: string, raw: string, authorityValue: number, unit = ''): QuantityConflictAnchor {
  const nameAt = markdown.indexOf(name);
  const start = markdown.indexOf(raw, nameAt >= 0 ? nameAt + name.length : 0);
  return { name, value: Number(raw.replace(/,/gu, '')), unit, authorityValue, start, end: start + raw.length };
}

// 探测锁定的行为表：格式 → excavationDepthFromFacts 提取值（≥1且<50 过滤）
const DEPTH_BEHAVIOR: Array<{ f: string; depth: number | 'undef' }> = [
  { f: '1', depth: 1 },
  { f: '1.0', depth: 1 },
  { f: '1.00', depth: 1 },
  { f: '0.5', depth: 'undef' },
  { f: '0.05', depth: 'undef' },
  { f: '10', depth: 10 },
  { f: '99', depth: 'undef' },
  { f: '999', depth: 'undef' },
  { f: '1000', depth: 'undef' },
  { f: '1,000', depth: 'undef' },
  { f: '10,000', depth: 'undef' },
  { f: '10000.5', depth: 'undef' },
  { f: '1234.567', depth: 'undef' },
  { f: '0001', depth: 1 },
  { f: '010', depth: 10 },
  { f: '1e3', depth: 3 },
  { f: '3.0', depth: 3 },
  { f: '12,345,678', depth: 'undef' },
];

const depthFacts = (f: string) => factsOf({ project: [factOf({ key: '基坑开挖深度', value: `${f}m` })] });

// ── N1. 开挖深度提取：数值格式谱系 ──

describe('N1 开挖深度提取：数值格式谱系', () => {
  it.each(DEPTH_BEHAVIOR)('N1 「基坑开挖深度$f」→ $depth（≥1且<50 过滤）', ({ f, depth }) => {
    if (depth === 'undef') {
      expect(excavationDepthFromFacts(depthFacts(f))).toBeUndefined();
    } else {
      expect(excavationDepthFromFacts(depthFacts(f))).toBe(depth);
    }
  });
  it('N1 千分位截尾锁定：「1,000m」被捕获为 0 → 过滤剔除 → undefined', () => {
    expect(excavationDepthFromFacts(depthFacts('1,000'))).toBeUndefined();
  });
  it('N1 科学计数截尾锁定：「1e3m」被捕获为 3 → 返回 3', () => {
    expect(excavationDepthFromFacts(depthFacts('1e3'))).toBe(3);
  });
  it('N1 上限过滤：「49m」保留、「50m」剔除', () => {
    expect(excavationDepthFromFacts(depthFacts('49'))).toBe(49);
    expect(excavationDepthFromFacts(depthFacts('50'))).toBeUndefined();
  });
  it('N1 比较式条文防御：「开挖深度16m及以上」→ 条文阈值排除 → undefined', () => {
    expect(excavationDepthFromFacts(depthFacts('16及以上'))).toBeUndefined();
  });
});

// ── N2. 危大工程分级：数值格式谱系（深度≥3 → 缺标注报 1） ──

describe('N2 危大工程分级：数值格式谱系', () => {
  it.each(DEPTH_BEHAVIOR)('N2 深度「$f」→ $depth（≥5 报 2 条，3-5 报 1 条，其余 0）', ({ f, depth }) => {
    const issues = excavationHazardClassificationIssues('基坑施工方案正文，无任何标注。', depthFacts(f));
    const expected = typeof depth === 'number' ? (depth >= 5 ? 2 : depth >= 3 ? 1 : 0) : 0;
    expect(issues).toHaveLength(expected);
  });
});

// ── N3. 目录重建：中文章序数谱系 ──

const ORDINAL_TABLE: Array<{ raw: string; keepsChapter: boolean }> = [
  { raw: '一', keepsChapter: true },
  { raw: '二', keepsChapter: true },
  { raw: '三', keepsChapter: true },
  { raw: '九', keepsChapter: true },
  { raw: '十', keepsChapter: true },
  { raw: '十一', keepsChapter: true },
  { raw: '十五', keepsChapter: true },
  { raw: '十九', keepsChapter: true },
  { raw: '二十', keepsChapter: false },
  { raw: '二十一', keepsChapter: false },
  { raw: '二十五', keepsChapter: false },
  { raw: '三十', keepsChapter: false },
  { raw: '一百', keepsChapter: false },
  { raw: '一百二十', keepsChapter: false },
  { raw: '12', keepsChapter: true },
];

describe('N3 目录重建：章序数谱系（二十及以上 → chapterOrdinal undefined → 章被滤除）', () => {
  it.each(ORDINAL_TABLE)('N3 「第$raw章 环境保护」→ 重建保留章行：$keepsChapter', ({ raw, keepsChapter }) => {
    const markdown = keepsChapter
      ? `## 目录\n旧目录行\n\n## 第${raw}章 环境保护\n### 1.1 扬尘控制`
      : `## 目录\n旧目录行\n\n## 第一章 环境保护\n### 1.1 扬尘控制\n\n## 第${raw}章 绿色施工\n### 20.1 节水措施`;
    const result = fixTocFromBody(markdown);
    if (keepsChapter) {
      expect(result.fixedCount).toBe(1);
      expect(result.markdown).toContain(`第${raw}章 环境保护`);
    } else {
      expect(result.fixedCount).toBe(1);
      expect(result.markdown).toContain('第一章 环境保护');
      expect(result.markdown).toContain('  1.1 扬尘控制');
      expect(result.markdown).not.toContain('  20.1 节水措施');
    }
  });
  it('N3 第一章 1.1 小节挂靠：ordinal=1 → 重建含缩进小节行', () => {
    const result = fixTocFromBody('## 目录\n旧目录行\n\n## 第一章 环境保护\n### 1.1 扬尘控制');
    expect(result.markdown).toContain('  1.1 扬尘控制');
  });
  it('N3 第十一章：ordinal=11 与 1.1 major=1 不匹配 → 重建目录块无该小节行', () => {
    const result = fixTocFromBody('## 目录\n旧目录行\n\n## 第十一章 环境保护\n### 1.1 扬尘控制');
    expect(result.markdown).toContain('第十一章 环境保护');
    expect(result.markdown).not.toContain('  1.1 扬尘控制');
  });
});

// ── N4. 语境模板 × 锚点直连（S5 零豁免：语境形态不影响坐标替换） ──

describe('N4 语境模板 × 锚点直连', () => {
  const tpl = contextTemplates('C.1项铺装', '50', 'm');
  it.each(Object.keys(tpl))('N4 语境「%s」→ 锚点照替换 1 处（50→100）', (key) => {
    const markdown = tpl[key];
    const anchor = anchorAfter(markdown, 'C.1项铺装', '50', 100, 'm');
    const result = fixQuantityAuthorityConflicts(markdown, [anchor]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe(`${markdown.slice(0, anchor.start)}100${markdown.slice(anchor.end)}`);
  });
});

// ── N5. 规格词谱系：分规格量豁免 ──

describe('N5 规格限定词：零豁免照替换（裁决在判定层）', () => {
  it.each(SPEC_WORDS)('N5 规格词「%s」在名称前 → 锚点照替换 50→100', (word) => {
    const markdown = `${word}C.1项铺装 50m。`;
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAfter(markdown, 'C.1项铺装', '50', 100, 'm')]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('C.1项铺装 100m');
  });
});

// ── N6. 否定前缀谱系：检测器不认 → 仍修复（锁定） ──

describe('N6 否定前缀 × 锚点直连（前缀不影响坐标替换）', () => {
  it.each(NEGATION_PREFIXES)('N6 前缀「%s」→ 「无50m」的 50m 照常替换 100', (prefix) => {
    const markdown = `本项目C.1项铺装${prefix}50m。`;
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAfter(markdown, 'C.1项铺装', '50', 100, 'm')]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('100m');
  });
});

// ── N7. 括号三态 × 清单名匹配 ──

describe('N7 括号三态 × 名称形态无关（锚点直连）', () => {
  it('N7 正文半角括号 → 锚点照替换', () => {
    const markdown = 'C.1项铺装(石材) 50m。';
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAfter(markdown, 'C.1项铺装(石材)', '50', 100, 'm')]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('C.1项铺装(石材) 100m');
  });
  it('N7 正文全角括号 → 锚点照替换', () => {
    const markdown = 'C.1项铺装（石材） 50m。';
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAfter(markdown, 'C.1项铺装(石材)', '50', 100, 'm')]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('C.1项铺装（石材） 100m');
  });
  it('N7 正文无括号（名称与正文不同形）→ 名称不参与匹配，照替换', () => {
    const markdown = 'C.1项铺装 50m。';
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAfter(markdown, 'C.1项铺装(石材)', '50', 100, 'm')]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('100m');
  });
});

// ── N8. 列举分隔符 × 多条目窗口 ──

describe('N8 列举分隔符：锚点照替换（分隔符不影响坐标）', () => {
  it.each(LIST_SEPARATORS)('N8 分隔符「%s」后的条目不干扰本条目 → 替换 1 处', (sep) => {
    const markdown = `C.1项铺装 50m${sep}C.2项浇筑 200m。`;
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAfter(markdown, 'C.1项铺装', '50', 100, 'm')]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('C.1项铺装 100m');
  });
});
