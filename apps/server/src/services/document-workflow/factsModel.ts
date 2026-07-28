import * as fs from 'node:fs';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import { getProjectRoot } from '../knowledge/kbService';
import type { DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentFactsModel, DocumentTemplate, StructuredTableFact } from './types';
import { evidenceSatisfiesSpecField, specFactTargets } from './factMatching';
import { callDocumentLlmJson } from './llmClient';
import { stringifyFactValue, throwIfAborted } from './utils';

export function extractFacts(template: DocumentTemplate, evidence: DocumentEvidence[], spec?: AutoDocumentSpecPackage): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const field of specFactTargets(template, spec)) {
    const hit = evidence.find(item => evidenceSatisfiesSpecField(item, field));
    if (hit) facts[field.name] = `${hit.content.replace(/\s+/gu, ' ')}（来源：${hit.filePath}，角色：${hit.roleId || '未标注'}）`;
  }
  return facts;
}

export function extractStructuredTables(evidence: DocumentEvidence[]): StructuredTableFact[] {
  const tables: StructuredTableFact[] = [];
  const seen = new Set<string>();
  for (const item of evidence.filter(e => e.processingType === 'table')) {
    if (seen.has(item.filePath)) continue;
    seen.add(item.filePath);
    const root = getProjectRoot();
    const absolute = path.isAbsolute(item.filePath) ? item.filePath : fs.existsSync(path.join(root, 'knowledgeBase', item.filePath)) ? path.join(root, 'knowledgeBase', item.filePath) : path.join(root, item.filePath);
    const ext = path.extname(item.filePath).toLowerCase();
    if (fs.existsSync(absolute) && ['.xlsx', '.xls', '.csv'].includes(ext)) {
      try {
        const workbook = XLSX.readFile(absolute, { cellDates: true, sheetStubs: false });
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' }).map(row => row.map(cell => String(cell).trim()));
          const nonEmpty = matrix.filter(row => row.some(Boolean));
          if (nonEmpty.length < 2) continue;
          const headerIndex = nonEmpty.findIndex(row => row.filter(Boolean).length >= 2);
          if (headerIndex < 0) continue;
          const headers = nonEmpty[headerIndex].filter(Boolean);
          const rows = nonEmpty.slice(headerIndex + 1).map(row => row.slice(0, headers.length)).filter(row => row.some(Boolean));
          if (rows.length === 0) continue;
          tables.push({ tableType: item.roleId || 'table', sheet: sheetName, headers, rows, sourceFile: item.filePath, sourceRange: sheet['!ref'] });
        }
        continue;
      } catch {
        // 回退到文本解析
      }
    }
    const lines = item.content.split('\n').map(line => line.trim()).filter(Boolean);
    const tableLines = lines.filter(line => line.includes('|') || line.includes('\t') || line.includes(','));
    if (tableLines.length < 2) continue;
    const delimiter = tableLines[0].includes('|') ? '|' : tableLines[0].includes('\t') ? '\t' : ',';
    const rows = tableLines.map(line => line.split(delimiter).map(cell => cell.trim()).filter(Boolean)).filter(row => row.length > 1);
    if (rows.length < 2) continue;
    tables.push({ tableType: item.roleId || 'table', headers: rows[0], rows: rows.slice(1), sourceFile: item.filePath, sourceRange: item.sectionTitle });
  }
  return tables;
}

export function fieldExtractionPattern(name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`${escaped}[：:\\s]+([^\\n，。；;]+)`, 'u');
}

export function extractStructuredFacts(evidence: DocumentEvidence[], template: DocumentTemplate, spec?: AutoDocumentSpecPackage): DocumentFact[] {
  const dynamicPatterns = specFactTargets(template, spec).map(field => ({ field, pattern: fieldExtractionPattern(field.name) }));
  const facts: DocumentFact[] = [];
  for (const item of evidence) {
    for (const { field, pattern } of dynamicPatterns) {
      if (!evidenceSatisfiesSpecField(item, field)) continue;
      const match = item.content.match(pattern) || [undefined, item.content.replace(/\s+/gu, ' ')];
      const value = match?.[1]?.trim();
      if (value && !facts.some(fact => fact.fieldId === field.id && fact.value === value)) {
        facts.push({ key: field.name, fieldId: field.id, fieldName: field.name, value, sourceFile: item.filePath, roleId: item.roleId || 'unknown', processingType: item.processingType, confidence: item.score, sourceRef: { filePath: item.filePath, roleId: item.roleId || 'unknown', processingType: item.processingType, sectionTitle: item.sectionTitle } });
      }
    }
  }
  return facts;
}

export function reliableFactForTarget(fact: DocumentFact, target: ReturnType<typeof specFactTargets>[number]) {
  const value = stringifyFactValue(fact.value).trim();
  if (!value || value.length < 2) return false;
  if (value.length > 220 && fact.confidence < 0.8) return false;
  const identity = `${fact.fieldId || ''} ${fact.fieldName || ''} ${fact.key}`.toLowerCase();
  const matchesTarget = identity.includes(target.id.toLowerCase()) || identity.includes(target.name.toLowerCase());
  if (!matchesTarget) return false;
  if (fact.roleId === 'project_basic_fact' || fact.roleId?.startsWith('role-') || fact.sourceRef?.filePath) return fact.confidence >= 0.55;
  return fact.confidence >= 0.75;
}

export function shouldRunLlmFactExtraction(existingFacts: DocumentFact[], template: DocumentTemplate, spec?: AutoDocumentSpecPackage) {
  const targets = specFactTargets(template, spec).filter(target => target.required);
  if (targets.length === 0) return existingFacts.filter(fact => fact.confidence >= 0.75 && stringifyFactValue(fact.value).trim().length >= 2).length < 12;
  const covered = targets.filter(target => existingFacts.some(fact => reliableFactForTarget(fact, target))).length;
  return covered / targets.length < 0.9;
}

export async function extractFactsWithLlm(evidence: DocumentEvidence[], promptTexts: string, template: DocumentTemplate, spec?: AutoDocumentSpecPackage, signal?: AbortSignal): Promise<{ facts: DocumentFact[]; stages: DocumentExecutionStage[] }> {
  const stages: DocumentExecutionStage[] = [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: 'LLM JSON 抽取未启用或无可用模型' }];
  const maxChars = Math.max(12000, Math.floor(Number(process.env.DOCUMENT_FACT_EXTRACTION_MAX_CHARS ?? 45000)));
  const maxItems = Math.max(8, Math.floor(Number(process.env.DOCUMENT_FACT_EXTRACTION_MAX_ITEMS ?? 48)));
  let chars = 0;
  const sampleParts: string[] = [];
  for (const item of evidence.slice(0, maxItems)) {
    const content = stringifyFactValue(item.content).replace(/\s+/gu, ' ').slice(0, Math.max(800, Math.floor(maxChars / maxItems)));
    const part = `文件:${item.filePath}\n角色:${item.roleId || ''}\n处理:${item.processingType || ''}\n内容:${content}`;
    if (sampleParts.length > 0 && chars + part.length > maxChars) break;
    chars += part.length;
    sampleParts.push(part);
  }
  const sample = sampleParts.join('\n\n---\n\n');
  if (!sample.trim()) return { facts: [], stages };
  throwIfAborted(signal);
  const targets = specFactTargets(template, spec);
  const schemaText = targets.map(field => `- id=${field.id} name=${field.name} type=auto required=${field.required} sourceRoleIds=${field.sourceRoleIds.join(',') || '不限'} hint=${field.extractionHint || '无'}`).join('\n');
  const llm = await callDocumentLlmJson<{ facts?: Array<{ fieldId?: string; fieldName?: string; key: string; value: string; sourceFile?: string; roleId?: string; processingType?: string; confidence?: number }> }>(
    promptTexts || '你是文档事实抽取器。',
    `请严格按下面的动态事实 schema 从资料中抽取事实。只抽取资料明确支持的内容；如果字段限定 sourceRoleIds，必须优先来自对应文件角色；事实取舍和冲突处理遵循规范包字段说明、文件角色和提示词角色配置。\n返回 {"facts":[{"fieldId":"...","fieldName":"...","key":"...","value":"...","sourceFile":"...","roleId":"...","processingType":"reference","confidence":0.8}]}。\n\n动态事实 schema：\n${schemaText}\n\n资料：\n${sample}`,
    { signal },
  );
  throwIfAborted(signal);
  if (!llm?.facts?.length) return { facts: [], stages };
  return {
    facts: llm.facts.filter(item => item.key && item.value).map(item => {
      const field = targets.find(target => target.id === item.fieldId || target.name === item.fieldName || target.name === item.key);
      return {
        key: field?.name || item.key,
        fieldId: field?.id || item.fieldId,
        fieldName: field?.name || item.fieldName,
        value: stringifyFactValue(item.value),
        sourceFile: item.sourceFile || '',
        roleId: item.roleId || 'llm',
        processingType: item.processingType,
        confidence: item.confidence ?? 0.8,
        sourceRef: { filePath: item.sourceFile || '', roleId: item.roleId || 'llm', processingType: item.processingType },
      };
    }),
    stages: [{ type: 'fact_extraction', roleId: 'llm-json', status: 'success', message: `LLM 按动态 schema 抽取 ${llm.facts.length} 条事实` }],
  };
}

export function normalizedFactValue(value: unknown) {
  return stringifyFactValue(value).replace(/\s+/gu, '').replace(/[，。,.;；：:]/gu, '').toLowerCase();
}

function conflictComparableFactValue(value: unknown) {
  const raw = stringifyFactValue(value).trim();
  const normalized = normalizedFactValue(raw);
  if (!normalized || normalized.length > 80) return '';
  if (!/[\d年月日%]|合格|一星|二星|三星|总价合同|单价合同|承台|框架|装配式/u.test(raw)) return '';
  return normalized;
}

function conflictComparableField(key: string) {
  return /项目名称|工程名称|招标人|建设地点|建筑面积|结构形式|层数|工期|质量标准|合同价格形式|绿色建筑等级|投标有效期|质保期|税率/u.test(key);
}

export function detectFactConflicts(facts: DocumentFact[], spec?: AutoDocumentSpecPackage) {
  const conflictKeys = (spec?.factFields.map(field => field.name) || [...new Set(facts.map(fact => fact.key))]).filter(conflictComparableField);
  const conflicts: string[] = [];
  for (const key of conflictKeys) {
    const items = facts.filter(fact => fact.key === key || fact.fieldName === key);
    const values = new Map<string, DocumentFact[]>();
    for (const item of items) {
      const normalized = conflictComparableFactValue(item.value);
      if (!normalized) continue;
      values.set(normalized, [...(values.get(normalized) || []), item]);
    }
    if (values.size > 1) {
      const detail = [...values.values()].slice(0, 4).map(group => `${stringifyFactValue(group[0]!.value).slice(0, 120)}（${[...new Set(group.map(item => item.sourceFile))].slice(0, 3).join('、')}）`).join(' vs ');
      conflicts.push(`事实冲突：${key} 存在多个来源值：${detail}`);
    }
  }
  return conflicts.slice(0, 8);
}

export function buildSchemaFacts(facts: DocumentFact[], spec?: AutoDocumentSpecPackage) {
  const schemaFacts: Record<string, DocumentFact[]> = {};
  for (const field of spec?.factFields || []) {
    schemaFacts[field.id] = facts.filter(fact => fact.fieldId === field.id || fact.key === field.name || fact.fieldName === field.name);
  }
  return schemaFacts;
}

export function buildFactsModel(facts: DocumentFact[], tables: StructuredTableFact[] = [], missingItems: string[] = [], spec?: AutoDocumentSpecPackage): DocumentFactsModel {
  const byKeys = (keys: string[]) => facts.filter(fact => keys.some(key => fact.key.includes(key)));
  const byProcessing = (type: string) => facts.filter(fact => fact.processingType === type || fact.roleId.includes(type));
  const preciseFacts = facts.filter(fact => /\d|DN|φ|Φ|mm|cm|m²|m3|MPa|kPa|℃|%|GB|ISO|IEC|IEEE|RFC|API|台|套|个|项|批|次|页|份|人|㎡/iu.test(`${fact.key} ${fact.value}`));
  const billFacts = facts.filter(fact => fact.processingType === 'table' || /bill|boq|table|sheet|data|表格|列表|明细|数据/u.test(`${fact.roleId} ${fact.sourceFile}`));
  return {
    project: facts,
    schedule: byKeys(['工期', '开工', '竣工', '节点']),
    quality: byKeys(['质量']),
    safety: byKeys(['安全']),
    resources: byKeys(['劳动力', '材料', '机械', '设备']),
    tables,
    drawings: byProcessing('drawing'),
    bills: billFacts,
    preciseFacts,
    rules: byProcessing('rule'),
    specifications: byProcessing('specification'),
    schemaFacts: buildSchemaFacts(facts, spec),
    missing: [...new Set(missingItems)],
    conflicts: detectFactConflicts(facts, spec),
  };
}
