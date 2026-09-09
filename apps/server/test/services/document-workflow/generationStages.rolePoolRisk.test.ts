/**
 * 4.22.0 事故回归：stageUnderstanding 未写回 rolePoolRisk → stageChapterLoop 读 undefined.highRisk 抛错，
 * 全部章节生成失败（真实模板复现：10/10 章 chapter_generation failed）。
 * 两道防线：
 * 1. 治本：真实 stageUnderstanding 在索引健康检查通过后必须写回 session.understanding.rolePoolRisk
 *    （用 collectProjectBasicEvidence 抛错作终止点——写回点在其之前，函数其余部分不执行）；
 * 2. 防御：resolveRolePoolRisk 兑底——阶段 1 未写入时按零风险兜底（深召回仍由 missingFacts 触发）。
 */
import { describe, expect, it, vi } from 'vitest';
import type * as DocumentGeneratorHelpersModule from '@/services/document-workflow/documentGeneratorHelpers';

vi.mock('@/services/document-workflow/documentGeneratorHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof DocumentGeneratorHelpersModule>();
  return {
    ...actual,
    // 终止点：写回 rolePoolRisk（L54）之后的首个 LLM/检索调用即抛错，函数其余部分不执行
    collectProjectBasicEvidence: vi.fn(async () => {
      throw new Error('stop-after-rolePoolRisk');
    }),
  };
});

import { retrievalCoverageRisk, resolveRolePoolRisk } from '@/services/document-workflow/documentEvidenceRetrieval';
import { stageUnderstanding } from '@/services/document-workflow/generationStages/stageUnderstanding';
import { createEmptyGenerationSession } from '@/services/document-workflow/generationStages/generationSession';
import type { GenerationSession } from '@/services/document-workflow/generationStages/generationSession';

describe('resolveRolePoolRisk 兑底（4.22.0 防御防线）', () => {
  it('阶段 1 未写入（undefined）时返回零风险兜底，章节循环不再崩溃', () => {
    const resolved = resolveRolePoolRisk(undefined);
    expect(resolved).toBeDefined();
    expect(resolved.highRisk).toBe(false);
    expect(resolved.totalChunks).toBe(0);
    expect(resolved.loadedRatio).toBe(1);
  });

  it('阶段 1 已写入的风险对象原样返回（不覆盖真实计算结果）', () => {
    const highRisk = retrievalCoverageRisk({ totalChunks: 2000, loadedChunks: 400, vectorReady: true });
    expect(resolveRolePoolRisk(highRisk)).toBe(highRisk);
    const lowRisk = retrievalCoverageRisk({ totalChunks: 120, loadedChunks: 120, vectorReady: true });
    expect(resolveRolePoolRisk(lowRisk)).toBe(lowRisk);
    expect(resolveRolePoolRisk(lowRisk).highRisk).toBe(false);
  });

  it('兜底语义与检索风险口径一致：零切片 + 无向量状态不构成高风控', () => {
    const fallback = retrievalCoverageRisk({ totalChunks: 0, loadedChunks: 0, vectorReady: undefined });
    expect(fallback.highRisk).toBe(false);
    // 向量显性未就绪才会触发风险（与 kbIndexHealth 告警口径一致）
    const vectorDown = retrievalCoverageRisk({ totalChunks: 0, loadedChunks: 0, vectorReady: false });
    expect(vectorDown.highRisk).toBe(true);
  });
});

describe('stageUnderstanding 写回 rolePoolRisk（4.22.0 治本防线）', () => {
  function buildMinimalSession(): GenerationSession {
    const session = createEmptyGenerationSession({ templateId: 'tpl-risk' });
    Object.assign(session.prepare, {
      projectRoot: '/fake/root',
      projectId: 'p-risk',
      materialFilePaths: ['招标文件.pdf'],
      kindByPath: new Map<string, string>([['招标文件.pdf', 'tender']]),
      processingByPath: new Map<string, string>(),
      webAccessConfig: { enabled: false },
      projectMaterialProfile: { files: [], groups: {} },
    });
    Object.assign(session.understanding, {
      manager: {
        getProject: async () => ({
          listFiles: () => [{ relativePath: '招标文件.pdf', chunkCount: 5, status: 'ready' }],
          countPendingIndexJobs: () => 0,
          getVectorStatus: () => ({ status: 'ready', error: undefined, indexedChunks: 5, lastIndexedAt: 0, backend: 'hnsw' }),
        }),
      },
    });
    return session;
  }

  it('索引健康检查通过后写回 rolePoolRisk（highRisk=false，切片数按索引口径）', async () => {
    const session = buildMinimalSession();
    // collectProjectBasicEvidence 抛错是预期终止点：写回发生在其之前（L54 < L113）
    await expect(stageUnderstanding(session)).rejects.toThrow('stop-after-rolePoolRisk');
    expect(session.understanding.rolePoolRisk).toBeDefined();
    expect(session.understanding.rolePoolRisk.highRisk).toBe(false);
    // usableChunkCount=5 与 materialFilePaths.length*20=20 取 min → 5
    expect(session.understanding.rolePoolRisk.totalChunks).toBe(5);
    expect(session.understanding.rolePoolRisk.loadedChunks).toBe(5);
  });

  it('向量未就绪时写回高风险标记（与索引健康检查告警口径一致）', async () => {
    const session = buildMinimalSession();
    const manager = session.understanding.manager as unknown as {
      getProject: () => Promise<{ getVectorStatus: () => { status: string } }>;
    };
    manager.getProject = async () => ({
      listFiles: () => [{ relativePath: '招标文件.pdf', chunkCount: 5, status: 'ready' }],
      countPendingIndexJobs: () => 0,
      getVectorStatus: () => ({ status: 'building' }),
    } as never);
    await expect(stageUnderstanding(session)).rejects.toThrow('stop-after-rolePoolRisk');
    expect(session.understanding.rolePoolRisk).toBeDefined();
    expect(session.understanding.rolePoolRisk.highRisk).toBe(true);
  });
});
