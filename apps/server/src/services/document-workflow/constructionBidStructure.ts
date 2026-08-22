import type { DocumentTemplate, DocumentTemplateChapter } from './types';
import { displayChapterTitle } from './outline';
import { inferConstructionOrgProjectTypes, type ConstructionOrgProjectType } from './constructionOrgCatalog';

/**
 * L1 结构引擎：评标结构知识库与前置结构校验。
 *
 * 目标：在章节生成开始前，将"评标导向的施工组织设计结构"约束注入章节规划，
 * 并在规划完成后执行结构符合性校验（阻断级），避免生成后才发现章节结构失真
 * （例如某章膨胀至 46 个小节、缺少主要施工内容、缺少质量/安全保障结构）。
 */

export type BidStructureGroupId =
  | 'overview'        // 工程概况与总体理解
  | 'major-content'   // 项目主要施工内容（工作包）
  | 'key-difficulty'  // 重难点分析与对策
  | 'deployment'      // 施工部署与组织
  | 'schedule'        // 进度计划与工期保障
  | 'quality'         // 质量保证体系
  | 'safety'          // 安全文明与危大工程
  | 'resources'       // 人材机资源配置
  | 'environment'     // 绿色文明施工
  | 'emergency';      // 应急管理

export interface BidStructureGroup {
  id: BidStructureGroupId;
  title: string;
  /** 该结构组必须承载的最小内容集合（小节标题关键词） */
  requiredSectionPatterns: RegExp[];
  /** 挂靠章标题的匹配正则（决定该结构组应落在哪一章） */
  chapterPatterns: RegExp[];
  /** 结构组缺失时的补救说明 */
  remedy: string;
  /** 最低要求级别：required=评标必查结构，recommended=加分结构 */
  level: 'required' | 'recommended';
}

/**
 * 评标结构知识库：面向整个建筑领域的通用评标结构基准。
 * 参考入围施工组织设计的评标结构（整体理解→主要施工内容→重难点→部署→进度→质量→安全→人材机→文明绿色→应急），
 * 同时兼容常见的"六章制/八章制"技术标结构。
 */
export const BID_STRUCTURE_GROUPS: BidStructureGroup[] = [
  {
    id: 'overview',
    title: '工程概况与总体理解',
    requiredSectionPatterns: [/编制依据|编制说明/u, /工程概况|项目概况|基本概况/u, /现场踏勘|施工条件|现场条件/u],
    chapterPatterns: [/概况|总体|理解|说明|编制|项目/u],
    remedy: '应设置工程概况章节，包含编制依据、工程基本概况、现场条件与总体理解。',
    level: 'required',
  },
  {
    id: 'major-content',
    title: '项目主要施工内容',
    requiredSectionPatterns: [/主要施工内容|主要施工项目|施工内容/u],
    chapterPatterns: [/概况|总体|理解|主要施工|工程/u],
    remedy: '必须包含"项目主要施工内容"小节，按工作包展开施工概况、施工流程、施工方法。',
    level: 'required',
  },
  {
    id: 'key-difficulty',
    title: '重难点分析与对策',
    requiredSectionPatterns: [/重点.*难点|难点.*对策|重难点/u],
    chapterPatterns: [/概况|总体|理解|重点|难点|施工/u],
    remedy: '应设置项目特点、重点、难点分析小节，并逐项给出应对措施与责任闭环。',
    level: 'required',
  },
  {
    id: 'deployment',
    title: '施工部署与施工组织',
    requiredSectionPatterns: [/施工部署|总体部署|流水|施工顺序|施工区段/u],
    chapterPatterns: [/部署|组织|总体|方案/u],
    remedy: '应设置施工部署小节，明确流水段划分、施工顺序与资源调配。',
    level: 'required',
  },
  {
    id: 'schedule',
    title: '进度计划与工期保障',
    requiredSectionPatterns: [/进度计划|工期|节点/u],
    chapterPatterns: [/进度|工期|计划|保障/u],
    remedy: '应设置进度计划与工期保障小节，含总进度计划、关键节点与纠偏措施。',
    level: 'required',
  },
  {
    id: 'quality',
    title: '质量保证体系与措施',
    requiredSectionPatterns: [/质量/u],
    chapterPatterns: [/质量|验收|保障|措施/u],
    remedy: '应设置质量保证体系与措施小节，含质量目标、三检、隐蔽验收、通病防治。',
    level: 'required',
  },
  {
    id: 'safety',
    title: '安全文明施工与危大工程管控',
    requiredSectionPatterns: [/安全/u, /危大/u],
    chapterPatterns: [/安全|文明|风险|危大|保障|措施/u],
    remedy: '应设置安全管理与危大工程管控小节，含危险源辨识、危大清单、专项方案。',
    level: 'required',
  },
  {
    id: 'resources',
    title: '劳动力材料机械设备配置',
    requiredSectionPatterns: [/劳动力|机械设备|材料.*计划|资源配置|人材机/u],
    chapterPatterns: [/资源|劳动力|机械|材料|设备|计划/u],
    remedy: '应设置资源配置小节，含分阶段劳动力、机械设备投入与材料进场计划。',
    level: 'required',
  },
  {
    id: 'environment',
    title: '绿色文明施工与环保措施',
    requiredSectionPatterns: [/文明施工|扬尘|噪声|绿色|环保|四节/u],
    chapterPatterns: [/文明|绿色|环保|扬尘|噪声|保障|措施/u],
    remedy: '应设置文明施工与绿色施工小节，含扬尘噪声管控与四节一环保措施。',
    level: 'required',
  },
  {
    id: 'emergency',
    title: '应急管理体系',
    requiredSectionPatterns: [/应急/u],
    chapterPatterns: [/应急|安全|保障|措施/u],
    remedy: '应设置应急管理小节，含应急组织、物资储备与专项预案。',
    level: 'recommended',
  },
];

/** 项目类型专属的加分结构组 */
const PROJECT_TYPE_EXTRA_GROUPS: Record<Exclude<ConstructionOrgProjectType, 'general'>, BidStructureGroup[]> = {
  building: [
    {
      id: 'key-difficulty',
      title: '危大工程专项管控（房建）',
      requiredSectionPatterns: [/深基坑|高支模|起重吊装|脚手架/u],
      chapterPatterns: [/危大|安全|专项/u],
      remedy: '房建项目应对深基坑、高支模、起重吊装、脚手架等危大工程逐项给出专项方案与安全管理措施。',
      level: 'recommended',
    },
  ],
  municipal: [
    {
      id: 'key-difficulty',
      title: '交通导改与管线保护（市政）',
      requiredSectionPatterns: [/交通导改|交通导行|占道施工/u, /管线保护|管线探测/u],
      chapterPatterns: [/交通|管线|安全|专项|保障/u],
      remedy: '市政项目应设置交通导改与既有管线保护专项内容。',
      level: 'recommended',
    },
  ],
  renovation: [
    {
      id: 'key-difficulty',
      title: '居民协调与既有保护（改造）',
      requiredSectionPatterns: [/居民|扰民|既有.*保护|不中断/u],
      chapterPatterns: [/居民|协调|保护|保障|专项/u],
      remedy: '改造项目应设置居民沟通协调与既有设施保护专项内容。',
      level: 'recommended',
    },
  ],
  decoration: [
    {
      id: 'key-difficulty',
      title: '成品保护与交叉施工（装饰）',
      requiredSectionPatterns: [/成品保护/u, /交叉施工|工序穿插/u],
      chapterPatterns: [/成品保护|交叉|协调|保障|专项/u],
      remedy: '装饰项目应设置成品保护与交叉施工工序优化专项内容。',
      level: 'recommended',
    },
  ],
};

function normalize(text: string) {
  return displayChapterTitle(text).replace(/\s+/gu, '').toLowerCase();
}

export interface BidStructureDiagnostic {
  groupId: BidStructureGroupId;
  groupTitle: string;
  level: 'required' | 'recommended';
  status: 'satisfied' | 'missing' | 'fragmented';
  /** 承载该结构组的章节标题（satisfied 时） */
  carrierChapters: string[];
  missingSections: string[];
  remedy: string;
}

/**
 * 结构符合性校验：检查章节规划是否满足评标结构基准。
 * - satisfied：结构组的小节全部落到至少一个章节
 * - fragmented：小节散落在 2 个以上章节（结构失真信号，如某章膨胀 46 小节）
 * - missing：必查小节缺失
 */
export function auditBidStructure(chapters: DocumentTemplateChapter[]): BidStructureDiagnostic[] {
  const groups = [...BID_STRUCTURE_GROUPS];
  return groups.map(group => {
    const carriers: string[] = [];
    const coveredPatterns = new Set<RegExp>();
    for (const chapter of chapters) {
      const chapterText = normalize(`${chapter.title} ${(chapter.sections || []).join(' ')}`);
      for (const pattern of group.requiredSectionPatterns) {
        if (pattern.test(chapterText) && !coveredPatterns.has(pattern)) {
          coveredPatterns.add(pattern);
          carriers.push(chapter.title);
        }
      }
    }
    const uniqueCarriers = [...new Set(carriers)];
    const missingSections = group.requiredSectionPatterns
      .filter(pattern => !coveredPatterns.has(pattern))
      .map(pattern => pattern.source.replace(/[\\/^$.*+?()[\]{}|]/gu, '').replace(/u$/u, ''));
    const status: BidStructureDiagnostic['status'] = coveredPatterns.size === group.requiredSectionPatterns.length
      ? (uniqueCarriers.length > 1 ? 'fragmented' : 'satisfied')
      : 'missing';
    return { groupId: group.id, groupTitle: group.title, level: group.level, status, carrierChapters: uniqueCarriers, missingSections, remedy: group.remedy };
  });
}

/** 结构组数量约束：单章小节数上限（防止某章膨胀） */
export const MAX_SECTIONS_PER_CHAPTER = 18;
/** 关键承载章最小小节数下限（概况/方案类章不能空壳） */
export const MIN_SECTIONS_FOR_CARRIER = 4;

export interface BidStructureIssue {
  level: 'error' | 'warning';
  severity: 'blocker' | 'warning';
  message: string;
  suggestion: string;
}

/** 前置结构校验：在生成开始前调用，返回阻断级问题（用于章节规划修正） */
export function validateBidStructureBeforeGeneration(input: {
  template: DocumentTemplate;
  chapters: DocumentTemplateChapter[];
  requirement?: string;
}): { diagnostics: BidStructureDiagnostic[]; issues: BidStructureIssue[]; enrichedChapters: DocumentTemplateChapter[] } {
  const diagnostics = auditBidStructure(input.chapters);
  const issues: BidStructureIssue[] = [];
  const missingRequired = diagnostics.filter(item => item.level === 'required' && item.status === 'missing');
  for (const diagnostic of missingRequired) {
    issues.push({ level: 'error', severity: 'blocker', message: `评标结构缺失：${diagnostic.groupTitle}（缺少：${diagnostic.missingSections.join('、')}）`, suggestion: diagnostic.remedy });
  }
  const fragmented = diagnostics.filter(item => item.status === 'fragmented');
  for (const diagnostic of fragmented) {
    issues.push({ level: 'warning', severity: 'warning', message: `${diagnostic.groupTitle} 小节散落在 ${diagnostic.carrierChapters.length} 个章节（${diagnostic.carrierChapters.join('、')}），结构可能失真`, suggestion: '建议将同类内容集中到一个承载章节，避免章节间职责重叠。' });
  }
  for (const chapter of input.chapters) {
    const sectionCount = (chapter.sections || []).length;
    if (sectionCount > MAX_SECTIONS_PER_CHAPTER) {
      issues.push({ level: 'warning', severity: 'warning', message: `${chapter.title} 规划小节 ${sectionCount} 个，超过 ${MAX_SECTIONS_PER_CHAPTER} 个上限，易产生内容膨胀与重复`, suggestion: '合并语义相近的小节，或将细分内容下移为三级小节而非二级小节。' });
    }
  }

  // 自动补全缺失的必查结构组小节（挂靠到最佳承载章）
  const enriched = input.chapters.map(chapter => ({ ...chapter, sections: [...(chapter.sections || [])] }));
  const used = new Set<string>();
  for (const diagnostic of missingRequired) {
    const group = BID_STRUCTURE_GROUPS.find(item => item.id === diagnostic.groupId);
    if (!group) continue;
    const carrierIndex = enriched.findIndex(chapter => {
      const title = normalize(chapter.title);
      return group.chapterPatterns.some(pattern => pattern.test(title)) && !/雨季|冬季|高温|防汛|扬尘|噪声|工资|劳务|实名|应急|BIM|智慧|管线/u.test(title);
    });
    const target = enriched[carrierIndex >= 0 ? carrierIndex : 0];
    const additions = diagnostic.missingSections.filter(section => !used.has(section));
    for (const section of additions) {
      used.add(section);
      if (!target.sections.some(item => normalize(item).includes(normalize(section)) || normalize(section).includes(normalize(item)))) {
        target.sections.push(section);
      }
    }
  }

  // 项目类型专属加分结构
  const projectTypes = inferConstructionOrgProjectTypes(input);
  for (const type of projectTypes) {
    if (type === 'general') continue;
    for (const extra of PROJECT_TYPE_EXTRA_GROUPS[type]) {
      const chapterText = normalize(enriched.map(chapter => `${chapter.title} ${(chapter.sections || []).join(' ')}`).join(' '));
      if (extra.requiredSectionPatterns.some(pattern => pattern.test(chapterText))) continue;
      const carrierIndex = enriched.findIndex(chapter => {
        const title = normalize(chapter.title);
        return extra.chapterPatterns.some(pattern => pattern.test(title));
      });
      const target = enriched[carrierIndex >= 0 ? carrierIndex : 0];
      target.sections.push(extra.title);
    }
  }

  return { diagnostics, issues, enrichedChapters: enriched };
}
