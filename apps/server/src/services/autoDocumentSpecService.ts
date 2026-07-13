import * as crypto from 'node:crypto';
import type { DocumentTemplate } from './documentWorkflowService';
import type { AutoDocumentSpecPackage } from './autoDocumentSpecTypes';
import { applyKeywordRules, CHAPTER_FACT_RULES, DOCUMENT_TYPE_RULES, FACT_RULES, firstKeywordRuleOutput } from './documentSemanticRules';

function hashTemplate(template: DocumentTemplate) {
  return crypto.createHash('sha1').update(JSON.stringify({
    id: template.id,
    name: template.name,
    description: template.description,
    outputTitle: template.outputTitle,
    chapters: template.chapters,
    promptBindings: template.promptBindings,
    fileBindings: template.fileBindings,
    projectRoleConfigId: template.projectRoleConfigId,
  })).digest('hex').slice(0, 12);
}

function factId(name: string) {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/gu, '-').slice(0, 60) || `fact-${Date.now()}`;
}

function inferDocumentType(template: DocumentTemplate) {
  const text = `${template.name} ${template.category} ${template.outputTitle} ${template.description}`;
  return firstKeywordRuleOutput(text, DOCUMENT_TYPE_RULES) || template.category || '业务文档';
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
  if (documentType === '施工组织设计') {
    for (const name of applyKeywordRules('招标 施工 工程 清单 图纸 质量 工期 安全 文明 材料 重点 难点', FACT_RULES)) facts.add(name);
  }
  return [...facts].filter(Boolean);
}

export interface AutoDocumentSpecResult {
  spec: AutoDocumentSpecPackage;
  sourceHash: string;
  managedBy: 'system';
}

export function getOrCreateAutoDocumentSpec(template: DocumentTemplate): AutoDocumentSpecResult {
  const sourceHash = hashTemplate(template);
  const documentType = inferDocumentType(template);
  const factNames = inferFactNames(template, documentType);
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
  return {
    sourceHash,
    managedBy: 'system',
    spec: {
      id: `auto-${template.id}-${sourceHash}`.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 80),
      name: `后台自动规范 - ${template.name}`,
      description: `${documentType}后台自动规范，由模板、提示词和角色绑定静默生成。`,
      factFields: factNames.map(name => ({
        id: factId(name),
        name,
        type: 'auto' as const,
        required: !/材料|品牌|重点|难点|约束/iu.test(name),
        extractionHint: `从项目资料摘要、角色绑定证据和知识库证据中抽取“${name}”。`,
        validationHint: `生成内容涉及“${name}”时必须与项目资料一致，不得引入其他项目事实。`,
      })),
      chapterMode: chapterRules.length > 0 ? 'fixed' : 'dynamic',
      chapterRules,
      dynamicChapterRule: {
        source: 'ai_plan',
        minChapters: Math.max(1, template.chapters.length || 1),
        maxChapters: Math.max(8, template.chapters.length || 8),
        titleStrategy: 'template',
        minWordsPerChapter: 900,
        generationHint: `按${documentType}正式文件要求，根据项目资料摘要和模板提示词自动规划章节。`,
      },
      gateRules: [
        { id: 'auto-source-required', name: '事实必须有来源', type: 'source_required', level: 'warning', evaluator: { subject: 'source', operator: 'all_have_source' } },
        { id: 'auto-min-source', name: '至少使用项目资料来源', type: 'source_required', level: 'warning', evaluator: { subject: 'source', operator: 'min_count', min: 2 } },
        { id: 'auto-no-debug-text', name: '不得输出后台流程话术', type: 'forbidden_text', level: 'error', value: '知识库证据', evaluator: { subject: 'document', operator: 'not_contains', value: '知识库证据' } },
      ],
      builtIn: true,
    },
  };
}

export function autoSpecPrompt(spec: AutoDocumentSpecPackage, sourceHash: string) {
  return [
    '## 后台自动文档规范',
    `规范：${spec.name}`,
    `版本标识：${sourceHash}`,
    `事实字段：${spec.factFields.map(field => `${field.name}${field.required ? '(必需)' : ''}`).join('、')}`,
    `章节规则：${spec.chapterMode === 'fixed' ? spec.chapterRules.map(rule => rule.title).join('、') : spec.dynamicChapterRule.generationHint}`,
    `校验规则：${spec.gateRules.map(rule => rule.name).join('、')}`,
  ].join('\n');
}
