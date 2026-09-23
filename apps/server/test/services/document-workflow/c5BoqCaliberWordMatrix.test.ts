/**
 * C5「小节正文含工程量清单内部口径词」用例矩阵（4.59 R-C5，真实文本逐字用例）。
 *
 * 背景：ea380252 终稿报 4 条（cfb0a0da 报 2 条），逐条复核**全部为误报**：
 *   ① 「接地电阻按实测值逐点验收」（ea 第 253 行）/「管道预制按实测尺寸下料」（ea 第 267、349 行）——
 *      `按实测` 是施工语言（实测实量下料/验收），与清单计价口径无关；
 *   ② 「悬挂灯按实11 LED 200W杆吊」（ea 第 406 行）/「悬挂灯按实11、12均为LED 200W杆吊」（cfb 第 170 行）——
 *      原文出处是 CAD 图纸标注（`1#厂房施工图_t3.dwg` 文本「悬挂灯…按实按实 1111 杆吊，距顶板底1.0米」：
 *      `按实` 是现场确定安装高度的标注、`11` 是灯具编号），不是工程量清单内部口径词。
 * 判据收窄为 `按实(?!际|测|\d)`（计价语义的「按实」恒后接动词：按实结算/按实计量/按实调整/按实收方）。
 *
 * 用例文本来源（全部真实、逐字）：
 *   · 真终稿：assets/巢湖施工组织设计-doc-1790176444035-ea380252.md、…-cfb0a0da.md；
 *   · 真实历史轮 draft 句（本轮已删改、仅报告留存原文）：reports/doc-1790119909475-7ea5c969-review.md、
 *     doc-1790058352641-ccf7fe0d-review.md 等的 blocker 原文摘录——用于「真泄漏照报」方向；
 *   · 清单内部词逐字取自真实工程量清单单元格（…/4-工程量清单各项分类表/1#厂房土建工程.xls：
 *     单元格原文 `分部小计`、`综合单价`、`暂估价`）。
 *
 * 四类覆盖：正向（真泄漏照报）/ 反向（三类误报不得再报）/ 边界（形态与共现边界）/
 * 不变（表格承载、措施项目合法用法、弱族口径、非关键小节豁免）。
 */
import { describe, expect, it } from 'vitest';
import { majorContentGovernanceIssues } from '@/services/document-workflow/constructionOrgQualityRules';

/** 关键小节容器（与真实终稿同形：## 主要施工方法与技术措施 → ### 小节） */
const section = (title: string, body: string): string => `## 主要施工方法与技术措施\n### ${title}\n${body}\n`;

/** 只取「内部口径词」族（同函数另有「表格承载正文」族） */
const caliberIssues = (markdown: string) =>
  majorContentGovernanceIssues(markdown).filter(issue => issue.message.includes('内部口径词'));

// ═══════════════════ 真实文本 ═══════════════════

/** ea380252 第 253 行（按实测，真终稿逐字） */
const EA_253 = '焊接处做防腐处理，接地电阻按实测值逐点验收。';
/** ea380252 第 267 / 349 行（按实测，真终稿逐字） */
const EA_267 = '1. 管道预制：按实测尺寸下料，PVC-U管切口垂直度偏差不大于1mm，按承插粘接工艺连接。';
/** ea380252 第 406 行（按实+数字，真终稿逐字） */
const EA_406_TAIL = '照明开关220V/10A 50套、插座250V/10A 57套及16A 1套；悬挂灯按实11 LED 200W杆吊，距顶板底1.0米（距地2.6米以上），悬挂灯按实12 LED 200W杆吊，距顶板底1.0米（距地2.6米以上）。';
/** cfb0a0da 第 170 行（按实+数字，真终稿逐字） */
const CFB_170 = '灯具选型经设计确认：11号为深照型灯具，12号为广照型；悬挂灯按实11、12均为LED 200W杆吊，距顶板底1.0米。';

/** 真泄漏（历史轮真实 draft 句，报告原文摘录）：计价语义「按实计量」 */
const LEAK_PILE = '禁横向敲击损伤桩身，截桩后桩头废弃物按实计量外运处置。';
const LEAK_JOINT = 'Φ16以上接头采用机械连接，接头数量按实计量；砼模板工程配模以组合钢模为主，接缝贴海绵条防漏浆。';
/** 真泄漏（历史轮真实 draft 句）：弱族「小计/合计 + 单位」 */
const LEAK_SUBTOTAL = '侧缘石垫层合计562m³，人行道垫层按分层碾压密实度控制。';

describe('C5 正向：真清单口径泄漏照报（判据未被收窄成放行）', () => {
  it('「按实计量」（历史轮真实 draft 句）→ 报出且报文点名该切片', () => {
    const issues = caliberIssues(section('1.9 基础与地基处理施工方法', LEAK_PILE));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('blocker');
    expect(issues[0]?.message).toContain('按实计量');
  });

  it('「接头数量按实计量」（历史轮真实 draft 句）→ 报出', () => {
    const issues = caliberIssues(section('1.23 基础工程', LEAK_JOINT));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('按实计量');
  });

  it('清单单元格内部词（分部小计/综合单价/暂估价，逐字取自真实清单 xls）→ 报出', () => {
    const body = ['本小节工程量数据取自工程量清单计价表：', '分部小计', '综合单价', '暂估价'].join('\n');
    const issues = caliberIssues(section('1.20 室外附属专项工程', body));
    expect(issues).toHaveLength(1);
    for (const word of ['分部小计', '综合单价', '暂估价']) expect(issues[0]?.message).toContain(word);
  });
});

describe('C5 反向：三类真实误报不得再报（两份终稿 6 条 blocker 全部为误报）', () => {
  it('「按实测值逐点验收」（ea380252 第 253 行逐字）→ 零 blocker', () => {
    expect(caliberIssues(section('1.11 室外电气与路灯安装施工', EA_253))).toEqual([]);
  });

  it('「按实测尺寸下料」（ea380252 第 267/349 行逐字）→ 零 blocker', () => {
    expect(caliberIssues(section('1.13 室内给排水与卫生洁具安装', EA_267))).toEqual([]);
    expect(caliberIssues(section('1.20 1#厂房安装专项工程', `统固定、灌水试验的顺序组织：${EA_267}`))).toEqual([]);
  });

  it('「悬挂灯按实11/12 …杆吊」（ea380252 第 406 行逐字）→ 零 blocker', () => {
    expect(caliberIssues(section('1.26 3#门卫安装饰装修工程', EA_406_TAIL))).toEqual([]);
  });

  it('「悬挂灯按实11、12均为LED 200W杆吊」（cfb0a0da 第 170 行逐字）→ 零 blocker', () => {
    expect(caliberIssues(section('1.4 主要施工内容', CFB_170))).toEqual([]);
  });
});

describe('C5 边界：形态与共现边界（收窄口径的边界照实固定）', () => {
  it('收窄边界：`按实+数字` 不报（数字=编号/标注），`按实+动词` 仍报（计价语义）', () => {
    // 注：小节标题避免用「主要施工内容」（该名会被写作规范同时识别为 H2 章块与 H3 小节 → 同一正文两判）
    expect(caliberIssues(section('1.5 混凝土工程计量', '悬挂灯按实12 LED 200W杆吊。'))).toEqual([]);
    expect(caliberIssues(section('1.5 混凝土工程计量', '混凝土工程量按实结算，结算量以经确认的清单为准。'))).toHaveLength(1);
  });

  it('已知残余形态：「按实采用/按实配置」（历史轮 doc-1790086852103 实录）仍按清单口径词报出', () => {
    // 本批未收窄此形态：`按实+动词` 中计价义（结算/计量/调整/收方）与施工义（采用/配置）
    // 在词面上不可确定区分，再收窄会漏真泄漏（宁漏报不误报的边界在此族内不可两全）——
    // 该判断已如实记入报告，不作静默放宽
    const issues = caliberIssues(section('1.9 门卫房结构与安装配合', '悬挂灯按实采用LED 200W杆吊，距顶板底1.0米。'));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('按实采用');
  });

  it('「措施项目」合法用法不报；与计价语境共现（措施项目费）才报', () => {
    expect(caliberIssues(section('2.18 措施项目', '措施项目按分部分项方案组织施工，脚手架随主体进度搭拆。'))).toEqual([]);
    expect(caliberIssues(section('2.24 分部分项方案列举', '措施项目费按费率计取并计入报价。'))).toHaveLength(1);
  });
});

describe('C5 不变：既有族与既有豁免不得改变', () => {
  it('弱族（合计+单位）不因本批收窄而沉默（历史轮真实 draft 句照报）', () => {
    const issues = caliberIssues(section('1.20 室外附属专项工程', LEAK_SUBTOTAL));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('合计562m³');
  });

  it('非关键小节不参与判定（既有边界）', () => {
    expect(caliberIssues('## 工程概况\n本工程接桩后桩头废弃物按实计量外运处置。')).toEqual([]);
  });

  it('表格承载正文族仍独立报出（G2 另一族不受本批影响）', () => {
    const markdown = section('2.2 1#厂房土建专项工程', ['| 项目 | 数量 |', '| --- | --- |', '| 土方 | 1 |'].join('\n'));
    const all = majorContentGovernanceIssues(markdown);
    expect(all.some(issue => issue.message.includes('不应使用 Markdown 表格承载'))).toBe(true);
  });
});
