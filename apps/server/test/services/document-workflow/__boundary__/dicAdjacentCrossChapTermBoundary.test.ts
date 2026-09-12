/**
 * 边界矩阵（P1 第 27 批 · DD 组）
 * 覆盖：fixAdjacentPhraseDuplication 深挖增量（模式1/2/3 长度边界、整文预归一、句界、details 截断、guard 上限）/
 * fixInternalTerminology 规则变体与组合
 * 原则：每条用例独立断言意义；真实实现行为一律锁定，不迎合用例改实现。
 */
import { describe, expect, it } from 'vitest';
import { fixAdjacentPhraseDuplication, fixInternalTerminology } from '@/services/document-workflow/documentIntegrityChecks';

// ── DD1. fixAdjacentPhraseDuplication 深挖增量 ──

describe('DD1a 模式1 相邻重复块长度边界', () => {
  it('DD1a L16 起点精确（16 字中文块折叠）', () => {
    const b16 = '甲乙丙丁戊己庚辛壬癸子丑寅卯';
    const result = fixAdjacentPhraseDuplication(`${b16}${b16}。`);
    expect(result.markdown).toBe(`${b16}。`);
    expect(result.fixedCount).toBe(1);
  });
  it('DD1a L16 纯数字块折叠', () => {
    expect(fixAdjacentPhraseDuplication('12345678901234561234567890123456。').markdown).toBe('1234567890123456。');
  });
  it('DD1a 17 字重复块 → 模式1 不对齐、模式2 兜底完整删除', () => {
    const b17 = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午';
    const result = fixAdjacentPhraseDuplication(`${b17}${b17}。`);
    // L17 不在模式1 扫描范围且跨块子块无相邻对齐 → 模式1 无命中；
    // 纯中文 L17≥12 由模式2 隔位删除第二块（完整删除无残留）
    expect(result.markdown).toBe(`${b17}。`);
    expect(result.fixedCount).toBe(1);
    expect(result.details[0]).toContain('隔位重复短语折叠');
  });
  it('DD1a 三连中文块两轮迭代折叠', () => {
    const result = fixAdjacentPhraseDuplication('施工进度施工进度施工进度。');
    expect(result.markdown).toBe('施工进度。');
    expect(result.fixedCount).toBe(2);
  });
  it('DD1a 块含标点（中文块）折叠', () => {
    expect(fixAdjacentPhraseDuplication('甲乙，丙甲乙，丙。').markdown).toBe('甲乙，丙。');
  });
  it('DD1a 折叠在句中（非句首）', () => {
    expect(fixAdjacentPhraseDuplication('按照施工进度施工进度执行。').markdown).toBe('按照施工进度执行。');
  });
  it('DD1a 首字数字相邻重复由模式1 处理（模式2 首字门槛分工）', () => {
    const result = fixAdjacentPhraseDuplication('186人配置186人配置。');
    expect(result.markdown).toBe('186人配置。');
    expect(result.fixedCount).toBe(1);
    expect(result.details[0]).toContain('相邻重复短语折叠');
  });
});

describe('DD1b 模式2 隔位重复短语长度边界', () => {
  it('DD1b L9 数字短语最小边界（9 字删）', () => {
    const p9 = '高峰期按186人配';
    expect(fixAdjacentPhraseDuplication(`${p9}，${p9}。`).markdown).toBe(`${p9}，。`.replace('，。', '。'));
  });
  it('DD1b L20 数字短语上限（20 字完整删第二处）', () => {
    const p20 = '高峰期应急抢险人员按高峰人数186人配置';
    const result = fixAdjacentPhraseDuplication(`${p20}，${p20}。`);
    expect(result.markdown).toBe(`${p20}，。`.replace('，。', '。'));
    expect(result.fixedCount).toBe(1);
  });
  it('DD1b 21 字数字重复块 → 20 字子块折叠残留尾字', () => {
    const p21 = '高峰期应急抢险人员按高峰人数186人配置好';
    const result = fixAdjacentPhraseDuplication(`${p21}，${p21}。`);
    // L21 不扫描，L20 子块删第二块前 20 字，残留「好，」
    expect(result.markdown).toBe(`${p21}，好。`);
    expect(result.fixedCount).toBe(1);
  });
  it('DD1b 纯中文 12 字最小边界（12 字删）', () => {
    const p12 = '主体结构与装饰装修穿插施工';
    expect(fixAdjacentPhraseDuplication(`${p12}，${p12}。`).markdown).toBe(`${p12}，。`.replace('，。', '。'));
  });
  it('DD1b 纯中文 21 字重复块 → 20 字子块折叠残留尾字', () => {
    const p21 = '主体结构与装饰装修穿插施工阶段高峰人员调配';
    const result = fixAdjacentPhraseDuplication(`${p21}，${p21}。`);
    expect(result.markdown).toBe(`${p21}，配。`);
  });
  it('DD1b 短语含 | 结构符号豁免（隔位不删）', () => {
    const p = '高峰期|186人配置';
    const md = `${p}，中间安排人员，${p}。`;
    expect(fixAdjacentPhraseDuplication(md).markdown).toBe(md);
    expect(fixAdjacentPhraseDuplication(md).fixedCount).toBe(0);
  });
  it('DD1b 四现删后三处（fixedCount=3）', () => {
    const p = '高峰阶段应急抢险人员按186人';
    const result = fixAdjacentPhraseDuplication(`${p}${p}${p}${p}。`);
    expect(result.markdown).toBe(`${p}。`);
    expect(result.fixedCount).toBe(3);
  });
  it('DD1b 同句两不同隔位短语', () => {
    const pA = '高峰期应急抢险186人';
    const pB = '冬季热负荷配置71kW';
    const md = `${pA}，${pA}，${pB}，${pB}。`;
    const result = fixAdjacentPhraseDuplication(md);
    expect(result.markdown).toBe(`${pA}，${pB}。`.replace(/，。/gu, '。').replace(/。$/u, '。'));
    expect(result.fixedCount).toBe(2);
  });
  it('DD1b 模式1 优先于模式2（相邻与隔位同句）', () => {
    const md = '施工进度施工进度，按186人配置，按186人配置。';
    const result = fixAdjacentPhraseDuplication(md);
    // 第一轮模式1 折叠相邻块 → 第二轮模式2 删隔位短语
    expect(result.markdown).toBe('施工进度，按186人配置。');
    expect(result.fixedCount).toBe(2);
  });
});

describe('DD1c 模式3 数值单位粘连增量', () => {
  it('DD1c 三连粘连两轮迭代删至首块', () => {
    const result = fixAdjacentPhraseDuplication('负荷71.2kW182.5kW273.3kW。');
    expect(result.markdown).toBe('负荷71.2kW。');
    expect(result.fixedCount).toBe(2);
  });
  it('DD1c 负号前缀粘连折叠保留负号', () => {
    expect(fixAdjacentPhraseDuplication('-71.2kW182.5kW。').markdown).toBe('-71.2kW。');
  });
  it('DD1c 尾块无单位不删', () => {
    expect(fixAdjacentPhraseDuplication('负荷71.2kW182.5。').markdown).toBe('负荷71.2kW182.5。');
  });
  it('DD1c 大写单位不匹配（KW 不在单位组）', () => {
    expect(fixAdjacentPhraseDuplication('负荷71.2KW182.5KW。').markdown).toBe('负荷71.2KW182.5KW。');
  });
  it('DD1c 整数无小数粘连折叠', () => {
    expect(fixAdjacentPhraseDuplication('负荷71kW182kW。').markdown).toBe('负荷71kW。');
  });
});

describe('DD1d 整文预归一（split 前）', () => {
  it('DD1d 双句号归一', () => {
    const result = fixAdjacentPhraseDuplication('段落。。');
    expect(result.markdown).toBe('段落。');
    expect(result.fixedCount).toBe(0);
  });
  it('DD1d 逗号+句号归一', () => {
    expect(fixAdjacentPhraseDuplication('段落，。').markdown).toBe('段落。');
  });
  it('DD1d 双叹号后跟句号三连归一取首字符', () => {
    // [。；！？]{2,} 贪婪匹配「！！。」三连 → 取首字符「！」
    expect(fixAdjacentPhraseDuplication('段落！！。').markdown).toBe('段落！');
  });
  it('DD1d 预归一与折叠组合', () => {
    const result = fixAdjacentPhraseDuplication('施工进度施工进度。。');
    expect(result.markdown).toBe('施工进度。');
    expect(result.fixedCount).toBe(1);
  });
});

describe('DD1e 句界与跳过形态', () => {
  it('DD1e 分号句界各自折叠', () => {
    const result = fixAdjacentPhraseDuplication('施工进度施工进度；养护周期养护周期。');
    expect(result.markdown).toBe('施工进度；养护周期。');
    expect(result.fixedCount).toBe(2);
  });
  it('DD1e 叹号句界折叠', () => {
    expect(fixAdjacentPhraseDuplication('施工进度施工进度！').markdown).toBe('施工进度！');
  });
  it('DD1e 问号句界折叠', () => {
    expect(fixAdjacentPhraseDuplication('施工进度施工进度？').markdown).toBe('施工进度？');
  });
  it('DD1e 换行句界各自折叠', () => {
    const result = fixAdjacentPhraseDuplication('施工进度施工进度\n养护周期养护周期。');
    expect(result.markdown).toBe('施工进度\n养护周期。');
    expect(result.fixedCount).toBe(2);
  });
  it('DD1e 跨句不折叠（句界阻断相邻判定）', () => {
    const result = fixAdjacentPhraseDuplication('施工进度。施工进度。');
    expect(result.markdown).toBe('施工进度。施工进度。');
    expect(result.fixedCount).toBe(0);
  });
  it('DD1e 表格行带前导空格跳过', () => {
    const result = fixAdjacentPhraseDuplication('  | 施工 | 施工 |');
    expect(result.markdown).toBe('  | 施工 | 施工 |');
    expect(result.fixedCount).toBe(0);
  });
});

describe('DD1f details 截断与 guard 上限', () => {
  it('DD1f details 超 8 条截断（fixedCount 全量）', () => {
    const md = '施工进度施工进度。'.repeat(10);
    const result = fixAdjacentPhraseDuplication(md);
    expect(result.fixedCount).toBe(10);
    expect(result.details).toHaveLength(8);
  });
  it('DD1f guard=20 轮上限（21 块粘连链只删 20 块）', () => {
    const chain = Array.from({ length: 22 }, (_, i) => `${i + 1}kW`).join('');
    const result = fixAdjacentPhraseDuplication(`负荷${chain}。`);
    // 每轮删一个粘连块，20 轮后停止 → 残留首块与最后一块
    expect(result.markdown).toBe('负荷1kW22kW。');
    expect(result.fixedCount).toBe(20);
  });
  it('DD1f details 内容格式（相邻重复短语折叠）', () => {
    const result = fixAdjacentPhraseDuplication('施工进度施工进度。');
    expect(result.details[0]).toContain('相邻重复短语折叠');
    expect(result.details[0]).toContain('施工进度');
  });
});

// ── DD3. fixInternalTerminology 规则变体与组合 ──

describe('DD3a 规则变体边界', () => {
  it('DD3a 规则1 缺「全文」前缀不命中', () => {
    const md = '唯一劳动力峰值口径确定。';
    expect(fixInternalTerminology(md).markdown).toBe(md);
    expect(fixInternalTerminology(md).fixedCount).toBe(0);
  });
  it('DD3a 规则2 前加「的」仍命中（无边界断言）', () => {
    const result = fixInternalTerminology('的统一控制口径。');
    expect(result.markdown).toBe('的统一控制基准。');
    expect(result.fixedCount).toBe(1);
  });
  it('DD3a 「工作包」单独出现不替换（仅锁定短语）', () => {
    const md = '按工作包管理。';
    expect(fixInternalTerminology(md).markdown).toBe(md);
    expect(fixInternalTerminology(md).fixedCount).toBe(0);
  });
  it('DD3a 跨行不命中（regex 不跨行）', () => {
    const md = '统一控制\n口径。';
    const result = fixInternalTerminology(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('DD3a 同条规则 3 处计数与 details', () => {
    const result = fixInternalTerminology('拆除工程工作包。拆除工程工作包。拆除工程工作包。');
    expect(result.fixedCount).toBe(3);
    expect(result.details[0]).toContain('拆除工程工作包 3 处');
  });
});

describe('DD3b 规则组合与幂等', () => {
  it('DD3b 规则4+5 同文组合（顺序独立替换）', () => {
    const result = fixInternalTerminology('拆除工程工作包按工作包逐项说明。');
    expect(result.markdown).toBe('拆除工程按专业工程逐项说明。');
    expect(result.fixedCount).toBe(2);
    expect(result.details).toHaveLength(2);
  });
  it('DD3b 规则1 两处 + 规则3 一处 details 顺序', () => {
    const result = fixInternalTerminology('全文唯一劳动力峰值口径与全文唯一劳动力峰值口径按以下口径处理。');
    expect(result.markdown).toBe('全文劳动力峰值基准与全文劳动力峰值基准按以下程序处理。');
    expect(result.fixedCount).toBe(3);
    expect(result.details).toHaveLength(2);
    expect(result.details[0]).toContain('劳动力峰值口径 2 处');
  });
  it('DD3b 替换后幂等（二次运行零命中）', () => {
    const first = fixInternalTerminology('统一控制口径。');
    const second = fixInternalTerminology(first.markdown);
    expect(second.markdown).toBe('统一控制基准。');
    expect(second.fixedCount).toBe(0);
    expect(second.details).toEqual([]);
  });
  it('DD3b 空串安全', () => {
    const result = fixInternalTerminology('');
    expect(result.markdown).toBe('');
    expect(result.fixedCount).toBe(0);
  });
});
