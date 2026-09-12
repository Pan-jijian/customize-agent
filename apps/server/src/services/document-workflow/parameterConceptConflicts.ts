import { getLocalSemanticProvider } from './semanticSimilarity';
import type { ValidationIssue } from './types';

/**
 * 参数概念口径冲突检测（C1）：把"同一参数概念的多口径矛盾"（如围挡高度 2.5m/1.8m、试压压力 1.5MPa/1.0MPa）
 * 从枚举参数名单迁移到"概念自组织聚类 + 同簇数值冲突"检测。
 *
 * 分层：L1 正则结构提取"数值+单位+概念语境"token（封闭集单位表）→ L3 本地 bge 对概念语境自组织聚类
 * （两两余弦 ≥0.6 合并为同簇，并查集）→ L2 同簇内显著不同数值判定冲突（差异 >2%，排除并列枚举）。
 * 零误伤原则：本地 bge 恒可用（本地 ONNX 推理），嵌入失败直接抛出；
 * 并列枚举（"600mm/800mm/1000mm 三种规格"）不判冲突。
 * V5 P6 误报收口（run1 实测，三防线）：①簇级倍数门——同一参数口径偏差不可能达 4 倍以上，
 * 超出必是跨对象 bge 误聚类（实测误报簇 4.84/6/11/13 倍全部收口，原 20 倍门有漏网）；
 * ②单位一致性——同簇跨单位数值不可互比（「2 处] vs「22 天」误聚根因）；
 * ③概念黑名单——对象计数类概念（自然村/标段/点位等）是对象枚举计数非参数多口径。
 */

const PARAM_TOKEN_RE = /([\u4e00-\u9fa5A-Za-z0-9（）()]{1,12}?)(\d+(?:\.\d+)?)\s*(mm|cm|m|米|MPa|kN|kV|kW|℃|°C|万元|元|人|天|日|个|层|樘|处|套|台|t|吨)([\u4e00-\u9fa5A-Za-z0-9（）()]{0,8})/gu;

/** 纯通用量词表：概念归一化后仅为量词本身（无具体对象）时退出聚类——
 * 不同对象的「直径22mm」「直径48.3mm」（锚杆 vs 钢管）同词形不同对象，聚同簇必误报（合肥师范实测）。 */
const GENERIC_MEASURE_WORDS = [
  '直径', '厚度', '宽度', '长度', '高度', '深度', '间距', '距离', '标高', '偏差',
  '数量', '面积', '体积', '重量', '压力', '温度', '强度', '等级', '坡度', '规格',
  '尺寸', '层数', '次数', '跨度', '半径',
] as const;

/** 概念黑名单（run1 实测误报收口）：对象计数类概念——「13 个自然村 / 1 个标段 / 2 处踏勘点位」
 * 是对象的枚举计数而非同一参数的多口径取值，跨对象 bge 误聚簇时数字天然异构（13 vs 1）；
 * 此类数字一致性由跨章/审计通道把关，不参与参数口径互斥（「养护」类时长按对象天然多口径同）。 */
const CONCEPT_BLACKLIST_RE = /自然村|村组|标段|区域|点位|养护/u;

/** 概念归一化：去除单位词与标点后仅保留概念词面 */
function normalizeConcept(concept: string): string {
  return concept
    .replace(/(?:mm|cm|m|MPa|kN|kV|kW|℃|元|万元|人|天|日|个|层|樘|处|套|台|t|吨)/gu, '')
    .replace(/[\s,，、；;：:（）()]/gu, '');
}

function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += left[index] * right[index];
  return sum;
}

interface ParamToken { concept: string; value: number; unit: string; raw: string }

function extractParamTokens(markdown: string): ParamToken[] {
  const tokens: ParamToken[] = [];
  // 剔除表格行与标题行，只检正文句（表格内同概念多规格属正常枚举，不在矛盾检测范围）
  for (const line of markdown.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) continue;
    for (const match of trimmed.matchAll(new RegExp(PARAM_TOKEN_RE.source, 'gu'))) {
      const prefix = (match[1] || '').trim();
      const value = Number(match[2]);
      const unit = match[3] || '';
      const suffix = (match[4] || '').trim();
      // 概念语境 = 数值前后短语去空白；语境过短（纯标点/无概念词）不参与聚类
      const concept = `${prefix}${suffix}`.replace(/[\s,，、；;：:]/gu, '');
      if (concept.length < 2 || !/[\u4e00-\u9fa5A-Za-z]{2,}/u.test(concept) || !Number.isFinite(value) || value <= 0) continue;
      // 纯通用量词概念跳过：无具体对象无从判定口径，不同对象同量词聚簇必误报
      if (GENERIC_MEASURE_WORDS.some(word => normalizeConcept(concept) === word)) continue;
      // 对象计数类概念跳过（非参数口径，见 CONCEPT_BLACKLIST_RE）
      if (CONCEPT_BLACKLIST_RE.test(concept)) continue;
      tokens.push({ concept, value, unit, raw: match[0] });
    }
  }
  // 去重：同 raw 只留一个（同一表述重复出现不算冲突）
  const seen = new Set<string>();
  return tokens.filter(token => {
    const key = token.raw;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 60);
}

/** 并查集：两两语义相似 ≥0.6 的概念合并为同簇（自组织聚类） */
function clusterConcepts(concepts: string[], similarity: (left: string, right: string) => number): Map<string, string> {
  const parent = new Map(concepts.map(concept => [concept, concept]));
  const find = (node: string): string => {
    const root = parent.get(node) || node;
    return root === node ? node : (parent.set(node, find(root)), parent.get(node) || node);
  };
  const union = (left: string, right: string) => { parent.set(find(left), find(right)); };
  for (let left = 0; left < concepts.length; left += 1) {
    for (let right = left + 1; right < concepts.length; right += 1) {
      if (similarity(concepts[left], concepts[right]) >= 0.6) union(concepts[left], concepts[right]);
    }
  }
  return parent;
}

export async function parameterConceptConflictIssues(markdown: string): Promise<ValidationIssue[]> {
  const tokens = extractParamTokens(markdown);
  // 至少需要 3 个概念 token 才有聚类价值；不足时静默跳过（零误伤：样本不足不判）
  if (tokens.length < 3) return [];
  const concepts = [...new Set(tokens.map(token => token.concept))];
  if (concepts.length < 2) return [];
  const vectors = await getLocalSemanticProvider().embedDocuments(concepts);
  if (vectors.length !== concepts.length) {
    throw new Error(`本地语义模型嵌入数量不一致：期望 ${concepts.length} 条，实际 ${vectors.length} 条`);
  }
  const vectorOf = new Map(concepts.map((concept, index) => [concept, vectors[index]]));
  const similarity = (left: string, right: string) => {
    const leftVector = vectorOf.get(left);
    const rightVector = vectorOf.get(right);
    if (!leftVector || !rightVector || leftVector.length === 0 || rightVector.length === 0) return 0;
    return dot(leftVector, rightVector);
  };
  const parent = clusterConcepts(concepts, similarity);
  const find = (node: string): string => {
    let current = node;
    while ((parent.get(current) || current) !== current) current = parent.get(current) || current;
    return current;
  };
  // 按簇聚合 token
  const clusters = new Map<string, ParamToken[]>();
  for (const token of tokens) {
    const root = find(token.concept);
    const group = clusters.get(root) || [];
    group.push(token);
    clusters.set(root, group);
  }
  const conflicts: string[] = [];
  for (const group of clusters.values()) {
    if (group.length < 2) continue;
    // 簇级倍数门（>4 倍整簇跳过）：同一参数口径偏差不可能达 4 倍以上，超出必是跨对象 bge
    // 误聚类——run1 实测误报簇 4.84/6/11/13 倍全部收口（原 >20 倍门对「13 个自然村 vs
    // 1 个标段」类跨对象计数聚簇有漏网），整簇跳过不再细分。
    const groupMax = Math.max(...group.map(token => token.value));
    const groupMin = Math.min(...group.map(token => token.value));
    if (groupMax > groupMin * 4) continue;
    // 单位一致性（run1 实测误报收口）：同簇不同单位的数值不可互比（bge 把「踏勘点位不少于
    // 2 处」与「驻场每月不少于 22 天」误聚同簇）——按单位分组后仅同单位组内 ≥2 个显著差异值才判冲突
    const byUnit = new Map<string, ParamToken[]>();
    for (const token of group) {
      const unitGroup = byUnit.get(token.unit) || [];
      unitGroup.push(token);
      byUnit.set(token.unit, unitGroup);
    }
    for (const unitGroup of byUnit.values()) {
      if (unitGroup.length < 2) continue;
      const values = [...new Set(unitGroup.map(token => token.value))];
      if (values.length < 2) continue;
      const maxValue = Math.max(...values);
      const minValue = Math.min(...values);
      // 差异 >2% 才算显著冲突；同簇同值多表述不算
      if (maxValue - minValue <= maxValue * 0.02) continue;
      // 排除并列枚举：任一 token 原文后紧跟"、"或"/"且同句出现另一数字+单位
      const enumerations = unitGroup.filter(token => /[、/](?:与)?\d/u.test(token.raw));
      if (enumerations.length >= 2) continue;
      conflicts.push(`“${unitGroup[0].concept}”出现多个口径：${[...new Set(unitGroup.map(token => token.raw))].slice(0, 3).join('、')}`);
      if (conflicts.length >= 4) break;
    }
    if (conflicts.length >= 4) break;
  }
  if (conflicts.length === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `同一参数概念出现多口径数值冲突：${conflicts.join('；')}`,
    suggestion: '以绑定资料（图纸/清单/规范）裁决口径为准统一数值表述：每个参数概念全文只保留一个口径数值，删除矛盾表述。',
  }];
}
