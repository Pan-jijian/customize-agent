/**
 * C-T5 清单落位口径单测：豁免分类（汇总口径行）/ 显性说明扫描 / 责任章映射（行级任务清单驱动）/
 * 责任清单行渲染（写作注入）。全部为 L2 确定性纯函数，无 LLM 与语义通道。
 */
import { describe, expect, it } from 'vitest';
import { assignBillRowChapter, buildBillResponsibilityMap, classifyBillPlacementExemption, renderBillChapterTaskLines, scanBillExplicitDispositions } from '@/services/document-workflow/billFactLock';
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

  it('清单明细条目与空值不豁免（整名锚定，含汇总字样的明细名不误伤）', () => {
    expect(classifyBillPlacementExemption('挖一般土方')).toBeUndefined();
    expect(classifyBillPlacementExemption('混凝土管铺设')).toBeUndefined();
    expect(classifyBillPlacementExemption('')).toBeUndefined();
    expect(classifyBillPlacementExemption('含税合计金额调整')).toBeUndefined();
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
