/**
 * 模板化治理单源模块（结构标签 / 标题完整性 / 工序表达形式轮换 / 句式骨架指纹 / 句模聚类复读）。
 *
 * 背景（舒城模板实测）：分部分项章被「施工概况/施工流程/施工方法」三段标签链统治——
 * 段首标签 40 处、同名标签 H4 三组、箭头链 328 处、句式骨架 45/62/46 次、残缺小节名。
 * 治理原则：结构入后台、表达回前台——要素保留、形式释放、命名内容化。
 *
 * 检测定位（documentFinalValidation 终检注册）与修复定位（SURFACE_FIX_STEPS 确定性链 +
 * repairTemplatingIssues / repairChapterByQuality LLM 锚点修复）共用本模块原语，
 * 防「修复用一套正则、检测用另一套」的口径漂移。
 *
 * 模块依赖仅 utils（归一化与工序表达判定），不得反向引用写作/规划/修复侧模块（防环）。
 */
import type { ValidationIssue } from './types';
import { documentTextLength } from './budget';
import { hasProcessSequenceExpression, normalizeSubsectionTitleForDedup, WORK_PACKAGE_SECTION_RE } from './utils';

// ═══════════════════════════ 一、结构标签遏制 ═══════════════════════════

/**
 * 结构标签独立成题黑名单（整题归一化后匹配）：结构标签词只能是段落组织的
 * 历史写法遗物，不得充当小节标题。裸「施工概况/施工流程/施工方法/工艺流程」等
 * 独立成题即违规（正文要素本身合法，要的是融入连贯叙述、不得用标签形式承载）。
 *
 * 白名单保护（不命中的合法标题）：「工程概况」「施工部署」「施工组织」「质量控制」
 * 「施工准备」「主要工艺流程与施工顺序」等含前缀限定词的正式标题不受影响。
 */
export const STRUCTURAL_LABEL_TITLE_RE = /^(?:主要施工|施工)?(?:工艺流程|概况|概述|流程|工序|工艺|方法|方案|步骤|顺序|做法|安排|要点|内容)(?:要点|概述|简介|说明)?$/u;

/** 黑名单豁免：既有锚定小节名（criticalSectionAnchors 同源），命中正则但为专用章节保留 */
const STRUCTURAL_LABEL_TITLE_EXEMPT = new Set(['主要施工方法', '主要施工内容', '项目主要施工内容']);

/** 结构标签标题判定（检测器 / 确定性修复器 / 规划层双闸共用单一判定） */
export function isStructuralLabelTitle(rawTitle: string): boolean {
  const normalized = normalizeSubsectionTitleForDedup(rawTitle);
  if (!normalized) return false;
  if (STRUCTURAL_LABEL_TITLE_EXEMPT.has(normalized)) return false;
  return STRUCTURAL_LABEL_TITLE_RE.test(normalized);
}

/**
 * 正文行首结构标签前缀（「施工概况：本项目……」「**施工流程**：……」形态）：
 * 尾随冒号是标签引导的确定性信号（正文自然叙述不会以标签词+冒号行首开场）。
 */
export const STRUCTURE_LABEL_PREFIX_RE = /^(\s*(?:[-*•]\s+)?)\*{0,2}(?:施工概况|施工概述|施工流程|工艺流程|施工工艺|施工工序|施工方法|施工步骤|施工顺序|施工做法|施工安排|施工要点)\*{0,2}[：:]\s*/u;

/** 写作侧结构标签禁令（workflowRules / 任务卡 / 块写作提示词单源引用文案） */
export const STRUCTURE_LABEL_BAN_LINE = '正文禁止以“施工概况/施工流程/施工方法/工艺流程/施工步骤”等结构标签充当小节标题或段落开头引导（不得出现“施工概况：本项目……”式标签行），要素内容直接融入连贯段落叙述。';

/** 标签标题 / 段首标签前缀检测（终检注册：标签残留即 error，确定性修复器兜底） */
export function templatedLabelIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const headingSamples: string[] = [];
  let headingCount = 0;
  const prefixSamples: string[] = [];
  let prefixCount = 0;
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    // H3~H6 标签标题：H4~H6 由确定性修复器删标题行（保正文）；H3 报错交 LLM 修复重命名（防结构损毁）
    const heading = /^(#{3,6})\s+(.+?)\s*$/u.exec(trimmed);
    if (heading) {
      if (isStructuralLabelTitle(heading[2])) {
        headingCount += 1;
        if (headingSamples.length < 5) headingSamples.push(`${heading[1]} ${heading[2]}`);
      }
      continue;
    }
    if (STRUCTURE_LABEL_PREFIX_RE.test(rawLine)) {
      prefixCount += 1;
      if (prefixSamples.length < 5) prefixSamples.push(trimmed.slice(0, 24));
    }
  }
  if (headingCount > 0) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'structure',
      owner: 'system',
      repairability: 'local_deterministic',
      message: `正文存在结构标签充当小节标题 ${headingCount} 处：“${headingSamples.join('”、“')}”`,
      suggestion: '结构标签（施工概况/施工流程/施工方法/工艺流程等）不得独立成题；确定性修复器已接入删除标签标题行（正文保留），要素内容融入上级小节连贯叙述。',
    });
  }
  if (prefixCount > 0) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'structure',
      owner: 'system',
      repairability: 'local_deterministic',
      message: `正文段首结构标签前缀 ${prefixCount} 处：“${prefixSamples.join('”、“')}…”`,
      suggestion: '禁止“施工概况：……”“施工流程：……”式段首标签引导；确定性修复器已接入剥离标签前缀（正文保留），要素直接以连贯段落表述。',
    });
  }
  return issues;
}

/**
 * 结构标签确定性修复（SURFACE_FIX_STEPS 注册）：
 * 1) H4~H6 标签标题行删除（正文并入上级小节，形成连贯叙述）；
 * 2) 正文行首标签前缀剥离（保正文；剥离后为空的行删除）；
 * 3) 删除标题行时吞掉紧随的一个空行，防双空行残留；
 * 4) 正文孤立小节标题行删除（4.28.4 舒城实测：「#### 2.7.1 路基处理」标题下正文段落之后
 *    又出现独占一行的「路基处理」——写作 LLM 把小节名当内容输出；纯文字行归一化命中前文
 *    已现的小节标题即整行删除）。
 */
export function fixTemplatedLabels(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const lines = markdown.split(/\r?\n/u);
  const output: string[] = [];
  let removedHeadings = 0;
  let strippedPrefixes = 0;
  let removedTitleLeaks = 0;
  // 小节标题索引（H3~H6 归一化名 → 首现行号）：孤立标题泄漏行的判定基准
  const titleIndex = new Map<string, number>();
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{3,6})\s+(.+?)\s*$/u.exec(lines[index].trim());
    if (!heading) continue;
    const normalized = normalizeSubsectionTitleForDedup(heading[2]);
    if (normalized && !titleIndex.has(normalized)) titleIndex.set(normalized, index);
  }
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed) {
      output.push(raw);
      continue;
    }
    const heading = /^(#{4,6})\s+(.+?)\s*$/u.exec(trimmed);
    if (heading) {
      if (isStructuralLabelTitle(heading[2])) {
        removedHeadings += 1;
        // 吞掉紧随的一个空行（标题删除后正文直接并入上文）
        if (index + 1 < lines.length && lines[index + 1].trim() === '') index += 1;
        continue;
      }
      output.push(raw);
      continue;
    }
    if (/^#{1,6}\s/u.test(trimmed)) {
      output.push(raw);
      continue;
    }
    // 孤立标题泄漏行：纯文字行（无标点/空白/markdown 符号）归一化命中「先前已出现的小节标题」
    // → 该行是小节名被当正文输出（标题已存在），整行删除
    if (/^[\u4e00-\u9fa5A-Za-z0-9]{2,24}$/u.test(trimmed)) {
      const normalized = normalizeSubsectionTitleForDedup(trimmed);
      const headingLine = normalized ? titleIndex.get(normalized) : undefined;
      if (normalized && headingLine !== undefined && index > headingLine) {
        removedTitleLeaks += 1;
        // 前后均空行时吞掉尾随空行，防双空行残留
        if (index + 1 < lines.length && !lines[index + 1].trim() && output.length > 0 && !output[output.length - 1].trim()) index += 1;
        continue;
      }
    }
    const prefixMatch = STRUCTURE_LABEL_PREFIX_RE.exec(raw);
    if (prefixMatch) {
      const rest = raw.slice(prefixMatch[0].length);
      strippedPrefixes += 1;
      if (rest.trim()) output.push(rest);
      continue;
    }
    output.push(raw);
  }
  const fixedCount = removedHeadings + strippedPrefixes + removedTitleLeaks;
  if (fixedCount === 0) return { markdown, fixedCount: 0, details: [] };
  const details: string[] = [];
  if (removedHeadings > 0) details.push(`结构标签标题删除 ${removedHeadings} 行（正文保留）`);
  if (strippedPrefixes > 0) details.push(`段首标签前缀剥离 ${strippedPrefixes} 处`);
  if (removedTitleLeaks > 0) details.push(`正文孤立小节标题行删除 ${removedTitleLeaks} 行`);
  return { markdown: output.join('\n'), fixedCount, details };
}

// ═══════════════════════════ 二、工序表达形式轮换 ═══════════════════════════

/** 工序顺序表达四形式（写作侧按块 index 轮换指定；检测侧相邻块同形式即违规） */
export const FLOW_SEQUENCE_FORMS = ['顺序词叙述', '编号步骤', '有序列表', '箭头链'] as const;
export type FlowSequenceForm = (typeof FLOW_SEQUENCE_FORMS)[number];

/** 块序号 → 指定形式（相邻块天然不同：index%4 轮换） */
export function flowFormForBlockIndex(index: number): FlowSequenceForm {
  const size = FLOW_SEQUENCE_FORMS.length;
  return FLOW_SEQUENCE_FORMS[((index % size) + size) % size];
}

/** 形式环内下一个（检测建议与修复目标共用：保证与当前形式不同） */
export function nextFlowForm(form: FlowSequenceForm): FlowSequenceForm {
  const index = FLOW_SEQUENCE_FORMS.indexOf(form);
  return FLOW_SEQUENCE_FORMS[(index + 1) % FLOW_SEQUENCE_FORMS.length];
}

const FLOW_FORM_DIRECTIVES: Record<FlowSequenceForm, string> = {
  // C4 D7：去内容例句（「先……，再……，随后……，然后……，最后……」等示例被 LLM 直接当模板抄写，
  // 示例即模板化源头——与 SKELETON_FINGERPRINT_BAN_LINE 去示例同方针），只保留形式特征描述
  顺序词叙述: '用顺序词连贯叙述工序先后（衔接词按语境自然变化，不得与相邻小节复用同一连接词序列）',
  编号步骤: '用编号步骤分行列出工序（每行一个步骤，行首连续编号）',
  有序列表: '用要点列表分行列出工序（每行一个步骤，行首列表符）',
  箭头链: '用箭头链表达工序先后（工序元素按先后顺序用箭头连接）',
};

/**
 * 块写作工序表达形式指定（章生成块级角色上下文注入）：
 * 相邻块轮换不同形式，防全章通篇箭头链/单一形式的机械观感（舒城实测箭头链 328 处）。
 */
export function flowRotationDirective(index: number): string {
  const form = flowFormForBlockIndex(index);
  return `【工序顺序表达形式指定】本块的工序顺序表达使用「${form}」形式：${FLOW_FORM_DIRECTIVES[form]}；本章相邻小节已分别指定其他形式，禁止通篇使用同一形式，不得用“施工流程：”等结构标签引导。`;
}

/**
 * 工序表达形式分类计数：四形式各自的确定性出现计数（主导形式判定用）。
 * 与 utils.hasProcessSequenceExpression 的关系：后者判「有没有」，本函数判「以哪种为主」。
 */
export function classifyFlowForms(text: string): Record<FlowSequenceForm, number> {
  const arrow = (text.match(/→|->|=>/gu) || []).length;
  const numberedLines = (text.match(/(?:^|\n)\s*(?:\d+[.、)）]|[（(]\d+[）)]|[一二三四五六七八九十]{1,3}[、.]|第[一二三四五六七八九十]{1,3}步)/gu) || []).length;
  const bulletLines = (text.match(/(?:^|\n)\s*[-*•]\s+\S/gu) || []).length;
  // 顺序词连接符常被逗号分隔（「先测量放线，再沟槽开挖」），排除逗号会整体漏判 → primaryFlowForm 返回
  // undefined，相邻同形式检测钝化；禁跨句号/问叹号/换行防跨句误报，「后」兼容「先深后浅」式无逗号句式
  const sequence = (text.match(/先[^。；！？\n]{0,24}(?:再|然后|随后|接着|最后|后)|依次|先后|按[^。；！？\n]{0,12}顺序|顺序施工|流水施工/gu) || []).length;
  return {
    箭头链: arrow,
    编号步骤: numberedLines >= 2 ? numberedLines : 0,
    有序列表: bulletLines >= 2 ? bulletLines : 0,
    顺序词叙述: sequence,
  };
}

/** 块文本主导工序表达形式（无任何工序顺序表达返回 undefined；并列按 FLOW_SEQUENCE_FORMS 顺序取先者） */
export function primaryFlowForm(text: string): FlowSequenceForm | undefined {
  if (!hasProcessSequenceExpression(text)) return undefined;
  const counts = classifyFlowForms(text);
  let best: FlowSequenceForm | undefined;
  let bestCount = 0;
  for (const form of FLOW_SEQUENCE_FORMS) {
    if (counts[form] > bestCount) {
      best = form;
      bestCount = counts[form];
    }
  }
  return best;
}

/** 章节切片（与 headingDuplicateIssues / 句架检测同口径：## 分章） */
function chapterSlices(markdown: string): Array<{ title: string; body: string }> {
  return markdown.split(/^##\s+/gmu).slice(1).map(part => {
    const newline = part.indexOf('\n');
    return newline < 0
      ? { title: part.trim(), body: '' }
      : { title: part.slice(0, newline).trim(), body: part.slice(newline + 1) };
  });
}

/** H3 块切片（块标题 + 块正文，分部分项章内每 H3 一个分项块） */
function h3Blocks(body: string): Array<{ title: string; text: string }> {
  const blocks: Array<{ title: string; text: string }> = [];
  let current: { title: string; lines: string[] } | undefined;
  for (const line of body.split(/\r?\n/u)) {
    const heading = /^###\s+(.+?)\s*$/u.exec(line.trim());
    if (heading) {
      if (current) blocks.push({ title: current.title, text: current.lines.join('\n') });
      current = { title: heading[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push({ title: current.title, text: current.lines.join('\n') });
  return blocks;
}

/**
 * 分部分项章内相邻块工序表达形式重复检测（终检注册）：
 * 写作侧按 index%4 轮换指定形式，模型未遵守导致相邻块同形式（模板化观感）即 error，
 * 由 repairTemplatingIssues 扩展轮的块级锚点改写修复（flowFormRepairTargets 同源定位）。
 */
export function flowFormRepeatIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapterSlices(markdown)) {
    if (!WORK_PACKAGE_SECTION_RE.test(chapter.title)) continue;
    const blocks = h3Blocks(chapter.body);
    if (blocks.length < 2) continue;
    const forms = blocks.map(block => primaryFlowForm(block.text));
    for (let index = 1; index < blocks.length; index += 1) {
      const previous = forms[index - 1];
      const current = forms[index];
      if (!previous || !current || previous !== current) continue;
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'style',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `工序顺序表达形式模板化：「${chapter.title}」章相邻小节「${blocks[index - 1].title}」与「${blocks[index].title}」同为【${current}】形式`,
        suggestion: `将「${blocks[index].title}」的工序顺序表达改写为其他形式（建议【${nextFlowForm(current)}】），内容与数值保持不变；分项块之间必须轮换形式，禁止通篇同一形式。`,
      });
      if (issues.length >= 6) return issues;
    }
  }
  return issues;
}

/** 工序形式修复目标（repairTemplatingIssues 消费：块级定位 + 目标形式，检测建议与修复目标同源） */
export interface FlowFormRepairTarget {
  chapterTitle: string;
  blockTitle: string;
  currentForm: FlowSequenceForm;
  targetForm: FlowSequenceForm;
}

export function flowFormRepairTargets(markdown: string): FlowFormRepairTarget[] {
  const targets = new Map<string, FlowFormRepairTarget>();
  for (const chapter of chapterSlices(markdown)) {
    if (!WORK_PACKAGE_SECTION_RE.test(chapter.title)) continue;
    const blocks = h3Blocks(chapter.body);
    if (blocks.length < 2) continue;
    const forms = blocks.map(block => primaryFlowForm(block.text));
    for (let index = 1; index < blocks.length; index += 1) {
      const current = forms[index];
      if (!current || current !== forms[index - 1]) continue;
      const key = `${chapter.title}\u0000${blocks[index].title}`;
      if (!targets.has(key)) {
        targets.set(key, { chapterTitle: chapter.title, blockTitle: blocks[index].title, currentForm: current, targetForm: nextFlowForm(current) });
      }
    }
  }
  return [...targets.values()].slice(0, 12);
}

// ── 工序形式确定性轮换修复（round-2 链 / 终检前最后一道） ──

/** 分部分项章内 H3 块的带位置引用（行范围 [startLine, endLine)，endLine 为下一标题行或文末） */
interface FlowBlockRef {
  chapterTitle: string;
  title: string;
  text: string;
  startLine: number;
  endLine: number;
}

/** 收集分部分项章内 H3 块（检测 h3Blocks 同口径；修复器按行范围重写块正文用） */
function collectFlowBlockRefs(markdown: string): FlowBlockRef[] {
  const lines = markdown.split(/\r?\n/u);
  const refs: FlowBlockRef[] = [];
  let chapterTitle = '';
  let inScope = false;
  let current: { title: string; startLine: number } | undefined;
  const flush = (endLine: number) => {
    if (!current || !inScope) return;
    refs.push({ chapterTitle, title: current.title, text: lines.slice(current.startLine + 1, endLine).join('\n'), startLine: current.startLine, endLine });
    current = undefined;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const chapter = /^##\s+(.+?)\s*$/u.exec(lines[index]);
    if (chapter) {
      flush(index);
      chapterTitle = chapter[1];
      inScope = WORK_PACKAGE_SECTION_RE.test(chapterTitle);
      continue;
    }
    const block = /^###\s+(.+?)\s*$/u.exec(lines[index]);
    if (block) {
      flush(index);
      if (inScope) current = { title: block[1], startLine: index };
    }
  }
  flush(lines.length);
  return refs;
}

/** 序列句外框（先……最后……，句内匹配；「最后」后内容不含逗号防跨段误吃） */
const SEQUENCE_FRAME_RE = /先([^。；\n]{2,200}?)[，,、]\s*最后([^。；\n，,]{2,60}?)([。；])/gu;

/** 序列步骤分隔（连接词前须有分隔符；不把裸「后」当连接词——「、后浇带」类术语防误切） */
const SEQUENCE_STEP_SPLIT_RE = /[，,、]\s*(?:再|接着|随后|然后|继而)\s*/u;

/** 序列帧前缀边界（悬空前缀保护回溯锚：句界/分句界/冒号/换行——冒号紧邻「先」即合法引导语位） */
const SEQUENCE_PREFIX_BOUNDARY_RE = /[。；：！？\n]/u;

/** 顺序词叙述 → 编号步骤：序列句拆为编号行（连接词剥离，内容与数值逐字保留） */
function sequenceToNumberedSteps(text: string): string | undefined {
  let changed = false;
  const next = text.replace(SEQUENCE_FRAME_RE, (match, middle: string, last: string, tail: string, offset: number) => {
    // 悬空前缀保护（4.39 截断根因治理）：「先」嵌在句中时，转换会把前缀遗留为无标点悬空行尾
    // （「……水舌3个。施工先基层清理，再开孔，最后封堵。」→「……水舌3个。施工⏎1. …」，终检误判
    // 「句尾截断」）；回溯至最近句界，前缀非空一律放弃转换（零误伤，句子保持原样留待 LLM 改述）
    let cursor = offset;
    while (cursor > 0 && !SEQUENCE_PREFIX_BOUNDARY_RE.test(text[cursor - 1])) cursor -= 1;
    if (text.slice(cursor, offset).trim() !== '') return match;
    const steps = middle.split(SEQUENCE_STEP_SPLIT_RE).concat(last.split(SEQUENCE_STEP_SPLIT_RE)).map(part => part.trim()).filter(Boolean);
    if (steps.length < 3) return match;
    changed = true;
    const rows = steps.map((step, index) => `${index + 1}. ${step}${index === steps.length - 1 ? tail : '；'}`);
    return `\n${rows.join('\n')}`;
  });
  return changed ? next : undefined;
}

/** 箭头链匹配（元素不含箭头/标点/空白/引号/括号；链长 2~8 个元素） */
const ARROW_CHAIN_RE = /[^\s→，。；：、！？“”‘’《》〈〉（）\n]+(?:(?:→|->|=>)[^\s→，。；：、！？“”‘’《》〈〉（）\n]+){1,7}/gu;

/** 箭头链中间连接词（轮换用，防「然后」连续复读） */
const ARROW_JOINERS = ['再', '随后', '然后', '接着'] as const;

/** 箭头链 → 顺序词叙述：「A→B→C」→「先A，再B，最后C」（元素顺序与措辞逐字保留） */
function arrowsToSequentialWords(text: string): string | undefined {
  let changed = false;
  const next = text.replace(ARROW_CHAIN_RE, chain => {
    const parts = chain.split(/→|->|=>/u).map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) return chain;
    changed = true;
    if (parts.length === 2) return `先${parts[0]}，再${parts[1]}`;
    const middles = parts.slice(1, -1).map((part, index) => `${ARROW_JOINERS[index % ARROW_JOINERS.length]}${part}`);
    return `先${parts[0]}，${middles.join('，')}，最后${parts[parts.length - 1]}`;
  });
  return changed ? next : undefined;
}

/** 编号步骤 → 有序列表：行首编号标记换为 bullet（行结构与内容不动） */
function numberedToBullets(text: string): string | undefined {
  let changed = 0;
  const next = text.replace(/^(\s*)\d+[.、)）]\s+/gmu, (_match, indent: string) => {
    changed += 1;
    return `${indent}- `;
  });
  return changed >= 2 ? next : undefined;
}

/** 有序列表 → 箭头链：连续 bullet 行合并为单行箭头链（元素顺序与措辞逐字保留） */
function bulletsToArrows(text: string): string | undefined {
  const lines = text.split(/\r?\n/u);
  const output: string[] = [];
  let group: string[] = [];
  let changed = false;
  const flushGroup = () => {
    if (group.length >= 2) {
      const items = group.map(line => line.replace(/^[ \t]*[-*•]\s+/u, '').replace(/[；;，,。]$/u, '').trim()).filter(Boolean);
      if (items.length >= 2) {
        changed = true;
        output.push(items.join('→'));
        group = [];
        return;
      }
    }
    output.push(...group);
    group = [];
  };
  for (const line of lines) {
    if (/^[ \t]*[-*•]\s+\S/u.test(line)) group.push(line);
    else {
      flushGroup();
      output.push(line);
    }
  }
  flushGroup();
  return changed ? output.join('\n') : undefined;
}

/** 形式环内相邻转换（与 FLOW_SEQUENCE_FORMS 环一致）；转换后 primaryFlowForm 复检不达标即放弃（零误伤） */
function convertFlowFormText(text: string, from: FlowSequenceForm, to: FlowSequenceForm): string | undefined {
  let candidate: string | undefined;
  if (from === '顺序词叙述' && to === '编号步骤') candidate = sequenceToNumberedSteps(text);
  else if (from === '箭头链' && to === '顺序词叙述') candidate = arrowsToSequentialWords(text);
  else if (from === '编号步骤' && to === '有序列表') candidate = numberedToBullets(text);
  else if (from === '有序列表' && to === '箭头链') candidate = bulletsToArrows(text);
  if (!candidate || candidate === text) return undefined;
  return primaryFlowForm(candidate) === to ? candidate : undefined;
}

/** 工序形式确定性修复产出 */
export interface FlowFormFixOutcome {
  markdown: string;
  fixedCount: number;
  details: Array<{ chapterTitle: string; blockTitle: string; fromForm: FlowSequenceForm; toForm: FlowSequenceForm }>;
}

/**
 * 工序形式确定性轮换修复（round-2 链 / 终检前最后一道）：
 * 写作侧按 index%4 轮换指定形式，但评审轮 LLM 改写可能重新引入相邻同形式
 * （templating-repair 曾清零、后续评审轮复发），此修复器兜底收敛：
 * 顺扫将同形式对的后块转到环内下一形式（顺序词→编号步骤、箭头链→顺序词等，内容与数值逐字保留）；
 * 后块不可转时回溯转前块（避让前后邻居形式）；每步转换后 primaryFlowForm 复检，不达标即放弃该块。
 * 每块至多转换一次，未收敛残留由收口报告可见，不静默。
 */
export function fixFlowFormRepetition(markdown: string): FlowFormFixOutcome {
  const blocks = collectFlowBlockRefs(markdown);
  if (blocks.length < 2) return { markdown, fixedCount: 0, details: [] };
  // 按章切连续段（同名章不跨段合并）
  const groups: FlowBlockRef[][] = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (last && last[0].chapterTitle === block.chapterTitle) last.push(block);
    else groups.push([block]);
  }
  const conversions = new Map<FlowBlockRef, { text: string; fromForm: FlowSequenceForm; toForm: FlowSequenceForm }>();
  for (const group of groups) {
    const resolved: Array<FlowSequenceForm | undefined> = group.map(block => primaryFlowForm(block.text));
    // 顺扫：同形式对的后块转环内下一形式（级联处理转换后与前块的新重复）
    for (let index = 1; index < group.length; index += 1) {
      const current = resolved[index];
      const previousForm = resolved[index - 1];
      if (!current || current !== previousForm) continue;
      const target = nextFlowForm(current);
      const converted = convertFlowFormText(group[index].text, current, target);
      if (!converted) continue;
      conversions.set(group[index], { text: converted, fromForm: current, toForm: target });
      resolved[index] = target;
    }
    // 回溯：后块不可转的同形式对，转前块（须与前后邻居都不同）
    for (let index = 1; index < group.length; index += 1) {
      const current = resolved[index];
      const previousForm = resolved[index - 1];
      if (!current || !previousForm || current !== previousForm) continue;
      const previousBlock = group[index - 1];
      if (conversions.has(previousBlock)) continue;
      const target = nextFlowForm(previousForm);
      if (index >= 2 && resolved[index - 2] === target) continue;
      const converted = convertFlowFormText(previousBlock.text, previousForm, target);
      if (!converted) continue;
      conversions.set(previousBlock, { text: converted, fromForm: previousForm, toForm: target });
      resolved[index - 1] = target;
    }
  }
  if (conversions.size === 0) return { markdown, fixedCount: 0, details: [] };
  // 从后往前按行范围重写块正文（行数增减不影响前面块的索引）
  const lines = markdown.split(/\r?\n/u);
  const details: FlowFormFixOutcome['details'] = [];
  const ordered = [...conversions.entries()].sort((left, right) => right[0].startLine - left[0].startLine);
  for (const [block, conversion] of ordered) {
    lines.splice(block.startLine + 1, block.endLine - block.startLine - 1, ...conversion.text.split('\n'));
    details.push({ chapterTitle: block.chapterTitle, blockTitle: block.title, fromForm: conversion.fromForm, toForm: conversion.toForm });
  }
  return { markdown: lines.join('\n'), fixedCount: details.length, details };
}

// ═══════════════════════════ 三、句式骨架指纹 ═══════════════════════════

/**
 * 句式骨架指纹库（验收口径单源）：舒城验收表实测的高频复读骨架——
 * 「由技术负责人组织」45 次、「合格后方可」62 次、「验收合格后」46 次（全文精确计数），
 * 验收标准「每条骨架全文 ≤2 次」。
 *
 * 历史缺陷修正：首版把指纹泛化为「由××岗位 / ××合格后」五家族正则（同章 ≥3 处即报），
 * 在施组体裁中严重误伤——「由安全员检查临边防护」类实体句被当成空壳套话（舒城实测单章
 * 家族命中 130 处、空壳 0 处），且修复目标量级（每家族 4 句）与检测量级不可收敛。
 * 现按验收表原义收敛：逐字短语弹性匹配（空白容错）、全文精确计数、>2 即报。
 *
 * 4.40 d5e 根治（变体复读盲区）：写作卡/修复建议曾附「同义表达示例」，LLM 集中抄写示例——
 * 4.39 舒城实测「技术负责人牵头组织」37 处、「合格后再行」28 处、「验收通过后」17 处，
 * 基准字形全部 ≤2 的表象达标下藏着新套话（「换皮复读」零检测零治理）。现按族治理：
 * 每族声明合规变体形态池（variant form），任一变体形态全篇 > SKELETON_VARIANT_CAP 即复读；
 * 确定性兜底按形态池做负载均衡同构改写（删除冗余虚词/动词短语级同义替换，语法安全单测锁定）；
 * 示例文案全部从写作卡与修复建议中删除（示例即模板化源头，不再向 LLM 暴露具体变体）。
 */
export interface SkeletonFingerprint {
  id: string;
  /** 指纹原文（展示与计数基准，与验收表逐字一致） */
  text: string;
  /** 弹性匹配正则（空白容错；检测 / 修复 / 验收计数同源） */
  pattern: RegExp;
  /** 变体形态池（4.40 d5e：合规同义表达的单形态基准 + 弹性匹配 + 超量时的同构安全改写；
   * 前缀「由/项目」归一同形态——「由技术负责人牵头组织」与「技术负责人牵头组织」是一种表达） */
  variantForms: readonly SkeletonVariantForm[];
}

/** 骨架变体形态（4.40 d5e）：同义表达的一种合规字形——检测计数与确定性改写共用单源 */
export interface SkeletonVariantForm {
  /** 形态基准字形（展示与计数基准） */
  text: string;
  /** 弹性匹配正则（空白容错；检测 / 修复 / 验收计数同源） */
  pattern: RegExp;
  /** 本形态超量时的确定性同构改写（命中片段内短语替换）：
   * from 只匹配可安全替换的虚词/动词短语位，to 为同义目标（空串 = 删除冗余虚词）；
   * 语法安全性由单测按舒城实测句锁定（替换后句子仍通顺、事实不变） */
  rewrites: readonly SkeletonVariantRewrite[];
}

export interface SkeletonVariantRewrite {
  from: RegExp;
  to: string;
}

export const SKELETON_FINGERPRINTS: readonly SkeletonFingerprint[] = [
  {
    id: 'by-tech-lead-org',
    text: '由技术负责人组织',
    pattern: /由\s*技术负责人\s*组织/gu,
    variantForms: [
      {
        text: '技术负责人牵头组织',
        pattern: /(?:由\s*)?(?:项目\s*部?\s*)?技术负责人\s*牵头\s*组织/gu,
        rewrites: [
          { from: /牵头\s*组织/u, to: '负责组织' },
          { from: /牵头\s*组织/u, to: '统筹组织' },
          { from: /牵头\s*组织/u, to: '组织' },
          { from: /牵头\s*组织/u, to: '统一组织' },
          { from: /牵头\s*组织/u, to: '直接组织' },
        ],
      },
      {
        text: '技术负责人负责组织',
        pattern: /(?:由\s*)?(?:项目\s*部?\s*)?技术负责人\s*负责\s*组织/gu,
        rewrites: [
          { from: /负责\s*组织/u, to: '统筹组织' },
          { from: /负责\s*组织/u, to: '组织' },
        ],
      },
      {
        text: '技术负责人统筹组织',
        pattern: /(?:由\s*)?(?:项目\s*部?\s*)?技术负责人\s*统筹\s*组织/gu,
        rewrites: [
          { from: /统筹\s*组织/u, to: '组织' },
          { from: /统筹\s*组织/u, to: '负责组织' },
        ],
      },
      {
        text: '技术负责人统一组织',
        pattern: /(?:由\s*)?(?:项目\s*部?\s*)?技术负责人\s*统一\s*组织/gu,
        rewrites: [
          { from: /统一\s*组织/u, to: '组织' },
          { from: /统一\s*组织/u, to: '直接组织' },
        ],
      },
      {
        text: '技术负责人直接组织',
        pattern: /(?:由\s*)?(?:项目\s*部?\s*)?技术负责人\s*直接\s*组织/gu,
        rewrites: [{ from: /直接\s*组织/u, to: '组织' }],
      },
      {
        text: '技术负责人组织',
        pattern: /(?:项目\s*部?\s*)?技术负责人\s*组织/gu,
        rewrites: [
          { from: /负责人\s*组织/u, to: '负责人负责组织' },
          { from: /负责人\s*组织/u, to: '负责人统筹组织' },
        ],
      },
    ],
  },
  {
    id: 'post-qualified',
    text: '合格后方可',
    pattern: /合格\s*后方可/gu,
    variantForms: [
      {
        text: '合格后再行',
        pattern: /合格\s*后再行/gu,
        rewrites: [{ from: /再行/u, to: '' }],
      },
      {
        text: '合格后方能',
        pattern: /合格\s*后方能/gu,
        rewrites: [{ from: /方能/u, to: '' }],
      },
      {
        text: '合格后才可',
        pattern: /合格\s*后才可/gu,
        rewrites: [{ from: /才可/u, to: '' }],
      },
      {
        text: '合格以后方可',
        pattern: /合格\s*以后方可/gu,
        rewrites: [{ from: /以后/u, to: '' }],
      },
    ],
  },
  {
    id: 'after-acceptance',
    text: '验收合格后',
    pattern: /验收\s*合格\s*后/gu,
    variantForms: [
      {
        text: '验收通过后',
        pattern: /验收\s*通过后/gu,
        rewrites: [
          { from: /验收\s*通过后/u, to: '通过验收后' },
          { from: /验收\s*通过后/u, to: '验收签认后' },
          { from: /验收\s*通过后/u, to: '验收确认后' },
        ],
      },
      {
        text: '通过验收后',
        pattern: /通过\s*验收后/gu,
        rewrites: [{ from: /通过\s*验收后/u, to: '验收签认后' }],
      },
      {
        text: '验收签认后',
        pattern: /验收\s*签认后/gu,
        rewrites: [{ from: /验收\s*签认后/u, to: '验收确认后' }],
      },
      {
        text: '验收确认后',
        pattern: /验收\s*确认后/gu,
        rewrites: [{ from: /验收\s*确认后/u, to: '验收签认后' }],
      },
    ],
  },
];

/** 每条骨架指纹全文出现上限（验收表口径：每条骨架全文 ≤2 次） */
export const SKELETON_FINGERPRINT_CAP = 2;

/** 变体形态单形态全文上限（4.40 d5e：基准线的 4 倍——同义变体允许更宽，但天花板防「换皮复读」；
 * 4.39 舒城实测 37/28/17 次集中单形态全部落入本线的拦截范围） */
export const SKELETON_VARIANT_CAP = 8;

/** 写作侧骨架指纹禁令（写作卡 / 任务卡注入文案单源）：
 * 4.40 d5e 去示例——历史缺陷：禁令曾附「如“技术负责人牵头组织”…」示例，LLM 把示例当模板
 * 全篇复制（舒城 4.39 实测 37 处），示例即模板化源头，方针化表述不暴露具体变体 */
export const SKELETON_FINGERPRINT_BAN_LINE = '句式禁止复读：全篇「由技术负责人组织」「合格后方可」「验收合格后」三类骨架表述各自不得超过 2 次，任何同义替换表达全篇不得超过 8 次；同义表达必须逐句轮换、句式多样（动词与语序随句变化），不得集中复用同一说法，保持事实不变（岗位、数值、频次不得丢失）。';

/** 骨架指纹全文计数（弹性空白匹配；检测 / 修复复扫 / 验收统计同源） */
export function countSkeletonFingerprint(markdown: string, fingerprint: SkeletonFingerprint): number {
  return [...markdown.matchAll(fingerprint.pattern)].length;
}

/** 命中句扩展为完整句（向前后找句界，修复锚点需完整句原文） */
function sentenceAround(text: string, start: number, end: number): string {
  let left = start;
  while (left > 0 && !/[。！？\n]/u.test(text[left - 1])) left -= 1;
  let right = end;
  while (right < text.length && !/[。！？\n]/u.test(text[right])) right += 1;
  if (right < text.length && /[。！？]/u.test(text[right])) right += 1;
  return text.slice(left, right).trim();
}

/** 骨架族治理形态（基准 + 变体形态统一视图：同一框架下检测上限与同构改写候选） */
interface SkeletonGovernanceForm {
  form: SkeletonVariantForm;
  cap: number;
}

/** 族治理形态表：基准字形（改写候选 = 各变体形态字形）+ 变体形态（改写候选 = 自身 rewrites） */
function governanceFormsOf(fingerprint: SkeletonFingerprint): SkeletonGovernanceForm[] {
  return [
    {
      form: {
        text: fingerprint.text,
        pattern: fingerprint.pattern,
        rewrites: fingerprint.variantForms.map(variant => ({ from: fingerprint.pattern, to: variant.text })),
      },
      cap: SKELETON_FINGERPRINT_CAP,
    },
    ...fingerprint.variantForms.map(form => ({ form, cap: SKELETON_VARIANT_CAP })),
  ];
}

/**
 * 骨架指纹复读检测（终检注册）：
 * ① 基准字形全篇 >2 处即 blocker（验收表口径「每条骨架全文 ≤2 次」）；
 * ② 4.40 d5e 变体形态全篇 > SKELETON_VARIANT_CAP 即 blocker（示例变体被 LLM 集中抄写实锤：
 *   舒城 4.39「技术负责人牵头组织」37 处、「合格后再行」28 处、「验收通过后」17 处——
 *   基准字形 ≤2 的表象达标不算治理完成，同义替换单形态集中复用即「换皮复读」）；
 * round-2 确定性修复器 fixSkeletonFingerprintRepetition 按形态池负载均衡兜底收敛。
 * 修复建议不再附具体同义示例（示例即模板化源头，历史缺陷）。
 */
export function skeletonFingerprintIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const fingerprint of SKELETON_FINGERPRINTS) {
    const count = countSkeletonFingerprint(markdown, fingerprint);
    if (count > SKELETON_FINGERPRINT_CAP) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'style',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `句式骨架复读：「${fingerprint.text}」全篇出现 ${count} 处（上限 ${SKELETON_FINGERPRINT_CAP} 处）——模板化复用句式`,
        suggestion: `保留全文前 ${SKELETON_FINGERPRINT_CAP} 处「${fingerprint.text}」，其余处逐句改用不同句式（同义表达须逐句轮换，不得集中复用同一替换说法）；改写保留原句全部事实信息（岗位、数值、频次不得丢失），不得用结构标签或固定套语替代。`,
      });
    }
    for (const variant of fingerprint.variantForms) {
      const variantCount = [...markdown.matchAll(variant.pattern)].length;
      if (variantCount <= SKELETON_VARIANT_CAP) continue;
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'style',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `句式变体复读：「${variant.text}」全篇出现 ${variantCount} 处（同义表达单形态上限 ${SKELETON_VARIANT_CAP} 处）——同义替换被集中复用`,
        suggestion: `保留全文前 ${SKELETON_VARIANT_CAP} 处，其余处逐句改用不同句式（替换动词、调整语序或换用其他同义表达），不得继续复用同一替换表达；改写保留原句全部事实信息（岗位、数值、频次不得丢失）。`,
      });
    }
  }
  return issues;
}

/** 骨架指纹修复目标（repairTemplatingIssues 消费：按章聚合超量命中句；全文口径超出保留额度 cap 后，每章每形态至多 4 句） */
export interface SkeletonFingerprintRepairTarget {
  chapterTitle: string;
  fingerprintLabel: string;
  /** 本形态全文保留额度（验收上限：基准字形 2 / 变体形态 8） */
  cap: number;
  /** 全篇出现总次数（prompt 供 LLM 了解治理总量级） */
  totalCount: number;
  sentences: string[];
}

export function skeletonFingerprintRepairTargets(markdown: string): SkeletonFingerprintRepairTarget[] {
  const targets: SkeletonFingerprintRepairTarget[] = [];
  const chapters = chapterSlices(markdown);
  for (const fingerprint of SKELETON_FINGERPRINTS) {
    for (const { form, cap } of governanceFormsOf(fingerprint)) {
      const total = [...markdown.matchAll(form.pattern)].length;
      if (total <= cap) continue;
      const byChapter = new Map<string, string[]>();
      for (const chapter of chapters) {
        if (!chapter.body) continue;
        for (const match of chapter.body.matchAll(form.pattern)) {
          const start = match.index ?? 0;
          const sentence = sentenceAround(chapter.body, start, start + match[0].length);
          if (sentence.length < 6) continue;
          const list = byChapter.get(chapter.title) ?? [];
          if (!list.includes(sentence)) list.push(sentence);
          byChapter.set(chapter.title, list);
        }
      }
      // 全文保留额度 cap 处：按章序打平消耗，其余为超量修复目标（每章至多 4 句进锚点修复）
      let keepQuota = cap;
      for (const [chapterTitle, sentences] of byChapter) {
        const overflow = sentences.slice(keepQuota).slice(0, 4);
        keepQuota = Math.max(0, keepQuota - sentences.length);
        if (overflow.length > 0) targets.push({ chapterTitle, fingerprintLabel: form.text, cap, totalCount: total, sentences: overflow });
      }
    }
  }
  // 上限 24（4.40 d5e：变体形态纳入治理后组数扩大——3 族最多 3×(基准+6 变体) 形态×多章）
  return targets.slice(0, 24);
}

/** 骨架指纹确定性修复产出 */
export interface SkeletonFingerprintFixOutcome {
  markdown: string;
  fixedCount: number;
  details: Array<{ id: string; replaced: number }>;
}

/**
 * 骨架指纹确定性兜底（round-2 链 / 终检前最后一道，4.40 d5e 族级升级）：
 * 基准字形保留全文前 2 处，变体形态保留前 8 处，其余按「形态池负载均衡」同构改写：
 * 候选改写只落在可安全替换的虚词/动词短语位（删除冗余虚词或动词同义替换，语法安全性单测锁定）；
 * 候选按目标形态当前计数取最闲者（min-max 均衡），防「换皮复读」（旧实现固定轮换变体池，
 * 舒城 4.39 实测示例变体被集中抄写 37/28/17 处而兜底零感知）。
 * 每轮重扫全族计数（重叠形态自然校准）；替换使源形态计数单调下降 → 有限轮次收敛。
 */
export function fixSkeletonFingerprintRepetition(markdown: string): SkeletonFingerprintFixOutcome {
  let next = markdown;
  let fixedCount = 0;
  const details: Array<{ id: string; replaced: number }> = [];
  for (const fingerprint of SKELETON_FINGERPRINTS) {
    const forms = governanceFormsOf(fingerprint);
    let replaced = 0;
    // guard 上限 = 单族最大可能替换量（形熊池容量有限，收敛单调）
    for (let guard = 0; guard < 600; guard += 1) {
      const scans = forms.map(item => [...next.matchAll(item.form.pattern)]);
      const counts = scans.map(list => list.length);
      const overflowIndex = counts.findIndex((count, index) => count > forms[index].cap);
      if (overflowIndex < 0) break;
      const source = forms[overflowIndex];
      const overflow = scans[overflowIndex][source.cap];
      if (!overflow) break;
      const start = overflow.index ?? 0;
      const matched = overflow[0];
      let best: { candidate: string; pressure: number } | undefined;
      for (const rewrite of source.form.rewrites) {
        const replacement = matched.replace(rewrite.from, rewrite.to);
        if (!replacement || replacement === matched) continue;
        const candidate = next.slice(0, start) + replacement + next.slice(start + matched.length);
        if (candidate === next) continue;
        // 压力 = 替换后命中形态（含重叠）中的最大当前计数（0 = 零压力改写，如删除冗余虚词）
        const hitCounts = forms.flatMap((item, index) => ([...replacement.matchAll(item.form.pattern)].length > 0 ? [counts[index]] : []));
        const pressure = hitCounts.length > 0 ? Math.max(...hitCounts) : 0;
        if (!best || pressure < best.pressure) best = { candidate, pressure };
      }
      if (!best) break;
      next = best.candidate;
      replaced += 1;
    }
    if (replaced > 0) {
      details.push({ id: fingerprint.id, replaced });
      fixedCount += replaced;
    }
  }
  return { markdown: next, fixedCount, details };
}

// ═══════════════════════════ 三·五、句模聚类复读（C4：D3 检测器扩面） ═══════════════════════════

/**
 * 句模族定义（句式结构帧级，与骨架指纹族互补：骨架指纹=词面焦点族（3 组定位词），
 * 句模=过程句结构帧）。历史缺陷（C4-1 实测）：fillerDensityReport 语义原型只抓
 * 「无信息套话」，结构完整的同句式复读在语义原型下判非套话——r28l/s28l 实测
 * 「先…再…随后…然后…最后」多段链 13/47 句、「并形成记录闭环」11/28 句，filler 高分
 * 与用户实读复读矛盾；flowFormRepeatIssues 只查相邻块同形式、skeletonFingerprint 只覆盖
 * 3 族词面，均不覆盖句模级复读（D3）。
 */
export interface SentencePatternFamily {
  id: string;
  label: string;
  /** 句级结构帧判定（同一句命中多次只计一次；以「结构帧+连接词共现」为界，不按词面单点） */
  test: (sentence: string) => boolean;
}

/** 顺序连接词表（句模族共享：序列链判定的连接词共现计数） */
const SEQUENCE_CONNECTIVES = ['再', '接着', '随后', '然后', '继而', '最后', '而后'] as const;

/**
 * 句模族表（P3 item 11：结构帧聚类——「先…再…随后…然后…最后」「完成…后，进行…」
 * 「…合格后，进入下道工序」「采用…，…，…；…并形成记录闭环」等）。判定均为结构帧
 * （连接词共现/从句帧 + 后续承接动作），与项目专名无关（通用性红线）；新增族在此登记即
 * 全链生效（检测/修复目标/评分/复检同源消费）。
 * C4-1 实机校准（r28l/s28l 探针）：sequence-chain 以「先/首先 + ≥3 连接词」（先…再…随后…最后
 * 完整链，探针 F1e 口径：全文 13/47 句）为界；仅 2 连接词的短链（先…再…最后）不计数，防误伤；
 * 句首聚类实测的宣告式复读（「施工按以下顺序组织：」×6、「工序按编号步骤组织：」×7）
 * 另设 form-announcement 族。
 */
export const SENTENCE_PATTERN_FAMILIES: SentencePatternFamily[] = [
  {
    id: 'sequence-chain',
    label: '多段顺序词链（先…再…随后/然后…最后）',
    test: sentence => /先|首先/u.test(sentence) && SEQUENCE_CONNECTIVES.filter(word => sentence.includes(word)).length >= 3,
  },
  {
    id: 'after-completion-action',
    label: '完成即转入式（完成/结束…后，进行/开展…）',
    test: sentence => /(?:完成|完毕|结束|完工)[^。！？\n]{0,40}?后\s*[，,、]?\s*(?:进行|开展|实施|开始|转入|安排|及时|组织)/u.test(sentence),
  },
  {
    id: 'acceptance-next-step',
    label: '验收衔接式（…合格后，方可/进入下道工序）',
    test: sentence => /(?:合格|通过验收|验收通过|签认)[^。！？\n]{0,16}?后\s*[，,、]?\s*(?:方可|才能|进入|转入|进行|开始|实施|组织)/u.test(sentence),
  },
  {
    id: 'closed-loop-record',
    label: '资料闭环式（…并形成记录/资料闭环）',
    test: sentence => /(?:并)?形成[^。！？\n]{0,24}?(?:记录|资料|台账|档案|影像)(?:闭环|闭合|归档|备查)/u.test(sentence),
  },
  {
    id: 'form-announcement',
    label: '形式宣告式（施工/工序按顺序/编号步骤…组织：）',
    test: sentence => /(?:施工|工序|流程|作业|操作)[^。！？\n]{0,14}?(?:按|依)(?:以下|下列)?[^。！？\n]{0,40}?(?:顺序|步骤|编号|次序)[^。！？\n]{0,12}?(?:组织|展开|安排|排列)/u.test(sentence),
  },
];

/** 同模式句复读命中线底线（短文档/小样本口径；长文经 sentencePatternThreshold 按正文字数密度上浮） */
export const SENTENCE_PATTERN_MIN_REPEATS = 6;

/**
 * 句模复读命中线（C8 S3② 密度归一，P3 口径校准）：绝对计数 6 于长文误伤自然语式
 * （r28m' 6.5 万字 form-announcement 8 处判误报 vs s28m' 21 万字 46 处判真复读）——
 * 命中线按正文字数密度上浮：max(6, ceil(documentTextLength/5000))（=2.0 处/万字）。
 * 校准锚点：r28m'（1.23/万，自然语式）应通过、s28m' 修复前（2.20/万，真复读）应命中、
 * S3① 引导句确定性剥离后残留（1.82/万）应通过。检测/修复目标/评分/复检四端单源消费。
 */
export function sentencePatternThreshold(markdown: string): number {
  return Math.max(SENTENCE_PATTERN_MIN_REPEATS, Math.ceil(documentTextLength(markdown) / 5000));
}

/** 句池（markdown 级单源）：剔除标题行/表格行，按 。！？ 切句（保分号链完整——顺序词链常跨分号），
 * 剥条目编号/列表符前缀，≥8 字。检测/修复目标/复检三端同源引用（防口径漂移）。 */
function sentencePoolOf(markdown: string): string[] {
  const sentences: string[] = [];
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').trim();
    if (!line || /^#{1,6}\s/u.test(line) || line.startsWith('|')) continue;
    const body = line.replace(/^(?:\d+(?:\.\d+)*[.、)）]|[-*•])\s*/u, '');
    for (const part of body.split(/(?<=[。！？])/u)) {
      const sentence = part.trim();
      if (sentence.length >= 8) sentences.push(sentence);
    }
  }
  return sentences;
}

/** 单族全文命中计数（检测/复检/报告同源口径） */
export function countSentencePatternHits(markdown: string, family: SentencePatternFamily): number {
  return sentencePoolOf(markdown).filter(family.test).length;
}

/**
 * 句模复读检测（终检注册）：任一结构帧全篇命中数 ≥ 密度阈值即 error/blocker——同模式句重复即模板
 * 化观感（句内事实可核查，但与 filler 语义概念正交，属独立治理维度；阈值口径见 sentencePatternThreshold）。
 */
export function sentencePatternRepeatIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const pool = sentencePoolOf(markdown);
  const threshold = sentencePatternThreshold(markdown);
  for (const family of SENTENCE_PATTERN_FAMILIES) {
    const count = pool.filter(family.test).length;
    if (count < threshold) continue;
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'style',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `句式模版复读：「${family.label}」全篇出现 ${count} 处（复读命中线 ${threshold} 处）——同模式句重复，模板化观感`,
      suggestion: `保留全文前 ${threshold - 1} 处，其余处逐句改写为自然多样表达（变换句式结构与连接方式，或拆分为多句；各句改写方向须彼此不同，不得集中复用同一替换句式）；改写保留原句全部工序顺序、数值与验收事实，不得删减工艺参数。`,
    });
  }
  return issues;
}

/** 句模复读修复目标（repairTemplatingIssues 消费：按章聚合超量命中句，保留额度按章序消耗，每章每族至多 4 句） */
export interface SentencePatternRepairTarget {
  chapterTitle: string;
  patternId: string;
  patternLabel: string;
  /** 全篇命中总数（prompt 供 LLM 了解治理量级） */
  totalCount: number;
  /** 全篇保留额度（复读命中线前 N-1 处） */
  cap: number;
  sentences: string[];
}

export function sentencePatternRepairTargets(markdown: string): SentencePatternRepairTarget[] {
  const targets: SentencePatternRepairTarget[] = [];
  const chapters = chapterSlices(markdown);
  const pool = sentencePoolOf(markdown);
  const threshold = sentencePatternThreshold(markdown);
  // 跨族去重：同一句只进最先命中的族（族表顺序即优先级），防同句双锚点重复改写
  const assigned = new Set<string>();
  for (const family of SENTENCE_PATTERN_FAMILIES) {
    const total = pool.filter(family.test).length;
    if (total < threshold) continue;
    const cap = threshold - 1;
    const byChapter = new Map<string, string[]>();
    for (const chapter of chapters) {
      if (!chapter.body) continue;
      const list: string[] = [];
      for (const sentence of sentencePoolOf(chapter.body)) {
        if (assigned.has(sentence) || !family.test(sentence) || list.includes(sentence)) continue;
        list.push(sentence);
      }
      if (list.length > 0) byChapter.set(chapter.title, list);
    }
    let keepQuota = cap;
    for (const [chapterTitle, sentences] of byChapter) {
      const overflow = sentences.slice(keepQuota).slice(0, 4);
      keepQuota = Math.max(0, keepQuota - sentences.length);
      if (overflow.length > 0) {
        overflow.forEach(sentence => assigned.add(sentence));
        targets.push({ chapterTitle, patternId: family.id, patternLabel: family.label, totalCount: total, cap, sentences: overflow });
      }
    }
  }
  return targets.slice(0, 16);
}

/**
 * 句模宣告引导句确定性剥离（C8 S3①：链尾 markdown-only 收口区消费，零 LLM）——判定与句池
 * form-announcement 族单源（检测定位=修复定位）：行内最后一句命中该族且以「：」结尾
 *（「施工按以下顺序组织：」+ 列表的引导语；列表自承载全部信息，删除无损——s28m' 终稿
 * 46 处族命中中 8 处此类，r28m' 亦含「施工按以下编号步骤组织：」形态）。
 * 动作：整行仅此句则删行（其后紧邻空行一并压缩，段间保留单一空行）；行内前文保留、
 * 只删末句子串；删除后不做标点修补（实测前驱句均以「。」结尾，无损最小变更）。
 * 幂等：无目标/已剥离时零变更可安全重放（零变更时原样返回，不触碰换行与空白）。
 */
export function stripSentencePatternAnnouncements(markdown: string): {
  markdown: string;
  removedCount: number;
  removedSentences: string[];
} {
  const family = SENTENCE_PATTERN_FAMILIES.find(item => item.id === 'form-announcement')!;
  const removedSentences: string[] = [];
  const out: string[] = [];
  let skipNextBlank = false;
  for (const rawLine of markdown.split(/\r?\n/u)) {
    if (skipNextBlank) {
      skipNextBlank = false;
      if (rawLine.trim() === '') continue;
    }
    const line = rawLine.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').trim();
    if (!line || /^#{1,6}\s/u.test(line) || line.startsWith('|')) { out.push(rawLine); continue; }
    const prefix = line.match(/^(?:\d+(?:\.\d+)*[.、)）]|[-*•])\s*/u)?.[0] ?? '';
    const lastSentence = line.slice(prefix.length).split(/(?<=[。！？])/u).pop()?.trim() ?? '';
    if (lastSentence.length < 8 || !/[：:]\s*$/u.test(lastSentence) || !family.test(lastSentence)) {
      out.push(rawLine);
      continue;
    }
    const cutIndex = rawLine.lastIndexOf(lastSentence);
    if (cutIndex < 0) { out.push(rawLine); continue; }
    removedSentences.push(lastSentence);
    const keptLine = rawLine.slice(0, cutIndex).replace(/\s+$/u, '');
    if (keptLine.trim() === '') { skipNextBlank = true; continue; }
    out.push(keptLine);
  }
  return removedSentences.length === 0
    ? { markdown, removedCount: 0, removedSentences }
    : { markdown: out.join('\n'), removedCount: removedSentences.length, removedSentences };
}

/**
 * 泛化归口式帧（C8 S5 U 通道：句级复读坍塌修复轮——duplicateSentenceCollapse——的泛句判据基准）。
 * s28m' 唯一性 0.59（53/90）复算归因：重复句超预算扣分中泛句复读 excess 37 为「上述/相关/有关
 * ＋泛对象词」引首的泛化归口句复读（「上述要求纳入…每日检查、每周复核」类），全篇复读 39 种
 * 仅 1 种命中句模族表 → 修复通道死角；且 r28m'/s28m' 泛句密度不可分（2.47 vs 2.77 处/万字，
 * 族计数式判据会误触发长文阈值），故判据定为「帧命中 ∩ 完全同句复读」（修复轮消费
 * duplicateSentenceOccurrences 单源出现明细——检测定位=修复定位）。
 * v2 校准（probe4）：s28m' 21 种泛句全覆盖，且精确排除「上述＋具体业务名词」的 4 句帧首同形
 * 业务句（岗位证书/新材料/纠偏动作/规范编号——句首同帧但句体为真实业务事实，跨章复读保留）。
 */
export const GENERALIZED_CLOSURE_SENTENCE_RE = /^(?:上述|相关|有关)(?:要求|做法|措施|内容|安排|控制要点|控制项|控制内容|作业要求)/u;

// ═══════════════════════════ 四、标题完整性 ═══════════════════════════

/** 剥「第X章/第X节」与数字编号得标题核心名（保留内部标点供句化判定） */
export function coreTitleName(rawTitle: string): string {
  return rawTitle
    .replace(/^第[一二三四五六七八九十百零〇\d]+[章节篇部分][\s、.．:：]*/u, '')
    .replace(/^\d+(?:\.\d+)*[.．、:：]?\s*/u, '')
    .trim();
}

/** 合法短标题豁免（目录类结构性字词，非内容小节） */
const TITLE_CORE_EXEMPT = new Set(['目录', '前言', '摘要', '附录', '索引', '封面', '总则']);

/** 残缺标题判定（纯短汉字标题（无字母含入）不足 3 字即残缺；“小菜园”类 3 字完整专业词、“BIM应用”类含字母标题不在此列）：检测与确定性补全同源。
 * 4.44 #3 根治：阈值 4→3——4.43 实测「2.1.4 小菜园」为完整专业词（项目主要专业构成之一），
 * 旧阈值将 3 字完整词误判残缺；「危大」类 2 字残缺仍保留判定。 */
/**
 * 合法 2 字专业术语白名单（完整工程术语，非截断）。
 * 判据不是长度而是「是否完整术语」：「危大」是截断（应为「危大工程辨识与管控」），
 * 「排水」「围墙」「屋面」是完整专业词。实测误判：巢湖终检 64 项复核清单里多数属于此类
 *（「1.4.1 1#厂房」「2.5.2 排水」「2.14.2 矮墙」「2.13.4 围墙」被判「标题核心名不足 3 字」）。
 */
const TITLE_CORE_COMPLETE_TERMS = new Set([
  // 仅收「本身就是完整对象名、加后缀反而不成词」的两字词——实测巢湖误判项：
  // 「2.14.2 矮墙」「2.13.4 围墙」（不存在「矮墙系统/围墙系统」这类说法）。
  // 不放「电气/通风/排水/幕墙」等可加后缀成词的术语：它们由 fixTruncatedTitleCompletion
  // 按正文取证确定性补全为「电气系统/通风系统/…」，这是更完整的标题（既有测试锁定该行为）。
  '矮墙', '围墙',
]);

function isTruncatedTitleCore(core: string): boolean {
  if (!core || TITLE_CORE_EXEMPT.has(core)) return false;
  if (TITLE_CORE_COMPLETE_TERMS.has(core)) return false;
  const hanCount = (core.match(/[\u4e00-\u9fa5]/gu) || []).length;
  // 具名构建筑物（含编号/井号且中文名 ≥2 字，如「1#厂房」「2#门卫」「3# 泵房」）：具体对象名，非截断
  //（「1#厂」这类中文名不足 2 字仍判残缺，避免放过真截断）
  if (/[#＃\d]/u.test(core) && hanCount >= 2) return false;
  if (hanCount === 0 || hanCount >= 3) return false;
  return !/[A-Za-z]/u.test(core) && core.length <= 4;
}

/** 标题缺陷判定：核心名不足 3 汉字（如「6.5 危大」）/ 含逗号句化 / 悬挂连接词结尾（如「××及」） */
function titleDefectReason(core: string): string | undefined {
  if (!core || TITLE_CORE_EXEMPT.has(core)) return undefined;
  const hanCount = (core.match(/[\u4e00-\u9fa5]/gu) || []).length;
  if (hanCount === 0) return undefined;
  if (isTruncatedTitleCore(core)) return '标题核心名不足 3 字（残缺标题）';
  if (/[，,]/u.test(core)) return '标题含逗号（句式化标题）';
  if (/[等及和与]$/u.test(core)) return '标题以悬挂连接词结尾（残缺标题）';
  return undefined;
}

interface TitleDefect {
  chapterTitle: string;
  parentTitle: string;
  rawTitle: string;
  reason: string;
}

/** H2~H4 标题缺陷扫描（章节归属记录；同核心名去重） */
function scanTitleDefects(markdown: string): TitleDefect[] {
  const defects: TitleDefect[] = [];
  const seen = new Set<string>();
  let chapterTitle = '';
  let sectionTitle = '';
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const heading = /^(#{2,4})\s+(.+?)\s*$/u.exec(rawLine.trim());
    if (!heading) continue;
    const depth = heading[1].length;
    const rawTitle = heading[2];
    if (depth === 2) {
      chapterTitle = rawTitle;
      sectionTitle = '';
      continue;
    }
    const core = coreTitleName(rawTitle);
    if (core && !seen.has(core)) {
      const reason = titleDefectReason(core);
      if (reason) {
        seen.add(core);
        defects.push({ chapterTitle, parentTitle: sectionTitle, rawTitle, reason });
      }
    }
    if (depth === 3) sectionTitle = rawTitle;
  }
  return defects;
}

/** 标题残缺/句化检测（终检注册）：规划层双闸（isInvalidPlannedSectionTitle / isInvalidTitle）的终检兜底 */
export function titleIntegrityIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const defect of scanTitleDefects(markdown)) {
    const scope = defect.parentTitle ? `「${defect.parentTitle}」内` : defect.chapterTitle ? `「${defect.chapterTitle}」章内` : '';
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'structure',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `小节标题残缺或句式化：${scope}“${defect.rawTitle}”（${defect.reason}）`,
      suggestion: '将标题重命名为完整表达小节内容的正式名称（如“危大”应为“危大工程辨识与管控”、残缺名补全语义），正文内容不变；禁止使用“施工概况/施工流程/施工方法”等结构标签词充当标题。',
    });
    if (issues.length >= 6) return issues;
  }
  return issues;
}

/** 标题修复目标（repairTemplatingIssues 消费：标题行原文 + 缺陷原因） */
export interface TitleRepairTarget {
  chapterTitle: string;
  title: string;
  reason: string;
}

export function titleRepairTargets(markdown: string): TitleRepairTarget[] {
  return scanTitleDefects(markdown)
    .slice(0, 6)
    .map(defect => ({ chapterTitle: defect.chapterTitle, title: defect.rawTitle, reason: defect.reason }));
}

// ── 残缺标题确定性补全（round-2 链 / 终检前最后一道） ──

/** 补全后缀白名单（工程通用后缀；按优先级取正文中实际出现的 core+后缀 组合，优先级高者先取证） */
const TITLE_COMPLETION_SUFFIXES = ['系统', '工程', '设施', '设备', '装置', '结构', '管道', '安装', '施工', '项目', '要点'] as const;

/** 残缺标题确定性补全产出 */
export interface TruncatedTitleFixOutcome {
  markdown: string;
  fixedCount: number;
  details: Array<{ from: string; to: string }>;
}

/**
 * 残缺标题确定性补全（round-2 链 / 终检前最后一道）：
 * 「2.22.1 电气」类 <3 汉字残缺标题（H4 工作包名映射常见），从标题下方正文取证
 * core+工程后缀的首次实锤（如正文首句「电气系统施工对象包括……」→ 补全「电气系统」）；
 * 后缀必须在正文原文出现（零编造），取证失败不改（保留 LLM 锚点修复位）。
 */
export function fixTruncatedTitleCompletion(markdown: string): TruncatedTitleFixOutcome {
  const lines = markdown.split(/\r?\n/u);
  const details: TruncatedTitleFixOutcome['details'] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const heading = /^(#{2,4})\s+(.+?)\s*$/u.exec(rawLine.trim());
    if (!heading) continue;
    const rawTitle = heading[2];
    const core = coreTitleName(rawTitle);
    if (!isTruncatedTitleCore(core)) continue;
    // 正文取证窗口：标题行下方 400 字符内（不跨下一标题）
    const bodyParts: string[] = [];
    let cursor = index + 1;
    let chars = 0;
    while (cursor < lines.length && chars < 400) {
      if (/^\s*#{1,6}\s/u.test(lines[cursor])) break;
      bodyParts.push(lines[cursor]);
      chars += lines[cursor].length;
      cursor += 1;
    }
    const body = bodyParts.join('\n');
    const suffix = TITLE_COMPLETION_SUFFIXES.find(candidate => body.includes(core + candidate));
    if (!suffix) continue;
    // 补全后核心名须达到完整标题语义（≥4 汉字）
    if (((core + suffix).match(/[\u4e00-\u9fa5]/gu) || []).length < 4) continue;
    const position = rawTitle.indexOf(core);
    if (position < 0) continue;
    const newTitle = `${rawTitle.slice(0, position)}${core}${suffix}${rawTitle.slice(position + core.length)}`;
    lines[index] = rawLine.replace(rawTitle, newTitle);
    details.push({ from: rawTitle, to: newTitle });
  }
  if (details.length === 0) return { markdown, fixedCount: 0, details: [] };
  return { markdown: lines.join('\n'), fixedCount: details.length, details };
}

// ── 句化标题切分（标题合并治理 · 装配层 markdownComposer 与交付链同源） ──

/** 规划小节标题匹配键（句化标题切分专用归一化，自包含实现不反向依赖规划模块）：
 * 剥「第X章/节」与数字编号 + 全部空白与标点——两侧（标题行片段与规划小节名）同口径比较 */
export function plannedTitleMatchKey(title: string): string {
  return title
    .replace(/\*+/gu, '')
    .replace(/^第[一二三四五六七八九十百千万零〇\d]+[章节篇部分][\s、.．:：-]*/u, '')
    .replace(/^\d+(?:\.\d+)*(?:[.．、]|\s)+/u, '')
    .replace(/^[-—–]\s*/u, '')
    .replace(/[\s()（）:：.。；;,，、\-—·]/gu, '')
    .trim();
}

/** 句化标题续写句最小长度（规范化字符数）：低于该阈值视为正常标题修饰（如「×××与保证措施」），不切分 */
const SENTENCE_LIKE_HEADING_REMAINDER_MIN = 10;

/**
 * 句化标题切分识别（标题合并治理单源）：标题文本以规划小节标题为前缀且余部 ≥10 字（规范化）时，
 * 视为「规划标题与正文首句并写」（丰乐镇 4.27.0 实测「公厕机电安装工程集中在马老郢…」179 字、
 * 「村庄道路基层与面层作业覆盖9个自然村…」291 字），返回规划标题与续写句余部；
 * 候选按规划标题长度降序（最长前缀优先）；余部不足阈值时不做前缀命中（保持既有精确匹配路径）。
 * 切分位置用逐字符扫描确定（容忍标题内软换行空格/标点差异，如「马圩 自然村组」）。
 */
export function splitSentenceLikeHeading(headingText: string, plannedTitles: readonly string[]): { plannedTitle: string; remainder: string } | undefined {
  const candidates = plannedTitles
    .map(title => ({ title: String(title || '').trim(), key: plannedTitleMatchKey(String(title || '')) }))
    .filter(item => item.title && item.key.length >= 4)
    .sort((left, right) => right.key.length - left.key.length);
  for (const candidate of candidates) {
    for (let cut = candidate.key.length; cut <= headingText.length; cut += 1) {
      if (plannedTitleMatchKey(headingText.slice(0, cut)) !== candidate.key) continue;
      const remainder = headingText.slice(cut).replace(/^[\s:：.。；;,，、\-—]+/u, '');
      if (plannedTitleMatchKey(remainder).length >= SENTENCE_LIKE_HEADING_REMAINDER_MIN) return { plannedTitle: candidate.title, remainder };
      // 首个前缀命中点余部即最长余部（更长前缀不会再命中）：余部过短视为正常标题，不再切分该候选
      break;
    }
  }
  return undefined;
}

/**
 * 续写句与后继正文的覆盖判定（切分修复内容零丢失防线）：续写句按句累加，
 * 规范化（仅去空白，容忍软换行空格差异）后被后继正文包含的最长前缀句序列视为已覆盖——
 * 全部覆盖返回空串（丢弃不重复），部分/未覆盖返回剩余整句拼接（转正文行插入）。
 */
export function uncoveredHeadingRemainder(remainder: string, followingBodyText: string): string {
  const sentences = remainder.split(/(?<=[。；;！？])/u).map(part => part.trim()).filter(Boolean);
  if (sentences.length === 0) return '';
  const followingKey = followingBodyText.replace(/\s+/gu, '');
  if (!followingKey) return remainder;
  let covered = 0;
  for (let index = 0; index < sentences.length; index += 1) {
    const accumulated = sentences.slice(0, index + 1).join('').replace(/\s+/gu, '');
    if (followingKey.includes(accumulated)) covered = index + 1;
    else break;
  }
  return sentences.slice(covered).join('');
}

/**
 * 句化标题切分确定性修复（4.27.2 标题合并治理 P0 · 交付链兜底）：
 * LLM 写作层把规划小节标题与正文首句并写为一行 H3/H4（「### 2.11 公厕机电安装工程集中在马老郢…」），
 * 标题行含长句正文属评标视角结构性硬伤。按规划小节标题前缀命中切分：
 * 标题复原为「原编号 + 规划标题」，续写句余部与后继正文（截至下一标题行，≤6 行）做覆盖判定——
 * 已被正文覆盖的部分丢弃，未覆盖部分转正文段落插入（内容零丢失）；
 * 未注入规划标题（plannedSectionTitles 缺失）或标题非句化合并形态时静默跳过（零误伤）。
 * 装配层 markdownComposer.normalizeSectionHeading 同源前缀匹配在更早环节收敛，本器为交付前兜底。
 */
export function fixSentenceLikeHeadingSplit(markdown: string, plannedSectionTitles?: readonly string[]): { markdown: string; fixedCount: number; details: string[] } {
  if (!plannedSectionTitles || plannedSectionTitles.length === 0) return { markdown, fixedCount: 0, details: [] };
  const lines = markdown.split(/\r?\n/u);
  const out: string[] = [];
  let fixedCount = 0;
  const details: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    const heading = /^(#{3,4})\s+(.+?)\s*$/u.exec(trimmed);
    if (!heading) { out.push(rawLine); continue; }
    const numbered = /^(\d+(?:\.\d+)*)\s+(.+)$/u.exec(heading[2]);
    const numberPrefix = numbered ? `${numbered[1]} ` : '';
    const titleText = numbered ? numbered[2] : heading[2];
    const split = splitSentenceLikeHeading(titleText, plannedSectionTitles);
    if (!split) { out.push(rawLine); continue; }
    const bodyParts: string[] = [];
    for (let cursor = index + 1; cursor < lines.length && bodyParts.length < 6; cursor += 1) {
      if (/^\s*#{1,6}\s/u.test(lines[cursor])) break;
      bodyParts.push(lines[cursor]);
    }
    const uncovered = uncoveredHeadingRemainder(split.remainder, bodyParts.join('\n'));
    out.push(`${heading[1]} ${numberPrefix}${split.plannedTitle}`);
    if (uncovered) out.push('', uncovered);
    fixedCount += 1;
    if (details.length < 6) details.push(`${heading[1]} ${numberPrefix}${split.plannedTitle}（续写句${uncovered ? '转正文' : '已被正文覆盖丢弃'}）`);
  }
  return { markdown: out.join('\n'), fixedCount, details };
}
