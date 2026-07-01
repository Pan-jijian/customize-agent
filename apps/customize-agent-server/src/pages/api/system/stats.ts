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
  tokens: { total: number };
  models: ModelUsage[];
  tasks: { total: number; success: number; failed: number; types: Record<string, number> };
  uptime: number;
}

let lastCpu = process.cpuUsage();
let lastTime = Date.now();

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
      for (const line of content.split('\n').filter(Boolean)) {
        try {
          const evt = JSON.parse(line);
          // Token 统计
          if (evt.event === 'llm_response' && evt.payload) {
            const prompt = Number(evt.payload.prompt) || 0;
            const completion = Number(evt.payload.completion) || 0;
            tokens += prompt + completion;
          }
          // Session metadata → model info
          if (evt.event === 'session_metadata' && evt.payload) {
            const key = `${evt.payload.provider || '?'}/${evt.payload.model || '?'}`;
            const entry = modelMap.get(key) || { provider: String(evt.payload.provider || '?'), model: String(evt.payload.model || '?'), count: 0 };
            entry.count++;
            modelMap.set(key, entry);
          }
          // 任务统计
          if (evt.event === 'task_start' && evt.payload) {
            total++;
            const t = String(evt.payload.task || 'chat').slice(0, 50);
            taskTypes[t] = (taskTypes[t] || 0) + 1;
          }
          if (evt.event === 'task_finish') {
            const summary = String(evt.payload?.summary || '');
            if (summary.includes('success') || summary.includes('成功')) success++;
            else if (summary.includes('fail') || summary.includes('error') || summary.includes('失败')) failed++;
            else success++; // 默认算成功
          }
        } catch { /* skip bad lines */ }
      }
    }
  } catch { /* no logs yet */ }

  return {
    tokens,
    models: [...modelMap.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    tasks: { total, success, failed, types: taskTypes },
  };
}

export default function handler(_req: NextApiRequest, res: NextApiResponse<StatsResponse>) {
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
}
