/**
 * P9 issue 快照 provenance 失效机制（替换脆弱正则）：
 * 1. stripSnapshotIssues 行为——带快照 detectorId 的 issue 无条件剔除，无 provenance / 非快照 detectorId 保留；
 * 2. SNAPSHOT_DETECTOR_IDS 恰好锁定 5 个快照检测器（与各打标点一一对应，防集合膨胀）；
 * 3. 打标点断言——overviewRecapIssues / internalTerminologyAnchorIssues（L1 精确词层）/
 *    internalTerminologyIssues 返回的 issue 携带 detectorId 与 stableHash 指纹；
 * 4. recomputeFinalValidationBundle 源码防回归——4 组脆弱正则已移除，替换为 stripSnapshotIssues。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SNAPSHOT_DETECTOR_IDS, stripSnapshotIssues } from '@/services/document-workflow/issueProvenance';
import { overviewRecapIssues } from '@/services/document-workflow/documentIntegrityChecks';
import { internalTerminologyAnchorIssues } from '@/services/document-workflow/internalTerminologyAnchors';
import { internalTerminologyIssues } from '@/services/document-workflow/qualityValidation';
import { stableHash } from '@/services/document-workflow/utils';
import type { ValidationIssue } from '@/services/document-workflow/types';

// 语义嵌入可控模拟（与 internalTerminologyAnchors.test.ts 同模式）：全零向量，L3 语义层不命中，
// 打标断言只针对 L1 精确词层（避免测试环境依赖 @huggingface/transformers 动态导入）
const embedDocumentsMock = vi.hoisted(() => vi.fn<(texts: string[]) => Promise<number[][]>>());

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  getLocalSemanticProvider: () => ({ embedDocuments: embedDocumentsMock }),
}));

beforeEach(() => {
  embedDocumentsMock.mockReset();
  embedDocumentsMock.mockImplementation(async (texts: string[]) => texts.map(() => [0, 0]));
});

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

const issue = (detectorId?: string): ValidationIssue => ({
  level: 'error',
  message: '测试 issue',
  provenance: detectorId ? { detectorId, fingerprint: 'fp' } : undefined,
});

// 与 __boundary__/dicListParagraphClosureBoundary.test.ts W4 同构造：概况章 + 概况区外复述句
const RECAP_MD = '## 工程概况\n本项目为某市安置小区项目。\n## 施工组织\n本项目为某市安置小区项目。';

describe('stripSnapshotIssues（P9）', () => {
  it('空数组 → 空数组', () => {
    expect(stripSnapshotIssues([])).toEqual([]);
  });

  it('无 provenance 的 issue 保留（快照判定只认 detectorId，不猜 message 文案）', () => {
    const kept = stripSnapshotIssues([issue(), issue('some-other-detector')]);
    expect(kept).toHaveLength(2);
  });

  it('非快照 detectorId 保留', () => {
    expect(stripSnapshotIssues([issue('table-quality')])).toHaveLength(1);
  });

  it('5 个快照 detectorId 逐一无条件剔除', () => {
    for (const detectorId of SNAPSHOT_DETECTOR_IDS) {
      expect(stripSnapshotIssues([issue(detectorId)]), `${detectorId} 未被剔除`).toEqual([]);
    }
  });

  it('快照与普通 issue 混合时只剔除快照', () => {
    const mixed = [issue('fact-coverage'), issue(), issue('overview-recap')];
    const kept = stripSnapshotIssues(mixed);
    expect(kept).toHaveLength(1);
    expect(kept[0].provenance?.detectorId).toBeUndefined();
  });
});

describe('SNAPSHOT_DETECTOR_IDS 集合锁定（P9）', () => {
  it('恰好 5 个快照检测器（与打标点一一对应，新增快照必须同步重算链注册）', () => {
    expect([...SNAPSHOT_DETECTOR_IDS].sort()).toEqual([
      'data-consistency-snapshot',
      'fact-coverage',
      'global-consistency-snapshot',
      'internal-terminology-anchor',
      'overview-recap',
    ]);
  });
});

describe('打标点断言（P9）', () => {
  it('overviewRecapIssues 携带 provenance（detectorId + 全文 stableHash 指纹）', () => {
    const issues = overviewRecapIssues(RECAP_MD);
    expect(issues).toHaveLength(1);
    expect(issues[0].provenance).toEqual({ detectorId: 'overview-recap', fingerprint: stableHash(RECAP_MD) });
  });

  it('internalTerminologyAnchorIssues L1 精确词层携带 provenance', async () => {
    const markdown = '本工程按工作包组织施工内容。';
    const issues = await internalTerminologyAnchorIssues(markdown);
    expect(issues).toHaveLength(1); // L3 全零向量不命中，仅 L1 精确词层输出
    expect(issues[0].provenance).toEqual({ detectorId: 'internal-terminology-anchor', fingerprint: stableHash(markdown) });
  });

  it('internalTerminologyIssues（词面保险丝）携带 provenance（与旧正则 3 剔除行为一致）', () => {
    const markdown = '拆除工程工作包施工内容。';
    const issues = internalTerminologyIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0].provenance).toEqual({ detectorId: 'internal-terminology-anchor', fingerprint: stableHash(markdown) });
  });
});

describe('recomputeFinalValidationBundle 源码防回归（P9）', () => {
  // P2 拆分后该闭包位于 finalize/rebuildAndRecompute.ts stageRebuildAndRecompute，读新文件断言
  const pipeline = readFileSync(path.join(SRC_DIR, 'finalize/rebuildAndRecompute.ts'), 'utf8');

  it('4 组脆弱正则已全部移除（正则形式不残留，与 message 措辞解耦）', () => {
    expect(pipeline).not.toContain('/已确认事实未在正文中落位/u');
    expect(pipeline).not.toContain('/概况段跨章复述/u');
    expect(pipeline).not.toContain('/后台内部术语|后台内部话术/u');
    expect(pipeline).not.toContain('/^(?:跨章一致性复核|数据一致性复核)：/u');
  });

  it('重算基线过滤已替换为 stripSnapshotIssues', () => {
    expect(pipeline).toContain('stripSnapshotIssues(session.baseValidationIssues)');
    expect(pipeline).toContain("from '../issueProvenance'");
  });

  it('校验组打包打标：fact-coverage + 跨章一致性/数据一致性快照', () => {
    expect(pipeline).toContain("provenance: { detectorId: 'fact-coverage', fingerprint: stableHash(budgetDraftMarkdown) }");
    expect(pipeline).toContain("detectorId: isDataConflict ? 'data-consistency-snapshot' : 'global-consistency-snapshot'");
  });

  it('documentIntegrityChecks 打标 overview-recap（指纹随全文变化）', () => {
    // P4 拆分后该打标位于 integrity/detectors/detectors.ts，读新文件断言
    const source = readFileSync(path.join(SRC_DIR, 'integrity/detectors/detectors.ts'), 'utf8');
    expect(source).toContain("provenance: { detectorId: 'overview-recap', fingerprint: stableHash(markdown) }");
  });

  it('internalTerminologyAnchors 两处打标（L1 精确词 + L3 语义锚点同 detectorId）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'internalTerminologyAnchors.ts'), 'utf8');
    expect(source.match(/provenance: \{ detectorId: 'internal-terminology-anchor', fingerprint: stableHash\(markdown\) \}/gu)).toHaveLength(2);
  });

  it('qualityValidation 词面保险丝打标（旧正则 3 覆盖过的路径不得遗漏）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'qualityValidation.ts'), 'utf8');
    expect(source).toContain("provenance: { detectorId: 'internal-terminology-anchor', fingerprint: stableHash(markdown) }");
  });
});
