import type { ChapterCoverageReport, DocumentFactTrace, DocumentKnowledgeCoverageReport, DocumentQualityReport, RepairStrategy, ValidationIssue } from './types';
import { isActionableTraceFact } from './documentFactTrace';

export function buildRepairStrategies(input: { issues: ValidationIssue[]; qualityReport?: DocumentQualityReport; knowledgeCoverage?: DocumentKnowledgeCoverageReport; factTraces?: DocumentFactTrace[]; chapterCoverage?: ChapterCoverageReport[] }): RepairStrategy[] {
  const strategies: RepairStrategy[] = [];
  const blocking = input.issues.filter(issue => issue.level === 'error');
  if (blocking.length > 0) {
    strategies.push({ priority: 'high', title: '阻断问题修复', action: `修复 ${blocking.length} 个导出阻断问题，优先处理事实冲突、结构缺失、模板规则违规和占位残留。` });
  }
  // 未落位事实统计必须按可执行口径过滤：技术参数/精确参数池（清单编码、孤立尺寸）是提示词注入池而非逐条落位义务，
  // 不过滤会把 94 项技术参数算进“未落位事实”（十度实测：98 项告警中 94 项是参数池噪音，真实硬缺陷仅 2 条）
  const allUnplacedFacts = (input.factTraces || []).filter(trace => trace.status === 'unplaced' && isActionableTraceFact(trace));
  if (allUnplacedFacts.length > 0) {
    const summary = allUnplacedFacts.length > 12
      ? `${allUnplacedFacts.length} 项（示例：${allUnplacedFacts.slice(0, 8).map(t => t.label).join('、')} 等）`
      : `${allUnplacedFacts.length} 项（${allUnplacedFacts.map(t => t.label).join('、')}）`;
    strategies.push({ priority: 'high', title: '事实落位修复', action: `将 ${summary} 已确认知识库事实写入对应章节，保持原始数值、单位和来源口径。` });
  }
  if (input.knowledgeCoverage && input.knowledgeCoverage.score < 95) {
    strategies.push({ priority: 'medium', title: '知识库确认覆盖修复', action: '扩大本地知识库检索范围，执行事实补抽和章节证据重分配；这是系统检索、抽取、落位问题，不要求用户追加资料。' });
  }
  const allWeakChapters = (input.chapterCoverage || []).filter(chapter => chapter.score < 80);
  if (allWeakChapters.length > 0) {
    const display = allWeakChapters.length > 10
      ? `${allWeakChapters.slice(0, 8).map(c => c.title).join('、')} 及其他${allWeakChapters.length - 8}章`
      : allWeakChapters.map(c => c.title).join('、');
    strategies.push({ priority: 'medium', title: '章节覆盖修复', action: `补齐低覆盖章节（${allWeakChapters.length}章）：${display}。` });
  }
  if (input.qualityReport && !input.qualityReport.passed) {
    strategies.push({ priority: 'medium', title: '交付置信度修复', action: input.qualityReport.actions.join(' ') });
  }
  return strategies;
}

export function repairStrategyIssues(strategies: RepairStrategy[]): ValidationIssue[] {
  return strategies.filter(strategy => strategy.priority === 'high').map(strategy => ({
    // 修复策略是流程状态说明而非正文缺陷，按 info 计入，避免污染缺陷计分
    level: 'info' as const,
    message: `修复策略待执行：${strategy.title}`,
    suggestion: strategy.action,
  }));
}
