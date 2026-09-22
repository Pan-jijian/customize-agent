import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DocumentDraftChapter, GeneratedDocumentDraft, DocumentAsset } from '../document-workflow/types';
import { appendFingerprintEntry, extractHeadingTitles, generateDocumentDraft, getDocumentTemplate } from '../document-workflow';
import { preflightLocalSemanticProvider } from '../document-workflow/semanticSimilarity';
import { collectSectionContentGaps } from '../document-workflow/qualityValidation';
import { buildSuspensionChecklist, formatSuspensionBanner } from '../document-workflow/suspensionChecklist';
import { DOCUMENT_WORKFLOW_VERSION } from '../document-workflow/documentWorkflowVersion';
import { computeProjectId } from '@customize-agent/knowledge';
import { getProjectKbRoot, getProjectRoot } from '../knowledge/kbService';
import { documentTextLength } from '../document-workflow/budget';
import { tuningProfile } from '../document-workflow/tuningProfile';
import { upsertKbOperation } from '../knowledge/kbOperationLog';

export type GeneratedDocumentStatus = 'queued' | 'generating' | 'completed' | 'completed_with_issues' | 'warning' | 'failed' | 'aborted';

export interface GeneratedDocumentListItem {
  id: string;
  taskId?: string;
  templateId: string;
  templateName?: string;
  templateVersion?: number;
  title: string;
  requirement: string;
  projectRoot?: string;
  projectId?: string;
  knowledgeBasePath?: string;
  status: GeneratedDocumentStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  elapsedMs?: number;
  error?: string;
  warningIssues?: string[];
  warningCount?: number;
  blockerCount?: number;
  suggestionCount?: number;
  wordCount?: number;
  chapterCount?: number;
  completedChapterCount?: number;
  latestStage?: string;
  latestMessage?: string;
  assets?: DocumentAsset[];
  partialChapters?: GeneratedDocumentDraft['partialChapters'];
  /** 排队位次（1 起，随队列变化）：仅 status='queued' 的记录携带 */
  queuePosition?: number;
}

export interface GeneratedDocumentRecord {
  id: string;
  taskId?: string;
  templateId: string;
  templateName?: string;
  templateVersion?: number;
  title: string;
  requirement: string;
  projectRoot?: string;
  projectId?: string;
  knowledgeBasePath?: string;
  markdown: string;
  editedMarkdown?: string;
  wordCount?: number;
  status: GeneratedDocumentStatus;
  draft?: GeneratedDocumentDraft;
  executionStages?: GeneratedDocumentDraft['executionStages'];
  partialChapters?: GeneratedDocumentDraft['partialChapters'];
  checkpointChapters?: DocumentDraftChapter[];
  reviewMetadata?: GeneratedDocumentDraft['reviewMetadata'];
  promptProvenance?: GeneratedDocumentDraft['promptProvenance'];
  agentWorkflow?: GeneratedDocumentDraft['agentWorkflow'];
  assets: DocumentAsset[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  warningIssues?: string[];
  /** 任务归属进程 PID / 归属进程启动时刻：中断判定做存活探测（多实例与重启归因），任务启动与进度写盘时写入 */
  ownerPid?: number;
  ownerStartedAt?: number;
  /** 进程层中断判定归档（markStaleGeneratingRecord 写入）：判定时刻与原因 */
  interruptedAt?: number;
  interruptionReason?: 'process-exited' | 'heartbeat-lost' | 'owner-unknown';
  /** 人工中止审计（abortGeneratedDocument 写入）：时刻 / 来源 / 中止时正在运行的阶段 */
  abortedAt?: number;
  abortedBy?: string;
  abortedStage?: string;
  maxEvidencePerChapter?: number;
  /** 导出后闭环报告历史（B3：归档总用时/质量对标分/规则执行摘要/修复记录，支持历史对比） */
  exportReports?: ExportReport[];
  /** E5 修订闭环审计（批 1）：系统修订日志——唯一入口工具写入，修订必须显式声明、可审计 */
  revisionLog?: Array<{ at: number; note?: string; replacements: number; beforeChars: number; afterChars: number; beforeWordCount: number; afterWordCount: number }>;
}

/** 导出后闭环报告：归档到记录详情，支持与历史版本对比 */
export interface ExportReport {
  format: 'markdown' | 'html' | 'pdf' | 'docx';
  exportedAt: number;
  /** 生成总用时（毫秒） */
  durationMs?: number;
  /** 提示词规则执行摘要 */
  ruleSummary?: string[];
  /** 审查修复记录：已修复问题数 */
  repairedCount?: number;
  /** 审查修复记录：阻断问题数 */
  blockingCount?: number;
  gatePassed?: boolean;
  /** P18 自动健康诊断告警（导出时从 draft.reviewMetadata.telemetry 归档） */
  healthAlerts?: string[];
  /** P19 修复轮热力图（导出时归档，跨文档缺陷热力图分析数据源） */
  repairHeat?: Record<string, { hits: number; repaired: number; failed: number }>;
  /** A1 导出纯渲染审计（批 1）：模式/源层缺陷/渲染层结构操作计数——dry-run 误报采样与守恒断言证据 */
  renderAudit?: ExportRenderAuditReport;
}

/** A1 导出纯渲染审计摘要（导出层写入，export.ts 同形状：响应头与归档共用，禁止两处口径分叉） */
export interface ExportRenderAuditReport {
  /** 开关模式：off/observe/enforce */
  mode: string;
  /** 源层结构性缺陷（裸表/孤立分隔线）数量与定位明细 */
  blockerCount: number;
  blockerCodes: string[];
  /** 非阻断提示（如单位书写残留） */
  notices: string[];
  /** 渲染层结构操作计数（补分隔线/列对齐/边界截断/内联分隔线剥离/插空行/单位改写） */
  ops: Record<string, number>;
  opsTotal: number;
}

function failRunningStages(stages: GeneratedDocumentRecord['executionStages'], message: string): GeneratedDocumentRecord['executionStages'] {
  return stages?.map(stage => stage.status === 'running' ? { ...stage, status: 'failed' as const, message } : stage);
}

function isAbortError(error: unknown) {
  // 中止判定收敛（消除误判面）：只认精确的『用户中止』文案——throwIfAborted / llmClient 信号门控是
  // 唯一中止来源；不再用 /abort/i 宽正则（历史缺陷：任何含 "aborted" 字样的第三方异常，如 fetch
  // DOMException "This operation was aborted"，都会被误标『已中止』，用户误以为被系统自动中止）
  return error instanceof Error && error.message === '用户中止';
}

function fallbackFailedTitle(record: Pick<GeneratedDocumentRecord, 'title' | 'templateName'>) {
  return record.title && record.title !== '生成中' && record.title !== '排队中' ? record.title : `${record.templateName || '文档'}生成失败`;
}

function mergeDraftChapters(...sources: Array<DocumentDraftChapter[] | undefined>): DocumentDraftChapter[] {
  const chapters = new Map<string, DocumentDraftChapter>();
  for (const source of sources) {
    for (const chapter of source || []) {
      if (chapter.id && chapter.content?.trim()) chapters.set(chapter.id, chapter);
    }
  }
  return [...chapters.values()];
}

function reusableCheckpointChapters(existing: GeneratedDocumentRecord | null, input: { templateId: string; requirement?: string }, projectRoot: string): DocumentDraftChapter[] {
  if (!existing) return [];
  const template = getDocumentTemplate(input.templateId);
  const workflowVersion = existing.reviewMetadata?.workflowVersion?.version || existing.draft?.reviewMetadata?.workflowVersion?.version;
  const exportGatePassed = existing.draft?.exportGate?.passed === true;
  const sameTemplate = existing.templateId === input.templateId && (!template || !existing.templateVersion || existing.templateVersion === template.version);
  const sameProject = existing.projectRoot === projectRoot && existing.projectId === computeProjectId(projectRoot);
  const sameRequirement = (existing.requirement || '') === (input.requirement || '');
  if (!sameTemplate || !sameProject || !sameRequirement || workflowVersion !== DOCUMENT_WORKFLOW_VERSION.version || !exportGatePassed) return [];
  const passingIds = new Set((existing.draft?.partialChapters || existing.partialChapters || []).filter(chapter => chapter.status === 'completed').map(chapter => chapter.id));
  return mergeDraftChapters(existing.draft?.chapters, existing.checkpointChapters).filter(chapter =>
    passingIds.has(chapter.id) &&
    Boolean(chapter.content?.trim()) &&
    !/WRITER_MISSING_SECTION|Writer 未完成/u.test(chapter.content)
  );
}

function summarizeCheckpointChapters(chapters: DocumentDraftChapter[] | undefined): GeneratedDocumentDraft['partialChapters'] {
  return (chapters || []).map(chapter => ({
    id: chapter.id,
    title: chapter.title,
    chars: documentTextLength(chapter.content),
    status: chapter.inProgress ? 'in_progress' as const : chapter.content.trim().length > 0 ? 'completed' as const : 'failed' as const,
    updatedAt: Date.now(),
    timedOut: chapter.timedOut,
    elapsedMs: chapter.elapsedMs,
  }));
}

export interface GeneratedAssetRecord extends DocumentAsset {
  name: string;
  source: 'knowledge_base' | 'generated' | 'uploaded' | 'external_url';
  indexed: boolean;
  usedByDocumentIds: string[];
  createdAt: number;
  updatedAt: number;
}

interface GenerateTask {
  id: string;
  documentId: string;
  /** 模板与项目：队列调度的同模板互斥判定（避免为判定反复读盘） */
  templateId: string;
  projectRoot: string;
  status: GeneratedDocumentStatus;
  controller: AbortController;
  promise: Promise<GeneratedDocumentRecord>;
  startedAt: number;
  lastProgressAt: number;
}

/** 排队中的生成请求：同模板+同项目一次只运行一个任务，前一个任务结束后由 pumpGenerationQueue 自动接续下一个 */
interface QueuedGeneration {
  taskId: string;
  documentId: string;
  templateId: string;
  projectRoot: string;
  requirement?: string;
  maxEvidencePerChapter?: number;
  enqueuedAt: number;
}

/**
 * dev 模式下 webpack 会把每个 API 路由各自打包为独立 chunk，共享模块在每个 chunk 中复制一份；
 * 任务注册表与进程启动时刻必须挂到 globalThis 才能保证所有路由实例共享同一份状态，
 * 否则启动任务的路由实例与轮询列表的路由实例持有不同的 tasks Map 与 PROCESS_STARTED_AT，
 * 轮询会把正在运行的任务误判为“生成任务已中断”。
 */
const globalDocumentTaskStore = globalThis as typeof globalThis & {
  __generatedDocumentTasks?: Map<string, GenerateTask>;
  __generatedDocumentProcessStartedAt?: number;
  __generatedDocumentQueue?: QueuedGeneration[];
};
const tasks = (globalDocumentTaskStore.__generatedDocumentTasks ??= new Map<string, GenerateTask>());
/** 待启动队列（与 tasks 同理必须挂 globalThis：dev 模式各 API 路由 chunk 会复制模块级变量）：
 * 同一模板+项目连续多次生成的请求按入队顺序串行执行，前一个任务结束后自动接续下一个 */
const generationQueue: QueuedGeneration[] = (globalDocumentTaskStore.__generatedDocumentQueue ??= []);
const ABANDONED_RECORD_STALE_MS = Math.max(60 * 60_000, Number(process.env.DOCUMENT_ABANDONED_RECORD_STALE_MS ?? 24 * 60 * 60_000));
/** 本进程启动时刻：用于重启后快速识别“上一次进程遗留”的 generating 记录，无需等待 24 小时阈值 */
const PROCESS_STARTED_AT = (globalDocumentTaskStore.__generatedDocumentProcessStartedAt ??= Date.now());

/** 心跳写盘保底间隔（阶段签名未变时的最小写盘间隔）：默认 30s，与中断宽限联动（宽限 clamp ≥3×心跳） */
function resolveHeartbeatSaveIntervalMs() {
  return Math.max(30_000, Math.min(300_000, Number(process.env.DOCUMENT_PROGRESS_HEARTBEAT_SAVE_INTERVAL_MS ?? 30_000)));
}
/** 宽限期：generating 记录 updatedAt 距今小于该值时不判定中断，避免误杀刚创建或仍有实例在推进的任务。
 * 默认 180s 且 clamp ≥3×心跳间隔（历史缺陷：60s 心跳对 60s 宽限无裕度，事件循环被语义推理占满时
 * 心跳延迟即触发多实例误判『生成任务已中断』）。 */
const RECENT_UPDATE_GRACE_MS = Math.max(Math.max(30_000, Number(process.env.DOCUMENT_RECENT_UPDATE_GRACE_MS ?? 180_000)), resolveHeartbeatSaveIntervalMs() * 3);

function defaultProcessAliveProbe(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM=进程存在但无信号权限（视为存活）；ESRCH=进程不存在
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
let processAliveProbe: (pid: number | undefined) => boolean = defaultProcessAliveProbe;
/** 单测注入：替换进程存活探测（真实 PID 语义难以构造确定性用例） */
export function setProcessAliveProbeForTest(probe: ((pid: number | undefined) => boolean) | null) {
  processAliveProbe = probe ?? defaultProcessAliveProbe;
}

type StaleVerdict = { stale: false } | { stale: true; reason: 'process-exited' | 'heartbeat-lost' | 'owner-unknown' };

/** 中断判定单源（markStaleGeneratingRecord 与轮询短路 generatingRecordRequiresFullPoll 共用，杜绝口径漂移）：
 * 1) 宽限期内不判；2) 有归属进程：存活→不判（跨实例保护，超 24h 兜底防 PID 复用悬挂）；已退出→立即判（process-exited）；
 * 3) 无归属（升级前存量记录）：早于本进程启动→判；否则超 24h→判。 */
function evaluateStaleInterruption(input: { status: GeneratedDocumentStatus; updatedAt: number; ownerPid?: number }): StaleVerdict {
  if (input.status !== 'generating' && input.status !== 'queued') return { stale: false };
  const now = Date.now();
  if (now - input.updatedAt < RECENT_UPDATE_GRACE_MS) return { stale: false };
  if (input.ownerPid) {
    if (processAliveProbe(input.ownerPid)) {
      if (now - input.updatedAt < ABANDONED_RECORD_STALE_MS) return { stale: false };
      return { stale: true, reason: 'heartbeat-lost' };
    }
    return { stale: true, reason: 'process-exited' };
  }
  if (input.updatedAt < PROCESS_STARTED_AT) return { stale: true, reason: 'owner-unknown' };
  if (now - input.updatedAt >= ABANDONED_RECORD_STALE_MS) return { stale: true, reason: 'owner-unknown' };
  return { stale: false };
}

function generatedProjectId(projectRoot = getProjectRoot()) {
  return computeProjectId(path.resolve(projectRoot));
}

export function generatedRoot(projectRoot = getProjectRoot()) {
  const root = path.join(os.homedir(), '.customize-agent', 'projects', generatedProjectId(projectRoot), 'generatedDocuments');
  fs.mkdirSync(path.join(root, 'drafts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  return root;
}

function indexPath(projectRoot = getProjectRoot()) { return path.join(generatedRoot(projectRoot), 'index.json'); }
function assetsPath(projectRoot = getProjectRoot()) { return path.join(generatedRoot(projectRoot), 'assets.json'); }
function draftPath(id: string, projectRoot = getProjectRoot()) { return path.join(generatedRoot(projectRoot), 'drafts', `${id}.json`); }
function draftMetaPath(id: string, projectRoot = getProjectRoot()) { return path.join(generatedRoot(projectRoot), 'drafts', `${id}.meta.json`); }

interface GeneratedDocumentMeta {
  updatedAt: number;
  status: GeneratedDocumentStatus;
  completedAt?: number;
  /** 任务归属进程（轻量轮询短路的中断判活需要，避免全量读取 draft 才能判定） */
  ownerPid?: number;
  ownerStartedAt?: number;
}

/** 轻量元信息：轮询接口用其判断文档是否有变化，未变化时无需读取完整 draft 文件 */
export function getGeneratedDocumentMeta(id: string, projectRoot = getProjectRoot()): GeneratedDocumentMeta | null {
  const meta = readJson<GeneratedDocumentMeta | null>(draftMetaPath(id, projectRoot), null);
  return meta && Number.isFinite(meta.updatedAt) ? meta : null;
}

function writeGeneratedDocumentMeta(record: GeneratedDocumentRecord, projectRoot: string) {
  writeJson(draftMetaPath(record.id, projectRoot), { updatedAt: record.updatedAt, status: record.status, completedAt: record.completedAt, ownerPid: record.ownerPid, ownerStartedAt: record.ownerStartedAt } satisfies GeneratedDocumentMeta);
}

/** 判断 generating 记录是否需要绕过轻量轮询短路、强制全量读取以触发 stale 标记（与 markStale 共用同一判定单源） */
export function generatingRecordRequiresFullPoll(meta: GeneratedDocumentMeta | null) {
  if (!meta) return false;
  return evaluateStaleInterruption(meta).stale;
}
export function generatedAssetAbsolutePath(asset: Pick<GeneratedAssetRecord, 'path'>, projectRoot = getProjectRoot()) {
  if (!asset.path) return null;
  if (path.isAbsolute(asset.path)) return asset.path;
  if (asset.path.startsWith('generatedDocuments/assets/')) return path.join(generatedRoot(projectRoot), asset.path.replace(/^generatedDocuments\/assets\//u, 'assets/'));
  return path.join(getProjectKbRoot(projectRoot), asset.path);
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

/** 原子写 JSON：先写临时文件再 rename，避免进程崩溃时写坏一半的 draft/index 文件 */
function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function getActiveTaskByDocumentId(documentId: string) {
  for (const task of tasks.values()) if (task.documentId === documentId) return task;
  return null;
}

function markStaleGeneratingRecord(record: GeneratedDocumentRecord, projectRoot = getProjectRoot()) {
  if ((record.status !== 'generating' && record.status !== 'queued') || getActiveTaskByDocumentId(record.id)) return record;
  // 排队记录仍在本进程待启动队列中：按序等待属正常状态，不判定中断（进程退出后队列随内存消失，不再命中本分支）
  if (record.status === 'queued' && generationQueue.some(job => job.documentId === record.id)) return record;
  // 中断判定单源（evaluateStaleInterruption）：宽限期 → ownerPid 判活（存活不判/已死立即判）/ 存量记录走旧逻辑
  const verdict = evaluateStaleInterruption(record);
  if (!verdict.stale) return record;
  // 排队中断文案区分：排队任务从未执行，引导重新发起而非『继续生成』
  const message = record.status === 'queued'
    ? '排队任务未执行（生成进程已退出或服务重启），请重新发起生成'
    : '生成任务已中断，请点击继续生成或重新生成';
  const status: GeneratedDocumentStatus = record.checkpointChapters?.length ? 'warning' : 'failed';
  console.warn(`[gen] interrupted: doc=${record.id} reason=${verdict.reason} ownerPid=${record.ownerPid ?? 'none'} lastHeartbeat=${new Date(record.updatedAt).toISOString()}`);
  const next = {
    ...record,
    title: fallbackFailedTitle(record),
    status,
    error: record.error || message,
    executionStages: failRunningStages(record.executionStages, message),
    completedAt: Date.now(),
    interruptedAt: Date.now(),
    interruptionReason: verdict.reason,
    warningIssues: record.checkpointChapters?.length ? [...(record.warningIssues || []), message] : record.warningIssues,
  };
  if (record.taskId) {
    upsertDocumentOperation(projectRoot, {
      taskId: record.taskId,
      title: `生成 ${next.title}`,
      status: status === 'warning' ? 'warning' : 'error',
      percent: 100,
      message,
      stages: next.executionStages,
      error: message,
    });
  }
  return next;
}

export function listGeneratedDocuments(projectRoot = getProjectRoot()) {
  return readJson<GeneratedDocumentListItem[]>(indexPath(projectRoot), [])
    .map(item => {
      if (item.status !== 'generating' && item.status !== 'queued') return item;
      const fullRecord = readJson<GeneratedDocumentRecord | null>(draftPath(item.id, projectRoot), null);
      if (!fullRecord) return item;
      const next = markStaleGeneratingRecord(fullRecord, projectRoot);
      const saved = next !== fullRecord ? saveGeneratedDocument(next, projectRoot, { preserveUpdatedAt: true }) : next;
      return { ...toGeneratedDocumentListItem(saved), queuePosition: saved.status === 'queued' ? getQueuedDocumentPosition(saved.id) : undefined };
    })
    .sort((a, b) => (b.createdAt || b.updatedAt) - (a.createdAt || a.updatedAt));
}

export function getGeneratedDocument(id: string, projectRoot = getProjectRoot()) {
  const record = readJson<GeneratedDocumentRecord | null>(draftPath(id, projectRoot), null);
  if (!record) return null;
  const next = markStaleGeneratingRecord(record, projectRoot);
  const saved = next !== record ? saveGeneratedDocument(next, projectRoot, { preserveUpdatedAt: true }) : next;
  return ensureGeneratedDocumentAsset(saved, projectRoot);
}

export function saveGeneratedDocument(record: GeneratedDocumentRecord, projectRoot = getProjectRoot(), options?: { preserveUpdatedAt?: boolean }) {
  const now = Date.now();
  const next = trimEvidenceContent({ ...record, updatedAt: options?.preserveUpdatedAt ? record.updatedAt : now });
  writeJson(draftPath(next.id, projectRoot), next);
  writeGeneratedDocumentMeta(next, projectRoot);
  const list = readJson<GeneratedDocumentListItem[]>(indexPath(projectRoot), []).filter(item => item.id !== next.id);
  list.unshift(toGeneratedDocumentListItem(next));
  writeJson(indexPath(projectRoot), list);
  return next;
}

export function updateGeneratedDocument(id: string, patch: Partial<GeneratedDocumentRecord>, projectRoot = getProjectRoot()) {
  const current = getGeneratedDocument(id, projectRoot);
  if (!current) return null;
  return saveGeneratedDocument({ ...current, ...patch, id }, projectRoot);
}

export function abortGeneratedDocument(id: string, projectRoot = getProjectRoot()) {
  const current = getGeneratedDocument(id, projectRoot);
  if (!current) return null;
  if (current.status !== 'generating' && current.status !== 'queued') return current;
  // 排队任务中止：直接从待启动队列摘除（未创建 controller/任务注册），随后触发调度让后续任务顶补
  const fromQueue = current.status === 'queued';
  if (fromQueue) {
    const queuedIndex = generationQueue.findIndex(job => job.documentId === id);
    if (queuedIndex >= 0) generationQueue.splice(queuedIndex, 1);
  }
  for (const [key, task] of tasks) {
    if (task.documentId === id) {
      task.status = 'aborted';
      task.controller.abort();
      tasks.delete(key);
    }
  }
  const message = '用户中止';
  // 中止审计：归因『人工中止』与其余终止路径的依据（abortedAt/abortedBy/中止时所处阶段）
  const runningStage = [...(current.executionStages || [])].reverse().find(stage => stage.status === 'running');
  const abortedStage = fromQueue ? '生成队列' : runningStage?.subtitle || runningStage?.roleName || runningStage?.roleId;
  const executionStages = failRunningStages(current.executionStages, message);
  const record = saveGeneratedDocument({ ...current, status: 'aborted', error: message, executionStages, completedAt: Date.now(), abortedAt: Date.now(), abortedBy: 'user-api', abortedStage }, projectRoot);
  console.log(`[gen] aborted by user: doc=${id} stage=${abortedStage || 'unknown'} taskId=${record.taskId || 'none'}`);
  const operationMessage = abortedStage ? `用户中止（阶段：${abortedStage}）` : message;
  if (record.taskId) {
    upsertDocumentOperation(projectRoot, { taskId: record.taskId, title: `生成 ${record.title}`, status: 'warning', percent: 100, message: operationMessage, stages: executionStages, error: message });
  }
  // 摘除排队任务后立即尝试调度：容量与同模板互斥满足时后续排队任务顶补启动
  if (fromQueue) pumpGenerationQueue();
  return record;
}

export function deleteGeneratedDocument(id: string, projectRoot = getProjectRoot()) {
  // 删除排队中的记录时同步摘除队列请求，避免 pump 接续启动一个已被删除的文档
  const queuedIndex = generationQueue.findIndex(job => job.documentId === id);
  if (queuedIndex >= 0) generationQueue.splice(queuedIndex, 1);
  try {
    fs.rmSync(draftPath(id, projectRoot), { force: true });
  } catch {
    console.warn('[generated-documents] 删除文档记录失败或文件不存在', id);
  }
  const list = readJson<GeneratedDocumentListItem[]>(indexPath(projectRoot), []).filter(item => item.id !== id);
  writeJson(indexPath(projectRoot), list);
}

export function listGeneratedAssets(projectRoot = getProjectRoot()) {
  return readJson<GeneratedAssetRecord[]>(assetsPath(projectRoot), []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function upsertGeneratedAssets(assets: DocumentAsset[], documentId: string, projectRoot = getProjectRoot()) {
  const now = Date.now();
  const existing = listGeneratedAssets(projectRoot);
  const next = [...existing];
  for (const asset of assets) {
    const index = next.findIndex(item => item.id === asset.id);
    const source: GeneratedAssetRecord['source'] = asset.path?.startsWith('generatedDocuments/assets/') || asset.status === 'generated' || asset.status === 'prompt_ready' ? 'generated' : 'knowledge_base';
    const record: GeneratedAssetRecord = {
      ...asset,
      name: path.basename(asset.path || asset.url || asset.id),
      source,
      indexed: index >= 0 ? next[index]!.indexed : false,
      usedByDocumentIds: index >= 0 ? [...new Set([...next[index]!.usedByDocumentIds, documentId])] : [documentId],
      createdAt: index >= 0 ? next[index]!.createdAt : now,
      updatedAt: now,
    };
    if (index >= 0) next[index] = { ...next[index], ...record };
    else next.push(record);
  }
  writeJson(assetsPath(projectRoot), next);
  return next;
}

function generatedDocumentAssetPath(record: Pick<GeneratedDocumentRecord, 'id' | 'title'>) {
  return `generatedDocuments/assets/${safeKnowledgeFileName(record.title)}-${record.id}.md`;
}

export function upsertGeneratedDocumentAsset(record: GeneratedDocumentRecord, projectRoot = getProjectRoot()) {
  const markdown = record.editedMarkdown || record.markdown;
  if (!markdown?.trim()) return null;
  const relativePath = generatedDocumentAssetPath(record);
  const absolutePath = path.join(generatedRoot(projectRoot), relativePath.replace(/^generatedDocuments\//u, ''));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, markdown, 'utf8');
  const asset: DocumentAsset = {
    id: `document-${record.id}`,
    type: 'file',
    role: 'generated',
    path: relativePath,
    status: 'generated',
    message: '模板运行生成的 Markdown 文档，仅登记到生成资源，不进入知识库',
  };
  return upsertGeneratedAssets([asset], record.id, projectRoot).find(item => item.id === asset.id) || null;
}

function ensureGeneratedDocumentAsset(record: GeneratedDocumentRecord, projectRoot = getProjectRoot()) {
  if (record.status === 'generating' || !(record.editedMarkdown || record.markdown)?.trim()) return record;
  const assetId = `document-${record.id}`;
  if (record.assets?.some(asset => asset.id === assetId && asset.path)) return record;
  const asset = upsertGeneratedDocumentAsset(record, projectRoot);
  if (!asset) return record;
  return saveGeneratedDocument({ ...record, assets: [asset, ...(record.assets || []).filter(item => item.id !== asset.id)] }, projectRoot);
}

export function getGeneratedAsset(id: string, projectRoot = getProjectRoot()) {
  return listGeneratedAssets(projectRoot).find(asset => asset.id === id) || null;
}

export function deleteGeneratedAsset(id: string, projectRoot = getProjectRoot()) {
  const asset = getGeneratedAsset(id, projectRoot);
  if (!asset) return false;
  const absolutePath = generatedAssetAbsolutePath(asset, projectRoot);
  if (absolutePath && absolutePath.startsWith(generatedRoot(projectRoot))) {
    try {
      fs.rmSync(absolutePath, { force: true });
    } catch {
      console.warn('[generated-documents] 删除生成资源文件失败或文件不存在', absolutePath);
    }
  }
  writeJson(assetsPath(projectRoot), listGeneratedAssets(projectRoot).filter(item => item.id !== id));
  return true;
}

function safeKnowledgeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|]/gu, '_').slice(0, 120) || 'generated-document';
}

export function openGeneratedAssetTarget(id: string, target: 'file' | 'directory', projectRoot = getProjectRoot()) {
  const asset = getGeneratedAsset(id, projectRoot);
  if (!asset) return null;
  const absolutePath = generatedAssetAbsolutePath(asset, projectRoot);
  if (!absolutePath || !fs.existsSync(absolutePath)) return null;
  return target === 'directory' ? path.dirname(absolutePath) : absolutePath;
}

function trimChapterEvidence(chapter: DocumentDraftChapter): DocumentDraftChapter {
  const maxItems = Math.max(4, Math.floor(tuningProfile().persistEvidenceMaxItems ?? 10));
  const maxChars = Math.max(300, Math.floor(tuningProfile().persistEvidenceItemChars ?? 900));
  return {
    ...chapter,
    evidence: (chapter.evidence || []).slice(0, maxItems).map(item => ({
      ...item,
      content: typeof item.content === 'string' ? item.content.replace(/\s+/gu, ' ').slice(0, maxChars) : '',
    })),
  };
}

function toGeneratedDocumentListItem(record: GeneratedDocumentRecord): GeneratedDocumentListItem {
  const stages = record.executionStages || record.draft?.executionStages || [];
  const latestStage = [...stages].reverse().find(stage => stage.message || stage.subtitle || stage.roleId);
  const chapters = record.partialChapters || summarizeCheckpointChapters(record.checkpointChapters || record.draft?.checkpointChapters || record.draft?.chapters);
  const validationIssues = record.draft?.validationIssues || [];
  const blockerCount = record.draft?.exportGate
    ? (record.draft.exportGate.blockingIssues?.length ?? 0)
    : validationIssues.filter(issue => issue.severity === 'blocker' || issue.level === 'error').length;
  const warningCount = validationIssues.filter(issue => issue.severity === 'warning' || issue.level === 'warning').length || record.warningIssues?.length || 0;
  const suggestionCount = validationIssues.filter(issue => issue.severity === 'suggestion' || issue.level === 'info').length;
  return {
    id: record.id,
    taskId: record.taskId,
    templateId: record.templateId,
    templateName: record.templateName,
    templateVersion: record.templateVersion,
    title: record.title,
    requirement: record.requirement,
    projectRoot: record.projectRoot,
    projectId: record.projectId,
    knowledgeBasePath: record.knowledgeBasePath,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    elapsedMs: record.completedAt ? record.completedAt - record.createdAt : record.updatedAt - record.createdAt,
    error: record.error,
    warningIssues: (record.warningIssues || []).slice(0, 12),
    warningCount,
    blockerCount,
    suggestionCount,
    wordCount: documentTextLength(record.editedMarkdown || record.markdown || record.draft?.markdown || ''),
    chapterCount: chapters?.length || record.draft?.chapters?.length || 0,
    completedChapterCount: (chapters || []).filter(chapter => chapter.status === 'completed').length,
    latestStage: latestStage?.subtitle || latestStage?.roleName || latestStage?.roleId,
    latestMessage: latestStage?.message,
    assets: (record.assets || []).slice(0, 8),
    partialChapters: chapters,
  };
}

function trimEvidenceContent<T extends GeneratedDocumentRecord>(record: T): T {
  const draft = record.draft ? {
    ...record.draft,
    chapters: record.draft.chapters?.map(trimChapterEvidence),
    checkpointChapters: record.draft.checkpointChapters?.map(trimChapterEvidence),
  } : record.draft;
  return {
    ...record,
    draft,
    checkpointChapters: record.checkpointChapters?.map(trimChapterEvidence),
  };
}

function activeTaskResponse(task: GenerateTask, projectRoot: string) {
  const record = getGeneratedDocument(task.documentId, projectRoot);
  if (!record || record.status !== 'generating') return null;
  // 统一返回结构：复用运行中任务不属于排队，queuePosition 恒为 undefined
  return { taskId: task.id, documentId: task.documentId, record, queuePosition: undefined };
}

function documentOperationDetails(stages: GeneratedDocumentRecord['executionStages'] | undefined) {
  const important = (stages || []).filter(stage =>
    stage.type === 'role_binding' ||
    stage.roleId === 'runtime-prompt-rules' ||
    stage.roleId === 'document-readiness' ||
    stage.status === 'failed',
  );
  return important.flatMap(stage => [
    `${stage.subtitle || stage.roleName || stage.roleId}：${stage.message || stage.status}`,
    ...(stage.details || []).slice(0, 8).map(detail => `  - ${detail}`),
  ]).slice(0, 80);
}

function upsertDocumentOperation(projectRoot: string, input: { taskId: string; title: string; status: 'processing' | 'success' | 'warning' | 'error'; percent: number; message: string; stages?: GeneratedDocumentRecord['executionStages']; error?: string }) {
  upsertKbOperation(projectRoot, {
    id: input.taskId,
    type: 'document',
    title: input.title,
    stage: input.status === 'processing' ? 'generating' : input.status === 'error' ? 'error' : 'done',
    status: input.status,
    percent: input.percent,
    message: input.message,
    error: input.error,
    details: documentOperationDetails(input.stages),
  });
}

/** 启动异步文档生成任务，包含进度回调持久化、结果入库、资源管理，返回任务 ID 和文档 ID */
/** 全局并发上限（函数化：排队调度实时读取，单测可动态调整 env） */
function maxConcurrentGenerations() {
  return Math.max(1, Number(process.env.DOCUMENT_MAX_CONCURRENT_GENERATIONS ?? 2));
}

/** 排队位次（1 起）：不在队列中返回 undefined */
export function getQueuedDocumentPosition(documentId: string) {
  const index = generationQueue.findIndex(job => job.documentId === documentId);
  return index >= 0 ? index + 1 : undefined;
}

/** 同模板+同项目互斥判定（队列调度用，基于任务注册表避免反复读盘） */
function hasActiveTaskForTemplateProject(templateId: string, projectRoot: string) {
  for (const task of tasks.values()) if (task.templateId === templateId && task.projectRoot === projectRoot) return true;
  return false;
}

/** 排队调度：并发名额有空且该模板+项目无运行中任务时，按入队顺序接续启动下一个；
 * 队首若因同模板正在运行暂不可启动则跳过（不同模板可在并发上限内并行） */
function pumpGenerationQueue() {
  for (;;) {
    if (tasks.size >= maxConcurrentGenerations()) return;
    const index = generationQueue.findIndex(job => !hasActiveTaskForTemplateProject(job.templateId, job.projectRoot));
    if (index < 0) return;
    const [job] = generationQueue.splice(index, 1);
    const current = getGeneratedDocument(job.documentId, job.projectRoot);
    if (!current || current.status !== 'queued') continue;
    try {
      launchTask({
        taskId: job.taskId,
        documentId: job.documentId,
        resolvedProjectRoot: job.projectRoot,
        templateId: job.templateId,
        requirement: job.requirement ?? current.requirement,
        maxEvidencePerChapter: job.maxEvidencePerChapter ?? current.maxEvidencePerChapter,
        existing: null,
        initial: {
          ...current,
          taskId: job.taskId,
          title: '生成中',
          status: 'generating',
          error: undefined,
          completedAt: undefined,
          ownerPid: process.pid,
          ownerStartedAt: PROCESS_STARTED_AT,
          executionStages: [{ type: 'validation', roleId: 'queue-start', status: 'running', message: '排队完成，开始生成' }],
          updatedAt: Date.now(),
        },
        startMessage: '排队完成，文档生成任务已启动',
      });
    } catch (error) {
      // 启动失败：落 failed 记录（保留调度循环继续处理后续排队任务）
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[gen] queue launch failed: doc=${job.documentId} ${message}`);
      const latest = getGeneratedDocument(job.documentId, job.projectRoot);
      if (latest && latest.status === 'queued') {
        saveGeneratedDocument({ ...latest, title: fallbackFailedTitle(latest), status: 'failed', error: message, executionStages: failRunningStages(latest.executionStages, message), completedAt: Date.now() }, job.projectRoot);
        upsertDocumentOperation(job.projectRoot, { taskId: job.taskId, title: `生成 ${latest.templateName || latest.title}`, status: 'error', percent: 100, message, error: message });
      }
    }
  }
}

/** 任务管道（立即启动与排队接续共用）：写启动态、注册任务、运行生成、终态归档；
 * finally 中释放并发名额并触发队列调度（任务完成后自动接续下一个排队任务） */
function launchTask(job: {
  taskId: string;
  documentId: string;
  resolvedProjectRoot: string;
  templateId: string;
  requirement?: string;
  maxEvidencePerChapter?: number;
  resumeDocumentId?: string;
  existing: GeneratedDocumentRecord | null;
  initial: GeneratedDocumentRecord;
  startMessage: string;
}) {
  const { taskId, documentId, resolvedProjectRoot, existing, initial } = job;
  // input 等价于原 startGenerateDocumentTask 入参：管道段内 reusableCheckpointChapters 与 generateDocumentDraft 展开依赖该变量名
  const input = { templateId: job.templateId, requirement: job.requirement, maxEvidencePerChapter: job.maxEvidencePerChapter, resumeDocumentId: job.resumeDocumentId };
  const now = Date.now();
  saveGeneratedDocument(initial, resolvedProjectRoot);
  upsertDocumentOperation(resolvedProjectRoot, { taskId, title: `生成 ${initial.title}`, status: 'processing', percent: 1, message: job.startMessage, stages: initial.executionStages });
  const controller = new AbortController();
  const taskRef: { current?: GenerateTask } = {};
  const resumeChapters = reusableCheckpointChapters(existing, input, resolvedProjectRoot);
  // 内存最新进度快照：catch 链需要标记未完成阶段时必须用内存最新 stages，不能读磁盘旧快照——
  // 进度写盘有节流（minProgressSaveInterval），磁盘 stages 滞后会把已成功章节标成 failed（状态传播错乱）
  let lastProgressStages: GeneratedDocumentRecord['executionStages'] | undefined;
  let lastProgressMarkdown = '';
  let lastProgressSaveAt = 0;
  let lastProgressSignature = '';
  const minProgressSaveInterval = Math.max(1_000, Math.min(15_000, Number(process.env.DOCUMENT_PROGRESS_SAVE_INTERVAL_MS ?? 5_000)));
  // 阶段签名未变（如周期性心跳）时的保底写盘间隔（默认 30s，与中断宽限联动），避免每 30s 心跳全量写盘
  const minProgressHeartbeatSaveInterval = resolveHeartbeatSaveIntervalMs();
  // 语义模型预热前置（fail-fast）：模型路径失效等基础设施问题在任务启动初期即暴露并结束任务，
  // 避免生成推进到末期才因嵌入失败硬停；DOCUMENT_SKIP_EMBED_PREFLIGHT=1 可关闭
  const promise = preflightLocalSemanticProvider().then(() => generateDocumentDraft({ ...input, diversitySeed: documentId, projectRoot: resolvedProjectRoot, resumeChapters, signal: controller.signal, onProgress: (stages, checkpoint) => {
    try {
      if (taskRef.current) taskRef.current.lastProgressAt = Date.now();
      lastProgressStages = stages;
      if (checkpoint?.chapters?.length) lastProgressMarkdown = checkpoint.chapters.map(chapter => `# ${chapter.title}\n\n${chapter.content}`).join('\n\n');
      const nowProgress = Date.now();
      const signature = JSON.stringify({
        stages: stages.map(stage => ({ type: stage.type, roleId: stage.roleId, status: stage.status, message: stage.message, progress: stage.progress })),
        checkpoint: checkpoint?.chapters?.map(chapter => [chapter.id, chapter.content.length, chapter.sections?.length || 0]) || [],
      });
      if (!checkpoint?.chapters && signature === lastProgressSignature && nowProgress - lastProgressSaveAt < Math.max(minProgressSaveInterval, minProgressHeartbeatSaveInterval)) return;
      const current = getGeneratedDocument(documentId, resolvedProjectRoot);
      if (current && current.status === 'generating') {
        const checkpointChapters = checkpoint?.chapters ? mergeDraftChapters(current.checkpointChapters, checkpoint.chapters).map(trimChapterEvidence) : current.checkpointChapters;
        const checkpointMarkdown = checkpointChapters?.length ? checkpointChapters.map(chapter => `# ${chapter.title}\n\n${chapter.content}`).join('\n\n') : current.markdown;
        const saved = saveGeneratedDocument(trimEvidenceContent({
          ...current,
          ownerPid: process.pid,
          ownerStartedAt: PROCESS_STARTED_AT,
          executionStages: stages,
          checkpointChapters,
          partialChapters: checkpoint?.chapters ? summarizeCheckpointChapters(checkpointChapters) : current.partialChapters,
          markdown: checkpointMarkdown,
          wordCount: checkpointMarkdown ? documentTextLength(checkpointMarkdown) : current.wordCount,
        }), resolvedProjectRoot);
        const latestStage = [...stages].reverse().find(stage => stage.status === 'running') || stages[stages.length - 1];
        upsertDocumentOperation(resolvedProjectRoot, { taskId, title: `生成 ${saved.templateName || saved.title}`, status: 'processing', percent: Math.max(1, Math.min(99, latestStage?.progress ? Math.round((latestStage.progress.current / Math.max(1, latestStage.progress.total)) * 90) : 30)), message: latestStage?.message || '文档生成中', stages });
        const heartbeatSave = signature === lastProgressSignature;
        lastProgressSaveAt = nowProgress;
        lastProgressSignature = signature;
        console.log(`[gen] progress saved: ${stages.length} stages, checkpoint=${checkpointChapters?.length || 0}, doc=${documentId}`);
        if (heartbeatSave) {
          // P2 内存峰值观测：心跳写盘处采样，支撑 OOM 归因（与 dmesg OOM 时间线对齐）
          const memory = process.memoryUsage();
          console.log(`[gen] memory rss=${Math.round(memory.rss / 1048576)}MB heap=${Math.round(memory.heapUsed / 1048576)}MB doc=${documentId}`);
        }
      }
    } catch (err) { console.error('[gen] progress save error:', err); }
  } })).then(async result => {
    if (taskRef.current) {
      taskRef.current.lastProgressAt = Date.now();
    }
    const current = getGeneratedDocument(documentId, resolvedProjectRoot);
    if (!current || current.status !== 'generating') return current ?? initial;
    const hiddenDiagnosticRe = /结构化事实读取不足|正文可能未显式覆盖|仅包含文件类型和占位符|不在本次招标范围内|知识库文件索引失败|暂无可检索内容切片|未抽取到结构化事实|兜底片段|资料抽取诊断|无法直接读取文本内容|占位符|缺乏详细的.*具体尺寸|需结合原文件进一步深化|章节生成存在兜底/u;
    const markdown = result.markdown || '';
    const hasIllegalH2 = /^##\s+(?!目录$)(?!附录)(?!附表\s*[一二三四五六七八九十\d]{1,3})(?!第[一二三四五六七八九十百千万\d]+章\s+)/gmu.test(markdown);
    const hasPageRefs = /(?:第?\d+页|P\.?\s*\d+)/iu.test(markdown);
    const hasForbiddenParty = /施工方/u.test(markdown);
    const warningIssues = result.validationIssues
      .filter(issue => issue.level === 'error' || issue.level === 'warning')
      .map(issue => issue.suggestion ? `${issue.message}：${issue.suggestion}` : issue.message)
      .filter(message => !/^\s*[[{]/u.test(message) && !/"status"\s*:/u.test(message) && !hiddenDiagnosticRe.test(message))
      .filter(message => !/正文存在非正式章二级标题/u.test(message) || hasIllegalH2)
      .filter(message => !/资料页码|文件页码|页码引用/u.test(message) || hasPageRefs)
      .filter(message => !/禁止内容|施工方/u.test(message) || hasForbiddenParty)
      .filter(message => result.exportGate.passed ? !/目录与正文不一致|表格分隔线位置不规范/u.test(message) : true);
    // 4.55.22：`too_short`（正文 1–179 字且非表正文稀薄）一并浮出——三个消费点原只收 empty，
    // 该 reason 是"生产者有、消费方全不收"的死值，交付物里"标题下只有一两句"完全不可见。
    const sectionGaps = collectSectionContentGaps(result.markdown, result.chapters);
    const emptyGaps = sectionGaps.filter(gap => gap.reason === 'empty');
    const shortGaps = sectionGaps.filter(gap => gap.reason === 'too_short');
    if (emptyGaps.length > 0) warningIssues.unshift(`小节内容补写未完成：仍有 ${emptyGaps.length} 个空洞小节，请继续生成或补充资料后重试`);
    if (shortGaps.length > 0) warningIssues.unshift(`小节内容偏薄：${shortGaps.length} 个小节正文过短（如「${shortGaps.slice(0, 3).map(gap => gap.sectionTitle).join('」「')}」），建议扩写至实质篇幅后重试`);
    if (!result.exportGate.passed) {
      // 4.50 交付解耦 + 批1 C1 复核清单：未收敛阻断不再挂起交付（failed），转结构化精准人工清单
      //（分类/定位/问题/建议/修复路径/检测器身份）置顶——优先复用流水线归档清单
      //（reviewMetadata.suspensionChecklist，三挂载点同一构建），兜底路径就地构建，保证 banner 与归档同源。
      const blockers = result.exportGate.blockingIssues || [];
      const checklist = result.reviewMetadata?.suspensionChecklist ?? buildSuspensionChecklist(blockers, result.chapters);
      warningIssues.unshift(formatSuspensionBanner(checklist));
    }
    // 4.50 交付与修复解耦（根治「阻断=永远拿不到文档」）：门禁通过=completed；未通过=completed_with_issues
    // —— 文档照常可查看/可导出/可基于 checkpoint 续修，修复机制继续尽力收敛、残留项以复核清单呈现；
    // failed 终态仅保留给异常中断路径（生成抛错且无 checkpoint）。V2 批3「宁缺毋假=failed」策略废弃。
    const completedStatus: GeneratedDocumentStatus = result.exportGate.passed ? 'completed' : 'completed_with_issues';
    const completedBase = trimEvidenceContent({
      ...current,
      templateName: result.templateName,
      templateVersion: result.templateVersion ?? current.templateVersion,
      title: result.title,
      markdown: result.markdown,
      status: completedStatus,
      draft: result,
      executionStages: result.executionStages,
      partialChapters: result.partialChapters,
      checkpointChapters: result.chapters,
      reviewMetadata: result.reviewMetadata,
      promptProvenance: result.promptProvenance ?? current.promptProvenance,
      agentWorkflow: result.agentWorkflow,
      assets: result.assets || [],
      completedAt: Date.now(),
      warningIssues,
    });
    const generatedAsset = upsertGeneratedDocumentAsset(completedBase, resolvedProjectRoot);
    const record = saveGeneratedDocument({
      ...completedBase,
      assets: generatedAsset ? [generatedAsset, ...(completedBase.assets || []).filter(asset => asset.id !== generatedAsset.id)] : completedBase.assets,
    }, resolvedProjectRoot);
    // 多文档反雷同（L3）：定稿后写指纹池（只存标题与结构、无正文；失败静默不阻断主链）；
    // 4.50 交付解耦后 completedStatus 恒为 completed / completed_with_issues 两值，有正文即入池
    if (result.markdown) {
      const headingTitles = extractHeadingTitles(result.markdown);
      if (headingTitles.h3.length > 0 || headingTitles.h4.length > 0) {
        appendFingerprintEntry({ documentId, templateId: record.templateId || input.templateId, h3: headingTitles.h3, h4: headingTitles.h4, createdAt: new Date().toISOString() });
      }
    }
    upsertGeneratedAssets(result.assets || [], documentId, resolvedProjectRoot);
    upsertDocumentOperation(resolvedProjectRoot, { taskId, title: `生成 ${record.title}`, status: record.status === 'completed' ? 'success' : 'warning', percent: 100, message: record.status === 'completed' ? '文档生成完成，已通过导出门禁' : `文档生成完成，存在 ${result.exportGate.blockingIssues.length || warningIssues.length || 1} 项质量提示待人工复核（不影响导出）`, stages: result.executionStages });
    return record;
  }).catch(error => {
    const current = getGeneratedDocument(documentId, resolvedProjectRoot);
    if (!current || current.status !== 'generating') return current ?? initial;
    const message = error instanceof Error ? error.message : String(error);
    // 双判：精确中止文案 或 signal 已中止（signal 唯一中止来源=abort API，文案变化时仍正确落『已中止』）
    const status: GeneratedDocumentStatus = isAbortError(error) || controller.signal.aborted ? 'aborted' : current.checkpointChapters?.length || lastProgressMarkdown ? 'warning' : 'failed';
    const markdown = lastProgressMarkdown || current.markdown || current.checkpointChapters?.map(chapter => `# ${chapter.title}\n\n${chapter.content}`).join('\n\n') || '';
    // 状态传播修复：用内存最新 stages 标记未完成阶段（failRunningStages 只标 running），
    // 磁盘快照滞后时已成功的章不会被误标 failed
    const failedStages = failRunningStages(lastProgressStages || current.executionStages, message);
    const record = saveGeneratedDocument(trimEvidenceContent({
      ...current,
      title: status === 'failed' ? fallbackFailedTitle(current) : current.title && current.title !== '生成中' ? current.title : `${current.templateName || '文档'}生成未完成`,
      status,
      error: message,
      markdown,
      executionStages: failedStages,
      completedAt: Date.now(),
      warningIssues: status === 'warning' ? [...(current.warningIssues || []), message] : current.warningIssues,
    }), resolvedProjectRoot);
    upsertDocumentOperation(resolvedProjectRoot, { taskId, title: `生成 ${record.title}`, status: status === 'warning' ? 'warning' : 'error', percent: 100, message, stages: failedStages, error: message });
    return record;
  }).finally(() => {
    tasks.delete(taskId);
    pumpGenerationQueue();
  });
  const task: GenerateTask = { id: taskId, documentId, templateId: input.templateId, projectRoot: resolvedProjectRoot, status: 'generating', controller, promise, startedAt: now, lastProgressAt: now };
  taskRef.current = task;
  tasks.set(taskId, task);
  return { taskId, documentId, record: initial };
}

/** 启动异步文档生成任务：新请求进入排队（同模板+项目串行、完成自动接续）；恢复请求保持即时启动语义 */
export function startGenerateDocumentTask(input: { templateId: string; requirement?: string; maxEvidencePerChapter?: number; resumeDocumentId?: string }, projectRoot = getProjectRoot()) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const currentProjectId = computeProjectId(resolvedProjectRoot);
  const now = Date.now();
  const existing = input.resumeDocumentId ? getGeneratedDocument(input.resumeDocumentId, resolvedProjectRoot) : null;
  if (existing) {
    const active = getActiveTaskByDocumentId(existing.id);
    const activeResponse = active ? activeTaskResponse(active, resolvedProjectRoot) : null;
    if (activeResponse) return activeResponse;
    // 恢复：即时语义保持原行为（容量不足抛错、不排队）；同名排队请求让位（恢复优先）
    if (tasks.size >= maxConcurrentGenerations()) {
      throw new Error(`当前已有 ${tasks.size} 个文档生成任务在运行（上限 ${maxConcurrentGenerations()}），请等待完成或中止后再运行`);
    }
    const queuedIndex = generationQueue.findIndex(job => job.documentId === existing.id);
    if (queuedIndex >= 0) generationQueue.splice(queuedIndex, 1);
    const taskId = `task-${now}-${crypto.randomBytes(4).toString('hex')}`;
    const initial: GeneratedDocumentRecord = {
      ...existing,
      taskId,
      status: 'generating',
      error: undefined,
      completedAt: undefined,
      interruptedAt: undefined,
      interruptionReason: undefined,
      abortedAt: undefined,
      abortedBy: undefined,
      abortedStage: undefined,
      ownerPid: process.pid,
      ownerStartedAt: PROCESS_STARTED_AT,
      executionStages: [{ type: 'validation', roleId: 'resume-generation', status: 'running', message: '已重新进入生成流程；仅复用通过当前工作流版本、项目、模板、需求和导出门禁校验的章节，其余章节重新生成' }],
      partialChapters: undefined,
      checkpointChapters: undefined,
      draft: undefined,
      warningIssues: undefined,
      updatedAt: now,
    };
    const launched = launchTask({ taskId, documentId: existing.id, resolvedProjectRoot, templateId: input.templateId, requirement: input.requirement, maxEvidencePerChapter: input.maxEvidencePerChapter, resumeDocumentId: input.resumeDocumentId, existing, initial, startMessage: '文档生成任务已进入后台队列' });
    // 统一返回类型：恢复分支保持即时启动语义、不进排队，queuePosition 恒为 undefined
    return { ...launched, queuePosition: undefined as number | undefined };
  }
  // 新请求：每次调用创建一份新文档并加入排队（不再复用运行中的同模板任务）；
  // pump 在容量与同模板互斥满足时立即启动，否则等前一个任务完成后自动接续
  const documentId = `doc-${now}-${crypto.randomBytes(4).toString('hex')}`;
  const taskId = `task-${now}-${crypto.randomBytes(4).toString('hex')}`;
  const template = getDocumentTemplate(input.templateId);
  const initial: GeneratedDocumentRecord = {
    id: documentId,
    taskId,
    ownerPid: process.pid,
    ownerStartedAt: PROCESS_STARTED_AT,
    templateId: input.templateId,
    templateName: template?.name,
    templateVersion: template?.version,
    title: '排队中',
    requirement: input.requirement || '',
    maxEvidencePerChapter: input.maxEvidencePerChapter,
    projectRoot: resolvedProjectRoot,
    projectId: currentProjectId,
    knowledgeBasePath: getProjectKbRoot(resolvedProjectRoot),
    markdown: '',
    status: 'queued',
    assets: [],
    createdAt: now,
    updatedAt: now,
  };
  generationQueue.push({ taskId, documentId, templateId: input.templateId, projectRoot: resolvedProjectRoot, requirement: input.requirement, maxEvidencePerChapter: input.maxEvidencePerChapter, enqueuedAt: now });
  const position = getQueuedDocumentPosition(documentId) ?? 1;
  const queuedInitial: GeneratedDocumentRecord = {
    ...initial,
    executionStages: [{ type: 'validation', roleId: 'queue-wait', status: 'running', message: `已加入生成队列（位次 ${position}）：同模板前一任务完成或并发名额空闲后自动开始` }],
  };
  saveGeneratedDocument(queuedInitial, resolvedProjectRoot);
  upsertDocumentOperation(resolvedProjectRoot, { taskId, title: `生成 ${template?.name || '文档'}`, status: 'processing', percent: 1, message: `已加入生成队列（位次 ${position}），等待自动接续`, stages: queuedInitial.executionStages });
  pumpGenerationQueue();
  const started = getActiveTaskByDocumentId(documentId);
  return { taskId, documentId, record: getGeneratedDocument(documentId, resolvedProjectRoot) || queuedInitial, queuePosition: started ? undefined : getQueuedDocumentPosition(documentId) };
}

export function getGenerateTask(taskId: string) {
  return tasks.get(taskId) || null;
}
