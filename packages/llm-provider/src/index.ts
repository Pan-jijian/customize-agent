import OpenAi from 'openai'
import { Message, LLMResponse } from '@code-agent/shared'


export interface LLMProviderOptions {
  apiKey?: string;
  baseUrl?: string;
}

export class DeepSeekProvider {
  private client: OpenAi;
  private modelName: string;
  constructor(options: LLMProviderOptions = {}) {
    this.client = new OpenAi({
      apiKey: options.apiKey || process.env.OPENAI_API_KEY,
      baseURL: options.baseUrl || process.env.OPENAI_BASE_URL
    })
    this.modelName = process.env.DEEPSEEK_MODEL_NAME || 'deepseek-v4-flash'
  }

  /**
   * 标准文本/流式聊天接口
   */
  async chat(messages: Message[]): Promise<LLMResponse> {
    try {
       const openAiMessages = messages.map(m => ({
        role: m.role,
        content: m.content
      })) as OpenAi.Chat.Completions.ChatCompletionMessageParam[];

      const response = await this.client.chat.completions.create({
        model: this.modelName,
        messages: openAiMessages,
        temperature: 0.2,
      }) 
      const choice = response.choices[0];
      const message = choice.message;

      const thinkingContent = (message as any).reasoning_content || undefined;
      return {
        content: message.content || '',
        thinkingContent,
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
        } : undefined
      }

    } catch (e) {
      console.error('DeepSeek v4 api 调用失败', e)
      throw e
    }
  }
}