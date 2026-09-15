import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 依赖隔离：document-workflow 编排、qualityValidation、知识库服务、操作日志、外部 runtime 包全部 mock；
// 文件系统经 homedir mock 重定向到工厂内自建的固定临时目录。
vi.mock('os', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  let fixedDir = '';
  const mockOs = {
    homedir: () => {
      if (!fixedDir) fixedDir = mkdtempSync(join('/tmp', 'ca-gendoc-test-'));
      return fixedDir;
    },
    tmpdir: () => '/tmp',
  };
  return { ...mockOs, default: mockOs };
});
vi.mock('@/services/document-workflow', () => ({
  generateDocumentDraft: vi.fn(),
  getDocumentTemplate: vi.fn(() => ({ id: 't1', name: '标准模板', version: 1, description: '', category: '施工组织设计', outputTitle: '施工组织设计', chapters: [] })),
}));
vi.mock('@/services/document-workflow/qualityValidation', () => ({
  collectSectionContentGaps: vi.fn(() => []),
}));
// 语义模型预热隔离：任务启动链会调用 preflightLocalSemanticProvider，单测不加载真实 BGE 模型
vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  preflightLocalSemanticProvider: vi.fn(async () => {}),
}));
vi.mock('@/services/knowledge/kbService', () => ({
  getProjectKbRoot: vi.fn(() => '/kb-root'),
  getProjectRoot: vi.fn(() => '/proj-root'),
}));
vi.mock('@/services/knowledge/kbOperationLog', () => ({
  upsertKbOperation: vi.fn(),
}));
vi.mock('@customize-agent/knowledge', () => ({
  computeProjectId: vi.fn(() => 'proj-id-001'),
}));

import type { DocumentFactsModel, GeneratedDocumentDraft } from '@/services/document-workflow/types';
import { generateDocumentDraft, getDocumentTemplate } from '@/services/document-workflow';
import { collectSectionContentGaps } from '@/services/document-workflow/qualityValidation';
import { upsertKbOperation } from '@/services/knowledge/kbOperationLog';
import {
  abortGeneratedDocument,
  deleteGeneratedAsset,
  deleteGeneratedDocument,
  generatedAssetAbsolutePath,
  generatingRecordRequiresFullPoll,
  getGenerateTask,
  getGeneratedAsset,
  getGeneratedDocument,
  getGeneratedDocumentMeta,
  getQueuedDocumentPosition,
  listGeneratedAssets,
  listGeneratedDocuments,
  openGeneratedAssetTarget,
  saveGeneratedDocument,
  setProcessAliveProbeForTest,
  startGenerateDocumentTask,
  updateGeneratedDocument,
  upsertGeneratedAssets,
  upsertGeneratedDocumentAsset,
  type GeneratedDocumentRecord,
} from '@/services/document-core/generatedDocumentService';

const EMPTY_FACTS_MODEL = {
  project: [], schedule: [], quality: [], safety: [], resources: [],
  tables: [], drawings: [], bills: [], preciseFacts: [], rules: [], specifications: [],
  schemaFacts: {}, factIndex: {}, missing: [], conflicts: [],
} as unknown as DocumentFactsModel;

function makeResult(overrides: Partial<GeneratedDocumentDraft> = {}): GeneratedDocumentDraft {
  return {
    templateId: 't1',
    templateName: '标准模板',
    title: '施工组织设计',
    requirement: 'req',
    generatedAt: Date.now(),
    markdown: '正文内容'.repeat(500),
    facts: {},
    structuredFacts: [],
    factsModel: EMPTY_FACTS_MODEL,
    chapters: [],
    sources: [],
    missingItems: [],
    validation: { passed: true, warnings: [], errors: [] },
    validationIssues: [],
    executionStages: [],
    exportGate: { passed: true, blockingIssues: [], checklist: [] },
    ...overrides,
  };
}

function makeRecord(overrides: Partial<GeneratedDocumentRecord> = {}): GeneratedDocumentRecord {
  const now = Date.now();
  return {
    id: 'doc-1',
    templateId: 't1',
    templateName: '标准模板',
    title: '施工组织设计',
    requirement: 'req',
    markdown: '正文',
    status: 'completed',
    assets: [],
    createdAt: now - 1000,
    updatedAt: now,
    ...overrides,
  };
}

function clearTasks() {
  const store = globalThis as { __generatedDocumentTasks?: Map<string, unknown>; __generatedDocumentQueue?: unknown[] };
  store.__generatedDocumentTasks?.clear();
  store.__generatedDocumentQueue?.splice(0);
}

beforeEach(() => {
  fs.rmSync(path.join(os.homedir(), '.customize-agent'), { recursive: true, force: true });
  clearTasks();
  vi.mocked(generateDocumentDraft).mockReset();
  vi.mocked(collectSectionContentGaps).mockReturnValue([]);
  vi.mocked(upsertKbOperation).mockReset();
  vi.mocked(getDocumentTemplate).mockReturnValue({ id: 't1', name: '标准模板', version: 1, description: '', category: '施工组织设计', outputTitle: '施工组织设计', chapters: [] });
  delete process.env.DOCUMENT_MAX_CONCURRENT_GENERATIONS;
  delete process.env.DOCUMENT_TUNING_PROFILE;
  setProcessAliveProbeForTest(null);
});

afterAll(() => {
  fs.rmSync(os.homedir(), { recursive: true, force: true });
});

describe('记录基础读写', () => {
  it('saveGeneratedDocument 写入 draft/index/meta 三处', () => {
    const record = makeRecord();
    saveGeneratedDocument(record, '/proj');
    const saved = getGeneratedDocument('doc-1', '/proj');
    expect(saved?.title).toBe('施工组织设计');
    const meta = getGeneratedDocumentMeta('doc-1', '/proj');
    expect(meta?.status).toBe('completed');
    // getGeneratedDocument 会经 ensureGeneratedDocumentAsset 再次落盘，updatedAt 不早于原记录
    expect(meta?.updatedAt).toBeGreaterThanOrEqual(record.updatedAt);
    const list = listGeneratedDocuments('/proj');
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('doc-1');
  });

  it('listGeneratedDocuments 按时间倒序', () => {
    saveGeneratedDocument(makeRecord({ id: 'doc-a', createdAt: 1, updatedAt: 1 }), '/proj');
    saveGeneratedDocument(makeRecord({ id: 'doc-b', createdAt: 2, updatedAt: 2 }), '/proj');
    const list = listGeneratedDocuments('/proj');
    expect(list.map(item => item.id)).toEqual(['doc-b', 'doc-a']);
  });

  it('getGeneratedDocument 不存在返回 null', () => {
    expect(getGeneratedDocument('nope', '/proj')).toBeNull();
    expect(getGeneratedDocumentMeta('nope', '/proj')).toBeNull();
  });

  it('updateGeneratedDocument 合并补丁；不存在返回 null', () => {
    saveGeneratedDocument(makeRecord(), '/proj');
    const updated = updateGeneratedDocument('doc-1', { title: '新标题' }, '/proj');
    expect(updated?.title).toBe('新标题');
    expect(updateGeneratedDocument('ghost', { title: 'x' }, '/proj')).toBeNull();
  });

  it('deleteGeneratedDocument 移除记录', () => {
    saveGeneratedDocument(makeRecord(), '/proj');
    deleteGeneratedDocument('doc-1', '/proj');
    expect(getGeneratedDocument('doc-1', '/proj')).toBeNull();
    expect(listGeneratedDocuments('/proj')).toEqual([]);
  });
});

describe('abortGeneratedDocument', () => {
  it('不存在或非 generating 记录直接返回', () => {
    expect(abortGeneratedDocument('nope', '/proj')).toBeNull();
    saveGeneratedDocument(makeRecord(), '/proj');
    const record = abortGeneratedDocument('doc-1', '/proj');
    expect(record?.status).toBe('completed');
  });

  it('generating 记录中止：触发 controller.abort 并落盘 aborted', async () => {
    vi.mocked(generateDocumentDraft).mockImplementation(() => new Promise(() => {}));
    const { taskId, documentId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const aborted = abortGeneratedDocument(documentId, '/proj');
    expect(aborted?.status).toBe('aborted');
    expect(aborted?.error).toBe('用户中止');
    // 任务被移出注册表，轮询方通过落盘记录感知中止
    expect(getGenerateTask(taskId)).toBeNull();
  });

  it('中止审计：abortedAt/abortedBy/abortedStage 落盘（running 阶段提取）', async () => {
    vi.mocked(generateDocumentDraft).mockImplementation(async (input) => {
      input.onProgress?.([{ type: 'chapter_generation', roleId: 'chapter_generation', status: 'running', subtitle: '第三章 施工部署', message: '生成中' }]);
      return new Promise(() => {});
    });
    const { documentId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    await new Promise(resolve => setTimeout(resolve, 0));
    const aborted = abortGeneratedDocument(documentId, '/proj');
    expect(aborted?.status).toBe('aborted');
    expect(aborted?.error).toBe('用户中止');
    expect(aborted?.abortedBy).toBe('user-api');
    expect(aborted?.abortedStage).toBe('第三章 施工部署');
    expect(typeof aborted?.abortedAt).toBe('number');
  });
});

describe('资产管理', () => {
  it('generatedAssetAbsolutePath 三形态', () => {
    expect(generatedAssetAbsolutePath({ path: '' }, '/proj')).toBeNull();
    expect(generatedAssetAbsolutePath({ path: '/abs/file.md' }, '/proj')).toBe('/abs/file.md');
    expect(generatedAssetAbsolutePath({ path: 'generatedDocuments/assets/x.md' }, '/proj')).toContain('/generatedDocuments/assets/x.md');
    expect(generatedAssetAbsolutePath({ path: 'kb/file.pdf' }, '/proj')).toBe('/kb-root/kb/file.pdf');
  });

  it('upsertGeneratedAssets 新建与更新（source 判定、去重、保留 indexed）', () => {
    const asset = { id: 'a1', type: 'file' as const, role: 'generated' as const, path: 'generatedDocuments/assets/a.md', status: 'generated' as const };
    let next = upsertGeneratedAssets([asset], 'doc-1', '/proj');
    expect(next).toHaveLength(1);
    expect(next[0]!.source).toBe('generated');
    expect(next[0]!.usedByDocumentIds).toEqual(['doc-1']);
    expect(next[0]!.name).toBe('a.md');
    // 再 upsert 同 id：usedByDocumentIds 去重、indexed 保留
    next = upsertGeneratedAssets([asset], 'doc-1', '/proj');
    expect(next).toHaveLength(1);
    expect(next[0]!.usedByDocumentIds).toEqual(['doc-1']);
    // knowledge_base 资产 source 判定（path 非生成目录且 status 非生成态）
    const kbAsset = { id: 'k1', type: 'file' as const, role: 'reference' as const, path: 'kb/req.pdf', status: 'failed' as const };
    next = upsertGeneratedAssets([kbAsset], 'doc-2', '/proj');
    expect(next[1]!.source).toBe('knowledge_base');
  });

  it('listGeneratedAssets 按 updatedAt 倒序', () => {
    vi.useFakeTimers();
    try {
      upsertGeneratedAssets([{ id: 'a1', type: 'file' as const, role: 'generated', path: 'x.md', status: 'generated' as const }], 'doc-1', '/proj');
      vi.advanceTimersByTime(1000);
      upsertGeneratedAssets([{ id: 'a2', type: 'file' as const, role: 'generated', path: 'y.md', status: 'generated' as const }], 'doc-1', '/proj');
      const list = listGeneratedAssets('/proj');
      expect(list[0]!.id).toBe('a2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('getGeneratedAsset / deleteGeneratedAsset', () => {
    expect(getGeneratedAsset('nope', '/proj')).toBeNull();
    expect(deleteGeneratedAsset('nope', '/proj')).toBe(false);
    const asset = upsertGeneratedAssets([{ id: 'a1', type: 'file' as const, role: 'generated', path: 'generatedDocuments/assets/a.md', status: 'generated' as const }], 'doc-1', '/proj')[0]!;
    // 先写实际文件以便删除
    fs.mkdirSync(path.dirname(generatedAssetAbsolutePath(asset, '/proj')!), { recursive: true });
    fs.writeFileSync(generatedAssetAbsolutePath(asset, '/proj')!, 'x');
    expect(deleteGeneratedAsset('a1', '/proj')).toBe(true);
    expect(getGeneratedAsset('a1', '/proj')).toBeNull();
  });

  it('deleteGeneratedAsset 不删除知识库目录外的文件', () => {
    upsertGeneratedAssets([{ id: 'k1', type: 'file' as const, role: 'reference' as const, path: 'kb/keep.pdf', status: 'failed' as const }], 'doc-1', '/proj');
    expect(deleteGeneratedAsset('k1', '/proj')).toBe(true);
    // kb 根路径在 generatedRoot 之外，文件不会被 rm
  });

  it('upsertGeneratedDocumentAsset：空 markdown 返回 null，正常时写文件并登记', () => {
    expect(upsertGeneratedDocumentAsset(makeRecord({ markdown: '', editedMarkdown: '' }), '/proj')).toBeNull();
    const asset = upsertGeneratedDocumentAsset(makeRecord({ id: 'doc-9', markdown: '# 标题\n内容' }), '/proj');
    expect(asset).not.toBeNull();
    expect(asset!.id).toBe('document-doc-9');
    const absPath = generatedAssetAbsolutePath(asset!, '/proj')!;
    expect(fs.existsSync(absPath)).toBe(true);
    expect(fs.readFileSync(absPath, 'utf8')).toBe('# 标题\n内容');
    // 标题清洗非法字符后作为文件名（目录前缀除外）
    const weird = upsertGeneratedDocumentAsset(makeRecord({ id: 'doc-10', title: '标题：含/非法*字符', markdown: 'x' }), '/proj');
    const weirdBase = path.basename(weird!.path!);
    expect(weirdBase).not.toContain('/');
    expect(weirdBase).not.toContain('*');
  });

  it('openGeneratedAssetTarget', () => {
    expect(openGeneratedAssetTarget('nope', 'file', '/proj')).toBeNull();
    const asset = upsertGeneratedDocumentAsset(makeRecord({ id: 'doc-11', markdown: '内容' }), '/proj')!;
    const fileTarget = openGeneratedAssetTarget(asset.id, 'file', '/proj');
    expect(fileTarget).toBeTruthy();
    const dirTarget = openGeneratedAssetTarget(asset.id, 'directory', '/proj');
    expect(dirTarget).toBe(path.dirname(fileTarget!));
  });
});

describe('stale 标记与轮询判定', () => {
  it('generatingRecordRequiresFullPoll 四分支', () => {
    expect(generatingRecordRequiresFullPoll(null)).toBe(false);
    expect(generatingRecordRequiresFullPoll({ updatedAt: Date.now(), status: 'completed' })).toBe(false);
    // 宽限期内不强制
    expect(generatingRecordRequiresFullPoll({ updatedAt: Date.now() - 10_000, status: 'generating' })).toBe(false);
    // 进程启动前的 generating 记录强制
    expect(generatingRecordRequiresFullPoll({ updatedAt: 1, status: 'generating' })).toBe(true);
    // 超过 24h 阈值强制
    expect(generatingRecordRequiresFullPoll({ updatedAt: Date.now() - 25 * 60 * 60_000, status: 'generating' })).toBe(true);
  });

  it('listGeneratedDocuments 将陈旧 generating 记录标记为 failed（无 checkpoint）', () => {
    saveGeneratedDocument(makeRecord({ id: 'doc-s', status: 'generating', updatedAt: 1 }), '/proj', { preserveUpdatedAt: true });
    const list = listGeneratedDocuments('/proj');
    expect(list[0]!.status).toBe('failed');
    expect(list[0]!.error).toContain('已中断');
  });

  it('陈旧 generating 记录带 checkpoint 时标记为 warning', () => {
    const record = makeRecord({ id: 'doc-w', status: 'generating', updatedAt: 1 });
    record.checkpointChapters = [{ id: 'c1', title: '第一章', content: '内容', evidence: [], missingFacts: [] }];
    saveGeneratedDocument(record, '/proj', { preserveUpdatedAt: true });
    const list = listGeneratedDocuments('/proj');
    expect(list[0]!.status).toBe('warning');
    expect(list[0]!.warningIssues).toContain('生成任务已中断，请点击继续生成或重新生成');
  });

  it('服务重启后队列随内存消失：queued 记录读取时标记 failed（排队未执行文案）', () => {
    setProcessAliveProbeForTest(() => false);
    saveGeneratedDocument(makeRecord({ id: 'doc-q', status: 'queued', title: '排队中', updatedAt: 1, ownerPid: 4242 }), '/proj', { preserveUpdatedAt: true });
    const record = getGeneratedDocument('doc-q', '/proj');
    expect(record?.status).toBe('failed');
    expect(record?.error).toContain('排队任务未执行');
    expect(record?.interruptionReason).toBe('process-exited');
  });

  it('仍在待启动队列中的 queued 记录不判定中断（超宽限期亦不误杀）', () => {
    vi.mocked(generateDocumentDraft).mockImplementation(() => new Promise(() => {}));
    startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const queued = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    // 模拟长排队：把排队记录时间改早至超出宽限定值与进程启动时刻之前
    const stored = getGeneratedDocument(queued.documentId, '/proj')!;
    saveGeneratedDocument({ ...stored, updatedAt: 1 }, '/proj', { preserveUpdatedAt: true });
    setProcessAliveProbeForTest(() => false);
    expect(getGeneratedDocument(queued.documentId, '/proj')?.status).toBe('queued');
  });

  it('宽限期内的 generating 记录不被标记', () => {
    saveGeneratedDocument(makeRecord({ id: 'doc-g', status: 'generating', updatedAt: Date.now() - 5_000 }), '/proj', { preserveUpdatedAt: true });
    const list = listGeneratedDocuments('/proj');
    expect(list[0]!.status).toBe('generating');
  });

  it('宽限期 180s：owner 已死但 60s 内仍有更新 → 不判（旧 60s 宽限口径会误判为中断）', () => {
    setProcessAliveProbeForTest(() => false);
    saveGeneratedDocument(makeRecord({ id: 'doc-recent', status: 'generating', updatedAt: Date.now() - 60_000, ownerPid: 4242 }), '/proj', { preserveUpdatedAt: true });
    expect(getGeneratedDocument('doc-recent', '/proj')?.status).toBe('generating');
    expect(generatingRecordRequiresFullPoll(getGeneratedDocumentMeta('doc-recent', '/proj'))).toBe(false);
  });

  it('markStale 矩阵：owner 存活不判 / 已死立即判 process-exited / 缺失存量判 owner-unknown', () => {
    const hourAgo = Date.now() - 60 * 60_000;
    saveGeneratedDocument(makeRecord({ id: 'doc-alive', status: 'generating', updatedAt: hourAgo, ownerPid: 4242 }), '/proj', { preserveUpdatedAt: true });
    saveGeneratedDocument(makeRecord({ id: 'doc-dead', status: 'generating', updatedAt: hourAgo, ownerPid: 4242 }), '/proj', { preserveUpdatedAt: true });
    saveGeneratedDocument(makeRecord({ id: 'doc-legacy', status: 'generating', updatedAt: 1 }), '/proj', { preserveUpdatedAt: true });
    // owner 存活：超出宽限也不判（跨实例/多窗口保护）
    setProcessAliveProbeForTest(() => true);
    expect(getGeneratedDocument('doc-alive', '/proj')?.status).toBe('generating');
    // owner 已死：立即判 process-exited（带审计字段）
    setProcessAliveProbeForTest(() => false);
    const dead = getGeneratedDocument('doc-dead', '/proj');
    expect(dead?.status).toBe('failed');
    expect(dead?.interruptionReason).toBe('process-exited');
    expect(typeof dead?.interruptedAt).toBe('number');
    // 缺失归属的存量记录（updatedAt 早于进程启动）→ owner-unknown
    const legacy = getGeneratedDocument('doc-legacy', '/proj');
    expect(legacy?.status).toBe('failed');
    expect(legacy?.interruptionReason).toBe('owner-unknown');
  });

  it('owner 存活但心跳 24h 未更新 → heartbeat-lost（PID 复用悬挂兜底）', () => {
    setProcessAliveProbeForTest(() => true);
    saveGeneratedDocument(makeRecord({ id: 'doc-hang', status: 'generating', updatedAt: Date.now() - 25 * 60 * 60_000, ownerPid: 4242 }), '/proj', { preserveUpdatedAt: true });
    const record = getGeneratedDocument('doc-hang', '/proj');
    expect(record?.status).toBe('failed');
    expect(record?.interruptionReason).toBe('heartbeat-lost');
  });
});

describe('startGenerateDocumentTask', () => {
  it('门禁通过 → completed，登记操作日志与资源', async () => {
    vi.mocked(generateDocumentDraft).mockResolvedValue(makeResult());
    const { taskId, documentId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const task = getGenerateTask(taskId);
    expect(task).not.toBeNull();
    const record = await task!.promise;
    expect(record.status).toBe('completed');
    expect(record.title).toBe('施工组织设计');
    expect(record.draft?.markdown).toBeTruthy();
    expect(upsertKbOperation).toHaveBeenCalled();
    expect(getGenerateTask(taskId)).toBeNull();
    // 落盘与列表一致
    expect(getGeneratedDocument(documentId, '/proj')?.status).toBe('completed');
    expect(record.assets?.some(asset => asset.id === `document-${documentId}`)).toBe(true);
  });

  it('门禁未通过 + 实质正文 → failed（V2 批3 宁缺毋假：带病文档不作为交付件）', async () => {
    vi.mocked(generateDocumentDraft).mockResolvedValue(makeResult({
      markdown: '正文内容'.repeat(1000),
      exportGate: { passed: false, blockingIssues: [{ level: 'error', message: '空小节' }], checklist: [] },
    }));
    const { taskId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const record = await getGenerateTask(taskId)!.promise;
    expect(record.status).toBe('failed');
    expect(record.warningIssues?.length).toBeGreaterThan(0);
    // 未收敛阻断清单无条件置顶（不再依赖“警告为空才补泛化文案”的旧逻辑，可排查可续修）
    expect(record.warningIssues?.[0]).toContain('导出门禁未通过');
    expect(record.warningIssues?.[0]).toContain('空小节');
  });

  it('门禁未通过 + 无实质正文 → failed', async () => {
    vi.mocked(generateDocumentDraft).mockResolvedValue(makeResult({
      markdown: '短',
      exportGate: { passed: false, blockingIssues: [{ level: 'error', message: '空小节' }], checklist: [] },
    }));
    const { taskId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const record = await getGenerateTask(taskId)!.promise;
    expect(record.status).toBe('failed');
  });

  it('生成抛错 → failed；含 checkpoint 时 → warning', async () => {
    vi.mocked(generateDocumentDraft).mockRejectedValue(new Error('模型调用失败'));
    const { taskId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const record = await getGenerateTask(taskId)!.promise;
    expect(record.status).toBe('failed');
    expect(record.error).toBe('模型调用失败');
  });

  it('finalize 抛错 → 磁盘快照滞后时不误标已成功章节（catch 用内存最新 stages）', async () => {
    const stageA = { type: 'chapter_generation' as const, roleId: 'chapter_generation', status: 'success' as const, message: '第一章已成稿' };
    const stageB = { type: 'chapter_generation' as const, roleId: 'chapter_generation', status: 'running' as const, message: '第二章生成中' };
    vi.mocked(generateDocumentDraft).mockImplementation(async (input) => {
      input.onProgress?.([stageA, stageB], { chapters: [{ id: 'c1', title: '第一章', content: '检查点内容'.repeat(50), evidence: [], missingFacts: [], sections: ['1'] }] });
      return new Promise<GeneratedDocumentDraft>((_resolve, reject) => {
        reject(new Error('OUTLINE 指定 2 章，实际只生成 1 章'));
      });
    });
    const { taskId, documentId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const promise = getGenerateTask(taskId)!.promise;
    // 模拟磁盘快照滞后：最后一次进度写盘丢失，磁盘停留在「第一章仍 running」的旧快照
    const savedBefore = getGeneratedDocument(documentId, '/proj')!;
    saveGeneratedDocument({ ...savedBefore, executionStages: [{ ...stageA, status: 'running' as const }, stageB] }, '/proj');
    const record = await promise;
    expect(record.status).toBe('warning');
    const saved = getGeneratedDocument(documentId, '/proj')!;
    const chapterStages = (saved.executionStages || []).filter(stage => stage.type === 'chapter_generation');
    expect(chapterStages).toHaveLength(2);
    // 已成功章节不被旧快照误标 failed，仅真正 running 的章节标 failed
    expect(chapterStages[0]!.status).toBe('success');
    expect(chapterStages[1]!.status).toBe('failed');
  });

  it('用户中止 → aborted', async () => {
    vi.mocked(generateDocumentDraft).mockRejectedValue(new Error('用户中止'));
    const { taskId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const record = await getGenerateTask(taskId)!.promise;
    expect(record.status).toBe('aborted');
  });

  it('第三方含 "aborted" 字样的错误不再误判已中止 → failed（精确匹配）', async () => {
    vi.mocked(generateDocumentDraft).mockRejectedValue(new Error('This operation was aborted'));
    const { taskId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const record = await getGenerateTask(taskId)!.promise;
    expect(record.status).toBe('failed');
    expect(record.error).toBe('This operation was aborted');
  });

  it('signal 已中止时非精确中止文案仍落 aborted（signal 双判）', async () => {
    let rejectDraft: ((error: Error) => void) | null = null;
    vi.mocked(generateDocumentDraft).mockImplementation(() => new Promise((_resolve, reject) => { rejectDraft = reject; }));
    const { taskId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    await new Promise(resolve => setTimeout(resolve, 0));
    const task = getGenerateTask(taskId)!;
    task.controller.abort();
    rejectDraft!(new Error('The operation was aborted'));
    const record = await task.promise;
    expect(record.status).toBe('aborted');
  });

  it('任务启动写入 ownerPid/ownerStartedAt（进度写盘与 meta 同步）', async () => {
    vi.mocked(generateDocumentDraft).mockImplementation(() => new Promise(() => {}));
    const { documentId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const record = getGeneratedDocument(documentId, '/proj');
    expect(record?.ownerPid).toBe(process.pid);
    expect(typeof record?.ownerStartedAt).toBe('number');
    expect(getGeneratedDocumentMeta(documentId, '/proj')?.ownerPid).toBe(process.pid);
  });

  it('并发上限：容量满时新请求进入排队（不再抛错）', () => {
    process.env.DOCUMENT_MAX_CONCURRENT_GENERATIONS = '1';
    vi.mocked(generateDocumentDraft).mockImplementation(() => new Promise(() => {}));
    startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const second = startGenerateDocumentTask({ templateId: 't2' }, '/proj');
    expect(second.queuePosition).toBe(1);
    expect(getGeneratedDocument(second.documentId, '/proj')?.status).toBe('queued');
  });

  it('同模板同项目连点：创建新的排队任务（不再复用运行中任务）', () => {
    vi.mocked(generateDocumentDraft).mockImplementation(() => new Promise(() => {}));
    const first = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const second = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    expect(second.taskId).not.toBe(first.taskId);
    expect(second.queuePosition).toBe(1);
    expect(getGeneratedDocument(first.documentId, '/proj')?.status).toBe('generating');
    expect(getGeneratedDocument(second.documentId, '/proj')?.status).toBe('queued');
  });

  it('任务完成后自动接续下一个排队任务（无需人工再点）', async () => {
    const resolvers: Array<(value: GeneratedDocumentDraft) => void> = [];
    vi.mocked(generateDocumentDraft).mockImplementation(async () => new Promise<GeneratedDocumentDraft>(resolve => { resolvers.push(resolve); }));
    const first = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const second = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    expect(getGeneratedDocument(second.documentId, '/proj')?.status).toBe('queued');
    await new Promise(resolve => setTimeout(resolve, 0));
    resolvers[0]!(makeResult());
    await getGenerateTask(first.taskId)!.promise;
    // finally 释放名额并 pump：第二个任务自动启动（无需再次调用 startGenerateDocumentTask）
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getGeneratedDocument(second.documentId, '/proj')?.status).toBe('generating');
    expect(getGenerateTask(second.taskId)).not.toBeNull();
    resolvers[1]!(makeResult());
    const done = await getGenerateTask(second.taskId)!.promise;
    expect(done.status).toBe('completed');
  });

  it('队首同模板阻塞时跳过：后续不同模板排队任务先启动', () => {
    vi.mocked(generateDocumentDraft).mockImplementation(() => new Promise(() => {}));
    startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const sameTemplate = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    expect(sameTemplate.queuePosition).toBe(1);
    const other = startGenerateDocumentTask({ templateId: 't2' }, '/proj');
    // 容量 2 有空位，但队首 t1 因同模板互斥不可启动 → t2 跳过直接启动
    expect(other.queuePosition).toBeUndefined();
    expect(getGeneratedDocument(other.documentId, '/proj')?.status).toBe('generating');
    expect(getGeneratedDocument(sameTemplate.documentId, '/proj')?.status).toBe('queued');
  });

  it('中止排队任务：从队列摘除并落 aborted（abortedStage=生成队列）', () => {
    vi.mocked(generateDocumentDraft).mockImplementation(() => new Promise(() => {}));
    startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const queued = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const aborted = abortGeneratedDocument(queued.documentId, '/proj');
    expect(aborted?.status).toBe('aborted');
    expect(aborted?.abortedStage).toBe('生成队列');
    expect(getQueuedDocumentPosition(queued.documentId)).toBeUndefined();
  });

  it('删除排队中的文档：同步摘除队列请求', () => {
    vi.mocked(generateDocumentDraft).mockImplementation(() => new Promise(() => {}));
    startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const queued = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    expect(getQueuedDocumentPosition(queued.documentId)).toBe(1);
    deleteGeneratedDocument(queued.documentId, '/proj');
    expect(getQueuedDocumentPosition(queued.documentId)).toBeUndefined();
  });

  it('resumeDocumentId 复用现有 active 任务', () => {
    vi.mocked(generateDocumentDraft).mockImplementation(() => new Promise(() => {}));
    const first = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const resumed = startGenerateDocumentTask({ templateId: 't1', resumeDocumentId: first.documentId }, '/proj');
    expect(resumed.taskId).toBe(first.taskId);
  });

  it('onProgress 回调持久化 checkpoint 章节', async () => {
    let resolveDraft!: (value: GeneratedDocumentDraft) => void;
    vi.mocked(generateDocumentDraft).mockImplementation(async (input) => {
      input.onProgress?.([], { chapters: [{ id: 'c1', title: '第一章', content: '检查点内容', evidence: [], missingFacts: [], sections: ['1.1'] }] });
      return new Promise<GeneratedDocumentDraft>(resolve => { resolveDraft = resolve; });
    });
    const { taskId, documentId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const promise = getGenerateTask(taskId)!.promise;
    // 任务链先经语义预热（mock 微任务）再进入生成：等待微任务刷新后 checkpoint 已落盘
    await new Promise(resolve => setTimeout(resolve, 0));
    const mid = getGeneratedDocument(documentId, '/proj');
    expect(mid?.status).toBe('generating');
    expect(mid?.checkpointChapters?.[0]?.id).toBe('c1');
    expect(mid?.checkpointChapters?.[0]?.content).toBe('检查点内容');
    resolveDraft(makeResult());
    const record = await promise;
    expect(record.status).toBe('completed');
  });

  it('warningIssues 过滤：隐藏诊断/非正式H2/页码/施工方条件性保留', async () => {
    vi.mocked(generateDocumentDraft).mockResolvedValue(makeResult({
      markdown: '# 标题\n\n## 概述\n\n## 第3页\n\n施工方责任\n\n正文内容'.repeat(200),
      exportGate: { passed: true, blockingIssues: [], checklist: [] },
      validationIssues: [
        { level: 'warning', message: '结构化事实读取不足' },
        { level: 'warning', message: '正文存在非正式章二级标题' },
        { level: 'warning', message: '页码引用不规范' },
        { level: 'warning', message: '施工方不得出现' },
        { level: 'warning', message: '普通问题', suggestion: '请修改' },
      ],
    }));
    const { taskId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const record = await getGenerateTask(taskId)!.promise;
    expect(record.warningIssues).not.toContain('结构化事实读取不足');
    // 正文含非正式 H2 与页码与施工方，条件性保留
    expect(record.warningIssues).toContain('正文存在非正式章二级标题');
    expect(record.warningIssues).toContain('页码引用不规范');
    expect(record.warningIssues).toContain('施工方不得出现');
    expect(record.warningIssues).toContain('普通问题：请修改');
  });

  it('sectionGaps 空洞小节补充提示置顶', async () => {
    vi.mocked(collectSectionContentGaps).mockReturnValue([{ reason: 'empty' as const, sectionTitle: '1.1 空洞', chapterId: 'c1' }, { reason: 'short' as const, sectionTitle: '1.2 正常', chapterId: 'c1' }] as never);
    vi.mocked(generateDocumentDraft).mockResolvedValue(makeResult());
    const { taskId } = startGenerateDocumentTask({ templateId: 't1' }, '/proj');
    const record = await getGenerateTask(taskId)!.promise;
    expect(record.warningIssues?.[0]).toContain('仍有 1 个空洞小节');
  });
});

describe('列表项派生与证据裁剪', () => {
  it('toGeneratedDocumentListItem 派生字段', () => {
    const record = makeRecord({ id: 'doc-x' });
    record.executionStages = [
      { type: 'validation', roleId: 'r1', status: 'success', message: '第一步' },
      { type: 'validation', roleId: 'agent-final-gate', status: 'success', subtitle: '导出门禁', message: '完成' },
    ];
    record.checkpointChapters = [
      { id: 'c1', title: '第一章', content: '内容一', evidence: [], missingFacts: [] },
      { id: 'c2', title: '第二章', content: '', evidence: [], missingFacts: [], inProgress: true },
    ];
    saveGeneratedDocument(record, '/proj');
    const item = listGeneratedDocuments('/proj')[0]!;
    expect(item.latestStage).toBe('导出门禁');
    expect(item.latestMessage).toBe('完成');
    expect(item.chapterCount).toBe(2);
    expect(item.completedChapterCount).toBe(1);
    expect(item.wordCount).toBeGreaterThan(0);
  });

  it('saveGeneratedDocument 裁剪证据条目与内容长度', () => {
    process.env.DOCUMENT_TUNING_PROFILE = JSON.stringify({ persistEvidenceMaxItems: 4, persistEvidenceItemChars: 300 });
    const record = makeRecord();
    record.draft = makeResult();
    record.draft.checkpointChapters = [{
      id: 'c1', title: '第一章', content: 'x',
      evidence: Array.from({ length: 6 }, (_, i) => ({ chapterId: 'c1', filePath: `f${i}`, score: 1, content: `很长的证据内容${i}`.repeat(100) })),
      missingFacts: [],
    }];
    const saved = saveGeneratedDocument(record, '/proj');
    const chapter = saved.draft!.checkpointChapters![0]!;
    expect(chapter.evidence).toHaveLength(4);
    expect(chapter.evidence[0]!.content.length).toBeLessThanOrEqual(300);
  });
});
