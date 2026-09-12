/**
 * 舒城模板化治理验收统计（发布后真实生成对照，.manual.ts 显式运行）。
 *
 * 运行：npx vitest run apps/server/test/shucheng-acceptance.manual.ts
 * 环境变量 DOC_IDS 指定多个 draft（逗号分隔）；默认统计最新发布后生成 + 发布前预跑。
 *
 * 验收口径（《模板化治理完整方案》验收表）：
 * - 段首标签 40→0（STRUCTURE_LABEL_PREFIX_RE 命中行）
 * - 同名 H4 3组→0（#### 标题同核心名重复组）
 * - 箭头链 328→形式轮换（→ 总计数；相邻块同形式 issue）
 * - 骨架指纹 45/62/46→全文≤2（由技术负责人组织 / 合格后方可 / 验收合格后 精确计数）
 * - 残缺名修复（titleIntegrityIssues）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import {
  SKELETON_FINGERPRINTS,
  STRUCTURE_LABEL_PREFIX_RE,
  countSkeletonFingerprint,
  flowFormRepeatIssues,
  isStructuralLabelTitle,
  skeletonFingerprintIssues,
  templatedLabelIssues,
  titleIntegrityIssues,
} from '@/services/document-workflow/templatingGovernance';

const PROJECT_ID = process.env.PROJECT_ID ?? '3c3f04667c69';
const DRAFT_DIR = path.join(os.homedir(), '.customize-agent', 'projects', PROJECT_ID, 'generatedDocuments', 'drafts');

interface DraftLike {
  markdown?: string;
  title?: string;
  status?: string;
  wordCount?: number;
  reviewMetadata?: { professionalScore?: { total?: number; grade?: string; dimensions?: Array<{ label: string; score: number; detail: string }> }; templatingReviewIssues?: unknown };
}

function loadDraft(docId: string): DraftLike {
  return JSON.parse(fs.readFileSync(path.join(DRAFT_DIR, `${docId}.json`), 'utf8')) as DraftLike;
}

/** 同名 H4 组统计（核心名重复即一组；返回重复组数量与明细） */
function duplicateH4Groups(markdown: string): { groups: number; details: string[] } {
  const counts = new Map<string, number>();
  for (const line of markdown.split(/\r?\n/u)) {
    const m = /^####\s+(.+?)\s*$/u.exec(line.trim());
    if (!m) continue;
    const core = m[1].replace(/^\d+(?:\.\d+)*[.．、:：]?\s*/u, '').replace(/\s+/gu, '');
    if (!core) continue;
    counts.set(core, (counts.get(core) ?? 0) + 1);
  }
  const details: string[] = [];
  for (const [core, count] of counts) {
    if (count >= 2) details.push(`${core} ×${count}`);
  }
  return { groups: details.length, details: details.slice(0, 10) };
}

/** 段首标签行统计（排除标题行） */
function prefixLabelCount(markdown: string): { count: number; samples: string[] } {
  let count = 0;
  const samples: string[] = [];
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^#{1,6}\s/u.test(trimmed)) continue;
    if (STRUCTURE_LABEL_PREFIX_RE.test(rawLine)) {
      count += 1;
      if (samples.length < 6) samples.push(trimmed.slice(0, 30));
    }
  }
  return { count, samples };
}

/** 标签标题（H3~H6 结构标签独立成题）统计 */
function labelHeadingCount(markdown: string): { count: number; samples: string[] } {
  let count = 0;
  const samples: string[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const m = /^(#{3,6})\s+(.+?)\s*$/u.exec(line.trim());
    if (m && isStructuralLabelTitle(m[2])) {
      count += 1;
      if (samples.length < 6) samples.push(`${m[1]} ${m[2]}`);
    }
  }
  return { count, samples };
}

/** 箭头计数 */
function arrowCount(markdown: string): number {
  return (markdown.match(/→|->|=>/gu) || []).length;
}

/** 骨架指纹全文计数（验收表口径：全文精确计数，弹性空白同源） */
function fingerprintStats(markdown: string): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const fingerprint of SKELETON_FINGERPRINTS) totals[fingerprint.text] = countSkeletonFingerprint(markdown, fingerprint);
  return totals;
}

function analyze(docId: string) {
  const draft = loadDraft(docId);
  const markdown = draft.markdown ?? '';
  const prefix = prefixLabelCount(markdown);
  const headings = labelHeadingCount(markdown);
  const dup = duplicateH4Groups(markdown);
  const arrows = arrowCount(markdown);
  const fingerprints = fingerprintStats(markdown);
  const templated = templatedLabelIssues(markdown);
  const flowRepeat = flowFormRepeatIssues(markdown);
  const skeletonRepeat = skeletonFingerprintIssues(markdown);
  const titles = titleIntegrityIssues(markdown);
  return {
    docId,
    status: draft.status,
    wordCount: draft.wordCount,
    chars: markdown.length,
    professionalScore: draft.reviewMetadata?.professionalScore
      ? {
          total: draft.reviewMetadata.professionalScore.total,
          grade: draft.reviewMetadata.professionalScore.grade,
          dimensions: (draft.reviewMetadata.professionalScore.dimensions ?? []).map(d => `${d.label}=${d.score}`),
        }
      : null,
    prefixLabel: prefix.count,
    prefixSamples: prefix.samples,
    labelHeading: headings.count,
    labelHeadingSamples: headings.samples,
    duplicateH4Groups: dup.groups,
    duplicateH4Details: dup.details,
    arrows,
    fingerprintTotals: fingerprints,
    detector: {
      templatedLabelIssues: templated.length,
      flowFormRepeatIssues: flowRepeat.length,
      skeletonFingerprintIssues: skeletonRepeat.length,
      titleIntegrityIssues: titles.length,
    },
    titleIssueSamples: titles.slice(0, 5).map(i => i.message.slice(0, 100)),
    flowIssueSamples: flowRepeat.slice(0, 4).map(i => i.message.slice(0, 100)),
  };
}

describe('舒城模板化治理验收统计', () => {
  const docIds = (process.env.DOC_IDS ?? 'doc-1789116737813-8450341b,doc-1789084996463-e6bd5020').split(',').map(s => s.trim()).filter(Boolean);
  it('输出各文档验收指标', () => {
    for (const docId of docIds) {
      try {
        const report = analyze(docId);
        console.log(`\n===== ${docId} =====`);
        console.log(JSON.stringify(report, null, 2));
      } catch (error) {
        console.log(`\n===== ${docId} ===== 读取失败: ${(error as Error).message}`);
      }
    }
  });
});
