/**
 * 模板化治理单源模块（结构标签 / 标题完整性 / 工序表达形式轮换 / 句式骨架指纹）。
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
 * 3) 删除标题行时吞掉紧随的一个空行，防双空行残留。
 */
export function fixTemplatedLabels(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const lines = markdown.split(/\r?\n/u);
  const output: string[] = [];
  let removedHeadings = 0;
  let strippedPrefixes = 0;
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
    const prefixMatch = STRUCTURE_LABEL_PREFIX_RE.exec(raw);
    if (prefixMatch) {
      const rest = raw.slice(prefixMatch[0].length);
      strippedPrefixes += 1;
      if (rest.trim()) output.push(rest);
      continue;
    }
    output.push(raw);
  }
  const fixedCount = removedHeadings + strippedPrefixes;
  if (fixedCount === 0) return { markdown, fixedCount: 0, details: [] };
  const details: string[] = [];
  if (removedHeadings > 0) details.push(`结构标签标题删除 ${removedHeadings} 行（正文保留）`);
  if (strippedPrefixes > 0) details.push(`段首标签前缀剥离 ${strippedPrefixes} 处`);
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
  顺序词叙述: '用顺序词连贯叙述工序先后（“先……，再……，随后……，然后……，最后……”）',
  编号步骤: '用编号步骤分行列出工序（“1. 测量放线；2. 基槽开挖；3. 基础施工；……”）',
  有序列表: '用无序要点列表分行列出工序（“- 基层清理；- 放线定位；- 分层摊铺；……”）',
  箭头链: '用箭头链表达工序先后（“基层清理→放线定位→分层摊铺→碾压→验收”）',
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

/** 顺序词叙述 → 编号步骤：序列句拆为编号行（连接词剥离，内容与数值逐字保留） */
function sequenceToNumberedSteps(text: string): string | undefined {
  let changed = false;
  const next = text.replace(SEQUENCE_FRAME_RE, (match, middle: string, last: string, tail: string) => {
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
 */
export interface SkeletonFingerprint {
  id: string;
  /** 指纹原文（展示与计数基准，与验收表逐字一致） */
  text: string;
  /** 弹性匹配正则（空白容错；检测 / 修复 / 验收计数同源） */
  pattern: RegExp;
  /** 变体池（确定性修复轮换替换用；变体不得命中任一指纹 pattern，单测锁定防替换后复发） */
  variants: readonly string[];
}

export const SKELETON_FINGERPRINTS: readonly SkeletonFingerprint[] = [
  {
    id: 'by-tech-lead-org',
    text: '由技术负责人组织',
    pattern: /由\s*技术负责人\s*组织/gu,
    variants: ['技术负责人牵头组织', '项目部安排技术负责人主持', '技术负责人负责组织实施', '由项目技术负责人统筹安排'],
  },
  {
    id: 'post-qualified',
    text: '合格后方可',
    pattern: /合格\s*后方可/gu,
    variants: ['合格后再行', '合格后方能', '合格后才可', '检验合格方可', '合格以后方可'],
  },
  {
    id: 'after-acceptance',
    text: '验收合格后',
    pattern: /验收\s*合格\s*后/gu,
    variants: ['验收通过后', '验收签认后', '验收确认后', '检验合格后'],
  },
];

/** 每条骨架指纹全文出现上限（验收表口径：每条骨架全文 ≤2 次） */
export const SKELETON_FINGERPRINT_CAP = 2;

/** 写作侧骨架指纹禁令（写作卡 / 任务卡注入文案单源） */
export const SKELETON_FINGERPRINT_BAN_LINE = '句式禁止复读：全篇「由技术负责人组织」「合格后方可」「验收合格后」三类骨架表述各自不得超过 2 次，同义表达轮换使用（如“技术负责人牵头组织”“检验合格后再行”“验收通过后”），保持句式多样、事实不变。';

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

/**
 * 骨架指纹复读检测（终检注册）：任一指纹全篇出现 >2 处即 blocker
 * （验收口径「每条骨架全文 ≤2 次」；round-2 确定性修复器 fixSkeletonFingerprintRepetition 兜底清零）。
 */
export function skeletonFingerprintIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const fingerprint of SKELETON_FINGERPRINTS) {
    const count = countSkeletonFingerprint(markdown, fingerprint);
    if (count <= SKELETON_FINGERPRINT_CAP) continue;
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'style',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `句式骨架复读：「${fingerprint.text}」全篇出现 ${count} 处（上限 ${SKELETON_FINGERPRINT_CAP} 处）——模板化复用句式`,
      suggestion: `保留全文前 2 处「${fingerprint.text}」，其余处按句子语境轮换同义表达（如：${fingerprint.variants.slice(0, 3).join('、')}）；改写保留原句全部事实信息（岗位、数值、频次不得丢失），不得用结构标签或固定套语替代。`,
    });
  }
  return issues;
}

/** 骨架指纹修复目标（repairTemplatingIssues 消费：按章聚合超量命中句，全文口径第 3 处起，每章每指纹至多 4 句） */
export interface SkeletonFingerprintRepairTarget {
  chapterTitle: string;
  fingerprintLabel: string;
  /** 全篇出现总次数（prompt 供 LLM 了解治理总量级） */
  totalCount: number;
  sentences: string[];
}

export function skeletonFingerprintRepairTargets(markdown: string): SkeletonFingerprintRepairTarget[] {
  const targets: SkeletonFingerprintRepairTarget[] = [];
  const chapters = chapterSlices(markdown);
  for (const fingerprint of SKELETON_FINGERPRINTS) {
    const total = countSkeletonFingerprint(markdown, fingerprint);
    if (total <= SKELETON_FINGERPRINT_CAP) continue;
    const byChapter = new Map<string, string[]>();
    for (const chapter of chapters) {
      if (!chapter.body) continue;
      for (const match of chapter.body.matchAll(fingerprint.pattern)) {
        const start = match.index ?? 0;
        const sentence = sentenceAround(chapter.body, start, start + match[0].length);
        if (sentence.length < 6) continue;
        const list = byChapter.get(chapter.title) ?? [];
        if (!list.includes(sentence)) list.push(sentence);
        byChapter.set(chapter.title, list);
      }
    }
    // 全文保留额度 2 处：按章序打平消耗，其余为超量修复目标（每章至多 4 句进锚点修复）
    let keepQuota = SKELETON_FINGERPRINT_CAP;
    for (const [chapterTitle, sentences] of byChapter) {
      const overflow = sentences.slice(keepQuota).slice(0, 4);
      keepQuota = Math.max(0, keepQuota - sentences.length);
      if (overflow.length > 0) targets.push({ chapterTitle, fingerprintLabel: fingerprint.text, totalCount: total, sentences: overflow });
    }
  }
  return targets.slice(0, 12);
}

/** 骨架指纹确定性修复产出 */
export interface SkeletonFingerprintFixOutcome {
  markdown: string;
  fixedCount: number;
  details: Array<{ id: string; replaced: number }>;
}

/**
 * 骨架指纹确定性兜底（round-2 链 / 终检前最后一道）：每指纹保留全文前 2 处匹配，
 * 其余轮换替换为变体池表达（实时重扫保证「验收合格后方可」类重叠指纹组合收敛）。
 * 变体池单测锁定「替换后不命中任一指纹」，短语级同义改写不丢事实、不改句法。
 */
export function fixSkeletonFingerprintRepetition(markdown: string): SkeletonFingerprintFixOutcome {
  let next = markdown;
  let fixedCount = 0;
  const details: Array<{ id: string; replaced: number }> = [];
  for (const fingerprint of SKELETON_FINGERPRINTS) {
    let replaced = 0;
    for (;;) {
      const matches = [...next.matchAll(fingerprint.pattern)];
      if (matches.length <= SKELETON_FINGERPRINT_CAP) break;
      const overflow = matches[SKELETON_FINGERPRINT_CAP];
      const start = overflow.index ?? 0;
      const variant = fingerprint.variants[replaced % fingerprint.variants.length];
      const candidate = next.slice(0, start) + variant + next.slice(start + overflow[0].length);
      // 防御：若变体误命中自身指纹则计数不降（变体池单测锁定不触发），跳出防死循环
      if (countSkeletonFingerprint(candidate, fingerprint) >= matches.length) break;
      next = candidate;
      replaced += 1;
    }
    if (replaced > 0) {
      details.push({ id: fingerprint.id, replaced });
      fixedCount += replaced;
    }
  }
  return { markdown: next, fixedCount, details };
}

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

/** 残缺标题判定（纯短汉字标题（无字母含入）不足 4 字即残缺；“BIM应用”类含字母标题不在此列）：检测与确定性补全同源 */
function isTruncatedTitleCore(core: string): boolean {
  if (!core || TITLE_CORE_EXEMPT.has(core)) return false;
  const hanCount = (core.match(/[\u4e00-\u9fa5]/gu) || []).length;
  if (hanCount === 0 || hanCount >= 4) return false;
  return !/[A-Za-z]/u.test(core) && core.length <= 4;
}

/** 标题缺陷判定：核心名不足 4 汉字（如「6.5 危大」）/ 含逗号句化 / 悬挂连接词结尾（如「××及」） */
function titleDefectReason(core: string): string | undefined {
  if (!core || TITLE_CORE_EXEMPT.has(core)) return undefined;
  const hanCount = (core.match(/[\u4e00-\u9fa5]/gu) || []).length;
  if (hanCount === 0) return undefined;
  if (isTruncatedTitleCore(core)) return '标题核心名不足 4 字（残缺标题）';
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
 * 「2.22.1 电气」类 <4 汉字残缺标题（H4 工作包名映射常见），从标题下方正文取证
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
