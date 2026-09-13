/**
 * 生成中止韧性故障注入验证（真实进程 / 真实文件系统，显式运行，.manual.ts 不参与全量）。
 *
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/resilient-interruption.manual.ts
 *
 * 覆盖「生成中止韧性修复方案」测试与验收节的三项故障注入：
 * 1) 真实 kill -9：generating 记录归属子进程被强杀后，本进程读取即判 process-exited（保留
 *    checkpoint 可「继续生成」）；存活归属进程的记录不被误判；存活超 24h 未心跳 → heartbeat-lost。
 * 2) detSafe 注入抛错（同步 throw / 异步 reject）→ 显性 warning 降级，不穿透炸整篇。
 * 3) 模型不可用（CUSTOMIZE_BGE_MODEL_PATH 指向损坏模型目录）→ 预热分钟 0 快速失败；
 *    DOCUMENT_SKIP_EMBED_PREFLIGHT=1 可跳过。
 *
 * 前置说明：
 * - 用例 1 依赖默认阈值（宽限 180s、心跳兜底 24h）；若显式设置了 DOCUMENT_RECENT_UPDATE_GRACE_MS /
 *   DOCUMENT_ABANDONED_RECORD_STALE_MS，请先 unset 再运行。
 * - 用例 3 会创建进程级缓存的本地语义 provider（指向损坏目录）并污染该 worker 的 sharedProvider，
 *   故置于文件末尾；vitest 各测试文件默认隔离（独立 worker），不影响其他测试文件。
 * - 真实「继续生成」到成稿需要 LLM 环境，人工步骤：将 doc-todead 对应记录在列表中点击「继续生成」
 *   （可恢复入口前置：状态 warning + checkpoint 保留即满足；本脚本已断言该前置）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  generatedRoot,
  generatingRecordRequiresFullPoll,
  getGeneratedDocument,
  getGeneratedDocumentMeta,
  saveGeneratedDocument,
  type GeneratedDocumentRecord,
} from '@/services/document-core/generatedDocumentService';
import { detSafe } from '@/services/document-workflow/detectorFixerRegistry';
import { preflightLocalSemanticProvider } from '@/services/document-workflow/semanticSimilarity';

const PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'resilient-interruption-'));
/** 临时 projectRoot 映射的存储目录（~/.customize-agent/projects/<projectId>），结束后整体清理 */
const PROJECT_STORE_ROOT = path.dirname(generatedRoot(PROJECT_ROOT));
const TEN_MIN_AGO = Date.now() - 10 * 60_000;
const HOURS_25_AGO = Date.now() - 25 * 60 * 60_000;
const STALE_CHECKPOINT = [{ id: 'c1', title: '第一章', content: '检查点内容', evidence: [], missingFacts: [], sections: ['1.1'] }] as unknown as GeneratedDocumentRecord['checkpointChapters'];

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

/** 真实长存活子进程：本进程对它的判活/判死走生产 probe（process.kill(pid,0)），不注入 mock */
function spawnIdleChild() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000);'], { stdio: 'ignore' });
}

afterAll(() => {
  fs.rmSync(PROJECT_ROOT, { recursive: true, force: true });
  fs.rmSync(PROJECT_STORE_ROOT, { recursive: true, force: true });
});

describe('故障注入 1：真实 kill -9 的进程中断判定（ownerPid 判活/判死）', () => {
  it('存活归属进程不判 → kill -9 后立即 process-exited 且 checkpoint 保留可恢复', async () => {
    const child = spawnIdleChild();
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });
    const ownerPid = child.pid;
    expect(typeof ownerPid).toBe('number');

    // 三条记录：alive（超宽限但 owner 存活）、hang（owner 存活但 25h 未心跳）、todead（kill 后应判）
    saveGeneratedDocument(makeRecord({ id: 'doc-alive', status: 'generating', updatedAt: TEN_MIN_AGO, ownerPid }), PROJECT_ROOT, { preserveUpdatedAt: true });
    saveGeneratedDocument(makeRecord({ id: 'doc-hang', status: 'generating', updatedAt: HOURS_25_AGO, ownerPid }), PROJECT_ROOT, { preserveUpdatedAt: true });
    saveGeneratedDocument(makeRecord({
      id: 'doc-todead',
      status: 'generating',
      updatedAt: HOURS_25_AGO,
      ownerPid,
      checkpointChapters: STALE_CHECKPOINT,
      executionStages: [{ id: 's1', roleId: 'writer', roleName: '写作', subtitle: '正文写作', status: 'running' }] as unknown as GeneratedDocumentRecord['executionStages'],
    }), PROJECT_ROOT, { preserveUpdatedAt: true });

    // ① 存活：超宽限也不判（跨实例/多窗口保护），轮询短路与 stale 判定同口径
    expect(getGeneratedDocument('doc-alive', PROJECT_ROOT)?.status).toBe('generating');
    expect(generatingRecordRequiresFullPoll(getGeneratedDocumentMeta('doc-alive', PROJECT_ROOT))).toBe(false);

    // ② 心跳兜底：owner 存活但 25h 未更新 → heartbeat-lost（防 PID 复用悬挂）
    const hang = getGeneratedDocument('doc-hang', PROJECT_ROOT);
    expect(hang?.status).toBe('failed');
    expect(hang?.interruptionReason).toBe('heartbeat-lost');

    // ③ 真实 kill -9：收到 exit（进程已回收）后读取即判 process-exited
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    const dead = getGeneratedDocument('doc-todead', PROJECT_ROOT);
    expect(dead?.status).toBe('warning'); // 有 checkpoint → warning（保底可恢复）
    expect(dead?.interruptionReason).toBe('process-exited');
    expect(typeof dead?.interruptedAt).toBe('number');
    expect(dead?.error).toContain('已中断');
    expect(dead?.checkpointChapters?.length).toBeGreaterThan(0); // 继续生成复用基础
    expect(dead?.warningIssues?.some(issue => /已中断/u.test(issue))).toBe(true);
    expect(dead?.executionStages?.every(stage => stage.status !== 'running')).toBe(true);
    // meta 与 draft 同步（轻量轮询即判中断）
    expect(getGeneratedDocumentMeta('doc-todead', PROJECT_ROOT)?.status).toBe('warning');
  });
});

describe('故障注入 2：末期检测器异常 → detSafe 显性 warning 降级', () => {
  it('同步抛错不穿透，返回单条 warning issue（含检测器名与原始原因）', async () => {
    const issues = await detSafe('fault-injection-det', () => {
      throw new Error('injected detector failure');
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe('warning');
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.message).toContain('fault-injection-det');
    expect(issues[0]?.message).toContain('injected detector failure');
  });

  it('异步 reject 同样降级', async () => {
    const issues = await detSafe('fault-injection-det-async', async () => {
      throw new Error('async injected');
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe('warning');
  });
});

describe('故障注入 3：模型不可用 → 预热快速失败（置于文件末尾：会污染 sharedProvider）', () => {
  it('损坏模型目录 + 预热 → 明确错误快速失败；SKIP 开关可跳过', async () => {
    const brokenModelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-bge-'));
    // 伪造"存在 config/tokenizer 但无权重"的模型目录：resolveBundledBgeModelPath 会选中它，
    // pipeline 本地加载（allowRemoteModels=false）失败 → 预热失败
    fs.writeFileSync(path.join(brokenModelDir, 'config.json'), '{}');
    fs.writeFileSync(path.join(brokenModelDir, 'tokenizer.json'), '{}');
    process.env.CUSTOMIZE_BGE_MODEL_PATH = brokenModelDir;
    try {
      const startedAt = Date.now();
      await expect(preflightLocalSemanticProvider()).rejects.toThrow('本地语义模型预热失败');
      expect(Date.now() - startedAt).toBeLessThan(60_000); // 分钟 0 暴露，不允许长挂
      process.env.DOCUMENT_SKIP_EMBED_PREFLIGHT = '1';
      await expect(preflightLocalSemanticProvider()).resolves.toBeUndefined();
    } finally {
      delete process.env.CUSTOMIZE_BGE_MODEL_PATH;
      delete process.env.DOCUMENT_SKIP_EMBED_PREFLIGHT;
      fs.rmSync(brokenModelDir, { recursive: true, force: true });
    }
  }, 120_000);
});
