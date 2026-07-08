// @customize-agent/cli — 工具审批处理器
import * as readline from 'readline';
import { t, s } from '../tui/renderer.js';
import type { I18nManager } from '../i18n/manager.js';
import { supportsAnsi } from '../tui/terminal-capabilities.js';

let keypressInitialized = false;

export type ApprovalHandler = (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<boolean>;

export function createApprovalHandler(i18n: I18nManager): ApprovalHandler {
  return async (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const label = i18n.toolLabel(toolName);
    const detail = args.path
      ? i18n.t('approval.file_detail', { path: String(args.path) })
      : args.input
        ? i18n.t('approval.command_detail', { cmd: String(args.input).slice(0, 120) })
        : undefined;

    const approvalLines = [
      t.warning(s.bold(i18n.t('approval.box_title'))),
      `${t.text(label + ':')} ${t.accent(toolName)}`,
      ...(detail ? [t.dim(detail)] : []),
    ];
    process.stdout.write(approvalLines.join('\n') + '\n');

    if (!supportsAnsi()) {
      return new Promise<boolean>(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`${i18n.t('approval.run')}? (y/N) `, answer => {
          rl.close();
          resolve(/^y(es)?$/i.test(answer.trim()));
        });
        signal?.addEventListener('abort', () => { rl.close(); resolve(false); }, { once: true });
      });
    }

    if (!keypressInitialized) {
      readline.emitKeypressEvents(process.stdin);
      keypressInitialized = true;
    }

    return new Promise<boolean>(resolve => {
      let raw = false;
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(true); raw = true; } catch { /* 忽略 */ }
      }
      process.stdin.resume();
      const choices = [
        { label: i18n.t('approval.run'), value: true },
        { label: i18n.t('approval.cancel'), value: false },
      ];
      let sel = 0;
      let linesDrawn = 0;
      const clear = () => {
        if (linesDrawn > 0) process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[0J`);
        linesDrawn = 0;
      };
      const draw = () => {
        clear();
        const lines = choices.map((choice, i) => `${i === sel ? t.accent('▶') : ' '} ${i === sel ? s.bold(choice.label) : choice.label}`);
        lines.push('', t.dim('↑↓  Enter  Esc'));
        process.stdout.write(lines.join('\n') + '\n');
        linesDrawn = lines.length;
      };
      let done = false;
      function onAbort() { finish(false); }
      const cleanup = () => {
        clear();
        process.stdout.write(`\x1b[${approvalLines.length}A\r\x1b[0J`);
        process.stdin.removeListener('keypress', onKeypress);
        signal?.removeEventListener('abort', onAbort);
        if (raw) try { process.stdin.setRawMode(false); } catch { /* 忽略 */ }
      };
      const finish = (approved: boolean) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(approved);
      };
      const onKeypress = (_str: string | undefined, key: readline.Key) => {
        if (key?.ctrl && key.name === 'c') finish(false);
        else if (key?.name === 'up' || key?.name === 'down') { sel = sel === 0 ? 1 : 0; draw(); }
        else if (key?.name === 'return' || key?.name === 'enter') finish(choices[sel]!.value);
        else if (key?.name === 'escape') finish(false);
      };

      process.stdin.on('keypress', onKeypress);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else draw();
    });
  };
}
