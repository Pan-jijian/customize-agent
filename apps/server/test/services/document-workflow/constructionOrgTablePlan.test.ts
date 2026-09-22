/**
 * 4.12.5 组级表格计划过滤单测：主题块并发链路每组只注入本组小节承接的表计划，
 * 末组额外承接全章未分配表，避免每组看到全章表计划导致跨组重复输出。
 * R20 追加：表格执行率逐表对账单测（数量口径 → 逐表匹配，通用判据无项目硬编码）；
 * R20 C3 追加：题注注入器单测（幂等重跑/三形态/章号推进/附表区不注入）；
 * R20 C1 追加：图类呈现元件单测（提取/语义归属/指令渲染）；
 * r26d 追加：终稿无题表题名回填单测（草稿表头键反查/歧义不回填/幂等）。
 * B-T1 追加：图位/图题机制单测（编号归一化/引用同步/补位注入/规格汇集/覆盖对账/无内部话术）。
 */
import { describe, expect, it } from 'vitest';
import { attachDiagramArtifacts, collectFigurePlaceholderSpecs, completeTitlelessTableTitles, diagramRequirementsPrompt, ensureFigurePlaceholders, extractDiagramArtifacts, extractFigureCaptions, extractMarkdownTableCandidates, figureCoverage, groupTablePlansForSections, injectTableCaptions, mergeStructureDiagramArtifacts, normalizeFigureNumbering, normalizeFigureSpecName, normalizeTableNumbering, recoverTitlelessTableTitlesFromDrafts, splitGluedTableCaptions, tablePlanExecutionGaps } from '@/services/document-workflow/constructionOrgTablePlan';
import { scanTableNumberingDefects } from '@/services/document-workflow/structureIntegrityRules';
import { figureSubstituteTableLines } from '@/services/document-workflow/figureSubstituteTables';
import { figureSubstituteTableIssues } from '@/services/document-workflow/documentIntegrityChecks';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';
import type { DocumentTemplateChapter, PlannedTablePlan } from '@/services/document-workflow/types';

function tablePlan(id: string, section: string): PlannedTablePlan {
  return {
    id,
    title: `${section}表`,
    chapterTitle: '资源配置与投入计划',
    section,
    required: false,
    reason: '融合规划产出',
    fields: [],
  };
}

function chapter(plans: PlannedTablePlan[]): DocumentTemplateChapter {
  return { id: 'ch1', title: '资源配置与投入计划', purpose: '', tablePlans: plans } as DocumentTemplateChapter;
}

describe('groupTablePlansForSections 组级表格计划过滤（4.12.5）', () => {
  it('非末组只注入本组小节承接的表计划', () => {
    const plans = [tablePlan('a', '劳动力投入计划'), tablePlan('b', '材料进场计划'), tablePlan('c', '机械配置计划')];
    const filtered = groupTablePlansForSections(chapter(plans), ['劳动力投入计划'], []);
    expect(filtered.map(plan => plan.id)).toEqual(['a']);
  });

  it('末组额外承接全章未分配表', () => {
    const plans = [tablePlan('a', '劳动力投入计划'), tablePlan('b', '材料进场计划'), tablePlan('c', '机械配置计划')];
    // 全章小节标题承接了劳动力与材料表，机械表未分配 → 末组兜底承接
    const filtered = groupTablePlansForSections(chapter(plans), ['质量保证措施'], ['劳动力投入计划', '材料进场计划']);
    expect(filtered.map(plan => plan.id)).toEqual(['c']);
  });

  it('末组同时承接本组归属表与未分配表且不重复', () => {
    const plans = [tablePlan('a', '劳动力投入计划'), tablePlan('b', '材料进场计划'), tablePlan('c', '机械配置计划')];
    // 全章小节承接了劳动力与材料表，机械表未分配 → 末组兜底承接
    const filtered = groupTablePlansForSections(chapter(plans), ['劳动力投入计划'], ['劳动力投入计划', '材料进场计划']);
    expect(filtered.map(plan => plan.id)).toEqual(['a', 'c']);
  });

  it('无表计划时返回空数组', () => {
    expect(groupTablePlansForSections(chapter([]), ['劳动力投入计划'], ['劳动力投入计划'])).toEqual([]);
  });
});

describe('tablePlanExecutionGaps 逐表对账（R20：数量口径 → 逐表匹配）', () => {
  const chapterOf = (plans: PlannedTablePlan[]): DocumentTemplateChapter =>
    ({ id: 'ch1', title: '资源配置与投入计划', purpose: '', tablePlans: plans }) as DocumentTemplateChapter;
  const draftOf = (content: string) => [{ title: '资源配置与投入计划', content }];
  const planOf = (id: string, title: string, fields: string[] = []): PlannedTablePlan => ({
    id, title, chapterTitle: '资源配置与投入计划', section: '', required: false, reason: '规划产出',
    fields: fields.map(name => ({ name })),
  });

  it('丢 1 张表即检出（旧数量口径 3/4 ≥60% 会漏网）', () => {
    const plans = [
      planOf('a', '劳动力投入计划表'),
      planOf('b', '主要材料进场计划表'),
      planOf('c', '施工机械设备配置表'),
      planOf('d', '资金使用计划表'),
    ];
    const md = [
      '### 劳动力投入', '劳动力投入计划表', '',
      '| 序号 | 工种 | 人数 |', '|---|---|---|', '| 1 | 普工 | 10 |', '',
      '### 材料进场', '主要材料进场计划表', '',
      '| 序号 | 材料名称 | 单位 |', '|---|---|---|', '| 1 | 水泥 | t |', '',
      '### 机械配置', '施工机械设备配置表', '',
      '| 序号 | 设备名称 | 台数 |', '|---|---|---|', '| 1 | 挖机 | 2 |',
    ].join('\n');
    const gaps = tablePlanExecutionGaps([chapterOf(plans)], draftOf(md));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].planned).toBe(4);
    expect(gaps[0].actual).toBe(3);
    expect(gaps[0].plans.map(plan => plan.id)).toEqual(['d']);
  });

  it('表名漂移不误报（核心词通道：“劳动力配置汇总表”↔“分阶段劳动力投入表”）', () => {
    const md = ['分阶段劳动力投入表', '', '| 序号 | 工种 | 人数 |', '|---|---|---|', '| 1 | 普工 | 10 |'].join('\n');
    expect(tablePlanExecutionGaps([chapterOf([planOf('a', '劳动力配置汇总表')])], draftOf(md))).toEqual([]);
  });

  it('表名占表头首格（脏形态）视为已承接', () => {
    const md = ['| 分阶段劳动力投入表 | 工种 | 人数 |', '|---|---|---|', '| 普工 | 10 | 5 |'].join('\n');
    expect(tablePlanExecutionGaps([chapterOf([planOf('a', '分阶段劳动力投入表')])], draftOf(md))).toEqual([]);
  });

  it('表题与后文粘连（超长行）按表名前缀截取后承接', () => {
    const md = [
      '施工机械设备投入计划表上述措施纳入招标文件要求并严格执行，同时结合现场实际动态调整资源配置计划与作业安排。', '',
      '| 序号 | 设备名称 | 台数 |', '|---|---|---|', '| 1 | 挖机 | 2 |',
    ].join('\n');
    expect(tablePlanExecutionGaps([chapterOf([planOf('a', '施工机械设备投入计划表')])], draftOf(md))).toEqual([]);
  });

  it('题注编号前缀（“表3-2”）剥离后承接', () => {
    const md = ['表3-2 劳动力投入计划表', '', '| 序号 | 工种 | 人数 |', '|---|---|---|', '| 1 | 普工 | 10 |'].join('\n');
    expect(tablePlanExecutionGaps([chapterOf([planOf('a', '劳动力投入计划表')])], draftOf(md))).toEqual([]);
  });

  it('表题缺失时表头字段覆盖通道兜底承接', () => {
    const md = ['以下是本项目管理人员安排。', '', '| 姓名 | 职务 | 联系方式 |', '|---|---|---|', '| 张三 | 项目经理 | 13800000000 |'].join('\n');
    expect(tablePlanExecutionGaps([chapterOf([planOf('a', '组织人员名单表', ['姓名', '职务', '联系方式'])])], draftOf(md))).toEqual([]);
  });

  it('一对一分配：两个相近计划表只有一张实际表时另一个缺失', () => {
    const md = ['劳动力投入计划表', '', '| 序号 | 工种 | 人数 |', '|---|---|---|', '| 1 | 普工 | 10 |'].join('\n');
    const gaps = tablePlanExecutionGaps([chapterOf([planOf('a', '劳动力投入计划表'), planOf('b', '劳动力投入表')])], draftOf(md));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].plans.map(plan => plan.id)).toEqual(['b']);
  });
});

describe('injectTableCaptions 题注注入（R20 C3）', () => {
  it('标准表题行注入「表{章号}-{章内序号}」且章内序号递增、换章重置', () => {
    const md = [
      '## 第三章 资源配置与投入计划', '',
      '表题一表', '',
      '| 序号 | 工种 | 人数 |', '|---|---|---|', '| 1 | 普工 | 10 |', '',
      '表题二表', '',
      '| 序号 | 材料 | 单位 |', '|---|---|---|', '| 1 | 水泥 | t |', '',
      '## 第四章 施工进度计划', '',
      '表题三表', '',
      '| 序号 | 节点 | 日期 |', '|---|---|---|', '| 1 | 开工 | 2026-01 |',
    ].join('\n');
    const output = injectTableCaptions(md);
    expect(output).toContain('表3-1 表题一表');
    expect(output).toContain('表3-2 表题二表');
    expect(output).toContain('表4-1 表题三表');
  });

  it('幂等：已带题注前缀（表3-1）重跑不重复注入', () => {
    const md = ['## 第三章 XX', '', '表3-1 表题一表', '', '| 序号 | 工种 |', '|---|---|', '| 1 | 普工 |'].join('\n');
    const once = injectTableCaptions(md);
    expect(once).toBe(md);
    expect(injectTableCaptions(once)).toBe(once);
  });

  it('表名占表头首格（脏形态）：移出为独立题注行并恢复表头首列', () => {
    const md = ['## 第三章 XX', '', '| 劳动力投入计划表 | 工种 | 人数 |', '|---|---|---|', '| 普工 | 10 | 5 |'].join('\n');
    const output = injectTableCaptions(md);
    expect(output).toContain('表3-1 劳动力投入计划表');
    expect(output).toContain('| 工种 | 人数 |');
    expect(output).not.toContain('| 劳动力投入计划表 | 工种 |');
  });

  it('表题与后文粘连：拆为题注行+余文行，正文零丢失', () => {
    const md = [
      '## 第三章 XX', '',
      '施工机械设备投入计划表上述措施纳入现场管理并结合进度动态调整资源配置与作业安排。', '',
      '| 序号 | 设备名称 | 台数 |', '|---|---|---|', '| 1 | 挖机 | 2 |',
    ].join('\n');
    const output = injectTableCaptions(md);
    expect(output).toContain('表3-1 施工机械设备投入计划表');
    expect(output).toContain('上述措施纳入现场管理并结合进度动态调整资源配置与作业安排。');
  });

  it('附表区（## 附表N）表格不注入且不影响正文章号', () => {
    const md = [
      '## 第三章 XX', '',
      '正文表题表', '',
      '| 序号 | 工种 |', '|---|---|', '| 1 | 普工 |', '',
      '## 附表一 法定附表', '',
      '附表表题表', '',
      '| 序号 | 名称 |', '|---|---|', '| 1 | 甲 |',
    ].join('\n');
    const output = injectTableCaptions(md);
    expect(output).toContain('表3-1 正文表题表');
    expect(output).not.toContain('表3-2 附表表题表');
    expect(output).toContain('附表表题表');
  });

  it('无题名形态表格不注入（由终检 table-caption 报出人工核对）', () => {
    const md = ['## 第三章 XX', '', '以下是安排情况。', '', '| 序号 | 工种 |', '|---|---|', '| 1 | 普工 |'].join('\n');
    const output = injectTableCaptions(md);
    expect(output).not.toContain('表3-1');
  });

  it('无编号章标题按出现顺序推进章号；阿拉伯数字章号直接解析', () => {
    const md = [
      '## 资源配置计划', '',
      '表题一表', '',
      '| 序号 | 工种 |', '|---|---|', '| 1 | 普工 |', '',
      '## 第12章 进度计划', '',
      '表题二表', '',
      '| 序号 | 节点 |', '|---|---|', '| 1 | 开工 |',
    ].join('\n');
    const output = injectTableCaptions(md);
    expect(output).toContain('表1-1 表题一表');
    expect(output).toContain('表12-1 表题二表');
  });

  it('extractMarkdownTableCandidates 题注字段：注入后全文 captioned', () => {
    const md = ['## 第三章 XX', '', '表题一表', '', '| 序号 | 工种 |', '|---|---|', '| 1 | 普工 |'].join('\n');
    const output = injectTableCaptions(md);
    const candidates = extractMarkdownTableCandidates(output);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].captioned).toBe(true);
    expect(candidates[0].title).toBe('表题一表');
  });

  it('r23 P3b 引导句形态：锚点前提取表名，原行保留、题注行插入表格正上方', () => {
    const md = [
      '## 第三章 资源配置与投入计划', '',
      '为便于现场组织施工，现将主要施工内容与工程量汇总如下表，表中工程量以清单为准。', '',
      '| 专业工程 | 施工内容 | 工程量 |', '|---|---|---|', '| 道路工程 | 路面硬化 | 按清单 |',
    ].join('\n');
    const output = injectTableCaptions(md);
    expect(output).toContain('表3-1 主要施工内容与工程量汇总');
    // 原引导句保留（不改写不吞原文），题注行位于表格正上方
    expect(output).toContain('为便于现场组织施工，现将主要施工内容与工程量汇总如下表，表中工程量以清单为准。');
    expect(output).toContain('表3-1 主要施工内容与工程量汇总\n\n| 专业工程 | 施工内容 | 工程量 |');
  });

  it('r23 P3b 「按…枚举…汇总」引导句：截断枚举字段串取表名主体', () => {
    const md = [
      '## 第三章 XX', '',
      '亮化工程主要施工方法控制要点按分项工程、施工工序、工艺参数、责任岗位汇总如下表，用于指导班组作业。', '',
      '| 分项工程 | 施工工序 | 控制要点 |', '|---|---|---|', '| 路灯 | 组立 | 垂直度 |',
    ].join('\n');
    const output = injectTableCaptions(md);
    expect(output).toContain('表3-1 亮化工程主要施工方法控制要点');
  });

  it('r23 P3b 叙述句动词形态：编制/建立+名词短语+尾词提取表名', () => {
    const md = [
      '## 第三章 XX', '',
      '项目部按五个施工阶段编制工期关键节点控制表，明确各阶段计划完成时间与责任岗位。', '',
      '| 施工阶段 | 关键节点 | 计划完成时间 |', '|---|---|---|', '| 准备 | 清杂完成 | 第7天 |',
    ].join('\n');
    const output = injectTableCaptions(md);
    expect(output).toContain('表3-1 工期关键节点控制表');
  });

  it('r23 P3b 标题行形态：以“表”结尾的紧邻标题作为表名注入且标题保留', () => {
    const md = [
      '## 第三章 XX', '',
      '#### 项目基本信息表', '',
      '| 信息项 | 内容 |', '|---|---|', '| 项目名称 | 示例项目 |',
    ].join('\n');
    const output = injectTableCaptions(md);
    expect(output).toContain('表3-1 项目基本信息表');
    expect(output).toContain('#### 项目基本信息表');
  });

  it('r23 P3b 「按…」叙述句（顿号紧贴但非枚举清单）：截断无效自动回退，不误切真实表名', () => {
    const md = [
      '## 第三章 XX', '',
      '项目经理按事故等级在1小时内向建设单位、监理单位及主管部门报告。应急救援物资与设备配置表如下：相关要求纳入管理制度。', '',
      '| 物资名称 | 规格 | 数量 |', '|---|---|---|', '| 急救箱 | 便携 | 每班组1个 |',
    ].join('\n');
    const output = injectTableCaptions(md);
    expect(output).toContain('表3-1 应急救援物资与设备配置表');
  });

  it('r23 P3b 反例：引导句候选尾词不符（承诺/说明句）不提取不注入', () => {
    const md = [
      '## 第三章 XX', '',
      '我公司郑重承诺，各项事宜如下：相关内容纳入管理制度。', '',
      '| 序号 | 事项 |', '|---|---|', '| 1 | 甲 |',
    ].join('\n');
    const output = injectTableCaptions(md);
    expect(output).not.toContain('表3-1');
  });

  it('r23 P3b leadIn 形态幂等：重跑不重复注入', () => {
    const md = [
      '## 第三章 XX', '',
      '项目部编制工期关键节点控制表，明确各阶段计划完成时间。', '',
      '| 施工阶段 | 关键节点 |', '|---|---|', '| 准备 | 清杂完成 |',
    ].join('\n');
    const once = injectTableCaptions(md);
    expect(once).toContain('表3-1 工期关键节点控制表');
    expect(injectTableCaptions(once)).toBe(once);
  });

  it('r28h 归因：残缺题注前缀（表3-题名）剥离后按当前表序重编号，无双编号', () => {
    // r28h2 实测：题注编号表序段被数值清理误删后的「表3-路结构层…」形态不被前缀判据识别，
    // 重跑注入产出「表3-1 表3-路结构层…」双编号；M4b 剥离残缺前缀后重编号（幂等）
    const md = ['## 第三章 XX', '', '表3-路结构层主要物资投入计划表', '', '| 物资名称 | 规格型号 | 单位 |', '|---|---|---|', '| 水泥 | P.O42.5 | t |'].join('\n');
    const output = injectTableCaptions(md);
    expect(output).toContain('表3-1 路结构层主要物资投入计划表');
    expect(output).not.toContain('表3-1 表3-');
    expect(injectTableCaptions(output)).toBe(output);
  });
});

describe('r24 B8 题名形态扩展与无题表确定性补名', () => {
  it('「按下表记录」引导句：锚点提取表名，原行完整保留（防畸形题注/孤立残行）', () => {
    const md = [
      '## 第九章 交通组织与便民措施', '',
      '居民出行临时便道维护情况按下表记录，各便道位置、维护频次与责任单位按现场管理要求执行。', '',
      '| 便道位置 | 维护频次 | 责任单位 |', '|---|---|---|', '| 便道一 | 每日巡查 | 综合班组 |',
    ].join('\n');
    const output = injectTableCaptions(md);
    expect(output).toContain('表9-1 居民出行临时便道维护情况');
    // 原引导句完整保留，不产生「…按下表」截断题名与「记录，…」孤立残行
    expect(output).toContain('居民出行临时便道维护情况按下表记录，各便道位置、维护频次与责任单位按现场管理要求执行。');
    expect(output).not.toContain('表9-1 居民出行临时便道维护情况按下表');
  });

  it('整行加粗表题：取加粗内容为表题，替换后无加粗标记残留', () => {
    const md = [
      '## 第三章 XX', '',
      '**项目基本信息表**', '',
      '| 信息项 | 内容 |', '|---|---|', '| 项目名称 | 示例项目 |',
    ].join('\n');
    const output = injectTableCaptions(md);
    expect(output).toContain('表3-1 项目基本信息表');
    expect(output).not.toContain('**');
  });

  it('反例：无表名引导句（如下表所示）不误截为畸形题名也不注入', () => {
    const md = [
      '## 第三章 XX', '',
      '各岗位安全职责如下表所示。', '',
      '| 岗位 | 安全职责 |', '|---|---|', '| 项目经理 | 全面负责 |',
    ].join('\n');
    const output = injectTableCaptions(md);
    expect(output).not.toContain('表3-1 各岗位安全职责如下表');
    expect(output).not.toContain('表3-1 各岗位安全职责如下表所示');
  });

  it('无题表确定性补名：表头字段与本章计划表对账，补独立表题行', () => {
    const md = [
      '## 第三章 XX', '',
      '| 工种 | 人数 | 进场时间 |', '|---|---|---|', '| 普工 | 10 | 第1天 |',
    ].join('\n');
    const plans: PlannedTablePlan[] = [{ id: 'p1', title: '劳动力投入计划表', chapterTitle: 'XX', section: '', required: false, reason: '', fields: [{ name: '工种' }, { name: '人数' }, { name: '进场时间' }] }];
    const result = completeTitlelessTableTitles(md, plans);
    expect(result.completed).toBe(1);
    expect(result.markdown).toContain('劳动力投入计划表\n\n| 工种 | 人数 | 进场时间 |');
  });

  it('无题表确定性补名反例：字段覆盖不足/计划表字段过少不配对', () => {
    const md = [
      '## 第三章 XX', '',
      '| 工种 | 人数 | 进场时间 |', '|---|---|---|', '| 普工 | 10 | 第1天 |',
    ].join('\n');
    const noCoverage: PlannedTablePlan[] = [{ id: 'p1', title: '部位检查表', chapterTitle: 'XX', section: '', required: false, reason: '', fields: [{ name: '部位' }, { name: '数量' }, { name: '规格' }] }];
    expect(completeTitlelessTableTitles(md, noCoverage)).toEqual({ markdown: md, completed: 0 });
    const tooFewFields: PlannedTablePlan[] = [{ id: 'p2', title: '劳动力投入计划表', chapterTitle: 'XX', section: '', required: false, reason: '', fields: [{ name: '工种' }] }];
    expect(completeTitlelessTableTitles(md, tooFewFields)).toEqual({ markdown: md, completed: 0 });
  });
});

describe('C1 图类呈现元件（提取/归属/指令）', () => {
  it('从要求条目提取图类元件（正文与核心词双通道），同名去重', () => {
    const entries = [
      { text: '总进度计划须含网络图、横道图及专业分包设计深化内容', coreTerms: ['网络图', '横道图', '专业分包设计深化'] },
      { text: '另一条再次提到横道图与对应用语', coreTerms: ['横道图'] },
      { text: '与图表无关的条款', coreTerms: ['材料进场'] },
    ];
    const artifacts = extractDiagramArtifacts(entries);
    expect(artifacts.map(artifact => artifact.name).sort()).toEqual(['横道图', '网络图'].sort());
    const network = artifacts.find(artifact => artifact.name === '网络图');
    const gantt = artifacts.find(artifact => artifact.name === '横道图');
    expect(network?.instruction).toContain('文字框图');
    expect(network?.source).toContain('总进度计划');
    expect(gantt?.instruction).toContain('时间轴');
    expect(gantt?.source).toContain('总进度计划');
  });

  it('语义归属：高相似度挂章，低于阈值不注入', () => {
    const chapters = [
      { id: 'c8', title: '确保工期的技术组织措施', purpose: '' } as DocumentTemplateChapter,
      { id: 'c10', title: '施工总平面布置图', purpose: '' } as DocumentTemplateChapter,
    ];
    const artifacts = [
      { name: '横道图', instruction: '以表格式时间轴呈现', source: '总进度计划须含横道图' },
      { name: '布置图', instruction: '以分区布置的文字框图呈现', source: '冷门要求' },
    ];
    const similarity = (source: string, title: string) => (source.includes('总进度计划') && title === '确保工期的技术组织措施' ? 0.8 : 0.2);
    const result = attachDiagramArtifacts(chapters, artifacts, similarity);
    expect(result.chapters[0].diagramRequirements).toHaveLength(1);
    expect(result.chapters[0].diagramRequirements?.[0]).toContain('横道图');
    expect(result.chapters[1].diagramRequirements).toBeUndefined();
    expect(result.unattached.map(artifact => artifact.name)).toEqual(['布置图']);
  });

  it('无归属时章节不变；指令渲染含框图表征与要求原文', () => {
    const chapters = [{ id: 'c8', title: '确保工期的技术组织措施', purpose: '' } as DocumentTemplateChapter];
    const passed = attachDiagramArtifacts(chapters, [{ name: '横道图', instruction: '以表格式时间轴呈现', source: 'x' }], () => 0);
    expect(passed.chapters[0]).toBe(chapters[0]);
    expect(passed.unattached).toHaveLength(1);
    const prompt = diagramRequirementsPrompt({ ...chapters[0], diagramRequirements: ['「横道图」以表格式时间轴呈现（阶段与节点）。'] });
    expect(prompt).toContain('文字框图');
    expect(prompt).toContain('表格式时间轴');
    expect(prompt).toContain('「横道图」');
    expect(diagramRequirementsPrompt(chapters[0])).toBe('');
  });
});

/** r25 B1 假数据构件（纯虚构名称，零项目专名）：通用两列小表 */
function fakeTable(): string {
  return '| 项目 | 说明 |\n| --- | --- |\n| 甲 | 现场核验 |';
}

describe('r25 B1 题注粘连拆分（splitGluedTableCaptions）', () => {
  it('首「表」截取判据：题注名 + 后随余文同居一行 → 拆为题注行 + 空行 + 余文行', () => {
    const glued = '表1-1 设备进场检验记录表上述要求纳入作业流程管理，班组每日核对并留存记录。';
    expect(splitGluedTableCaptions(glued).split('\n')).toEqual([
      '表1-1 设备进场检验记录表',
      '',
      '上述要求纳入作业流程管理，班组每日核对并留存记录。',
    ]);
  });

  it('回指锚切分判据：题名不含「表」字时按「上述/相关」类衔接词切分', () => {
    const glued = '表3-2 工种配置与技能要求上述措施以专项方案为依据逐项落实，管理人员每日跟进检查。';
    expect(splitGluedTableCaptions(glued).split('\n')).toEqual([
      '表3-2 工种配置与技能要求',
      '',
      '上述措施以专项方案为依据逐项落实，管理人员每日跟进检查。',
    ]);
  });

  it('干净题注/引用整句/断行残形/短余文一律原样保留', () => {
    const clean = '表1-1 设备进场检验记录表';
    expect(splitGluedTableCaptions(clean)).toBe(clean);
    // 引用整句（含句读，题名校验拒绝）
    const reference = '表7-1 用于逐处锁定保护责任与检查频次，安全员按表相关控制内容编入工序卡与操作规程。';
    expect(splitGluedTableCaptions(reference)).toBe(reference);
    // 断行残形（题名后无余文）
    const residual = '表6-1 材料进场检验与试验计划按表\n列项目执行。';
    expect(splitGluedTableCaptions(residual)).toBe(residual);
    // 短余文（低于拆分阈值）
    const short = '表1-1 设备台账上述要求。';
    expect(splitGluedTableCaptions(short)).toBe(short);
  });

  it('幂等：拆分结果再次通过无变化', () => {
    const glued = '表1-1 设备进场检验记录表上述要求纳入作业流程管理，班组每日核对并留存记录。';
    const once = splitGluedTableCaptions(glued);
    expect(splitGluedTableCaptions(once)).toBe(once);
  });

  it('r28h 归因：行尾粘连镜像形态（正文句读 + 表N-M 题名同行）→ 拆为正文行 + 空行 + 题注行', () => {
    // r28h2 实测：LLM 补名把题名写回正文句尾（「…验收。表5-2 道路区段…清单」同行），
    // probe 上溯因行内含「。」跳过致 kind='none'，题注链全链不消费
    const glued = '各检验批由施工员组织班组自检，质检员复验合格后报监理单位验收。道路区段各工种配置按下表执行。表5-2 道路区段劳动力工种配置与责任清单';
    expect(splitGluedTableCaptions(glued).split('\n')).toEqual([
      '各检验批由施工员组织班组自检，质检员复验合格后报监理单位验收。道路区段各工种配置按下表执行。',
      '',
      '表5-2 道路区段劳动力工种配置与责任清单',
    ]);
  });

  it('r28h 行尾形态反例：非句读前导/题名不符/表格行/标题行一律不拆', () => {
    // 引用句（无句读前导）
    const reference = '各工种配置见表5-2 道路区段劳动力工种配置与责任清单';
    expect(splitGluedTableCaptions(reference)).toBe(reference);
    // 题名尾词不符（「所示采用商品混凝土浇筑」）
    const noTail = '检测方法详见。表5-2 所示采用商品混凝土浇筑';
    expect(splitGluedTableCaptions(noTail)).toBe(noTail);
    // 表格行与标题行不处理
    const tableRow = '| 表5-2 道路区段劳动力工种配置与责任清单 |';
    expect(splitGluedTableCaptions(tableRow)).toBe(tableRow);
    const heading = '#### 表5-2 道路区段劳动力工种配置与责任清单';
    expect(splitGluedTableCaptions(heading)).toBe(heading);
  });

  it('r28h 行尾形态幂等：拆分结果再次通过无变化', () => {
    const glued = '各检验批由施工员组织班组自检。表5-2 道路区段劳动力工种配置与责任清单';
    const once = splitGluedTableCaptions(glued);
    expect(once).toContain('表5-2 道路区段劳动力工种配置与责任清单');
    expect(splitGluedTableCaptions(once)).toBe(once);
  });
});

describe('r25 B1 表编号唯一化（normalizeTableNumbering）', () => {
  it('重复编号消解：含重复编号的章按出现序整体重排 + 引用同步 + 终检函数零缺陷', () => {
    const doc = [
      '## 第一章 编制说明',
      '表1-1 甲计划表',
      fakeTable(),
      '表1-1 乙台账',
      fakeTable(),
      '按表1-1执行相关要求。',
      '表1-2 丙汇总',
      fakeTable(),
      '详见表1-2的规定。',
    ].join('\n');
    const out = normalizeTableNumbering(doc);
    expect(out).toContain('表1-1 甲计划表');
    expect(out).toContain('表1-2 乙台账');
    expect(out).toContain('表1-3 丙汇总');
    // 歧义键（重复编号本身）不建引用映射，原引用保持
    expect(out).toContain('按表1-1执行');
    // 无歧义键的引用同步到新编号
    expect(out).toContain('详见表1-3的规定');
    expect(scanTableNumberingDefects(out)).toHaveLength(0);
  });

  it('粘连拆分 + 续文回位：题注恢复贴表，回指余文移到表后', () => {
    const doc = [
      '## 第一章 编制说明',
      '表1-1 甲计划表',
      fakeTable(),
      '表1-1 乙计划表上述要求纳入作业流程管理，班组每日核对并留存记录。',
      fakeTable(),
    ].join('\n');
    const out = normalizeTableNumbering(doc);
    expect(out).toContain('表1-2 乙计划表');
    expect(out).toContain('表1-2 乙计划表\n\n| 项目 | 说明 |');
    expect(out).toContain('| 甲 | 现场核验 |\n\n上述要求纳入作业流程管理，班组每日核对并留存记录。');
    expect(scanTableNumberingDefects(out)).toHaveLength(0);
  });

  it('悬空题注（表格缺失残留）纳入章内序参与唯一化，防悬挂编号撞号', () => {
    const doc = [
      '## 第一章 编制说明',
      '表1-1 甲计划表',
      fakeTable(),
      '表1-1 乙台账上述要求纳入作业流程管理，班组每日核对并留存记录。',
      fakeTable(),
      '表1-2 悬空汇总',
      '本段为正文叙述，描述现场布置与实施安排。',
    ].join('\n');
    const out = normalizeTableNumbering(doc);
    expect(out).toContain('表1-2 乙台账');
    expect(out).toContain('表1-3 悬空汇总');
  });

  it('引用行/量词形态防误伤：「表1张」类量词不被当作引用改写', () => {
    const doc = [
      '## 第二章 施工方案',
      '表2-1 甲台账',
      fakeTable(),
      '表2-1 乙记录',
      fakeTable(),
      '表1 丙要求',
      fakeTable(),
      '汇总表1张，其余详见说明。',
    ].join('\n');
    const out = normalizeTableNumbering(doc);
    expect(out).toContain('表2-2 乙记录');
    expect(out).toContain('表2-3 丙要求');
    expect(out).toContain('汇总表1张');
  });

  it('跨章隔离：无重复编号的章零改动；幂等重放逐字符一致', () => {
    const doc = [
      '## 第二章 施工方案',
      '表2-1 甲台账',
      fakeTable(),
      '表2-1 乙记录',
      fakeTable(),
      '## 第三章 资源配置',
      '表3-1 丙汇总',
      fakeTable(),
      '表3-2 丁计划',
      fakeTable(),
    ].join('\n');
    const out = normalizeTableNumbering(doc);
    expect(out).toContain('表2-2 乙记录');
    expect(out).toContain('表3-1 丙汇总');
    expect(out).toContain('表3-2 丁计划');
    expect(normalizeTableNumbering(out)).toBe(out);
  });

  it('干净文档恒等：无粘连无重复时逐字符不变', () => {
    const clean = [
      '## 第一章 编制说明',
      '表1-1 甲计划表',
      fakeTable(),
      '表1-2 乙台账',
      fakeTable(),
    ].join('\n');
    expect(normalizeTableNumbering(clean)).toBe(clean);
  });
});

describe('r26d 终稿无题表题名回填（recoverTitlelessTableTitlesFromDrafts）', () => {
  const riskHeader = ['| 风险因素 | 影响工序 | 影响程度 |', '|---|---|---|', '| 天气风险 | 土方开挖 | 高 |'];
  // 终稿：风险表无任何题名行（probe 上溯即撞前表数据行 kind='none'），前表已带题注
  const finalMd = [
    '## 第七章 工期保证体系及保证措施', '',
    '表7-1 工期关键节点控制表', '',
    '| 施工阶段 | 控制节点 |', '|---|---|', '| 准备阶段 | 第5日 |', '',
    ...riskHeader,
  ].join('\n');
  // 草稿：同表头表带裸题名行（写作层原始产物）
  const draftMd = [
    '| 施工阶段 | 控制节点 |', '|---|---|', '| 准备阶段 | 第5日 |', '',
    '工期风险识别与应对措施表', '',
    ...riskHeader,
  ].join('\n');

  it('同表头键反查：终稿无题表回填草稿题名，注入链后题注齐备', () => {
    const recovered = recoverTitlelessTableTitlesFromDrafts(finalMd, [draftMd]);
    expect(recovered.recovered).toBe(1);
    expect(recovered.markdown).toContain('工期风险识别与应对措施表\n\n| 风险因素 | 影响工序 | 影响程度 |');
    // 与接线块同口径：回填后接导出链（注入+唯一化）→ 题注编号就位、终检候选全部 captioned
    const chained = normalizeTableNumbering(injectTableCaptions(recovered.markdown));
    expect(chained).toContain('表7-2 工期风险识别与应对措施表');
    expect(extractMarkdownTableCandidates(chained).every(candidate => candidate.captioned)).toBe(true);
  });

  it('草稿题注行剥前缀回填：不产生双前缀', () => {
    const captionedDraft = draftMd.replace('工期风险识别与应对措施表', '表7-9 工期风险识别与应对措施表');
    const recovered = recoverTitlelessTableTitlesFromDrafts(finalMd, [captionedDraft]);
    expect(recovered.recovered).toBe(1);
    expect(recovered.markdown).toContain('工期风险识别与应对措施表\n\n| 风险因素');
    expect(recovered.markdown).not.toContain('表7-9 工期风险识别与应对措施表');
    expect(recovered.markdown).not.toContain('表7-9 表7-9');
  });

  it('歧义键不回填：草稿同表头多题名时保持原样', () => {
    const draftB = draftMd.replace('工期风险识别与应对措施表', '工期风险分析表');
    const recovered = recoverTitlelessTableTitlesFromDrafts(finalMd, [draftMd, draftB]);
    expect(recovered).toEqual({ markdown: finalMd, recovered: 0, details: [] });
  });

  it('草稿同表头表自身无题名（kind=none）不回填', () => {
    const noTitleDraft = draftMd.replace('工期风险识别与应对措施表\n\n', '');
    const recovered = recoverTitlelessTableTitlesFromDrafts(finalMd, [noTitleDraft]);
    expect(recovered).toEqual({ markdown: finalMd, recovered: 0, details: [] });
  });

  it('表头不匹配不回填；终稿无无题表恒等零变更', () => {
    const otherDraft = draftMd.replace('风险因素 | 影响工序 | 影响程度', '检查项目 | 检查方法 | 合格标准');
    expect(recoverTitlelessTableTitlesFromDrafts(finalMd, [otherDraft])).toEqual({ markdown: finalMd, recovered: 0, details: [] });
    const cleanFinal = finalMd.replace('\n\n| 风险因素 | 影响工序 | 影响程度 |\n|---|---|---|\n| 天气风险 | 土方开挖 | 高 |', '');
    expect(recoverTitlelessTableTitlesFromDrafts(cleanFinal, [draftMd])).toEqual({ markdown: cleanFinal, recovered: 0, details: [] });
  });

  it('幂等：回填后重跑零变更（表不再属无题枚举）', () => {
    const recovered = recoverTitlelessTableTitlesFromDrafts(finalMd, [draftMd]);
    const again = recoverTitlelessTableTitlesFromDrafts(recovered.markdown, [draftMd]);
    expect(again.recovered).toBe(0);
    expect(again.markdown).toBe(recovered.markdown);
  });
});

// ═══ B-T1 图位/图题机制 ═══

describe('B-T1 图题编号归一化（normalizeFigureNumbering）', () => {
  it('Writer 乱编号 → 按章序-章内序重排，引用同步；幂等', () => {
    const md = [
      '## 第1章 编制说明',
      '正文段落。',
      '图 9-9 项目管理机构图',
      '上述机构如图 9-9 所示运行。',
      '## 第2章 施工进度计划',
      '图 1-1 施工进度横道图',
      '具体节点见图 1-1。',
    ].join('\n');
    const result = normalizeFigureNumbering(md);
    expect(result).toContain('图1-1 项目管理机构图');
    expect(result).toContain('图2-1 施工进度横道图');
    expect(result).toContain('上述机构如图1-1所示运行。');
    expect(result).toContain('具体节点见图2-1。');
    expect(normalizeFigureNumbering(result)).toBe(result);
  });

  it('无编号图题补编号；引用句/叙述句不被误判为图题', () => {
    const md = [
      '## 第1章 工程概况',
      '图 管理组织机构图',
      '如图 1-1 所示的层级关系。',
      '图 1-2 所示为岗位设置情况。',
    ].join('\n');
    const result = normalizeFigureNumbering(md);
    expect(result).toContain('图1-1 管理组织机构图');
    // 引用句/叙述句（含句读或不以图类尾词落定）保持原样
    expect(result).toContain('如图 1-1 所示的层级关系。');
    expect(result).toContain('图 1-2 所示为岗位设置情况。');
  });

  it('同章多图章内序号连续递增；附表区不参与', () => {
    const md = [
      '## 第1章 施工组织总体安排',
      '图 项目管理机构图',
      '正文。',
      '图 岗位责任分工图',
      '## 附表一 项目管理机构图',
      '图 1-1 附表内图题',
    ].join('\n');
    const result = normalizeFigureNumbering(md);
    expect(result).toContain('图1-1 项目管理机构图');
    expect(result).toContain('图1-2 岗位责任分工图');
    expect(result).toContain('图 1-1 附表内图题');
  });

  it('无图题零改动恒等；extractFigureCaptions 实体提取', () => {
    const plain = ['## 第1章 工程概况', '正文内容。'].join('\n');
    expect(normalizeFigureNumbering(plain)).toBe(plain);
    const entities = extractFigureCaptions(['## 第1章 工程概况', '图 项目管理机构图', '正文。', '图1-2 岗位责任分工图'].join('\n'));
    expect(entities.map(entity => `${entity.chapterNo}|${entity.oldKey}|${entity.name}`)).toEqual(['1||项目管理机构图', '1|1-2|岗位责任分工图']);
  });
});

describe('B-T1 图位补位（ensureFigurePlaceholders）与规格汇集', () => {
  it('缺失规格注入目标章末尾；已有图题（核心词匹配）不重复注入；幂等且可接归一化落地编号', () => {
    const md = [
      '## 第1章 工程概况',
      '正文。',
      '## 第2章 施工进度计划',
      '图2-1 横道图',
      '正文段落。',
      '## 第3章 施工总平面布置',
      '正文。',
    ].join('\n');
    const specs = [
      { chapterTitle: '施工进度计划', name: '施工进度横道图' },
      { chapterTitle: '施工总平面布置', name: '施工总平面布置图' },
    ];
    const result = ensureFigurePlaceholders(md, specs);
    expect(result.inserted).toEqual(['施工总平面布置：「施工总平面布置图」']);
    const lines = result.markdown.split('\n');
    const figureLine = lines.indexOf('图 施工总平面布置图');
    expect(figureLine).toBeGreaterThan(lines.findIndex(line => line.includes('第3章')));
    expect(ensureFigurePlaceholders(result.markdown, specs)).toEqual({ markdown: result.markdown, inserted: [] });
    expect(normalizeFigureNumbering(result.markdown)).toContain('图3-1 施工总平面布置图');
  });

  it('规格为空恒等；无匹配章标题时注入文末保底', () => {
    const md = ['## 第1章 工程概况', '正文。'].join('\n');
    expect(ensureFigurePlaceholders(md, [])).toEqual({ markdown: md, inserted: [] });
    const result = ensureFigurePlaceholders(md, [{ chapterTitle: '不存在的章节', name: '施工进度网络图' }]);
    expect(result.inserted).toEqual(['不存在的章节：「施工进度网络图」']);
    expect(result.markdown).toContain('图 施工进度网络图');
  });

  it('collectFigurePlaceholderSpecs：结构要求（图/框图形态）+ 章级图类指令合并去重；表类形态不收', () => {
    const specs = collectFigurePlaceholderSpecs({
      structureItems: [
        { chapterTitle: '施工组织总体安排', form: 'org_chart', element: '项目管理机构图' },
        { chapterTitle: '施工组织总体安排', form: 'table', element: '部门设置一览表' },
        { chapterTitle: '施工进度计划', form: 'diagram', element: '施工进度网络图' },
      ],
      chapters: [{ title: '施工进度计划', diagramRequirements: ['「网络图」以文字框图呈现（节点与衔接关系）。（招标要求原文：「以网络图表示进度计划。」）'] }],
    });
    expect(specs).toEqual([
      { chapterTitle: '施工组织总体安排', name: '项目管理机构图' },
      { chapterTitle: '施工进度计划', name: '施工进度网络图' },
    ]);
  });

  it('figureCoverage：图类要求 ↔ 正文规范图题对照（核心词匹配）；无图类要求不参与', () => {
    const md = ['## 第1章 施工组织总体安排', '图1-1 项目管理机构图', '## 第2章 施工进度计划'].join('\n');
    const specs = [
      { chapterTitle: '施工组织总体安排', name: '项目管理机构图' },
      { chapterTitle: '施工进度计划', name: '施工进度横道图' },
    ];
    expect(figureCoverage(specs, md)).toEqual({ total: 2, covered: 1, missing: [{ chapterTitle: '施工进度计划', name: '施工进度横道图' }] });
    expect(figureCoverage([], md)).toEqual({ total: 0, covered: 0, missing: [] });
  });

  it('E2E：ensure → normalize 成对使用后图类要求一一落地、编号全局连续、重跑全链幂等', () => {
    const md = [
      '## 第1章 编制说明与工程概况',
      '图 项目管理机构框图',
      '## 第2章 施工进度计划及保证措施',
      '## 第3章 施工总平面布置',
    ].join('\n');
    const specs = [
      { chapterTitle: '编制说明与工程概况', name: '项目管理机构图' },
      { chapterTitle: '施工进度计划及保证措施', name: '施工进度网络图' },
      { chapterTitle: '施工总平面布置', name: '施工总平面布置图' },
    ];
    const once = normalizeFigureNumbering(ensureFigurePlaceholders(md, specs).markdown);
    expect(once).toContain('图1-1 项目管理机构框图');
    expect(once).toContain('图2-1 施工进度网络图');
    expect(once).toContain('图3-1 施工总平面布置图');
    expect(figureCoverage(specs, once)).toEqual({ total: 3, covered: 3, missing: [] });
    const twice = normalizeFigureNumbering(ensureFigurePlaceholders(once, specs).markdown);
    expect(twice).toBe(once);
  });

  it('无内部话术：图类呈现指令与图题链产物不出现「系统不生成/编制人绘制/绘制后附」', () => {
    const chapter = { id: 'c-figure', title: '施工进度计划', purpose: '', diagramRequirements: ['「横道图」以表格式时间轴呈现（阶段与节点、起止时间）。'] } as DocumentTemplateChapter;
    const prompt = diagramRequirementsPrompt(chapter);
    expect(prompt).toContain('规范图题行');
    expect(prompt).toContain('图 X-X 图名');
    expect(prompt).not.toContain('系统不生成');
    expect(prompt).not.toContain('编制人');
    expect(prompt).not.toContain('绘制后附');
    const md = ['## 第1章 施工进度计划', '图 施工进度横道图'].join('\n');
    const produced = normalizeFigureNumbering(ensureFigurePlaceholders(md, [{ chapterTitle: '施工进度计划', name: '施工进度横道图' }]).markdown);
    expect(produced).not.toMatch(/编制人|系统不生成|绘制后附/u);
  });

  it('mergeStructureDiagramArtifacts：结构要求图/框图形态并入并按图名核心词去重；表类不收', () => {
    const base = [{ name: '横道图', instruction: '以表格式时间轴呈现', source: '以横道图表示进度。' }];
    const merged = mergeStructureDiagramArtifacts(base, [
      { form: 'diagram', element: '施工进度横道图', sourceText: '横道图。' },
      { form: 'org_chart', element: '项目管理机构图', sourceText: '组织机构以框图方式表示。' },
      { form: 'table', element: '部门设置一览表', sourceText: '附表列明部门。' },
    ]);
    expect(merged.map(item => item.name)).toEqual(['横道图', '项目管理机构图']);
    expect(merged[1].instruction).toContain('文字框图');
    expect(mergeStructureDiagramArtifacts([], [])).toEqual([]);
  });

  it('C2 normalizeFigureSpecName：工程图类构成词尾补「图」；已带图尾/非构成词尾原样（防正文引用句误修）', () => {
    expect(normalizeFigureSpecName('施工进度计划')).toBe('施工进度计划图');
    expect(normalizeFigureSpecName('项目管理机构')).toBe('项目管理机构图');
    expect(normalizeFigureSpecName('总平面布置')).toBe('总平面布置图');
    expect(normalizeFigureSpecName('施工进度网络图')).toBe('施工进度网络图');
    expect(normalizeFigureSpecName('组织机构图')).toBe('组织机构图');
    // 非图类构成词尾原样（宁缺不假：「中所示内容」类正文引用句不得被改成图题）
    expect(normalizeFigureSpecName('中所示内容')).toBe('中所示内容');
    expect(normalizeFigureSpecName('施工部署')).toBe('施工部署');
  });

  it('C2 规格汇集归一化：无尾词图类名补「图」，注入/覆盖对账口径闭环', () => {
    const specs = collectFigurePlaceholderSpecs({
      structureItems: [
        { chapterTitle: '施工进度计划', form: 'diagram', element: '施工进度计划' },
        { chapterTitle: '施工组织总体安排', form: 'org_chart', element: '项目管理机构' },
      ],
    });
    expect(specs).toEqual([
      { chapterTitle: '施工进度计划', name: '施工进度计划图' },
      { chapterTitle: '施工组织总体安排', name: '项目管理机构图' },
    ]);
    const md = ['## 第1章 施工进度计划', '## 第2章 施工组织总体安排'].join('\n');
    const result = ensureFigurePlaceholders(md, specs);
    // 注入行与规格同口径（严格判据可达），归一化后覆盖对账 2/2
    expect(result.markdown).toContain('图 施工进度计划图');
    const numbered = normalizeFigureNumbering(result.markdown);
    expect(figureCoverage(specs, numbered)).toEqual({ total: 2, covered: 2, missing: [] });
  });

  it('C2 就地修复：尾词补全/句读粘连拆分/编号缺尾词补全；修复行纳入既有图题不重复注入；幂等', () => {
    const md = [
      '## 第1章 施工进度计划',
      '图 施工进度计划',
      '## 第2章 进度网络图',
      '图4-3 网络图相关内容纳入施工组织设计与作业流程管理，资料员每日更新记录、测量员每周复核数据。',
      '正文段落。',
      '## 第3章 项目管理机构',
      '图 9-1 项目管理机构',
    ].join('\n');
    const specs = [
      { chapterTitle: '施工进度计划', name: '施工进度计划图' },
      { chapterTitle: '进度网络图', name: '网络图' },
      { chapterTitle: '项目管理机构', name: '项目管理机构图' },
    ];
    const result = ensureFigurePlaceholders(md, specs);
    // ①裸图题缺尾词 → 补全
    expect(result.markdown).toContain('图 施工进度计划图');
    // ②句读粘连 → 图题行保留 + 残余句独立成行
    expect(result.markdown).toContain('图4-3 网络图');
    expect(result.markdown).toContain('\n相关内容纳入施工组织设计与作业流程管理，资料员每日更新记录、测量员每周复核数据。');
    // ③带编号缺尾词 → 补全
    expect(result.markdown).toContain('图9-1 项目管理机构图');
    // 修复后三项全部计入既有图题，零注入
    expect(result.inserted).toEqual([]);
    const numbered = normalizeFigureNumbering(result.markdown);
    expect(numbered).toContain('图1-1 施工进度计划图');
    expect(figureCoverage(specs, numbered)).toEqual({ total: 3, covered: 3, missing: [] });
    // 幂等：重跑零变化
    const again = ensureFigurePlaceholders(numbered, specs);
    expect(again.markdown).toBe(numbered);
    expect(again.inserted).toEqual([]);
  });
});

// ═══ 4.55.12 W5 正文侧承载：图位带数据落地（巢湖实测：裸图题无表） ═══

describe('4.55.12 图类替代表（图位必须带内容承载）', () => {
  const bp = {
    schedule: [
      { seq: 1, label: '施工准备', duration: 10, startDay: 1, endDay: 10, critical: false, basis: '里程碑推导' },
      { seq: 2, label: '基础与主体施工', duration: 120, startDay: 11, endDay: 130, critical: true, basis: '里程碑推导' },
    ],
    tempLand: [{ purpose: '钢筋加工区', area: 800, location: '场地东侧', duration: '全过程', note: '硬化处理', basis: '推导' }],
  } as unknown as BlueprintData;
  const callback = { substituteTable: (name: string) => figureSubstituteTableLines(bp, name) };
  const specs = [{ chapterTitle: '第一章 主要施工方法与技术措施', name: '施工进度计划横道图' }];

  it('既有裸图题（模型只输出图题）→ 就地补等效数据表（蓝图直出，零编造）', () => {
    const src = ['## 第一章 主要施工方法与技术措施', '', '图1-2 施工进度计划横道图', '', '正文内容。'].join('\n');
    const result = ensureFigurePlaceholders(src, specs, callback).markdown;
    expect(result).toContain('| 工序 | 持续天数 | 起止天序 | 线路性质 | 依据 |');
    expect(result).toContain('| 基础与主体施工 | 120 | 第11～130天 | 关键线路 | 里程碑推导 |');
    // 图题原位保留（只补内容，不改形态声明）
    expect(result).toContain('图1-2 施工进度计划横道图');
    expect(result.indexOf('图1-2')).toBeLessThan(result.indexOf('| 工序 |'));
  });

  it('完全缺失图位 → 注入图题 + 数据表（不再是裸图题）', () => {
    const src = ['## 第一章 主要施工方法与技术措施', '', '正文内容。'].join('\n');
    const result = ensureFigurePlaceholders(src, specs, callback).markdown;
    expect(result).toContain('图 施工进度计划横道图');
    expect(result).toContain('| 工序 |');
  });

  it('幂等：图片已插入后重放不再补（表格不构成"图已承载"——4.55.20 口径收紧）', () => {
    const src = ['## 第一章 主要施工方法与技术措施', '', '图1-2 施工进度计划横道图', '', '正文内容。'].join('\n');
    const once = ensureFigurePlaceholders(src, specs, callback).markdown;
    expect(ensureFigurePlaceholders(once, specs, callback).markdown).toBe(once);
  });

  it('无对应蓝图数据的图类不造数据（机构图保持图题，无表）', () => {
    const src = ['## 第一章 主要施工方法与技术措施', '', '图1-5 项目管理机构图', '', '正文内容。'].join('\n');
    const result = ensureFigurePlaceholders(src, [{ chapterTitle: '第一章 主要施工方法与技术措施', name: '项目管理机构图' }], callback).markdown;
    expect(result).toBe(src);
  });

  it('未传替代表回调时保持原行为（纯图题注入，向后兼容）', () => {
    const src = ['## 第一章 主要施工方法与技术措施', '', '正文内容。'].join('\n');
    const result = ensureFigurePlaceholders(src, specs).markdown;
    expect(result).toContain('图 施工进度计划横道图');
    expect(result).not.toContain('| 工序 |');
  });
});

describe('4.55.12 图类承载检测（裸图题不再判成立）', () => {
  const specs = [{ chapterTitle: '第一章 主要施工方法与技术措施', name: '施工进度计划横道图' }];

  it('裸图题（图题下无内容）→ 判无承载', () => {
    const md = ['## 第一章', '', '图1-2 施工进度计划横道图', '', '下一条目内容。'].join('\n');
    expect(figureSubstituteTableIssues(md, specs)).toHaveLength(1);
  });

  it('图题下有数据表 → 判已承载', () => {
    const md = ['## 第一章', '', '图1-2 施工进度计划横道图', '', '| 工序 | 持续天数 |', '| --- | --- |', '| 施工准备 | 10 |'].join('\n');
    expect(figureSubstituteTableIssues(md, specs)).toEqual([]);
  });

  it('图题下有文字框图（≥8 汉字正文行）→ 判已承载（正文禁表口径下的合法形态）', () => {
    const md = ['## 第一章', '', '图1-2 施工进度计划横道图', '', '施工准备（第1～10天）→基础与主体施工（第11～130天）→装饰装修。'].join('\n');
    expect(figureSubstituteTableIssues(md, specs)).toEqual([]);
  });
});
