/**
 * D6 池噪声判定单测（要求池/参数池同源净化单源）：七类形态判据正样本全覆盖 + 防误伤守护反样本。
 * 加固点（D6 实机复算修正，r28l/s28l）：
 * - 门槛 3：表号标号「H.4/E.1/O.8」/独立月份「12月/08月」等 3 字符残片此前被 4 字符门槛遮蔽滞留池中；
 * - 图签守卫统一：双特征短路曾绕过约束词守卫，「投标人须提供工程设计甲级资质证书」类真实资格
 *   要求条款被误判出池——命任任一图签特征均须无约束词方可判定。
 * 判定为 L2 确定性纯函数：无 LLM 无 IO。
 */
import { describe, expect, it } from 'vitest';
import { classifyPoolNoiseText, isPoolNoiseText, POOL_NOISE_RULE_SOURCES } from '@/services/document-workflow/poolNoise';

describe('classifyPoolNoiseText（D6 池噪声形态判定与防误伤）', () => {
  it('图签：无约束词的印章/证书编号行判 drawing_signature；含约束词的真实条款不误伤（守卫统一）', () => {
    expect(classifyPoolNoiseText('工程设计甲级证书编号：A134A00302')).toBe('drawing_signature');
    expect(classifyPoolNoiseText('安徽省城建设计研究总院 出图专用章')).toBe('drawing_signature');
    expect(classifyPoolNoiseText('专用章')).toBe('drawing_signature');
    // 双特征共现（工程设计甲级 + 资质证书）但含约束词：真实资格要求条款保留（双特征短路误伤修正）
    expect(classifyPoolNoiseText('投标人须提供工程设计甲级资质证书')).toBeUndefined();
    expect(classifyPoolNoiseText('须提供工程设计甲级资质证书')).toBeUndefined();
    // 单特征 + 约束词（按图施工类）：保留
    expect(classifyPoolNoiseText('按图施工须加盖出图章')).toBeUndefined();
  });

  it('坐标 / 表格残片 / 编号粘连 / 目录行 / 罗列值 / 孤立日期各归其类', () => {
    expect(classifyPoolNoiseText('R6C4项目特征描述:（6）设备全景通道')).toBe('sheet_coordinate');
    expect(classifyPoolNoiseText('CHECKE子项名称SUBITEM')).toBe('table_fragment');
    expect(classifyPoolNoiseText('建设单位：（签章）施工单位：（签章）')).toBe('table_fragment');
    expect(classifyPoolNoiseText('项目编号：询标日期：年月日')).toBe('table_fragment');
    // 日期时间粘连（日期尾与钟点串接）
    expect(classifyPoolNoiseText('2026.7.1018：16')).toBe('table_fragment');
    expect(classifyPoolNoiseText('2225111舒城县重点工程')).toBe('numeric_smear');
    expect(classifyPoolNoiseText('000L')).toBe('numeric_smear');
    expect(classifyPoolNoiseText('1.3.1')).toBe('numeric_smear');
    // 3 字符表号标号（门槛 3 修正：此前被 4 字符门槛遮蔽滞留池中）
    expect(classifyPoolNoiseText('H.4')).toBe('numeric_smear');
    expect(classifyPoolNoiseText('E.1')).toBe('numeric_smear');
    expect(classifyPoolNoiseText('O.8')).toBe('numeric_smear');
    expect(classifyPoolNoiseText('十九、施工组织设计.......')).toBe('toc_line');
    // 真实 PDF 目录行形态：点串后带页码（行尾为页码而非点串；C3-9 归零验证实机缺口修正）
    expect(classifyPoolNoiseText('十九、施工组织设计.......................................................................................................................211')).toBe('toc_line');
    expect(classifyPoolNoiseText('一、投标须知.........................15')).toBe('toc_line');
    // 防误伤：不含点串/省略号尾的正常编号条款行不命中
    expect(classifyPoolNoiseText('1.1 本工程计划工期为90日历天，具体以开工令为准。')).toBeUndefined();
    expect(classifyPoolNoiseText('2024年')).toBe('date_fragment');
    // 孤立月份（门槛 3 修正）；含空白容忍
    expect(classifyPoolNoiseText('12月')).toBe('date_fragment');
    expect(classifyPoolNoiseText('05 月')).toBe('date_fragment');
    // 超长罗列值（>60 字无句读含拉丁串）
    expect(classifyPoolNoiseText(
      'GB50268给水排水管道工程施工及验收规范GB50268给水排水管道工程施工及验收规范GB50268给水排水管道工程施工',
    )).toBe('listing_smear');
  });

  it('表格跨行粘连（行结构判据）：编号列碎片 + 短碎片行判定；编号+长内容多行条款不误伤', () => {
    expect(classifyPoolNoiseText('3.4.4\n方案\n3.6.1\n计划')).toBe('table_fragment');
    expect(classifyPoolNoiseText('2.4 招标项目标段编号：丰乐镇项目施工\n2.5 建设地点：安徽省合肥市')).toBeUndefined();
  });

  it('防误伤守护：强度等级/砂浆混凝土标号豁免、3 字符合法值、短文本、含句读长句、半角值保留', () => {
    // 强度等级/砂浆/轻集料混凝土/加气块/抹灰石膏豁免
    expect(classifyPoolNoiseText('LC5.0')).toBeUndefined();
    expect(classifyPoolNoiseText('M7.5')).toBeUndefined();
    expect(classifyPoolNoiseText('Mb5.0')).toBeUndefined();
    expect(classifyPoolNoiseText('A3.5')).toBeUndefined();
    expect(classifyPoolNoiseText('DP5.0')).toBeUndefined();
    // 3 字符合法值（门槛 3 修正后不误伤）
    expect(classifyPoolNoiseText('C60')).toBeUndefined();
    expect(classifyPoolNoiseText('M15')).toBeUndefined();
    expect(classifyPoolNoiseText('W3L')).toBeUndefined();
    expect(classifyPoolNoiseText('AL1')).toBeUndefined();
    expect(classifyPoolNoiseText('L63')).toBeUndefined();
    expect(classifyPoolNoiseText('4mm')).toBeUndefined();
    expect(classifyPoolNoiseText('8cm')).toBeUndefined();
    expect(classifyPoolNoiseText('09m')).toBeUndefined();
    expect(classifyPoolNoiseText('0mm')).toBeUndefined();
    // 管径/数量/度量值形态
    expect(classifyPoolNoiseText('DN100')).toBeUndefined();
    expect(classifyPoolNoiseText('Φ400')).toBeUndefined();
    expect(classifyPoolNoiseText('3项')).toBeUndefined();
    expect(classifyPoolNoiseText('1.5m')).toBeUndefined();
    expect(classifyPoolNoiseText('0.08mm')).toBeUndefined();
    // 年份+月绑定 / 含约束词的实质内容：保留
    expect(classifyPoolNoiseText('2026年9月')).toBeUndefined();
    expect(classifyPoolNoiseText('确保一次性成活率95%')).toBeUndefined();
  });

  it('isPoolNoiseText 布尔包装与规则源清单（缓存指纹源非空）', () => {
    expect(isPoolNoiseText('R6C4项目特征描述')).toBe(true);
    expect(isPoolNoiseText('确保一次性成活率95%')).toBe(false);
    expect(POOL_NOISE_RULE_SOURCES.length).toBeGreaterThan(10);
    expect(POOL_NOISE_RULE_SOURCES.every(source => String(source).length > 0)).toBe(true);
  });
});
