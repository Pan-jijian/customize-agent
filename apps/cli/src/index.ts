import { Command } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { readdirSync, statSync } from 'fs';
import { createProvider } from '@customize-agent/llm';
import { PermissionEngine, ExecutionController, type GoalEvaluator } from '@customize-agent/engine';
import { LSPManager } from '@customize-agent/search';
import { MemoryManager } from '@customize-agent/memory';
import { ConfigStore, ModelRegistry, resolveProtocol, type ProviderConfig } from '@customize-agent/runtime';
import { AgentExecutor } from './agent/executor.js';
import { buildRegistry, connectConfiguredMcp } from './agent/tool-registry.js';
import { Repl } from './repl/repl.js';
import { t, s, renderMarkdown } from './tui/renderer.js';
import { type Message } from '@customize-agent/types';
import { I18nManager } from './i18n/manager.js';
import * as readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(__filename), '../../..');

const program = new Command();
const configStore = new ConfigStore();

function _generateRepoMap(): string {
  const ignore = new Set(['node_modules', 'dist', '.git', '.DS_Store', '__pycache__', 'target']);
  const lines: string[] = [];
  let count = 0;
  const max = 200;

  function walk(dir: string, prefix: string): void {
    if (count >= max) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter(e => !e.startsWith('.') && !ignore.has(e)).sort();
    } catch {
      return;
    }
    for (let i = 0; i < entries.length && count < max; i++) {
      const e = entries[i]!;
      const full = join(dir, e);
      try {
        if (statSync(full).isDirectory()) {
          lines.push(`${prefix}${i === entries.length - 1 ? '└── ' : '├── '}${e}/`);
          count++;
          walk(full, prefix + (i === entries.length - 1 ? '    ' : '│   '));
        }
      } catch { /* skip */ }
    }
  }

  const top = readdirSync(PROJECT_ROOT).filter(e => !e.startsWith('.') && !ignore.has(e)).sort();
  for (const e of top) {
    if (count >= max) break;
    try {
      const full = join(PROJECT_ROOT, e);
      if (statSync(full).isDirectory()) {
        lines.push(`${e}/`);
        count++;
        walk(full, '    ');
      } else {
        lines.push(e);
        count++;
      }
    } catch { /* skip */ }
  }
  return lines.join('\n');
}

let _repoMap: string | null = null;
let i18n: I18nManager;
let keypressInitialized = false;

function providerFactoryName(providerName: string, providerConfig?: ProviderConfig): string {
  const protocol = resolveProtocol(providerName, providerConfig);
  if (protocol === 'anthropic') return 'anthropic';
  if (protocol === 'google') return 'google';
  if (protocol === 'openai') {
    return ['deepseek', 'openai', 'openrouter', 'ollama'].includes(providerName) ? providerName : 'openai';
  }
  return providerName;
}

function createGoalEvaluator(provider: ReturnType<typeof createProvider>): GoalEvaluator {
  return async context => {
    const prompt = new ExecutionController().goalDetector.buildGoalCheckPrompt(context);
    const response = await provider.chat([
      { role: 'system', content: 'You are a strict task completion judge. Reply only with YES or NO followed by a concise reason.' },
      { role: 'user', content: prompt },
    ]);
    return new ExecutionController().goalDetector.parseGoalResponse(response.content);
  };
}

function createApprovalHandler() {
  return async (toolName: string, args: Record<string, unknown>) => {
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

    if (!keypressInitialized) {
      readline.emitKeypressEvents(process.stdin);
      keypressInitialized = true;
    }

    return new Promise<boolean>(resolve => {
      let raw = false;
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(true); raw = true; } catch { /* ignore */ }
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
      const cleanup = () => {
        clear();
        process.stdout.write(`\x1b[${approvalLines.length}A\r\x1b[0J`);
        process.stdin.removeListener('keypress', onKeypress);
        if (raw) try { process.stdin.setRawMode(false); } catch { /* ignore */ }
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
      draw();
    });
  };
}

async function createExecutor(providerName?: string, modelName?: string, providerConfig?: ProviderConfig, lspManager?: LSPManager) {
  const configuredProvider = providerName ?? 'deepseek';
  const factoryName = providerFactoryName(configuredProvider, providerConfig);
  const provider = createProvider(factoryName, {
    modelName,
    apiKey: providerConfig?.apiKey,
    baseUrl: providerConfig?.baseUrl,
  });
  const registry = buildRegistry({ root: PROJECT_ROOT, lspManager, provider });
  await connectConfiguredMcp(registry, PROJECT_ROOT);
  const permissionEngine = new PermissionEngine();
  const controller = new ExecutionController({ maxBudgetUsd: 5.0, deadLoopThreshold: 4, goalEvaluator: createGoalEvaluator(provider) });
  const approvalHandler = createApprovalHandler();

  if (_repoMap === null) _repoMap = _generateRepoMap();
  return new AgentExecutor({
    provider,
    registry,
    permissionEngine,
    controller,
    approvalHandler,
    i18n,
    projectRoot: PROJECT_ROOT,
    repoMap: _repoMap,
  });
}

program
  .name('customize-agent')
  .description('Customize Agent v0.0.3 — interactive REPL')
  .option('-p, --prompt <text>', 'Single-shot execution mode')
  .option('--plan', 'Plan mode: read-only exploration (requires -p)');

program.action(async () => {
  const opts = program.opts();
  const modelRegistry = new ModelRegistry(configStore);
  const config = configStore.load();

  i18n = new I18nManager(config.language);

  if (opts.prompt) {
    const resolved = modelRegistry.resolve('action');
    if (!resolved) {
      console.log(`\n${i18n.t('cmd.no_model_configured')}`);
      console.log(i18n.t('cmd.first_config'));
      return;
    }
    const pCfg = configStore.getProvider(resolved.provider);
    const lsp = new LSPManager(PROJECT_ROOT);
    const executor = await createExecutor(resolved.provider, resolved.name, pCfg, lsp);

    const history: Message[] = [{ role: 'system', content: executor.getSystemPrompt() }];

    if (opts.plan) {
      history.push({
        role: 'user',
        content: `Create an execution plan for the following task. Read-only exploration. Do not modify any files.\n\nTask: ${opts.prompt}\n\nOutput the plan.`,
      });
      console.log(`\n📋 ${i18n.t('plan.banner')} [${executor.providerName}]`);
    } else {
      history.push({ role: 'user', content: opts.prompt });
      console.log(`\n🚀 Customize Agent v0.0.3 [${executor.providerName}]`);
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
    ? await createExecutor(resolved.provider, resolved.name, providerCfg, lsp)
    : await createExecutor(undefined, undefined, undefined, lsp);

  const memory = new MemoryManager();
  const repl = new Repl({
    executor,
    projectRoot: PROJECT_ROOT,
    memory,
    i18n,
    configStore,
    modelRegistry,
    providerDisplay,
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
    const registry = buildRegistry({ root: PROJECT_ROOT });
    const server = new McpServer(registry, 'customize-agent', '0.0.3');
    await server.start();
  });

program.parse();
