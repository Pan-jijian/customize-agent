/**
 * 规划层承接小节（reviewModuleSections）单测：丰乐镇 R12 评分归因——6 强制模块与劳务保障制度
 * 在规划层显性承接（小节标题即评审查询原词）；B-T2——组织机构结构要求在语义路由目标章
 * 显性承接「项目管理机构与岗位职责」。本测试锁定：
 * 1. 注入矩阵：目标章完全缺失 → 注入规范术语小节；弱承接（标题含核心词元）→ 标题规范化不新增；
 *    已有等价小节 → 跳过；
 * 2. 分拆矩阵：单小节同时弱承接实名/工资两模块 → 先到改名、后到注入（防重复小节）；
 * 3. 章匹配：无对应主题章 → 不注入任何小节；多章各自承接互不串扰；
 * 4. 不可变性：输入章节数组不被 mutate；changes 诊断记录 added/renamed 明细；
 * 5. B-T2：org_chart/机构要素挂章 → 承接注入；低置信（未挂章）不注入；同章多要素只处理一次；
 *    非组织类结构要求不触发；重复调用幂等（已有承接跳过）。
 */
import { describe, expect, it } from 'vitest';
import { injectReviewModuleSections, injectStructureOrgSections } from '@/services/document-workflow/reviewModuleSections';
import type { DocumentTemplateChapter, TenderStructureForm } from '@/services/document-workflow/types';
import type { TenderStructureAssignment } from '@/services/document-workflow/tenderRequirements';

function chapter(title: string, sections: string[]): DocumentTemplateChapter {
  return { id: title, title, purpose: '', queries: [], requiredFacts: [], sections };
}

describe('injectReviewModuleSections 评审模块承接小节', () => {
  it('安全章完全缺失 → 注入 4 个评审模块小节（危险源/危大/应急/临时用电）', () => {
    const { chapters, changes } = injectReviewModuleSections([
      chapter('第七章 确保安全生产的技术组织措施', ['安全责任体系与制度运行', '沟槽开挖与机械作业防护']),
    ]);
    expect(chapters[0].sections).toEqual([
      '安全责任体系与制度运行',
      '沟槽开挖与机械作业防护',
      '危险源辨识与风险识别评估',
      '危险性较大的分部分项工程安全管理',
      '生产安全事故应急预案与应急演练',
      '施工现场临时用电三级配电两级保护',
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0].added).toHaveLength(4);
    expect(changes[0].renamed).toHaveLength(0);
  });

  it('弱承接小节 → 标题规范化为规范术语（不新增小节）', () => {
    const { chapters, changes } = injectReviewModuleSections([
      chapter('确保安全生产的技术组织措施', ['应急准备与防火防中毒', '临电管理与设备安全控制', '常规安全检查']),
    ]);
    const sections = chapters[0].sections || [];
    expect(sections).toContain('生产安全事故应急预案与应急演练');
    expect(sections).toContain('施工现场临时用电三级配电两级保护');
    expect(sections).not.toContain('应急准备与防火防中毒');
    expect(sections).not.toContain('临电管理与设备安全控制');
    // 改名不新增：原始 3 个 + 注入 2 个（危险源/危大）= 5 个
    expect(sections).toHaveLength(5);
    expect(changes[0].renamed).toEqual([
      { from: '应急准备与防火防中毒', to: '生产安全事故应急预案与应急演练' },
      { from: '临电管理与设备安全控制', to: '施工现场临时用电三级配电两级保护' },
    ]);
  });

  it('实名+工资单小节弱承接 → 先到改名、后到注入（防重复小节）', () => {
    const { chapters, changes } = injectReviewModuleSections([
      chapter('劳动力安排计划', ['专业班组进场衔接与工日核定', '实名制考勤与工资直发']),
    ]);
    const sections = chapters[0].sections || [];
    expect(sections).toContain('建筑工人实名制管理');
    expect(sections).toContain('农民工工资专用账户与工资支付保障');
    expect(changes[0].renamed).toEqual([{ from: '实名制考勤与工资直发', to: '建筑工人实名制管理' }]);
    expect(changes[0].added).toEqual(['农民工工资专用账户与工资支付保障']);
  });

  it('已有等价小节 → 跳过（不重复注入/不改名）', () => {
    const { chapters, changes } = injectReviewModuleSections([
      chapter('确保文明施工的技术组织措施', ['扬尘污染防治措施', '雨污分流与沉淀排放']),
    ]);
    const sections = chapters[0].sections || [];
    expect(sections.filter(section => section === '扬尘污染防治措施')).toHaveLength(1);
    // 绿色施工模块无承接 → 注入；扬尘模块跳过
    expect(changes[0].added).toEqual(['绿色施工与四节一环保措施']);
    expect(changes[0].renamed).toHaveLength(0);
  });

  it('无对应主题章 → 不注入任何小节（changes 为空）', () => {
    const { chapters, changes } = injectReviewModuleSections([
      chapter('确保工程质量的技术组织措施', ['三检制度与样板引路']),
    ]);
    expect(chapters[0].sections).toEqual(['三检制度与样板引路']);
    expect(changes).toHaveLength(0);
  });

  it('多章各自承接：安全章/文明章/劳动力章互不串扰', () => {
    const { chapters, changes } = injectReviewModuleSections([
      chapter('第一章 工程概况', ['编制依据']),
      chapter('第七章 确保安全生产的技术组织措施', ['安全责任体系']),
      chapter('第九章 确保文明施工的技术组织措施', ['文明施工责任与扬尘管控']),
      chapter('第五章 劳动力安排计划', []),
    ]);
    expect((chapters[1].sections || []).filter(section => /预案与应急演练|临时用电/.test(section))).toHaveLength(2);
    expect(chapters[2].sections).toContain('扬尘污染防治措施');
    expect(chapters[2].sections).toContain('绿色施工与四节一环保措施');
    expect(chapters[3].sections).toEqual(['建筑工人实名制管理', '农民工工资专用账户与工资支付保障']);
    expect(chapters[0].sections).toEqual(['编制依据']);
    expect(changes.map(item => item.chapterTitle)).toHaveLength(3);
  });

  it('不可变性：输入章节数组与 sections 不被 mutate', () => {
    const input = [chapter('确保安全生产的技术组织措施', ['安全责任体系'])];
    const { chapters } = injectReviewModuleSections(input);
    expect(input[0].sections).toEqual(['安全责任体系']);
    expect(chapters[0].sections).not.toBe(input[0].sections);
    expect(chapters[0]).not.toBe(input[0]);
  });
});

function orgAssignment(chapterTitle: string, element: string, options: { form?: TenderStructureForm; lowConfidence?: boolean } = {}): TenderStructureAssignment {
  return {
    requirement: { element, form: options.form || 'org_chart', sourceText: `以框图方式表示${element}` },
    chapterTitle,
    score: 0.62,
    lowConfidence: options.lowConfidence || false,
  };
}

describe('injectStructureOrgSections 组织机构承接小节（B-T2）', () => {
  it('org_chart 挂章且章内无承接 → 注入「项目管理机构与岗位职责」', () => {
    const { chapters, changes } = injectStructureOrgSections(
      [chapter('第五章 施工组织总体安排', ['工程概况与编制依据', '施工部署与流程安排'])],
      [orgAssignment('第五章 施工组织总体安排', '项目管理机构')],
    );
    expect(chapters[0].sections).toEqual(['工程概况与编制依据', '施工部署与流程安排', '项目管理机构与岗位职责']);
    expect(changes).toHaveLength(1);
    expect(changes[0].added).toEqual(['项目管理机构与岗位职责']);
    expect(changes[0].renamed).toHaveLength(0);
  });

  it('已有「组织机构」承接小节 → 跳过（不注入/不改名）', () => {
    const { sections, changes } = (() => {
      const result = injectStructureOrgSections(
        [chapter('第五章 施工组织总体安排', ['项目组织机构设置', '施工部署'])],
        [orgAssignment('施工组织总体安排', '项目管理机构')],
      );
      return { sections: result.chapters[0].sections || [], changes: result.changes };
    })();
    expect(sections).toEqual(['项目组织机构设置', '施工部署']);
    expect(changes).toHaveLength(0);
  });

  it('弱承接「项目班子及岗位职责」→ 标题规范化（不新增小节）', () => {
    const { chapters, changes } = injectStructureOrgSections(
      [chapter('施工组织总体安排', ['项目班子及岗位职责', '资源配置计划'])],
      [orgAssignment('施工组织总体安排', '项目管理机构')],
    );
    expect(chapters[0].sections).toEqual(['项目管理机构与岗位职责', '资源配置计划']);
    expect(changes[0].renamed).toEqual([{ from: '项目班子及岗位职责', to: '项目管理机构与岗位职责' }]);
    expect(changes[0].added).toHaveLength(0);
  });

  it('低置信（未挂章）→ 不注入（防错挂）；非组织类结构要求 → 不触发', () => {
    const lowConfidence = injectStructureOrgSections(
      [chapter('施工组织总体安排', ['施工部署'])],
      [orgAssignment('施工组织总体安排', '项目管理机构', { lowConfidence: true })],
    );
    expect(lowConfidence.changes).toHaveLength(0);
    expect(lowConfidence.chapters[0].sections).toEqual(['施工部署']);
    const nonOrg = injectStructureOrgSections(
      [chapter('施工总平面布置', ['临时设施布置'])],
      [orgAssignment('施工总平面布置', '施工总平面布置', { form: 'diagram' })],
    );
    expect(nonOrg.changes).toHaveLength(0);
  });

  it('element 含机构词但 form 为 table → 同样承接（机构内容不论呈现形态）', () => {
    const { changes } = injectStructureOrgSections(
      [chapter('项目管理机构部署', ['岗位设置说明'])],
      [orgAssignment('项目管理机构部署', '项目管理机构', { form: 'table' })],
    );
    expect(changes[0].added).toEqual(['项目管理机构与岗位职责']);
  });

  it('多要素挂同章只处理一次；重复调用幂等（已有承接跳过）', () => {
    const input = [chapter('施工组织总体安排', ['施工部署'])];
    const first = injectStructureOrgSections(input, [orgAssignment('施工组织总体安排', '项目管理机构'), orgAssignment('施工组织总体安排', '组织机构')]);
    expect(first.changes[0].added).toEqual(['项目管理机构与岗位职责']);
    const second = injectStructureOrgSections(first.chapters, [orgAssignment('施工组织总体安排', '项目管理机构')]);
    expect(second.changes).toHaveLength(0);
    expect((second.chapters[0].sections || []).filter(section => section === '项目管理机构与岗位职责')).toHaveLength(1);
  });

  it('不可变性：输入章节数组与 sections 不被 mutate', () => {
    const input = [chapter('施工组织总体安排', ['施工部署'])];
    const { chapters } = injectStructureOrgSections(input, [orgAssignment('施工组织总体安排', '项目管理机构')]);
    expect(input[0].sections).toEqual(['施工部署']);
    expect(chapters[0]).not.toBe(input[0]);
  });
});
