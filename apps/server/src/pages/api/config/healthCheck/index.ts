import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/configService';
import { createProvider } from '@customize-agent/llm';
import { resolveProtocol } from '@customize-agent/runtime';
import { recordErrorLog } from '@/services/errorLogService';
import { withApiErrorBoundary } from '@/services/apiErrorBoundary';

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
  const start = Date.now();
  try {
    const p = createProvider(providerFactoryName(providerName, cfg), { apiKey: cfg?.apiKey, baseUrl: cfg?.baseUrl, modelName: providerName, directEndpoint: cfg?.directEndpoint });
    await p.chat([{ role: 'user', content: 'ping' }], { maxTokens: 1, temperature: 0 });
    res.status(200).json({ success: true, message: '连接成功', latencyMs: Date.now() - start });
  } catch (err: unknown) {
    const entry = recordErrorLog({ level: 'warn', source: 'api/config/healthCheck', functionName: 'providerHealthCheck', error: err, req, meta: { providerName } });
    res.status(200).json({ success: false, message: err instanceof Error ? err.message : 'Health check failed', latencyMs: Date.now() - start, requestId: entry.id });
  }
}

export default withApiErrorBoundary('api/config/healthCheck', handler);
