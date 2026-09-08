/**
 * 边界矩阵（P1 第 32 批 · SS 组 · 豁免词谱系跨检测器行为锁定）
 * 断言按探测锁定的真实行为推导。
 *  - S1 否定声明词 × areaArithmeticIssues：不豁免（行级豁免仅限灭火器/养护期类检测器）
 *  - S2 否定声明词直接修饰面积句：不豁免
 *  - S3 规格限定词 × areaArithmeticIssues：不豁免
 *  - S4 相对量豁免词谱系 × 权威表对齐（GG5 构造：非权威 80 对齐权威 100）
 *  - S5 相对量豁免词 × 行内双日期取大（外部权威 80 差 20% 容差内不动）
 */
import { describe, expect, it } from 'vitest';
import { applyNumericConsistencyDeterministicFixes, areaArithmeticIssues } from '@/services/document-workflow/documentIntegrityChecks';

const NEGATIVE_WORDS = ['不再出现', '不得出现', '严禁出现', '避免出现', '不采用', '未采用', '予以删除', '已删除', '取消', '纠正为', '更正为'] as const;
const RELATIVE_WORDS = ['合格', '封顶', '移交', '完成', '进场', '退场'] as const;
const SPEC_WORDS = ['直径450', '直径630', 'DN200', 'DN110', 'Φ16', 'φ10'] as const;

// ── S1. 否定声明词 × area（不豁免，行为锁定） ──

describe('S1 面积算术：否定声明词不豁免', () => {
  it.each(NEGATIVE_WORDS)('S1 面积矛盾句后接「%s。」→ 仍报 1 条', (word) => {
    expect(areaArithmeticIssues(`地上10㎡地下5㎡单体建筑面积10㎡。${word}。`)).toHaveLength(1);
  });
});

// ── S2. 否定声明词直修饰面积句（不豁免） ──

describe('S2 面积算术：否定词直修饰不豁免', () => {
  it.each(['不再出现', '不得出现', '未采用'])('S2 「%s地上10㎡地下5㎡单体建筑面积10㎡」→ 仍报 1 条', (word) => {
    expect(areaArithmeticIssues(`${word}地上10㎡地下5㎡单体建筑面积10㎡。`)).toHaveLength(1);
  });
});

// ── S3. 规格词 × area（不豁免） ──

describe('S3 面积算术：规格限定词不豁免', () => {
  it.each(SPEC_WORDS)('S3 「%s」前缀面积矛盾句 → 仍报 1 条', (word) => {
    expect(areaArithmeticIssues(`${word}地上10㎡地下5㎡单体建筑面积10㎡。`)).toHaveLength(1);
  });
});

// ── S4. 相对量豁免词谱系 × 权威表对齐（GG5 构造） ──

describe('S4 节点工期：相对量豁免词谱系 × 权威表对齐', () => {
  it.each(RELATIVE_WORDS)('S4 权威行「主体%s后第30日，第100日」→ 30 豁免取 100 → 非权威 80 对齐', (word) => {
    const markdown = [
      '## 总进度计划',
      '| 里程碑 | 完成时间 |',
      '| --- | --- |',
      `| 主体${word} | 主体${word}后第30日，第100日 |`,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '## 其他表',
      '| 节点 | 时间 |',
      '| --- | --- |',
      `| 主体${word} | 第80日 |`,
    ].join('\n');
    const result = applyNumericConsistencyDeterministicFixes(markdown, { scheduleAuthority: 0 });
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain(`| 主体${word} | 第100日 |`);
    expect(result.markdown).not.toContain('第80日');
  });
});

// ── S5. 相对量豁免词 × 行内双日期（外部权威差 20% 容差内不动） ──

describe('S5 节点工期：相对量豁免 × 行内取大行为', () => {
  it.each(RELATIVE_WORDS)('S5 行「主体%s后第30日，第100日」外部权威 80 → 容差内不动', (word) => {
    const markdown = `| 里程碑 | 完成时间 |\n| --- | --- |\n| 主体${word} | 主体${word}后第30日，第100日 |`;
    const result = applyNumericConsistencyDeterministicFixes(markdown, { scheduleAuthority: 80 });
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('第100日');
  });
});
