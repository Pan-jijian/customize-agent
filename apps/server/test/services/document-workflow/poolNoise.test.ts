/**
 * D6 池噪声判定单测（要求池/参数池同源净化单源）：七类形态判据正样本全覆盖 + 防误伤守护反样本。
 * 加固点（D6 实机复算修正，r28l/s28l）：
 * - 门槛 3：表号标号「H.4/E.1/O.8」/独立月份「12月/08月」等 3 字符残片此前被 4 字符门槛遮蔽滞留池中；
 * - 图签守卫统一：双特征短路曾绕过约束词守卫，「投标人须提供工程设计甲级资质证书」类真实资格
 *   要求条款被误判出池——命任任一图签特征均须无约束词方可判定。
 * 判定为 L2 确定性纯函数：无 LLM 无 IO。
 */
import { describe, expect, it } from 'vitest';
import { classifyPoolNoiseText, POOL_NOISE_RULE_SOURCES, stripDuplicatedLabelEchoes } from '@/services/document-workflow/poolNoise';
import { stripClarificationNarrative, stripDrawingPointerPhrases } from '@/services/document-workflow/materialResidue';

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

  it('规则源清单（缓存指纹源非空）', () => {
    expect(POOL_NOISE_RULE_SOURCES.length).toBeGreaterThan(10);
    expect(POOL_NOISE_RULE_SOURCES.every(source => String(source).length > 0)).toBe(true);
  });
});

describe('4.55.12 参数池噪声扩围（巢湖实测缺失项形态）', () => {
  it('章节号+题名粘连（「2.1招标」）→ numeric_smear', () => {
    expect(classifyPoolNoiseText('2.1招标')).toBe('numeric_smear');
    expect(classifyPoolNoiseText('1.3.2计划工期')).toBe('numeric_smear');
  });
  it('计量单位结尾的正当值不受影响', () => {
    expect(classifyPoolNoiseText('1.5米')).toBeUndefined();
    expect(classifyPoolNoiseText('2.5m')).toBeUndefined();
    expect(classifyPoolNoiseText('3.2平方米')).toBeUndefined();
    expect(classifyPoolNoiseText('C30')).toBeUndefined();
    expect(classifyPoolNoiseText('MU20废渣混凝土实心砖')).toBeUndefined();
  });
  it('项目编号+序号粘连（「2026AFMGZ508282.3」）→ numeric_smear', () => {
    expect(classifyPoolNoiseText('2026AFMGZ508282.3')).toBe('numeric_smear');
  });
  it('页眉页码串格（「第页共页」）→ table_fragment', () => {
    expect(classifyPoolNoiseText('第页共页')).toBe('table_fragment');
  });
  it('叙述型长值不误伤（截断散文类判据因「建设地点位于…」误伤风险已放弃，见注释）', () => {
    expect(classifyPoolNoiseText('建设地点位于巢湖市居巢经开区义成路与南外环路交口北侧')).toBeUndefined();
    expect(classifyPoolNoiseText('巢湖市光电新能源产业园项目东区标准化厂房二标段位于巢湖市居巢')).toBeUndefined();
  });
});

describe('4.55.24 字段名复写（CAD 双写产物）判定与单源清理', () => {
  it('实测形态「条款号条款号条款名称条款名称编列内容编列内容…」→ duplicated_label', () => {
    expect(classifyPoolNoiseText('现澄清为如下：条款号条款号条款名称条款名称编列内容编列内容')).toBe('duplicated_label');
  });

  it('通用复写形态（规格数量规格数量）→ duplicated_label', () => {
    expect(classifyPoolNoiseText('规格数量规格数量')).toBe('duplicated_label');
  });

  it('固有四字重叠词与双字叠词不误伤', () => {
    expect(classifyPoolNoiseText('时时刻刻')).toBeUndefined();
    expect(classifyPoolNoiseText('一一对应各分项')).toBeUndefined();
    expect(classifyPoolNoiseText('分部分项工程')).toBeUndefined();
    expect(classifyPoolNoiseText('各项措施应落实到位')).toBeUndefined();
  });

  it('stripDuplicatedLabelEchoes 与池噪声闸同判据（单源）', () => {
    const single = stripDuplicatedLabelEchoes('规格数量规格数量');
    expect(single.removed).toBe(1);
    expect(single.text).toBe('');
    const preserved = stripDuplicatedLabelEchoes('时时刻刻注意安全');
    expect(preserved.removed).toBe(0);
    expect(preserved.text).toBe('时时刻刻注意安全');
  });
});

describe('4.55.24 变更过程叙述链尾清理（实测漏网句式）', () => {
  it('「招标阶段计划工期为365日历天，现澄清变更为330日历天」→ 删除变更叙述小句、保留现行值句', () => {
    const result = stripClarificationNarrative('本工程位于巢湖市居巢经开区义成路与南外环路交口北侧，招标阶段计划工期为365日历天，现澄清变更为330日历天，各阶段进度安排均按330日历天倒排控制');
    expect(result.removed).toBeGreaterThan(0);
    expect(result.text).not.toContain('365');
    expect(result.text).toContain('330日历天倒排控制');
    expect(result.text).toContain('巢湖市居巢经开区义成路');
  });

  it('「经澄清…调整为…」形态同样清理', () => {
    const result = stripClarificationNarrative('合同估算价经澄清文件调整为157166591.34元');
    expect(result.removed).toBeGreaterThan(0);
  });

  it('正常行文不误伤（「招标文件规定质量标准为合格」无变更语义）', () => {
    const result = stripClarificationNarrative('招标文件规定质量标准为合格，工期为330日历天');
    expect(result.removed).toBe(0);
    expect(result.text).toContain('330日历天');
  });

  it('幂等：重复清理结果不变', () => {
    const once = stripClarificationNarrative('招标阶段计划工期为365日历天，现澄清变更为330日历天，各阶段按330日历天控制');
    const twice = stripClarificationNarrative(once.text);
    expect(twice.text).toBe(once.text);
  });
});

describe('4.55.25 指向型表述链尾确定性清除（用户实测：技术标不能靠指向搪塞）', () => {
  it('实测形态「具体做法参见《钢筋混凝土及砖砌排水检查井》20S515/29」→ 整句删除', () => {
    const result = stripDrawingPointerPhrases('管道基础施工前应复核槽底标高。具体做法参见《钢筋混凝土及砖砌排水检查井》20S515/29。');
    expect(result.removed).toBeGreaterThan(0);
    expect(result.text).not.toContain('20S515');
    expect(result.text).toContain('管道基础施工前应复核槽底标高。');
  });

  it('句中嵌指向 → 只删该小句，句子其余内容保留', () => {
    const result = stripDrawingPointerPhrases('管道基础采用C20混凝土浇筑，具体做法参见《钢筋混凝土及砖砌排水检查井》20S515/29，管座与管基同步施工。');
    expect(result.text).toContain('管道基础采用C20混凝土浇筑');
    expect(result.text).toContain('管座与管基同步施工');
    expect(result.text).not.toContain('20S515');
  });

  it('「按设计图纸控制」「以图纸为准」「详见××大样图」「待补充」一并清除', () => {
    const result = stripDrawingPointerPhrases('室内外高差按设计图纸控制，散水做法详见图集大样图，垫层厚度待确认，混凝土强度等级C25。');
    expect(result.text).not.toMatch(/按设计图纸|大样图|待确认/u);
    expect(result.text).toContain('混凝土强度等级C25');
  });

  it('写实的做法与规范引用不误伤（编制依据/具体参数）', () => {
    const ok = '基础下做100厚碎石垫层，100厚C15混凝土垫层；执行《混凝土结构工程施工质量验收规范》GB50204-2015。';
    const result = stripDrawingPointerPhrases(ok);
    expect(result.removed).toBe(0);
    expect(result.text).toBe(ok);
  });
});
