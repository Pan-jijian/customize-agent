import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DocumentEvidence, DocumentExecutionStage, DocumentGenerationDiagnostics, ProjectGraph } from './types';
import { callDocumentLlmJson } from './llmClient';
import { runWithAdaptiveConcurrency, stableHash, throwIfAborted } from './utils';
import { displayStage } from './progress';
import { docSystemPrefix } from './markdownComposer';

const SYSTEM_PROMPT_BASE = [
  '通读以下项目资料（招标文件、工程量清单、图纸设计说明、补疑文件等），',
  '输出一个 JSON 对象，描述你对该项目的完整理解。',
  '',
  'JSON 字段（全部为数组，无相关信息时返回空数组）：',
  '  works:           [{name, scope, sourceFiles, relatedItems}]',
  '  methods:         [{name, steps, applicableWorks, sourceFiles}]',
  '  resources:       [{name, type:"material"|"equipment"|"labor", spec, quantity, unit, sourceFiles}]',
  '  schedule:        [{milestone, duration, startDate, endDate, sourceFiles}]',
  '  standards:       [{code, description, sourceFiles}]',
  '  risks:           [{risk, level:"high|medium|low", mitigation, sourceFiles}]',
  '  requirements:    [{category, detail, sourceFiles}]',
  '  siteConditions:  [{condition, impact, sourceFiles}]',
  '  addendumChanges: [{originalPath, original, revised, sourceFile}]',
  '  gaps:            [string] 仅记录资料中确实缺失且影响施工组织设计编制的事实；证据中已出现的内容不得声称「未提供/未找到」',
  '',
  '只基于资料内容，不编造。每个条目标注来源文件。只返回 JSON。',
].join('\n');

function buildPrompt(evidence: DocumentEvidence[]): string {
  const text = evidence.map((item, i) => {
    const h = `[${i + 1}] ${item.filePath}`;
    const s = item.sectionTitle ? ` / ${item.sectionTitle}` : '';
    return `${h}${s}\n${item.content.replace(/\s+/gu, ' ').trim()}`;
  }).join('\n\n---\n\n');
  return `请从以下项目资料中提取结构化理解：\n\n${text}\n\n返回 JSON。`;
}

function normalize(raw: Partial<ProjectGraph> | undefined, evidence: DocumentEvidence[]): ProjectGraph | undefined {
  if (!raw) return undefined;
  const files = new Set(evidence.map(e => e.filePath));
  const ok = (f: unknown) => typeof f === 'string' && (files.has(f) || evidence.some(e => path.basename(e.filePath) === path.basename(f)));
  const s = (v: unknown, n: number) => typeof v === 'string' ? v.slice(0, n) : typeof v === 'number' ? String(v).slice(0, n) : '';
  const a = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []).slice(0, n);

  return {
    works: (raw.works || []).filter(w => typeof w.name === 'string' && typeof w.scope === 'string').map(w => ({
      name: s(w.name, 200), scope: s(w.scope, 500),
      sourceFiles: a(w.sourceFiles, 10).filter(ok), relatedItems: a(w.relatedItems, 20),
    })),
    methods: (raw.methods || []).filter(m => typeof m.name === 'string').map(m => ({
      name: s(m.name, 200), steps: a(m.steps, 12),
      applicableWorks: a(m.applicableWorks, 10), sourceFiles: a(m.sourceFiles, 10).filter(ok),
    })),
    resources: (raw.resources || []).filter(r => typeof r.name === 'string').map(r => ({
      name: s(r.name, 200),
      type: r.type === 'material' || r.type === 'equipment' || r.type === 'labor' ? r.type : 'material',
      spec: s(r.spec, 200), quantity: s(r.quantity, 50), unit: s(r.unit, 20),
      sourceFiles: a(r.sourceFiles, 5).filter(ok),
    })),
    schedule: (raw.schedule || []).filter(x => typeof x.milestone === 'string').map(x => ({
      milestone: s(x.milestone, 200), duration: s(x.duration, 100),
      startDate: s(x.startDate, 50), endDate: s(x.endDate, 50),
      sourceFiles: a(x.sourceFiles, 5).filter(ok),
    })),
    standards: (raw.standards || []).filter(x => typeof x.code === 'string' || typeof x.description === 'string').map(x => ({
      code: s(x.code, 100), description: s(x.description, 300),
      sourceFiles: a(x.sourceFiles, 5).filter(ok),
    })),
    risks: (raw.risks || []).filter(r => typeof r.risk === 'string').map(r => ({
      risk: s(r.risk, 300),
      level: r.level === 'high' || r.level === 'medium' || r.level === 'low' ? r.level : 'medium',
      mitigation: s(r.mitigation, 500), sourceFiles: a(r.sourceFiles, 5).filter(ok),
    })),
    requirements: (raw.requirements || []).filter(x => typeof x.category === 'string' && typeof x.detail === 'string').map(x => ({
      category: s(x.category, 100), detail: s(x.detail, 500),
      sourceFiles: a(x.sourceFiles, 5).filter(ok),
    })),
    siteConditions: (raw.siteConditions || []).filter(x => typeof x.condition === 'string').map(x => ({
      condition: s(x.condition, 300), impact: s(x.impact, 500),
      sourceFiles: a(x.sourceFiles, 5).filter(ok),
    })),
    addendumChanges: (raw.addendumChanges || []).filter(x => typeof x.original === 'string' && typeof x.revised === 'string').map(x => ({
      originalPath: s(x.originalPath, 300), original: s(x.original, 300),
      revised: s(x.revised, 500), sourceFile: s(x.sourceFile, 200),
    })),
    gaps: a(raw.gaps, 20),
    generatedAt: Date.now(),
  };
}

function evidenceText(items: DocumentEvidence[]) {
  return items.map(item => `${item.filePath}\n${item.sectionTitle || ''}\n${item.content}`).join('\n');
}

function extractFirst(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match?.[1]?.replace(/\s+/gu, ' ').trim().slice(0, 500) || '';
}

type ProjectGraphDomain = 'scope' | 'methods' | 'resources' | 'scheduleStandards' | 'risksSite' | 'requirementsAddendum';

const DOMAIN_PROMPTS: Record<ProjectGraphDomain, { title: string; pattern: RegExp; guidance: string }> = {
  scope: { title: '项目基本信息、工程范围、主要工程内容', pattern: /项目名称|工程名称|招标范围|施工范围|建设内容|建设规模|建筑面积|工程概况|清单|图纸/u, guidance: '重点填充 works、requirements。必须识别项目名称、建设地点、建设规模、招标范围、工程内容；有来源才写。' },
  methods: { title: '关键施工方法与专业工序', pattern: /施工方法|施工工艺|工序|流程|专项|装饰|装修|加固|电气|给排水|消防|智能化|暖通|屋面|外墙/u, guidance: '重点填充 methods，并关联 applicableWorks。步骤必须来自资料或由资料中的专业工程内容直接归纳。' },
  resources: { title: '材料、设备、劳动力、工程量资源', pattern: /材料|设备|机械|劳动力|工程量|清单|规格|型号|数量|单位|暂估|主材/u, guidance: '重点填充 resources。材料设备和工程量能确认多少写多少，数量和单位不得编造。' },
  scheduleStandards: { title: '工期节点、质量目标、标准规范、验收要求', pattern: /工期|日历天|开工|竣工|节点|进度|质量|验收|标准|规范|合格|创优/u, guidance: '重点填充 schedule、standards。必须优先抽取总工期、质量标准、验收标准和关键节点。' },
  risksSite: { title: '现场条件、重难点、风险与约束', pattern: /现场|周边|交通|既有|营业|拆除|保护|安全|文明|扬尘|噪声|风险|难点|危大/u, guidance: '重点填充 risks、siteConditions。风险必须给出资料支撑的原因和控制方向。' },
  requirementsAddendum: { title: '招标管理要求、补疑澄清与修正', pattern: /招标|投标|合同|要求|承包|分包|保修|补疑|澄清|答疑|修正|变更|编制/u, guidance: '重点填充 requirements、addendumChanges。补疑澄清必须写 original、revised、sourceFile。评标办法、评分细则、分值构成、评审内容项属商务程序性内容，对施工组织设计编制无用，一律不抽取、不进图谱。无法确认原文时不要编造。' },
};

function sourceFilesFor(items: DocumentEvidence[], textPattern: RegExp, max = 8) {
  return [...new Set(items.filter(item => textPattern.test(item.content) || textPattern.test(item.sectionTitle || '') || textPattern.test(item.filePath)).map(item => item.filePath))].slice(0, max);
}

function buildProjectGraphHintsFromEvidence(evidence: DocumentEvidence[]) {
  const text = evidenceText(evidence);
  const hint = (label: string, pattern: RegExp) => {
    const value = extractFirst(text, pattern);
    return value ? `${label}：${value}` : '';
  };
  return [
    hint('项目名称', /(?:招标项目名称|项目名称|工程名称)[：:\s]*([^。；\n]{3,120})/u),
    hint('建设地点', /(?:建设地点|项目地点|实施地点)[：:\s]*([^。；\n]{3,160})/u),
    hint('建设规模', /(?:建设规模|建筑面积|总建筑面积)[：:\s]*([^。；\n]{3,120})/u),
    hint('计划工期', /(?:计划工期|总工期|工期要求|工期总日历天数)[：:\s]*([^。；\n]{2,80})/u),
    hint('质量标准', /(?:质量标准|质量要求|质量目标)[：:\s]*([^。；\n]{2,120})/u),
    hint('招标范围', /(?:招标范围|工程承包范围|施工范围|建设内容)[：:\s]*([\s\S]{20,700}?)(?=\n#{1,4}\s|\n\d+[.、]\s|质量|工期|$)/u),
    sourceFilesFor(evidence, /补疑|澄清|答疑|修正/u).length ? `补疑澄清文件：${sourceFilesFor(evidence, /补疑|澄清|答疑|修正/u).join('、')}` : '',
  ].filter(Boolean);
}

function selectDomainEvidence(evidence: DocumentEvidence[], domain: ProjectGraphDomain, maxChars = 52000) {
  const domainSpec = DOMAIN_PROMPTS[domain];
  const ranked = [...evidence].sort((a, b) => {
    const aHit = domainSpec.pattern.test(`${a.filePath}${a.sectionTitle || ''}${a.content}`) ? 1 : 0;
    const bHit = domainSpec.pattern.test(`${b.filePath}${b.sectionTitle || ''}${b.content}`) ? 1 : 0;
    return bHit - aHit || b.score - a.score;
  });
  const selected: DocumentEvidence[] = [];
  let chars = 0;
  for (const item of ranked) {
    const slice = { ...item, content: item.content.replace(/\s+/gu, ' ').trim().slice(0, 5000) };
    if (chars + slice.content.length > maxChars && selected.length >= 8) continue;
    selected.push(slice);
    chars += slice.content.length;
    if (chars >= maxChars || selected.length >= 18) break;
  }
  return selected;
}

function buildDomainPrompt(evidence: DocumentEvidence[], domain: ProjectGraphDomain, hints: string[]) {
  const spec = DOMAIN_PROMPTS[domain];
  return [
    `请抽取项目图谱分域：${spec.title}`,
    spec.guidance,
    '确定性线索仅用于帮助定位原文，不得作为最终图谱事实直接照抄；最终 JSON 必须由资料证据支撑。',
    hints.length ? `定位线索：\n${hints.map(item => `- ${item}`).join('\n')}` : '',
    buildPrompt(evidence),
  ].filter(Boolean).join('\n\n');
}

function graphItemCount(graph: ProjectGraph) {
  return graph.works.length + graph.methods.length + graph.resources.length + graph.schedule.length + graph.standards.length + graph.risks.length + graph.requirements.length + graph.siteConditions.length + graph.addendumChanges.length;
}

function merge(graphs: ProjectGraph[]): ProjectGraph {
  const seen = { w: new Set<string>(), m: new Set<string>(), r: new Set<string>(), sc: new Set<string>(), st: new Set<string>(), ri: new Set<string>(), rq: new Set<string>(), si: new Set<string>(), a: new Set<string>() };
  return {
    works: graphs.flatMap(g => g.works).filter(w => { const k = w.name + w.scope; if (seen.w.has(k)) return false; seen.w.add(k); return true; }),
    methods: graphs.flatMap(g => g.methods).filter(m => { const k = m.name; if (seen.m.has(k)) return false; seen.m.add(k); return true; }),
    resources: graphs.flatMap(g => g.resources).filter(r => { const k = r.name + r.spec + r.type; if (seen.r.has(k)) return false; seen.r.add(k); return true; }),
    schedule: graphs.flatMap(g => g.schedule).filter(x => { const k = x.milestone; if (seen.sc.has(k)) return false; seen.sc.add(k); return true; }),
    standards: graphs.flatMap(g => g.standards).filter(x => { const k = x.code + x.description; if (seen.st.has(k)) return false; seen.st.add(k); return true; }),
    risks: graphs.flatMap(g => g.risks).filter(r => { const k = r.risk; if (seen.ri.has(k)) return false; seen.ri.add(k); return true; }),
    requirements: graphs.flatMap(g => g.requirements).filter(x => { const k = x.category + x.detail; if (seen.rq.has(k)) return false; seen.rq.add(k); return true; }),
    siteConditions: graphs.flatMap(g => g.siteConditions).filter(x => { const k = x.condition; if (seen.si.has(k)) return false; seen.si.add(k); return true; }),
    addendumChanges: graphs.flatMap(g => g.addendumChanges).filter(x => { const k = x.original + x.revised; if (seen.a.has(k)) return false; seen.a.add(k); return true; }),
    gaps: [...new Set(graphs.flatMap(g => g.gaps))],
    generatedAt: Date.now(),
  };
}

function cacheRoot(projectRoot?: string) {
  const root = path.join(process.env.HOME || process.cwd(), '.customize-agent', 'cache', 'document-workflow', stableHash(projectRoot || 'default'));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function fileSignature(projectRoot: string | undefined, filePath: string) {
  if (!projectRoot) return undefined;
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  try {
    const stat = fs.statSync(fullPath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

function graphCacheKey(input: { evidence: DocumentEvidence[]; requirement?: string; templateId?: string; projectRoot?: string }) {
  return stableHash({
    version: 'project-graph-v5-short-timeout-single-pass',
    requirement: input.requirement || '',
    templateId: input.templateId || '',
    evidence: input.evidence.map(item => ({ filePath: item.filePath, fileSig: fileSignature(input.projectRoot, item.filePath), sectionTitle: item.sectionTitle, contentHash: stableHash({ length: item.content.length, head: item.content.slice(0, 8000), tail: item.content.slice(-8000) }) })).sort((a, b) => `${a.filePath}${a.sectionTitle}`.localeCompare(`${b.filePath}${b.sectionTitle}`)),
  });
}

function readCachedGraph(projectRoot: string | undefined, key: string): ProjectGraph | undefined {
  const root = cacheRoot(projectRoot);
  if (!root) return undefined;
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(root, `project-graph-${key}.json`), 'utf8')) as ProjectGraph;
    return cached && Array.isArray(cached.works) ? cached : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedGraph(projectRoot: string | undefined, key: string, graph?: ProjectGraph) {
  const root = cacheRoot(projectRoot);
  if (!root || !graph) return;
  fs.writeFileSync(path.join(root, `project-graph-${key}.json`), JSON.stringify(graph, null, 2));
}

interface ProjectGraphValidation {
  ok: boolean;
  reasons: string[];
}

function validateProjectGraph(graph: ProjectGraph | undefined, evidence: DocumentEvidence[]): ProjectGraphValidation {
  if (!graph) return { ok: false, reasons: ['LLM 未返回可解析的 ProjectGraph JSON'] };
  const reasons: string[] = [];
  const n = graphItemCount(graph);
  const text = evidenceText(evidence);
  if (n === 0) reasons.push('ProjectGraph 全部节点为空');
  if (/招标范围|施工范围|建设内容|工程名称|项目名称|工程量|清单|图纸/u.test(text) && graph.works.length === 0) reasons.push('缺少工程范围/主要工程内容 works');
  if (/工期|日历天|进度/u.test(text) && graph.schedule.length === 0) reasons.push('资料包含工期信息但 schedule 为空');
  if (/质量|验收|标准|规范/u.test(text) && graph.standards.length === 0) reasons.push('资料包含质量/验收/标准信息但 standards 为空');
  if (/材料|设备|机械|劳动力|工程量|清单/u.test(text) && graph.resources.length === 0) reasons.push('资料包含资源或工程量信息但 resources 为空');
  const sourced = [
    ...graph.works, ...graph.methods, ...graph.resources, ...graph.schedule,
    ...graph.standards, ...graph.risks, ...graph.requirements, ...graph.siteConditions,
  ].filter(item => (item.sourceFiles || []).length > 0).length + graph.addendumChanges.filter(item => item.sourceFile).length;
  if (n > 0 && sourced === 0) reasons.push('图谱节点缺少来源文件');
  return { ok: reasons.length === 0, reasons };
}

function stage(graph: ProjectGraph, cached = false): DocumentExecutionStage {
  const n = graph.works.length + graph.methods.length + graph.resources.length + graph.schedule.length + graph.standards.length + graph.risks.length + graph.requirements.length + graph.siteConditions.length + graph.addendumChanges.length;
  return displayStage({
    type: 'file_understanding', roleId: 'project-graph', status: 'success',
    message: `${cached ? '复用缓存：' : ''}${graph.works.length}工程 ${graph.methods.length}工法 ${graph.resources.length}资源 ${graph.schedule.length}节点 ${graph.standards.length}标准 ${graph.risks.length}风险 ${graph.requirements.length}要求 ${graph.siteConditions.length}条件 ${graph.addendumChanges.length}修正${graph.gaps.length ? ` ${graph.gaps.length}缺口` : ''}（${n}项）`,
    details: [...graph.works.slice(0, 3).map(w => w.name), ...graph.resources.slice(0, 3).map(r => r.name), ...graph.gaps.slice(0, 3)],
  }, { subtitle: '项目图谱分析' });
}

function failedStage(reasons: string[]): DocumentExecutionStage {
  return displayStage({
    type: 'file_understanding', roleId: 'project-graph', status: 'failed',
    message: `项目图谱分析失败：${reasons.slice(0, 3).join('；')}`,
    details: reasons.slice(0, 8),
  }, { subtitle: '项目图谱分析' });
}

export async function buildProjectGraph(input: {
  evidence: DocumentEvidence[];
  signal?: AbortSignal;
  timeoutMs?: number;
  projectRoot?: string;
  requirement?: string;
  templateId?: string;
  diagnostics?: DocumentGenerationDiagnostics;
}): Promise<{ graph?: ProjectGraph; stage: DocumentExecutionStage }> {
  throwIfAborted(input.signal);
  if (input.evidence.length === 0) {
    return { stage: failedStage(['未检索到项目证据，无法生成可信 LLM 项目图谱']) };
  }
  const cacheKey = graphCacheKey({ evidence: input.evidence, requirement: input.requirement, templateId: input.templateId, projectRoot: input.projectRoot });
  const cached = readCachedGraph(input.projectRoot, cacheKey);
  const cachedValidation = cached ? validateProjectGraph(cached, input.evidence) : undefined;
  if (cached && cachedValidation?.ok) return { graph: cached, stage: stage(cached, true) };

  const sorted = [...input.evidence].sort((a, b) => b.score - a.score);
  const hints = buildProjectGraphHintsFromEvidence(sorted);
  const failures: string[] = [];

  async function callDomain(domain: ProjectGraphDomain, extraReasons: string[] = []): Promise<ProjectGraph | undefined> {
    const evidence = selectDomainEvidence(sorted, domain, extraReasons.length ? 64000 : 52000);
    const raw = await callDocumentLlmJson<ProjectGraph>(
      `${docSystemPrefix(SYSTEM_PROMPT_BASE)}\n\n当前只抽取分域：${DOMAIN_PROMPTS[domain].title}。其他字段可以返回空数组，但本分域相关字段必须尽最大能力从证据中抽取。${extraReasons.length ? `\n本次定向修复原因：${extraReasons.join('；')}` : ''}`,
      buildDomainPrompt(evidence, domain, hints),
      { temperature: extraReasons.length ? 0 : 0.1, signal: input.signal, diagnostics: input.diagnostics },
    );
    throwIfAborted(input.signal);
    return normalize(raw, evidence);
  }

  async function buildByDomains(repairReasons: string[] = []) {
    const domains = Object.keys(DOMAIN_PROMPTS) as ProjectGraphDomain[];
    const graphs = await runWithAdaptiveConcurrency(domains, async domain => {
      try {
        const graph = await callDomain(domain, repairReasons);
        if (graph && graphItemCount(graph) > 0) return graph;
        failures.push(`${DOMAIN_PROMPTS[domain].title} 未抽取到有效节点`);
      } catch (err) {
        if (input.signal?.aborted) throw err;
        failures.push(`${DOMAIN_PROMPTS[domain].title} LLM 调用失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    }, { kind: 'llmRepair', targetWords: 4000, concurrency: Number(process.env.DOCUMENT_PROJECT_GRAPH_DOMAIN_CONCURRENCY || 2) });
    const validGraphs = graphs.filter((graph): graph is ProjectGraph => Boolean(graph));
    return validGraphs.length ? merge(validGraphs) : undefined;
  }

  try {
    const first = await buildByDomains();
    const validation = validateProjectGraph(first, sorted);
    if (validation.ok && first) {
      writeCachedGraph(input.projectRoot, cacheKey, first);
      return { graph: first, stage: stage(first) };
    }

    if (first && graphItemCount(first) > 0) {
      writeCachedGraph(input.projectRoot, cacheKey, first);
      return { graph: first, stage: stage(first) };
    }

    const retried = await buildByDomains([...validation.reasons, ...failures]);
    if (retried && graphItemCount(retried) > 0) {
      writeCachedGraph(input.projectRoot, cacheKey, retried);
      return { graph: retried, stage: stage(retried) };
    }
    return { stage: failedStage([...validation.reasons, ...failures]) };
  } catch (err) {
    if (input.signal?.aborted) throw err;
    console.error('[project-graph] failed:', err);
    return { stage: failedStage([err instanceof Error ? err.message : String(err), ...failures]) };
  }
}

export function projectGraphPrompt(graph: ProjectGraph): string {
  const out = ['## 项目资料图谱分析结果', ''];

  for (const w of graph.works) {
    if (out.length === 2) out.push('### 主要工程内容');
    out.push(`- **${w.name}**：${w.scope}`);
  }
  if (graph.works.length) out.push('');

  for (const m of graph.methods) {
    if (!out.includes('### 关键施工方法与工艺')) out.push('### 关键施工方法与工艺');
    out.push(`- **${m.name}**：${m.steps.filter(Boolean).join(' → ')}`);
  }
  if (graph.methods.length) out.push('');

  for (const r of graph.resources) {
    if (!out.includes('### 资源需求')) out.push('### 资源需求');
    const label = { material: '材料', equipment: '设备', labor: '劳动力' }[r.type] || '资源';
    out.push(`- [${label}] ${r.name}${r.spec ? `（${r.spec}）` : ''}${r.quantity ? ` ${r.quantity}${r.unit}` : ''}`);
  }
  if (graph.resources.length) out.push('');

  for (const x of graph.schedule) {
    if (!out.includes('### 工期与关键节点')) out.push('### 工期与关键节点');
    out.push(`- ${x.milestone}：${x.duration}（${x.startDate} ~ ${x.endDate}）`);
  }
  if (graph.schedule.length) out.push('');

  for (const s of graph.standards) {
    if (!out.includes('### 技术标准与验收要求')) out.push('### 技术标准与验收要求');
    out.push(`- **${s.code}**：${s.description}`);
  }
  if (graph.standards.length) out.push('');

  for (const r of graph.risks) {
    if (!out.includes('### 重点难点与风险')) out.push('### 重点难点与风险');
    out.push(`- **[${r.level}] ${r.risk}**：${r.mitigation}`);
  }
  if (graph.risks.length) out.push('');

  for (const x of graph.requirements) {
    if (!out.includes('### 特定要求')) out.push('### 特定要求');
    out.push(`- [${x.category}] ${x.detail}`);
  }
  if (graph.requirements.length) out.push('');

  for (const x of graph.siteConditions) {
    if (!out.includes('### 现场条件与约束')) out.push('### 现场条件与约束');
    out.push(`- ${x.condition}：${x.impact}`);
  }
  if (graph.siteConditions.length) out.push('');

  for (const a of graph.addendumChanges) {
    if (!out.includes('### 补疑修正')) out.push('### 补疑修正');
    out.push(`- "${a.original}" → "${a.revised}"`);
  }
  if (graph.addendumChanges.length) out.push('');

  for (const g of graph.gaps) {
    if (!out.includes('### 资料缺口')) out.push('### 资料缺口');
    out.push(`- ${g}`);
  }
  if (graph.gaps.length) out.push('');

  return out.join('\n');
}
