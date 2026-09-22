/**
 * 4.55.29 L1-1/L1-2/L1-3/L1-4 导出门禁接回锁定：
 * - L1-1 门禁默认生效：未通过且未显式声明 `allowNonDeliverable` → 422（`enforceGate:false` 静默关闸的调用面已删除）；
 * - L1-3 放行必须自标注：显式放行时文件名强制加「_非交付物_」后缀 + 响应头置位；
 * - L1-2 消费侧契约：响应头名与前端 lib/api.ts 的字面量镜像一致（前端据此读交付资格并按服务端文件名下载）；
 * - L1-4 门禁清单归档：导出时把门禁清单（含检测器身份/修复路径）写入 exportReports，供修复轮消费。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NON_DELIVERABLE_FILENAME_SUFFIX, NON_DELIVERABLE_HEADER, markNonDeliverableFilename } from '@/services/document-workflow/exportNaming';

const mocks = vi.hoisted(() => ({
  updateGeneratedDocument: vi.fn((_id: string, _patch: Record<string, unknown>, _root?: string) => undefined),
  recordGate: undefined as { passed: boolean; blockingIssues: Array<Record<string, unknown>> } | undefined,
}));

vi.mock('@/services/document-core/generatedDocumentService', () => ({
  generatedRoot: '/tmp/export-gate-test/assets',
  getGeneratedDocument: (id: string) => ({
    id,
    title: '测试文档',
    templateId: 'construction-organization-design',
    requirement: '',
    markdown: '# 测试文档\n\n正文。',
    assets: [],
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    completedAt: Date.now(),
    draft: { chapters: [{ id: 'c1', title: '第一章 工程概况', content: '' }], exportGate: mocks.recordGate },
  }),
  updateGeneratedDocument: (id: string, patch: Record<string, unknown>, root?: string) => mocks.updateGeneratedDocument(id, patch, root),
}));

const { default: exportHandler } = await import('@/pages/api/documents/export');

interface MockResponse {
  headers: Record<string, string>;
  statusCode: number;
  jsonBody?: unknown;
  sentBody?: unknown;
  headersSent: boolean;
  setHeader: (key: string, value: string) => MockResponse;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
  send: (body: unknown) => MockResponse;
}

function createResponse(): MockResponse {
  const res = { headers: {} as Record<string, string>, statusCode: 0, headersSent: false } as MockResponse;
  res.setHeader = (key, value) => { res.headers[key] = value; return res; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.jsonBody = body; return res; };
  res.send = body => { res.sentBody = body; return res; };
  return res;
}

const blockingIssue = {
  level: 'error' as const,
  severity: 'blocker' as const,
  category: 'structure' as const,
  repairability: 'local_deterministic' as const,
  message: '第一章 空小节：1.1 施工准备',
  suggestion: '补充该小节正文。',
  provenance: { detectorId: 'test-detector', fingerprint: 'fp-1' },
};

async function postExport(body: Record<string, unknown>) {
  const res = createResponse();
  await exportHandler({ method: 'POST', body: { title: '测试文档', markdown: '# 测试文档\n\n正文。', format: 'markdown', projectRoot: '/tmp/export-gate-test', ...body } } as never, res as never);
  return res;
}

beforeEach(() => {
  mocks.updateGeneratedDocument.mockClear();
  mocks.recordGate = undefined;
  // 导出纯渲染模式固定为 observe：本用例只锁门禁与标注口径，不受源层结构缺陷 enforce 影响
  process.env.DOCUMENT_EXPORT_PURE_RENDER = 'observe';
});

afterEach(() => {
  delete process.env.DOCUMENT_EXPORT_PURE_RENDER;
});

describe('4.55.29 L1-3 非交付物文件名标注', () => {
  it('后缀追加在扩展名之前，且幂等', () => {
    expect(markNonDeliverableFilename('施工组织设计.pdf')).toBe(`施工组织设计${NON_DELIVERABLE_FILENAME_SUFFIX}.pdf`);
    expect(markNonDeliverableFilename(markNonDeliverableFilename('施工组织设计.pdf'))).toBe(`施工组织设计${NON_DELIVERABLE_FILENAME_SUFFIX}.pdf`);
    expect(markNonDeliverableFilename('无扩展名')).toBe(`无扩展名${NON_DELIVERABLE_FILENAME_SUFFIX}`);
  });

  it('响应头名与前端镜像一致（客户端按字面量读取）', () => {
    expect(NON_DELIVERABLE_HEADER).toBe('X-Export-Not-Deliverable');
  });
});

describe('4.55.29 L1-1 门禁默认生效', () => {
  it('门禁未通过且未显式放行 → 422 阻断，不产出任何产物', async () => {
    const res = await postExport({ exportGate: { passed: false, blockingIssues: [blockingIssue] } });
    expect(res.statusCode).toBe(422);
    expect((res.jsonBody as { error?: string }).error).toBe('EXPORT_GATE_BLOCKED');
    expect((res.jsonBody as { issues?: unknown[] }).issues?.length).toBe(1);
    expect(res.sentBody).toBeUndefined();
    expect(res.headers['Content-Disposition']).toBeUndefined();
  });

  it('blockingIssues 为空但 passed=false（检查项未完成）同样阻断', async () => {
    const res = await postExport({ exportGate: { passed: false, blockingIssues: [] } });
    expect(res.statusCode).toBe(422);
    expect((res.jsonBody as { message?: string }).message).toContain('导出门禁未通过');
  });
});

describe('4.55.29 L1-3 显式放行必须自标注', () => {
  it('allowNonDeliverable 放行：后缀 + 响应头 + 清单头齐备', async () => {
    const res = await postExport({ documentId: 'doc-1', exportGate: { passed: false, blockingIssues: [blockingIssue] }, allowNonDeliverable: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers[NON_DELIVERABLE_HEADER]).toBe('true');
    expect(res.headers['X-Export-Gate-Passed']).toBe('false');
    expect(decodeURIComponent(res.headers['Content-Disposition'] || '')).toContain(`测试文档${NON_DELIVERABLE_FILENAME_SUFFIX}.md`);
    const gateIssues = JSON.parse(decodeURIComponent(res.headers['X-Export-Gate-Issues'] || '[]')) as string[];
    expect(gateIssues[0]).toContain('空小节');
    expect(String(res.sentBody)).toContain('测试文档');
  });

  it('门禁通过：无后缀、头部显式声明 false', async () => {
    const res = await postExport({ exportGate: { passed: true, blockingIssues: [] } });
    expect(res.statusCode).toBe(200);
    expect(res.headers[NON_DELIVERABLE_HEADER]).toBe('false');
    expect(res.headers['X-Export-Gate-Passed']).toBe('true');
    expect(decodeURIComponent(res.headers['Content-Disposition'] || '')).toContain('测试文档.md');
    expect(decodeURIComponent(res.headers['Content-Disposition'] || '')).not.toContain(NON_DELIVERABLE_FILENAME_SUFFIX);
  });

  it('记录侧门禁优先于请求体（客户端声明「已通过」不得覆盖服务端结论）', async () => {
    mocks.recordGate = { passed: false, blockingIssues: [blockingIssue] };
    const res = await postExport({ documentId: 'doc-1', exportGate: { passed: true, blockingIssues: [] } });
    expect(res.statusCode).toBe(422);
    expect((res.jsonBody as { error?: string }).error).toBe('EXPORT_GATE_BLOCKED');
  });
});

describe('4.55.29 L1-4 门禁清单归档（修复轮消费面）', () => {
  it('放行的非交付物导出把门禁清单写入 exportReports（含检测器身份与修复路径）', async () => {
    const res = await postExport({ documentId: 'doc-1', exportGate: { passed: false, blockingIssues: [blockingIssue] }, allowNonDeliverable: true });
    expect(res.statusCode).toBe(200);
    expect(mocks.updateGeneratedDocument).toHaveBeenCalledTimes(1);
    const patch = mocks.updateGeneratedDocument.mock.calls[0][1] as { exportReports?: Array<Record<string, unknown>> };
    const report = patch.exportReports?.[0] as { gateIssueCount?: number; gateChecklist?: { total: number; items: Array<{ problem: string; detectorId?: string; repairPath: string }> } };
    expect(report.gateIssueCount).toBe(1);
    expect(report.gateChecklist?.total).toBe(1);
    expect(report.gateChecklist?.items[0].problem).toContain('空小节');
    expect(report.gateChecklist?.items[0].detectorId).toBe('test-detector');
    expect(report.gateChecklist?.items[0].repairPath).toContain('确定性修复器');
  });

  it('交付物导出不写门禁清单（避免「交付物带阻断清单」的自相矛盾归档）', async () => {
    await postExport({ documentId: 'doc-1', exportGate: { passed: true, blockingIssues: [] } });
    const patch = mocks.updateGeneratedDocument.mock.calls[0][1] as { exportReports?: Array<Record<string, unknown>> };
    const report = patch.exportReports?.[0] as { gateIssueCount?: number; gateChecklist?: unknown };
    expect(report.gateIssueCount).toBeUndefined();
    expect(report.gateChecklist).toBeUndefined();
  });
});
