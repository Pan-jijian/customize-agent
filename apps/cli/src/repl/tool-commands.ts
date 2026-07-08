import type { Message } from '@customize-agent/types';
import type { BuiltinTools } from '@customize-agent/tools';
import { t } from '../tui/renderer.js';
import type { I18nManager } from '../i18n/manager.js';

/**
 * 快捷工具命令：调用 BuiltinTools 中的常用功能。
 * 包括 /web、/export、/checkpoint、/git、/preview、/file、/mcp、/plugin、/zip 等。
 */
export class ToolCommands {
  constructor(private builtinTools: BuiltinTools, private i18n: I18nManager, private history: Message[]) {}

  async web(args: string): Promise<void> {
    const [sub, ...rest] = args.split(/\s+/);
    const input = rest.join(' ');
    if (sub === 'search' && input) process.stdout.write(await this.builtinTools.webSearch(input) + '\n\n');
    else if (sub === 'fetch' && input) process.stdout.write((await this.builtinTools.webFetch(input)).slice(0, 6000) + '\n\n');
    else process.stdout.write(t.warning('Usage: /web search <query> | /web fetch <url>\n\n'));
  }

  async export(args: string): Promise<void> {
    const [kind, output = `export-${Date.now()}.md`] = args.split(/\s+/);
    const content = this.history.filter(m => m.role !== 'system').map(m => `## ${m.role}\n\n${m.content}`).join('\n\n');
    if (kind === 'json') process.stdout.write(await this.builtinTools.exportJson(output, this.history) + '\n\n');
    else if (kind === 'html') process.stdout.write(await this.builtinTools.exportHtml(output, 'Session Export', content) + '\n\n');
    else if (kind === 'pdf') process.stdout.write(await this.builtinTools.exportPdf(output, 'Session Export', content) + '\n\n');
    else if (kind === 'session') process.stdout.write(await this.builtinTools.exportSession(output, this.history) + '\n\n');
    else process.stdout.write(await this.builtinTools.exportMarkdown(output, content) + '\n\n');
  }

  async checkpoint(args: string): Promise<void> {
    const [sub, name = `checkpoint-${Date.now()}`] = args.split(/\s+/);
    if (sub === 'create') process.stdout.write(await this.builtinTools.checkpointCreate(name) + '\n\n');
    else if (sub === 'restore') process.stdout.write(await this.builtinTools.checkpointRestore(name) + '\n\n');
    else if (sub === 'delete') process.stdout.write(await this.builtinTools.checkpointDelete(name) + '\n\n');
    else process.stdout.write(await this.builtinTools.checkpointList() + '\n\n');
  }

  async git(args: string): Promise<void> {
    const sub = args.trim() || 'status';
    const map: Record<string, string[]> = {
      status: ['status', '--short'],
      diff: ['diff'],
      log: ['log', '--oneline', '-20'],
      stash: ['stash', 'push'],
    };
    process.stdout.write(await this.builtinTools.git(map[sub] ?? ['status', '--short']) + '\n\n');
  }

  async preview(args: string): Promise<void> {
    const url = args.trim();
    if (!url) { process.stdout.write(t.warning(this.i18n.t('cmd.usage_preview') + '\n\n')); return; }
    process.stdout.write(await this.builtinTools.openPreview(url) + '\n\n');
  }

  async file(args: string): Promise<void> {
    const [sub, file] = args.split(/\s+/);
    if (!file) { process.stdout.write(t.warning('Usage: /file inspect <path> | /file text <path>\n\n')); return; }
    if (sub === 'text') process.stdout.write(await this.builtinTools.extractText(file) + '\n\n');
    else process.stdout.write(await this.builtinTools.inspectFile(file) + '\n\n');
  }

  async mcp(args: string): Promise<void> {
    const [sub, name, ...rest] = args.split(/\s+/).filter(Boolean);
    if (sub === 'add' && name) process.stdout.write(await this.builtinTools.mcpAdd(name, rest.join(' ')) + '\n\n');
    else if (sub === 'remove' && name) process.stdout.write(await this.builtinTools.mcpRemove(name) + '\n\n');
    else if (sub === 'tools') process.stdout.write(await this.builtinTools.mcpTools(name) + '\n\n');
    else process.stdout.write(await this.builtinTools.mcpList() + '\n\n');
  }

  async plugin(args: string): Promise<void> {
    const [sub, name] = args.split(/\s+/).filter(Boolean);
    if (sub === 'install' && name) process.stdout.write(await this.builtinTools.pluginInstall(name) + '\n\n');
    else process.stdout.write(await this.builtinTools.pluginList() + '\n\n');
  }

  async zip(args: string): Promise<void> {
    const [output, ...files] = args.split(/\s+/).filter(Boolean);
    if (!output || !files.length) { process.stdout.write(t.warning('Usage: /zip <output.tar> <files...>\n\n')); return; }
    process.stdout.write(await this.builtinTools.zipFiles(output, files) + '\n\n');
  }
}
