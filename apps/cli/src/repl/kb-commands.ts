import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExternalExtractorRegistry, MultiProjectManager, getProjectKbPath } from '@customize-agent/knowledge';
import { t } from '../tui/renderer.js';
import type { I18nManager } from '../i18n/manager.js';

export class KbCommands {
  private manager?: MultiProjectManager;
  private dashboardUrl?: string;
  private i18n?: I18nManager;

  constructor(
    private readonly projectRoot: string,
    manager?: MultiProjectManager,
    dashboardUrl?: string,
    i18n?: I18nManager,
  ) {
    this.manager = manager;
    this.dashboardUrl = dashboardUrl;
    this.i18n = i18n;
  }

  private getManager(): MultiProjectManager {
    this.manager ??= new MultiProjectManager();
    return this.manager;
  }

  async handle(args: string): Promise<void> {
    const tokens = this.parse(args);
    const command = tokens.shift() ?? 'overview';

    switch (command) {
      case 'overview':
      case '':
        await this.overview();
        return;
      case 'status':
        await this.status();
        return;
      case 'list':
        await this.list(tokens.join(' '));
        return;
      case 'search':
        await this.search(tokens);
        return;
      case 'reindex':
        await this.reindex();
        return;
      case 'dedup':
        await this.dedup();
        return;
      case 'projects':
        await this.projects();
        return;
      case 'forget':
        await this.forget(tokens[0]);
        return;
      case 'global':
        await this.global(tokens);
        return;
      case 'daemon':
        await this.daemon(tokens[0]);
        return;
      case 'config':
        await this.config();
        return;
      case 'dash':
      case 'dashboard':
        await this.dashboard(tokens);
        return;
      case 'add':
        await this.add(tokens);
        return;
      case 'remove':
        await this.remove(tokens);
        return;
      case 'tag':
        await this.tag(tokens);
        return;
      default:
        process.stdout.write(t.warning(`未知 /kb 命令: ${command}\n\n`));
    }
  }

  private async overview(): Promise<void> {
    const project = await this.getManager().getProject(this.projectRoot);
    const stats = project.getStats();
    process.stdout.write(`\n${t.accent('Knowledge Base')}\n`);
    process.stdout.write(`  项目: ${t.text(project.projectId ?? 'unknown')}\n`);
    process.stdout.write(`  路径: ${t.dim(project.kbPath)}\n`);
    process.stdout.write(`  文件: ${stats.fileCount}  Chunks: ${stats.chunkCount}  大小: ${stats.totalSizeBytes} bytes\n\n`);
  }

  private async status(): Promise<void> {
    await this.overview();
    const global = await this.getManager().getGlobalKB();
    const globalStats = global.getStats();
    process.stdout.write(`${t.accent('Global KB')}\n`);
    process.stdout.write(`  路径: ${t.dim(global.kbPath)}\n`);
    process.stdout.write(`  文件: ${globalStats.fileCount}  Chunks: ${globalStats.chunkCount}  大小: ${globalStats.totalSizeBytes} bytes\n\n`);
  }

  private async list(pattern?: string): Promise<void> {
    const kbPath = getProjectKbPath(this.projectRoot);
    if (!fs.existsSync(kbPath)) {
      process.stdout.write(t.dim(`未找到 ${kbPath}\n\n`));
      return;
    }

    const project = await this.getManager().getProject(this.projectRoot);
    await project.incrementalIndex();
    const files = project.listFiles()
      .map(file => file.relativePath)
      .filter(file => !pattern || file.includes(pattern));

    if (!files.length) {
      process.stdout.write(t.dim('没有匹配的知识库文件。\n\n'));
      return;
    }

    process.stdout.write(`\n${t.accent('knowledgeBase/')}\n`);
    for (const file of files.slice(0, 100)) process.stdout.write(`  ${file}\n`);
    if (files.length > 100) process.stdout.write(t.dim(`  ... 还有 ${files.length - 100} 个文件\n`));
    process.stdout.write('\n');
  }

  private async search(tokens: string[]): Promise<void> {
    const { scope, rest } = this.extractScope(tokens);
    const query = rest.join(' ').trim();
    if (!query) {
      process.stdout.write(t.warning('用法: /kb search [--scope project|global|all] <query>\n\n'));
      return;
    }

    const results = await this.getManager().search(this.projectRoot, query, { scope, limit: 10 });
    process.stdout.write(`\n${t.accent(`KB Search (${scope})`)}\n`);
    for (const result of results.results) {
      process.stdout.write(`  ${t.text(result.filePath)} ${t.dim(`[${result.scope}] ${result.score.toFixed(3)}`)}\n`);
      process.stdout.write(`    ${result.content.replace(/\s+/g, ' ').slice(0, 160)}\n`);
    }
    if (!results.results.length) process.stdout.write(t.dim('  无结果\n'));
    process.stdout.write('\n');
  }

  private async reindex(): Promise<void> {
    const project = await this.getManager().getProject(this.projectRoot);
    const diff = await project.incrementalIndex();
    process.stdout.write(t.success(`索引完成: +${diff.newFiles.length} ~${diff.modifiedFiles.length} -${diff.deletedFiles.length}, skipped ${diff.skippedFiles.length}\n\n`));
  }

  private async add(tokens: string[]): Promise<void> {
    const sourcePath = tokens[0];
    const targetPath = tokens[1];
    if (!sourcePath) {
      process.stdout.write(t.warning('用法: /kb add <file> [target-relative-path]\n\n'));
      return;
    }
    const project = await this.getManager().getProject(this.projectRoot);
    const diff = await project.addFile(sourcePath, targetPath);
    process.stdout.write(t.success(`已添加并索引: +${diff.newFiles.length} ~${diff.modifiedFiles.length}\n\n`));
  }

  private async remove(tokens: string[]): Promise<void> {
    const relativePath = tokens[0];
    if (!relativePath) {
      process.stdout.write(t.warning('用法: /kb remove <relative-path>\n\n'));
      return;
    }
    const project = await this.getManager().getProject(this.projectRoot);
    await project.removeFile(relativePath);
    process.stdout.write(t.success(`已移除: ${relativePath}\n\n`));
  }

  private async tag(tokens: string[]): Promise<void> {
    const relativePath = tokens.shift();
    if (!relativePath || tokens.length === 0) {
      process.stdout.write(t.warning('用法: /kb tag <relative-path> <tag...>\n\n'));
      return;
    }
    const project = await this.getManager().getProject(this.projectRoot);
    project.tagFile(relativePath, tokens);
    process.stdout.write(t.success(`已设置标签: ${relativePath} => ${tokens.join(', ')}\n\n`));
  }

  private async dedup(): Promise<void> {
    const project = await this.getManager().getProject(this.projectRoot);
    const relationships = project.listRelationships();
    const summary = new Map<string, number>();
    for (const relationship of relationships) {
      summary.set(relationship.relationshipType, (summary.get(relationship.relationshipType) ?? 0) + 1);
    }

    process.stdout.write(`\n${t.accent('Dedup / Relationships')}\n`);
    if (summary.size === 0) process.stdout.write(t.dim('  暂无关系记录\n'));
    for (const [type, count] of summary) process.stdout.write(`  ${type}: ${count}\n`);
    process.stdout.write('\n');
  }

  private async projects(): Promise<void> {
    const projects = await this.getManager().listProjects();
    process.stdout.write(`\n${t.accent('Known Projects')}\n`);
    if (!projects.length) process.stdout.write(t.dim('  暂无项目注册记录\n'));
    for (const project of projects) {
      process.stdout.write(`  ${project.projectId} ${t.text(project.projectName ?? path.basename(project.projectRoot))}\n`);
      process.stdout.write(`    ${t.dim(project.projectRoot)}\n`);
    }
    process.stdout.write('\n');
  }

  private async forget(projectId?: string): Promise<void> {
    if (!projectId) {
      process.stdout.write(t.warning('用法: /kb forget <project-id>\n\n'));
      return;
    }
    await this.getManager().forgetProject(projectId);
    process.stdout.write(t.success(`已忘记项目索引: ${projectId}\n\n`));
  }

  private async global(tokens: string[]): Promise<void> {
    const command = tokens.shift() ?? 'overview';
    const global = await this.getManager().getGlobalKB();
    if (command === 'overview' || command === '') {
      const stats = global.getStats();
      process.stdout.write(`\n${t.accent('Global Knowledge Base')}\n`);
      process.stdout.write(`  路径: ${t.dim(global.kbPath)}\n`);
      process.stdout.write(`  文件: ${stats.fileCount}  Chunks: ${stats.chunkCount}\n\n`);
      return;
    }
    if (command === 'search') {
      const query = tokens.join(' ');
      const results = await this.getManager().search(this.projectRoot, query, { scope: 'global', limit: 10 });
      for (const result of results.results) process.stdout.write(`  ${result.filePath}: ${result.content.slice(0, 120)}\n`);
      process.stdout.write('\n');
      return;
    }
    if (command === 'add') {
      const sourcePath = tokens[0];
      const targetPath = tokens[1];
      if (!sourcePath) {
        process.stdout.write(t.warning('用法: /kb global add <file> [target-relative-path]\n\n'));
        return;
      }
      const diff = await global.addFile(sourcePath, targetPath);
      process.stdout.write(t.success(`已添加到全局知识库: +${diff.newFiles.length} ~${diff.modifiedFiles.length}\n\n`));
      return;
    }
    if (command === 'remove') {
      const relativePath = tokens[0];
      if (!relativePath) {
        process.stdout.write(t.warning('用法: /kb global remove <relative-path>\n\n'));
        return;
      }
      await global.removeFile(relativePath);
      process.stdout.write(t.success(`已从全局知识库移除: ${relativePath}\n\n`));
      return;
    }
    process.stdout.write(t.warning(`未知 /kb global 命令: ${command}\n\n`));
  }

  private async daemon(command?: string): Promise<void> {
    if (command !== 'status') {
      process.stdout.write(t.warning('用法: /kb daemon status\n\n'));
      return;
    }
    const project = await this.getManager().getProject(this.projectRoot);
    process.stdout.write(`${t.success('SQLite vec ready')} ${t.dim(project.getVectorStatus().backend)}\n\n`);
  }

  private async config(): Promise<void> {
    const project = await this.getManager().getProject(this.projectRoot);
    process.stdout.write(`\n${t.accent('KB Config')}\n`);
    process.stdout.write(`  projectId: ${project.projectId ?? ''}\n`);
    process.stdout.write(`  kbPath: ${project.kbPath}\n`);
    const extractors = ExternalExtractorRegistry.fromEnvironment().listCapabilities();
    process.stdout.write('  externalExtractors:\n');
    if (extractors.length === 0) {
      process.stdout.write(t.dim('    未配置。可设置 CUSTOMIZE_AGENT_DWG_PARSER / CUSTOMIZE_AGENT_VISIO_PARSER / CUSTOMIZE_AGENT_SOLIDWORKS_PARSER 等环境变量。\n\n'));
      return;
    }
    for (const extractor of extractors) {
      process.stdout.write(`    ${extractor.name}: ${extractor.available ? 'available' : 'unavailable'}\n`);
    }
    process.stdout.write('\n');
  }

  private async dashboard(tokens: string[]): Promise<void> {
    if (this.dashboardUrl && tokens.length === 0) {
      const url = this.i18n?.t('kb.dash_url', { url: this.dashboardUrl }) ?? `Dashboard: ${this.dashboardUrl}`;
      const hint = this.i18n?.t('kb.dash_auto_started') ?? 'Dashboard was auto-started with the CLI.';
      process.stdout.write(t.success(`${url}\n`));
      process.stdout.write(t.dim(`${hint}\n\n`));
      return;
    }
    const port = tokens[0] ? Number(tokens[0]) : 17321;
    const url = this.i18n?.t('kb.dash_url', { url: `http://localhost:${port}` }) ?? `Dashboard: http://localhost:${port}`;
    const hint = this.i18n?.t('kb.dash_manual') ?? 'Start manually: cd apps/server && pnpm dev';
    process.stdout.write(t.success(`${url}\n`));
    process.stdout.write(t.dim(`${hint}\n\n`));
  }

  private extractScope(tokens: string[]): { scope: 'project' | 'global' | 'all'; rest: string[] } {
    const index = tokens.indexOf('--scope');
    if (index === -1) return { scope: 'all', rest: tokens };
    const value = tokens[index + 1];
    const scope = value === 'project' || value === 'global' || value === 'all' ? value : 'all';
    return { scope, rest: tokens.filter((_, i) => i !== index && i !== index + 1) };
  }

  private parse(args: string): string[] {
    return args.match(/"[^"]+"|'[^']+'|\S+/g)?.map(token => token.replace(/^['"]|['"]$/g, '')) ?? [];
  }
}
