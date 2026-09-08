/**
 * 第十三批边界矩阵（O 组）：数值权威互查族。
 * 覆盖：装饰层厚度（O1）、绿化养护期（O2）、路灯数量（O3）、
 * 基坑深度锁定与危大分级（O4）、设备进场时序（O5）。
 */
import { describe, expect, it } from 'vitest';
import {
  equipmentEntryTimingIssues,
  excavationDepthFromFacts,
  excavationDepthLockIssues,
  excavationHazardClassificationIssues,
  extractGreeningMaintenanceAuthority,
  extractStreetLightAuthority,
  finishThicknessIssues,
  fixFinishThickness,
  greeningMaintenanceMismatchIssues,
  streetLightCountMismatchIssues,
} from '@/services/document-workflow/documentIntegrityChecks';
import { factOf, factsOf } from './boundaryKit';

describe('O1 装饰层厚度：finishThicknessIssues + fixFinishThickness', () => {
  it('O1-1 抹面200mm报工艺参数异常', () => {
    const issues = finishThicknessIssues('抹面200mm。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('200');
  });
  it.each([
    ['抹面', '抹面200mm。'],
    ['打底', '打底150mm。'],
    ['找平', '找平层厚度为120mm。'],
    ['坐浆', '坐浆200mm。'],
    ['结合层', '结合层100mm。'],
    ['粘结层', '粘结层120mm。'],
    ['罩面', '罩面130mm。'],
    ['批嵌', '批嵌100mm。'],
    ['腻子', '腻子批刮200mm。'],
  ])('O1-2 语境词谱系：%s 命中', (_label, md) => {
    expect(finishThicknessIssues(md)).toHaveLength(1);
  });
  it('O1-3 100mm边界报（>=100）', () => {
    expect(finishThicknessIssues('抹面100mm。')).toHaveLength(1);
  });
  it('O1-4 两位数厚度不报：抹面99mm', () => {
    expect(finishThicknessIssues('抹面99mm。')).toHaveLength(0);
  });
  it('O1-5 常规厚度不报：抹面20mm', () => {
    expect(finishThicknessIssues('抹面20mm。')).toHaveLength(0);
  });
  it('O1-6 结构层厚度不误报：垫层150mm/墙体200mm', () => {
    expect(finishThicknessIssues('垫层150mm，墙体200mm。')).toHaveLength(0);
  });
  it('O1-7 反向形态命中：200mm厚抹面', () => {
    expect(finishThicknessIssues('200mm厚抹面。')).toHaveLength(1);
  });
  it('O1-8 反向形态词表外不命中：200mm厚抹灰层（抹灰不在词表）', () => {
    expect(finishThicknessIssues('200mm厚抹灰层。')).toHaveLength(0);
  });
  it('O1-9 语境窗口10字符外不命中：抹面与数字隔12字符', () => {
    expect(finishThicknessIssues('抹面分层施工，每层厚度控制在200mm。')).toHaveLength(0);
  });
  it('O1-9b 语境窗口恰好10字符命中（窗口含边界）', () => {
    expect(finishThicknessIssues('抹面施工，每层厚度控制在200mm。')).toHaveLength(1);
  });
  it('O1-10 表格行排除', () => {
    expect(finishThicknessIssues('| 抹面 | 200mm | 备注 |')).toHaveLength(0);
  });
  it('O1-11 多命中聚合为单条issue且去重', () => {
    const issues = finishThicknessIssues('抹面200mm，找平200mm，抹面200mm。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('抹面');
    expect(issues[0].message).toContain('找平');
  });
  it('O1-12 fixFinishThickness除以10：200→20、150→15', () => {
    const result = fixFinishThickness('抹面200mm，找平150mm。');
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toContain('抹面20mm');
    expect(result.markdown).toContain('找平15mm');
  });
  it('O1-13 fix反向形态：200mm厚抹面→20mm厚抹面', () => {
    const result = fixFinishThickness('200mm厚抹面。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('20mm厚抹面');
  });
  it('O1-14 fix边界：100→10', () => {
    const result = fixFinishThickness('抹面100mm。');
    expect(result.markdown).toContain('抹面10mm');
  });
  it('O1-15 fix不动结构层厚度：垫层150mm保持', () => {
    const result = fixFinishThickness('垫层150mm。');
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('垫层150mm');
  });
  it('O1-16 fix只替换窗口内目标数字：抹面2层200mm→抹面2层20mm', () => {
    const result = fixFinishThickness('抹面2层200mm。');
    expect(result.markdown).toContain('抹面2层20mm');
  });
});

describe('O2 绿化养护期：greeningMaintenanceMismatchIssues + extractGreeningMaintenanceAuthority', () => {
  const authorityModel = (value: string) => factsOf({ bills: [factOf({ key: '绿化养护', value })] });

  it('O2-1 正文一年 vs 清单两年报矛盾', () => {
    const issues = greeningMaintenanceMismatchIssues('绿化养护期一年。', authorityModel('养护两年'));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('1年');
  });
  it('O2-2 正文与清单一致不报：两年 vs 两年', () => {
    expect(greeningMaintenanceMismatchIssues('绿化养护期两年。', authorityModel('养护两年'))).toHaveLength(0);
  });
  it('O2-3 差异20%边界：权威10年，正文12年不报、13年报', () => {
    expect(greeningMaintenanceMismatchIssues('绿化养护期12年。', authorityModel('养护十年'))).toHaveLength(0);
    expect(greeningMaintenanceMismatchIssues('绿化养护期13年。', authorityModel('养护十年'))).toHaveLength(1);
  });
  it('O2-4 中文数字谱系解析：一/两/十/十五', () => {
    const model = authorityModel('养护两年');
    expect(greeningMaintenanceMismatchIssues('绿化养护期一年。', model)).toHaveLength(1);
    expect(greeningMaintenanceMismatchIssues('绿化养护期十年。', model)).toHaveLength(1);
    expect(greeningMaintenanceMismatchIssues('绿化养护期十五年。', model)).toHaveLength(1);
  });
  it('O2-5 阿拉伯数字形态：养护1年', () => {
    expect(greeningMaintenanceMismatchIssues('绿化养护期1年。', authorityModel('养护两年'))).toHaveLength(1);
  });
  it('O2-6 否定声明句豁免：不再出现养护一年', () => {
    expect(greeningMaintenanceMismatchIssues('统一为两年，不再出现养护一年。', authorityModel('养护两年'))).toHaveLength(0);
  });
  it('O2-7 表格行排除', () => {
    expect(greeningMaintenanceMismatchIssues('| 养护 | 一年 |', authorityModel('养护两年'))).toHaveLength(0);
  });
  it('O2-8 无清单权威早退', () => {
    expect(greeningMaintenanceMismatchIssues('绿化养护期一年。', factsOf({}))).toHaveLength(0);
  });
  it('O2-9 正文无养护期表述不报', () => {
    expect(greeningMaintenanceMismatchIssues('本项目绿化工程按时完成。', authorityModel('养护两年'))).toHaveLength(0);
  });
  it('O2-10 权威提取：天单位不采（混凝土养护14天）', () => {
    expect(extractGreeningMaintenanceAuthority(factsOf({ bills: [factOf({ key: '混凝土', value: '混凝土养护14天' })] }))).toBeUndefined();
  });
  it('O2-11 权威提取：中文数字两年', () => {
    expect(extractGreeningMaintenanceAuthority(authorityModel('养护两年'))).toBe(2);
  });
  it('O2-12 权威提取：超20年不采', () => {
    expect(extractGreeningMaintenanceAuthority(authorityModel('养护三十年'))).toBeUndefined();
  });
  it('O2-13 权威提取：label命中（value无语境词时label提供）', () => {
    const model = factsOf({ bills: [factOf({ fieldName: '养护期一年', value: '—' })] });
    expect(extractGreeningMaintenanceAuthority(model)).toBe(1);
  });
  it('O2-14 权威提取：数据源分层bills优先首命中', () => {
    const model = factsOf({
      bills: [factOf({ key: '绿化养护', value: '养护三年' })],
      preciseFacts: [factOf({ key: '绿化养护', value: '养护两年' })],
    });
    expect(extractGreeningMaintenanceAuthority(model)).toBe(3);
  });
});

describe('O3 路灯数量：streetLightCountMismatchIssues + extractStreetLightAuthority', () => {
  const streetLightModel = (authority: number) => factsOf({
    billItemFacts: [factOf({ key: '路灯', value: `庭院灯｜特征：灯罩套件齐全｜工程量：${authority}套` })],
  });

  it('O3-1 正文17套 vs 清单118套报矛盾', () => {
    const issues = streetLightCountMismatchIssues('路灯17套。', streetLightModel(118));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('17');
  });
  it('O3-2 差异20%边界：权威100，正文80不报、79报', () => {
    expect(streetLightCountMismatchIssues('路灯80套。', streetLightModel(100))).toHaveLength(0);
    expect(streetLightCountMismatchIssues('路灯79套。', streetLightModel(100))).toHaveLength(1);
  });
  it('O3-3 分型号多值求和：17+3=20 vs 权威25不报（只采17会误报）', () => {
    expect(streetLightCountMismatchIssues('路灯100W17套，路灯120W3套。', streetLightModel(25))).toHaveLength(0);
  });
  it('O3-4 单位谱系：套/盏/杆均采', () => {
    expect(streetLightCountMismatchIssues('路灯18盏。', streetLightModel(118))).toHaveLength(1);
    expect(streetLightCountMismatchIssues('路灯18杆。', streetLightModel(118))).toHaveLength(1);
  });
  it('O3-5 「分批/每批」批次口径豁免', () => {
    expect(streetLightCountMismatchIssues('路灯分2批每批10套。', streetLightModel(118))).toHaveLength(0);
  });
  it('O3-6 否定声明句豁免：不再出现路灯17套', () => {
    expect(streetLightCountMismatchIssues('统一为118套，不再出现路灯17套。', streetLightModel(118))).toHaveLength(0);
  });
  it('O3-7 无清单权威早退', () => {
    expect(streetLightCountMismatchIssues('路灯17套。', factsOf({}))).toHaveLength(0);
  });
  it('O3-8 28字符窗口外不采', () => {
    expect(streetLightCountMismatchIssues('路灯工程共计安装庭院灯、高杆灯、庭院灯、草坪灯、庭院灯等各类灯具17套。', streetLightModel(118))).toHaveLength(0);
  });
  it('O3-9 权威提取：billItemFacts「｜工程量：」段取值防特征套字误采', () => {
    const model = factsOf({ billItemFacts: [factOf({ key: '路灯', value: '路灯杆件｜特征：含2套备件｜工程量：20套' })] });
    expect(extractStreetLightAuthority(model)).toBe(20);
  });
  it('O3-10 权威提取：分型号多行求和103+15=118', () => {
    const model = factsOf({
      billItemFacts: [
        factOf({ key: '路灯', value: '庭院灯｜工程量：103套' }),
        factOf({ key: '路灯', value: '庭院灯｜工程量：15套' }),
      ],
    });
    expect(extractStreetLightAuthority(model)).toBe(118);
  });
  it('O3-11 权威提取：无行级条目时bills+preciseFacts兜底', () => {
    const model = factsOf({ bills: [factOf({ key: '路灯', value: '路灯18盏' })] });
    expect(extractStreetLightAuthority(model)).toBe(18);
  });
  it('O3-12 权威提取：label无路灯不采', () => {
    const model = factsOf({ bills: [factOf({ key: '庭院灯', value: '10套' })] });
    expect(extractStreetLightAuthority(model)).toBeUndefined();
  });
  it('O3-13 权威提取：同对象引用去重（bills+preciseFacts同一fact只计一次）', () => {
    const shared = factOf({ key: '路灯', value: '20套' });
    const model = factsOf({ bills: [shared], preciseFacts: [shared] });
    expect(extractStreetLightAuthority(model)).toBe(20);
  });
});

describe('O4 基坑深度锁定与危大分级', () => {
  it('O4-1 基坑语境≥3处且无深度数值报未锁定', () => {
    const issues = excavationDepthLockIssues('基坑开挖。基坑支护。边坡支护。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('未锁定');
  });
  it('O4-2 基坑语境不足3处不检', () => {
    expect(excavationDepthLockIssues('基坑开挖。')).toHaveLength(0);
  });
  it('O4-3 确定性深度表述锁定：开挖深度5.85m不报', () => {
    expect(excavationDepthLockIssues('基坑开挖深度5.85m。基坑支护。边坡支护。')).toHaveLength(0);
  });
  it('O4-4 「约/为/达」允许：开挖深度约为5.85m视为锁定', () => {
    expect(excavationDepthLockIssues('基坑开挖深度约为5.85m。基坑支护。边坡支护。')).toHaveLength(0);
  });
  it('O4-5 比较式阈值不算锁定：超过3m报未锁定', () => {
    const issues = excavationDepthLockIssues('基坑开挖。基坑支护。边坡支护。开挖深度超过3m的基坑属危大工程。');
    expect(issues).toHaveLength(1);
  });
  it('O4-6 按图式不算锁定：按图纸确定报未锁定', () => {
    expect(excavationDepthLockIssues('基坑开挖。基坑支护。边坡支护。开挖深度按基坑支护设计图纸确定。')).toHaveLength(1);
  });
  it('O4-7 倍数式排除：深度2倍距离不算锁定', () => {
    expect(excavationDepthLockIssues('基坑开挖。基坑支护。边坡支护。开挖深度2倍距离范围内堆载。')).toHaveLength(1);
  });
  it('O4-8 偏差句排除：标高偏差控制在±5不算锁定', () => {
    expect(excavationDepthLockIssues('基坑开挖。基坑支护。边坡支护。基底标高偏差控制在±5mm。')).toHaveLength(1);
  });
  it('O4-9 零标高基准排除：设计±0.000对应绝对标高不算锁定', () => {
    expect(excavationDepthLockIssues('基坑开挖。基坑支护。边坡支护。现状地面标高与设计±0.000对应绝对标高。')).toHaveLength(1);
  });
  it('O4-10 时间单位排除：坑底标高后24h内完成垫层不算锁定', () => {
    expect(excavationDepthLockIssues('基坑开挖。基坑支护。边坡支护。坑底标高后24h内完成垫层。')).toHaveLength(1);
  });
  it('O4-11 以上/以下相对量排除：标高以上300mm人工清底不算锁定', () => {
    expect(excavationDepthLockIssues('基坑开挖。基坑支护。边坡支护。基底标高以上300mm人工清底。')).toHaveLength(1);
  });
  it('O4-12 水位相对句排除：标高低于水池最低水位500mm不算锁定', () => {
    expect(excavationDepthLockIssues('基坑开挖。基坑支护。边坡支护。降水井标高低于水池最低水位500mm。')).toHaveLength(1);
  });
  it('O4-13 首个有效窗口即锁定：排除窗口后出现确定性深度不报', () => {
    expect(excavationDepthLockIssues('基坑开挖。基坑支护。边坡支护。开挖深度超过3m。基坑开挖深度5.85m。')).toHaveLength(0);
  });
  it('O4-14 深度提取：canonical槽位直接取值', () => {
    const model = factsOf({ canonical: { byKey: { excavation_depth: { value: '5.15m' } } } as never });
    expect(excavationDepthFromFacts(model)).toBe(5.15);
  });
  it('O4-15 深度提取：比较式条文防御（16m及以上被排除）', () => {
    const model = factsOf({ canonical: { byKey: { excavation_depth: { value: '开挖深度16m及以上' } } } as never });
    expect(excavationDepthFromFacts(model)).toBeUndefined();
  });
  it('O4-16 深度提取：事实关键词门（建筑高度28.9m不误采）', () => {
    const model = factsOf({ project: [factOf({ fieldName: '建筑高度', value: '28.9m' })] });
    expect(excavationDepthFromFacts(model)).toBeUndefined();
  });
  it('O4-17 深度提取：关键词命中采值（基坑深度5.85m）', () => {
    const model = factsOf({ drawings: [factOf({ fieldName: '基坑深度', value: '5.85m' })] });
    expect(excavationDepthFromFacts(model)).toBe(5.85);
  });
  it('O4-18 深度提取：范围过滤（0.5m过小、60m过大均排除）', () => {
    const small = factsOf({ canonical: { byKey: { excavation_depth: { value: '0.5m' } } } as never });
    const large = factsOf({ canonical: { byKey: { excavation_depth: { value: '60m' } } } as never });
    expect(excavationDepthFromFacts(small)).toBeUndefined();
    expect(excavationDepthFromFacts(large)).toBeUndefined();
  });
  it('O4-19 深度提取：负标高取绝对值', () => {
    const model = factsOf({ canonical: { byKey: { excavation_depth: { value: '坑底标高-5.85m' } } } as never });
    expect(excavationDepthFromFacts(model)).toBe(5.85);
  });
  it('O4-20 深度提取：多源取最大（canonical 5.15 vs 图纸4.2）', () => {
    const model = factsOf({
      canonical: { byKey: { excavation_depth: { value: '5.15m' } } } as never,
      drawings: [factOf({ fieldName: '基坑深度', value: '4.2m' })],
    });
    expect(excavationDepthFromFacts(model)).toBe(5.15);
  });
  it('O4-21 危大分级：深度2.9m早退', () => {
    const model = factsOf({ canonical: { byKey: { excavation_depth: { value: '2.9m' } } } as never });
    expect(excavationHazardClassificationIssues('正文无标注。', model)).toHaveLength(0);
  });
  it('O4-22 危大分级：3m无危大标注报1条', () => {
    const model = factsOf({ canonical: { byKey: { excavation_depth: { value: '3m' } } } as never });
    const issues = excavationHazardClassificationIssues('正文无标注。', model);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('危大工程判定缺失');
  });
  it('O4-23 危大分级：5m两者均缺报2条', () => {
    const model = factsOf({ canonical: { byKey: { excavation_depth: { value: '5.5m' } } } as never });
    const issues = excavationHazardClassificationIssues('正文无标注。', model);
    expect(issues).toHaveLength(2);
  });
  it('O4-24 危大分级：5m有危大无超危大报1条', () => {
    const model = factsOf({ canonical: { byKey: { excavation_depth: { value: '5.5m' } } } as never });
    const issues = excavationHazardClassificationIssues('本工程属危大工程。', model);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('超过一定规模');
  });
  it('O4-25 危大分级：5m两者齐全不报', () => {
    const model = factsOf({ canonical: { byKey: { excavation_depth: { value: '5.5m' } } } as never });
    expect(excavationHazardClassificationIssues('本工程属危大工程，属于超过一定规模需专家论证。', model)).toHaveLength(0);
  });
});

describe('O5 设备进场时序：equipmentEntryTimingIssues', () => {
  it('O5-1 尾期进场报出：第170日 vs 总工期210（80%=168）', () => {
    const issues = equipmentEntryTimingIssues('计划工期210日历天。塔式起重机计划于第170日进场。', factsOf({}));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('尾期');
  });
  it('O5-2 尾期边界：第168日恰好80%报、第167日不报', () => {
    expect(equipmentEntryTimingIssues('计划工期210日历天。塔式起重机计划于第168日进场。', factsOf({}))).toHaveLength(1);
    expect(equipmentEntryTimingIssues('计划工期210日历天。塔式起重机计划于第167日进场。', factsOf({}))).toHaveLength(0);
  });
  it('O5-3 无总工期不检尾期', () => {
    expect(equipmentEntryTimingIssues('塔式起重机计划于第170日进场。', factsOf({}))).toHaveLength(0);
  });
  it('O5-4 绑定资料工期兜底：schedule事实210日历天', () => {
    const model = factsOf({ schedule: [factOf({ key: '总工期', value: '210日历天' })] });
    expect(equipmentEntryTimingIssues('塔式起重机计划于第170日进场。', model)).toHaveLength(1);
  });
  it.each(['进场', '投入使用', '安装', '调试'])('O5-5 进场动词谱系：%s', verb => {
    const issues = equipmentEntryTimingIssues(`计划工期210日历天。塔式起重机第170日${verb}。`, factsOf({}));
    expect(issues).toHaveLength(1);
  });
  it('O5-6 设备词表外不采：发电机第170日进场不报', () => {
    expect(equipmentEntryTimingIssues('计划工期210日历天。发电机第170日进场。', factsOf({}))).toHaveLength(0);
  });
  it('O5-7 一位数日期不采：第9日', () => {
    expect(equipmentEntryTimingIssues('计划工期210日历天。挖掘机第9日进场。', factsOf({}))).toHaveLength(0);
  });
  it('O5-8 进场窗口8字符外不采', () => {
    expect(equipmentEntryTimingIssues('计划工期210日历天。塔式起重机第170日完成各项验收手续后进场。', factsOf({}))).toHaveLength(0);
  });
  it('O5-9 设备名24字符窗口外不采', () => {
    expect(equipmentEntryTimingIssues('计划工期210日历天。塔式起重机及其配套附属设施、吊索具、标准节等计划于第170日进场。', factsOf({}))).toHaveLength(0);
  });
  it('O5-10 工序倒挂：挖掘机第75日 vs 基坑支护完成第60日', () => {
    const issues = equipmentEntryTimingIssues('第60日完成基坑支护及土方外运。挖掘机第75日进场。', factsOf({}));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('倒挂');
  });
  it('O5-11 倒挂边界：挖掘机第60日与节点同日不报', () => {
    expect(equipmentEntryTimingIssues('第60日完成基坑支护及土方外运。挖掘机第60日进场。', factsOf({}))).toHaveLength(0);
  });
  it('O5-12 非基坑设备晚于节点不判倒挂：塔式起重机', () => {
    expect(equipmentEntryTimingIssues('第60日完成基坑支护及土方外运。塔式起重机第75日进场。', factsOf({}))).toHaveLength(0);
  });
  it('O5-13 无基坑节点不检倒挂', () => {
    expect(equipmentEntryTimingIssues('挖掘机第75日进场。', factsOf({}))).toHaveLength(0);
  });
  it('O5-14 节点表格式形态B：基坑支护完成|第60天', () => {
    const issues = equipmentEntryTimingIssues('基坑支护完成|第60天。挖掘机第75日进场。', factsOf({}));
    expect(issues).toHaveLength(1);
  });
  it('O5-15 节点表格行形态D：| 基坑支护及土方外运 | 开工后第60日 |', () => {
    const issues = equipmentEntryTimingIssues('| 基坑支护及土方外运 | 开工后第60日 |\n挖掘机第75日进场。', factsOf({}));
    expect(issues).toHaveLength(1);
  });
  it('O5-16 设备表行不误采为节点（开工后第75日进场形态）', () => {
    expect(equipmentEntryTimingIssues('| 挖掘机 | 开工后第75日进场 |', factsOf({}))).toHaveLength(0);
  });
  it('O5-17 尾期+倒挂并存报2条', () => {
    const md = '计划工期210日历天。第60日完成基坑支护及土方外运。挖掘机第75日进场。塔式起重机第170日进场。';
    expect(equipmentEntryTimingIssues(md, factsOf({}))).toHaveLength(2);
  });
  it('O5-18 相同句子重复去重只报一次', () => {
    const md = '计划工期210日历天。塔式起重机第170日进场。塔式起重机第170日进场。';
    expect(equipmentEntryTimingIssues(md, factsOf({}))).toHaveLength(1);
  });
});
