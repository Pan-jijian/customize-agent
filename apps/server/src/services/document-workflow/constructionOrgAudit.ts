import type { DocumentDraftChapter, ValidationIssue } from './types';
import { stripTableCellInvisibleChars } from './helpers/markdownCleanup';
import { DEVICE_SPEC_RE, PROCESS_PARAMETER_RE } from './parameterPatterns';
import { buildSemanticGate } from './semanticGate';
import { isFillerPoolExcludedLine, isTemplatePrefixSentence, isZeroInfoSloganSentence, judgeFillerSentences } from './tenderBidChecks';
import { workPackageContentElementsComplete } from './utils';

export { DEVICE_SPEC_RE, PROCESS_PARAMETER_RE } from './parameterPatterns';

/**
 * L4 校验体系：面向施工组织设计的专业性审计校验器。
 *
 * 原有校验器只查"有没有数字"，本组校验器查"什么数字、什么段落、什么表格"：
 * 1. duplicateParagraphIssues      —— 跨小节重复段落检测（同段出现在多个小节）
 * 2. fillerParagraphIssues         —— 废话段落模式检测（模板化空话，正则召回+语义复核）
 * 3. processParameterDensityIssues —— 工艺参数密度（区分概况数字与工艺参数）
  * 4. sectionCardStructureIssues    —— 工作包内容要素完整性（4.17.9 呈现形式不限，标签不强制）
 * 5. tableCompletenessIssues       —— 表格空字段检测
 * （原 6. reviewResponseIssues 已删除：招标硬性要求响应检测统一由 tenderRequirements.ts
 *   锚点级语义通道（requirementAcceptanceIssues）承担，消除两处实现口径分裂——阶段五 5.3）
 */

/** 废话段模式库：正则只做召回（短路优化），语义判定由 FILLER_PARAGRAPH_SEMANTIC_PROTOTYPES 语义 gate 完成（阶段五） */
const FILLER_PARAGRAPH_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /本小节围绕.+展开，结合绑定项目资料/u, label: '模板化开篇套话' },
  { pattern: /明确适用范围、控制目标、责任岗位与过程要求/u, label: '泛化目标罗列' },
  { pattern: /实施前应完成资料核对、技术交底和作业条件确认/u, label: '泛化前置条件' },
  { pattern: /交底覆盖率按\s*100%?\s*控制/u, label: '空泛交底承诺' },
  { pattern: /关键问题在\s*24\s*小时内形成整改责任/u, label: '空泛整改时限' },
  { pattern: /按施工准备→过程实施→检查验收→问题整改→资料归档的闭环组织/u, label: '通用闭环套话' },
  { pattern: /按作业条件确认→技术交底→过程实施→自检互检→整改复查/u, label: '通用流程套话' },
  { pattern: /依据本项目已确认资料中的项目边界/u, label: '资料依据套话' },
  { pattern: /执行日巡查、周复核和节点验收制度/u, label: '泛化巡查制度' },
  { pattern: /一般问题\s*7\s*日内闭环/u, label: '泛化整改时限' },
  { pattern: /由项目经理、技术负责人和专职安全员联合复核/u, label: '岗位名单堆砌' },
  { pattern: /确保与总体施工部署、工期计划和验收要求保持一致/u, label: '原则性呼应' },
  { pattern: /结合现场实际情况(?:，|,)?合理(?:组织|安排|布置|配置)/u, label: '结合实际套话' },
  { pattern: /严格(?:执行|落实|按照)国家(?:现行)?(?:有关)?(?:规范|标准|规程)/u, label: '规范泛引用' },
  { pattern: /做到(?:文明施工|安全生产|质量第一|安全第一)/u, label: '口号式承诺' },
  { pattern: /(?:确保|保证)工程(?:质量|安全|进度|文明施工)/u, label: '目标口号' },
  { pattern: /建立(?:健全)?(?:完善)?(?:的)?(?:管理)?体系(?:和|，)?(?:落实|确保|保证)/u, label: '体系空话' },
];

/** 废话段模式合并召回正则：命中仅触发语义复核（不直接判定） */
const FILLER_PARAGRAPH_LEXICAL_RE = new RegExp(FILLER_PARAGRAPH_PATTERNS.map(item => `(?:${item.pattern.source})`).join('|'), 'u');

/** 废话段语义原型（正例）：与 17 条模式 label 同口径的套话表述基准（bge 余弦 ≥ 阈值判定套话） */
const FILLER_PARAGRAPH_SEMANTIC_PROTOTYPES = [
  '本小节围绕以下内容展开并结合绑定项目资料',
  '明确适用范围控制目标责任岗位与过程要求',
  '实施前应完成资料核对技术交底和作业条件确认',
  '交底覆盖率按100%控制',
  '关键问题在24小时内形成整改责任',
  '按施工准备过程实施检查验收问题整改资料归档的闭环组织',
  '依据本项目已确认资料中的项目边界',
  '执行日巡查周复核和节点验收制度',
  '一般问题7日内闭环',
  '由项目经理技术负责人和专职安全员联合复核',
  '确保与总体施工部署工期计划和验收要求保持一致',
  '结合现场实际情况合理组织安排',
  '严格执行国家现行有关规范标准',
  '做到文明施工安全生产质量第一',
  '确保工程质量和安全进度',
  '建立健全管理体系并落实相关制度',
] as const;

/** 具体量化措施语义原型（负例保护）：含套话词面但语义属落地措施不得误判套话 */
const FILLER_LEGAL_PROTOTYPES = [
  '每道工序完成后由质检员实测实量并记录数据',
  '混凝土浇筑完成后每天洒水养护不少于两次',
  '每周组织不少于一次的现场安全专项检查',
] as const;

/** 构建废话段语义 gate：正则召回 + 语义复核（semanticGate 统一入口） */
async function buildFillerParagraphGate(embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<(texts: string[]) => Promise<boolean[]>> {
  return buildSemanticGate({
    prototypes: [...FILLER_PARAGRAPH_SEMANTIC_PROTOTYPES],
    negativePrototypes: [...FILLER_LEGAL_PROTOTYPES],
    lexicalHints: FILLER_PARAGRAPH_LEXICAL_RE,
    embedDocuments,
  });
}

const WORK_PACKAGE_SECTION_PATTERNS = [/主要分部分项工程施工方案/u, /主要施工方法/u, /主要施工内容/u, /施工方案/u];

const BASIC_FACT_RE = /(?:建筑面积|面积|总建筑面积)[约]?\s*\d+(?:\.\d+)?\s*(?:㎡|m²)|计划工期\s*\d+|日历天|地上\s*\d+\s*层|框架结构|质量标准[:：]?\s*合格/giu;

function extractSectionBlocks(content: string): Array<{ heading: string; body: string }> {
  const lines = content.split('\n');
  const blocks: Array<{ heading: string; body: string }> = [];
  let currentHeading = '';
  let currentBody: string[] = [];
  for (const line of lines) {
    // 零宽剥离后再识别标题（r28f 全文穿插 U+200B 类字符，裸 line.trim() 对零宽标题行失配）
    const heading = /^#{3,4}\s+(.+)$/u.exec(line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').trim());
    if (heading) {
      if (currentHeading || currentBody.length > 0) blocks.push({ heading: currentHeading, body: currentBody.join('\n') });
      currentHeading = heading[1].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentHeading || currentBody.length > 0) blocks.push({ heading: currentHeading, body: currentBody.join('\n') });
  return blocks;
}

function normalizeParagraph(text: string) {
  return text.replace(/[，。,.;；:：、（）()【】[\]《》“”"'`\s]/gu, '');
}

/** 从正文中提取段落（按句号分段的完整句组，长度≥60 字的才算可重复段落） */
function extractParagraphs(body: string): string[] {
  const cleaned = body
    .replace(/^#{1,6}\s+.*$/gmu, '')
    .replace(/^\s*\|.*\|\s*$/gmu, '')
    .replace(/^\s*[-|]\s*$/gmu, '')
    .replace(/^\s*\[.*?\]\(.*?\)\s*$/gmu, '');
  return cleaned
    .split(/\n{1,}/u)
    .map(item => item.trim())
    .filter(item => item.length >= 60 && item.length <= 400 && !/^\s*[-*]\s+/u.test(item));
}

/** 1. 跨小节重复段落检测：同一段落出现在 ≥2 个不同小节即为重复 */
export function duplicateParagraphIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const paragraphLocations = new Map<string, Array<{ chapter: string; section: string }>>();
  for (const chapter of chapters) {
    const blocks = extractSectionBlocks(chapter.content);
    for (const block of blocks) {
      const section = block.heading || chapter.title;
      for (const paragraph of extractParagraphs(block.body)) {
        const key = normalizeParagraph(paragraph);
        if (key.length < 60) continue;
        const locations = paragraphLocations.get(key) || [];
        if (!locations.some(item => item.chapter === chapter.title && item.section === section)) {
          locations.push({ chapter: chapter.title, section });
        }
        paragraphLocations.set(key, locations);
      }
    }
  }
  const reported = new Set<string>();
  for (const [key, locations] of paragraphLocations) {
    const uniqueLocations = locations.filter((item, index, array) => array.findIndex(other => other.chapter === item.chapter && other.section === item.section) === index);
    if (uniqueLocations.length < 2) continue;
    const fingerprint = uniqueLocations.map(item => `${item.chapter}::${item.section}`).sort().join('|');
    if (reported.has(fingerprint)) continue;
    reported.add(fingerprint);
    const sample = locations[0];
    const preview = sample ? `（如：${sample.section} 中「${key.slice(0, 30)}…」）` : '';
    issues.push({
      level: uniqueLocations.length >= 3 ? 'error' : 'warning',
      severity: uniqueLocations.length >= 3 ? 'blocker' : 'warning',
      message: `发现相同段落出现在 ${uniqueLocations.length} 个不同小节：${uniqueLocations.map(item => item.section).slice(0, 6).join('、')}${preview}`,
      suggestion: '每个小节必须针对其标题写专属内容，不得复制粘贴相同段落；重复小节应合并或删除后重写。',
    });
    if (issues.length >= 8) break;
  }
  return issues;
}

/** 2. 废话段落模式检测：正则召回 → 句级语义复核（bge 余弦 ≥ 阈值才计命中），具体量化措施负例放行 */
export async function fillerParagraphIssues(
  chapters: DocumentDraftChapter[],
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const judge = await buildFillerParagraphGate(embedDocuments);
  for (const chapter of chapters) {
    const blocks = extractSectionBlocks(chapter.content);
    const chapterHits: string[] = [];
    for (const block of blocks) {
      // D-T7：行过滤与修复锚点端（isFillerPoolExcludedLine）同源——r28f 实测章标题行
      // （「## 第六章 确保工程质量的技术组织措施」）此前直入句池被词面「确保工程质量」+
      // 语义复核命中，误报「模板化空话：目标口号」（#53：检测端 17 原型无行过滤 = 修复端
      // 有行过滤的口径分叉）；标题/表格/列表/目录条目行不入池。
      const sentences = block.body
        .split(/\n/u)
        .filter(line => !isFillerPoolExcludedLine(line))
        .flatMap(line => line.split(/[。；;]/u))
        .map(sentence => sentence.trim())
        .filter(sentence => sentence.length >= 12);
      if (sentences.length === 0) continue;
      const flags = await judge(sentences);
      sentences.forEach((sentence, index) => {
        if (!flags[index]) return;
        // 语义确认后按句内命中的召回模式归 label（正则仅召回，label 归属保持确定性）
        for (const { pattern, label } of FILLER_PARAGRAPH_PATTERNS) {
          if (pattern.test(sentence) && !chapterHits.includes(label)) chapterHits.push(label);
        }
      });
    }
    if (chapterHits.length >= 3) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        message: `${chapter.title} 存在大量模板化空话（${chapterHits.slice(0, 6).join('、')}）`,
        suggestion: '删除"本小节围绕…展开""按100%控制"式套话，按"责任岗位+执行动作+量化标准+检查频次+整改时限"重写。',
      });
    } else if (chapterHits.length > 0) {
      issues.push({
        level: 'warning',
        severity: 'warning',
        message: `${chapter.title} 存在模板化空话：${chapterHits.join('、')}`,
        suggestion: '替换为具体量化做法；同一小节不得重复出现套话段落。',
      });
    }
  }
  return issues;
}

/** 套话句修复锚点：检测定位 = 修复定位；channel 标记命中通道，semantic 通道可进入确定性删除判定 */
export interface FillerSentenceTarget {
  chapterId?: string;
  chapterTitle: string;
  section: string;
  sentence: string;
  /** semantic=套话语义原型命中（0.80 校准阈值）；vague=模糊应答语义复核命中；
   * prefix=模板化前缀句词首确定性命中（D-T7 ①）；paragraph=废话段模式语义复核命中（D-T7 ③） */
  channel: 'semantic' | 'vague' | 'prefix' | 'paragraph';
}

/**
 * 套话句修复锚点提取：与检测器 fillerDensityReport（tenderBidChecks）同源判定——
 * 共享句池（buildFillerSentencePool 口径：过滤标题/表格/列表/引用/目录行，按。；; 切句，≥12 字）
 * + 共享句级判定器（judgeFillerSentences），逐句输出命中句原文（含小节定位与命中通道），
 * 供模板化修复闭环（globalQualityGates.repairTemplatingIssues）做锚点直连修复与确定性删除。
 * 检测定位 = 修复定位：命中句原文直接作为 repairChapterByQuality 的 anchorTexts，
 * 修复器不重新定位（历史缺陷：修复器在整章复述定位套话句 → patch 全部落空 → 套话占比永不收敛）。
 * 限幅：每章 12 句、全文 60 条（修复输入有界，防大文档锚点清单爆炸）。
 */
export async function fillerSentenceTargets(
  chapters: DocumentDraftChapter[],
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<FillerSentenceTarget[]> {
  const targets: FillerSentenceTarget[] = [];
  for (const chapter of chapters) {
    // 句池构建：与 fillerDensityReport 同口径（标题/表格/列表/引用/目录行不进句池），并记录每句所在小节用于定位
    const candidates: Array<{ sentence: string; section: string }> = [];
    let currentSection = chapter.title;
    for (const line of chapter.content.split('\n')) {
      const heading = /^#{3,4}\s+(.+)$/u.exec(line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').trim());
      if (heading) { currentSection = heading[1].trim(); continue; }
      if (isFillerPoolExcludedLine(line)) continue;
      for (const raw of line.split(/[。；;]/u)) {
        const sentence = raw.trim();
        if (sentence.length >= 12) candidates.push({ sentence, section: currentSection });
      }
    }
    if (candidates.length === 0) continue;
    const judgements = await judgeFillerSentences(candidates.map(item => item.sentence), embedDocuments);
    // D-T7 ③ 通道扩围：废话段模式语义 gate（与检测端 fillerParagraphIssues 同源原型与词面
    // 召回 buildFillerParagraphGate）命中的句子并入修复目标——检测（17 原型）与修复（14 原型）
    // 此前口径分叉，检测报出的「本小节围绕…展开」类模板句不在修复锚点集内（检测恒报、无人修）。
    const paragraphGate = await buildFillerParagraphGate(embedDocuments);
    const paragraphFlags = await paragraphGate(candidates.map(item => item.sentence));
    let chapterCount = 0;
    const seen = new Set<string>();
    for (let index = 0; index < judgements.length; index += 1) {
      const judgement = judgements[index];
      if ((!judgement.filler && !paragraphFlags[index]) || seen.has(judgement.sentence) || chapterCount >= 12) continue;
      seen.add(judgement.sentence);
      chapterCount += 1;
      const channel = judgement.semantic ? 'semantic' : judgement.vague ? 'vague' : 'paragraph';
      targets.push({ chapterId: chapter.id, chapterTitle: chapter.title, section: candidates[index].section, sentence: judgement.sentence, channel });
    }
    if (targets.length >= 60) break;
  }
  return targets.slice(0, 60);
}

/**
 * 模板化前缀句修复锚点提取（D-T7 ①，r28f #35 归因）：与 fillerSentenceTargets 同池范式
 * （逐行过滤 + H3/H4 小节定位 + ≥12 字句池），判定走 isTemplatePrefixSentence 词首确定性
 * 单源（检测端 formalStyleIssues 同源引用，检测定位 = 修复定位）。标题行跳过含零宽前缀形态
 * （行首剥零宽后仍以 # 开头即标题；防「1.2 主要施工内容」类标题残片被判前缀句误删）。
 * 限幅同 filler：每章 12 句、全文 60 条。
 */
export function templatePrefixTargets(chapters: DocumentDraftChapter[]): FillerSentenceTarget[] {
  const targets: FillerSentenceTarget[] = [];
  for (const chapter of chapters) {
    let currentSection = chapter.title;
    let chapterCount = 0;
    for (const line of chapter.content.split('\n')) {
      const heading = /^#{3,4}\s+(.+)$/u.exec(line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').trim());
      if (heading) { currentSection = heading[1].trim(); continue; }
      const compactLine = line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '');
      if (/^\s*#{1,6}\s/u.test(compactLine)) continue;
      if (isFillerPoolExcludedLine(line)) continue;
      for (const raw of line.split(/[。；;]/u)) {
        const sentence = raw.trim();
        if (sentence.length < 12 || !isTemplatePrefixSentence(sentence)) continue;
        if (chapterCount >= 12 || targets.length >= 60) break;
        chapterCount += 1;
        targets.push({ chapterId: chapter.id, chapterTitle: chapter.title, section: currentSection, sentence, channel: 'prefix' });
      }
      if (chapterCount >= 12 || targets.length >= 60) break;
    }
    if (targets.length >= 60) break;
  }
  return targets;
}

/** 确定性删除句在正文中的全部出现处：去尾标点 → 行内「前导空白+句+尾标点」全局替换，
 * 行尾无标点句按行尾匹配；仅处理非排除行（标题/表格行原样保留）；返回删除处数 */
function removeSentenceOccurrences(lines: string[], sentence: string): number {
  const core = sentence.replace(/[。；;]\s*$/u, '').trim();
  if (core.length < 12) return 0;
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const inlineRe = new RegExp(`[\\s\\u3000]*${escaped}[\\s\\u3000]*[。；;]`, 'gu');
  const tailRe = new RegExp(`[\\s\\u3000]*${escaped}[\\s\\u3000]*$`, 'u');
  let removed = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (isFillerPoolExcludedLine(line) || !line.includes(core)) continue;
    const matches = line.match(inlineRe);
    const replaced = matches && matches.length > 0 ? line.replace(inlineRe, '') : line.replace(tailRe, '');
    if (replaced === line) continue;
    removed += matches && matches.length > 0 ? matches.length : 1;
    if (replaced.trim() === '') lines.splice(index, 1);
    else lines[index] = replaced;
  }
  return removed;
}

/**
 * 零信息口号句确定性删除（C2 句级定点治理）：仅删除 semantic 通道且通过零信息硬闸
 * （isZeroInfoSloganSentence：无数字/岗位/频次/合规锚点）的命中句——删除零信息句是
 * 无损净化，不经过 LLM（历史负效果：LLM 批量改写误报句引入同义新空话）；
 * 其余命中句（vague 通道 / 含信息或合规承诺的 semantic 句）原样保留在 remaining，交 LLM 锚点具体化。
 * 幂等安全：句已不存在时删除数为 0，target 回填 remaining（不丢修复锚点）。
 * D-T7 通道扩展：semantic（套话原型）/prefix（模板化前缀句）/paragraph（废话段模式）
 * 三确定性通道 + 零信息硬闸即删；vague（模糊应答，语境依赖型）一律交 LLM 具体化。
 */
export function stripZeroInfoSloganSentences(
  chapters: DocumentDraftChapter[],
  targets: FillerSentenceTarget[],
): { deletedCount: number; deletedSentences: string[]; remaining: FillerSentenceTarget[] } {
  const deletedSentences: string[] = [];
  const remaining: FillerSentenceTarget[] = [];
  let deletedCount = 0;
  for (const target of targets) {
    const key = target.chapterId || target.chapterTitle;
    const chapter = chapters.find(item => (item.id || item.title) === key);
    const deletableChannel = target.channel === 'semantic' || target.channel === 'prefix' || target.channel === 'paragraph';
    if (!chapter || !deletableChannel || !isZeroInfoSloganSentence(target.sentence)) {
      remaining.push(target);
      continue;
    }
    const lines = chapter.content.split('\n');
    const removed = removeSentenceOccurrences(lines, target.sentence);
    if (removed > 0) {
      chapter.content = lines.join('\n').replace(/\n{3,}/gu, '\n\n');
      deletedCount += removed;
      if (!deletedSentences.includes(target.sentence)) deletedSentences.push(target.sentence);
    } else {
      remaining.push(target);
    }
  }
  return { deletedCount, deletedSentences, remaining };
}
export function processParameterDensityIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const blocks = extractSectionBlocks(chapter.content);
    for (const block of blocks) {
      const isWorkPackageSection = WORK_PACKAGE_SECTION_PATTERNS.some(pattern => pattern.test(block.heading) || pattern.test(chapter.title));
      if (!isWorkPackageSection) continue;
      // 管理程序型小节豁免（r17 丰乐镇归因）：「专项施工方案管理」类程序小节（编制/审批/交底/修订
      // 流程，载体是管理动作与检查闭环）被「施工方案」泛类模式误纳——按工作包要求 mm/MPa 工艺参数
      // 属语义错位；真作业方案小节（如「沟槽开挖专项施工方案」）不含程序词不受影响。
      if (/(?:方案管理|管理程序|管理流程|管理制度|审批流程)/u.test(block.heading)) continue;
      const processParams = new Set(block.body.match(PROCESS_PARAMETER_RE) || []);
      const basicFacts = new Set(block.body.match(BASIC_FACT_RE) || []);
      const deviceSpecs = new Set(block.body.match(DEVICE_SPEC_RE) || []);
      const bodyChars = block.body.length;
      if (bodyChars < 400) continue;
      const density = processParams.size / (bodyChars / 1000);
      // 拆除/清理/清底/运输类作业以工程量、作业边界与成品保护为核心控制点，参数载体为保护挑网宽度、警戒距离等 m 级安全参数；
      // 要求其 mm/MPa 级工艺参数既不符合专业实际，也会把合格的拆除方案误判为阻断项。
      const isDemolitionSection = /拆除|清理|清底|清运|弃置|运输|搬运/u.test(block.heading);
      if (processParams.size === 0) {
        // 设备清单型小节（如安装工程施工方案的配电箱配置）以型号/容量/等级参数为载体，不按工艺参数阻断
        if (deviceSpecs.size >= 6) {
          issues.push({
            level: 'warning',
            severity: 'warning',
            message: `${chapter.title} / ${block.heading} 以设备配置参数为主：设备型号/容量参数 ${deviceSpecs.size} 项，工艺参数待补充`,
            suggestion: '设备清单型小节保留型号规格参数即可；如补充安装工艺（试验压力、坡度、间距、偏差），应同步写入工艺参数与验收节点。',
          });
          continue;
        }
        if (isDemolitionSection) {
          issues.push({
            level: 'warning',
            severity: 'warning',
            message: `${chapter.title} / ${block.heading} 以工程量与保护措施为主，建议补充拆除深度偏差、保护挑网宽度、警戒距离等参数`,
            suggestion: '拆除类作业补充拆除厚度偏差（mm）、防护挑网/安全网宽度（m）、警戒区距离（m）等安全与技术参数即可，不强制 mm/MPa 级工艺参数。',
          });
          continue;
        }
        issues.push({
          level: 'error',
          severity: 'blocker',
          message: `${chapter.title} / ${block.heading} 无工艺参数：全文只有概况性数字，缺乏 mm/MPa/间距/偏差/试验压力等工艺级参数`,
          suggestion: '必须写入工艺参数（如桩位偏差≤50mm、搭接宽度≥100mm、闭水试验48h），参数来自绑定资料或行业规范值。',
        });
      } else if (density < (isDemolitionSection ? 0.3 : 1.5)) {
        issues.push({
          level: 'warning',
          severity: 'warning',
          message: `${chapter.title} / ${block.heading} 工艺参数密度偏低：每千字 ${processParams.size} 个工艺参数（概况数字 ${basicFacts.size} 个）`,
          suggestion: '增加工艺级参数落位；概况数字（面积、工期、层数）不能替代工艺参数。',
        });
      }
    }
  }
  return issues;
}

/** 4. 工作包内容要素完整性（作业对象与工程量/工序顺序/施工方法；呈现形式不限，标签不强制） */
export function sectionCardStructureIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    // 盲区根治：不再复用 extractSectionBlocks（其把 #### 子包行也切为新块，方案节 body 恒为空、
    // subPackages 恒为 []，本节检查从未真正生效——测试注释记录的已知缺陷）。
    // 直接按行解析：定位 ### 方案节标题 → 取到下一 H2/H3 为止的节 body → 节内切 #### 子包逐一检查
    const lines = chapter.content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!/^#{3}\s+[^\n]*(?:主要分部分项工程施工方案|主要施工方法)/u.test(line)) continue;
      let end = lines.length;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (/^#{2,3}\s+/u.test(lines[cursor].trim())) { end = cursor; break; }
      }
      const sectionBody = lines.slice(index + 1, end).join('\n');
      const subPackages = sectionBody.split(/^####\s+/gmu).slice(1).map(item => item.trim()).filter(Boolean);
      if (subPackages.length === 0) continue;
      // 三要素判定统一走 utils.workPackageContentElementsComplete（与结构门禁/专项验收同口径，
      // 历史缺陷：本处正则漏“作业对象|部位”“验收标准|检测”等词，自然成文块被误报要素缺失）
      const incomplete = subPackages.filter(pkg => !workPackageContentElementsComplete(pkg));
      if (incomplete.length > 0) {
        issues.push({
          // 4.18.6 要素不全由 warning 升级 blocker：与专项验收/结构门禁同口径硬拦截，
          // 缺任一要素的分项方案必须打回修复，不再直达交付（轮7 实测：要素不全块整包交付）
          level: 'error',
          severity: 'blocker',
          message: `${chapter.title} / ${line.replace(/^#{3}\s+(?:\d+(?:\.\d+)*\s+)?/u, '')} 有 ${incomplete.length}/${subPackages.length} 个分部分项内容要素不全（作业对象与工程量/工序顺序/施工方法至少缺一）`,
          suggestion: '每个分项方案需覆盖作业对象与工程量、工序安排、施工方法三方面要素，融入连贯段落叙述（禁止以“施工概况/工艺流程/施工方法”等结构标签充当标题或段落开头引导）；工序顺序表达须先后清晰（相邻小节不得同句式开头，同一句式全文不得反复使用，禁止以固定句模复读）。',
        });
      }
    }
  }
  return issues;
}

/** 5. 表格空字段检测 */
export function tableCompletenessIssues(chapters: DocumentDraftChapter[], markdown = ''): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const wholeText = markdown || chapters.map(chapter => chapter.content).join('\n\n');
  // 按行扫描表格块：连续两个以上以 | 开头的行视为一个表格
  const lines = wholeText.split('\n');
  let tableIndex = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!/^\|.+\|$/u.test(line)) {
      index += 1;
      continue;
    }
    const tableLines: string[] = [];
    while (index < lines.length && /^\|.+\|$/u.test(lines[index].trim())) {
      tableLines.push(lines[index].trim());
      index += 1;
    }
    if (tableLines.length < 3) continue;
    tableIndex += 1;
    const header = tableLines[0];
    const columnCount = header.split('|').length - 2;
    const bodyRows = tableLines.filter((row, rowIndex) => {
      if (rowIndex === 0) return false;
      const withoutBars = row.replace(/\|/gu, '').replace(/[\s\-:]/gu, '');
      return withoutBars.length > 0; // 跳过对齐分隔行
    });
    const emptyCellCount = bodyRows.reduce((total, row) => {
      const cells = row.split('|').slice(1, -1).map(cell => stripTableCellInvisibleChars(cell.trim()));
      return total + cells.filter(cell => cell === '' || cell === '-' || cell === '—' || cell === '/').length;
    }, 0);
    const totalCells = bodyRows.length * Math.max(1, columnCount);
    if (emptyCellCount > 0 && emptyCellCount / Math.max(1, totalCells) >= 0.4) {
      issues.push({
        level: 'warning',
        severity: 'warning',
        message: `第 ${tableIndex} 个表格存在 ${emptyCellCount} 个空单元格（${bodyRows.length} 行），表格信息不完整`,
        suggestion: '表格每一列都必须填写，缺失字段应从资料补齐；无法确认的字段应删除该行而非留空。',
      });
    }
    if (issues.length >= 5) break;
  }
  return issues;
}

/** 全部审计校验器聚合（异步：废话段检测走语义复核；招标硬性要求响应由 tenderRequirements 锚点级语义通道承担） */
export async function constructionOrgProfessionalAuditIssues(chapters: DocumentDraftChapter[], markdown = '', embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<ValidationIssue[]> {
  return [
    ...duplicateParagraphIssues(chapters),
    ...await fillerParagraphIssues(chapters, embedDocuments),
    ...processParameterDensityIssues(chapters),
    ...sectionCardStructureIssues(chapters),
    ...tableCompletenessIssues(chapters, markdown),
  ];
}
