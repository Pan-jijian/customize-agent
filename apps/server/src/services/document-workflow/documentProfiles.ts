import type { DocumentTemplate, DocumentTemplateChapter, DocumentProfileReport } from './types';

export function buildDocumentProfileReport(input: { template: DocumentTemplate; chapters: DocumentTemplateChapter[]; requirement?: string }): DocumentProfileReport {
  const text = `${input.template.name} ${input.template.outputTitle || ''} ${input.requirement || ''} ${input.chapters.map(chapter => chapter.title).join(' ')}`;
  const matched = [
    { pattern: /专项施工|危大|专项方案/u, type: '专项施工方案', dimensions: ['专项对象边界', '工艺参数', '风险控制', '验收要求', '应急措施'] },
    { pattern: /投标|技术标|响应|招标/u, type: '投标技术方案', dimensions: ['招标响应', '技术优势', '工期质量安全承诺', '资源保障', '履约可实施性'] },
    { pattern: /监理|旁站|巡视|平行检验/u, type: '监理规划/细则', dimensions: ['监理目标', '旁站巡视', '平行检验', '验收程序', '资料签认'] },
    { pattern: /可研|可行性|项目建议书|投资估算/u, type: '可研/项目建议类文档', dimensions: ['建设必要性', '方案比选', '投资估算', '风险分析', '实施效益'] },
    { pattern: /运维|维护|保养|巡检/u, type: '运维维护方案', dimensions: ['巡检频次', '维护流程', '故障响应', '备品备件', '记录闭环'] },
  ].find(item => item.pattern.test(text));
  return {
    type: matched?.type || '施工组织设计/施工技术方案',
    dimensions: matched?.dimensions || ['工程概况', '施工部署', '进度质量安全', '资源配置', '施工工艺和验收闭环'],
    requiredEvidencePolicy: '本地知识库为完整事实源；系统暂未确认的事实必须通过扩大检索、事实补抽或落位修复解决，不得归因为用户资料缺失。',
  };
}
