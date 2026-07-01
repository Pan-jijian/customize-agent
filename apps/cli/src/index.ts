#!/usr/bin/env node
// ↑ shebang — 必须保留。让操作系统知道用 Node.js 执行此文件，CLI 的 bin 入口依赖它。
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { LSPManager } from '@customize-agent/search';
import { MemoryManager } from '@customize-agent/memory';
import { ensureProjectCustomizeFile, MultiProjectManager } from '@customize-agent/knowledge';
import { ConfigStore, ModelRegistry } from '@customize-agent/runtime';
import { createExecutor } from './bootstrap.js';
import { Repl } from './repl/repl.js';
import { t, renderMarkdown } from './tui/renderer.js';
import { type Message } from '@customize-agent/types';
import { I18nManager } from './i18n/manager.js';

function resolveUserProjectRoot(): string {
  return resolve(process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD ?? process.env.PWD ?? process.cwd());
}

const PROJECT_ROOT = resolveUserProjectRoot();
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

async function ensureProjectWorkspace(projectRoot: string): Promise<void> {
  ensureProjectCustomizeFile(projectRoot);
  const manager = new MultiProjectManager();
  try {
    await manager.getProject(projectRoot);
  } finally {
    await manager.shutdown();
  }
}

const program = new Command();
const configStore = new ConfigStore();

program
  .name('customize')
  .description(`Customize Agent v${pkg.version} — interactive REPL`)
  .option('-p, --prompt <text>', 'Single-shot execution mode')
  .option('--plan', 'Plan mode: read-only exploration (requires -p)');

program.action(async () => {
  await ensureProjectWorkspace(PROJECT_ROOT);
  const opts = program.opts();
  const modelRegistry = new ModelRegistry(configStore);
  const config = configStore.load();
  const i18n = new I18nManager(config.language);

  if (opts.prompt) {
    const resolved = modelRegistry.resolve('action');
    if (!resolved) {
      console.log(`\n${i18n.t('cmd.no_model_configured')}`);
      console.log(i18n.t('cmd.first_config'));
      return;
    }
    const pCfg = configStore.getProvider(resolved.provider);
    const lsp = new LSPManager(PROJECT_ROOT);
    const executor = await createExecutor(PROJECT_ROOT, i18n, resolved.provider, resolved.name, pCfg, lsp);

    const history: Message[] = [{ role: 'system', content: executor.getSystemPrompt() }];

    if (opts.plan) {
      history.push({
        role: 'user',
        content: `Create an execution plan for the following task. Read-only exploration. Do not modify any files.\n\nTask: ${opts.prompt}\n\nOutput the plan.`,
      });
      console.log(`\n📋 ${i18n.t('plan.banner')} [${executor.providerName}]`);
    } else {
      history.push({ role: 'user', content: opts.prompt });
      console.log(`\n🚀 Customize Agent v${pkg.version} [${executor.providerName}]`);
    }
    console.log(`   Task: "${opts.prompt}"`);

    try {
      const updated = await executor.runTask(history, { plan: opts.plan ?? false, readonly: opts.plan ?? false });
      const lastAssistant = [...updated].reverse().find(m => m.role === 'assistant');
      if (lastAssistant) {
        const cleanContent = lastAssistant.content.trim();
        process.stdout.write('\n' + t.purple('📋 Result:') + '\n');
        process.stdout.write(renderMarkdown(cleanContent) + '\n');
      }
    } catch (err) {
      console.log(`\n${i18n.t('error.execution')} ${(err as Error).message}`);
    }
    return;
  }

  const lsp = new LSPManager(PROJECT_ROOT);
  const resolved = modelRegistry.resolve('action');
  const providerDisplay = resolved ? `${resolved.provider}/${resolved.name}` : i18n.t('welcome.no_model');
  const providerCfg = resolved ? configStore.getProvider(resolved.provider) : undefined;
  const executor = resolved
    ? await createExecutor(PROJECT_ROOT, i18n, resolved.provider, resolved.name, providerCfg, lsp)
    : await createExecutor(PROJECT_ROOT, i18n, undefined, undefined, undefined, lsp);

  const memory = new MemoryManager();
  const kbManager = new MultiProjectManager();
  let kbStatus = '已初始化';
  try {
    const projectKb = await kbManager.getProject(PROJECT_ROOT);
    await projectKb.incrementalIndex();
    await kbManager.getGlobalKB();
  } catch (error) {
    kbStatus = `初始化失败: ${(error as Error).message}`;
  }
  let dashboardUrl: string | undefined;
  const dashboardPort = 17321;
  try {
    const { spawn } = await import('child_process');
    const { existsSync } = await import('fs');
    const isWin = process.platform === 'win32';
    const serverDir = resolve(import.meta.dirname!, '../../../apps/customize-agent-server');
    const nextBin = resolve(serverDir, 'node_modules', '.bin', isWin ? 'next.cmd' : 'next');
    const hasBuild = existsSync(resolve(serverDir, '.next', 'BUILD_ID'));

    if (!hasBuild) {
      kbStatus = `${kbStatus}\n   Dashboard: 未构建，请先运行 pnpm build`;
    } else {
      // 检测是否已有服务在运行 → 直接复用，避免多实例端口冲突
      let alreadyRunning = false;
      try {
        const res = await fetch(`http://localhost:${dashboardPort}/api/health`);
        if (res.ok) alreadyRunning = true;
      } catch { /* 端口空闲，需要启动 */ }

      if (alreadyRunning) {
        dashboardUrl = `http://localhost:${dashboardPort}`;
      } else {
        const proc = spawn(nextBin, ['start', '-p', String(dashboardPort)], {
          cwd: serverDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NODE_ENV: 'production' },
          shell: isWin,
        });
        proc.on('error', () => { /* 静默处理 */ });

        let stderrBuf = '';
        const ready = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 10000);
          const check = (data: string) => {
            if (data.includes('Ready')) { clearTimeout(timeout); resolve(true); }
          };
          proc.stdout?.on('data', (d: Buffer) => check(d.toString()));
          proc.stderr?.on('data', (d: Buffer) => {
            const s = d.toString();
            stderrBuf += s;
            check(s);
          });
          proc.once('close', () => { clearTimeout(timeout); resolve(false); });
        });

        // EADDRINUSE → 另一个实例刚好抢先启动了，复用即可
        if (!ready && stderrBuf.includes('EADDRINUSE')) {
          proc.kill();
          dashboardUrl = `http://localhost:${dashboardPort}`;
        } else if (ready) {
          dashboardUrl = `http://localhost:${dashboardPort}`;
        } else {
          dashboardUrl = `http://localhost:${dashboardPort}`;
        }
      }
    }
  } catch (error) {
    kbStatus = `${kbStatus}\n   Dashboard 启动失败: ${(error as Error).message}`;
  }

  const repl = new Repl({

    executor,
    projectRoot: PROJECT_ROOT,
    memory,
    i18n,
    configStore,
    modelRegistry,
    providerDisplay,
    kbManager,
    dashboardUrl,
    kbStatus,
  });

  await repl.start();
});

program
  .command('mcp-server')
  .description('Start MCP Server (stdio JSON-RPC)')
  .action(async () => {
    const i18nMcp = new I18nManager(configStore.load().language);
    const { McpServer } = await import('@customize-agent/engine');
    console.error(i18nMcp.t('cli.mcp_server_start'));
    const { buildRegistry } = await import('./agent/tool-registry.js');
    const registry = buildRegistry({ root: PROJECT_ROOT });
    const server = new McpServer(registry, 'customize-agent', pkg.version);
    await server.start();
  });

program.parse();
