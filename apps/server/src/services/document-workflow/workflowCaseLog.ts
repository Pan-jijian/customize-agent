import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 案例落盘（数据而非代码）：裁决/修复案例库以 JSONL 追加存储，
 * 用于事后复盘口径演化与检测器覆盖盲区分析。
 * 红线：案例库只写不读、绝不参与生成决策——任何读取此库的代码都不得影响生成路径。
 * 落盘失败静默：复盘数据不应影响文档生成主链路。
 */

export interface ArbitrationCaseRecord {
  caseType: 'scope_conflict_arbitration';
  recordedAt: number;
  kind: string;
  scope: string;
  values: Array<{ value: string; unit: string; sourceFile?: string; priority: number }>;
  winner?: string;
  confidence?: 'high' | 'medium' | 'low';
  manualReviewRequired: boolean;
}

export interface DeterministicFixCaseRecord {
  caseType: 'deterministic_fix';
  recordedAt: number;
  fixName: string;
  chapter?: string;
  section?: string;
  detail: string;
}

function caseLogRoot() {
  const dir = path.join(os.homedir(), '.customize-agent', 'cache', 'document-workflow', 'case-log');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendRecord(fileName: string, record: object) {
  try {
    fs.appendFileSync(path.join(caseLogRoot(), fileName), `${JSON.stringify(record)}\n`, 'utf-8');
  } catch {
    // 案例落盘失败静默：复盘数据不影响生成主链路
  }
}

/** 记录同口径数值冲突裁决案例（含置信度与是否转人工），供事后复盘裁决口径演化 */
export function recordArbitrationCases(cases: ArbitrationCaseRecord[]) {
  for (const item of cases) appendRecord('arbitration-cases.jsonl', item);
}

/** 记录确定性修复案例（何种检测器、修复了什么），供复盘检测器覆盖盲区 */
export function recordDeterministicFixCases(cases: DeterministicFixCaseRecord[]) {
  for (const item of cases) appendRecord('deterministic-fix-cases.jsonl', item);
}
