import type { DocumentTemplate, DocumentTemplateChapter } from './types';
import { displayChapterTitle } from './outline';

/** 工程专业类型：由项目名称/章节标题/用户要求词面推断（结构规划与工艺知识库的输入之一） */
export type ConstructionOrgProjectType = 'building' | 'municipal' | 'renovation' | 'decoration' | 'general';

function normalizeText(text: string) {
  return displayChapterTitle(text).replace(/\s+/gu, '').toLowerCase();
}

export function inferConstructionOrgProjectTypes(input: { template: DocumentTemplate; chapters: DocumentTemplateChapter[]; requirement?: string }): ConstructionOrgProjectType[] {
  const text = normalizeText(`${input.template.name} ${input.template.outputTitle || ''} ${input.requirement || ''} ${input.chapters.map(chapter => chapter.title).join(' ')}`);
  const types: ConstructionOrgProjectType[] = [];
  if (/市政|道路|管网|雨污|污水|给水|沟槽|交通导|沥青|水稳|检查井/u.test(text)) types.push('municipal');
  if (/老旧小区|小区改造|改造|修缮|飞线|居民|雨污分流/u.test(text)) types.push('renovation');
  if (/装饰|装修|精装|吊顶|墙地面|乳胶漆|瓷砖|石材|室内/u.test(text)) types.push('decoration');
  if (/房建|住宅|办公楼|厂房|主体结构|基础|屋面|二次结构|塔吊|建筑/u.test(text)) types.push('building');
  return types.length ? [...new Set(types)] : ['general'];
}
