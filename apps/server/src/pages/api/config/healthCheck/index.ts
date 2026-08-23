import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/common/configService';
import { createProvider } from '@customize-agent/llm';
import { resolveProtocol } from '@customize-agent/runtime';
import { recordErrorLog } from '@/services/common/errorLogService';
import { withApiErrorBoundary } from '@/services/common/apiErrorBoundary';

/** 根据协议类型映射 Provider 工厂名称 */
function providerFactoryName(providerName: string, providerConfig?: { protocol?: string }): string {
  const protocol = resolveProtocol(providerName, providerConfig);
  if (protocol === 'anthropic') return 'anthropic';
  if (protocol === 'google') return 'google';
  if (protocol === 'ollama') return 'ollama';
  if (protocol === 'openrouter') return 'openrouter';
  if (protocol === 'openai') {
    return ['deepseek', 'openai', 'openrouter', 'ollama'].includes(providerName) ? providerName : 'openai';
  }
  return providerName;
}

function resolveHealthCheckModelName(providerName: string): string {
  const config = getConfigStore().load();
  for (const tier of ['reasoning', 'action', 'reader'] as const) {
    const active = config.models[tier].active;
    const matched = config.models[tier].list.find(model => model.provider === providerName && model.name === active);
    if (matched) return matched.name;
  }
  for (const tier of ['reasoning', 'action', 'reader'] as const) {
    const matched = config.models[tier].list.find(model => model.provider === providerName);
    if (matched) return matched.name;
  }
  return providerName;
}

/**
 * Provider 健康检查 API 处理器
 * 向指定 AI 提供商发送 ping 消息测试连通性
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 仅允许 POST 请求
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { provider: providerName } = req.body;
  if (!providerName) return res.status(400).json({ success: false, message: 'Provider name required' });
  const cfg = getConfigStore().getProvider(providerName);
  const modelName = resolveHealthCheckModelName(providerName);
  const factoryName = providerFactoryName(providerName, cfg);
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const p = createProvider(factoryName, { apiKey: cfg?.apiKey, baseUrl: cfg?.baseUrl, modelName, directEndpoint: cfg?.directEndpoint });
    await p.chat([{ role: 'user', content: 'ping' }], { temperature: 0, signal: controller.signal });
    res.status(200).json({ success: true, message: '连接成功', latencyMs: Date.now() - start, modelName });
  } catch (err: unknown) {
    const entry = recordErrorLog({ level: 'warn', source: 'api/config/healthCheck', functionName: 'providerHealthCheck', error: err, req, meta: { providerName, modelName } });
    const message = controller.signal.aborted ? '健康检查超时' : err instanceof Error ? err.message : 'Health check failed';
    res.status(200).json({ success: false, message, latencyMs: Date.now() - start, requestId: entry.id, modelName });
  } finally {
    clearTimeout(timeout);
  }
}

export default withApiErrorBoundary('api/config/healthCheck', handler);
