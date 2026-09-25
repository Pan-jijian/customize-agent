/**
 * 4.61 规格错位检测的两条豁免闸（实测最大 FP 族）。
 *
 * ## 闸一 · 单位量纲（面积/体积 ≠ 长度）
 *
 * 实机误报（巢湖）：「接地跨接线采用不小于 **4mm²** 铜芯软线」被绑到清单「接地 **16mm**」
 * （接地极直径）判「规格错位」。既有跨量级闸用 5 倍阈值（4 vs 16 只有 4 倍），
 * 且 `MM_SIZE_TOKEN_RE` 要求以 `mm` 结尾、`mm²` 不匹配 → 量级闸根本没启用。
 *
 * ## 未采纳：构造层厚度闸二的词表扩围
 *
 * 同一族还有「10mm 厚 DS M20 砂浆」被绑到清单条目权威的形态，直觉上应扩 F14g 词表。
 * 但**合成 fixture 复现不出该 FP**（真实 FP 依赖实际清单权威图的条目结构），
 * 两条"应豁免"的用例在**关掉新闸后仍通过**——即空过。按测试纪律（空过测试比没有测试更糟）
 * 撤回该改动：未经验证的判据改动不进主干，留待用真实权威图定向复现后再做。
 *
 * ## 测试纪律
 *
 * 首版本文件用了 `hit.found`——该字段**不存在**（真实结构是 `{issue, location, replacement?}`），
 * 于是 `expect(hits.map(h => h.found)).not.toContain('4mm')` 恒真（比较的是 undefined）：
 * **空过测试**。改用 `hits.length` 断言后才发现。两条闸各自都做了"关掉即失败"的验证。
 */
import { describe, expect, it } from 'vitest';
import { scanSpecLocationMismatchHits } from '@/services/document-workflow/integrity/detectors/detectors';
import type { SpecAuthorityMap } from '@/services/document-workflow/types';

/** 检测器要求同维度 ≥2 个 placement 才会扫描（防单条目误判） */
const specMap: SpecAuthorityMap = {
  接地: [
    { location: '接地', spec: '16mm', sourceFile: '清单.xls' },
    { location: '接地', spec: '25mm', sourceFile: '清单.xls' },
  ],
 };

describe('4.61 规格错位 · 单位量纲闸（面积/体积 ≠ 长度）', () => {
  it('实机形态：4mm² 铜芯软线不得被判为「接地 16mm」的规格错位', () => {
    const md = '桥架连接处跨接电阻不大于0.00033Ω；接地跨接线采用不小于4mm²铜芯软线，压接端子后搪锡。';
    expect(scanSpecLocationMismatchHits(md, specMap), '面积量纲不应参与长度互比').toHaveLength(0);
  });

  it('体积上标同族：mm³ 同样不参与长度互比', () => {
    const md = '接地装置采用40mm³导电膏填充，接地极间距5m。';
    expect(scanSpecLocationMismatchHits(md, specMap)).toHaveLength(0);
  });

  it('**真规格错位照旧报**（闸只认紧贴上标，不放松真缺陷）', () => {
    const md = '接地扁钢采用40mm规格，与清单不符。';
    expect(scanSpecLocationMismatchHits(md, specMap).length, '长度类 token 的真错位必须照报').toBeGreaterThan(0);
  });
});
