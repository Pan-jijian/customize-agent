import type { ValidationIssue } from './types';

export function collectValidationIssueGroups(...groups: ValidationIssue[][]) {
  return groups.flat();
}

export function collectMessageGroups(...groups: string[][]) {
  return groups.flat();
}

function validationIssueKey(issue: ValidationIssue) {
  return issue.message.replace(/\d+(?:\.\d+)?/gu, '#').replace(/\s+/gu, '').slice(0, 120);
}

export function dedupeValidationIssues(issues: ValidationIssue[]) {
  const severityRank = { info: 0, warning: 1, error: 2 } as const;
  const merged = new Map<string, ValidationIssue>();
  for (const issue of issues) {
    const key = validationIssueKey(issue);
    const existing = merged.get(key);
    if (!existing || severityRank[issue.level] > severityRank[existing.level]) {
      merged.set(key, issue);
    } else if (!existing.suggestion && issue.suggestion) {
      merged.set(key, { ...existing, suggestion: issue.suggestion });
    }
  }
  return [...merged.values()];
}

export function repairIssueSignature(issue: ValidationIssue | string) {
  const raw = typeof issue === 'string' ? issue : issue.message;
  const message = raw.match(/问题：([^\n]+)/u)?.[1] || raw;
  return message.replace(/\d+(?:\.\d+)?/gu, '#').replace(/\s+/gu, '').slice(0, 120);
}

export function buildRepairTaskMessage(issue: ValidationIssue | string) {
  const message = typeof issue === 'string' ? issue : issue.message;
  const suggestion = typeof issue === 'string' ? '' : issue.suggestion;
  const target = message.match(/^([^：:]+)[：:]/u)?.[1] || '全文';
  const type = /跨章一致性/u.test(message) ? '跨章一致性修复' : /泛化|套话/u.test(message) ? '泛化内容替换' : /专业|进度|质量|安全|资源|施工/u.test(message) ? '专业缺口补写' : /小节|章节|结构/u.test(message) ? '结构完整性修复' : '质量问题修复';
  return ['【修复任务包】', `修复类型：${type}`, `修复对象：${target}`, `问题：${message}`, suggestion ? `要求：${suggestion}` : '', '输出要求：只改正文内容，不输出解释；必须结合资料事实、专业控制点、验收闭环和跨章一致性约束；不得用泛化套话填充。'].filter(Boolean).join('\n');
}

export function unresolvedRepairTasks(before: Array<ValidationIssue | string>, after: ValidationIssue[]) {
  const afterBySignature = new Map(after.map(issue => [repairIssueSignature(issue), issue]));
  return before.filter(issue => afterBySignature.has(repairIssueSignature(issue))).map(issue => {
    const persisted = afterBySignature.get(repairIssueSignature(issue));
    const level = persisted?.level === 'warning' ? '软问题复核' : '硬问题升级';
    return buildRepairTaskMessage(issue).replace('修复类型：', `修复类型：${level}-小节/章节重写；原类型：`);
  });
}

/** 增量修复的问题解决账本：追踪哪些问题已被修复，支持停滞检测 */
export class ResolutionLedger {
  private resolved = new Set<string>();
  private stagnantCount = 0;

  markResolved(issue: ValidationIssue | string): void {
    this.resolved.add(repairIssueSignature(issue));
  }

  isResolved(issue: ValidationIssue | string): boolean {
    return this.resolved.has(repairIssueSignature(issue));
  }

  /** 记录一轮修复结果；返回 true 表示连续 2 轮无进展，应停止 */
  markRound(progressed: boolean): boolean {
    if (progressed) {
      this.stagnantCount = 0;
      return false;
    }
    this.stagnantCount += 1;
    return this.stagnantCount >= 2;
  }

  /** 过滤出尚未被解决的 issues */
  pending<T extends ValidationIssue | string>(issues: T[]): T[] {
    return issues.filter(issue => !this.isResolved(issue));
  }

  /** 已解决数量 */
  resolvedCount(): number {
    return this.resolved.size;
  }

  /** 获取已解决的签名 Set 用于传递到 repair 函数 */
  pendingSignatures(): Set<string> {
    return new Set(this.resolved);
  }
}
