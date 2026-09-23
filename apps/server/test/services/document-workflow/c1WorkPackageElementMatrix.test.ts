/**
 * C1「分项方案要素不全」用例矩阵（4.59 R-C4，真实文档逐字用例）。
 *
 * 背景：两份巢湖终稿各报「主要施工方法与施工方法章存在 N 个分项方案内容要素不全（作业对象与工程量/
 * 工序顺序/施工方法至少缺一）」（ea380252 6 条、cfb0a0da 13 条）。逐块归因（见
 * `rc-class-diag.manual.ts` 的 [归因] 表）证明其中绝大多数是**判据形态覆盖缺口**导致的误报：
 * ① 工序顺序只认「按…顺序」字面与箭头/编号/列表，漏「按 A、B、C、D…组织」顿号链（ea 1.18.3）；
 * ② 施工方法词表漏焊接工艺参数族（ea 1.19.3「焊接搭接长度不小于6d，双面施焊」）；
 * ③ 作业对象只认「数值+单位」，漏「包括…等…内容」范围声明（cfb 1.4.3）；
 * ④ 逐 H4 块判定不回看 H3 小节前导（小节整体的作业对象/工序写在前导里，cfb 1.8.1/1.14.1/1.24.1）；
 * ⑤ 兜底块（「其他分部分项工程施工要点」）与⑥ 非方案主题小节（编制依据/进度计划/文明施工…）
 *    在 majorContent 侧已豁免，division 侧未豁免（同类块两套口径）。
 *
 * 用例文本全部逐字取自两份真实终稿（含空块、短块、兜底块的真实形态），四类覆盖：
 * 正向（真缺陷照报）/ 反向（误报防线：六机制各一例）/ 边界（阈值 ±1）/ 不变（原有行为不得改变）。
 *
 * 零静默降级：被类别豁免的块**仍由**「施工方法缺少工序顺序表达」「工艺参数不足」「正文过短」
 * 三族照常报出（本文件用真实终稿的族计数断言，见下）。
 */
import { describe, expect, it } from 'vitest';
import { constructionOrgDivisionSectionIssues } from '@/services/document-workflow/constructionOrgQualityRules';
import { workPackageContentElementFlags, workPackageContentElementsComplete } from '@/services/document-workflow/utils';
import type { DocumentDraftChapter } from '@/services/document-workflow/types';

const chapter = (title: string, content: string, sections: string[] = []): DocumentDraftChapter => ({ id: title, title, content, evidence: [], missingFacts: [], sections });

/** 要素不全 blocker 过滤（本文件只断言该族；分项不足/正文过短等族另有断言） */
const elementIssues = (chapters: DocumentDraftChapter[], markdown = '') =>
  constructionOrgDivisionSectionIssues(chapters, markdown).filter(issue => issue.message.includes('要素不全'));

// ═══════════════════ 真实文档逐字块（来源：assets/巢湖施工组织设计-doc-*） ═══════════════════

/** ea380252 1.18.3（顿号链工序：判据 ① 修复对象） */
const EA_1183 = `#### 1.18.3 其他分部分项工程施工要点
屋面及防水工程按基层清理、找坡找平、防水层施工、蓄水试验组织，屋面1面积2713.17m²、屋面3面积824.45m²、屋面4面积681.48m²，天棚涂膜防水638.97m²，防水层完成后蓄水24h无渗漏。门窗工程含金属门140.96樘、钢质防火门154.14m²、金属卷闸门359.88m²、金属窗2645.7m²，安装后检查启闭与密封。楼地面装饰工程含厂房地坪54668.38m²、金刚砂耐磨地坪60600.04m²、块料地面1118.08m²。墙柱面装饰工程含墙面一般抹灰28106.79m²、块料墙面1030.22m²、外墙真石漆5748.87m²。`;

/** ea380252 1.19.3（焊接工艺参数方法证据：判据 ② 修复对象） */
const EA_1193 = `#### 1.19.3 其他分部分项工程施工要点
零星装饰工程含成品隔断146.89m²、洗漱台11.29m²，按测量放线→基层处理→成品安装→打胶收口顺序施工。防雷接地利用柱主筋与圈梁钢筋焊接171处，避雷引下线2969.52m，焊接搭接长度不小于6d，双面施焊。消防水系统室内消火栓95套，栓口距地1.1m，管道消毒冲洗后试压。`;

/** ea380252 1.28.1（真空块：标题后直接接下一 H4 —— 正向真缺陷） */
const EA_1281 = `#### 1.28.1 照明
#### 1.28.2 动力`;

/** ea380252 1.17.3（真兜底块：标题后直接接下一标题 —— 空块形态） */
const EA_1173 = `#### 1.17.3 其他分部分项工程施工要点
### 1.18 屋面工程`;

/** cfb0a0da 1.4.3（「包括…等…内容」范围声明：判据 ③ 修复对象） */
const CFB_143 = `#### 1.4.3 室外附属工程
室外附属工程包括室外道路、围墙、排水、给水、电气及路灯等配套内容。道路结构层为水泥稳定碎（砾）石基层，水泥含量5%厂拌，厚度25cm，洒水车养护硬化区域管道中至路床底采用2:8灰土回填，检查井等构筑物四周含消解。随路基整平与管道沟槽回填同步实施；铺筑于停车区域，基层为300厚塘渣垫层与250厚水泥稳定碎石，面层植草砖缝内填种植土并撒播草籽。`;

/** cfb0a0da 1.4.4（短桩块：134 字、缺工序与方法 —— 正向真缺陷） */
const CFB_144 = `#### 1.4.4 景观绿化
景观绿化工程作业对象为室外附属工程范围内厂区绿地，种植土回（换）填、铺设草坪基层、铺种草皮4656.03m2，采用马尼拉套播多年生黑麦草，下铺3cm沙，种植土为黄土、按30cm厚回填；中间混凝土结构单体二层绿化屋面板配筋标高按调整后图纸施工。`;

/** cfb0a0da 1.1.1（非方案主题小节：编制依据 —— 判据 ⑥ 修复对象） */
const CFB_111 = `#### 1.1.1 国家法律法规及条例
国家法律法规及条例编制依据一览表
表1-1 依据一览表`;

/** cfb0a0da 1.8.1（H3 前导继承：判据 ④ 修复对象） */
const CFB_181_BLOCK = `#### 1.8.1 门卫配电箱及等电位施工要点
箱体安装完成后进行回路标识与系统调试，逐路核对AL-MW2、AL-MW3箱内断路器整定值与系统图一致，标识牌采用耐候材质，字迹清晰不褪色。送配电装置系统按1KV等级做交接试验，每系统不少于1次，试验数据由试验员记录、技术负责人审核归档。`;
/** 同一块的 H3 小节前导（cfb0a0da 1.8 门卫电气工程）：作业对象+工序写在 H3 层 */
const CFB_18_H3 = `### 1.8 门卫电气工程
门卫电气工程作业对象为2#门卫、3#门卫配电箱、等电位联结与室外照明，工程量配电箱6台、等电位联结端子箱4台、电缆敷设2811m。工序按测量定位→箱体安装→回路标识→系统调试顺序组织。`;

describe('C1 正向：真缺陷照报（空块/短桩块不得漏报）', () => {
  it('真空块（ea380252 1.28.1 照明）三要素全缺 → 块级三要素判定为不完整', () => {
    const flags = workPackageContentElementFlags('1.28.1 照明');
    expect(flags).toEqual({ scope: false, process: false, method: false });
    expect(workPackageContentElementsComplete('1.28.1 照明')).toBe(false);
  });

  it('真空块在 5 分项章内 → 章级报「要素不全」（真实终稿残留的 1 条，不得因修复而消失）', () => {
    const good = (name: string) => `#### 分项${name} 土方开挖\n作业对象为厂房基础土方，工程量800m³。工艺流程：测量放线→分层开挖→边坡修整→基底验槽。施工方法采用机械开挖分层作业，压实度不低于93%，验收记录归档。`;
    const content = `### 1 主要分部分项工程施工方案\n${good('1')}\n${good('2')}\n${good('3')}\n${EA_1281}`;
    const issues = elementIssues([chapter('主要施工方法与技术措施', content)]);
    expect(issues.length).toBe(1);
    expect(issues[0]?.severity).toBe('blocker');
    expect(issues[0]?.message).toContain('照明');
  });

  it('短桩块（cfb0a0da 1.4.4 景观绿化）缺工序与方法 → 报要素不全（真缺陷，实测残留）', () => {
    const flags = workPackageContentElementFlags(CFB_144);
    expect(flags.scope).toBe(true);
    expect(flags.process).toBe(false);
    expect(flags.method).toBe(false);
    expect(workPackageContentElementsComplete(CFB_144)).toBe(false);
  });
});

describe('C1 反向：六类误报机制各自不得再报（真实文档逐字块）', () => {
  it('① 顿号链工序（ea380252 1.18.3「按基层清理、找坡找平、防水层施工、蓄水试验组织」）→ 工序成立', () => {
    const flags = workPackageContentElementFlags(EA_1183);
    expect(flags.process).toBe(true);
    expect(flags.scope).toBe(true);
    expect(flags.method).toBe(true);
  });

  it('② 焊接工艺参数（ea380252 1.19.3「焊接搭接长度不小于6d，双面施焊」）→ 方法成立', () => {
    const flags = workPackageContentElementFlags(EA_1193);
    expect(flags.method).toBe(true);
    expect(workPackageContentElementsComplete(EA_1193)).toBe(true);
  });

  it('③ 「包括…等…内容」范围声明（cfb0a0da 1.4.3）→ 作业对象成立', () => {
    const flags = workPackageContentElementFlags(CFB_143);
    expect(flags.scope).toBe(true);
  });

  it('④ H3 小节前导继承：块内三要素不全但小节前导已给作业对象与工序 → 不报（cfb0a0da 1.8.1 形态）', () => {
    const content = `### 1 主要分部分项工程施工方案\n${CFB_18_H3}\n${CFB_181_BLOCK}\n${CFB_143}\n${CFB_144}`;
    const issues = elementIssues([chapter('主要施工方法与技术措施', content)]);
    expect(issues.some(issue => issue.message.includes('1.8.1') || issue.message.includes('门卫配电箱'))).toBe(false);
  });

  it('⑤ 兜底块豁免（ea380252 1.17.3「其他分部分项工程施工要点」空块）→ 不报要素不全', () => {
    const content = `### 1 主要分部分项工程施工方案\n${EA_1173}`;
    expect(elementIssues([chapter('主要施工方法与技术措施', content)])).toEqual([]);
  });

  it('⑥ 非方案主题小节豁免（cfb0a0da 1.1.1 编制依据·国家法律法规及条例）→ 不报要素不全', () => {
    const content = `### 1 主要分部分项工程施工方案\n${CFB_111}`;
    expect(elementIssues([chapter('主要施工方法与技术措施', content)])).toEqual([]);
  });

  it('零静默降级：被豁免的兜底块仍由「工序顺序表达/工艺参数/正文过短」三族报出（真实终稿族计数）', () => {
    // ea380252 实测（[C1-其余] 逐条）：要素不全族豁免后，「缺少工序顺序表达」4 个、「工艺参数不足」3 个、
    // 「正文过短」2 个仍点名 1.17.3 / 1.25.3 / 1.28.1 等同一批兜底块 —— 豁免只免「三要素」一项，
    // 不免其它质量族（本断言用真实终稿全章跑一遍，防止未来把豁免扩成整体放行）
    const content = `### 1 主要分部分项工程施工方案\n${EA_1173}\n${EA_1193}\n${EA_1183}`;
    const all = constructionOrgDivisionSectionIssues([chapter('主要施工方法与技术措施', content)]);
    expect(all.some(issue => issue.message.includes('缺少工序顺序表达'))).toBe(true);
  });
});

describe('C1 边界：判据阈值 ±1（顿号链环节数、范围声明尾缀、方法词表边界）', () => {
  it('顿号链 2 环节（不足 3）→ 不判工序（防把枚举句当工序）', () => {
    expect(workPackageContentElementFlags('屋面工程按基层清理、找坡找平组织。').process).toBe(false);
  });

  it('顿号链 3 环节 → 判工序（阈值下界）', () => {
    expect(workPackageContentElementFlags('屋面工程按基层清理、找坡找平、防水层施工组织。').process).toBe(true);
  });

  it('顿号链缺顺序语义词（「按厂区道路、围墙、排水等配套内容施工」）→ 不判工序（形态边界）', () => {
    expect(workPackageContentElementFlags('按厂区道路、围墙、排水等配套内容施工。').process).toBe(false);
  });

  it('范围声明尾缀不在词表（「包括钢筋、模板等作业」）→ 不判作业对象（形态边界）', () => {
    expect(workPackageContentElementFlags('包括钢筋、模板等作业。').scope).toBe(false);
    expect(workPackageContentElementFlags('包括钢筋、模板等分项。').scope).toBe(true);
  });

  it('方法词表边界：仅「焊接」而无工艺参数（去掉 1.19.3 的焊接句）→ 不判方法', () => {
    const withoutWeld = EA_1193.replace('防雷接地利用柱主筋与圈梁钢筋焊接171处，避雷引下线2969.52m，焊接搭接长度不小于6d，双面施焊。', '');
    expect(workPackageContentElementFlags(withoutWeld).method).toBe(false);
    // 对照：保留该句即判方法（证明命中的是工艺参数族，不是「焊接」二字）
    expect(workPackageContentElementFlags(EA_1193).method).toBe(true);
  });

  it('H3 前导继承的边界：无前导时照报（继承必须「有据才生效」，不是无条件放行）', () => {
    const baseline = workPackageContentElementFlags(CFB_181_BLOCK);
    expect(baseline.scope).toBe(false); // 该块自块无作业对象/工程量（实测 false）→ 单块判定缺要素
    expect(workPackageContentElementsComplete(CFB_181_BLOCK)).toBe(false);
    // 同一块去掉 H3 前导后照报（证明上一条用例的「不报」来自前导携带了三要素，而不是块所属小节被整体豁免）
    const withoutPreamble = `### 1 主要分部分项工程施工方案\n${CFB_181_BLOCK}\n${CFB_143}\n${CFB_144}`;
    const issues = elementIssues([chapter('主要施工方法与技术措施', withoutPreamble)]);
    expect(issues.some(issue => issue.message.includes('1.8.1') || issue.message.includes('门卫配电箱'))).toBe(true);
  });
});

describe('C1 不变：原有行为不得改变', () => {
  it('三要素齐全的自然成文块三 flag 全 true（原有口径）', () => {
    const good = '作业对象为厂房基础土方，工程量800m³。工艺流程：测量放线→分层开挖→边坡修整→基底验槽。施工方法采用机械开挖分层作业，压实度不低于93%，每层验收合格后进入下一层，验收记录归档。';
    expect(workPackageContentElementFlags(good)).toEqual({ scope: true, process: true, method: true });
    expect(workPackageContentElementsComplete(good)).toBe(true);
  });

  it('分项不足（<3 个）仍报 blocker（另一族不得因本批改动而沉默）', () => {
    const content = `### 1 主要分部分项工程施工方案\n${EA_1183}\n${EA_1193}`;
    const issues = constructionOrgDivisionSectionIssues([chapter('主要施工方法与技术措施', content)]);
    expect(issues.some(issue => issue.message.includes('分项不足'))).toBe(true);
  });

  it('空块仍报「正文过短」（真实 1.17.3/1.28.1 形态）', () => {
    const content = `### 1 主要分部分项工程施工方案\n${EA_1173}\n${EA_1183}\n${EA_1193}`;
    const issues = constructionOrgDivisionSectionIssues([chapter('主要施工方法与技术措施', content)]);
    expect(issues.some(issue => issue.message.includes('正文过短'))).toBe(true);
  });

  it('非分部分项候选章不参与判定（原有边界）', () => {
    expect(constructionOrgDivisionSectionIssues([chapter('工程概况', '本项目位于巢湖市。')])).toHaveLength(0);
  });
});
