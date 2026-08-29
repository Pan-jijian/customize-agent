import * as fs from 'node:fs';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import { getProjectKbRoot, getProjectRoot } from '../knowledge/kbService';
import { DEFAULT_DOCUMENT_DOMAIN_PROFILE, factFieldForLabel, isDiagnosticFactValue, isForbiddenFactValue, isLowConfidenceFactValue, type DocumentDomainProfile, type FactFieldProfile } from '../document-core/documentDomainProfileService';
import type { ChapterFactNeed, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, ResolvedFactNeed, StructuredTableFact } from './types';
import { evidenceSatisfiesSpecField, specFactTargets } from './factMatching';
import { normalizeEngineeringTextForFactMatch } from './engineeringUnits';
import { callDocumentLlmJson } from './llmClient';
import { HAS_QUANTIFIED_VALUE_RE, PRECISE_TOKEN_RE } from './parameterPatterns';
import { stringifyFactValue, throwIfAborted } from './utils';
import { buildSemanticSimilarity } from './semanticSimilarity';

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
  for (const item of evidence.filter(e => e.processingType === 'table' || e.processingType === 'structured_data' || e.processingType === 'bill_of_quantities')) {
    if (seen.has(item.filePath)) continue;
    seen.add(item.filePath);
    const root = getProjectRoot();
    const kbRoot = getProjectKbRoot(root);
    const absolute = path.isAbsolute(item.filePath) ? item.filePath : fs.existsSync(path.join(kbRoot, item.filePath)) ? path.join(kbRoot, item.filePath) : path.join(root, item.filePath);
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
  // 规模/工期类字段值常为混合口径长句（“建设规模：总占地面积约10970平方米，单体建筑面积28570.36平方米”、
  // “计划工期：…起，540日历天”），“，”截断会把值裁成纯占地/无数字口径（round-21 S6 实测：
  // 截断值“项目总占地面积约10970平方米”进入事实主表首位，确定性修复器以之为建筑总量期望口径，
  // 把正文正确的 28570.36 反向改成 10970）；此类字段改以句末标点终止，与
  // extractProjectBasicFactsFromEvidence 的 project_scale 长窗口径一致。
  // 窗口允许跨行（PDF 复制文本常在数字与单位之间换行，历史缺陷：事实值被截成
  // “单体建筑面积28570.36平方”缺“米”，正文随之产出缺单位表述）；跨行吞并由
  // extractStructuredFacts 的空白归一化 + 下一字段名截断兜底
  const body = /规模|scale|工期|周期/iu.test(name) ? '[^。；;]{2,220}' : '[^\\n，。；;]+';
  return new RegExp(`${escaped}[：:\\s]+(${body})`, 'u');
}

export function extractStructuredFacts(evidence: DocumentEvidence[], template: DocumentTemplate, spec?: AutoDocumentSpecPackage): DocumentFact[] {
  const dynamicTargets = specFactTargets(template, spec);
  const dynamicPatterns = dynamicTargets.map(field => ({ field, pattern: fieldExtractionPattern(field.name) }));
  // 跨行吞并防护：长窗口跨行后可能吞入下一字段名内容（“建设规模：…米\n计划工期：…”），
  // 值内出现其他字段名+冒号时截断到该字段名之前
  const otherFieldNames = dynamicTargets.map(field => field.name).filter(Boolean);
  const facts: DocumentFact[] = [];
  for (const item of evidence) {
    for (const { field, pattern } of dynamicPatterns) {
      if (!evidenceSatisfiesSpecField(item, field)) continue;
      const match = item.content.match(pattern);
      let value = match?.[1]?.trim();
      if (!value) continue;
      // 跨行空白归一化：修复“28570.36平方\n米”被截成缺“米”的历史缺陷（PDF 数字与单位之间换行）；
      // round-23 P0-3 补强：PDF 标题标记「###」夹在句中间（“平方\n\n### 米”）时先移除标记再归一化，
      // 否则值携带“###”进入 canonical 与写作层（实测坏值“28570.36平方2.8”传播至正文表格）
      value = cleanPdfHeadingNoise(value).replace(/\s+/gu, '');
      const nextFieldIndex = otherFieldNames.filter(name => name !== field.name).map(name => value!.indexOf(name)).filter(index => index > 0);
      if (nextFieldIndex.length > 0) value = value.slice(0, Math.min(...nextFieldIndex));
      if (value && value.length <= 220 && !isForbiddenFactValue(DEFAULT_DOCUMENT_DOMAIN_PROFILE, value) && !isDiagnosticFactValue(DEFAULT_DOCUMENT_DOMAIN_PROFILE, value) && !facts.some(fact => fact.fieldId === field.id && fact.value === value)) {
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

export async function extractFactsWithLlm(evidence: DocumentEvidence[], promptTexts: string, template: DocumentTemplate, spec?: AutoDocumentSpecPackage, signal?: AbortSignal, diagnostics?: DocumentGenerationDiagnostics): Promise<{ facts: DocumentFact[]; stages: DocumentExecutionStage[] }> {
  const stages: DocumentExecutionStage[] = [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: 'LLM JSON 抽取未启用或无可用模型' }];
  const maxChars = Math.max(12000, Math.floor(Number(process.env.DOCUMENT_FACT_EXTRACTION_MAX_CHARS ?? 45000)));
  const maxItems = Math.max(8, Math.floor(Number(process.env.DOCUMENT_FACT_EXTRACTION_MAX_ITEMS ?? 48)));
  let chars = 0;
  const sampleParts: string[] = [];
  // 按分数排序取最重要的证据（而非前 maxItems 个）
  const topEvidence = [...evidence].sort((a, b) => b.score - a.score).slice(0, maxItems);
  for (const item of topEvidence) {
    // round-23 P0-3：LLM 提取输入先清 PDF 标题标记噪声，防止模型面对夹断乱行输出截断坏值
    const content = cleanPdfHeadingNoise(stringifyFactValue(item.content)).replace(/\s+/gu, ' ').slice(0, Math.max(800, Math.floor(maxChars / maxItems)));
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
    { signal, maxTokens: 1800, temperature: 0.1, diagnostics },
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
  return normalizeEngineeringTextForFactMatch(stringifyFactValue(value));
}

function hasCorruptTextMarkers(text: string) {
  const corruptMarks = text.match(/�|￿/gu)?.length || 0;
  return corruptMarks >= 2 || Array.from(text).some(char => {
    const code = char.charCodeAt(0);
    return code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13);
  });
}

/** 程序性短语语义原型（h5 事实候选过滤）：投标程序/行政手续类文本基准，bge 余弦 ≥ 阈值判定为程序性文本 */
const PROCEDURAL_VALUE_PROTOTYPES = [
  '投标保证金的金额、收款账户名称、开户行与账号',
  '电子投标文件加密方式与解密方式',
  '开标时间、开标地点与开标程序',
  '评标委员会组成与评标办法',
  '招标人联系人、联系电话、邮箱与地址',
  '投标文件递交方式与递交截止时间',
  '空白表格填写说明与上传下载指引',
  '公共资源交易平台监督管理部门',
];
/** 程序性词面特征（召回触发）：命中后经 bge 语义复核才过滤——放行含程序字样的实质条款句（如质量保证金金额） */
const PROCEDURAL_LEXICAL_HINTS_RE = /签章|盖章|联系人|联系电话|电话|邮箱|解密方式|开标时间|开标地点|评标办法|评标委员会|投标保证金|保证金账户|电子交易系统|空白|填写|上传|下载|递交方式|递交截止|公共资源交易监督管理|监管部门|开评标程序|采购范围|是否|符合/u;
const PROCEDURAL_VALUE_THRESHOLD = 0.6;

function conflictComparableFactValue(value: unknown, profile: DocumentDomainProfile, isProcedural?: (raw: string) => boolean) {
  const raw = stringifyFactValue(value).trim();
  if (isDiagnosticFactValue(profile, raw) || isForbiddenFactValue(profile, raw)) return '';
  if (hasCorruptTextMarkers(raw)) return '';
  // 纯结构过滤（表格行分隔/标题标记/引用跳转/内部摘要标记）保留正则：属结构判定而非语义判断
  if (/\|/u.test(raw) || /^#+\s*/u.test(raw)) return '';
  if (/见(?:招标公告|投标人须知|前附表|本项目|补疑)|资料参数行摘要/u.test(raw)) return '';
  const duration = raw.match(/\d+\s*日历天/u)?.[0]?.replace(/\s+/gu, '');
  if (duration && /工期|日历天|开工日期|竣工/u.test(raw)) return duration;
  const normalized = normalizedFactValue(raw);
  if (!normalized || normalized.length > 80) return '';
  if (!/[\d年月日%]|合格|一星|二星|三星|总价合同|单价合同|承台|框架|装配式/u.test(raw)) return '';
  // 程序性词面命中 → bge 语义复核：与程序性原型余弦 ≥0.6 才过滤，实质条款句放行
  if (PROCEDURAL_LEXICAL_HINTS_RE.test(raw) && isProcedural?.(raw)) return '';
  return normalized;
}

function conflictComparableField(key: string, profile: DocumentDomainProfile) {
  const field = factFieldForLabel(profile, key);
  if (field) return field.cardinality === 'single' && field.conflictPolicy !== 'ignore' && field.conflictPolicy !== 'allow_multiple';
  return /项目名称|工程名称|招标人|建设地点|建筑面积|结构形式|层数|工期|质量标准|合同价格形式|绿色建筑等级|投标有效期|质保期/u.test(key);
}

export async function detectFactConflicts(facts: DocumentFact[], spec?: AutoDocumentSpecPackage, profile: DocumentDomainProfile = DEFAULT_DOCUMENT_DOMAIN_PROFILE, embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<string[]> {
  const conflictKeys = (spec?.factFields.map(field => field.name) || [...new Set(facts.map(fact => fact.fieldName || fact.key))]).filter(key => conflictComparableField(key, profile));
  // h5 程序性语义复核：词面特征命中的候选值 vs 程序性原型 bge 余弦（语义模型恒可用，空候选由恒零函数承接，无降级分支）
  const proceduralCandidates = [...new Set(facts.map(fact => stringifyFactValue(fact.value).trim()).filter(raw => PROCEDURAL_LEXICAL_HINTS_RE.test(raw)))];
  const proceduralSimilarity = await buildSemanticSimilarity(proceduralCandidates, PROCEDURAL_VALUE_PROTOTYPES, embedDocuments);
  const isProcedural = (raw: string) => PROCEDURAL_VALUE_PROTOTYPES.some(prototype => proceduralSimilarity(raw, prototype) >= PROCEDURAL_VALUE_THRESHOLD);
  const conflicts: string[] = [];
  for (const key of conflictKeys) {
    const items = facts.filter(fact => fact.key === key || fact.fieldName === key || factFieldForLabel(profile, fact.fieldName || fact.key)?.name === key);
    const values = new Map<string, DocumentFact[]>();
    for (const item of items) {
      const normalized = conflictComparableFactValue(item.value, profile, isProcedural);
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

/**
 * PDF 复制文本标题标记噪声清洗（round-23 P0-3）：PDF 导出文本常把文档标题标记
 * 「###」插入句子中间（如「28570.36平方\n\n### 米（其中…」），把数字与单位、句子
 * 拦腰打断。历史缺陷：LLM 提取通道面对乱行文本输出截断坏值「28570.36平方2.8」，
 * 正则通道停在换行产出缺「米」的「28570.36平方」，canonical 混合口径净化后全链路传播。
 * 清洗规则：移除 1-6 级标题标记及紧邻空白（含换行），使夹断的句子重新闭合
 * （「平方\n\n### 米」→「平方米」）；仅移除标记本身，不触碰正文内容。
 */
export function cleanPdfHeadingNoise(text: string) {
  return stringifyFactValue(text).replace(/\s*[#＃]{1,6}\s*/gu, '');
}

export function normalizeOcrFactText(text: string) {
  return stringifyFactValue(text)
    .replace(/[\u00A0\u2002-\u200B\u3000]/gu, ' ')
    .replace(/([\p{Script=Han}])\s+([\p{Script=Han}])/gu, '$1$2')
    .replace(/(\d)\s+(日历天|天|个月|月|年|万元|元|㎡|平方米|米|m|mm|MPa|kPa|%)/giu, '$1$2')
    .replace(/(合同|投资|工程|项目)\s*估\s*算\s*(?:价格|价)/gu, '$1估算价')
    .replace(/计划\s*工\s*期/gu, '计划工期')
    .replace(/合同\s*工\s*期/gu, '合同工期')
    .replace(/质量\s*标\s*准/gu, '质量标准')
    .replace(/建设\s*地\s*点/gu, '建设地点')
    .replace(/建设\s*规\s*模/gu, '建设规模')
    .replace(/招标\s*范\s*围/gu, '招标范围')
    .replace(/最高\s*投\s*标\s*限\s*价/gu, '最高投标限价')
    .replace(/招标\s*控\s*制\s*价/gu, '招标控制价')
    .replace(/[：:]\s*/gu, '：')
    .replace(/\s+/gu, ' ')
    .trim();
}

const PROJECT_BASIC_FACT_PATTERNS = [
  { fieldId: 'project_name', key: '项目名称', fieldName: '项目名称', pattern: /(?:项目名称|工程名称|招标项目名称)[：:\s为是]+([^\n。；;]{2,120})/u },
  { fieldId: 'project_code', key: '项目编号', fieldName: '项目编号', pattern: /(?:项目编号|招标项目编号|工程编号)[：:\s为是]+([A-Za-z0-9\-_.（）()]{4,80})/u },
  { fieldId: 'owner', key: '招标人', fieldName: '招标人', pattern: /(?:招标人|建设单位|发包人)[：:\s为是]+([^\n。；;]{2,120})/u },
  { fieldId: 'project_location', key: '建设地点', fieldName: '建设地点', pattern: /建设地点[：:\s为是]+([^\n。；;]{2,100})/u },
  { fieldId: 'project_scale', key: '建设规模', fieldName: '建设规模', pattern: /建设规模[：:\s为是]+([^\n。；;]{2,220})/u },
  // 嵌入句式补充：补疑/清单等文件常写“总建筑面积约4646m2”（无“建设规模：”标签），
  // 若无此模式则总量口径事实缺失，源级冲突裁决无从触发（历史缺陷：补疑更新面积未进事实主表）；
  // 目标性表述负分支（不捕获）：补疑/澄清中的“拟建设总建筑面积约5000㎡”“计划总建筑面积X㎡”是业务目标
  // 而非确定口径，不得进入事实主表成为裁决候选
  { fieldId: 'project_scale', key: '建设规模', fieldName: '建设规模', pattern: /(?:拟|计划|规划|目标|力争|预计|期望|远期|未来|设想|建议|预期|争取)[^，,。；;\n]{0,12}?(?<![地上地下])总?建筑面积(?:约|约为|约计|共计|为)?\s*[\d,，.]+\s*(?:㎡|m²|m2|平方米)|((?<![地上地下])总?建筑面积(?:约|约为|约计|共计|为)?\s*[\d,，.]+\s*(?:㎡|m²|m2|平方米))/u },
  { fieldId: 'project_scope', key: '招标范围', fieldName: '招标范围', pattern: /招标范围[：:\s为是]+([^\n。；;]{2,220})/u },
  { fieldId: 'schedule_requirement', key: '计划工期', fieldName: '周期要求', pattern: /(?:(?:计划工期|合同工期|总工期)[：:\s为是约]*|工期[：:\s为是约]+)([^\n。；;]{0,40}?\d+(?:\.\d+)?\s*(?:日历天|天|个月|月|年)(?:[^\n。；;]{0,30})?)/u },
  { fieldId: 'quality_standard', key: '质量标准', fieldName: '质量标准', pattern: /质量标准[：:\s为是]+([^\n。；;]{1,60})/u },
  { fieldId: 'project_investment_estimate', key: '合同估算价格', fieldName: '项目投资估算', pattern: /(?:合同估算价格|合同估算价|投资估算|估算价格|工程估算价|项目估算价|最高投标限价|招标控制价)[：:\s为是约]+([^\n。；;]{0,80}?\d+(?:\.\d+)?\s*(?:万元|元))/u },
];

export function isValidProjectBasicFactValue(fieldId: string | undefined, rawValue: unknown) {
  const value = normalizeOcrFactText(stringifyFactValue(rawValue));
  if (!fieldId || !value || value.length > 260) return false;
  if (/###|第\s*\d+\s*页|共\s*\d+\s*页|律师代理费|投标文件的编制|备选投标方案|投标将被否决|投标人提供|投标有效期|电子交易系统|公共资源交易监督管理部门|中标候选|评标委员会|实质性内容作出响应/u.test(value)) return false;
  if (/签章|盖章|联系人|联系电话|电话|邮箱|解密|开标|评标|保证金|交易系统|空白|填写|上传|下载|递交/u.test(value)) return false;
  if (fieldId === 'schedule_requirement') return value.length <= 90 && /\d+(?:\.\d+)?\s*(?:日历天|天|个月|月|年)/u.test(value);
  if (fieldId === 'quality_standard') return value.length <= 40 && /合格|优良|一次性验收|国家.*验收|达到/u.test(value) && !/工期|投标|技术标准|\d[.．、]/u.test(value);
  if (fieldId === 'owner') return value.length >= 4 && value.length <= 80 && /公司|局|委员会|中心|处|院|所|校|集团|有限|股份|责任|管理/u.test(value) && !/将报|监督管理部门|投标人|中标|负责解释|见招标|详见|空白|填写/u.test(value);
  if (fieldId === 'project_location') return value.length <= 120 && !/见招标公告|详见|投标/u.test(value);
  if (fieldId === 'project_scope') return value.length <= 220 && !/^[（(]\s*\d+[)）]/u.test(value) && !/具备.{0,24}(?:证书|考核合格|安全生产考核)/u.test(value) && !/^见(?:招标|投标人|前附)/u.test(value);
  if (fieldId === 'project_code') return /^[A-Za-z0-9\-_.（）()]+$/u.test(value);
  if (fieldId === 'project_investment_estimate') return value.length <= 100 && /\d+(?:\.\d+)?\s*(?:万元|元)/u.test(value);
  return value.length <= 220;
}

export function extractProjectBasicFactsFromEvidence(evidence: DocumentEvidence[]): DocumentFact[] {
  const facts: DocumentFact[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    // round-23 P0-3：正则通道同样先清 PDF 标题标记噪声（“平方\n\n### 米”→“平方米”），
    // 否则 project_scale pattern [^\n。；;] 停在“平方”后换行，产出缺“米”截断值
    const normalizedContent = cleanPdfHeadingNoise(normalizeOcrFactText(item.content));
    const lines = normalizedContent.split(/\r?\n/u).flatMap(line => {
      const compact = line.replace(/\s+/gu, ' ').trim();
      return compact.length > 260 ? compact.split(/(?=\d+(?:\.\d+)?\s*[^\s：:]{2,12}[：:])/u) : [compact];
    }).filter(Boolean);
    for (const line of lines) {
      if (/报价明细|综合单价|税率|增值税|利润|结算/u.test(line) && !/合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u.test(line)) continue;
      for (const rule of PROJECT_BASIC_FACT_PATTERNS) {
        const match = rule.pattern.exec(line);
        const value = match?.[1]?.trim();
        if (!value || !isValidProjectBasicFactValue(rule.fieldId, value)) continue;
        const key = `${item.filePath}:${rule.fieldId}:${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({
          key: rule.key,
          fieldName: rule.fieldName,
          fieldId: rule.fieldId,
          value,
          sourceFile: item.filePath,
          roleId: item.roleId || 'project_basic_fact',
          processingType: item.processingType || 'reference',
          confidence: Math.max(0.82, item.score || 0.82),
          sourceRef: { filePath: item.filePath, roleId: item.roleId || 'project_basic_fact', processingType: item.processingType || 'reference', sectionTitle: item.sectionTitle },
        });
      }
    }
  }
  return facts.slice(0, 80);
}

export function extractPreciseFactsFromEvidence(evidence: DocumentEvidence[], profile: DocumentDomainProfile = DEFAULT_DOCUMENT_DOMAIN_PROFILE): DocumentFact[] {
  const facts: DocumentFact[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    const sourceContext = `${item.roleId || ''} ${item.processingType || ''} ${item.filePath} ${item.sectionTitle || ''}`;
    const sourceLooksUseful = /drawing|table|bill|boq|draw|data|sheet|spec|standard|record|report|表格|数据|规格|参数|标准|记录|报告|清单|图纸|说明/u.test(sourceContext);
    if (!sourceLooksUseful && item.score < 0.75) continue;
    const content = stringifyFactValue(item.content).replace(/\s+/gu, ' ');
    for (const match of content.matchAll(PRECISE_TOKEN_RE)) {
      const token = match[0].trim();
      if (!token || isForbiddenFactValue(profile, token)) continue;
      const start = Math.max(0, (match.index || 0) - 40);
      const end = Math.min(content.length, (match.index || 0) + token.length + 40);
      const context = content.slice(start, end);
      if (isDiagnosticFactValue(profile, context) || isLowConfidenceFactValue(profile, context)) continue;
      const key = `${item.filePath}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({
        key: '精确参数',
        fieldName: '技术参数',
        fieldId: 'technical_parameter',
        value: token,
        sourceFile: item.filePath,
        roleId: item.roleId || 'precise_fact',
        processingType: item.processingType || 'precise',
        confidence: Math.max(0.7, item.score || 0.7),
        sourceRef: { filePath: item.filePath, roleId: item.roleId || 'precise_fact', processingType: item.processingType || 'precise', sectionTitle: item.sectionTitle },
      });
    }
  }
  return facts.slice(0, 240);
}

export function buildSchemaFacts(facts: DocumentFact[], spec?: AutoDocumentSpecPackage) {
  const schemaFacts: Record<string, DocumentFact[]> = {};
  for (const field of spec?.factFields || []) {
    schemaFacts[field.id] = facts.filter(fact => fact.fieldId === field.id || fact.key === field.name || fact.fieldName === field.name);
  }
  return schemaFacts;
}

function factText(fact: DocumentFact) {
  return `${fact.key} ${fact.fieldName || ''} ${fact.value} ${fact.roleId} ${fact.processingType || ''} ${fact.sourceFile}`;
}

function isProjectBasicCommercialFact(text: string) {
  return /合同估算价|合同估算价格|投资估算|估算价格|工程估算价|项目估算价|最高投标限价|招标控制价/u.test(text);
}

function isGenerationExcludedFact(fact: DocumentFact) {
  const text = factText(fact);
  if (isProjectBasicCommercialFact(text)) return false;
  return /投标保证金|发票类型|开标时间|公共资源交易监督管理|不良行为记录|投诉举报|资质投诉|投标承诺|违约金|中标服务费|交易平台|保证金账户|投标有效期|报价明细|投标报价|单价|合价|税率|增值税|利润|结算/u.test(text);
}

function buildEvidenceFactIndex(facts: DocumentFact[], preciseFacts: DocumentFact[], billFacts: DocumentFact[], profile: DocumentDomainProfile) {
  const diagnostics = facts.filter(fact => isDiagnosticFactValue(profile, factText(fact)) || isLowConfidenceFactValue(profile, factText(fact)));
  const reliableFacts = facts.filter(fact => {
    const text = factText(fact);
    return fact.confidence >= 0.58 && !isGenerationExcludedFact(fact) && !isForbiddenFactValue(profile, text) && !isDiagnosticFactValue(profile, text) && !isLowConfidenceFactValue(profile, text);
  });
  const parameterFacts = [...preciseFacts.filter(fact => !isGenerationExcludedFact(fact)), ...reliableFacts.filter(fact => HAS_QUANTIFIED_VALUE_RE.test(factText(fact)))]
    .filter((fact, index, array) => array.findIndex(item => item.sourceFile === fact.sourceFile && item.value === fact.value && item.key === fact.key) === index)
    .slice(0, 360);
  const tableFacts = reliableFacts.filter(fact => fact.processingType === 'table' || /table|sheet|表格|清单|明细|数据|参数行摘要/u.test(factText(fact)));
  const drawingFacts = reliableFacts.filter(fact => fact.processingType === 'drawing' || /drawing|draw|dwg|图纸|设计|尺寸|标高|管径|做法/u.test(factText(fact)));
  return { reliableFacts: reliableFacts.slice(0, 500), parameterFacts, tableFacts: tableFacts.slice(0, 240), drawingFacts: drawingFacts.slice(0, 240), billFacts: billFacts.slice(0, 240), diagnostics: diagnostics.slice(0, 120) };
}

function normalizeNeedText(value: string) {
  return stringifyFactValue(value).replace(/\s+/gu, ' ').trim();
}

function factNeedId(source: ChapterFactNeed['source'], label: string, fieldId?: string) {
  const raw = `${source}:${fieldId || label}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '');
  return raw || `${source}-${Math.random().toString(36).slice(2, 8)}`;
}

function needQueries(label: string, extra: string[] = []) {
  return [...new Set([label, ...extra, ...label.split(/[\s、，。；;:：/\\_-]+/u)].map(normalizeNeedText).filter(item => item.length >= 2))];
}

function addNeed(needs: ChapterFactNeed[], profile: DocumentDomainProfile, need: Omit<ChapterFactNeed, 'id' | 'queries'> & { id?: string; queries?: string[] }) {
  const label = normalizeNeedText(need.label);
  if (!label || isForbiddenFactValue(profile, label) || isDiagnosticFactValue(profile, label)) return;
  const id = need.id || factNeedId(need.source, label, need.fieldId);
  const queries = need.queries?.length ? need.queries.map(normalizeNeedText).filter(Boolean) : needQueries(label);
  const existing = needs.find(item => item.id === id || item.label === label);
  if (existing) {
    existing.required = existing.required || need.required;
    existing.queries = [...new Set([...existing.queries, ...queries])];
    return;
  }
  needs.push({ ...need, id, label, queries });
}

function addFieldNeed(needs: ChapterFactNeed[], profile: DocumentDomainProfile, field: FactFieldProfile, source: ChapterFactNeed['source'], required: boolean, extraQueries: string[] = []) {
  if (field.usagePolicy === 'do_not_use' || field.usagePolicy === 'diagnostic_only' || field.derivationPolicy === 'forbidden') return;
  addNeed(needs, profile, {
    label: field.name,
    category: field.category,
    required,
    source,
    fieldId: field.id,
    queries: needQueries(field.name, [...field.aliases, ...extraQueries]),
  });
}

export function buildChapterFactNeeds(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; spec?: AutoDocumentSpecPackage; profile?: DocumentDomainProfile; promptTexts?: string; requirement?: string; plan?: { requiredContents?: string[]; evidenceNeeds?: string[] } }) {
  const profile = input.profile || DEFAULT_DOCUMENT_DOMAIN_PROFILE;
  const needs: ChapterFactNeed[] = [];
  const chapterContext = [input.template.name, input.template.outputTitle, input.chapter.title, input.chapter.purpose, ...(input.chapter.sections || [])].filter(Boolean).join(' ');
  const specRule = input.spec?.chapterRules.find(rule => rule.id === input.chapter.id || rule.title === input.chapter.title);
  for (const fact of input.chapter.requiredFacts || []) addNeed(needs, profile, { label: fact, category: factFieldForLabel(profile, fact)?.category || 'required', required: true, source: 'template' });
  for (const section of input.chapter.sections || []) addNeed(needs, profile, { label: section, category: 'section', required: false, source: 'section', queries: needQueries(section, [input.chapter.title]) });
  for (const item of input.plan?.requiredContents || []) addNeed(needs, profile, { label: item, category: factFieldForLabel(profile, item)?.category || 'plan', required: true, source: 'plan' });
  for (const item of input.plan?.evidenceNeeds || []) addNeed(needs, profile, { label: item, category: factFieldForLabel(profile, item)?.category || 'plan', required: true, source: 'plan' });
  for (const id of specRule?.requiredFactIds || []) {
    const field = input.spec?.factFields.find(item => item.id === id);
    if (field) addNeed(needs, profile, { label: field.name, category: factFieldForLabel(profile, field.name)?.category || 'spec', required: true, source: 'spec', fieldId: field.id, queries: needQueries(field.name, [field.extractionHint || '', field.validationHint || '']) });
  }
  for (const field of input.spec?.factFields || []) {
    if (!field.required) continue;
    const profileField = factFieldForLabel(profile, field.name);
    const fieldText = `${field.name} ${field.extractionHint || ''} ${field.validationHint || ''}`;
    const related = chapterContext.includes(field.name) || needQueries(field.name, profileField?.aliases || []).some(term => chapterContext.includes(term)) || input.chapter.requiredFacts.some(fact => fact.includes(field.name) || field.name.includes(fact));
    if (related) addNeed(needs, profile, { label: field.name, category: profileField?.category || 'spec', required: true, source: 'spec', fieldId: field.id, queries: needQueries(field.name, [fieldText]) });
  }
  for (const field of profile.factFields) {
    const terms = [field.name, ...field.aliases];
    const related = terms.some(term => term.length >= 2 && chapterContext.includes(term));
    if (related) addFieldNeed(needs, profile, field, 'profile', field.usagePolicy === 'must_use', [chapterContext]);
  }
  const requirementText = normalizeNeedText(input.requirement || '');
  if (requirementText) {
    for (const field of profile.factFields) {
      if ([field.name, ...field.aliases].some(term => term.length >= 2 && requirementText.includes(term))) addFieldNeed(needs, profile, field, 'requirement', true, [requirementText]);
    }
  }
  const promptText = normalizeNeedText(input.promptTexts || '');
  if (promptText) {
    for (const field of profile.factFields) {
      if ([field.name, ...field.aliases].some(term => term.length >= 2 && promptText.includes(term))) addFieldNeed(needs, profile, field, 'prompt', field.usagePolicy === 'must_use', [input.chapter.title]);
    }
  }
  return needs;
}

function factMatchesNeed(fact: DocumentFact, need: ChapterFactNeed, profile: DocumentDomainProfile) {
  const text = factText(fact);
  if (isGenerationExcludedFact(fact) || isForbiddenFactValue(profile, text) || isDiagnosticFactValue(profile, text)) return false;
  if (need.fieldId && fact.fieldId === need.fieldId) return true;
  if (factFieldForLabel(profile, fact.fieldName || fact.key)?.id === need.fieldId) return true;
  const queries = need.queries.filter(item => item.length >= 2);
  if (queries.some(query => text.includes(query))) return true;
  const field = factFieldForLabel(profile, need.label);
  return Boolean(field && [field.name, ...field.aliases].some(term => term.length >= 2 && text.includes(term)));
}

function uniqueFacts(facts: DocumentFact[]) {
  const seen = new Set<string>();
  return facts.filter(fact => {
    const key = `${fact.sourceFile}:${fact.key}:${fact.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceMatchesNeed(item: DocumentEvidence, need: ChapterFactNeed, profile: DocumentDomainProfile) {
  const text = `${item.filePath} ${item.roleId || ''} ${item.processingType || ''} ${item.sectionTitle || ''} ${item.content}`;
  if (isForbiddenFactValue(profile, text) || isDiagnosticFactValue(profile, text)) return false;
  return need.queries.some(query => query.length >= 2 && text.includes(query));
}

export function resolveChapterFactNeeds(input: { needs: ChapterFactNeed[]; factsModel: DocumentFactsModel; evidence?: DocumentEvidence[]; profile?: DocumentDomainProfile }) {
  const profile = input.profile || DEFAULT_DOCUMENT_DOMAIN_PROFILE;
  const factPool = uniqueFacts([
    ...input.factsModel.factIndex.parameterFacts,
    ...input.factsModel.factIndex.tableFacts,
    ...input.factsModel.factIndex.drawingFacts,
    ...input.factsModel.factIndex.billFacts,
    ...input.factsModel.factIndex.reliableFacts,
  ]);
  return input.needs.map<ResolvedFactNeed>(need => {
    const matchedFacts = uniqueFacts(factPool.filter(fact => factMatchesNeed(fact, need, profile))).sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const matchedEvidence = (input.evidence || []).filter(item => evidenceMatchesNeed(item, need, profile));
    const bestConfidence = Math.max(0, ...matchedFacts.map(fact => fact.confidence || 0));
    const status: ResolvedFactNeed['status'] = matchedFacts.length === 0 && matchedEvidence.length === 0
      ? 'missing'
      : bestConfidence > 0 && bestConfidence < 0.58
        ? 'low_confidence'
        : 'satisfied';
    return { need, facts: matchedFacts, evidence: matchedEvidence, status };
  });
}

export function factsForChapterNeeds(resolvedNeeds: ResolvedFactNeed[]) {
  return uniqueFacts(resolvedNeeds.flatMap(item => item.facts));
}

export function factNeedsCoveragePrompt(resolvedNeeds: ResolvedFactNeed[]) {
  const lines = resolvedNeeds.map(item => {
    const factLines = item.facts.slice(0, 5).map(fact => `${fact.key || fact.fieldName || item.need.label}=${cleanFactForPrompt(fact.value)}${fact.sourceFile ? `（${path.basename(fact.sourceFile)}）` : ''}`);
    const evidenceLines = item.facts.length ? [] : (item.evidence || []).slice(0, 2).map(evidence => `证据片段：${cleanFactForPrompt(evidence.content).slice(0, 160)}${evidence.filePath ? `（${path.basename(evidence.filePath)}）` : ''}`);
    return `- ${item.need.required ? '必须' : '相关'}｜${item.need.label}｜${item.status}${factLines.length || evidenceLines.length ? `：${[...factLines, ...evidenceLines].join('；')}` : '：未在已解析资料中确认'}`;
  });
  return lines.length ? `事实需求覆盖卡片：\n${lines.join('\n')}` : '';
}

function cleanFactForPrompt(value: unknown) {
  return stringifyFactValue(value).replace(/\s+/gu, ' ').trim().slice(0, 220);
}

// 建设规模混合口径拆分：资料“建设规模：项目总占地面积约10970平方米，单体建筑面积28570.36平方米”
// 是占地+建筑两个口径的混合字段值，直接进事实主表会让写作模型与确定性一致性修复器混淆两个数值
// （round-21 S6 实测：正文 9 处“总建筑面积 10970㎡”，修复器反向改错 18 处 28570.36→10970）。
// 拆成“总占地面积”“单体建筑面积”两条独立事实，口径互不污染。
function splitMixedScaleFacts(facts: DocumentFact[]): DocumentFact[] {
  const result: DocumentFact[] = [];
  for (const fact of facts) {
    const label = `${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`;
    const value = stringifyFactValue(fact.value);
    if (/建设规模/u.test(label) && /占地|用地/u.test(value) && /建筑面积/u.test(value)) {
      const siteStart = value.search(/(?:总)?占地/u);
      const buildStart = value.search(/(?:单体)?总?建筑面积/u);
      if (siteStart >= 0 && buildStart > siteStart) {
        const siteValue = value.slice(siteStart, buildStart).replace(/^[，,、\s]+/u, '').replace(/[，,、\s]+$/u, '').trim();
        const buildValue = value.slice(buildStart).trim();
        if (siteValue && buildValue) {
          // fieldId 处置：占地口径不保留原“建设规模”fieldId——canonical 事实主表按 fieldId 直配字段
          // （历史缺陷：拆分后“总占地面积=项目总占地面积约10970平方米”仍被识别为 project_scale
          // 候选并胜出，canonical“建设规模”被污染为占地数值）；建筑侧保留原 fieldId，使
          // project_scale 字段值稳定落在建筑总量口径上
          result.push({ ...fact, key: '总占地面积', fieldName: '总占地面积', fieldId: undefined, value: siteValue });
          result.push({ ...fact, key: '单体建筑面积', fieldName: '单体建筑面积', value: buildValue });
          continue;
        }
      }
    }
    result.push(fact);
  }
  return result;
}

export async function buildFactsModel(facts: DocumentFact[], tables: StructuredTableFact[] = [], missingItems: string[] = [], spec?: AutoDocumentSpecPackage, profile: DocumentDomainProfile = DEFAULT_DOCUMENT_DOMAIN_PROFILE): Promise<DocumentFactsModel> {
  const byKeys = (keys: string[]) => facts.filter(fact => keys.some(key => `${fact.key} ${fact.fieldName || ''}`.includes(key)));
  const byProcessing = (type: string) => facts.filter(fact => fact.processingType === type || fact.roleId.includes(type));
  const preciseFacts = facts.filter(fact => {
    const text = `${fact.key} ${fact.fieldName || ''} ${fact.value}`;
    return HAS_QUANTIFIED_VALUE_RE.test(text)
      && (!isForbiddenFactValue(profile, text) || isProjectBasicCommercialFact(text))
      && !isDiagnosticFactValue(profile, text);
  });
  const billFacts = facts.filter(fact => fact.processingType === 'table' || fact.processingType === 'structured_data' || fact.processingType === 'bill_of_quantities' || /bill|boq|table|sheet|data|表格|列表|明细|数据/u.test(`${fact.roleId} ${fact.sourceFile}`));
  const projectFacts = splitMixedScaleFacts(facts.filter(fact => /项目名称|工程名称|项目编号|招标项目编号|招标人|建设单位|发包人|建设地点|建设规模|招标范围|计划工期|合同工期|周期要求|质量标准|合同估算|投资估算|最高投标限价|招标控制价/u.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`))).slice(0, 80);
  const factIndex = buildEvidenceFactIndex(facts, preciseFacts, billFacts, profile);
  return {
    project: projectFacts,
    schedule: byKeys(['工期', '开工', '竣工', '节点', '周期']),
    quality: byKeys(['质量', '验收']),
    safety: byKeys(['安全', '风险']),
    resources: byKeys(['劳动力', '材料', '机械', '设备', '资源']),
    tables,
    drawings: byProcessing('drawing'),
    bills: billFacts,
    preciseFacts,
    rules: byProcessing('rule'),
    specifications: byProcessing('specification'),
    schemaFacts: buildSchemaFacts(facts, spec),
    factIndex,
    missing: [...new Set(missingItems)],
    conflicts: await detectFactConflicts(facts, spec, profile),
  };
}
