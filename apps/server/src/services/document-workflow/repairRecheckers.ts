/** 修复复检器统一注册表（三期 p3-1 检测-修复同源化）：
 *  finalize 阶段 blocker 修复循环与交付前最终修复轮的复检器（detect）与确定性删除兜底（delete）
 *  原在两处独立双写（口径漂移风险：同 code 检测器两处各自构造、交付前轮缺 overview-recap/fabricated-date
 *  的 delete 兜底）。本模块收敛为单一注册表：
 *  - codes：条目服务的缺陷 code 集（blockerIssueCodeFor 产出，交付前轮按 code 精确查询）；
 *  - match：blocker 轮按缺陷消息正则路由（与原 recheckers 表逐字一致，含多 code 共享宽匹配条目）；
 *  - detect：修复后在最新全文上重跑同源检测，返回仍存在的同类缺陷消息（空数组=已消除）；
 *  - delete：二修仍失败且可确定性定位的类型提供删除兜底（与检测器同源的 strip/语义删除实现）。
 *  行为保持：所有 detect/delete 函数体自原双写位置逐字搬移；交付前轮 delete 兜底补齐由
 *  DOCUMENT_PREDELIVERY_DELETE_FALLBACK=0 回退为旧行为（仅 internal-term/commercial-data/repeated-word 三类）。 */
import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplateChapter, TenderRequirementModel } from './types';
import type { FactTokenScopeClassifier } from './factTokenClassifier';
import type { DataConsistencyConflict } from './dataConsistencyReview';
import { dataConsistencyConflictIssue, semanticChoiceConflicts, semanticChoiceConflictIssue } from './dataConsistencyReview';
import type { DecisionLockEntry } from './decisionLock';
import { crossChapterDuplicateSectionIssues } from './documentFinalValidation';
import { SOURCE_ENUMERATION_PHRASE_RE, cleanFormalSourcePhrases } from './markdownComposer';
import { generatedFactVerificationIssuesAsync, boqPlacementIssues, preciseFactUsageIssues } from './qualityValidation';
import { areaArithmeticIssues, bidderQualificationSectionIssues, bodySentencesForSemantic, collapseRepeatedWords, commercialDataInBodyIssues, dangerousListConsistencyIssues, fabricatedStartDateIssues, fieldValueMismatchIssues, localAdaptationKeywordIssues, overviewRecapCandidates, overviewRecapIssues, repeatedWordIssues, resourceConsistencyIssues, selfUnderminingCandidateIssues, sixHundredPercentCoverageIssues, stripCommercialDataSentences, supportSystemConflictIssues } from './documentIntegrityChecks';
import { isQualificationSectionTitle } from './evidenceContentSafety';
import { buildSemanticSimilarity, type SemanticSimilarityFn } from './semanticSimilarity';
import { normalizeChapterTitleLine, requirementsCoverageIssues, tenderRequirementCheckItems, tenderRequirementSemanticQuery } from './tenderRequirements';
import { constructionOrgMajorContentIssues } from './constructionOrgQualityRules';
import { internalTerminologyAnchorIssues, stripInternalTerminologySentences } from './internalTerminologyAnchors';
import { parameterConceptConflictIssues } from './parameterConceptConflicts';
import { constructionSystemCoverageIssues } from './constructionSystemCoverage';
import { dangerousApplicabilityIssues } from './dangerousApplicability';
import { stagePhrasingIssues } from './stagePhrasing';
import { emergencySectionDepthIssues } from './emergencySectionDepth';

/** 概况复述语义兑底工具集：概况章正文作语义基准，detect/delete 与检测器（overviewRecapIssues）同源同阈值（余弦 ≥0.6） */
export interface OverviewRecapTools {
  overviewBody: string;
  similarity: SemanticSimilarityFn;
}

export interface RepairRecheckerDeps {
  factsModel: DocumentFactsModel;
  /** 章草稿数组引用（修复循环逐元素替换，数组引用不变；消费点均在 finalize 尾部重赋值之前） */
  finalChapterDrafts: DocumentDraftChapter[];
  tenderRequirements?: TenderRequirementModel;
  factTokenScopeClassifier: FactTokenScopeClassifier;
  /** L3.5 数据一致性审查（D3 快照复用版）：正文哈希未变时复用快照，省去修复后重复全文审查 */
  reviewDataConsistencyCached: (markdown: string) => Promise<DataConsistencyConflict[]>;
  /** 1.3 项目关键决策锁（语义矛盾检测比对基准，与写作期注入同批证据确定性重建）；空数组时 semantic-choice 条目恒检出空 */
  decisionLock?: DecisionLockEntry[];
  /** 1.4 模板计划章（含 sections）：跨章同名 H3 检测的归属裁决基准；缺省时按"模板未安排"口径裁决（首现章保留） */
  effectiveChapters?: DocumentTemplateChapter[];
  /** 概况复述语义工具：缺概况章/无候选句时不注册 overview-recap 条目（与原条件注册一致） */
  recapTools?: OverviewRecapTools;
}

export interface RepairRechecker {
  /** 服务的缺陷 code 集（交付前轮按 code 精确查询；major-content 5 类与本地适配 3 类共享单条目） */
  codes: string[];
  /** blocker 轮消息正则路由（与原 recheckers 表逐字一致，find 首个匹配命中） */
  match: RegExp;
  label: string;
  detect: (markdown: string) => Promise<string[]>;
  delete?: (content: string, message: string) => Promise<{ content: string; removed: number }>;
}

/** 交付前轮旧行为携带 delete 兜底的 code 集（回退开关 DOCUMENT_PREDELIVERY_DELETE_FALLBACK=0 时仅这些保留 delete） */
export const PREDELIVERY_LEGACY_DELETE_CODES: ReadonlySet<string> = new Set(['internal-term', 'commercial-data', 'repeated-word']);

/** 构建统一复检器注册表。条目顺序与原 blocker 轮 recheckers 表逐字一致（find 首个匹配语义依赖顺序）。
 *  options.deleteCodes 提供时仅白名单 code 携带 delete（交付前轮回退开关用）；缺省全量携带。 */
export function buildRepairRecheckers(deps: RepairRecheckerDeps, options: { deleteCodes?: ReadonlySet<string> } = {}): RepairRechecker[] {
  const { factsModel, finalChapterDrafts, tenderRequirements, factTokenScopeClassifier, reviewDataConsistencyCached, decisionLock, effectiveChapters, recapTools } = deps;
  const gateDelete = (entry: RepairRechecker): RepairRechecker =>
    entry.delete && options.deleteCodes && !entry.codes.some(item => options.deleteCodes!.has(item))
      ? { ...entry, delete: undefined }
      : entry;
  const entries: RepairRechecker[] = [
    {
      codes: ['source-phrase'],
      match: /资料来源罗列话术/u,
      label: '资料来源罗列话术',
      detect: async markdown => {
        // 与 sourcePhraseIssues 同源：非编制依据节、非表格行中的来源罗列短语
        const found: string[] = [];
        let inBasis = false;
        for (const line of markdown.split(/\r?\n/u)) {
          const trimmed = line.trim();
          if (/^#{2,4}\s+/u.test(trimmed)) { inBasis = /编制依据|编制说明|法律法规|规范标准|标准依据/u.test(trimmed); continue; }
          if (inBasis || /^\s*\|/u.test(trimmed)) continue;
          if (SOURCE_ENUMERATION_PHRASE_RE.test(line)) found.push(trimmed.slice(0, 32));
        }
        return found;
      },
      delete: async content => {
        const next = cleanFormalSourcePhrases(content);
        return { content: next, removed: next === content ? 0 : 1 };
      },
    },
    {
      // A3：internal-term 补确定性删除兜底（与检测器同源 stripInternalTerminologySentences）——
      // 二修仍失败时整句删除，不再残留进导出门禁（历史缺陷：L1 精确词句无 L3 锚定词时 LLM 改不动也删不掉）
      codes: ['internal-term'],
      match: /后台内部术语|后台内部话术/u,
      label: '后台内部术语',
      detect: async markdown => (await internalTerminologyAnchorIssues(markdown)).map(item => item.message),
      delete: async content => {
        const next = await stripInternalTerminologySentences(content);
        return { content: next, removed: next === content ? 0 : 1 };
      },
    },
    { codes: ['param-conflict'], match: /同一参数概念出现多口径数值冲突/u, label: '参数概念口径冲突', detect: async markdown => (await parameterConceptConflictIssues(markdown)).map(item => item.message) },
    { codes: ['system-zero-coverage'], match: /专业工程系统在正文零覆盖/u, label: '专业工程系统零覆盖', detect: async () => constructionSystemCoverageIssues(finalChapterDrafts).map(item => item.message) },
    { codes: ['dangerous-list-missing'], match: /危大工程辨识清单遗漏|未编制危大工程辨识清单/u, label: '危大工程辨识遗漏', detect: async markdown => dangerousApplicabilityIssues(markdown).map(item => item.message) },
    { codes: ['major-content-dirty', 'major-content-flow', 'major-content-method', 'major-content-dup', 'major-content-structure'], match: /主要施工内容/u, label: '主要施工内容缺陷', detect: async markdown => constructionOrgMajorContentIssues(finalChapterDrafts, markdown).map(item => item.message) },
    {
      codes: ['requirement-unresponded'],
      match: /评分项要求未响应/u,
      label: '评分项要求未响应',
      // 复检与最终校验同口径：要求项 ↔（章节标题 + 正文句）同闭包 embedding（bodyTexts 必传），
      // 且查询文本必须用 tenderRequirementSemanticQuery 与构建侧一致（历史缺陷：缺 bodyTexts 只查章节标题、
      // 查询/构建口径不一致 cache miss 恒 0，正文已响应仍报零命中，修复轮永不收敛）
      detect: async markdown => {
        const queries = tenderRequirementCheckItems(tenderRequirements).map(({ item }) => tenderRequirementSemanticQuery(item));
        const chapterLines = markdown.split(/\n/u).filter(line => /^#{2,4}\s/u.test(line.trim())).map(line => normalizeChapterTitleLine(line)).filter(Boolean).slice(0, 80);
        const bodyTexts = bodySentencesForSemantic(markdown);
        const similarity = await buildSemanticSimilarity(queries, [...chapterLines, ...bodyTexts]);
        return (await requirementsCoverageIssues(markdown, tenderRequirements, { semanticSimilarity: similarity, bodyTexts })).filter(item => /评分项要求未响应/u.test(item.message)).map(item => item.message);
      },
    },
    { codes: ['self-undermining'], match: /自伤表述候选/u, label: '自伤表述候选', detect: async markdown => (await selfUnderminingCandidateIssues(markdown)).map(item => item.message) },
    {
      codes: ['fabricated-date'],
      match: /正文编造开工日期/u,
      label: '正文编造开工日期',
      detect: async markdown => fabricatedStartDateIssues(markdown, factsModel).map(item => item.message),
      delete: async (content, message) => {
        const quoted = (/“([^”]+)”/u.exec(message)?.[1] || '').replace(/\s+/gu, '');
        if (!quoted || quoted.length < 6) return { content, removed: 0 };
        const parts = content.split(/(?<=[。；;])\s*/u);
        let removed = 0;
        const kept = parts.filter(part => {
          if (!part.includes(quoted)) return true;
          removed += 1;
          return false;
        });
        return removed > 0 ? { content: kept.join(''), removed } : { content, removed: 0 };
      },
    },
    { codes: ['field-value-mismatch'], match: /字段-数值错配/u, label: '字段-数值错配', detect: async markdown => fieldValueMismatchIssues(markdown, factsModel).map(item => item.message) },
    { codes: ['area-arithmetic'], match: /面积算术矛盾/u, label: '面积算术矛盾', detect: async markdown => areaArithmeticIssues(markdown).map(item => item.message) },
    { codes: ['labor-contradiction'], match: /劳动力数据矛盾/u, label: '劳动力数据矛盾', detect: async markdown => resourceConsistencyIssues(markdown).map(item => item.message) },
    {
      codes: ['data-consistency'],
      match: /数据一致性矛盾/u,
      label: '数据一致性矛盾',
      // L3.5 审查层同源复检（D3 快照复用）：修复后全文重跑 LLM 批量审查，仍有矛盾（含修复引入的新矛盾）则进入升级轮；
      // 正文哈希未变时直接复用快照，省去每次修复后的全文审查调用
      detect: async markdown => (await reviewDataConsistencyCached(markdown)).map(conflict => dataConsistencyConflictIssue(conflict).message),
    },
    {
      // 1.3 语义矛盾（决策锁"实体-选择"冲突，塔吊 vs 施工电梯类无数值矛盾）：确定性闭集比对零 LLM 成本，
      // 与检测器同源复检；锁外取值句属实质技术内容，不提供确定性删除兜底（与 data-consistency 同口径，交 LLM 改写）
      codes: ['semantic-choice'],
      match: /语义矛盾/u,
      label: '语义矛盾',
      detect: async markdown => semanticChoiceConflicts(markdown, decisionLock || []).map(conflict => semanticChoiceConflictIssue(conflict).message),
    },
    {
      // 1.4 形态 B：跨章同名 H3 小节（1.3↔6.4 类串章实锤）；复检读章数组引用（修复逐元素替换，引用不变），
      // 归属裁决与检测同源（模板计划匹配章）；小节改写/归并属结构语义操作，不提供确定性删除兜底（交 LLM 修复轮）
      codes: ['cross-chapter-section'],
      match: /跨章同名小节/u,
      label: '跨章同名小节',
      detect: async () => crossChapterDuplicateSectionIssues(finalChapterDrafts, effectiveChapters || []).map(item => item.message),
    },
    { codes: ['support-conflict'], match: /基坑支护方案前后不一致/u, label: '基坑支护方案前后不一致', detect: async markdown => (await supportSystemConflictIssues(markdown)).map(item => item.message) },
    { codes: ['dangerous-list-inconsistent'], match: /危大工程辨识清单不一致/u, label: '危大工程辨识清单不一致', detect: async markdown => dangerousListConsistencyIssues(markdown).map(item => item.message) },
    { codes: ['six-hundred-percent'], match: /扬尘治理六个百分百/u, label: '扬尘治理六个百分百', detect: async markdown => (await sixHundredPercentCoverageIssues(markdown)).map(item => item.message) },
    { codes: ['local-award', 'green-quant', 'work-injury'], match: /本地创优目标缺失|四节一环保量化指标缺失|工伤保险表述缺失/u, label: '本地适配与政策合规关键词', detect: async markdown => (await localAdaptationKeywordIssues(markdown, factsModel)).map(item => item.message) },
    { codes: ['fact-verification'], match: /生成后事实反查失败/u, label: '生成后事实反查失败', detect: async markdown => (await generatedFactVerificationIssuesAsync(markdown, factsModel, { scopeClassifier: factTokenScopeClassifier })).filter(item => /生成后事实反查失败/u.test(item.message)).map(item => item.message) },
    { codes: ['repeated-word'], match: /正文存在叠词重复表述/u, label: '叠词重复表述', detect: async markdown => repeatedWordIssues(markdown).map(item => item.message), delete: async content => { const next = collapseRepeatedWords(content); return { content: next, removed: next === content ? 0 : 1 }; } },
    { codes: ['commercial-data'], match: /正文出现商务条款数据/u, label: '商务条款数据', detect: async markdown => (await commercialDataInBodyIssues(markdown)).map(item => item.message), delete: async content => { const next = stripCommercialDataSentences(content); return { content: next, removed: next === content ? 0 : 1 }; } },
    {
      // h17：资格串章确定性删除（评分报告 P1 收口）——资格内容小节整块删除，
      // 检测与删除同源（isQualificationSectionTitle），LLM patch 删不动时也不残留进导出门禁
      codes: ['qualification-mixed'],
      match: /投标人资格内容小节/u,
      label: '投标人资格内容串章',
      detect: async markdown => bidderQualificationSectionIssues(markdown).map(item => item.message),
      delete: async (content: string): Promise<{ content: string; removed: number }> => {
        const lines = content.split(/\r?\n/u);
        let removed = 0;
        const kept: string[] = [];
        let skipUntilLevel: number | undefined;
        for (const line of lines) {
          const heading = /^(#{2,4})\s+(.+)$/u.exec(line.trim());
          if (skipUntilLevel !== undefined) {
            if (heading && heading[1].length <= skipUntilLevel) {
              // 到达下一同级/上级标题行：恢复保留
              skipUntilLevel = undefined;
              kept.push(line);
              continue;
            }
            // 删除区间内：标题行以下内容全部丢弃（含子标题）
            continue;
          }
          if (heading && isQualificationSectionTitle(heading[2].trim())) {
            removed += 1;
            skipUntilLevel = heading[1].length;
            continue;
          }
          kept.push(line);
        }
        return removed > 0 ? { content: kept.join('\n'), removed } : { content, removed: 0 };
      },
    },
    { codes: ['boq-placement'], match: /清单项落位不足/u, label: '清单项落位不足', detect: async markdown => (await boqPlacementIssues(markdown, finalChapterDrafts, factsModel)).map(item => item.message) },
    { codes: ['precise-param'], match: /可靠精确参数使用不足/u, label: '可靠精确参数使用不足', detect: async markdown => (await preciseFactUsageIssues(markdown, factsModel, finalChapterDrafts)).filter(item => /关键参数抽查/u.test(item.message)).map(item => item.message) },
    { codes: ['stage-phrasing'], match: /施工阶段划分口径不统一/u, label: '施工阶段划分口径', detect: async markdown => (await stagePhrasingIssues(markdown)).map(item => item.message) },
    { codes: ['emergency-depth'], match: /应急预案小节深度不足/u, label: '应急预案小节深度', detect: async markdown => (await emergencySectionDepthIssues(markdown)).map(item => item.message) },
    ...(recapTools ? [{
      codes: ['overview-recap'],
      match: /概况段跨章复述/u,
      label: '概况段跨章复述',
      detect: async (markdown: string): Promise<string[]> => {
        const candidates = overviewRecapCandidates(markdown);
        if (candidates.sentences.length === 0 || !candidates.overviewBody) return [];
        const similarity = await buildSemanticSimilarity(candidates.sentences, [candidates.overviewBody]);
        return overviewRecapIssues(markdown, { semanticSimilarity: similarity }).map(item => item.message);
      },
      delete: async (content: string): Promise<{ content: string; removed: number }> => {
        const sentences = content.split(/(?<=[。；;])\s*/u);
        // 复述开头形态与检测侧 overviewRecapCandidates 同口径封闭集（本项目为/本工程为/该项目为/该工程为）
        const recapCandidates = sentences.filter(sentence => /本项目为|本工程为|该项目为|该工程为/u.test(sentence));
        if (recapCandidates.length === 0) return { content, removed: 0 };
        const similarity = await buildSemanticSimilarity(recapCandidates, [recapTools.overviewBody]);
        let removed = 0;
        const kept = sentences.filter(sentence => {
          if (!/本项目为|本工程为|该项目为|该工程为/u.test(sentence)) return true;
          if (similarity(sentence, recapTools.overviewBody) < 0.6) return true;
          removed += 1;
          return false;
        });
        return removed > 0 ? { content: kept.join(''), removed } : { content, removed: 0 };
      },
    } as RepairRechecker] : []),
  ];
  return entries.map(entry => gateDelete(entry));
}
