/**
 * G 线 P2-1 权威值占位符协议：**让计划类数值不经过 LLM 生成**。
 *
 * 现状是反过来的——LLM 先自己写数，再由写后对齐（P1-8）与 S5 判定把错值纠回来，
 * 纠不回的进终门禁。这条链每一环都在赔偿同一个结构性错误：**数值的产出方不该是 LLM**。
 * 本协议把产出方换成权威层：模型写 `{{AUTH:<path>}}`，生成后确定性填充。
 *
 * 本文件同时锁定**失效模式**——协议不被遵守时结果必须降级为「今日行为」而不是更差，
 * 且未决/畸形 token 一律**保留原样并上报**，绝不静默删除（P2-2 口径）。
 */
import { describe, expect, it } from 'vitest';
import { AUTHORITY_PLACEHOLDER_RE, fillAuthorityPlaceholders, renderAuthorityPlaceholderCatalog, renderAuthorityValue } from '@/services/document-workflow/integratedBlueprint';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint/types';

const DATA = {
  contract: { totalDays: 180, qualityStandard: '合格', pricingFile: '' },
  resources: { labor: { peak: { min: 40, max: 60 }, peakValue: 52, peakBasis: '', byPhase: [], byTrade: [], composition: [] }, equipment: [] },
  redLineFacts: [{ key: '绿化养护期', value: '一年', source: 'x' }],
  quantities: { 挖一般土方: { value: 1200, unit: 'm³' } },
} as unknown as BlueprintData;

describe('G 线 P2-1 权威值占位符', () => {
  it('占位符被权威值确定性填充（数值不由 LLM 产出）', () => {
    const result = fillAuthorityPlaceholders('本工程总工期 {{AUTH:data.contract.total_days}}。', DATA);
    expect(result.markdown).toBe('本工程总工期 180 日历天。');
    expect(result.filled).toEqual([{ path: 'data.contract.total_days', value: '180 日历天' }]);
    expect(result.unresolved).toEqual([]);
  });

  it('降级保证：无占位符时**完全 no-op**（协议不被遵守 ⇒ 结果为今日行为，不更差）', () => {
    const markdown = '本工程总工期 180 日历天，劳动力峰值 52 人。';
    const result = fillAuthorityPlaceholders(markdown, DATA);
    expect(result.markdown).toBe(markdown);
    expect(result.filled).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it('未决 token（path 无权威值）保留原样并上报——不静默删除', () => {
    const result = fillAuthorityPlaceholders('养护期 {{AUTH:data.unknown.path}}。', DATA);
    expect(result.markdown).toContain('{{AUTH:data.unknown.path}}');
    expect(result.unresolved).toEqual(['data.unknown.path']);
    expect(result.filled).toEqual([]);
  });

  it('畸形 token（空 path）保留原样并上报', () => {
    const result = fillAuthorityPlaceholders('异常 {{AUTH:}} 与 {{AUTH:   }}。', DATA);
    expect(result.markdown).toContain('{{AUTH:}}');
    expect(result.malformed.length).toBe(2);
    expect(result.filled).toEqual([]);
  });

  it('无蓝图数据时不做任何替换，但 token 全数登记为未决', () => {
    const result = fillAuthorityPlaceholders('工期 {{AUTH:data.contract.total_days}}。', undefined);
    expect(result.markdown).toBe('工期 {{AUTH:data.contract.total_days}}。');
    expect(result.unresolved).toEqual(['data.contract.total_days']);
  });

  it('幂等：填充后的正文不含 token，二次调用 no-op', () => {
    const once = fillAuthorityPlaceholders('工期 {{AUTH:data.contract.total_days}}。', DATA);
    const twice = fillAuthorityPlaceholders(once.markdown, DATA);
    expect(twice.markdown).toBe(once.markdown);
    expect(twice.filled).toEqual([]);
  });

  it('目录只列**有权威值**的 path（列了填不进的会自造未决告警）', () => {
    const catalog = renderAuthorityPlaceholderCatalog(
      ['data.contract.total_days', 'data.resources.labor.peak_value', 'data.unknown.path'],
      DATA,
    );
    expect(catalog).toHaveLength(2);
    expect(catalog.join('\n')).toContain('{{AUTH:data.contract.total_days}}');
    expect(catalog.join('\n')).not.toContain('data.unknown.path');
  });

  it('值与权威源同源：零值视为无权威（不填 0，避免把「没有」写成「为零」）', () => {
    const zeroed = { ...DATA, contract: { ...DATA.contract, totalDays: 0 } } as BlueprintData;
    expect(renderAuthorityValue('data.contract.total_days', zeroed)).toBeUndefined();
    const result = fillAuthorityPlaceholders('工期 {{AUTH:data.contract.total_days}}。', zeroed);
    expect(result.markdown).toContain('{{AUTH:data.contract.total_days}}');
    expect(result.unresolved).toEqual(['data.contract.total_days']);
  });

  it('token 正则不误伤正文（双花括号在正式中文正文中不出现）', () => {
    const markdown = '本工程按规范施工，混凝土强度 C30，{单括号}与 $$ 数学符号均不受影响。';
    expect([...markdown.matchAll(AUTHORITY_PLACEHOLDER_RE)]).toHaveLength(0);
    expect(fillAuthorityPlaceholders(markdown, DATA).markdown).toBe(markdown);
  });
});
