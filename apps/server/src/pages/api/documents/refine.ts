import type { NextApiRequest, NextApiResponse } from 'next';
import { createProvider } from '@customize-agent/llm';
import { resolveProtocol } from '@customize-agent/runtime';
import { getConfigStore } from '@/services/configService';

type LlmMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string };

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

const DEFAULT_MAX_MARKDOWN_CHARS = 300_000;
const DEFAULT_MAX_INSTRUCTION_CHARS = 12_000;

function getPositiveIntEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function cleanMarkdown(value: string) {
  return value.trim().replace(/^```(?:markdown|md)?\s*/iu, '').replace(/```$/u, '').trim();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { title, markdown, instruction, facts, chapters } = req.body as { title?: unknown; markdown?: unknown; instruction?: unknown; facts?: unknown; chapters?: unknown };
  const currentMarkdown = typeof markdown === 'string' ? markdown.trim() : '';
  const userInstruction = typeof instruction === 'string' ? instruction.trim() : '';
  if (!currentMarkdown || !userInstruction) return res.status(400).json({ error: '当前内容和修改要求不能为空' });
  const maxMarkdownChars = getPositiveIntEnv('DOCUMENT_REFINE_MAX_MARKDOWN_CHARS', DEFAULT_MAX_MARKDOWN_CHARS);
  const maxInstructionChars = getPositiveIntEnv('DOCUMENT_REFINE_MAX_INSTRUCTION_CHARS', DEFAULT_MAX_INSTRUCTION_CHARS);
  if (currentMarkdown.length > maxMarkdownChars) return res.status(400).json({ error: `当前文档过长，请先缩小修改范围或压缩到 ${maxMarkdownChars} 字以内` });
  if (userInstruction.length > maxInstructionChars) return res.status(400).json({ error: `修改要求过长，请压缩到 ${maxInstructionChars} 字以内` });

  const active = getActiveModelWithProvider();
  if (!active) return res.status(400).json({ error: '未配置可用模型，请先在模型配置中启用模型' });

  const factList = Array.isArray(facts) ? facts.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 80) : [];
  const chapterList = Array.isArray(chapters) ? chapters.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 40) : [];
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: '你是专业的文档编辑助手。请严格基于用户提供的 Markdown 文档和修改要求进行编辑，输出可以直接替换编辑框的完整 Markdown。不要解释，不要添加代码围栏，不要声称已保存。保留原文事实、标题层级和关键结构；除非用户明确要求，不要删除重要事实。',
    },
    {
      role: 'user',
      content: [
        `文档标题：${typeof title === 'string' && title.trim() ? title.trim() : '未命名文档'}`,
        chapterList.length > 0 ? `章节目录：\n${chapterList.map(item => `- ${item}`).join('\n')}` : '',
        factList.length > 0 ? `结构化事实：\n${factList.map(item => `- ${item}`).join('\n')}` : '',
        `修改要求：\n${userInstruction}`,
        `当前 Markdown：\n${currentMarkdown}`,
      ].filter(Boolean).join('\n\n'),
    },
  ];

  try {
    const { model, provider: providerConfig } = active;
    const provider = createProvider(providerFactoryName(model.provider, providerConfig), {
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey,
      modelName: model.name,
      directEndpoint: providerConfig.directEndpoint,
    });
    const response = await provider.chat(messages, { temperature: 0.25 });
    const refinedMarkdown = cleanMarkdown(response.content);
    if (!refinedMarkdown) return res.status(500).json({ error: 'AI 未返回有效文档内容' });
    res.status(200).json({ markdown: refinedMarkdown });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '文档精准修改失败' });
  }
}
