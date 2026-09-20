/**
 * 规划层确定性承接小节（零 LLM，注入/标题规范化）：6 强制模块与劳务保障制度（评审模块）
 * 与组织机构（B-T2 结构要求）在规划层显性承接。
 *
 * 归因（丰乐镇 R12 实测）：成稿语义评分按「块级 bge 余弦 ≥0.6」判定 6 强制模块与 13 合规项
 * （tenderBidScoring.ts MANDATORY_MODULE_QUERIES / COMPLIANCE_ITEM_QUERIES），但规划小节标题用
 * 近义改写（「实名制考勤与工资直发」对「建筑工人实名制管理」仅 0.557 MISS、「应急准备与防火防中毒」
 * 对「生产安全事故应急预案与应急演练」0.552 MISS）——内容已写入、术语不显性即判缺失，
 * completeness/compliance 恒低分。bge 实测：标题即规范术语原词时同一内容语义升至 0.64-0.93 全命中。
 *
 * 两条确定性动作（规划出口执行，写入后随规划结构直通写作/目录/预算，成稿 H3/H4 一一对应）：
 * ① 弱承接小节规范化：目标章已有含模块核心词元的小节 → 标题替换为规范术语标题（内容域不变）；
 * ② 缺失模块注入：目标章无任何承接小节 → 注入规范术语标题小节（标题即评审查询原词）。
 * 小节标题均为规范名词短语（4-16 字），与 isInvalidPlannedSectionTitle 口径兼容
 * （无结构标签/指令词/连续重复字符/条款碎片）。
 */
import type { DocumentTemplateChapter } from './types';
import { displayChapterTitle } from './outline';
import { normalizeChapterTitleLine, type TenderStructureAssignment } from './tenderRequirements';
import { sectionTitleEquivalent } from './promptRuleExtraction';

/** 评审模块承接表：module 为诊断标识，coreWords 判定弱承接（同域即可，改名优先于注入——防重复小节），
 * section 为规范术语标题（与 tenderBidScoring 查询原型同词或同义规范名） */
const REVIEW_MODULE_SECTIONS: Array<{ module: string; chapterPattern: RegExp; coreWords: RegExp; section: string }> = [
  // 安全章组（危大闭环链 6 环节 + 应急预案 + 临时用电三级配电两级保护）
  { module: '危险源辨识与风险识别评估', chapterPattern: /安全|危大/u, coreWords: /危险源|风险辨识|风险识别|风险分级|风险管控/u, section: '危险源辨识与风险识别评估' },
  { module: '危险性较大的分部分项工程安全管理', chapterPattern: /安全|危大/u, coreWords: /危大|危险性较大/u, section: '危险性较大的分部分项工程安全管理' },
  { module: '生产安全事故应急预案与应急演练', chapterPattern: /安全|危大/u, coreWords: /应急/u, section: '生产安全事故应急预案与应急演练' },
  { module: '施工现场临时用电三级配电两级保护', chapterPattern: /安全|危大/u, coreWords: /临电|用电|配电|漏电/u, section: '施工现场临时用电三级配电两级保护' },
  // 文明章组（扬尘污染防治 + 绿色施工与四节一环保）
  { module: '扬尘污染防治措施', chapterPattern: /文明|环保|绿色|扬尘|环境/u, coreWords: /扬尘/u, section: '扬尘污染防治措施' },
  { module: '绿色施工与四节一环保措施', chapterPattern: /文明|环保|绿色|扬尘|环境/u, coreWords: /绿色施工|四节|节能|节水|节材|节地|环境保护|环保/u, section: '绿色施工与四节一环保措施' },
  // 劳动力章组（实名制管理 + 工资专用账户保障）
  { module: '建筑工人实名制管理', chapterPattern: /劳动力|劳务|用工|实名|工资|人员/u, coreWords: /实名|考勤|劳务/u, section: '建筑工人实名制管理' },
  { module: '农民工工资专用账户与工资支付保障', chapterPattern: /劳动力|劳务|用工|实名|工资|人员/u, coreWords: /工资|专户|代发/u, section: '农民工工资专用账户与工资支付保障' },
];

export interface ReviewModuleSectionChange {
  chapterTitle: string;
  /** 注入的新小节（标题即规范术语） */
  added: string[];
  /** 弱承接标题规范化（原名 → 规范术语标题，小节数不变） */
  renamed: Array<{ from: string; to: string }>;
}

/** 评审模块承接小节注入：逐模块在目标章（章标题匹配 chapterPattern）中查找承接——
 * 已有等价小节跳过；存在弱承接（标题含核心词元）则规范化标题；完全缺失则注入规范术语小节。
 * 改名即时生效（后续模块看到最新标题），天然防止同一小节被多模块重复占用。 */
export function injectReviewModuleSections(chapters: DocumentTemplateChapter[]): { chapters: DocumentTemplateChapter[]; changes: ReviewModuleSectionChange[] } {
  const next = chapters.map(chapter => ({ ...chapter, sections: [...(chapter.sections || [])] }));
  const changes: ReviewModuleSectionChange[] = [];
  for (const sectionModule of REVIEW_MODULE_SECTIONS) {
    const chapter = next.find(item => sectionModule.chapterPattern.test(displayChapterTitle(item.title)));
    if (!chapter) continue;
    const sections = chapter.sections || (chapter.sections = []);
    if (sections.some(section => sectionTitleEquivalent(section, sectionModule.section))) continue;
    const weakIndex = sections.findIndex(section => sectionModule.coreWords.test(section));
    const record = changes.find(item => item.chapterTitle === chapter.title) || (changes.push({ chapterTitle: chapter.title, added: [], renamed: [] }), changes[changes.length - 1]!);
    if (weakIndex >= 0) {
      record.renamed.push({ from: sections[weakIndex]!, to: sectionModule.section });
      sections[weakIndex] = sectionModule.section;
    } else {
      sections.push(sectionModule.section);
      record.added.push(sectionModule.section);
    }
  }
  return { chapters: next, changes: changes.filter(item => item.added.length > 0 || item.renamed.length > 0) };
}

// ── B-T2 组织机构承接小节（结构要求驱动，动态触发） ──

/** 组织机构要素判定（结构要求）：org_chart 形态或 element 命中机构核心词即视为组织机构类要求 */
const ORG_STRUCTURE_ELEMENT_RE = /组织机构|项目管理机构|项目经理部|项目班子|管理机构|管理部门|管理团队|管理人员配置|人员配置|组织体系/u;

/** 组织机构承接规范术语小节（与 renderChapterStructureSlice 的 org_chart 专项指令同词） */
export const ORG_STRUCTURE_SECTION = '项目管理机构与岗位职责';

/** 已有承接判定（不重复注入/不改名）：「项目管理机构」类小节已存在即视为承接；
 * 「安全管理机构」等专业机构小节不算（其归属专业章而非项目管理机构内容） */
const ORG_SECTION_COVERED_RE = /项目管理机构|组织机构|组织架构|项目经理部/u;

/** 弱承接判定：标题含机构框架词元 → 规范化改名（改名优先于注入，防重复小节） */
const ORG_SECTION_CORE_WORDS = /组织机构|组织架构|项目班子|项目经理部|管理团队/u;

/**
 * 组织机构承接小节注入（B-T2，规划层确定性）：招标结构要求含组织机构类（org_chart 或机构要素）时，
 * 在语义路由目标章显性承接「项目管理机构与岗位职责」——已有承接跳过、弱承接标题规范化、完全缺失注入。
 * 目标章取 assignment.chapterTitle（与写作指令同路由函数、同章标题归一化口径——防「小节在此章、指令挂彼章」
 * 错位）；低置信（不挂章）不注入，防错挂。正文内容由写作链 org_chart 专项指令落实（组织架构说明 +
 * 框图承载 + 岗位责任矩阵），零实名数据（人员实名信息属商务册职责，由提示词红线拦截）。
 */
export function injectStructureOrgSections(
  chapters: DocumentTemplateChapter[],
  assignments: TenderStructureAssignment[],
): { chapters: DocumentTemplateChapter[]; changes: ReviewModuleSectionChange[] } {
  const orgAssignments = assignments.filter(assignment => !assignment.lowConfidence && (assignment.requirement.form === 'org_chart' || ORG_STRUCTURE_ELEMENT_RE.test(assignment.requirement.element)));
  if (orgAssignments.length === 0) return { chapters, changes: [] };
  const next = chapters.map(chapter => ({ ...chapter, sections: [...(chapter.sections || [])] }));
  const changes: ReviewModuleSectionChange[] = [];
  const handled = new Set<string>();
  for (const assignment of orgAssignments) {
    const chapter = next.find(item => normalizeChapterTitleLine(item.title) === assignment.chapterTitle);
    if (!chapter || handled.has(chapter.id)) continue;
    handled.add(chapter.id);
    const sections = chapter.sections || (chapter.sections = []);
    if (sections.some(section => ORG_SECTION_COVERED_RE.test(section))) continue;
    const record = changes.find(item => item.chapterTitle === chapter.title) || (changes.push({ chapterTitle: chapter.title, added: [], renamed: [] }), changes[changes.length - 1]!);
    const weakIndex = sections.findIndex(section => ORG_SECTION_CORE_WORDS.test(section));
    if (weakIndex >= 0) {
      record.renamed.push({ from: sections[weakIndex]!, to: ORG_STRUCTURE_SECTION });
      sections[weakIndex] = ORG_STRUCTURE_SECTION;
    } else {
      sections.push(ORG_STRUCTURE_SECTION);
      record.added.push(ORG_STRUCTURE_SECTION);
    }
  }
  return { chapters: next, changes: changes.filter(item => item.added.length > 0 || item.renamed.length > 0) };
}
