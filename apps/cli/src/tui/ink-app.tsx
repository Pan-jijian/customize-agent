/**
 * Ink TUI — React+Ink 终端渲染，对齐 Claude Code 架构
 */
import React, { useState, useCallback } from 'react';
import { render, Box, Text, Static, useInput } from 'ink';
import { t } from './renderer.js';
import type { AgentExecutor } from '../agent/executor.js';
import type { Message } from '@customize-agent/types';
import type { I18nManager } from '../i18n/manager.js';

interface OutputLine { id: number; text: string; }

function App({ executor, i18n, onReady }: {
  executor: AgentExecutor;
  i18n: I18nManager;
  onReady: (send: (input: string) => Promise<void>) => void;
}) {
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  let idCounter = 0;

  const executeInput = useCallback(async (userInput: string) => {
    if (!userInput.trim() || busy) return;
    setBusy(true);
    setInput('');
    const id = idCounter++;
    setLines(prev => [...prev, { id, text: `  ${t.accent('➜')} ${t.text(userInput)}` }]);

    // Ink 输出回调：将渲染后的 markdown 追加到输出行
    const onWrite = (text: string) => {
      setLines(prev => [...prev, { id: idCounter++, text }]);
    };

    try {
      const history: Message[] = [
        { role: 'system', content: executor.getSystemPrompt() },
        { role: 'user', content: userInput },
      ];
      await executor.runTask(history, { onWrite });
    } catch (err) {
      setLines(prev => [...prev, { id: idCounter++, text: `  ${t.error((err as Error).message)}` }]);
    } finally {
      setBusy(false);
    }
  }, [executor, busy]);

  React.useEffect(() => { onReady(executeInput); }, [onReady, executeInput]);

  useInput((inputChar, key) => {
    if (busy) return;
    if (key.return) { void executeInput(input); }
    else if (key.backspace || key.delete) { setInput(prev => prev.slice(0, -1)); }
    else if (inputChar) { setInput(prev => prev + inputChar); }
  });

  return (
    <Box flexDirection="column">
      <Static items={lines}>
        {(line) => <Text key={line.id}>{line.text}</Text>}
      </Static>
      {!busy ? (
        <Box>
          <Text color="cyan">  AGENT  │ ➜ </Text>
          <Text>{input}</Text>
        </Box>
      ) : (
        <Text dimColor>  {t.faint(i18n?.t('stream.thinking') ?? 'Thinking…')}</Text>
      )}
    </Box>
  );
}

export function startInkApp(
  executor: AgentExecutor,
  i18n: I18nManager,
): Promise<(input: string) => Promise<void>> {
  return new Promise((resolve) => {
    render(<App executor={executor} i18n={i18n} onReady={(send) => resolve(send)} />);
  });
}
