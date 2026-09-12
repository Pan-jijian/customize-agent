/**
 * dicEquipmentEntryMatrixBoundary：设备进场时序（equipmentEntryTimingIssues）+ 节点工期提取
 * （extractNodeScheduleDays 的 excavation 源）增量深挖（T 组）。
 * 覆盖增量维度（与既有批次互补，不重复）：
 *  - T1 设备词 20 词全谱系（尾期阈值触发提取）；
 *  - T2 第N日数字位宽边界（1位/2位/3位/4位/前导零/「天」异写）；
 *  - T3 动作词 4 词谱系 + 8 字符邻接窗口精确边界 + 动作词截断；
 *  - T4 设备词前 24 字符窗口精确边界 + 词表查找顺序（混凝土喷射机 vs 喷射机）；
 *  - T5 尾期阈值 total*0.8 精确边界（含非整数阈值 101*0.8=80.8、total 有效域 30-3000）；
 *  - T6 倒挂 pitDone 提取四形态谱系（A 正序/B 表格/C 封顶无关/D 表格行）+ PIT 设备 7 词谱系；
 *  - T7 组合矩阵：尾期+倒挂同报、多条目聚合、slice(0,3) 展示截断、同 raw 去重、宽词「安装/调试」误触锁定；
 *  - T8 动作词窗口排除字符谱系（| 。 ； ; \n）；
 *  - T10 总工期锚点四谱系 + 锚点后 12 字符窗口边界 + factsModel.schedule 兜底 + 正文优先。
 * 全部为确定性正则提取与数值比较，无语义依赖。
 */
import { describe, expect, it } from 'vitest';
import { equipmentEntryTimingIssues } from '@/services/document-workflow/documentIntegrityChecks';
import { factOf, factsOf } from './boundaryKit';

const EMPTY_FACTS = factsOf({});

// ── T1. 设备词 20 词全谱系（尾期阈值触发提取）──

const EQUIPMENT_WORDS = [
  '塔式起重机', '施工升降机', '施工电梯', '汽车起重机', '汽车吊',
  '混凝土泵车', '混凝土泵', '挖掘机', '装载机', '推土机',
  '压路机', '平地机', '空压机', '注浆机', '锚杆钻机',
  '混凝土喷射机', '喷射机', '吊篮', '钢筋加工设备', '塔吊',
] as const;

describe('T1 设备词 20 词全谱系（尾期阈值触发提取）', () => {
  it.each(EQUIPMENT_WORDS)('T1 设备词“%s”第210日进场 → 尾期报', (word) => {
    const issues = equipmentEntryTimingIssues(`计划工期210日历天。${word}第210日进场。`, EMPTY_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(`${word} 第210日进场`);
  });
});

// ── T2. 第N日数字位宽边界 ──

describe('T2 第N日数字位宽边界', () => {
  it('T2-1 第9日（1位，\d{2,3}不匹配）→ 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第9日进场。计划工期210日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T2-2 第99日（2位上限）→ 提取并报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第99日进场。计划工期75日历天。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T2-3 第100日（3位下限）→ 提取并报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第100日进场。计划工期75日历天。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T2-4 第060日（前导零，day=60）→ 已达总工期 60 报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第060日进场。计划工期60日历天。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T2-5 第1234日（4位，\d{2,3}无匹配起点）→ 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第1234日进场。计划工期210日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T2-6 第1000日（3位+尾数0，贪婪后回溯失败）→ 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第1000日进场。计划工期210日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T2-7 第168天（「天」异写，主正则只收「日」）→ 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第168天进场。计划工期210日历天。', EMPTY_FACTS)).toEqual([]);
  });
});

// ── T3. 动作词谱系与邻接窗口边界 ──

const ACTION_WORDS = ['进场', '投入使用', '安装', '调试'] as const;

describe('T3 动作词谱系与邻接窗口边界', () => {
  it.each(ACTION_WORDS)('T3-1 动作词“%s”0字符邻接 → 尾期报', (word) => {
    expect(equipmentEntryTimingIssues(`挖掘机第210日${word}。计划工期210日历天。`, EMPTY_FACTS)).toHaveLength(1);
  });
  it('T3-2 窗口8个「，」（恰上限）→ 报', () => {
    expect(equipmentEntryTimingIssues(`挖掘机第210日${'，'.repeat(8)}进场。计划工期210日历天。`, EMPTY_FACTS)).toHaveLength(1);
  });
  it('T3-3 窗口9个「，」（超上限）→ 不报', () => {
    expect(equipmentEntryTimingIssues(`挖掘机第210日${'，'.repeat(9)}进场。计划工期210日历天。`, EMPTY_FACTS)).toEqual([]);
  });
  it('T3-4 动作词截断「投入」（缺使用）→ 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日投入。计划工期210日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T3-5 动作词截断「使用」（缺投入）→ 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日使用。计划工期210日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T3-6 「完成」非动作词 → 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日完成吊装。计划工期210日历天。', EMPTY_FACTS)).toEqual([]);
  });
});

// ── T4. 设备词前 24 字符窗口精确边界 ──

describe('T4 设备词前24字符窗口精确边界', () => {
  it('T4-1 3字词21填充（index=24 恰入窗）→ 报', () => {
    expect(equipmentEntryTimingIssues(`挖掘机${'支'.repeat(21)}第210日进场。计划工期210日历天。`, EMPTY_FACTS)).toHaveLength(1);
  });
  it('T4-2 3字词22填充（index=25 首字出窗）→ 不报', () => {
    expect(equipmentEntryTimingIssues(`挖掘机${'支'.repeat(22)}第210日进场。计划工期210日历天。`, EMPTY_FACTS)).toEqual([]);
  });
  it('T4-3 5字词19填充（index=24 恰入窗）→ 报', () => {
    expect(equipmentEntryTimingIssues(`塔式起重机${'支'.repeat(19)}第210日进场。计划工期210日历天。`, EMPTY_FACTS)).toHaveLength(1);
  });
  it('T4-4 5字词20填充（index=25 首字出窗）→ 不报', () => {
    expect(equipmentEntryTimingIssues(`塔式起重机${'支'.repeat(20)}第210日进场。计划工期210日历天。`, EMPTY_FACTS)).toEqual([]);
  });
  it('T4-5 词表顺序：混凝土喷射机优先于喷射机 → message 记完整词', () => {
    const issues = equipmentEntryTimingIssues('混凝土喷射机第210日进场。计划工期210日历天。', EMPTY_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('「混凝土喷射机 第210日进场」');
  });
  it('T4-6 异写「砼喷射机」→ 命中词表词「喷射机」', () => {
    const issues = equipmentEntryTimingIssues('砼喷射机第210日进场。计划工期210日历天。', EMPTY_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('「喷射机 第210日进场」');
  });
  it('T4-7 施工升降机与施工电梯（>24字符隔离防前词误绑定）→ 2 条目聚合 1 条 issue', () => {
    const issues = equipmentEntryTimingIssues(`施工升降机第210日进场。${'支'.repeat(15)}施工电梯第210日进场。计划工期210日历天。`, EMPTY_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('施工升降机');
    expect(issues[0].message).toContain('施工电梯');
  });
  it('T4-8 设备词远离25填充（整词出窗）→ 不报', () => {
    expect(equipmentEntryTimingIssues(`挖掘机${'支'.repeat(25)}第210日进场。计划工期210日历天。`, EMPTY_FACTS)).toEqual([]);
  });
});

// ── T5. 尾期阈值 total*0.8 精确边界 ──

describe('T5 已达总工期 day>=total 精确边界', () => {
  it('T5-1 total=210 day=210 已达总工期 → 报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日进场。计划工期210日历天。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T5-2 total=210 day=167 → 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第167日进场。计划工期210日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T5-3 total=100 day=100 已达总工期 → 报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第100日进场。计划工期100日历天。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T5-4 total=100 day=79 → 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第79日进场。计划工期100日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T5-5 total=101 day=80（<80.8 非整数阈值）→ 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第80日进场。计划工期101日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T5-6 total=101 day=101 已达总工期 → 报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第101日进场。计划工期101日历天。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T5-7 total=30（有效域下限）day=30 已达总工期 → 报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第30日进场。计划工期30日历天。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T5-8 total=30 day=23 → 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第23日进场。计划工期30日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T5-9 total=3000（有效域上限）day=999（\d{2,3} 3位day上限）→ 阈值2400不可达 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第999日进场。计划工期3000日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T5-10 total=960 day=960 已达总工期 → 报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第960日进场。计划工期960日历天。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T5-11 total=1200 day=959 → 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第959日进场。计划工期1200日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T5-12 total=3001（>3000 无效）→ 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日进场。计划工期3001日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T5-13 total=29（<30 无效，total=undefined）→ 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日进场。计划工期29日历天。', EMPTY_FACTS)).toEqual([]);
  });
});

// ── T6. 倒挂 pitDone 提取四形态谱系 + PIT 设备词谱系 ──

describe('T6 倒挂 pitDone 形态A 正序完成式', () => {
  it('T6-1 第75日进场 > pitDone 60 → 报', () => {
    const issues = equipmentEntryTimingIssues('第60日完成基坑支护及土方外运。挖掘机第75日进场。', EMPTY_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('工序倒挂');
  });
  it('T6-2 第61日进场（pitDone+1）→ 报', () => {
    expect(equipmentEntryTimingIssues('第60日完成基坑支护及土方外运。挖掘机第61日进场。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T6-3 第60日进场（==pitDone，严格大于才报）→ 不报', () => {
    expect(equipmentEntryTimingIssues('第60日完成基坑支护及土方外运。挖掘机第60日进场。', EMPTY_FACTS)).toEqual([]);
  });
  it('T6-4 第59日进场（<pitDone）→ 不报', () => {
    expect(equipmentEntryTimingIssues('第60日完成基坑支护及土方外运。挖掘机第59日进场。', EMPTY_FACTS)).toEqual([]);
  });
  it('T6-5 节点短名「基坑支护」（形态A要求完整名）→ 无 pitDone 不报', () => {
    expect(equipmentEntryTimingIssues('第60日完成基坑支护。挖掘机第75日进场。', EMPTY_FACTS)).toEqual([]);
  });
  it('T6-6 「第60日」与「完成」间 14 字符（恰上限）→ 报', () => {
    expect(equipmentEntryTimingIssues(`第60日${'X'.repeat(14)}完成基坑支护及土方外运。挖掘机第75日进场。`, EMPTY_FACTS)).toHaveLength(1);
  });
  it('T6-7 「第60日」与「完成」间 15 字符（超上限）→ 不报', () => {
    expect(equipmentEntryTimingIssues(`第60日${'X'.repeat(15)}完成基坑支护及土方外运。挖掘机第75日进场。`, EMPTY_FACTS)).toEqual([]);
  });
  it('T6-8 「完成」与节点名间「，」（排除字符）→ 不报', () => {
    expect(equipmentEntryTimingIssues('第60日完成，基坑支护及土方外运。挖掘机第75日进场。', EMPTY_FACTS)).toEqual([]);
  });
  it('T6-9 「完成」与节点名间 12 字符（恰上限）→ 报', () => {
    expect(equipmentEntryTimingIssues(`第60日完成${'X'.repeat(12)}基坑支护及土方外运。挖掘机第75日进场。`, EMPTY_FACTS)).toHaveLength(1);
  });
  it('T6-10 「完成」与节点名间 13 字符（超上限）→ 不报', () => {
    expect(equipmentEntryTimingIssues(`第60日完成${'X'.repeat(13)}基坑支护及土方外运。挖掘机第75日进场。`, EMPTY_FACTS)).toEqual([]);
  });
  it('T6-11 形态A封顶节点（非excavation）→ 不报', () => {
    expect(equipmentEntryTimingIssues('第60日完成主体结构封顶。挖掘机第75日进场。', EMPTY_FACTS)).toEqual([]);
  });
});

describe('T6 倒挂 pitDone 形态B 表格式完成列', () => {
  it('T6-12 「基坑支护完成 | 第60天」→ 报', () => {
    expect(equipmentEntryTimingIssues('基坑支护完成 | 第60天。挖掘机第75日进场。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T6-13 锚点与「完成」间 8 字符（恰上限）→ 报', () => {
    expect(equipmentEntryTimingIssues(`基坑支护${'X'.repeat(8)}完成 | 第60天。挖掘机第75日进场。`, EMPTY_FACTS)).toHaveLength(1);
  });
  it('T6-14 锚点与「完成」间 9 字符（超上限）→ 不报', () => {
    expect(equipmentEntryTimingIssues(`基坑支护${'X'.repeat(9)}完成 | 第60天。挖掘机第75日进场。`, EMPTY_FACTS)).toEqual([]);
  });
  it('T6-15 锚点与「完成」间「、」（排除字符）→ 不报', () => {
    expect(equipmentEntryTimingIssues('基坑支护、完成 | 第60天。挖掘机第75日进场。', EMPTY_FACTS)).toEqual([]);
  });
  it('T6-16 「完成，第60天」（完成列后窗口允许逗号）→ 报', () => {
    expect(equipmentEntryTimingIssues('基坑支护完成，第60天。挖掘机第75日进场。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T6-17 形态B正负零节点（非excavation）→ 不报', () => {
    expect(equipmentEntryTimingIssues('正负零完成第60天。挖掘机第75日进场。', EMPTY_FACTS)).toEqual([]);
  });
});

describe('T6 倒挂 pitDone 形态C/D', () => {
  it('T6-18 形态C封顶倒序锁定（非excavation）→ 不报', () => {
    expect(equipmentEntryTimingIssues('主体结构封顶节点锁定在开工后第210日。挖掘机第75日进场。', EMPTY_FACTS)).toEqual([]);
  });
  it('T6-19 形态D表格行「| 基坑支护及土方外运 | 开工后第60日 |」→ 报', () => {
    const md = '| 基坑支护及土方外运 | 开工后第60日 |\n挖掘机第75日进场。';
    expect(equipmentEntryTimingIssues(md, EMPTY_FACTS)).toHaveLength(1);
  });
  it('T6-20 形态D「开工令下发后第60日」变体 → 报', () => {
    const md = '| 基坑支护及土方外运 | 开工令下发后第60日 |\n挖掘机第75日进场。';
    expect(equipmentEntryTimingIssues(md, EMPTY_FACTS)).toHaveLength(1);
  });
  it('T6-21 形态D「开工后第60日进场」（设备表行，第N日后非竖线）→ 不报', () => {
    const md = '| 基坑支护及土方外运 | 开工后第60日进场 |\n挖掘机第75日进场。';
    expect(equipmentEntryTimingIssues(md, EMPTY_FACTS)).toEqual([]);
  });
  it('T6-22 多源 pitDone 取 min（60 与 70 → 60）→ 65 进场报', () => {
    const md = '第60日完成基坑支护及土方外运。基坑支护完成 | 第70天。挖掘机第65日进场。';
    expect(equipmentEntryTimingIssues(md, EMPTY_FACTS)).toHaveLength(1);
  });
  it('T6-23 非 PIT 设备（塔式起重机）晚于 pitDone → 倒挂不报', () => {
    expect(equipmentEntryTimingIssues('第60日完成基坑支护及土方外运。塔式起重机第75日进场。', EMPTY_FACTS)).toEqual([]);
  });
});

const PIT_EQUIPMENT_WORDS = ['挖掘机', '空压机', '注浆机', '锚杆钻机', '混凝土喷射机', '喷射机', '推土机'] as const;

describe('T6 倒挂 PIT 设备 7 词谱系', () => {
  it.each(PIT_EQUIPMENT_WORDS)('T6-24 PIT 设备“%s”第75日进场 > pitDone 60 → 报', (word) => {
    const issues = equipmentEntryTimingIssues(`第60日完成基坑支护及土方外运。${word}第75日进场。`, EMPTY_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(`${word} 第75日进场`);
  });
});

// ── T7. 组合矩阵：尾期+倒挂同报 / 多条目聚合 / 截断 / 去重 / 宽词误触锁定 ──

describe('T7 组合矩阵与聚合', () => {
  it('T7-1 尾期+倒挂同文同报 → 2 条', () => {
    const md = '计划工期210日历天。第60日完成基坑支护及土方外运。挖掘机第210日进场。';
    expect(equipmentEntryTimingIssues(md, EMPTY_FACTS)).toHaveLength(2);
  });
  it('T7-2 2 台设备尾期（>24字符隔离防前词误绑定）→ 聚合 1 条 issue 含双条目', () => {
    const md = `计划工期210日历天。挖掘机第210日进场。${'支'.repeat(15)}空压机第210日进场。`;
    const issues = equipmentEntryTimingIssues(md, EMPTY_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('挖掘机 第210日进场');
    expect(issues[0].message).toContain('空压机 第210日进场');
  });
  it('T7-3 4 台设备尾期 → message 展示截断 slice(0,3)，第 4 台不入 message', () => {
    const md = `计划工期210日历天。挖掘机第210日进场。${'支'.repeat(15)}装载机第210日进场。${'支'.repeat(15)}压路机第210日进场。${'支'.repeat(15)}平地机第210日进场。`;
    const issues = equipmentEntryTimingIssues(md, EMPTY_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('挖掘机');
    expect(issues[0].message).toContain('压路机');
    expect(issues[0].message).not.toContain('平地机');
  });
  it('T7-4 2 台 PIT 设备倒挂（>24字符隔离）→ 聚合 1 条 issue', () => {
    const md = `第60日完成基坑支护及土方外运。挖掘机第75日进场。${'支'.repeat(15)}空压机第80日进场。`;
    const issues = equipmentEntryTimingIssues(md, EMPTY_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('挖掘机 第75日进场');
    expect(issues[0].message).toContain('空压机 第80日进场');
  });
  it('T7-5 同 equipment:raw 重复段 → 去重为 1 条目', () => {
    const md = 'ABCDEFGHIJKLMNOPQ挖掘机第210日进场ABCDEFGHIJKLMNOPQ挖掘机第210日进场。计划工期210日历天。';
    const issues = equipmentEntryTimingIssues(md, EMPTY_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].message.match(/第210日进场/gu)).toHaveLength(1);
  });
  it('T7-6 空 markdown → 不报', () => {
    expect(equipmentEntryTimingIssues('', EMPTY_FACTS)).toEqual([]);
  });
  it('T7-7 无设备词句 → 不报', () => {
    expect(equipmentEntryTimingIssues('计划工期210日历天。第210日完成主体结构封顶。', EMPTY_FACTS)).toEqual([]);
  });
  it('T7-8 宽词「安装」误触锁定：挖掘机完成机电安装句 → 倒挂报（真实行为）', () => {
    const md = '第60日完成基坑支护及土方外运。挖掘机第61日完成机电安装及智能化调试。';
    expect(equipmentEntryTimingIssues(md, EMPTY_FACTS)).toHaveLength(1);
  });
  it('T7-9 宽词「调试」误触锁定：推土机进入调试阶段句 → 倒挂报（真实行为）', () => {
    const md = '第60日完成基坑支护及土方外运。推土机第61日进入调试阶段。';
    expect(equipmentEntryTimingIssues(md, EMPTY_FACTS)).toHaveLength(1);
  });
});

// ── T8. 动作词窗口排除字符谱系 ──

describe('T8 动作词窗口排除字符谱系', () => {
  it('T8-1 窗口首字符「|」→ 不匹配不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日|进场。计划工期210日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T8-2 窗口首字符「。」→ 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日。进场。计划工期210日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T8-3 窗口首字符「；」→ 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日；进场。计划工期210日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T8-4 窗口首字符「;」→ 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日;进场。计划工期210日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T8-5 窗口首字符换行 → 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日\n进场。计划工期210日历天。', EMPTY_FACTS)).toEqual([]);
  });
});

// ── T10. 总工期锚点谱系 / 锚点后窗口边界 / facts 兜底 / 正文优先 ──

describe('T10 总工期锚点谱系与窗口边界', () => {
  const ANCHORS = ['计划工期', '合同工期', '总工期', '工期总日历天数'] as const;
  it.each(ANCHORS)('T10-1 锚点“%s”210日历天 → 尾期报', (anchor) => {
    expect(equipmentEntryTimingIssues(`挖掘机第210日进场。${anchor}210日历天。`, EMPTY_FACTS)).toHaveLength(1);
  });
  it('T10-2 「个」可选：「计划工期210个日历天」→ 报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日进场。计划工期210个日历天。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T10-3 锚点前「约」1字符入窗口 → 报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日进场。计划工期约210日历天。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T10-4 锚点后 12 字符（恰上限）→ 报', () => {
    expect(equipmentEntryTimingIssues(`挖掘机第210日进场。计划工期${'X'.repeat(12)}210日历天。`, EMPTY_FACTS)).toHaveLength(1);
  });
  it('T10-5 锚点后 13 字符（超上限，数字被窗口吞）→ 不报', () => {
    expect(equipmentEntryTimingIssues(`挖掘机第210日进场。计划工期${'X'.repeat(13)}210日历天。`, EMPTY_FACTS)).toEqual([]);
  });
  it('T10-6 锚点后直接句号截断 → total undefined 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日进场。计划工期。210日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T10-7 中文数字「二百一十」（非 \d）→ total undefined 不报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日进场。计划工期二百一十日历天。', EMPTY_FACTS)).toEqual([]);
  });
  it('T10-8 锚点后「—」特殊字符入窗口 → 报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日进场。计划工期—210日历天。', EMPTY_FACTS)).toHaveLength(1);
  });
  it('T10-9 「计划总工期」含「总工期」锚点子串 → 报', () => {
    expect(equipmentEntryTimingIssues('挖掘机第210日进场。计划总工期210日历天。', EMPTY_FACTS)).toHaveLength(1);
  });
});

describe('T10 factsModel.schedule 兜底与正文优先', () => {
  it('T10-10 正文无锚点，facts value 含锚点词 → 兜底 total=210 报', () => {
    const facts = factsOf({ schedule: [factOf({ value: '合同工期210日历天' })] });
    expect(equipmentEntryTimingIssues('挖掘机第210日进场。', facts)).toHaveLength(1);
  });
  it('T10-11 facts key+value 拼接成锚点句 → 兜底报', () => {
    const facts = factsOf({ schedule: [factOf({ key: '总工期', value: '210日历天' })] });
    expect(equipmentEntryTimingIssues('挖掘机第210日进场。', facts)).toHaveLength(1);
  });
  it('T10-12 facts value 无锚点词 → 兜底无效不报', () => {
    const facts = factsOf({ schedule: [factOf({ value: '210日历天' })] });
    expect(equipmentEntryTimingIssues('挖掘机第210日进场。', facts)).toEqual([]);
  });
  it('T10-13 正文300优先于 facts210 → day=300 报', () => {
    const facts = factsOf({ schedule: [factOf({ value: '计划工期210日历天' })] });
    expect(equipmentEntryTimingIssues('挖掘机第300日进场。合同工期300日历天。', facts)).toHaveLength(1);
  });
  it('T10-14 正文300优先 → day=239 不报（facts210 不生效）', () => {
    const facts = factsOf({ schedule: [factOf({ value: '计划工期210日历天' })] });
    expect(equipmentEntryTimingIssues('挖掘机第239日进场。合同工期300日历天。', facts)).toEqual([]);
  });
});
