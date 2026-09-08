/**
 * 第二十四批（AA 组）：覆盖最浅导出深挖之二——权威提取全谱系 + 双向厚度修复 + 规格错位豁免谱系。
 *
 * 基线说明：extractStreetLightAuthority（22 提及，L5 仅 3 条）/ extractProjectScaleSummary（23，L3 仅 3 条）/
 * fixFinishThickness（17，E 组仅 5 条）/ specLocationMismatchIssues（23，I 组约 16 条）/
 * fixSixHundredPercentCoverage（19，D 组约 12 条）/ stripCommercialDataBodyLines（12，Y4 约 7 条）。
 * 本文件对未探分支枚举：
 * - AA1 extractStreetLightAuthority：billItemFacts 优先级、bills/preciseFacts 兜底、三单位、工程量段、去重
 * - AA2 extractProjectScaleSummary：面积三单位、小数、层数来源（project/drawings/tables）、缺项组合
 * - AA3 fixFinishThickness：双向句式九语境词、100/999/1000 阈值、窗口 10/18 字边界、表格行阻断
 * - AA4 specLocationMismatchIssues：placement 门槛、七类标号模式、多权威集合、七豁免谱系、8 条截断
 * - AA5 fixSixHundredPercentCoverage：锚点三级兜底、插入位置、拆迁豁免增量
 * - AA6 stripCommercialDataBodyLines：行内删句留后句、混合行、标题/表格保留
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';
import {
  extractProjectScaleSummary, extractStreetLightAuthority, fixFinishThickness,
  fixSixHundredPercentCoverage, specLocationMismatchIssues,
  stripCommercialDataBodyLines,
} from '@/services/document-workflow/documentIntegrityChecks';
import type { SpecAuthorityMap } from '@/services/document-workflow/types';
import { factOf, factsOf } from './boundaryKit';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

/** 六项共享词模拟器（与 dicFixersBoundary 同源）：query/句共享扬尘词即 0.9 */
const SIX_PERCENT_SIM = async (_leftTexts: string[], _rightTexts: string[]) => (left: string, right: string): number => {
  const kw = ['围挡', '覆盖', '冲洗', '硬化', '湿法', '密闭'];
  return kw.some(word => left.includes(word) && right.includes(word)) ? 0.9 : 0.1;
};

function specMap(entries: Record<string, Array<[string, string]>>): SpecAuthorityMap {
  const map: SpecAuthorityMap = {};
  for (const [dimension, placements] of Object.entries(entries)) {
    map[dimension] = placements.map(([location, spec]) => ({ location, spec, sourceFile: '清单' }));
  }
  return map;
}

describe('AA1 extractStreetLightAuthority 路灯数量权威全谱系', () => {
  it('AA1 billItemFacts 优先于 bills（同有路灯只取 billItemFacts）', () => {
    const model = factsOf({
      billItemFacts: [factOf({ key: '路灯', value: 'LED路灯｜工程量：10套' })],
      bills: [factOf({ key: '路灯安装', value: '100套' })],
    });
    expect(extractStreetLightAuthority(model)).toBe(10);
  });
  it('AA1 无 billItemFacts → bills 兜底', () => {
    const model = factsOf({ bills: [factOf({ key: '路灯', value: 'LED路灯100套' })] });
    expect(extractStreetLightAuthority(model)).toBe(100);
  });
  it('AA1 无 billItemFacts/bills → preciseFacts 兜底', () => {
    const model = factsOf({ preciseFacts: [factOf({ fieldName: '路灯数量', value: '庭院灯36盏' })] });
    expect(extractStreetLightAuthority(model)).toBe(36);
  });
  it('AA1 盏单位提取', () => {
    const model = factsOf({ billItemFacts: [factOf({ key: '路灯', value: '庭院灯｜工程量：36盏' })] });
    expect(extractStreetLightAuthority(model)).toBe(36);
  });
  it('AA1 杆单位提取', () => {
    const model = factsOf({ billItemFacts: [factOf({ key: '路灯', value: '高杆灯｜工程量：8杆' })] });
    expect(extractStreetLightAuthority(model)).toBe(8);
  });
  it('AA1 无「｜工程量：」段 → 全值直接匹配', () => {
    const model = factsOf({ billItemFacts: [factOf({ key: '路灯', value: 'LED路灯25套' })] });
    expect(extractStreetLightAuthority(model)).toBe(25);
  });
  it('AA1 工程量段多处数字求和', () => {
    const model = factsOf({ billItemFacts: [factOf({ key: '路灯', value: '路灯｜工程量：A型30套、B型20套' })] });
    expect(extractStreetLightAuthority(model)).toBe(50);
  });
  it('AA1 0 套过滤 → undefined', () => {
    const model = factsOf({ billItemFacts: [factOf({ key: '路灯', value: '路灯｜工程量：0套' })] });
    expect(extractStreetLightAuthority(model)).toBeUndefined();
  });
  it('AA1 label 不含路灯（key/fieldName/fieldId 均无）→ 不采', () => {
    const model = factsOf({ bills: [factOf({ key: '景观照明', value: '庭院灯36盏' })] });
    expect(extractStreetLightAuthority(model)).toBeUndefined();
  });
  it('AA1 无路灯事实 → undefined', () => {
    expect(extractStreetLightAuthority(factsOf({}))).toBeUndefined();
  });
  it('AA1 null model → undefined', () => {
    expect(extractStreetLightAuthority(null)).toBeUndefined();
  });
  it('AA1 特征段含「套」字不误采（只取工程量段）', () => {
    const model = factsOf({ billItemFacts: [factOf({ key: '路灯', value: '庭院灯｜特征：灯罩套件｜工程量：20套' })] });
    expect(extractStreetLightAuthority(model)).toBe(20);
  });
  it('AA1 多事实跨类型累加（billItemFacts 两条求和）', () => {
    const model = factsOf({
      billItemFacts: [
        factOf({ key: '路灯', value: 'LED路灯｜工程量：103套' }),
        factOf({ key: '路灯', value: '太阳能路灯｜工程量：15套' }),
      ],
    });
    expect(extractStreetLightAuthority(model)).toBe(118);
  });
  it('AA1 非数字量词不采（约50套）', () => {
    const model = factsOf({ billItemFacts: [factOf({ key: '路灯', value: '路灯｜工程量：约50套' })] });
    expect(extractStreetLightAuthority(model)).toBe(50);
  });
});

describe('AA2 extractProjectScaleSummary 工程规模摘要深挖', () => {
  it('AA2 建设规模 label 命中', () => {
    const model = factsOf({ project: [factOf({ fieldName: '建设规模', value: '总建设规模8000平方米' })] });
    expect(extractProjectScaleSummary(model)).toBe('建筑面积8000平方米');
  });
  it('AA2 label 不命中跳过（建筑面积）', () => {
    const model = factsOf({ project: [factOf({ fieldName: '建筑面积', value: '12000平方米' })] });
    expect(extractProjectScaleSummary(model)).toBeUndefined();
  });
  it('AA2 ㎡ 单位', () => {
    const model = factsOf({ project: [factOf({ fieldName: '单体建筑面积', value: '12000㎡' })] });
    expect(extractProjectScaleSummary(model)).toBe('建筑面积12000平方米');
  });
  it('AA2 m² 单位', () => {
    const model = factsOf({ project: [factOf({ fieldName: '单体建筑面积', value: '12000m²' })] });
    expect(extractProjectScaleSummary(model)).toBe('建筑面积12000平方米');
  });
  it('AA2 小数面积', () => {
    const model = factsOf({ project: [factOf({ fieldName: '单体建筑面积', value: '12000.5平方米' })] });
    expect(extractProjectScaleSummary(model)).toBe('建筑面积12000.5平方米');
  });
  it('AA2 无面积只层数（project 文本）', () => {
    const model = factsOf({ project: [factOf({ value: '地上18层，地下1层' })] });
    expect(extractProjectScaleSummary(model)).toBe('地上18层、地下1层');
  });
  it('AA2 只地上层', () => {
    const model = factsOf({ project: [factOf({ value: '地上6层' })] });
    expect(extractProjectScaleSummary(model)).toBe('地上6层');
  });
  it('AA2 只地下层', () => {
    const model = factsOf({ project: [factOf({ value: '地下2层' })] });
    expect(extractProjectScaleSummary(model)).toBe('地下2层');
  });
  it('AA2 层数来自 drawings', () => {
    const model = factsOf({ drawings: [factOf({ value: '地上3层' })] });
    expect(extractProjectScaleSummary(model)).toBe('地上3层');
  });
  it('AA2 层数来自 tables', () => {
    const model = factsOf({ tables: [{ tableType: '主体概况表', headers: ['层数'], rows: [['地下1层']], sourceFile: '清单' }] });
    expect(extractProjectScaleSummary(model)).toBe('地下1层');
  });
  it('AA2 层数空白格（地上 18 层）', () => {
    const model = factsOf({ project: [factOf({ value: '地上 18 层' })] });
    expect(extractProjectScaleSummary(model)).toBe('地上18层');
  });
  it('AA2 全缺 → undefined', () => {
    expect(extractProjectScaleSummary(factsOf({}))).toBeUndefined();
  });
  it('AA2 null model → undefined', () => {
    expect(extractProjectScaleSummary(null)).toBeUndefined();
  });
  it('AA2 面积+层数全组合顺序', () => {
    const model = factsOf({
      project: [factOf({ fieldName: '单体建筑面积', value: '12000平方米' })],
      drawings: [factOf({ value: '地上18层，地下1层' })],
    });
    expect(extractProjectScaleSummary(model)).toBe('建筑面积12000平方米、地上18层、地下1层');
  });
  it('AA2 面积值非数字（匹配失败）→ 只层数', () => {
    const model = factsOf({
      project: [factOf({ fieldName: '单体建筑面积', value: '建筑面积详见规划证' })],
      drawings: [factOf({ value: '地上5层' })],
    });
    expect(extractProjectScaleSummary(model)).toBe('地上5层');
  });
});

describe('AA3 fixFinishThickness 双向句式深挖', () => {
  it.each(['抹面', '打底', '找平', '坐浆', '结合层', '粘结层', '罩面', '批嵌', '腻子'] as const)('AA3 句式1 语境词「%s」200→20', (word) => {
    const result = fixFinishThickness(`${word}厚度200mm。`);
    expect(result.markdown).toBe(`${word}厚度20mm。`);
    expect(result.fixedCount).toBe(1);
  });
  it('AA3 句式2 数字前 mm厚后语境词', () => {
    const result = fixFinishThickness('200mm厚找平层。');
    expect(result.markdown).toBe('20mm厚找平层。');
    expect(result.fixedCount).toBe(1);
  });
  it('AA3 句式2 mm 后无厚字仍匹配', () => {
    const result = fixFinishThickness('200mm找平层。');
    expect(result.markdown).toBe('20mm找平层。');
  });
  it('AA3 100 → 10', () => {
    expect(fixFinishThickness('抹面厚度100mm。').markdown).toBe('抹面厚度10mm。');
  });
  it('AA3 999 → 100（四舍五入）', () => {
    expect(fixFinishThickness('抹面厚度999mm。').markdown).toBe('抹面厚度100mm。');
  });
  it('AA3 1000 → 100', () => {
    expect(fixFinishThickness('抹面厚度1000mm。').markdown).toBe('抹面厚度100mm。');
  });
  it('AA3 99mm 不修（<100）', () => {
    expect(fixFinishThickness('抹面厚度99mm。').fixedCount).toBe(0);
  });
  it('AA3 非装饰语境不修（墙体厚度200mm）', () => {
    expect(fixFinishThickness('墙体厚度200mm。').fixedCount).toBe(0);
  });
  it('AA3 句式1 窗口恰 10 字命中', () => {
    const result = fixFinishThickness(`抹面${'字'.repeat(10)}200mm。`);
    expect(result.markdown).toContain('20mm');
  });
  it('AA3 句式1 窗口 11 字不修', () => {
    expect(fixFinishThickness(`抹面${'字'.repeat(11)}200mm。`).fixedCount).toBe(0);
  });
  it('AA3 句式2 窗口恰 18 字命中', () => {
    const result = fixFinishThickness(`200mm厚${'字'.repeat(18)}找平层。`);
    expect(result.markdown).toContain('20mm');
  });
  it('AA3 句式2 窗口 19 字不修', () => {
    expect(fixFinishThickness(`200mm厚${'字'.repeat(19)}找平层。`).fixedCount).toBe(0);
  });
  it('AA3 多处同时修复', () => {
    const result = fixFinishThickness('抹面厚度200mm，坐浆厚度300mm。');
    expect(result.markdown).toBe('抹面厚度20mm，坐浆厚度30mm。');
    expect(result.fixedCount).toBe(2);
    expect(result.details).toHaveLength(2);
  });
  it('AA3 details 记录换算值', () => {
    const result = fixFinishThickness('抹面厚度200mm。');
    expect(result.details[0]).toContain('200mm→20mm');
  });
  it('AA3 表格行内数值不修（| 阻断）', () => {
    const md = '| 装饰面层 | 抹面厚度 | 200mm |';
    expect(fixFinishThickness(md).fixedCount).toBe(0);
  });
  it('AA3 换行阻断', () => {
    expect(fixFinishThickness('抹面厚度\n200mm。').fixedCount).toBe(0);
  });
  it('AA3 无 mm 后缀不修', () => {
    expect(fixFinishThickness('抹面厚度200厘米。').fixedCount).toBe(0);
  });
});

describe('AA4 specLocationMismatchIssues 豁免与模式谱系增量', () => {
  it('AA4 维度 placements<2 跳过', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15']] });
    expect(specLocationMismatchIssues('垫层采用C20混凝土。', map)).toEqual([]);
  });
  it('AA4 location 空跳过', () => {
    const map = specMap({ 混凝土强度等级: [['', 'C15'], ['主体', 'C35']] });
    expect(specLocationMismatchIssues('采用C20混凝土。', map)).toEqual([]);
  });
  it('AA4 location 单字跳过（length<2）', () => {
    const map = specMap({ 混凝土强度等级: [['层', 'C15'], ['主体', 'C35']] });
    expect(specLocationMismatchIssues('层采用C20混凝土。', map)).toEqual([]);
  });
  it('AA4 spec 空跳过', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', ''], ['主体', 'C35']] });
    expect(specLocationMismatchIssues('垫层采用C20混凝土。', map)).toEqual([]);
  });
  it('AA4 spec 类型不可推导跳过（Q235）', () => {
    const map = specMap({ 钢筋类型: [['垫层', 'Q235'], ['主体', 'HRB400']] });
    expect(specLocationMismatchIssues('垫层采用Q235。', map)).toEqual([]);
  });
  it('AA4 未传 map → 空', () => {
    expect(specLocationMismatchIssues('垫层采用C20混凝土。')).toEqual([]);
  });
  it('AA4 空 map 对象 → 空', () => {
    expect(specLocationMismatchIssues('垫层采用C20混凝土。', {})).toEqual([]);
  });
  it('AA4 P 标号模式错位报', () => {
    const map = specMap({ 管材压力等级: [['给水管', 'P8'], ['排水管', 'P6']] });
    const issues = specLocationMismatchIssues('给水管采用P10。', map);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('P10');
  });
  it('AA4 M 标号模式错位报', () => {
    const map = specMap({ 砌筑砂浆等级: [['填充墙', 'M5'], ['承重墙', 'M7.5']] });
    const issues = specLocationMismatchIssues('填充墙采用M10砂浆。', map);
    expect(issues).toHaveLength(1);
  });
  it('AA4 A 标号模式错位报', () => {
    const map = specMap({ 加气块等级: [['隔墙', 'A5.0'], ['外墙', 'A3.5']] });
    const issues = specLocationMismatchIssues('隔墙采用A3.5加气块。', map);
    expect(issues).toHaveLength(1);
  });
  it('AA4 HRB 模式错位报', () => {
    const map = specMap({ 钢筋类型: [['梁体', 'HRB400'], ['板面', 'HRB335']] });
    const issues = specLocationMismatchIssues('梁体采用HRB335钢筋。', map);
    expect(issues).toHaveLength(1);
  });
  it('AA4 同 location 多权威 specs message 列出全部', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15'], ['垫层', 'C20'], ['主体', 'C35']] });
    const issues = specLocationMismatchIssues('垫层采用C25混凝土。', map);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('C15/C20');
  });
  it('AA4 权威 spec 命中不报', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15'], ['主体', 'C35']] });
    expect(specLocationMismatchIssues('垫层采用C15混凝土。', map)).toEqual([]);
  });
  it('AA4 多 location 独立判定报 2 条', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15'], ['主体', 'C35']] });
    const issues = specLocationMismatchIssues('垫层采用C20。主体采用C30。', map);
    expect(issues).toHaveLength(2);
  });
  it('AA4 工作宽度后置豁免', () => {
    const map = specMap({ 板材厚度: [['垫层', '120mm'], ['屋面', '80mm']] });
    expect(specLocationMismatchIssues('垫层两侧各200mm工作宽度。', map)).toEqual([]);
  });
  it('AA4 顿号枚举后置豁免', () => {
    const map = specMap({ 板材厚度: [['垫层', '120mm'], ['屋面', '80mm']] });
    expect(specLocationMismatchIssues('垫层200mm、150mm分层铺设。', map)).toEqual([]);
  });
  it('AA4 范围内豁免', () => {
    const map = specMap({ 板材厚度: [['垫层', '300mm'], ['屋面', '80mm']] });
    expect(specLocationMismatchIssues('垫层槽底200mm范围内人工清底。', map)).toEqual([]);
  });
  it('AA4 标高偏差豁免', () => {
    const map = specMap({ 板材厚度: [['垫层', '300mm'], ['屋面', '80mm']] });
    expect(specLocationMismatchIssues('垫层槽底标高偏差不超过±200mm。', map)).toEqual([]);
  });
  it('AA4 再浇筑工序切换豁免', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15'], ['主体', 'C35']] });
    expect(specLocationMismatchIssues('垫层完成后，再浇筑C30混凝土。', map)).toEqual([]);
  });
  it('AA4 枚举声明豁免（分别为）', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15'], ['主体', 'C35']] });
    expect(specLocationMismatchIssues('垫层与主体分别为C15、C35。', map)).toEqual([]);
  });
  it('AA4 分层厚度工艺参数豁免', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15'], ['主体', 'C35']] });
    expect(specLocationMismatchIssues('垫层按分层厚度300mm浇筑C30。', map)).toEqual([]);
  });
  it('AA4 8 条截断', () => {
    const map = specMap({ 混凝土强度等级: [['垫层', 'C15'], ['主体', 'C35']] });
    const md = Array.from({ length: 12 }, () => '垫层采用C20混凝土。').join('\n');
    expect(specLocationMismatchIssues(md, map)).toHaveLength(8);
  });
});

describe('AA5 fixSixHundredPercentCoverage 锚点兜底增量', () => {
  beforeEach(() => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(SIX_PERCENT_SIM);
  });

  it('AA5 无扬尘词面 → 早退', async () => {
    const result = await fixSixHundredPercentCoverage('本工程施工管理规范。');
    expect(result.fixedCount).toBe(0);
  });
  it('AA5 主锚点 100%围挡行后插入', async () => {
    const md = '## 扬尘治理\n\n现场落实100%围挡要求。\n\n后文。';
    const result = await fixSixHundredPercentCoverage(md);
    const lines = result.markdown.split('\n');
    const anchorIndex = lines.findIndex(line => line.includes('100%围挡要求'));
    expect(lines[anchorIndex + 1]).toContain('物料堆放100%覆盖：');
  });
  it('AA5 锚点失效 → 扬尘标题小节尾部兜底', async () => {
    const md = '## 文明施工\n\n### 5.1 扬尘防治措施\n\n安排专人清扫。\n\n### 5.2 噪声控制\n\n控制施工噪声。';
    const result = await fixSixHundredPercentCoverage(md);
    const lines = result.markdown.split('\n');
    const noiseIndex = lines.findIndex(line => line.includes('噪声控制'));
    const inserted = lines.slice(Math.max(0, noiseIndex - 8), noiseIndex).join('\n');
    expect(inserted).toContain('施工工地周边100%围挡：');
    expect(inserted).toContain('渣土车辆100%密闭运输：');
  });
  it('AA5 扬尘小节后无下一标题 → 文档尾插入', async () => {
    const md = '## 环保措施\n\n扬尘控制措施。';
    const result = await fixSixHundredPercentCoverage(md);
    const lines = result.markdown.split('\n');
    expect(lines[lines.length - 1]).toContain('渣土车辆100%密闭运输：');
  });
  it('AA5 无扬尘标题 → 环保标题兜底', async () => {
    const md = '## 环保措施\n\n安排专人清扫。\n\n## 其他章节\n\n其他内容。';
    const result = await fixSixHundredPercentCoverage(md);
    const lines = result.markdown.split('\n');
    const otherIndex = lines.findIndex(line => line.includes('其他章节'));
    const inserted = lines.slice(Math.max(0, otherIndex - 8), otherIndex).join('\n');
    expect(inserted).toContain('施工工地周边100%围挡：');
  });
  it('AA5 无扬尘无环保 → 文明施工标题兜底', async () => {
    const md = '## 文明施工\n\n安排专人清扫。\n\n## 其他章节\n\n其他内容。';
    const result = await fixSixHundredPercentCoverage(md);
    const lines = result.markdown.split('\n');
    const otherIndex = lines.findIndex(line => line.includes('其他章节'));
    const inserted = lines.slice(Math.max(0, otherIndex - 8), otherIndex).join('\n');
    expect(inserted).toContain('施工工地周边100%围挡：');
  });
  it('AA5 部分缺失补写 fixedCount=缺失数', async () => {
    const md = '## 扬尘治理\n\n施工工地周边100%围挡、物料堆放100%覆盖。';
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.fixedCount).toBe(4);
    expect(result.markdown).not.toContain('施工工地周边100%围挡：');
    expect(result.markdown).toContain('出入车辆100%冲洗：');
  });
  it('AA5 六项齐全不补写', async () => {
    const md = '## 扬尘治理\n\n施工工地周边100%围挡、物料堆放100%覆盖、出入车辆100%冲洗、施工现场地面100%硬化、拆迁工地100%湿法作业、渣土车辆100%密闭运输。';
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.fixedCount).toBe(0);
  });
  it('AA5 拆迁豁免（本项目无拆迁）→ 湿法项不补写', async () => {
    const md = '## 扬尘治理\n\n本项目无拆迁。施工工地周边100%围挡、物料堆放100%覆盖、出入车辆100%冲洗、施工现场地面100%硬化、渣土车辆100%密闭运输。';
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.fixedCount).toBe(0);
  });
  it('AA5 details 列出缺失项', async () => {
    const md = '## 扬尘治理\n\n现场安排专人清扫保洁。';
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.fixedCount).toBe(6);
    expect(result.details[0]).toContain('扬尘六个百分百补写');
  });
  it('AA5 标题行与表格行不参与预筛（补写六项）', async () => {
    const md = '## 扬尘治理\n\n### 围挡措施\n\n| 冲洗 | 硬化 |\n| --- | --- |\n| 落实 | 落实 |';
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.fixedCount).toBe(6);
  });
  it('AA5 补写句不触碰既有清单内容', async () => {
    const md = '## 扬尘治理\n\n施工工地周边100%围挡。\n既有说明文字。';
    const result = await fixSixHundredPercentCoverage(md);
    expect(result.markdown).toContain('既有说明文字');
    expect(result.fixedCount).toBe(5);
  });
});

describe('AA6 stripCommercialDataBodyLines 行级清洗增量', () => {
  it('AA6 行内删前句留后句', () => {
    const md = '暂列金额为60万元。后续施工按合同约定执行。';
    expect(stripCommercialDataBodyLines(md)).toBe('后续施工按合同约定执行。');
  });
  it('AA6 行内删后句留前句', () => {
    const md = '工程概况说明。暂列金额为60万元。';
    expect(stripCommercialDataBodyLines(md)).toBe('工程概况说明。');
  });
  it('AA6 纯强词句整行删空', () => {
    expect(stripCommercialDataBodyLines('暂列金额为60万元。')).toBe('');
  });
  it('AA6 税率数字句删', () => {
    expect(stripCommercialDataBodyLines('本项目增值税税率为9%。')).toBe('');
  });
  it('AA6 税率无数字保留', () => {
    expect(stripCommercialDataBodyLines('增值税按国家规定执行。')).toBe('增值税按国家规定执行。');
  });
  it('AA6 标题行保留', () => {
    expect(stripCommercialDataBodyLines('## 暂列金额说明')).toBe('## 暂列金额说明');
  });
  it('AA6 表格行保留', () => {
    expect(stripCommercialDataBodyLines('| 暂列金额 | 60万元 |')).toBe('| 暂列金额 | 60万元 |');
  });
  it('AA6 无关行保留', () => {
    expect(stripCommercialDataBodyLines('工程概况说明。')).toBe('工程概况说明。');
  });
  it('AA6 多行多处清洗', () => {
    const md = '暂列金额为60万元。\n工程概况。\n综合单价见清单。';
    expect(stripCommercialDataBodyLines(md)).toBe('\n工程概况。\n');
  });
  it('AA6 空行保留', () => {
    expect(stripCommercialDataBodyLines('\n\n')).toBe('\n\n');
  });
  it('AA6 分号分句删单句', () => {
    const md = '暂列金额为60万元；后续按合同执行。';
    expect(stripCommercialDataBodyLines(md)).toBe('后续按合同执行。');
  });
});
