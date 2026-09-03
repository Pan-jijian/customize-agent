/**
 * 施工组织设计写作规范单点（writingSpec）：关键小节锚定、专项写法规则、分部分项验收阈值的唯一来源。
 * 结构性转变：取消散落各文件的硬编码词表与提示词副本（chapterPlanner/chapterGeneration/
 * chapterPostProcessing/qualityValidation 曾各持一份），统一在本文件查表——
 * 新增关键小节类型、调整专项要求只改本文件一处，三条生成管线（小节/整章+主题块/聚焦草稿）自动生效。
 *
 * 配置收口（方案7）：本文件全部默认值源自 workflowRules.DEFAULT_WORKFLOW_RULES，
 * 项目级覆盖见 loadWorkflowRules（裁决链路已接入项目覆盖；本文件导出保持静态默认值，
 * 覆盖需随规则哈希联动时从 loadWorkflowRules(projectRoot) 取 writingSpec 段）。
 */

import { DEFAULT_WORKFLOW_RULES } from './workflowRules';

const DEFAULT_WRITING_SPEC = DEFAULT_WORKFLOW_RULES.writingSpec;

// ═══════ 评标必查细目锚定清单 ═══════
// 含这些词的输入细目必须保留为独立 H4 要点（标题可微调但关键词必须保留），
// 不得被主题块聚类合并吞并（历史缺陷：“项目主要施工内容”被并入“项目概况与施工内容综述”导致目录缺评标必查词）。
// 工期/质量/安全等高频词不进此表：章节内多条细目含这些词时全部保真会碎片化目录，由其自然聚类。
export const CRITICAL_SECTION_ANCHORS = DEFAULT_WRITING_SPEC.criticalSectionAnchors;

export function isCriticalSectionTitle(title: string) {
  return CRITICAL_SECTION_ANCHORS.some(keyword => title.includes(keyword));
}

// ═══════ 关键小节判别 ═══════
// 分部分项错位根治：分部分项两条锚定过去不在清单中，导致“主要分部分项工程施工方案”细目被语义聚类
// 并入其他 H4（甚至被并入“新工艺”章节）且无专项写法规则注入（历史缺陷：分部分项错位+内容概略）
export const MAJOR_CONTENT_SECTION_RE = new RegExp(DEFAULT_WRITING_SPEC.majorContentSection, 'u');
export const DIVISION_SECTION_RE = new RegExp(DEFAULT_WRITING_SPEC.divisionSection, 'u');

/** 分部分项工序标签（工艺流程/施工流程 两种写法兼容）：仅作为内容要素判定的可选形式之一，非强制标签 */
export const DIVISION_PROCESS_LABEL_RE = new RegExp(DEFAULT_WRITING_SPEC.divisionProcessLabel, 'u');

// ═══════ 专项写法规则（迁自 chapterGeneration 硬编码提示词，单点化） ═══════

const MAJOR_CONTENT_WRITE_RULES = [DEFAULT_WRITING_SPEC.writeRules.majorContent];

const DIVISION_WRITE_RULES = [DEFAULT_WRITING_SPEC.writeRules.division];

/** 小节锚定写法规则统一入口：按标题查表，返回应注入的专项规则行（无命中返回空数组） */
export function sectionAnchoredRules(sectionTitle: string): string[] {
  const rules: string[] = [];
  if (MAJOR_CONTENT_SECTION_RE.test(sectionTitle)) rules.push(...MAJOR_CONTENT_WRITE_RULES);
  if (DIVISION_SECTION_RE.test(sectionTitle)) rules.push(...DIVISION_WRITE_RULES);
  return rules;
}

/**
 * 章节级锚定规则：主题块管线的 blockChapter.sections 是 H4 要点标题（含锚定清单保真的关键词），
 * 整章管线的 chapter.sections 是规划小节——统一按「章标题+小节清单」整体判别并去重注入，
 * 保证主题块管线也能拿到与逐小节管线同源的专项规则（历史缺陷：主题块管线拿不到专项规则导致概略）
 */
export function chapterAnchoredRules(chapterTitle: string, sections: string[]): string[] {
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const candidate of [chapterTitle, ...(sections || [])]) {
    for (const rule of sectionAnchoredRules(candidate)) {
      if (seen.has(rule)) continue;
      seen.add(rule);
      rules.push(rule);
    }
  }
  return rules;
}

// ═══════ 关键小节深度判别与生成门槛（单点，自 chapterPostProcessing 收拢） ═══════

/** 深度关键小节判别（生成侧 blocker 门槛适用的标题集合，正则源来自 workflowRules 配置） */
const CRITICAL_DEEP_SECTION_RES = DEFAULT_WRITING_SPEC.criticalDeepSections.map(source => new RegExp(source, 'u'));

export function isCriticalDeepSectionTitle(sectionTitle: string) {
  return CRITICAL_DEEP_SECTION_RES.some(re => re.test(sectionTitle));
}

/** 生成侧深度 blocker 门槛（section writer / supplement 的最小字数，阈值来自 workflowRules 配置） */
export function criticalSectionBlockerMinChars(sectionTitle: string) {
  const { emergency, majorContent, division, focus } = DEFAULT_WRITING_SPEC.blockerMinChars;
  if (/危大工程专项施工方案审批流程|原材料进场复试|见证取样/u.test(sectionTitle)) return emergency;
  if (MAJOR_CONTENT_SECTION_RE.test(sectionTitle)) return majorContent;
  // “主要分部分项工程施工方案/主要施工方法”的全局门槛收敛到 1200：1800 字超过单次 LLM 稳定产出上限，
  // 导致 Writer/Repairer/Final Gate 补写永远被拒（真实生成中 1489 字也被判不足），空小节无法自愈。
  if (DIVISION_SECTION_RE.test(sectionTitle)) return division;
  if (/项目特点.*重点.*难点|重点.*难点.*分析/u.test(sectionTitle)) return focus;
  return 0;
}

// ═══════ 分部分项专项验收阈值（constructionOrgDivisionSectionIssues 消费，来自 workflowRules 配置） ═══════
export const DIVISION_SECTION_QUALITY = {
  /** 分项工程方案（#### 小节）少于 blockerMinPackages 个判结构不足（blocker）；资料覆盖专业少时不误杀 */
  blockerMinPackages: DEFAULT_WRITING_SPEC.divisionQuality.blockerMinPackages,
  /** 分项工程方案（#### 小节）建议最少数量：少于 minPackages 个仅给扩充建议（warning） */
  minPackages: DEFAULT_WRITING_SPEC.divisionQuality.minPackages,
  /** 每个分项方案正文必须落位的工艺参数最少数量（与专项提示词口径一致） */
  minParamsPerPackage: DEFAULT_WRITING_SPEC.divisionQuality.minParamsPerPackage,
  /** 每个分项方案正文最少字数（去空白）：低于该值判正文过短（blocker），门窗维修/立面修补等小分项同样要求写足 */
  minPackageChars: DEFAULT_WRITING_SPEC.divisionQuality.minPackageChars,
  /** 分项深度均衡阈值：最短分项不足最长分项该比例时给扩充建议（warning，不阻断） */
  balanceRatio: DEFAULT_WRITING_SPEC.divisionQuality.balanceRatio,
};
