/**
 * 危大判定参数绑定单测（4.55.22）。
 * 样本**逐字取自巢湖真实清单**（`4-工程量清单各项分类表/*.xls` 项目特征描述）——
 * 这些形态是实测踩过的坑，作为回归守卫固化。
 *
 * 基线实测缺陷（本模块要根治的）：正文把**规范阈值**当本项目参数写，与清单实测直接矛盾——
 * 「搭设高度超过24m区段属危大」（清单实测 18.05m以内）、「开挖深度超过3m属危大」（清单实测 1.5m内）。
 */
import { describe, expect, it } from 'vitest';
import { HAZARD_THRESHOLDS, billOfQuantitiesCorpus, extractHazardBindings, extractHazardParameters, normalizeParameterValue, renderHazardBindingBlock } from '@/services/document-workflow/hazardBinding';

const 清单 = '巢湖项目/4-工程量清单各项分类表/1#厂房土建工程.xls';

/** 巢湖清单原文行（逐字） */
const 巢湖清单 = [
  { content: '外墙脚手架 1．构件类型：砖外墙 2．搭设方式：双排,密目网(全封闭) 围护 3．搭设高度：18.05m以内 4．脚手架材质：投标人自行综合考虑', filePath: 清单 },
  { content: '内墙砌筑脚手架 3．搭设方式：双排,密目网(全封闭) 围护 3．搭设高度：4.5m以内', filePath: 清单 },
  { content: '有梁板模板：1．支撑高度：3.60m以内 2．模板材质：由投标人自行选择', filePath: 清单 },
  { content: '构造柱模板：2．支撑高度：详见施工图纸、投标人自行综合考虑超高部分的模板增加费', filePath: 清单 },
  { content: '挖一般土方 2．土壤类别：现场现状土 3．挖土深度：1.5m内 4．其他要求', filePath: 清单 },
  { content: '挖沟槽土方 3．挖土深度：1.0m内', filePath: 清单 },
  { content: '钢柱 1．柱类型：钢柱 2．钢材品种、规格：Q355B 3．单根柱质量：5t以内 4．安装高度：24.00m以内', filePath: 清单 },
  { content: '机械设备名称：投标人根据施工方案需要自行考虑 3．其他要求：塔式起重机基础数量等、投标人自行综合考虑报价', filePath: 清单 },
];

const findings = (evidence: typeof 巢湖清单) =>
  new Map(extractHazardBindings(evidence).map(item => [item.category, item]));

describe('值归一与区间语义（4.55.22）', () => {
  it('长度归一：m/cm/mm 与省略单位形态', () => {
    expect(normalizeParameterValue('18.05m以内', 'm')).toEqual({ normalized: 18.05, bound: 'upper' });
    expect(normalizeParameterValue('30cm内', 'm')).toEqual({ normalized: 0.3, bound: 'upper' });
    expect(normalizeParameterValue('150mm以内', 'm')).toEqual({ normalized: 0.15, bound: 'upper' });
    // 清单实测「搭设高度：3.60内」省略单位，按 m 计
    expect(normalizeParameterValue('3.60内', 'm')).toEqual({ normalized: 3.6, bound: 'upper' });
  });

  it('重量归一：t → kN（危大阈值 10kN/100kN 是力单位，不是吨）', () => {
    expect(normalizeParameterValue('5t以内', 'kN')).toEqual({ normalized: 49, bound: 'upper' });
    expect(normalizeParameterValue('10kN及以上', 'kN')).toEqual({ normalized: 10, bound: 'lower' });
  });

  it('指向型描述不可判定（不得当数值用）', () => {
    expect(normalizeParameterValue('详见施工图纸、投标人自行综合考虑超高部分', 'm')).toBeUndefined();
  });
});

describe('巢湖实测清单 → 危大判定（4.55.22 根治）', () => {
  const map = findings(巢湖清单);

  it('脚手架 = 不属危大（实测 18.05m以内 < 24m 阈值）——基线正文误写「超过24m属危大」', () => {
    const item = map.get('脚手架工程');
    expect(item?.conclusion).toBe('不属危大');
    expect(item?.clause).toBe('2.4.1');
    expect(item?.parameter).toContain('18.05m以内');
  });

  it('起重吊装 = 属危大，且引 2.3.2（塔吊属常规设备，2.3.1「非常规起重设备」前提不成立）', () => {
    const item = map.get('起重吊装及起重机械安装拆卸工程');
    expect(item?.conclusion).toBe('属危大');
    expect(item?.clause).toBe('2.3.2');
  });

  // 4.55.22 用户红线：**不设「依据不足」逃生口**——资料齐全，规则链必须自己决出属/不属
  it('基坑 = 不属危大（未达 3m 门槛，且资料无 2.1.2 触发条件信号）', () => {
    const item = map.get('基坑工程');
    expect(item?.conclusion).toBe('不属危大');
    expect(item?.clause).toBe('2.1.2');
    expect(item?.basis).toContain('未见毗邻建');
  });

  it('基坑：资料载明毗邻建（构）筑物/地下管线复杂时 → 属危大（2.1.2 条件型命中）', () => {
    const item = findings([
      { content: '挖一般土方 3．挖土深度：1.5m内 4．其他要求：基坑紧邻既有厂房，地下管线复杂', filePath: 清单 },
    ]).get('基坑工程');
    expect(item?.conclusion).toBe('属危大');
    expect(item?.clause).toBe('2.1.2');
  });

  it('模板支撑 = 不属危大（高度 3.6m 未达 5m，且无 ≥10m 搭设跨度——逐条件对照后决出）', () => {
    const item = map.get('模板工程及支撑体系');
    expect(item?.conclusion).toBe('不属危大');
    expect(item?.clause).toBe('2.2.2');
  });

  it('模板支撑：结构跨度命中取或条件 → 属危大；跨度 ≥18m 升为超过一定规模', () => {
    const span12 = findings([
      { content: '有梁板模板 1．支撑高度：3.60m以内 2．单跨跨度：12m', filePath: 清单 },
    ]).get('模板工程及支撑体系');
    expect(span12?.conclusion).toBe('属危大');
    expect(span12?.basis).toContain('跨度');
    // 巢湖实测「最大单跨跨度 35.86m」≥18m → 3.2.2 超过一定规模
    const span36 = findings([
      { content: '有梁板模板 1．支撑高度：3.60m以内 2．单跨跨度：35.86m', filePath: 清单 },
    ]).get('模板工程及支撑体系');
    expect(span36?.conclusion).toBe('属超过一定规模的危大');
  });

  it('四项判定全部给出条款号与阈值（恒有依据）', () => {
    for (const item of map.values()) {
      expect(item.clause).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(item.threshold.length).toBeGreaterThan(0);
      expect(item.basis.length).toBeGreaterThan(0);
    }
  });
});

describe('跨度字段左边界（DWG 吊车跨度误判回归）', () => {
  it('「吊车跨度：26.8m」不得当作模板支撑搭设跨度', () => {
    // 实测：巢湖 DWG 建筑图标注「20T 吊车跨度： 26.8m」——原实现字段名含裸「跨度」且无左边界，
    // 直接把 3.6m 高支模的项目误判成「超过一定规模的危大」
    const item = findings([
      { content: '有梁板模板 1．支撑高度：3.60m以内 2．模板材质：由投标人自行选择', filePath: 清单 },
      { content: '20T 吊车跨度： 26.8m 20T 吊车跨度： 23.8m', filePath: '巢湖项目/2-图纸目录/建筑/1#厂房审图_t3.dwg' },
    ]).get('模板工程及支撑体系');
    expect(item?.conclusion).toBe('不属危大');
  });

  it('显式「最大单跨跨度为 35.86 米」计入（招标原文句式）', () => {
    const item = findings([
      { content: '有梁板模板 1．支撑高度：3.60m以内', filePath: 清单 },
      { content: '主要建设1#厂房（建筑面积为71807.64平方米）、2#门卫、3#门卫及附属工程；最大单跨跨度为35.86米。', filePath: '巢湖项目/招标文件.pdf' },
    ]).get('模板工程及支撑体系');
    expect(item?.conclusion).toBe('属超过一定规模的危大');
    expect(item?.basis).toContain('35.86');
    expect(item?.basis).toContain('最大单跨跨度');
  });
});

describe('规范目录文本隔离（严重缺陷回归）', () => {
  it('CAD 图层抄录的 31 号文目录不得触发形态命中', () => {
    // 实测：巢湖 `结构设计总说明审图修改_t3.dwg` 图层内含整段目录，「附着式升降脚手架工程」直接命中
    // → 任何项目都被判「采用附着式升降脚手架，属危大」
    const polluted = [{
      content: '警示标志。 3排箍筋 2.4.2 附着式升降脚手架工程。 3.4.2 提升高度在150m及以上的附着式升降脚手架工程或附着式升降操作平台工程。',
      filePath: '巢湖项目/2-图纸目录/主体CAD/结构/结构设计总说明审图修改_t3.dwg',
    }];
    const corpus = billOfQuantitiesCorpus(polluted);
    expect(corpus).not.toContain('附着式升降脚手架');
    // 且该污染不得进入判定语料（非清单文件被整体排除）
    expect(findings([...巢湖清单, ...polluted]).get('脚手架工程')?.conclusion).toBe('不属危大');
  });

  it('非清单证据（图纸/施工方案）不参与形态判定，但参数抽取仍覆盖全量证据', () => {
    const params = extractHazardParameters(巢湖清单);
    expect(params.length).toBeGreaterThan(0);
    expect(billOfQuantitiesCorpus(巢湖清单)).toContain('搭设方式');
  });
});

describe('阈值表（单源）与注入渲染', () => {
  it('阈值表含附件1/附件2 双档且条款号完整', () => {
    expect(HAZARD_THRESHOLDS.基坑工程.hazardous[0]).toMatchObject({ clause: '2.1.1', value: 3 });
    expect(HAZARD_THRESHOLDS.基坑工程.superHazardous[0]).toMatchObject({ clause: '3.1.1', value: 5 });
    expect(HAZARD_THRESHOLDS.脚手架工程.hazardous[0]).toMatchObject({ clause: '2.4.1', value: 24 });
    expect(HAZARD_THRESHOLDS.起重吊装及起重机械安装拆卸工程.hazardous[0]).toMatchObject({ clause: '2.3.1', value: 10 });
  });

  it('注入块逐项含「本项目参数 + 条款 + 结论」，并禁止照抄阈值充当实测值（且无回避套话）', () => {
    const block = renderHazardBindingBlock(extractHazardBindings(巢湖清单));
    expect(block).toContain('禁止照抄规范阈值充当本项目参数');
    expect(block).toContain('18.05m以内');
    expect(block).toContain('不属危大');
    // 禁止的是**结论**出现回避态（禁用文案本身提及该词是允许的）
    expect(block).not.toContain('结论：**依据不足**');
    expect(block).toContain('不得写「须按设计文件/专项方案确定」「依据不足」类回避表述');
  });

  it('边界：等于阈值即命中（=3m 属危大、=24m 属危大）', () => {
    const at3 = findings([{ content: '挖一般土方 3．挖土深度：3.0m内', filePath: 清单 }]).get('基坑工程');
    expect(at3?.conclusion).toBe('属危大');
    const at24 = findings([{ content: '外墙脚手架 3．搭设高度：24m以内', filePath: 清单 }]).get('脚手架工程');
    expect(at24?.conclusion).toBe('属危大');
  });

  it('超过一定规模：≥5m 基坑判超危大', () => {
    const deep = findings([{ content: '挖一般土方 3．挖土深度：5.2m', filePath: 清单 }]).get('基坑工程');
    expect(deep?.conclusion).toBe('属超过一定规模的危大');
    expect(deep?.clause).toBe('3.1.1');
  });
});
