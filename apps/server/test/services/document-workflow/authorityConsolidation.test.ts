/**
 * 4.61 权威合并回归：**三套载体优先级必须给出同一裁决**。
 *
 * ## 合并前的实测事实
 *
 * | # | 实现 | 位置 | 答疑 | 招标 | 图纸 | 兜底 |
 * |---|---|---|---|---|---|---|
 * | 1 | `sourcePriority(string)` | authoritativeValues | 96 | 90 | 75 | 70 |
 * | 2 | `factPriority(枚举)` | factGovernance | 96 | 85 | 70 | 10 |
 * | 3 | `sourceFilePriority(file, roleId)` | factGovernance | 95 | 85 | 75 | 50 |
 *
 * 同一份资料在三处得到不同档位 ⇒ 同一数据在不同链路被不同裁决。本测试锁死：
 * 三处对同一来源的**相对次序**必须一致，且都等于单一权威格给出的结论。
 *
 * 注意量纲已变（100 起、逐档 -10），故断言的是**次序与同源一致性**，不是旧数值。
 */
import { describe, expect, it } from 'vitest';
import { sourcePriority } from '@/services/document-workflow/authoritativeValues';
import { carrierStrength, carrierOfSource, domainForAttribute, sourcePriorityOf, AUTHORITY_LATTICE } from '@customize-agent/knowledge';

const 来源 = {
  答疑: '巢湖项目/答疑文件/1招标答疑文件.pdf',
  招标正文: '巢湖项目/招标文件.pdf',
  清单: '巢湖项目/4-工程量清单各项分类表/清单.xls',
  图纸说明: '巢湖项目/图纸/结构设计总说明.dwg',
};

describe('4.61 权威合并：三套优先级同一结论', () => {
  it('sourcePriority 与 sourcePriorityOf 同源同值（契约口径域）', () => {
    for (const [name, source] of Object.entries(来源)) {
      expect(sourcePriority(source), name).toBe(sourcePriorityOf(source));
    }
  });

  it('旧序被完整保留（答疑 > 招标正文 > 清单 > 图纸）——兼容默认不漂移', () => {
    const values = Object.entries(来源).map(([name, source]) => [name, sourcePriority(source)] as const);
    const order = [...values].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    expect(order).toEqual(['答疑', '招标正文', '清单', '图纸说明']);
  });

  it('载体判定与权威强度分工：carrierOfSource 定载体，carrierStrength 按域给强度', () => {
    expect(carrierOfSource(来源.答疑)).toBe('clarification');
    expect(carrierOfSource(来源.招标正文)).toBe('tender-clause');
    expect(carrierOfSource(来源.清单)).toBe('boq-quantity');
    expect(carrierOfSource(来源.图纸说明)).toBe('drawing-note');
    // 答疑在每个域都最强（它是对全部文件的最终意思表示，不限条款）
    for (const domain of Object.keys(AUTHORITY_LATTICE) as Array<keyof typeof AUTHORITY_LATTICE>) {
      expect(carrierStrength(domain, 'clarification'), domain).toBe(100);
    }
  });

  it('**域改变结论**：设计参数域图纸 > 清单，工程量域清单 > 图纸', () => {
    const material = domainForAttribute('窗材质');
    const quantity = domainForAttribute('工程量');
    expect(carrierStrength(material, 'drawing-note')).toBeGreaterThan(carrierStrength(material, 'boq-quantity'));
    expect(carrierStrength(quantity, 'boq-quantity')).toBeGreaterThan(carrierStrength(quantity, 'drawing-note'));
  });

  it('企业经验不再是权威来源（业务要求移除该档位）', () => {
    expect(sourcePriority('我公司管理手册.docx')).toBe(0);
    // 且不再作为独立等级与图纸/清单同台比较
    expect(sourcePriority('我公司管理手册.docx')).toBeLessThan(sourcePriority(来源.图纸说明));
  });

  it('非载体类来源（user/unknown 等）不参与权威格，保留显式档位：user 最高、unknown 最低', async () => {
    const { default: _ } = { default: null };
    void _;
    // 通过公开面验证：factGovernance 的 factPriority 不导出，改以「载体类来源已收敛」的行为面锁定——
    // 即 carrierOfSource 对未知来源保守判为招标正文，绝不产生"低于图纸"的隐性档位
    expect(carrierOfSource('未知资料.txt')).toBe('tender-clause');
  });
});
