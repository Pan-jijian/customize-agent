/**
 * 评审模块承接小节（确定性注入/标题规范化，零 LLM）：6 强制模块与劳务保障制度在规划层显性承接。
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
  for (const module of REVIEW_MODULE_SECTIONS) {
    const chapter = next.find(item => module.chapterPattern.test(displayChapterTitle(item.title)));
    if (!chapter) continue;
    const sections = chapter.sections || (chapter.sections = []);
    if (sections.some(section => sectionTitleEquivalent(section, module.section))) continue;
    const weakIndex = sections.findIndex(section => module.coreWords.test(section));
    const record = changes.find(item => item.chapterTitle === chapter.title) || (changes.push({ chapterTitle: chapter.title, added: [], renamed: [] }), changes[changes.length - 1]!);
    if (weakIndex >= 0) {
      record.renamed.push({ from: sections[weakIndex]!, to: module.section });
      sections[weakIndex] = module.section;
    } else {
      sections.push(module.section);
      record.added.push(module.section);
    }
  }
  return { chapters: next, changes: changes.filter(item => item.added.length > 0 || item.renamed.length > 0) };
}
