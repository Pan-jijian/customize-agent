import { getLocalSemanticProvider } from './semanticSimilarity';
import type { ValidationIssue } from './types';

/**
 * 内部话术锚点库（C2）：后台内部术语/内部话术泄漏检测从单一精确词（工作包）扩展为语义锚点库。
 * 检测链路：L1 精确词召回（封闭集字面）+ L3 本地 bge 句子级语义匹配（锚点相似度 ≥0.62 判定泄漏）。
 * 零误伤原则：L1 字面召回与 L3 语义扩展判定双轨并行；本地 bge 恒可用（本地 ONNX 推理），嵌入失败直接抛出；
 * 修复闭环（documentPipeline 交付阻断修复轮）用同一检测函数复检，判定与修复同源。
 */

/** 内部话术语义锚点：生成系统后台概念与内部话术的正例句式，各带锚定词前置过滤——
 * 候选句必须含锚定词才参与语义匹配（round-18 E7 收紧：目录裸标题行“2.12 主要分部分项工程施工方案”
 * 与正常句“项目部根据本项目安全风险特点储备应急物资”因 bge 语义空间相近被误报为内部话术，
 * 锚定词把召回范围收窄到真正携带内部话术特征的句子） */
const INTERNAL_TERM_ANCHORS: Array<{ anchor: string; required: RegExp }> = [
  { anchor: '按工作包逐项说明施工内容', required: /工作包|逐项说明/u },
  { anchor: '本项目已确认资料', required: /已确认|确认资料|本项目资料/u },
  { anchor: '已确认的项目资料显示', required: /已确认|项目资料/u },
  { anchor: '根据已确认资料', required: /已确认/u },
  { anchor: '生成后事实反查未通过', required: /事实反查|反查/u },
  { anchor: '资料事实主表', required: /事实主表/u },
  { anchor: '事实卡', required: /事实卡/u },
  { anchor: '后台数据库记录', required: /后台数据库|后台记录/u },
  { anchor: '证据摘要中未包含', required: /证据摘要/u },
] as const;

/** 内部话术精确词兜底（L1 封闭集字面召回：确定性匹配，/g 收集全部命中词供一次性定向修复） */
const INTERNAL_TERM_EXACT_RE = /工作包|事实卡|事实主表|后台数据库/gu;

/** 目录裸标题行（无 # 前缀的数字编号标题，如“2.12 主要分部分项工程施工方案”）：不参与正文句子语义匹配 */
const TOC_LINE_RE = /^\d+(?:\.\d+)*\s+\S+/u;

function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += left[index] * right[index];
  return sum;
}

export async function internalTerminologyAnchorIssues(markdown: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  // L1 精确词兜底（确定性字面召回，与 L3 语义层并行）
  const exactHits = [...new Set(markdown.match(INTERNAL_TERM_EXACT_RE) || [])];
  if (exactHits.length > 0) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'format',
      owner: 'system',
      repairability: 'llm_repairable',
      message: `正式正文仍包含后台内部术语“${exactHits.join('”“')}”，需要按上下文语义改写为正式术语`,
      suggestion: '请结合语境改写：“拆除工程工作包”→“拆除工程”，“按工作包逐项说明”→“按专业工程逐项说明”；禁止出现生成系统后台概念。',
    });
  }
  // L3 语义锚点匹配：提取正文句子（排除标题行/表格行/目录裸标题行）批量嵌入后与锚点比对。
  // round-19 召回修复：此前按整行过滤长度（8~80 字），长段落整行超 80 字被整体跳过，
  // 徽光阁实测“依据本项目已确认资料、技术文件和验收标准”嵌入长段漏检；改为按句末标点拆句后再过滤长度
  const sentences = markdown
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => !/^#{1,6}\s/u.test(line) && !/^\s*\|/u.test(line) && !(TOC_LINE_RE.test(line) && line.length <= 40 && !/[。！？!?；;，,：:]/.test(line)))
    .flatMap(line => line.split(/(?<=[。！？!?；;])/u).map(part => part.trim()))
    .filter(sentence => sentence.length >= 8 && sentence.length <= 80)
    .slice(0, 200);
  if (sentences.length === 0) return issues;
  const provider = getLocalSemanticProvider();
  const [sentenceVectors, anchorVectors] = await Promise.all([
    provider.embedDocuments(sentences),
    provider.embedDocuments(INTERNAL_TERM_ANCHORS.map(item => item.anchor)),
  ]);
  const hits: string[] = [];
  for (let index = 0; index < sentences.length; index += 1) {
    const vector = sentenceVectors[index];
    if (!vector || vector.length === 0) continue;
    const sentence = sentences[index];
    // 锚定词前置过滤：候选句不含任一锚点的锚定词则跳过（目录行/正常专业句不再参与匹配）
    if (!INTERNAL_TERM_ANCHORS.some(item => item.required.test(sentence))) continue;
    const maxSim = Math.max(...anchorVectors.map(anchor => dot(vector, anchor)));
    if (maxSim >= 0.62) hits.push(sentence.slice(0, 24));
    if (hits.length >= 6) break;
  }
  if (hits.length > 0) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'format',
      owner: 'system',
      repairability: 'llm_repairable',
      message: `正式正文疑似包含后台内部话术（语义锚点命中 ${hits.length} 处）：${hits.map(hit => `“${hit}…”`).join('、')}`,
      suggestion: '将内部话术（已确认资料/事实卡/工作包等生成系统概念）改写为面向评标人的正式表述，仅陈述项目事实与施工内容。',
    });
  }
  return issues;
}

/**
 * 内部话术确定性删除兜底（round-19 R3）：与检测器同源同阈值（句级拆分 + 锚定词前置过滤 + 锚点相似度 ≥0.62），
 * 命中句子整句删除（含句末标点），标题行/表格行/目录裸标题行不触碰。
 */
export async function stripInternalTerminologySentences(markdown: string): Promise<string> {
  const lines = markdown.split(/\r?\n/u);
  const protectedLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (/^#{1,6}\s/u.test(trimmed)) return true;
    if (/^\s*\|/u.test(trimmed)) return true;
    return TOC_LINE_RE.test(trimmed) && trimmed.length <= 40 && !/[。！？!?；;，,：:]/.test(trimmed);
  };
  // 候选句收集与检测器同口径：行级豁免后按句末标点拆句，锚定词前置过滤
  const candidateLines: Array<{ index: number; sentences: string[] }> = [];
  lines.forEach((line, index) => {
    if (protectedLine(line)) return;
    const parts = line
      .split(/(?<=[。！？!?；;])/u)
      .map(part => part.trim())
      .filter(part => part.length >= 8 && part.length <= 80 && INTERNAL_TERM_ANCHORS.some(item => item.required.test(part)));
    if (parts.length > 0) candidateLines.push({ index, sentences: parts });
  });
  const allCandidates = candidateLines.flatMap(item => item.sentences).slice(0, 200);
  if (allCandidates.length === 0) return markdown;
  const provider = getLocalSemanticProvider();
  const [sentenceVectors, anchorVectors] = await Promise.all([
    provider.embedDocuments(allCandidates),
    provider.embedDocuments(INTERNAL_TERM_ANCHORS.map(item => item.anchor)),
  ]);
  const hitSet = new Set<string>();
  allCandidates.forEach((sentence, index) => {
    const vector = sentenceVectors[index];
    if (!vector || vector.length === 0) return;
    const maxSim = Math.max(...anchorVectors.map(anchor => dot(vector, anchor)));
    if (maxSim >= 0.62) hitSet.add(sentence);
  });
  if (hitSet.size === 0) return markdown;
  return lines.map((line, index) => {
    if (protectedLine(line)) return line;
    let next = line;
    for (const sentence of hitSet) {
      if (next.includes(sentence)) next = next.split(sentence).join('');
    }
    return next;
  }).join('\n');
}
