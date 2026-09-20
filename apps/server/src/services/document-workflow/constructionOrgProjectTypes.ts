import type { DocumentTemplate, DocumentTemplateChapter } from './types';
import { displayChapterTitle } from './outline';

/** 工程专业类型：由项目名称/章节标题/用户要求词面推断（结构规划与工艺知识库的输入之一） */
export type ConstructionOrgProjectType = 'building' | 'municipal' | 'renovation' | 'decoration' | 'general';

/** 专业类型判别词表（D-T9 单源导出）：章级领域判定（写作指令/节级错位扫描）与 infer 共用，声明序=判定序 */
export const CONSTRUCTION_ORG_PROJECT_TYPE_PATTERNS: ReadonlyArray<{ type: Exclude<ConstructionOrgProjectType, 'general'>; pattern: RegExp }> = [
  { type: 'municipal', pattern: /市政|道路|管网|雨污|污水|给水|沟槽|交通导|沥青|水稳|检查井/u },
  { type: 'renovation', pattern: /老旧小区|小区改造|改造|修缮|飞线|居民|雨污分流/u },
  { type: 'decoration', pattern: /装饰|装修|精装|吊顶|墙地面|乳胶漆|瓷砖|石材|室内/u },
  { type: 'building', pattern: /房建|住宅|办公楼|厂房|主体结构|基础|屋面|二次结构|塔吊|建筑/u },
];

function normalizeText(text: string) {
  return displayChapterTitle(text).replace(/\s+/gu, '').toLowerCase();
}

export function inferConstructionOrgProjectTypes(input: { template: DocumentTemplate; chapters: DocumentTemplateChapter[]; requirement?: string; materialText?: string }): ConstructionOrgProjectType[] {
  // D-T9 资料文本参与（项目特征/清单专业/图纸类型）：领域判定由资料内容驱动——不依赖项目名称；
  // 未传时保持原判定文本（向后兼容）
  const text = normalizeText(`${input.materialText || ''} ${input.template.name} ${input.template.outputTitle || ''} ${input.requirement || ''} ${input.chapters.map(chapter => chapter.title).join(' ')}`);
  const types = CONSTRUCTION_ORG_PROJECT_TYPE_PATTERNS.filter(entry => entry.pattern.test(text)).map(entry => entry.type);
  return types.length ? [...new Set(types)] : ['general'];
}
