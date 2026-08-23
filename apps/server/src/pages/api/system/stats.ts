import type { NextApiRequest, NextApiResponse } from 'next';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

interface ModelUsage {
  provider: string;
  model: string;
  count: number;
}

interface StatsResponse {
  cpu: { usagePercent: number; cores: number };
  memory: { totalMB: number; usedMB: number; processMB: number; usagePercent: number };
  tokens: { total: number; prompt: number; completion: number };
  models: ModelUsage[];
  tasks: { total: number; success: number; failed: number; running: number; types: Record<string, number> };
  logs: { files: number; events: number; latestAt?: string; scannedDirs: string[] };
  uptime: number;
}

let lastCpu = process.cpuUsage();
let lastTime = Date.now();

/** 计算两次调用之间的 CPU 使用率百分比 */
function getCpuUsage(): number {
  const now = Date.now();
  const elapsed = now - lastTime;
  if (elapsed < 100) return 0;
  const cpu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  lastTime = now;
  const totalMs = (cpu.user + cpu.system) / 1000;
  const percent = (totalMs / (elapsed * os.cpus().length)) * 100;
  return Math.min(100, Math.round(percent * 10) / 10);
}

/** 根据任务描述关键词推断任务类型（修复/开发/优化/审查/对话） */
function classifyTask(task: string): string {
  const text = task.toLowerCase();
  if (/修复|fix|bug|错误|报错|失败/u.test(text)) return '修复问题';
  if (/新增|添加|实现|feature|add/u.test(text)) return '功能开发';
  if (/重构|优化|refactor|性能|优化/u.test(text)) return '优化重构';
  if (/解释|分析|review|审查|检查/u.test(text)) return '分析审查';
  return '对话任务';
}

/** 累加模型使用次数到统计 Map 中 */
function addModelUsage(modelMap: Map<string, ModelUsage>, provider: string, model: string): void {
  const key = `${provider || '?'}/${model || '?'}`;
  const entry = modelMap.get(key) || { provider: provider || '?', model: model || '?', count: 0 };
  entry.count++;
  modelMap.set(key, entry);
}

function candidateLogDirs(): string[] {
  const dirs = [
    process.env.CUSTOMIZE_AGENT_HOME ? path.join(process.env.CUSTOMIZE_AGENT_HOME, '.customize-agent', 'logs') : undefined,
    process.env.HOME ? path.join(process.env.HOME, '.customize-agent', 'logs') : undefined,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.customize-agent', 'logs') : undefined,
    path.join(os.homedir(), '.customize-agent', 'logs'),
    path.join(os.tmpdir(), 'customize-agent', 'logs'),
  ].filter(Boolean) as string[];
  return [...new Set(dirs.map(dir => path.resolve(dir)))];
}

function parseModelLabel(provider: string, model: string): { provider: string; model: string } {
  const p = provider.trim();
  const m = model.trim();
  if (p && m && p !== m) return { provider: p.split('/')[0] || p, model: m.split('/').pop() || m };
  const label = m || p;
  if (!label) return { provider: '?', model: '?' };
  const parts = label.split('/').filter(Boolean);
  if (parts.length >= 2) return { provider: parts[0], model: parts.slice(1).join('/') };
  return { provider: '?', model: label };
}

/** 扫描日志目录，统计 Token 消耗、模型使用次数、任务完成情况 */
function scanLogs(): { tokens: { total: number; prompt: number; completion: number }; models: ModelUsage[]; tasks: { total: number; success: number; failed: number; running: number; types: Record<string, number> }; logs: { files: number; events: number; latestAt?: string; scannedDirs: string[] } } {
  let promptTokens = 0;
  let completionTokens = 0;
  const modelMap = new Map<string, ModelUsage>();
  const taskTypes: Record<string, number> = {};
  const taskState = new Map<string, { started: number; finished: number; failed: number }>();
  let latestAt = '';
  let events = 0;
  const files: string[] = [];
  const scannedDirs = candidateLogDirs();

  for (const logDir of scannedDirs) {
    try {
      for (const file of fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl'))) {
        files.push(path.join(logDir, file));
      }
    } catch { /* 日志目录不存在 */ }
  }

  for (const filePath of [...new Set(files)].sort()) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      let sessionProvider = '';
      let sessionModel = '';
      for (const line of content.split('\n').filter(Boolean)) {
        try {
          const evt = JSON.parse(line);
          events++;
          if (typeof evt.timestamp === 'string' && evt.timestamp > latestAt) latestAt = evt.timestamp;
          const sessionId = String(evt.sessionId || path.basename(filePath, '.jsonl'));
          const state = taskState.get(sessionId) || { started: 0, finished: 0, failed: 0 };
          if (evt.event === 'session_metadata' && evt.payload) {
            sessionProvider = String(evt.payload.provider || '');
            sessionModel = String(evt.payload.model || '');
          }
          if (evt.event === 'llm_response' && evt.payload) {
            const prompt = Number(evt.payload.prompt ?? evt.payload.promptTokens) || 0;
            const completion = Number(evt.payload.completion ?? evt.payload.completionTokens) || 0;
            promptTokens += prompt;
            completionTokens += completion;
            const parsed = parseModelLabel(sessionProvider, sessionModel);
            addModelUsage(modelMap, parsed.provider, parsed.model);
          }
          if (evt.event === 'task_start' && evt.payload) {
            state.started++;
            const taskType = classifyTask(String(evt.payload.task || 'chat'));
            taskTypes[taskType] = (taskTypes[taskType] || 0) + 1;
          }
          if (evt.event === 'task_finish') {
            state.finished++;
            const summary = String(evt.payload?.summary || '').toLowerCase();
            if (summary.includes('fail') || summary.includes('error') || summary.includes('失败')) state.failed++;
          }
          if (evt.event === 'error') state.failed++;
          taskState.set(sessionId, state);
        } catch { /* 跳过格式错误的行 */ }
      }
    } catch { /* 跳过不可读文件 */ }
  }

  let total = 0;
  let failed = 0;
  let running = 0;
  for (const state of taskState.values()) {
    total += state.started;
    failed += Math.min(state.started, state.failed);
    running += Math.max(0, state.started - state.finished);
  }
  const success = Math.max(0, total - failed - running);
  const models = [...modelMap.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  return {
    tokens: { total: promptTokens + completionTokens, prompt: promptTokens, completion: completionTokens },
    models,
    tasks: { total, success, failed, running, types: taskTypes },
    logs: { files: new Set(files).size, events, latestAt: latestAt || undefined, scannedDirs },
  };
}

export default function handler(req: NextApiRequest, res: NextApiResponse<StatsResponse>) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' } as any); return; }
  try {
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const procMem = process.memoryUsage();

    const stats = scanLogs();

    res.status(200).json({
      cpu: {
        usagePercent: getCpuUsage(),
        cores: os.cpus().length,
      },
      memory: {
        totalMB: Math.round(memTotal / 1024 / 1024),
        usedMB: Math.round((memTotal - memFree) / 1024 / 1024),
        processMB: Math.round(procMem.rss / 1024 / 1024),
        usagePercent: Math.round(((memTotal - memFree) / memTotal) * 100),
      },
      tokens: stats.tokens,
      models: stats.models,
      tasks: stats.tasks,
      logs: stats.logs,
      uptime: process.uptime(),
    });
  } catch (e: unknown) {
    console.error('[api] system/stats', e);
    res.status(500).json({ error: 'Internal server error' } as any);
  }
}
