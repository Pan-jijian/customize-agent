import * as path from 'node:path';
import type { DocumentFact, DocumentFactsModel, DocumentTemplate, DocumentTemplateChapter } from './types';
import { stringifyFactValue } from './utils';

type BlueprintFactsModel = Pick<DocumentFactsModel, 'project' | 'schedule' | 'quality' | 'safety' | 'resources' | 'preciseFacts' | 'bills' | 'drawings' | 'rules' | 'specifications'>;

type SupportFactsModel = Pick<DocumentFactsModel, 'project' | 'schedule' | 'quality' | 'safety' | 'resources' | 'bills' | 'drawings' | 'rules' | 'specifications'>;

function factLine(fact: DocumentFact) {
  const label = fact.fieldName || fact.key || '资料事实';
  const value = stringifyFactValue(fact.value).replace(/\s+/gu, ' ').trim();
  return `${label}：${value}${fact.sourceFile ? `（来源：${path.basename(fact.sourceFile)}）` : ''}`;
}

export function documentProfileForContext(input: { template: DocumentTemplate; chapters: DocumentTemplateChapter[]; requirement?: string }) {
  const text = `${input.template.name} ${input.template.outputTitle || ''} ${input.requirement || ''} ${input.chapters.map(chapter => chapter.title).join(' ')}`;
  if (/专项施工|危大|专项方案/u.test(text)) return { type: '专项施工方案', focus: ['专项对象边界', '工艺参数', '风险控制', '验收要求', '应急措施'] };
  if (/投标|技术标|响应|招标/u.test(text)) return { type: '投标技术方案', focus: ['招标响应', '技术优势', '工期质量安全承诺', '资源保障', '履约可实施性'] };
  if (/监理|旁站|巡视|平行检验/u.test(text)) return { type: '监理规划/细则', focus: ['监理目标', '旁站巡视', '平行检验', '验收程序', '资料签认'] };
  if (/可研|可行性|项目建议书|投资估算/u.test(text)) return { type: '可研/项目建议类文档', focus: ['建设必要性', '方案比选', '投资估算', '风险分析', '实施效益'] };
  if (/运维|维护|保养|巡检/u.test(text)) return { type: '运维维护方案', focus: ['巡检频次', '维护流程', '故障响应', '备品备件', '记录闭环'] };
  return { type: '施工组织设计/施工技术方案', focus: ['工程概况', '施工部署', '进度质量安全', '资源配置', '施工工艺和验收闭环'] };
}

export function factCoverageTargetsForTitle(title: string) {
  const targets = ['project'];
  if (/概况|工程|项目|部署|总体|施工|方案|资源/u.test(title)) targets.push('scope');
  if (/进度|工期|部署|资源/u.test(title)) targets.push('schedule');
  if (/质量|验收|材料/u.test(title)) targets.push('quality');
  if (/安全|文明|风险|危大/u.test(title)) targets.push('safety');
  if (/资源|材料|设备|劳动力|进度/u.test(title)) targets.push('resources');
  if (/施工|工艺|技术|方案|清单|工程量/u.test(title)) targets.push('quantities');
  return [...new Set(targets)];
}

export function factCoverageMatrixLines(chapters: DocumentTemplateChapter[]) {
  const labels: Record<string, string> = { project: '项目基础事实', scope: '招标范围/施工边界', schedule: '工期与节点', quality: '质量目标与验收', safety: '安全文明要求', resources: '资源投入依据', quantities: '清单/图纸/工程量事实' };
  return chapters.map((chapter, index) => `${index + 1}. ${chapter.title}：${factCoverageTargetsForTitle(chapter.title).map(key => labels[key] || key).join('、')}`);
}

export function supportLevelForChapter(chapter: DocumentTemplateChapter, factsModel: SupportFactsModel) {
  const targets = factCoverageTargetsForTitle(chapter.title);
  const supported = targets.filter(target => {
    if (target === 'project' || target === 'scope') return factsModel.project.length > 0 || factsModel.drawings.length > 0;
    if (target === 'schedule') return factsModel.schedule.length > 0;
    if (target === 'quality') return factsModel.quality.length > 0 || factsModel.specifications.length > 0;
    if (target === 'safety') return factsModel.safety.length > 0 || factsModel.rules.length > 0;
    if (target === 'resources') return factsModel.resources.length > 0 || factsModel.bills.length > 0;
    if (target === 'quantities') return factsModel.bills.length > 0 || factsModel.drawings.length > 0;
    return false;
  });
  const missing = targets.filter(target => !supported.includes(target));
  const ratio = targets.length ? supported.length / targets.length : 1;
  const level = ratio >= 0.75 ? 'strong' : ratio >= 0.4 ? 'medium' : 'weak';
  const mode = level === 'strong' ? 'project-specific' : level === 'medium' ? 'standard-based' : 'restricted-general';
  return { level, mode, supported, missing };
}

export function professionalPointsForTitle(title: string) {
  if (/概况|工程|项目/u.test(title)) return ['工程基础信息必须与资料一致', '突出招标范围、建设地点、规模、工期、质量目标', '说明施工组织编制边界'];
  if (/部署|总体|组织/u.test(title)) return ['明确施工组织逻辑、专业接口和施工段划分', '说明资源、进度、质量、安全之间的统筹关系', '形成可执行的管理闭环'];
  if (/进度|工期/u.test(title)) return ['围绕总工期和关键线路组织', '说明资源保障、穿插施工、纠偏机制', '不得编造系统暂未从知识库确认的日期节点'];
  if (/质量/u.test(title)) return ['覆盖材料进场验收、复验、过程检查、隐蔽验收和资料归档', '把资料中的质量标准落入控制点', '明确整改复验闭环'];
  if (/安全|文明|风险|危大/u.test(title)) return ['识别作业风险和现场管理边界', '覆盖人员、设备、临电、消防、文明施工措施', '明确检查整改和应急响应'];
  if (/资源|材料|设备|劳动力/u.test(title)) return ['依据工程范围和进度组织资源配置', '说明材料设备进场、验收、保管和调配', '资源安排必须支撑工期和质量目标'];
  if (/施工|工艺|技术|方案/u.test(title)) return ['明确施工准备、工艺流程、关键参数和验收要求', '关联图纸、清单、说明资料中的对象和边界', '突出重点难点和过程控制'];
  return ['结合资料事实说明对象范围、实施方法、控制要点和验收闭环', '避免泛化表述，必须体现本项目特征'];
}

export function chapterExecutionPlanLine(chapter: DocumentTemplateChapter, factsModel: SupportFactsModel) {
  const support = supportLevelForChapter(chapter, factsModel);
  return [
    `章节实施方案：${chapter.title}`,
    `   - 写作模式：${support.mode}；资料支撑度：${support.level}`,
    `   - 已支撑事实域：${support.supported.join('、') || '暂无'}`,
    `   - 系统暂未确认事实域：${support.missing.join('、') || '无'}`,
    `   - 章节目标：${professionalPointsForTitle(chapter.title).join('；')}`,
    `   - 组织顺序：${(chapter.sections || []).slice(0, 10).join(' → ') || '按模板章节目标展开'}`,
    '   - 禁止内容：系统暂未从知识库确认的项目特有数字、日期、金额、工程量或材料规格不得编造；应触发扩大检索、事实补抽或事实落位修复。',
  ].join('\n');
}

export function chapterTaskCardLine(chapter: DocumentTemplateChapter) {
  return [`章节任务卡：${chapter.title}`, `   - 必须覆盖事实域：${factCoverageTargetsForTitle(chapter.title).join('、')}`, ...professionalPointsForTitle(chapter.title).map(point => `   - ${point}`), ...(chapter.sections || []).slice(0, 10).map(section => `   - 小节任务：${section}｜${professionalPointsForTitle(section).join('；')}`)].join('\n');
}

export function buildDocumentBlueprintContext(input: { template: DocumentTemplate; chapters: DocumentTemplateChapter[]; factsModel: BlueprintFactsModel; requirement?: string }) {
  const coreFacts = [
    ...input.factsModel.project,
    ...input.factsModel.schedule,
    ...input.factsModel.quality,
    ...input.factsModel.safety,
    ...input.factsModel.resources,
    ...input.factsModel.preciseFacts,
  ].filter((fact, index, array) => {
    const value = stringifyFactValue(fact.value).replace(/\s+/gu, ' ').trim();
    return value.length > 0 && array.findIndex(item => `${item.key}:${stringifyFactValue(item.value).replace(/\s+/gu, ' ').trim()}` === `${fact.key}:${value}`) === index;
  }).slice(0, 36);
  const profile = documentProfileForContext(input);
  const evidenceTraceLines = coreFacts.slice(0, 18).map((fact, index) => `${index + 1}. ${fact.fieldName || fact.key || '资料事实'}｜${stringifyFactValue(fact.value).replace(/\s+/gu, ' ').slice(0, 90)}｜来源：${fact.sourceFile ? path.basename(fact.sourceFile) : '结构化事实主表'}`);
  const coverageMatrix = factCoverageMatrixLines(input.chapters);
  const supportMatrix = input.chapters.map((chapter, index) => {
    const support = supportLevelForChapter(chapter, input.factsModel);
    return `${index + 1}. ${chapter.title}：${support.level}/${support.mode}；缺失 ${support.missing.join('、') || '无'}`;
  });
  const chapterLines = input.chapters.map(chapterTaskCardLine);
  const executionPlans = input.chapters.map(chapter => chapterExecutionPlanLine(chapter, input.factsModel));
  return [
    '【全局文档蓝图与一致性约束】',
    `文档类型画像：${profile.type}；评分重点：${profile.focus.join('、')}`,
    `文档目标：${input.template.outputTitle || input.template.name}`,
    input.requirement ? `用户目标：${input.requirement}` : '',
    coreFacts.length ? `可信基础事实主表：\n${coreFacts.map(fact => `- ${factLine(fact)}`).join('\n')}` : '可信基础事实主表：系统当前结构化事实确认不足，应扩大本地知识库检索、补抽事实并修复事实落位；正文只能使用已确认事实，不得编造参数。',
    evidenceTraceLines.length ? `关键事实证据追踪清单：\n${evidenceTraceLines.join('\n')}` : '',
    `事实覆盖矩阵：\n${coverageMatrix.join('\n')}`,
    `知识库确认覆盖矩阵：\n${supportMatrix.join('\n')}`,
    '证据引用约束：工期、质量目标、招标范围、金额、工程量、标准规范、验收要求等关键事实必须来自可信基础事实主表或绑定材料；系统暂未从知识库确认的数字和参数不得编造。',
    '跨章一致性要求：所有章节必须共用同一套工期、质量、范围、资源和验收口径；不得在不同章节写出相互矛盾的项目基础信息。',
    `章节专业任务卡：\n${chapterLines.join('\n')}`,
    `章节实施方案：\n${executionPlans.join('\n')}`,
  ].filter(Boolean).join('\n');
}
