import type { NextApiRequest, NextApiResponse } from 'next';
import { createProvider } from '@customize-agent/llm';
import { resolveProtocol } from '@customize-agent/runtime';
import { getConfigStore } from '@/services/configService';

type LlmMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string };
type PromptChatRole = 'user' | 'assistant';

interface PromptChatMessage {
  role: PromptChatRole;
  content: string;
}

interface ReferencedKnowledgeFile {
  relativePath: string;
  content: string;
}

function providerFactoryName(providerName: string, providerConfig?: { protocol?: string }) {
  const protocol = resolveProtocol(providerName, providerConfig);
  if (protocol === 'anthropic') return 'anthropic';
  if (protocol === 'google') return 'google';
  if (protocol === 'ollama') return 'ollama';
  if (protocol === 'openrouter') return 'openrouter';
  return 'openai';
}

function getActiveModelWithProvider() {
  const config = getConfigStore().load();
  const activeModel = config.models.reasoning.active || config.models.action.active || config.models.reader.active;
  const selected = [...config.models.reasoning.list, ...config.models.action.list, ...config.models.reader.list].find(model => model.name === activeModel);
  if (!selected) return undefined;
  const providerConfig = config.providers[selected.provider];
  if (!providerConfig) return undefined;
  return { model: selected, provider: providerConfig };
}

function normalizeHistory(history: unknown): PromptChatMessage[] {
  if (!Array.isArray(history)) return [];
  return history
    .map(item => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Partial<PromptChatMessage>;
      if (raw.role !== 'user' && raw.role !== 'assistant') return null;
      if (typeof raw.content !== 'string' || !raw.content.trim()) return null;
      return { role: raw.role, content: raw.content.slice(0, 8000) };
    })
    .filter((item): item is PromptChatMessage => !!item)
    .slice(-8);
}

function normalizeReferences(references: unknown): ReferencedKnowledgeFile[] {
  if (!Array.isArray(references)) return [];
  return references
    .map(item => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Partial<ReferencedKnowledgeFile>;
      if (typeof raw.relativePath !== 'string' || typeof raw.content !== 'string' || !raw.content.trim()) return null;
      return { relativePath: raw.relativePath.slice(0, 500), content: raw.content.slice(0, 12000) };
    })
    .filter((item): item is ReferencedKnowledgeFile => !!item)
    .slice(0, 3);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, content, message, history, references } = req.body as { name?: unknown; content?: unknown; message?: unknown; history?: unknown; references?: unknown };
  const userMessage = typeof message === 'string' ? message.trim() : '';
  if (!userMessage) return res.status(400).json({ error: '请输入要发送给 AI 的问题' });
  const knowledgeReferences = normalizeReferences(references);

  const active = getActiveModelWithProvider();
  if (!active) return res.status(400).json({ error: '未配置可用模型，请先在模型配置中启用模型' });

  const promptName = typeof name === 'string' && name.trim() ? name.trim() : '未命名提示词';
  const promptContent = typeof content === 'string' ? content : '';
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: `你是专业的提示词优化助手，正在协助用户编辑一个提示词。\n\n要求：\n1. 始终围绕当前提示词进行分析、优化、补充、精简或重写。\n2. 如果用户要求你修改、优化、改写或生成提示词，请输出一份可以直接替换编辑框的完整提示词内容。\n3. 不要声称已经保存文件，也不要要求用户离开当前页面。\n4. 内容要清晰、可执行，适合直接作为系统提示词或角色提示词使用。\n5. 如果只是咨询问题，可以先解释思路；如果给出可应用版本，请把完整版本放在回复主体中。`,
    },
    {
      role: 'user',
      content: `当前提示词名称：${promptName}\n\n当前提示词内容：\n${promptContent || '（当前为空）'}`,
    },
    ...(knowledgeReferences.length > 0 ? [{
      role: 'user' as const,
      content: `用户通过 @ 指令召回了以下本地知识库文件，请结合这些资料优化当前提示词：\n\n${knowledgeReferences.map(file => `## ${file.relativePath}\n${file.content}`).join('\n\n---\n\n')}`,
    }] : []),
    ...normalizeHistory(history).map(item => ({ role: item.role, content: item.content })),
    { role: 'user', content: userMessage },
  ];

  try {
    const { model, provider: providerConfig } = active;
    const provider = createProvider(providerFactoryName(model.provider, providerConfig), {
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey,
      modelName: model.name,
      directEndpoint: providerConfig.directEndpoint,
    });
    const response = await provider.chat(messages, { temperature: 0.3 });
    res.status(200).json({ content: response.content.trim() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'AI 对话失败' });
  }
}
