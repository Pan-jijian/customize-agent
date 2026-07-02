#!/usr/bin/env node
// ↑ shebang — 必须保留。让操作系统知道用 Node.js 执行此文件，CLI 的 bin 入口依赖它。
import type { ChildProcess } from 'child_process';
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

function findDashboardServerDir(existsSync: (path: string) => boolean): string | null {
  const cliDir = import.meta.dirname!;
  const candidates = [
    resolve(cliDir, '../../../server'),
    resolve(cliDir, '../../../apps/server'),
    resolve(cliDir, '../../server'),
    resolve(process.cwd(), 'apps/server'),
  ];
  return candidates.find(dir => existsSync(resolve(dir, 'package.json'))) ?? null;
}

async function stopDashboardProcess(port: number, pid?: number): Promise<boolean> {
  const targetPid = pid ?? await findListeningPid(port);
  if (!targetPid || targetPid === process.pid) return false;
  try {
    process.kill(targetPid, 'SIGTERM');
  } catch {
    return false;
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${port}/api/health`);
    } catch {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

async function findListeningPid(port: number): Promise<number | undefined> {
  if (process.platform === 'win32') return undefined;
  const { execFile } = await import('child_process');
  return await new Promise(resolve => {
    execFile('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const pid = Number(stdout.trim().split('\n')[0]);
      resolve(Number.isFinite(pid) ? pid : undefined);
    });
  });
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
  const executorConfigKey = resolved ? JSON.stringify({ provider: resolved.provider, model: resolved.name, cfg: providerCfg ?? {} }) : undefined;
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
    const { existsSync, readFileSync: readRuntimeFileSync } = await import('fs');
    const isWin = process.platform === 'win32';
    const serverDir = findDashboardServerDir(existsSync);
    if (!serverDir) {
      kbStatus = `${kbStatus}\n   Dashboard: 未找到 Web 服务目录`;
      throw new Error('Dashboard server directory not found');
    }
    const nextBin = resolve(serverDir, 'node_modules', '.bin', isWin ? 'next.cmd' : 'next');
    const buildIdPath = resolve(serverDir, '.next', 'BUILD_ID');
    const routesManifestPath = resolve(serverDir, '.next', 'routes-manifest.json');
    const localBuildId = existsSync(buildIdPath) ? readRuntimeFileSync(buildIdPath, 'utf-8').trim() : '';
    const hasBuild = Boolean(localBuildId);
    const routesManifest = existsSync(routesManifestPath) ? readRuntimeFileSync(routesManifestPath, 'utf-8') : '';
    const hasConsoleRoutes = ['/overview', '/models', '/settings'].every(route =>
      routesManifest.includes(`"page":"${route}"`) || routesManifest.includes(`"page": "${route}"`),
    );

    if (!hasBuild || !hasConsoleRoutes) {
      kbStatus = `${kbStatus}\n   Dashboard: 未构建，请先运行 pnpm build`;
    } else {
      let portAvailable = false;
      let restartedStaleDashboard = false;
      let stopFailed = false;
      try {
        const res = await fetch(`http://localhost:${dashboardPort}/api/health`);
        if (res.ok) {
          const health = await res.json() as { buildId?: string | null; pid?: number };
          if (health.buildId === localBuildId) {
            dashboardUrl = `http://localhost:${dashboardPort}`;
          } else {
            restartedStaleDashboard = await stopDashboardProcess(dashboardPort, health.pid);
            portAvailable = restartedStaleDashboard;
            stopFailed = !restartedStaleDashboard;
          }
        }
      } catch {
        portAvailable = true;
      }

      if (!dashboardUrl && portAvailable) {
        let proc: ChildProcess | null = null;
        try {
          proc = spawn(nextBin, ['start', '-p', String(dashboardPort)], {
            cwd: serverDir,
            stdio: 'ignore',
            env: { ...process.env, NODE_ENV: 'production', CUSTOMIZE_PROJECT_ROOT: PROJECT_ROOT },
            shell: isWin,
            detached: true,
          });
          proc.unref();
        } catch { /* handled by health check below */ }

        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          try {
            const res = await fetch(`http://localhost:${dashboardPort}/api/health`);
            if (res.ok) {
              const health = await res.json() as { buildId?: string | null };
              if (health.buildId === localBuildId) {
                dashboardUrl = `http://localhost:${dashboardPort}`;
                break;
              }
            }
          } catch { /* wait for server */ }
          await new Promise(resolve => setTimeout(resolve, 300));
        }

        if (!dashboardUrl) {
          proc?.kill();
          kbStatus = `${kbStatus}\n   Dashboard: 启动超时`;
        }
      }

      if (dashboardUrl && restartedStaleDashboard) {
        kbStatus = `${kbStatus}\n   Dashboard: 已自动更新控制台服务`;
      } else if (stopFailed) {
        kbStatus = `${kbStatus}\n   Dashboard: 控制台正在更新，请关闭旧终端后重新打开`;
      }
    }
  } catch (error) {
    if ((error as Error).message !== 'Dashboard server directory not found') {
      kbStatus = `${kbStatus}\n   Dashboard 启动失败: ${(error as Error).message}`;
    }
  }

  const repl = new Repl({

    executor,
    projectRoot: PROJECT_ROOT,
    memory,
    i18n,
    configStore,
    modelRegistry,
    providerDisplay,
    executorConfigKey,
    createExecutor: (providerName, modelName, providerConfig) => createExecutor(PROJECT_ROOT, i18n, providerName, modelName, providerConfig, lsp),
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
