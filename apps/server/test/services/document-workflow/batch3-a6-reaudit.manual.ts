/**
 * 批次3 A6 离线验收复测（manual：不进常规门禁）：4.27.0 终稿 markdown × 落盘蓝图 → 新审计器重算。
 * 对照 reviewMetadata.authorityAudit 持久化旧报告：未登记 8 项（1.5mm/1.5m/24套/5.5m/95mm/S3.2/280cm/172人）
 * 应在边界严格定位（4.28.0 A6）+ 第四轮词表扩围后全部落桶（未登记=0）。
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/services/document-workflow/batch3-a6-reaudit.manual.ts
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auditAuthorityCoverage } from '@/services/document-workflow/authorityAudit';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';

const ROOT = '/Users/pan/Desktop/codeing/customize-agent';
const DOC_JSON = `${ROOT}/.dbg/gen-v5-4.27.0-final.json`;
const BLUEPRINT_JSON = '/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/assets/blueprint.json';

interface PersistedFinding { token: string; context: string }
interface PersistedAudit {
  scanned: number;
  matched: number;
  registered: number;
  derivationGaps: PersistedFinding[];
  processGaps: PersistedFinding[];
  unattributed: PersistedFinding[];
  unregisteredCount: number;
}

describe('批次3 A6 离线复测（4.27.0 终稿重算）', () => {
  it('旧未登记 8 项全部落桶（未登记=0）', () => {
    const doc = JSON.parse(fs.readFileSync(DOC_JSON, 'utf8')).document as {
      markdown: string;
      reviewMetadata: { authorityAudit: PersistedAudit };
    };
    const blueprintData = JSON.parse(fs.readFileSync(BLUEPRINT_JSON, 'utf8')).data as BlueprintData;
    const oldReport = doc.reviewMetadata.authorityAudit;
    const report = auditAuthorityCoverage(doc.markdown, blueprintData);
    console.log(`旧报告: scanned=${oldReport.scanned} matched=${oldReport.matched} registered=${oldReport.registered} 推导缺口=${oldReport.derivationGaps.length} 工艺缺口=${oldReport.processGaps.length} 未登记=${oldReport.unregisteredCount}`);
    console.log(`新报告: scanned=${report.scanned} matched=${report.matched} registered=${report.registered} 推导缺口=${report.derivationGaps.length} 工艺缺口=${report.processGaps.length} 未登记=${report.unregisteredCount}`);
    for (const finding of oldReport.unattributed) {
      const inDerivation = report.derivationGaps.find(item => item.token === finding.token);
      const inProcess = report.processGaps.find(item => item.token === finding.token);
      const still = report.unattributed.find(item => item.token === finding.token);
      const bucket = inDerivation ? 'derivation-gap' : inProcess ? 'process-gap' : still ? '仍未登记' : 'matched';
      const context = (inDerivation ?? inProcess ?? still)?.context ?? '';
      console.log(`  ${finding.token} → ${bucket} | ${context.slice(0, 46)}`);
    }
    expect(report.unregisteredCount).toBe(0);
  });
});
