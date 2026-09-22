import type { ValidationIssue } from './types';

export function collectValidationIssueGroups(...groups: ValidationIssue[][]) {
  return groups.flat();
}

export function repairIssueSignature(issue: ValidationIssue | string) {
  const raw = typeof issue === 'string' ? issue : issue.message;
  const message = raw.match(/问题：([^\n]+)/u)?.[1] || raw;
  return message.replace(/\d+(?:\.\d+)?/gu, '#').replace(/\s+/gu, '').slice(0, 120);
}
