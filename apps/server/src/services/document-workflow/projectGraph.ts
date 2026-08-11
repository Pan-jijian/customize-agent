import type { DocumentEvidence, DocumentExecutionStage, ProjectGraph } from './types';
import { callDocumentLlmJson } from './llmClient';
import { throwIfAborted } from './utils';
import { displayStage } from './progress';

const SYSTEM_PROMPT = [
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
  '  gaps:            [string]',
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
  const ok = (f: unknown) => typeof f === 'string' && (files.has(f) || evidence.some(e => e.filePath.includes(f) || f.includes(e.filePath)));
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

function charCount(items: DocumentEvidence[]): number {
  return items.reduce((sum, e) => sum + e.content.length, 0);
}

function batch(items: DocumentEvidence[], maxChars: number): DocumentEvidence[][] {
  const batches: DocumentEvidence[][] = [];
  let cur: DocumentEvidence[] = [];
  let n = 0;
  for (const item of items) {
    if (n + item.content.length > maxChars && cur.length > 0) { batches.push(cur); cur = []; n = 0; }
    cur.push(item);
    n += item.content.length;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
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

function stage(graph: ProjectGraph): DocumentExecutionStage {
  const n = graph.works.length + graph.methods.length + graph.resources.length + graph.schedule.length + graph.standards.length + graph.risks.length + graph.requirements.length + graph.siteConditions.length + graph.addendumChanges.length;
  return displayStage({
    type: 'file_understanding', roleId: 'project-graph', status: 'success',
    message: `${graph.works.length}工程 ${graph.methods.length}工法 ${graph.resources.length}资源 ${graph.schedule.length}节点 ${graph.standards.length}标准 ${graph.risks.length}风险 ${graph.requirements.length}要求 ${graph.siteConditions.length}条件 ${graph.addendumChanges.length}修正${graph.gaps.length ? ` ${graph.gaps.length}缺口` : ''}（${n}项）`,
    details: [...graph.works.slice(0, 3).map(w => w.name), ...graph.resources.slice(0, 3).map(r => r.name), ...graph.gaps.slice(0, 3)],
  }, { subtitle: '项目图谱分析' });
}

export async function buildProjectGraph(input: {
  evidence: DocumentEvidence[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ graph?: ProjectGraph; stage: DocumentExecutionStage }> {
  throwIfAborted(input.signal);
  if (input.evidence.length === 0) return { graph: undefined, stage: displayStage({ type: 'file_understanding', roleId: 'project-graph', status: 'skipped', message: '无证据' }, { subtitle: '项目图谱分析' }) };

  try {
    const sorted = [...input.evidence].sort((a, b) => b.score - a.score);
    const total = charCount(sorted);

    // 一次 LLM 调用处理全部证据；证据过多时分批
    async function callAndNormalize(evidence: DocumentEvidence[]): Promise<ProjectGraph | undefined> {
      let raw = await callDocumentLlmJson<ProjectGraph>(SYSTEM_PROMPT, buildPrompt(evidence), { temperature: 0.1, signal: input.signal, timeoutMs: input.timeoutMs || 180000 });
      throwIfAborted(input.signal);
      let g = normalize(raw, evidence);
      // 重试：LLM 返回了 JSON 但字段全空（格式可能不对），用更短的提示再试一次
      if (raw && !g && JSON.stringify(raw).length > 10) {
        raw = await callDocumentLlmJson<ProjectGraph>(
          `${SYSTEM_PROMPT}\n\n重要：必须返回所有7个字段的数组。即使某个字段没有数据，也要返回空数组 []。`,
          buildPrompt(evidence),
          { temperature: 0, signal: input.signal, timeoutMs: input.timeoutMs || 180000 },
        );
        throwIfAborted(input.signal);
        g = normalize(raw, evidence);
      }
      return g;
    }

    if (total <= 80000) {
      const g = await callAndNormalize(sorted);
      return g && (g.works.length + g.methods.length + g.resources.length + g.schedule.length + g.standards.length + g.risks.length + g.requirements.length + g.siteConditions.length + g.addendumChanges.length) > 0
        ? { graph: g, stage: stage(g) }
        : { graph: undefined, stage: displayStage({ type: 'file_understanding', roleId: 'project-graph', status: 'fallback', message: '未产出足够结构化内容' }, { subtitle: '项目图谱分析' }) };
    }

    const batches = batch(sorted, 60000);
    const graphs: ProjectGraph[] = [];
    for (const b of batches) {
      throwIfAborted(input.signal);
      const raw = await callDocumentLlmJson<ProjectGraph>(SYSTEM_PROMPT, buildPrompt(b), { temperature: 0.1, signal: input.signal, timeoutMs: input.timeoutMs || 180000 });
      const g = normalize(raw, b);
      if (g) graphs.push(g);
    }
    if (graphs.length === 0) return { graph: undefined, stage: displayStage({ type: 'file_understanding', roleId: 'project-graph', status: 'fallback', message: '未产出足够结构化内容' }, { subtitle: '项目图谱分析' }) };

    const m = merge(graphs);
    const n = m.works.length + m.methods.length + m.resources.length + m.schedule.length + m.standards.length + m.risks.length + m.requirements.length + m.siteConditions.length + m.addendumChanges.length;
    return n > 0 ? { graph: m, stage: stage(m) } : { graph: undefined, stage: displayStage({ type: 'file_understanding', roleId: 'project-graph', status: 'fallback', message: '合并后无数据' }, { subtitle: '项目图谱分析' }) };
  } catch (err) {
    if (input.signal?.aborted) throw err;
    console.error('[project-graph] failed:', err);
    return { graph: undefined, stage: displayStage({ type: 'file_understanding', roleId: 'project-graph', status: 'fallback', message: '分析失败' }, { subtitle: '项目图谱分析' }) };
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
