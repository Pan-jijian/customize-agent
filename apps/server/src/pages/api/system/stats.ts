import type { NextApiRequest, NextApiResponse } from 'next';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigStore } from '@/services/configService';

interface ModelUsage {
  provider: string;
  model: string;
  count: number;
}

interface StatsResponse {
  cpu: { usagePercent: number; cores: number };
  memory: { totalMB: number; usedMB: number; processMB: number; usagePercent: number };
  tokens: { total: number };
  models: ModelUsage[];
  tasks: { total: number; success: number; failed: number; types: Record<string, number> };
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

/** 当日志中无模型调用记录时，从配置中读取当前启用的模型作为降级展示 */
function configuredModelsFallback(): ModelUsage[] {
  try {
    const models = getConfigStore().load().models;
    const result: ModelUsage[] = [];
    for (const tier of ['action', 'reasoning', 'reader'] as const) {
      const active = models[tier].list.find(model => model.name === models[tier].active) ?? models[tier].list[0];
      if (active && !result.some(item => item.provider === active.provider && item.model === active.name)) {
        result.push({ provider: active.provider, model: active.name, count: 0 });
      }
    }
    return result;
  } catch {
    return [];
  }
}

/** 扫描日志目录，统计 Token 消耗、模型使用次数、任务完成情况 */
function scanLogs(): { tokens: number; models: ModelUsage[]; tasks: { total: number; success: number; failed: number; types: Record<string, number> } } {
  const logDir = path.join(os.homedir(), '.customize-agent', 'logs');
  let tokens = 0;
  const modelMap = new Map<string, ModelUsage>();
  const taskTypes: Record<string, number> = {};
  let total = 0;
  let success = 0;
  let failed = 0;

  try {
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(logDir, file), 'utf-8');
      let sessionProvider = '';
      let sessionModel = '';
      for (const line of content.split('\n').filter(Boolean)) {
        try {
          const evt = JSON.parse(line);
          if (evt.event === 'session_metadata' && evt.payload) {
            sessionProvider = String(evt.payload.provider || '').split('/')[0] || String(evt.payload.provider || '');
            sessionModel = String(evt.payload.model || '').split('/').pop() || String(evt.payload.model || '');
          }
          if (evt.event === 'llm_response' && evt.payload) {
            const prompt = Number(evt.payload.prompt ?? evt.payload.promptTokens) || 0;
            const completion = Number(evt.payload.completion ?? evt.payload.completionTokens) || 0;
            tokens += prompt + completion;
            addModelUsage(modelMap, sessionProvider, sessionModel);
          }
          if (evt.event === 'task_start' && evt.payload) {
            total++;
            const t = classifyTask(String(evt.payload.task || 'chat'));
            taskTypes[t] = (taskTypes[t] || 0) + 1;
          }
          if (evt.event === 'task_finish') {
            const summary = String(evt.payload?.summary || '');
            if (summary.includes('success') || summary.includes('成功')) success++;
            else if (summary.includes('fail') || summary.includes('error') || summary.includes('失败')) failed++;
            else success++;
          }
        } catch { /* 跳过格式错误的行 */ }
      }
    }
  } catch { /* 尚无日志，跳过 */ }

  const models = [...modelMap.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  return {
    tokens,
    models: models.length > 0 ? models : configuredModelsFallback(),
    tasks: { total, success, failed, types: taskTypes },
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
      tokens: { total: stats.tokens },
      models: stats.models,
      tasks: stats.tasks,
      uptime: process.uptime(),
    });
  } catch (e: unknown) {
    console.error('[api] system/stats', e);
    res.status(500).json({ error: 'Internal server error' } as any);
  }
}
