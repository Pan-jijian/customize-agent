/**
 * G 线 P2-11：CAD 坐标重建的单字符碎片合并。
 *
 * 实测依据（巢湖终态库 1730 个 cad chunk / 49,426 行）：单字符行 3,978 = 8.0%，
 * 其中「连续 ≥3 的整串」1,894 行（3.8%），是被逐字符拆成独立实体的**真实文本**——
 * `NINGBO` 拆成 `N|I|N|G|B|O`、`有限公司` 拆成 `有|限|公|司`。
 *
 * 本文件锁定合并行为，并明确**不删除**：孤立单字符行（实测以上下文为电气图例表列值的
 * 大写字母 `A` 为主）原样保留——本仓刚走完「解析丢数据」专项，检索语料里不做删除式治理。
 */
import { describe, it, expect } from 'vitest';
import { layoutCadAnnotations } from '../src/extraction/content-extractor.js';

/** 每字符一个实体、y 逐字错开（模拟 DXF 逐字符拆分实体） */
const perChar = (text: string, x0 = 0, y0 = 100) =>
  [...text].map((ch, i) => ({ text: ch, x: x0 + i, y: y0 - i * 0.5 }));

describe('G 线 P2-11 单字符碎片合并', () => {
  it('连续 ≥3 单字符合并成词（NINGBO / 有限公司 恢复可检索）', () => {
    const text = layoutCadAnnotations([
      ...perChar('NINGBO', 0, 100),
      { text: '宁波市工业建筑设计研究院', x: 0, y: 80 },
      ...perChar('有限公司', 0, 70),
    ]).join('\n');
    expect(text).toContain('NINGBO');
    expect(text).toContain('有限公司');
    // 不得残留被拆散的单字符行（断言「整行」而非子串——NINGBO 本身含 'N'）
    const lines = text.split('\n');
    expect(lines).not.toContain('N');
    expect(lines).not.toContain('有');
  });

  it('连续 2 个单字符不合并（可能是合法短编号）', () => {
    const text = layoutCadAnnotations([
      { text: '甲', x: 0, y: 100 },
      { text: '乙', x: 0, y: 99 },
      { text: '正文段落若干字符', x: 0, y: 90 },
    ]).join('\n');
    expect(text).toContain('甲');
    expect(text).toContain('乙');
  });

  it('孤立单字符行原样保留（不删除）', () => {
    const text = layoutCadAnnotations([
      { text: '照明配电箱REMARK', x: 0, y: 100 },
      { text: 'A', x: 0, y: 90 },
      { text: '专用电路上的应急照明灯', x: 0, y: 80 },
    ]).join('\n');
    expect(text).toContain('A');
    expect(text).toContain('专用电路上的应急照明灯');
  });

  it('多字符行不受影响（不误合并正常标注）', () => {
    const text = layoutCadAnnotations([
      { text: '主体结构混凝土强度等级为 C30', x: 0, y: 100 },
      { text: '垫层采用 C15 素混凝土', x: 0, y: 90 },
    ]).join('\n');
    expect(text).toContain('主体结构混凝土强度等级为 C30');
    expect(text).toContain('垫层采用 C15 素混凝土');
  });
});
