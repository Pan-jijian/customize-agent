/**
 * C-T5 清单落位口径单测：豁免分类（汇总口径行）/ 显性说明扫描 / 责任章映射（行级任务清单驱动）/
 * 责任清单行渲染（写作注入）/ C3-5-4 责任章映射加固（尾句剥离 + 子词边界/停用词）。
 * 全部为 L2 确定性纯函数，无 LLM 与语义通道。
 */
import { describe, expect, it } from 'vitest';
import { assignBillRowChapter, buildBillResponsibilityMap, classifyBillPlacementExemption, renderBillChapterTaskLines, renderBillFactLockText, scanBillExplicitDispositions, stripBillDescriptionBoilerplate } from '@/services/document-workflow/billFactLock';
import type { BillFactLock, BillFactLockEntry } from '@/services/document-workflow/billFactLock';

const entry = (over: Partial<BillFactLockEntry>): BillFactLockEntry => ({
  seq: 1,
  name: '',
  description: '',
  quantity: 0,
  unit: '',
  section: '',
  subsection: '',
  villageGroup: '',
  sourceFile: '清单.xls',
  specQuantityPairs: [],
  ...over,
});
const lockOf = (entries: BillFactLockEntry[]): BillFactLock => ({ entries, totalEntries: entries.length, sourceFile: '清单.xls', complete: true });

describe('classifyBillPlacementExemption（落位口径豁免：汇总口径行）', () => {
  it('计价汇总口径行判 summary-row', () => {
    expect(classifyBillPlacementExemption('分部小计')).toBe('summary-row');
    expect(classifyBillPlacementExemption('合计')).toBe('summary-row');
    expect(classifyBillPlacementExemption('规费')).toBe('summary-row');
    expect(classifyBillPlacementExemption('税金')).toBe('summary-row');
    expect(classifyBillPlacementExemption('暂列金额')).toBe('summary-row');
  });

  it('空白归一后仍判定（单元格前后缀空白）', () => {
    expect(classifyBillPlacementExemption(' 合计 ')).toBe('summary-row');
    expect(classifyBillPlacementExemption('分部 小计')).toBe('summary-row');
  });

  it('清单明细条目不豁免（整名锚定，含汇总字样的明细名不误伤）；空名行归 no-name-row（C3-5 扩围）', () => {
    expect(classifyBillPlacementExemption('挖一般土方')).toBeUndefined();
    expect(classifyBillPlacementExemption('混凝土管铺设')).toBeUndefined();
    expect(classifyBillPlacementExemption('含税合计金额调整')).toBeUndefined();
    // C3-5：名槽为空的行无法构成落位义务（费用组成表「人工费小计/说明：…」串入码格的形态）
    expect(classifyBillPlacementExemption('')).toBe('no-name-row');
    expect(classifyBillPlacementExemption('', { code: '人工费小计' })).toBe('no-name-row');
  });

  it('C3-5 豁免扩围：说明行/费小计行/编号结构行/序号分类行（s28l 实机形态）', () => {
    // 说明行（其他项目表/费用组成表填写说明；名槽或码槽出现均判）
    expect(classifyBillPlacementExemption('说明：此表项目名称、数量由招标人填写')).toBe('note-row');
    expect(classifyBillPlacementExemption('', { code: '说明：此表项目名称、数量由招标人填写' })).toBe('note-row');
    // 费小计行（费用尾缀 + 小计/合计形态）
    expect(classifyBillPlacementExemption('人工费小计')).toBe('fee-row');
    expect(classifyBillPlacementExemption('材料费小计')).toBe('fee-row');
    expect(classifyBillPlacementExemption('施工机械费小计')).toBe('fee-row');
    // 编号结构行（点分编号 code + 无工程量：4.7.x 分部标题/2.16.4 子分部）
    expect(classifyBillPlacementExemption('4.2飞霞广场综合提升改造工程', { code: '4.2' })).toBe('numbered-heading-row');
    expect(classifyBillPlacementExemption('4.7.4老税务局绿化', { code: '4.7.4' })).toBe('numbered-heading-row');
    expect(classifyBillPlacementExemption('（道路改造严重区域）', { code: '2.16.4' })).toBe('numbered-heading-row');
    // 序号分类行（中文数字/短序号 + 费用分类名：「一 人工」「二 材料」「三 施工机械」「5 其他」）
    expect(classifyBillPlacementExemption('人工', { code: '一' })).toBe('ordinal-category-row');
    expect(classifyBillPlacementExemption('材料', { code: '二' })).toBe('ordinal-category-row');
    expect(classifyBillPlacementExemption('施工机械', { code: '三' })).toBe('ordinal-category-row');
    expect(classifyBillPlacementExemption('其他', { code: '5' })).toBe('ordinal-category-row');
    // 反样本（真清单项不误伤）：带清单编码/工程量的行不豁免
    expect(classifyBillPlacementExemption('1.2米沥青漫行步道', { code: '040203006011', quantity: '285.84' })).toBeUndefined();
    expect(classifyBillPlacementExemption('4.2飞霞广场综合提升改造工程', { code: '4.2', quantity: '100' })).toBeUndefined();
    expect(classifyBillPlacementExemption('机械拆除道路面层', { code: '081201001001', quantity: '600' })).toBeUndefined();
  });

  it('C3-5-8 豁免扩围：泛词短名行判 generic-name-row（隐形分母消除；2 字实义词不误伤）', () => {
    // 泛词短名行：字面三通道因长度门槛全不可达（首段主名 2 字被泛词名单挡 + 整名 <3 字符 + 编码需正文含 8 位）
    // —— 带真实编码/工程量的泛词行仍是永不落位的隐形分母（s28l「软件」4 行实测），豁免与「泛词不构成落位证据」判定同源
    expect(classifyBillPlacementExemption('软件', { code: '030501017001', quantity: '1' })).toBe('generic-name-row');
    expect(classifyBillPlacementExemption('人工', { code: '030901010001' })).toBe('generic-name-row');
    // 审计归类稳定：带序号形态的泛词行仍归 ④（排在 ⑤ 之前）
    expect(classifyBillPlacementExemption('其他', { code: '5' })).toBe('ordinal-category-row');
    // 反样本：2 字工程实义词（垫层/圈梁/涵头）不在名单不误伤
    expect(classifyBillPlacementExemption('垫层', { code: '010501003001', quantity: '240' })).toBeUndefined();
    expect(classifyBillPlacementExemption('圈梁', { code: '010503002001', quantity: '120' })).toBeUndefined();
    expect(classifyBillPlacementExemption('涵头', { code: '040103002001', quantity: '2' })).toBeUndefined();
    // 反样本：含泛词的清单长名整名锚定不误伤
    expect(classifyBillPlacementExemption('临时道路工程', { code: '041001001001', quantity: '300' })).toBeUndefined();
  });

  it('版式噪声行判 noise-row（页眉/表标题；空名时作用于编码槽）', () => {
    expect(classifyBillPlacementExemption('分部分项工程量清单')).toBe('noise-row');
    expect(classifyBillPlacementExemption('E.1 分部分项工程量清单计')).toBe('noise-row');
    expect(classifyBillPlacementExemption('工程名称：某村人居环境整治项目')).toBe('noise-row');
    expect(classifyBillPlacementExemption('第 2 页')).toBe('noise-row');
    expect(classifyBillPlacementExemption('共 5 页')).toBe('noise-row');
    expect(classifyBillPlacementExemption('措施项目')).toBe('noise-row');
    // 名空 + 编码槽为页眉文本/合计（r28h2 实测形态：名空行占未落位 65%）
    expect(classifyBillPlacementExemption('', { code: '分部分项工程量清单' })).toBe('noise-row');
    expect(classifyBillPlacementExemption('', { code: '合   计' })).toBe('summary-row');
  });

  it('费用组成行判 fee-row（报价行不逐项落位；超长「…费」不误判）', () => {
    expect(classifyBillPlacementExemption('夜间施工增加费')).toBe('fee-row');
    expect(classifyBillPlacementExemption('二次搬运费')).toBe('fee-row');
    expect(classifyBillPlacementExemption('环境保护税')).toBe('fee-row');
    expect(classifyBillPlacementExemption('专业工程暂估价')).toBe('fee-row');
    // 长度上限（24 字）：长句不以费用行豁免
    expect(classifyBillPlacementExemption('施工期间为确保周边居民出行安全而发生的临时道路维护费')).toBeUndefined();
  });

  it('分部标题行判 section-title-row（「XX工程」无编码且无工程量；带码/带量不豁免）', () => {
    expect(classifyBillPlacementExemption('道路工程')).toBe('section-title-row');
    expect(classifyBillPlacementExemption('墙、柱面装饰与隔断、幕墙工程')).toBe('section-title-row');
    expect(classifyBillPlacementExemption('道路工程', { code: '040101001' })).toBeUndefined();
    expect(classifyBillPlacementExemption('道路工程', { quantity: '1200' })).toBeUndefined();
    // 带行上下文的真清单项不豁免（豁免判据不为落位率放水）
    expect(classifyBillPlacementExemption('挖一般土方', { code: '010101003001', quantity: '5600' })).toBeUndefined();
    expect(classifyBillPlacementExemption('矩形柱（含梯柱）', { code: '010502001001', quantity: '320' })).toBeUndefined();
  });
});

describe('scanBillExplicitDispositions（显性说明处置识别）', () => {
  it('指名条目 + 处置语气（利旧/不另列）命中', () => {
    const result = scanBillExplicitDispositions('原有检查井利旧使用，不另列施工方案。', ['检查井']);
    expect(result.size).toBe(1);
    expect(result.get('检查井')).toContain('利旧');
  });

  it('无处置语气的普通描述句不命中', () => {
    expect(scanBillExplicitDispositions('检查井采用砖砌结构，井盖为重型铸铁。', ['检查井']).size).toBe(0);
  });

  it('处置句未指名条目不命中（说明须含条目名）', () => {
    expect(scanBillExplicitDispositions('本工程雨污水管道利旧使用。', ['检查井']).size).toBe(0);
  });

  it('「由厂家配套」「不涉及」处置句式命中', () => {
    const result = scanBillExplicitDispositions('路灯基础由设备厂家配套实施。挡土墙不涉及本标段施工范围。', ['路灯基础', '挡土墙']);
    expect(result.size).toBe(2);
  });

  it('过短名称（<3 字）不参与判定；空输入安全返回空表', () => {
    expect(scanBillExplicitDispositions('检查井利旧', ['井']).size).toBe(0);
    expect(scanBillExplicitDispositions('', ['检查井']).size).toBe(0);
    expect(scanBillExplicitDispositions('检查井利旧使用', []).size).toBe(0);
  });
});

describe('assignBillRowChapter（行级任务清单：每行→责任章→写作证据位）', () => {
  const CHAPTERS = [
    { title: '第三章 施工部署与资源配置', sections: ['总体施工安排'] },
    { title: '第五章 主要施工方法', sections: ['排水工程', '道路工程'] },
  ];

  it('词面相关命中（含双字子词扩展）并给出建议落位小节', () => {
    expect(assignBillRowChapter({ name: '排水管道铺设' }, CHAPTERS)).toEqual({ chapterTitle: '第五章 主要施工方法', section: '排水工程' });
  });

  it('章标题与条目子词粒度不一致时仍命中（排水工程施工方案 ← 排水）', () => {
    const assignment = assignBillRowChapter({ name: '混凝土排水沟浇筑' }, [{ title: '第七章 排水工程施工方案' }]);
    expect(assignment?.chapterTitle).toBe('第七章 排水工程施工方案');
    expect(assignment?.section).toBeUndefined();
  });

  it('全零分回退施工方法类章（施工方案/施工工艺同口径）', () => {
    expect(assignBillRowChapter({ name: '特殊构件安装' }, [{ title: '第三章 组织机构' }, { title: '第五章 主要施工方法' }]))
      .toEqual({ chapterTitle: '第五章 主要施工方法' });
  });

  it('无方法类章回退失败返回 undefined；空章上下文/空文本返回 undefined', () => {
    expect(assignBillRowChapter({ name: '特殊构件安装' }, [{ title: '第三章 组织机构' }])).toBeUndefined();
    expect(assignBillRowChapter({ name: '特殊构件安装' }, [])).toBeUndefined();
    expect(assignBillRowChapter({}, CHAPTERS)).toBeUndefined();
  });
});

describe('C3-5-4 责任章映射加固（清单尾句剥离 + 子词边界/停用词）', () => {
  it('清单特征标准尾句剥离（boilerplate 段移除，真内容保留；换行归一）', () => {
    expect(stripBillDescriptionBoilerplate('绿篱日常养护 1．种类：色带 2．养护期：一级养护，日常养护18个月 3．具体详见设计图纸、图集、招标文件、招标文件补疑、政府相关文件、规范等其它资料，满足验收要求'))
      .toBe('绿篱日常养护 1．种类：色带 2．养护期：一级养护，日常养护18个月 3．具体');
    expect(stripBillDescriptionBoilerplate('挖土深度：\n详见设计图纸')).toBe('挖土深度：');
    expect(stripBillDescriptionBoilerplate('素土夯实，压实度≥0.93')).toBe('素土夯实，压实度≥0.93');
    expect(stripBillDescriptionBoilerplate('')).toBe('');
  });

  it('尾句不构成章归属证据：绿化养护条目归施工方法章，而非「验收/资料」小节所在章（s28l 963 条错归实证缺陷）', () => {
    const chapters = [
      { title: '第八章 工程施工的重点和难点及保证措施', sections: ['验收闭环与资料同步'] },
      { title: '第五章 主要施工方法', sections: ['公共广场提升改造专项工程', '绿化种植与养护'] },
    ];
    const assignment = assignBillRowChapter({
      name: '绿篱日常养护',
      description: '绿篱日常养护 1．种类：色带 2．养护期：一级养护 3．具体详见设计图纸、图集、招标文件、政府相关文件、规范等其它资料，满足验收要求',
    }, chapters);
    expect(assignment?.chapterTitle).toBe('第五章 主要施工方法');
    expect(assignment?.section).toBe('绿化种植与养护');
  });

  it('双字子词命中限切片首/尾：中段跨词碎片不命中（三级配电两级保护 ↛ 级配碎石），尾片段仍有效（保护）', () => {
    const chapters = [{ title: '第七章 确保安全生产的技术组织措施', sections: ['施工现场临时用电三级配电两级保护'] }];
    expect(assignBillRowChapter({ name: '景墙一', description: '10cm级配碎石，10cmC20混凝土垫层' }, chapters)).toBeUndefined();
    expect(assignBillRowChapter({ name: '成品保护' }, chapters)?.chapterTitle).toBe('第七章 确保安全生产的技术组织措施');
  });

  it('通用复现词子词不构成归属证据（施工/材料/钢筋/管理为停用词）', () => {
    const chapters = [
      { title: '第九章 施工总平面布置图', sections: ['材料堆场与加工区落位', '钢筋木工加工场区划设'] },
      { title: '第三章 组织机构', sections: ['搭接管理'] },
    ];
    expect(assignBillRowChapter({ name: '卫生间挂钩', description: '材料品种、规格、颜色：不锈钢' }, chapters)).toBeUndefined();
    expect(assignBillRowChapter({ name: '休闲坐凳', description: '150厚C25钢筋混凝土垫层，φ6@200单层双向' }, chapters)).toBeUndefined();
  });

  it('单点专有命中仍有效（无分数门槛）；零分回退施工方法类章口径不变', () => {
    const chapters = [
      { title: '第三章 施工部署与资源配置', sections: ['总体施工安排'] },
      { title: '第五章 主要施工方法', sections: ['排水工程', '道路工程'] },
    ];
    expect(assignBillRowChapter({ name: '排水管道铺设' }, chapters)).toEqual({ chapterTitle: '第五章 主要施工方法', section: '排水工程' });
    expect(assignBillRowChapter({ name: '特殊构件安装' }, chapters)).toEqual({ chapterTitle: '第五章 主要施工方法' });
  });
});

describe('buildBillResponsibilityMap / renderBillChapterTaskLines（写作注入）', () => {
  const chapters = [
    { title: '第五章 主要施工方法', sections: ['排水工程', '道路工程'] },
    { title: '第三章 组织机构' },
  ];
  const lock = lockOf([
    entry({ seq: 1, name: '排水管道铺设', quantity: 80, unit: 'm', section: '排水工程' }),
    entry({ seq: 2, name: '路面标线', quantity: 200, unit: 'm2', section: '道路面层' }),
    entry({ seq: 3, name: '沟槽开挖', quantity: 300, unit: 'm3', section: '排水工程' }),
  ]);

  it('全量映射：责任章 + 建议小节（同分取先者，词面无关小节不入选）', () => {
    const map = buildBillResponsibilityMap(lock, chapters);
    expect(map.size).toBe(3);
    expect(map.get(lock.entries[0]!)).toEqual({ chapterTitle: '第五章 主要施工方法', section: '排水工程' });
    expect(map.get(lock.entries[1]!)).toEqual({ chapterTitle: '第五章 主要施工方法', section: '道路工程' });
  });

  it('责任清单行渲染：条目名 + 数量单位 + 建议写入小节', () => {
    const map = buildBillResponsibilityMap(lock, chapters);
    const lines = renderBillChapterTaskLines(lock, map, '第五章 主要施工方法');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('本章责任清单行');
    expect(lines.some(line => line.includes('排水管道铺设') && line.includes('80m') && line.includes('建议写入小节「排水工程」'))).toBe(true);
    expect(lines.some(line => line.includes('路面标线') && line.includes('200m2') && line.includes('建议写入小节「道路工程」'))).toBe(true);
  });

  it('超出上限的行仅列名并给出总数（防提示词膨胀）', () => {
    const map = buildBillResponsibilityMap(lock, chapters);
    const limited = renderBillChapterTaskLines(lock, map, '第五章 主要施工方法', { maxEntries: 1 });
    expect(limited).toHaveLength(3);
    expect(limited[2]).toContain('另需覆盖（仅列名，共2条）');
  });

  it('空锁/空映射/章不匹配返回空数组', () => {
    const map = buildBillResponsibilityMap(lock, chapters);
    expect(renderBillChapterTaskLines(undefined, new Map(), '第五章 主要施工方法')).toEqual([]);
    expect(renderBillChapterTaskLines(lock, new Map(), '第五章 主要施工方法')).toEqual([]);
    expect(renderBillChapterTaskLines(lock, map, '第九章 不存在的章')).toEqual([]);
  });

  it('空锁/空章不产生责任映射', () => {
    expect(buildBillResponsibilityMap(undefined, chapters).size).toBe(0);
    expect(buildBillResponsibilityMap(lock, []).size).toBe(0);
  });
});

describe('4.55.28 规格-数量权威必须送达写手（用户实测：C40 为什么等修复才改）', () => {
  const chapters = [{ title: '第一章 主要施工方法与技术措施', sections: ['基础工程', '桩基工程'] }];
  const pileHead = entry({
    seq: 18,
    name: '截（凿）桩头',
    description: '1．桩类型：钢筋砼管桩 2．混凝土强度等级：C80 3．有无钢筋：有钢筋 4．其它：含试桩、送桩',
    quantity: 5152,
    unit: '根',
    section: '桩基工程',
    specQuantityPairs: [{ spec: 'C80', quantity: '5152根' }],
  });

  it('责任清单行显式携带规格-数量对（不再靠特征描述截断碰运气）', () => {
    const lock = lockOf([pileHead]);
    const lines = renderBillChapterTaskLines(lock, buildBillResponsibilityMap(lock, chapters), chapters[0]!.title);
    expect(lines.some(line => line.includes('截（凿）桩头') && line.includes('[C80 5152根]'))).toBe(true);
  });

  it('超预算条目不再静默消失：清单锁给出列名 + 全量规格-数量权威块', () => {
    const many = Array.from({ length: 80 }, (_, index) => entry({
      seq: index + 1,
      name: `条目${index + 1}`,
      description: '混凝土强度等级：C30',
      quantity: 10 + index,
      unit: 'm3',
      section: '基础工程',
      specQuantityPairs: [{ spec: 'C30', quantity: `${10 + index}m3` }],
    }));
    const text = renderBillFactLockText(lockOf(many), chapters[0]!.title, { sections: ['基础工程'], maxEntries: 5, maxChars: 200 });
    expect(text).toContain('另需覆盖');
    expect(text).toContain('本章规格-数量权威');
    // 被截断的条目规格对仍在（如 条目80 C30 89m3）
    expect(text).toContain('条目80 C30 89m3');
  });

  it('本章责任行的规格权威块要求"跨对象借用即错"（防桩头取承台 C40）', () => {
    const lock = lockOf([pileHead]);
    const lines = renderBillChapterTaskLines(lock, buildBillResponsibilityMap(lock, chapters), chapters[0]!.title);
    expect(lines.join('\n')).toContain('跨对象借用即错');
  });
});
