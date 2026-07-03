// @customize-agent/cli — 工具调用预览 & 折叠追踪
import type { ToolCall } from '@customize-agent/types';
import { toolCallFold, toolCallFolding } from '../tui/renderer.js';
import type { AgentEvent } from './executor.js';

/** 管理工具调用预览的去重和发射 */
export class ToolPreviewTracker {
  private previewed = new Set<string>();

  private keys(tc: ToolCall): string[] {
    return [tc.name, tc.id].filter(Boolean) as string[];
  }

  wasPreviewed(tc: ToolCall): boolean {
    return this.keys(tc).some(k => this.previewed.has(k));
  }

  markPreviewed(tc: ToolCall): void {
    for (const k of this.keys(tc)) this.previewed.add(k);
  }

  /** 发射预览事件，返回是否发射了新的预览 */
  emit(tc: ToolCall, elapsedMs: number, onEvent: (e: AgentEvent) => void): boolean {
    if (this.wasPreviewed(tc)) return false;
    this.markPreviewed(tc);
    onEvent({ type: 'tool_call_preview', toolName: tc.name, args: tc.arguments, elapsedMs });
    return true;
  }

  /** 快照当前已预览集合（用于判断某工具调用在折叠前是否已预览） */
  snapshot(): Set<string> {
    return new Set(this.previewed);
  }
}

/** 管理同类工具调用的折叠/合并渲染 */
export class ToolFoldTracker {
  private foldType = '';
  private foldCount = 0;
  private foldArgs: string[] = [];
  private foldTotalMs = 0;
  private foldDiff = '';
  private foldStartMs = 0;

  constructor(
    private stream: boolean,
    private write: (text: string) => void,
    private toolLabel: (name: string) => string,
    private toolsLabel: string,
    private formatArg: (args?: Record<string, unknown>) => string,
    private setLiveStatus?: (lines: string | string[]) => void,
    private commitStatus?: (lines: string | string[]) => void,
  ) {}

  /** 为工具调用推进折叠状态 */
  push(tc: ToolCall, skipStartRender: boolean, previewElapsedMs: number): void {
    if (tc.name === this.foldType) {
      this.foldCount++;
      this.foldArgs.push(this.formatArg(tc.arguments));
      if (this.stream && !skipStartRender) {
        const line = toolCallFolding(tc.name, this.foldCount, this.foldArgs[this.foldArgs.length - 1]!, Date.now() - this.foldStartMs, this.toolLabel(tc.name), this.toolsLabel);
        if (this.setLiveStatus) this.setLiveStatus(line);
        else this.write(line);
      }
    } else {
      this.flush();
      this.foldType = tc.name;
      this.foldCount = 1;
      this.foldArgs = [this.formatArg(tc.arguments)];
      this.foldTotalMs = 0;
      this.foldDiff = '';
      this.foldStartMs = Date.now();
      if (this.stream && !skipStartRender) {
        const line = toolCallFolding(tc.name, 1, this.foldArgs[0]!, previewElapsedMs, this.toolLabel(tc.name), this.toolsLabel);
        if (this.setLiveStatus) this.setLiveStatus(line);
        else this.write(line);
      }
    }
  }

  /** 累加工具执行耗时 */
  addDuration(ms: number): void {
    this.foldTotalMs += ms;
  }

  /** 保存 write_file 的 diff 结果 */
  setDiff(diff: string): void {
    this.foldDiff = diff;
  }

  /** 刷新当前折叠组 */
  flush(): void {
    if (this.foldCount === 0) return;
    if (this.stream) {
      const output = toolCallFold(this.foldType, this.foldCount, this.foldArgs, this.foldTotalMs, this.foldDiff, this.toolLabel(this.foldType), this.toolsLabel);
      if (this.commitStatus) this.commitStatus(output);
      else this.write(output + '\n');
    }
    this.foldType = ''; this.foldCount = 0; this.foldArgs = []; this.foldTotalMs = 0; this.foldDiff = ''; this.foldStartMs = 0;
  }
}
