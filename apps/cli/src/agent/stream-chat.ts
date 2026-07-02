import type { FunctionDefinition, ILLMProvider, StreamChunk } from '@customize-agent/llm';
import type { Message, ToolCall } from '@customize-agent/types';
import type { I18nManager } from '../i18n/manager.js';
import { extractThinkingSubtitle, renderInlineMarkdown, renderMarkdown, spinnerStart, t, thinkingSpinner } from '../tui/renderer.js';
import { supportsAnsi } from '../tui/terminal-capabilities.js';

export interface StreamChatOptions {
  provider: ILLMProvider;
  messages: Message[];
  tools: FunctionDefinition[];
  signal?: AbortSignal;
  i18n?: I18nManager;
  write: (text: string) => void;
  onToolCall?: (tc: ToolCall) => void;
  onThinkingContent?: (content: string) => void;
}

export interface StreamChatResult {
  content: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export async function streamChat(options: StreamChatOptions): Promise<StreamChatResult> {
  const { provider, messages, tools, signal, i18n, write, onToolCall, onThinkingContent } = options;
  let content = '';
  const toolCalls: ToolCall[] = [];
  const spin = spinnerStart(i18n?.t('stream.thinking'), write);
  let spinnerStopped = false;

  const tips = i18n?.tList('think.tips') ?? [];
  const think = thinkingSpinner(tips, write, {
    thinking: i18n?.t('think.thinking') ?? i18n?.t('stream.thinking') ?? 'Thinking…',
    thoughtFor: i18n?.t('think.thought_for') ?? 'Thought for',
    tokens: i18n?.t('think.tokens') ?? 'tokens',
  });
  let thinkActive = false;
  let thinkStartMs = 0;
  let thinkTokens = 0;
  let thinkingContent = '';

  const stopSpin = () => {
    if (!spinnerStopped) { spin.stop(); spinnerStopped = true; }
  };

  const flushThink = () => {
    if (!thinkActive) return;
    const elapsed = Date.now() - thinkStartMs;
    think.thinkDone(elapsed, thinkTokens, i18n?.t('think.expand_hint') ?? '(ctrl+o to expand thinking)');
    thinkActive = false;
  };

  let lineBuf = '';
  const tableBuf: string[] = [];
  let fenceBuf: string[] | null = null;
  const fenceRe = /^(`{3,}|~{3,})/;

  const response = await provider.chatStream(messages, (chunk: StreamChunk) => {
    switch (chunk.type) {
      case 'content': {
        stopSpin();
        flushThink();
        content += chunk.text;
        lineBuf += chunk.text;

        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';

        for (const line of lines) {
          const isFenceLine = fenceRe.test(line);
          if (isFenceLine || fenceBuf !== null) {
            if (fenceBuf === null) fenceBuf = [line];
            else if (isFenceLine) {
              fenceBuf.push(line);
              write(renderMarkdown(fenceBuf.join('\n') + '\n'));
              fenceBuf = null;
            } else {
              fenceBuf.push(line);
            }
            continue;
          }

          if (/^\|/.test(line)) {
            tableBuf.push(line);
          } else {
            if (tableBuf.length > 0) {
              write(renderMarkdown(tableBuf.join('\n') + '\n'));
              tableBuf.length = 0;
            }
            write(renderInlineMarkdown(line + '\n'));
          }
        }
        break;
      }
      case 'thinking':
        stopSpin();
        if (!thinkActive) {
          thinkActive = true;
          thinkStartMs = Date.now();
          thinkTokens = 0;
          thinkingContent = '';
          onThinkingContent?.(thinkingContent);
          think.thinkStart();
        }
        thinkingContent += chunk.text;
        onThinkingContent?.(thinkingContent);
        thinkTokens += Math.ceil(chunk.text.length / 4);
        think.thinkTick(Date.now() - thinkStartMs, thinkTokens, extractThinkingSubtitle(thinkingContent));
        break;
      case 'tool_call_preview':
        onToolCall?.({ id: chunk.id, name: chunk.name, arguments: {} });
        break;
      case 'tool_call':
        toolCalls.push(chunk.call);
        onToolCall?.(chunk.call);
        break;
      case 'reset':
        if (thinkActive) { think.stop(); thinkActive = false; }
        if (supportsAnsi()) write('\x1b[1G\x1b[2K');
        else write('\n');
        content = '';
        toolCalls.length = 0;
        lineBuf = '';
        tableBuf.length = 0;
        fenceBuf = null;
        break;
      case 'done':
        stopSpin();
        flushThink();
        if (fenceBuf !== null) {
          write(renderMarkdown(fenceBuf.join('\n') + '\n'));
          fenceBuf = null;
        }
        if (tableBuf.length > 0) {
          write(renderMarkdown(tableBuf.join('\n') + '\n'));
          tableBuf.length = 0;
        }
        if (lineBuf) write(renderInlineMarkdown(lineBuf));
        lineBuf = '';
        if (content || toolCalls.length) write('\n');
        break;
      case 'error':
        stopSpin();
        if (thinkActive) { think.stop(); thinkActive = false; }
        write(t.error(chunk.message ?? 'Stream error') + '\n');
        break;
    }
  }, { tools, signal });

  return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, usage: response.usage };
}
