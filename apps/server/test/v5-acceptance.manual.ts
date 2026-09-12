/**
 * V5 六机制治理验收统计（真实模板连发后显式运行，.manual.ts）。
 *
 * 运行：DOC_IDS=id1,id2,id3 npx vitest run apps/server/test/v5-acceptance.manual.ts
 * 默认：取项目最近 3 篇已完成草稿（completed / completed_with_issues / warning）。
 *
 * 验收口径（V5 方案 P6 硬验收表；v5 校准：真实残留数据源 = draft.exportGate.blockingIssues + 顶层
 * warningIssues，reviewMetadata.globalIssues 自设计起恒为空数组、不可作为断言面）：
 * 1) 跨章一致性/数值核对残留=0：warningIssues（修复轮/门禁残留清单）中数据类前缀计数为 0；
 * 2) 门禁数据类阻断=0 真矛盾：exportGate.blockingIssues 中 fact_consistency 类条目 + 终审
 *    「全维度评审·数据逻辑」条计数为 0；
 * 3) 敏感点抽查：
 *    a. 挖掘机台数全文唯一，且等于设备权威投影值（midValue 单值收敛口径）；
 *    b. 正文土方条目取值 ∈ {清单合计, 分工程/分村分组值} ∪ 审计已登记值（v5 方案 Y 值一致性）；
 *    c. 各阶段「阶段投入 N 人」= byPhase 权威投影值（阶段劳动力:xxx 条目）；
 *    d. 规格形 token（C 标号 / M 砂浆 / DN / Φ / W）数值核心 ∈ 权威核心集合；
 * 4) 无主数值审计=0 未登记项：落盘 reviewMetadata.authorityAudit 与实时重算均 unregisteredCount=0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { auditAuthorityCoverage, authorityAuditSummary } from '@/services/document-workflow/authorityAudit';
import type { AuthorityAuditReport } from '@/services/document-workflow/authorityAudit';
import { blueprintPhaseLaborAuthorities, blueprintQuantityGroupAuthorities, buildAuthorityIndex } from '@/services/document-workflow/authorityIndex';
import { loadBlueprintAsset } from '@/services/document-workflow/integratedBlueprint';
import type { BlueprintData, IntegratedBlueprint } from '@/services/document-workflow/integratedBlueprint';
import { generatedRoot } from '@/services/document-core/generatedDocumentService';

const PROJECT_ROOT = process.env.PROJECT_ROOT ?? '/Users/pan/Desktop/codeing/customize-agent';
/** 报告样本上限：收编流程需要全量浏览未登记项时设 ACCEPT_SAMPLE_LIMIT=100+ */
const SAMPLE_LIMIT = Number(process.env.ACCEPT_SAMPLE_LIMIT ?? 8);
const TERMINAL_OK_STATUSES = new Set(['completed', 'completed_with_issues', 'warning']);

interface DraftLike {
  id: string;
  status: string;
  markdown?: string;
  projectRoot?: string;
  wordCount?: number;
  /** 修复轮/门禁残留清单（generatedDocumentService 由 validationIssues 映射 message+suggestion） */
  warningIssues?: string[];
  /** 完整流水线输出（含终审门禁） */
  draft?: {
    exportGate?: {
      passed?: boolean;
      blockingIssues?: Array<{ level?: string; severity?: string; category?: string; message?: string; suggestion?: string }>;
    };
  };
  reviewMetadata?: {
    authorityAudit?: AuthorityAuditReport;
    reviewChecklist?: Array<{ key: string; label: string; passed: boolean; message?: string }>;
    professionalScore?: { total?: number; grade?: string };
    qualityReport?: { overall?: number; passed?: boolean };
  };
}

/** 警告层数据类前缀（验收 1：跨章一致性/数值核对残留=0）——run1 实测前缀集，新增类别按同规则并入。
 *  注意：「事实一致性冲突」（facts 层多值抽取噪音，如项目名称 vs 清单文件名）与「已确认…落位」
 *  属事实模型/覆盖层警告，非正文数据残留，不入本表。 */
const WARNING_DATA_RE = /^(?:阶段劳动力数据矛盾|材料规格拆分数量与蓝图权威不一致|材料\/设备数量口径矛盾|跨章一致性冲突|蓝图引用冲突|规格错位|时间区间倒挂|数值核对|口径矛盾|数值冲突)/u;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function clip(text: string, index: number, span: number): string {
  return text.slice(Math.max(0, index - span), index + span).replace(/\s+/gu, ' ');
}

function draftFile(docId: string): string {
  return path.join(generatedRoot(PROJECT_ROOT), 'drafts', `${docId}.json`);
}

function loadDraft(docId: string): DraftLike {
  return JSON.parse(fs.readFileSync(draftFile(docId), 'utf8')) as DraftLike;
}

/** 默认取值：最近 3 篇已完成草稿（meta 文件轻量读取，避免解析全量正文） */
function latestCompletedDocIds(limit = 3): string[] {
  const draftsDir = path.join(generatedRoot(PROJECT_ROOT), 'drafts');
  const rows: Array<{ id: string; completedAt: number }> = [];
  for (const file of fs.readdirSync(draftsDir)) {
    if (!file.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(draftsDir, file), 'utf8')) as { status?: string; completedAt?: number };
      if (!meta.status || !TERMINAL_OK_STATUSES.has(meta.status) || !meta.completedAt) continue;
      rows.push({ id: file.replace(/\.meta\.json$/u, ''), completedAt: meta.completedAt });
    } catch {
      // 跳过读取失败的 meta（进行中任务元数据半写）
    }
  }
  return rows.sort((left, right) => right.completedAt - left.completedAt).slice(0, limit).map(row => row.id);
}

/** 挖掘机台数扫描（v5 校准·三篇 run1 实证「全文唯一=5」）：
 *  形态一「挖掘机…N 台」——前 8 字含小型/微型/手扶/手持、或 N 前窗口以「与/及/和/、/，」开头
 *  （枚举承接）、或含他名词（破碎/配套等）→ 剔除；
 *  形态二「N 台…挖掘机」——N 前缀为他名词、或 N 与挖掘机之间含枚举分隔符/小型微型 → 剔除。 */
function machineCountScan(markdown: string): { values: string[]; samples: string[] } {
  const values: string[] = [];
  const samples: string[] = [];
  const exclude = /破碎|切割|汽车|渣土|人工|装载|泵|锤|钻|配套/u;
  for (const match of markdown.matchAll(/挖掘机([^。；\n]{0,8}?)(\d+(?:\.\d+)?)\s*台/gu)) {
    const index = match.index ?? 0;
    const before = markdown.slice(Math.max(0, index - 8), index);
    if (/小型|微型|手扶|手持/u.test(before)) continue;
    if (/^[与及和、，,]/u.test(match[1])) continue;
    if (exclude.test(match[1])) continue;
    values.push(match[2]);
    if (samples.length < 12) samples.push(clip(markdown, index, 30));
  }
  for (const match of markdown.matchAll(/([^。；\n]{0,10}?)(\d+(?:\.\d+)?)\s*台([^。；\n]{0,6}?)挖掘机/gu)) {
    if (exclude.test(match[1])) continue;
    if (/[、，,与及和]/u.test(match[3]) || /小型|微型/u.test(match[3])) continue;
    values.push(match[2]);
    if (samples.length < 12) samples.push(clip(markdown, match.index ?? 0, 30));
  }
  return { values, samples };
}

/** 阶段人数扫描（v5 校准·run1 实证误报源=工种限定「拆除工22人/绿化工163人」与否定语境「均不得按276人」）：
 *  捕获窗口含否定/上限词（不得/不超过/严禁/上限/控制值/峰值/不少于/不低于/至少/最低/不小于/≥）
 *  或窗口尾部为工种字「工」时剔除；保留真矛盾（阶段值 ≠ byPhase midValue 投影，如「阶段276人」vs 238）。 */
function phaseLaborScan(markdown: string, data: BlueprintData): { violations: string[]; matched: number } {
  const authorities = blueprintPhaseLaborAuthorities(data);
  const violations: string[] = [];
  let matched = 0;
  for (const authority of authorities) {
    const re = new RegExp(`${escapeRe(authority.phase)}([^。；\\n]{0,10}?)(\\d{2,3})\\s*人`, 'gu');
    for (const match of markdown.matchAll(re)) {
      const window = match[1] ?? '';
      if (/不得|不超过|严禁|上限|控制值|峰值|不少于|不低于|至少|最低|不小于|≥/u.test(window)) continue;
      if (/工$/u.test(window.trimEnd())) continue;
      // 表格行豁免（与 phaseLaborMixingIssues 同口径：分阶段投入明细表的合法承载）
      const lineStart = markdown.lastIndexOf('\n', match.index ?? 0) + 1;
      let lineEnd = markdown.indexOf('\n', match.index ?? 0);
      if (lineEnd === -1) lineEnd = markdown.length;
      if (/^\s*\|.*\|\s*$/u.test(markdown.slice(lineStart, lineEnd))) continue;
      matched += 1;
      const value = Number(match[2]);
      if (Math.abs(value - authority.value) > 0.5) {
        violations.push(`${authority.phase}：正文 ${value} 人 ≠ 权威 ${authority.value} 人（${clip(markdown, match.index ?? 0, 34)}）`);
      }
    }
  }
  return { violations, matched };
}

/** 分村/分工程土方值一致性（v5 校准·方案 Y）：正文「土方条目名…数值+体积单位」的取值必须
 *  ∈ {清单合计, 分工程/分村分组值} ∪ 审计已登记值（derivationGaps/processGaps/contextualMatches 数值核）。
 *  窗口不跨数字（run1 实测：相邻「12.24m²、挖基坑土方104.73m³」类句式会跨条目误配）；
 *  旧「全值逐字覆盖」断言过苛（run1 实测 224/265/252 误报：正文合法引用合计值即通过）。 */
function quantityValueScan(markdown: string, data: BlueprintData, auditedValues: Set<string>): { checked: number; violations: string[] } {
  const authorities = blueprintQuantityGroupAuthorities(data).filter(entry => /土方|回填|弃置|清表|平整/u.test(entry.name));
  const violations = new Set<string>();
  const normalize = (text: string): string => String(Number(text));
  for (const entry of authorities) {
    const legal = new Set<string>([normalize(String(entry.value)), ...(entry.groups ?? []).map(group => normalize(String(group.value)))]);
    const re = new RegExp(`${escapeRe(entry.name)}[^。；\\n\\d]{0,30}?(\\d+(?:\\.\\d+)?)\\s*(?:[mM][3³]|立方米)`, 'gu');
    for (const match of markdown.matchAll(re)) {
      const value = normalize(match[1]);
      if (legal.has(value)) continue;
      if (auditedValues.has(value)) continue;
      violations.add(`${entry.name}=${match[1]}`);
    }
  }
  return { checked: authorities.length, violations: [...violations] };
}

/** 规格形 token 扫描：C 标号 / M 砂浆 / DN / Φ / W 的数值核心必须在权威核心集合中（材料规格∈规格权威） */
function specTokenScan(markdown: string, data: BlueprintData): { checked: number; uncovered: string[] } {
  const cores = new Set<string>();
  for (const entry of buildAuthorityIndex(data).entries) {
    if (typeof entry.value === 'number') cores.add(String(entry.value));
    for (const text of [String(entry.value), entry.spec, entry.label]) {
      if (!text) continue;
      for (const core of text.match(/\d+(?:\.\d+)?/gu) ?? []) cores.add(core);
    }
    for (const group of entry.groups ?? []) cores.add(String(group.value));
  }
  const seen = new Map<string, string>();
  // 规格形 token 边界：C 标号前不得接字母（排除 DC36V/AC220V）、M 标号前不得接字母（排除 PM2.5）；
  // 小写 φ 多为工具/管径工艺形（角磨机 φ125），不入规格权威抽查（防误伤），Φ 大写（钢筋直径）保留。
  for (const match of markdown.matchAll(/(?:(?<![A-Za-z])C\d{2}(?!\d)|(?<![A-Za-z])M\d+(?:\.\d+)?(?!\d)|DN\s?\d+|Φ\s?\d+(?:\.\d+)?|\d+(?:\.\d+)?\s?W(?![A-Za-z\d]))/gu)) {
    const token = match[0].replace(/\s+/gu, '');
    if (!seen.has(token)) seen.set(token, clip(markdown, match.index ?? 0, 26));
  }
  const uncovered: string[] = [];
  for (const [token, context] of seen) {
    const core = token.match(/\d+(?:\.\d+)?/u)?.[0];
    if (core && !cores.has(core)) uncovered.push(`${token}（${context}）`);
  }
  return { checked: seen.size, uncovered };
}

function analyze(docId: string) {
  const draft = loadDraft(docId);
  const markdown = draft.markdown ?? '';
  const blueprint: IntegratedBlueprint | undefined = loadBlueprintAsset(draft.projectRoot ?? PROJECT_ROOT);
  const data = blueprint?.validation.passed ? blueprint.data : undefined;
  const persisted = draft.reviewMetadata?.authorityAudit;
  const recomputed = data ? auditAuthorityCoverage(markdown, data) : auditAuthorityCoverage(markdown);
  const blocking = draft.draft?.exportGate?.blockingIssues ?? [];
  const warningIssues = draft.warningIssues ?? [];
  const factBlockers = blocking.filter(item => item.category === 'fact_consistency');
  const reviewDataLogic = blocking.filter(item => item.category === 'qingtian_review' && /数据逻辑|数值|口径/u.test(item.message ?? ''));
  const warningData = warningIssues.filter(message => WARNING_DATA_RE.test(message));
  const checklistFailed = (draft.reviewMetadata?.reviewChecklist ?? []).filter(item => !item.passed);

  const failures: string[] = [];
  if (factBlockers.length > 0) failures.push(`门禁数据类阻断 ${factBlockers.length} 条`);
  if (reviewDataLogic.length > 0) failures.push(`终审数据逻辑高风险 ${reviewDataLogic.length} 条`);
  if (warningData.length > 0) failures.push(`警告层数据类残留 ${warningData.length} 条`);
  if (recomputed.unregisteredCount > 0) failures.push(`审计未登记项 ${recomputed.unregisteredCount} 个`);
  if (persisted && persisted.unregisteredCount !== recomputed.unregisteredCount) {
    failures.push(`落盘审计(${persisted.unregisteredCount}) 与重算(${recomputed.unregisteredCount}) 不一致`);
  }

  // 方案 Y 豁免集：审计已登记值（推导缺口/工艺缺口/撞核语境匹配的数值核）——正文引用的登记值不算越权
  const auditedValues = new Set<string>();
  for (const item of [...recomputed.derivationGaps, ...recomputed.processGaps, ...recomputed.contextualMatches]) {
    const core = item.token.match(/\d+(?:\.\d+)?/u)?.[0];
    if (core) auditedValues.add(String(Number(core)));
  }

  let machine: { unique: string[]; samples: string[]; pass: boolean } | undefined;
  let phase: { violations: string[]; matched: number; pass: boolean } | undefined;
  let quantityValues: { checked: number; violations: string[]; pass: boolean } | undefined;
  let specTokens: { checked: number; uncovered: string[]; pass: boolean } | undefined;
  if (data) {
    const machineRaw = machineCountScan(markdown);
    const unique = [...new Set(machineRaw.values)];
    const equipment = (buildAuthorityIndex(data).byDomain.get('equipment') ?? []).find(entry => entry.label === '挖掘机');
    const authorityValue = equipment && typeof equipment.value === 'number' ? String(equipment.value) : undefined;
    const machinePass = machineRaw.values.length > 0 && unique.length === 1 && (!authorityValue || unique[0] === authorityValue);
    machine = { unique, samples: machineRaw.samples, pass: machinePass };
    if (!machinePass) failures.push(`挖掘机台数不唯一或≠权威（实测 ${unique.join('/') || '无'}，权威 ${authorityValue ?? '缺失'}）`);

    const phaseRaw = phaseLaborScan(markdown, data);
    phase = { ...phaseRaw, pass: phaseRaw.violations.length === 0 };
    if (!phase.pass) failures.push(`阶段人数越权 ${phase.violations.length} 处`);

    const quantityRaw = quantityValueScan(markdown, data, auditedValues);
    quantityValues = { ...quantityRaw, pass: quantityRaw.violations.length === 0 };
    if (!quantityValues.pass) failures.push(`分村/分工程土方值越权 ${quantityRaw.violations.length} 处`);

    const specRaw = specTokenScan(markdown, data);
    specTokens = { ...specRaw, pass: specRaw.uncovered.length === 0 };
    if (!specTokens.pass) failures.push(`规格 token 越权 ${specRaw.uncovered.length} 个`);
  }

  const blockingByCategory: Record<string, number> = {};
  for (const item of blocking) {
    const key = item.category ?? 'unknown';
    blockingByCategory[key] = (blockingByCategory[key] ?? 0) + 1;
  }

  return {
    docId,
    status: draft.status,
    chars: markdown.length,
    wordCount: draft.wordCount ?? null,
    professionalScore: draft.reviewMetadata?.professionalScore?.total ?? null,
    qualityOverall: draft.reviewMetadata?.qualityReport?.overall ?? null,
    gate: {
      passed: draft.draft?.exportGate?.passed ?? null,
      blockingCount: blocking.length,
      blockingByCategory,
      factBlockers: factBlockers.slice(0, 6).map(item => item.message ?? ''),
      reviewDataLogic: reviewDataLogic.slice(0, 6).map(item => item.message ?? ''),
      warningTotal: warningIssues.length,
      warningDataCount: warningData.length,
      warningDataSamples: warningData.slice(0, 6),
    },
    checklistFailed: checklistFailed.map(item => item.label).slice(0, 8),
    authorityAudit: {
      persisted: persisted ? authorityAuditSummary(persisted) : '未落盘（生成早于 P5）',
      recomputed: authorityAuditSummary(recomputed),
      derivationGapSamples: recomputed.derivationGaps.slice(0, SAMPLE_LIMIT).map(item => `${item.token}—${item.context}`),
      processGapSamples: recomputed.processGaps.slice(0, SAMPLE_LIMIT).map(item => `${item.token}—${item.context}`),
      unattributed: recomputed.unattributed.slice(0, SAMPLE_LIMIT).map(item => `${item.token}—${item.context}`),
    },
    sensitive: { machine, phase, quantityValues, specTokens },
    verdict: { passed: failures.length === 0, failures },
  };
}

describe('V5 六机制治理验收统计', () => {
  const explicit = (process.env.DOC_IDS ?? '').split(',').map(item => item.trim()).filter(Boolean);
  const docIds = explicit.length > 0 ? explicit : latestCompletedDocIds(3);
  it('输出各文档 V5 验收指标', () => {
    console.log(`\n验收目标文档：${docIds.join(', ') || '（无已完成草稿）'}`);
    let passed = 0;
    for (const docId of docIds) {
      try {
        const report = analyze(docId);
        if (report.verdict.passed) passed += 1;
        console.log(`\n===== ${docId} =====`);
        console.log(JSON.stringify(report, null, 2));
      } catch (error) {
        console.log(`\n===== ${docId} ===== 读取失败: ${(error as Error).message}`);
      }
    }
    console.log(`\n验收汇总：${passed}/${docIds.length} 篇通过全部硬断言`);
  });
});
