import type { ChapterCoverageReport, DocumentFactTrace, DocumentKnowledgeCoverageReport, DocumentQualityReport, RepairStrategy, ValidationIssue } from './types';

export function buildRepairStrategies(input: { issues: ValidationIssue[]; qualityReport?: DocumentQualityReport; knowledgeCoverage?: DocumentKnowledgeCoverageReport; factTraces?: DocumentFactTrace[]; chapterCoverage?: ChapterCoverageReport[] }): RepairStrategy[] {
  const strategies: RepairStrategy[] = [];
  const blocking = input.issues.filter(issue => issue.level === 'error');
  if (blocking.length > 0) {
    strategies.push({ priority: 'high', title: '阻断问题修复', action: `修复 ${blocking.length} 个导出阻断问题，优先处理事实冲突、结构缺失、模板规则违规和占位残留。` });
  }
  const unplacedFacts = (input.factTraces || []).filter(trace => trace.status === 'unplaced').slice(0, 10);
  if (unplacedFacts.length > 0) {
    strategies.push({ priority: 'high', title: '事实落位修复', action: `将 ${unplacedFacts.length} 项已确认知识库事实写入对应章节，保持原始数值、单位和来源口径。` });
  }
  if (input.knowledgeCoverage && input.knowledgeCoverage.score < 95) {
    strategies.push({ priority: 'medium', title: '知识库确认覆盖修复', action: '扩大本地知识库检索范围，执行事实补抽和章节证据重分配；这是系统检索、抽取、落位问题，不要求用户追加资料。' });
  }
  const weakChapters = (input.chapterCoverage || []).filter(chapter => chapter.score < 80).slice(0, 8);
  if (weakChapters.length > 0) {
    strategies.push({ priority: 'medium', title: '章节覆盖修复', action: `补齐低覆盖章节：${weakChapters.map(chapter => chapter.title).join('、')}。` });
  }
  if (input.qualityReport && !input.qualityReport.passed) {
    strategies.push({ priority: 'medium', title: '交付置信度修复', action: input.qualityReport.actions.join(' ') });
  }
  return strategies;
}

export function repairStrategyIssues(strategies: RepairStrategy[]): ValidationIssue[] {
  return strategies.filter(strategy => strategy.priority === 'high').map(strategy => ({
    level: 'warning' as const,
    message: `修复策略待执行：${strategy.title}`,
    suggestion: strategy.action,
  }));
}
