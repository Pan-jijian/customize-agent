import type { DocumentDraftChapter, DocumentEvidence, DocumentFactsModel, DocumentKnowledgeCoverageReport, DocumentTemplateChapter, ValidationIssue } from './types';

const FACT_DOMAIN_LABELS: Record<string, string> = {
  project: '项目基础事实',
  schedule: '工期与节点',
  quality: '质量目标与验收',
  safety: '安全文明要求',
  resources: '资源投入依据',
  quantities: '清单/图纸/工程量事实',
  rules: '规范规则与验收要求',
};

function domainsForChapter(chapter: Pick<DocumentTemplateChapter | DocumentDraftChapter, 'title'>) {
  const domains = ['project'];
  if (/进度|工期|节点|部署/u.test(chapter.title)) domains.push('schedule');
  if (/质量|验收|材料/u.test(chapter.title)) domains.push('quality', 'rules');
  if (/安全|文明|风险|危大/u.test(chapter.title)) domains.push('safety', 'rules');
  if (/资源|材料|设备|劳动力|机械/u.test(chapter.title)) domains.push('resources');
  if (/施工|工艺|技术|方案|清单|工程量|图纸/u.test(chapter.title)) domains.push('quantities');
  return [...new Set(domains)];
}

function domainHasFacts(domain: string, factsModel: DocumentFactsModel) {
  if (domain === 'project') return factsModel.project.length > 0 || factsModel.preciseFacts.length > 0;
  if (domain === 'schedule') return factsModel.schedule.length > 0;
  if (domain === 'quality') return factsModel.quality.length > 0 || factsModel.specifications.length > 0;
  if (domain === 'safety') return factsModel.safety.length > 0 || factsModel.rules.length > 0;
  if (domain === 'resources') return factsModel.resources.length > 0 || factsModel.bills.length > 0;
  if (domain === 'quantities') return factsModel.bills.length > 0 || factsModel.drawings.length > 0 || factsModel.tables.length > 0;
  if (domain === 'rules') return factsModel.rules.length > 0 || factsModel.specifications.length > 0;
  return false;
}

export function buildKnowledgeCoverageReport(input: { chapters: DocumentDraftChapter[]; templateChapters: DocumentTemplateChapter[]; factsModel: DocumentFactsModel; evidence: DocumentEvidence[] }): DocumentKnowledgeCoverageReport {
  const chapterReports = input.chapters.map(chapter => {
    const templateChapter = input.templateChapters.find(item => item.id === chapter.id || item.title === chapter.title);
    const requiredDomains = domainsForChapter(templateChapter || chapter);
    const confirmedDomains = requiredDomains.filter(domain => domainHasFacts(domain, input.factsModel) || (chapter.evidence || []).some(item => new RegExp(FACT_DOMAIN_LABELS[domain] || domain, 'u').test(`${item.sectionTitle || ''} ${item.content || ''}`)));
    const unconfirmedDomains = requiredDomains.filter(domain => !confirmedDomains.includes(domain));
    const score = requiredDomains.length ? Math.round((confirmedDomains.length / requiredDomains.length) * 100) : 100;
    return { chapterId: chapter.id, title: chapter.title, requiredDomains, confirmedDomains, unconfirmedDomains, score };
  });
  const confirmedFiles = new Set(input.evidence.map(item => item.filePath).filter(Boolean));
  const score = chapterReports.length ? Math.round(chapterReports.reduce((sum, item) => sum + item.score, 0) / chapterReports.length) : 100;
  return {
    score,
    evidenceCount: input.evidence.length,
    confirmedFiles: confirmedFiles.size,
    chapterReports,
    unconfirmedDomains: [...new Set(chapterReports.flatMap(item => item.unconfirmedDomains))],
    remediation: score >= 95 ? '知识库事实覆盖已达到高置信交付要求。' : '系统需扩大本地知识库检索、补抽结构化事实，并将已确认事实落位到对应章节。',
  };
}

export function knowledgeCoverageIssues(report: DocumentKnowledgeCoverageReport): ValidationIssue[] {
  if (report.score >= 85) return [];
  return [{
    level: 'warning',
    message: `系统知识库覆盖确认率偏低：${report.score}%`,
    suggestion: `${report.remediation} 未确认事实域：${report.unconfirmedDomains.map(domain => FACT_DOMAIN_LABELS[domain] || domain).join('、') || '无'}`,
  }];
}
