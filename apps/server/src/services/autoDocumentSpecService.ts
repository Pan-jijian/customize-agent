import * as crypto from 'node:crypto';
import type { DocumentTemplate } from './documentWorkflowService';
import type { AutoSpecGateConfig } from './engineeringDocumentConfigService';
import { readEngineeringDocumentConfig } from './engineeringDocumentConfigService';
import type { AutoDocumentSpecPackage } from './autoDocumentSpecTypes';
import { applyKeywordRules, CHAPTER_FACT_RULES, DOCUMENT_TYPE_RULES, FACT_RULES, firstKeywordRuleOutput } from './documentSemanticRules';

function hashTemplate(template: DocumentTemplate, requirement = '') {
  return crypto.createHash('sha1').update(JSON.stringify({
    id: template.id,
    name: template.name,
    description: template.description,
    outputTitle: template.outputTitle,
    chapters: template.chapters,
    promptBindings: template.promptBindings,
    fileBindings: template.fileBindings,
    projectRoleConfigId: template.projectRoleConfigId,
    requirement,
  })).digest('hex').slice(0, 12);
}

function factId(name: string) {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/gu, '-').slice(0, 60) || `fact-${Date.now()}`;
}

function inferDocumentType(template: DocumentTemplate) {
  const text = `${template.name} ${template.category} ${template.outputTitle} ${template.description}`;
  return firstKeywordRuleOutput(text, DOCUMENT_TYPE_RULES) || template.category || '业务文档';
}

function quotedTexts(text: string) {
  const quotePattern = new RegExp('[“”"\'‘’「」『』《》](.{2,80}?)[“”"\'‘’「」『』《》]', 'gu');
  return [...text.matchAll(quotePattern)].map(match => match[1].trim()).filter(Boolean);
}

function splitRequirementItems(text: string) {
  return text.split(/[\n；;。]/u).map(item => item.trim()).filter(item => item.length >= 2);
}

function requirementPageTarget(requirement = '') {
  const match = requirement.match(/(?:大概|约|左右|不少于|至少|控制在|不超过|最多)?\s*(\d{1,3})\s*(?:页|page)/iu);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (/不少于|至少/iu.test(requirement)) return { min: value };
  if (/不超过|最多|以内|控制在/iu.test(requirement)) return { max: value };
  return { target: value, min: Math.max(1, Math.floor(value * 0.85)), max: Math.ceil(value * 1.15) };
}

function requirementChapters(requirement = '') {
  const chapters = new Set<string>();
  const patterns = [/(?:必须|需要|要求|增加|包含|包括|补充|设置|新增).{0,12}?(?:章节|章|节|小节)[：:为是]?\s*([^。；;\n]{2,80})/giu, /(?:章节|目录).{0,8}?(?:包括|包含|为|是)[：:]?\s*([^。；;\n]{2,120})/giu];
  for (const pattern of patterns) {
    for (const match of requirement.matchAll(pattern)) {
      for (const item of match[1].split(/[、,，/]/u).map(value => value.trim()).filter(Boolean)) {
        if (!/不要|禁止|不得|不能/iu.test(item) && item.length <= 40) chapters.add(item.replace(/[。；;：:]+$/u, ''));
      }
    }
  }
  return [...chapters];
}

function requirementForbiddenTexts(requirement = '') {
  const forbidden = new Set<string>();
  for (const item of splitRequirementItems(requirement).filter(item => /不要|禁止|不得|不能|不允许|严禁/iu.test(item))) {
    for (const text of quotedTexts(item)) forbidden.add(text);
    const match = item.match(/(?:不要|禁止|不得|不能|不允许|严禁)(?:出现|输出|写|包含)?\s*([^。；;\n]{2,40})/iu);
    if (match) forbidden.add(match[1].replace(/^(这些|以下|内容|词语|文字)[:：]?/u, '').trim());
  }
  return [...forbidden].filter(text => text && !/章节|页|表格/u.test(text)).slice(0, 30);
}

function requirementRequiredTexts(requirement = '') {
  const required = new Set<string>();
  for (const item of splitRequirementItems(requirement).filter(item => /必须|需要|要求|一定要|务必|包含|包括|输出|写明/iu.test(item) && !/章节|章|节|小节/iu.test(item))) {
    for (const text of quotedTexts(item)) required.add(text);
    const match = item.match(/(?:必须|需要|要求|一定要|务必|包含|包括|输出|写明)\s*([^。；;\n]{2,60})/iu);
    if (match) required.add(match[1].trim());
  }
  return [...required].filter(text => text && !/不要|禁止|不得|不能/u.test(text)).slice(0, 30);
}

function requirementTableMin(requirement = '') {
  const explicit = requirement.match(/(?:至少|不少于)?\s*(\d{1,2})\s*(?:个|张)?\s*表格/iu);
  if (explicit) return Number(explicit[1]);
  return /表格化|用表格|表格形式|表格表达/iu.test(requirement) ? 1 : undefined;
}

function templateTextForSpec(template: DocumentTemplate, documentType = '') {
  return `${documentType} ${template.name} ${template.category} ${template.outputTitle} ${template.description}`;
}

function matchesPattern(text: string, pattern: string) {
  try { return new RegExp(pattern, 'iu').test(text); } catch { return text.includes(pattern); }
}

function configuredAutoSpecGates(template: DocumentTemplate, documentType = ''): AutoSpecGateConfig[] {
  const text = templateTextForSpec(template, documentType);
  return readEngineeringDocumentConfig().autoSpecGates.filter(gate => gate.templateMatchers.some(pattern => matchesPattern(text, pattern)));
}

function inferFactNames(template: DocumentTemplate, documentType: string) {
  const templateText = [
    template.name,
    template.category,
    template.outputTitle,
    template.description,
    ...template.chapters.flatMap(chapter => [chapter.title, chapter.purpose, ...(chapter.sections || []), ...(chapter.requiredFacts || []), ...(chapter.queries || [])]),
  ].filter(Boolean).join('\n');
  const facts = new Set<string>([
    ...template.chapters.flatMap(chapter => chapter.requiredFacts || []),
    '项目名称',
    '项目资料范围',
  ]);
  for (const name of applyKeywordRules(templateText, FACT_RULES)) facts.add(name);
  const autoSpecGates = configuredAutoSpecGates(template, documentType);
  if (documentType === '施工组织设计' || autoSpecGates.length > 0) {
    for (const name of applyKeywordRules('招标 施工 工程 清单 图纸 质量 工期 安全 文明 材料 重点 难点', FACT_RULES)) facts.add(name);
    for (const name of autoSpecGates.flatMap(gate => gate.requiredFacts)) facts.add(name);
  }
  return [...facts].filter(Boolean);
}

export interface AutoDocumentSpecResult {
  spec: AutoDocumentSpecPackage;
  sourceHash: string;
  managedBy: 'system';
}

export function getOrCreateAutoDocumentSpec(template: DocumentTemplate, requirement = ''): AutoDocumentSpecResult {
  const sourceHash = hashTemplate(template, requirement);
  const documentType = inferDocumentType(template);
  const factNames = inferFactNames(template, documentType);
  const requiredChapters = requirementChapters(requirement);
  const requiredTexts = requirementRequiredTexts(requirement);
  const forbiddenTexts = requirementForbiddenTexts(requirement);
  const pageTarget = requirementPageTarget(requirement);
  const autoSpecGates = configuredAutoSpecGates(template, documentType);
  const configuredMinTables = Math.max(0, ...autoSpecGates.map(gate => gate.minTables || 0));
  const minTables = Math.max(requirementTableMin(requirement) || 0, configuredMinTables) || undefined;
  const chapterRules = template.chapters.map((chapter, index) => {
    const chapterText = [chapter.title, chapter.purpose, ...(chapter.sections || []), ...(chapter.requiredFacts || []), ...(chapter.queries || [])].join('\n');
    const chapterFactNames = new Set(chapter.requiredFacts || []);
    for (const name of factNames) if (chapterText.includes(name) || new RegExp(name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu').test(chapterText)) chapterFactNames.add(name);
    for (const name of applyKeywordRules(chapterText, CHAPTER_FACT_RULES)) chapterFactNames.add(name);
    return {
      id: chapter.id,
      title: chapter.title,
      required: true,
      order: index,
      minWords: 900,
      requiredFactIds: [...chapterFactNames].filter(name => factNames.includes(name)).map(factId),
      requiredFileRoleIds: [],
      requiredPromptRoleIds: [],
      generationHint: [chapter.purpose, chapter.sections?.length ? `必须包含小节：${chapter.sections.join('、')}` : '', chapterFactNames.size ? `重点覆盖事实：${[...chapterFactNames].join('、')}` : ''].filter(Boolean).join('\n'),
    };
  });
  const userChapterRules = requiredChapters
    .filter(title => !chapterRules.some(rule => rule.title.includes(title) || title.includes(rule.title)))
    .map((title, index) => ({
      id: `user-chapter-${factId(title)}`,
      title,
      required: true,
      order: chapterRules.length + index,
      minWords: 600,
      requiredFactIds: [],
      requiredFileRoleIds: [],
      requiredPromptRoleIds: [],
      generationHint: `用户明确要求包含该章节：${title}`,
    }));
  const gateRules = [
    { id: 'auto-source-required', name: '事实必须有来源', type: 'source_required', level: 'warning' as const, evaluator: { subject: 'source' as const, operator: 'all_have_source' as const } },
    { id: 'auto-min-source', name: '至少使用项目资料来源', type: 'source_required', level: 'warning' as const, evaluator: { subject: 'source' as const, operator: 'min_count' as const, min: 2 } },
    { id: 'auto-no-debug-text', name: '不得输出后台流程话术', type: 'forbidden_text', level: 'error' as const, value: '知识库证据', evaluator: { subject: 'document' as const, operator: 'not_contains' as const, value: '知识库证据' } },
    ...autoSpecGates.flatMap(gate => gate.requiredTexts.map(text => ({ id: `configured-required-${factId(text)}`, name: `配置建议包含：${text}`, type: 'configured_required_text', level: 'warning' as const, value: text, evaluator: { subject: 'document' as const, operator: 'contains' as const, value: text } }))),
    ...autoSpecGates.flatMap(gate => gate.forbiddenTexts.map(text => ({ id: `configured-forbidden-${factId(text)}`, name: `配置建议避免：${text}`, type: 'configured_forbidden_text', level: 'warning' as const, value: text, evaluator: { subject: 'document' as const, operator: 'not_contains' as const, value: text } }))),
    ...(configuredMinTables ? [{ id: 'configured-min-table-count', name: `配置建议正式表格不少于 ${configuredMinTables} 个`, type: 'configured_table_density', level: 'warning' as const, evaluator: { subject: 'table' as const, operator: 'min_count' as const, min: configuredMinTables } }] : []),
    ...requiredChapters.map(title => ({ id: `user-required-chapter-${factId(title)}`, name: `用户提到章节：${title}`, type: 'user_required_chapter', level: 'warning' as const, target: title, evaluator: { subject: 'chapter' as const, operator: 'exists' as const, target: title } })),
    ...requiredTexts.map(text => ({ id: `user-required-text-${factId(text)}`, name: `用户提到应包含：${text}`, type: 'user_required_text', level: 'warning' as const, value: text, evaluator: { subject: 'document' as const, operator: 'contains' as const, value: text } })),
    ...forbiddenTexts.map(text => ({ id: `user-forbidden-text-${factId(text)}`, name: `用户要求不得包含：${text}`, type: 'user_forbidden_text', level: 'error' as const, value: text, evaluator: { subject: 'document' as const, operator: 'not_contains' as const, value: text } })),
    ...(minTables ? [{ id: 'user-min-table-count', name: `用户提到表格数量不少于 ${minTables}`, type: 'user_format_table', level: 'warning' as const, evaluator: { subject: 'table' as const, operator: 'min_count' as const, min: minTables } }] : []),
    ...(pageTarget?.min ? [{ id: 'user-min-page-count', name: `用户提到页数不少于 ${pageTarget.min}`, type: 'user_page_target', level: 'warning' as const, evaluator: { subject: 'page' as const, operator: 'min_count' as const, min: pageTarget.min } }] : []),
    ...(pageTarget?.max ? [{ id: 'user-max-page-count', name: `用户要求页数不超过 ${pageTarget.max}`, type: 'user_page_target', level: 'warning' as const, evaluator: { subject: 'page' as const, operator: 'max_count' as const, min: pageTarget.max } }] : []),
  ];
  const finalChapterRules = [...chapterRules, ...userChapterRules];
  return {
    sourceHash,
    managedBy: 'system',
    spec: {
      id: `auto-${template.id}-${sourceHash}`.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 80),
      name: `后台优化建议 - ${template.name}`,
      description: `${documentType}后台优化建议，由模板、提示词、角色绑定和用户临时要求静默生成，仅用于提升内容完整性，不接管章节结构。`,
      factFields: factNames.map(name => ({
        id: factId(name),
        name,
        type: 'auto' as const,
        required: autoSpecGates.some(gate => gate.requiredFacts.includes(name)) || !/材料|品牌|重点|难点|约束/iu.test(name),
        extractionHint: `从项目资料摘要、角色绑定证据和知识库证据中抽取“${name}”。`,
        validationHint: `生成内容涉及“${name}”时必须与项目资料一致，不得引入其他项目事实。`,
      })),
      chapterMode: 'fixed',
      chapterRules: finalChapterRules,
      dynamicChapterRule: {
        source: 'ai_plan',
        minChapters: 0,
        maxChapters: 0,
        titleStrategy: 'template',
        minWordsPerChapter: 0,
        generationHint: `不自动规划或补充章节；仅按${documentType}正式文件要求提供内容完整性建议。`,
      },
      gateRules,
      builtIn: true,
    },
  };
}

export function autoSpecPrompt(spec: AutoDocumentSpecPackage, sourceHash: string) {
  return [
    '## 后台内容优化建议',
    `建议包：${spec.name}`,
    `版本标识：${sourceHash}`,
    '说明：以下内容仅用于提升事实覆盖、检索命中和质量检查，不得新增、删除、重排用户或模板章节。',
    `建议关注事实：${spec.factFields.map(field => field.name).join('、')}`,
    `章节内容建议：${spec.chapterRules.map(rule => `${rule.title}${rule.generationHint ? `：${rule.generationHint.replace(/\s+/gu, ' ').slice(0, 120)}` : ''}`).join('；') || '以当前模板章节为准'}`,
    `质量提醒：${spec.gateRules.map(rule => rule.name).join('、')}`,
  ].join('\n');
}
