// @customize-agent/cli — 引导/组装逻辑
import { createProvider } from '@customize-agent/llm';
import { PermissionEngine, ExecutionController, GoalManager, type GoalEvaluator } from '@customize-agent/engine';
import type { LSPManager } from '@customize-agent/search';
import { resolveProtocol, type ProviderConfig } from '@customize-agent/runtime';
import { SearchTools } from '@customize-agent/tools';
import { AgentExecutor } from './agent/executor.js';
import { buildRegistry, connectConfiguredMcp } from './agent/tool-registry.js';
import { createApprovalHandler } from './agent/approval.js';
import type { I18nManager } from './i18n/manager.js';

let _repoMap: string | null = null;

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
    const prompt = GoalManager.buildGoalCheckPrompt(context);
    const response = await provider.chat([
      { role: 'system', content: 'You are a strict task completion judge. Reply only with YES or NO followed by a concise reason.' },
      { role: 'user', content: prompt },
    ]);
    return GoalManager.parseGoalResponse(response.content);
  };
}

export async function createExecutor(
  projectRoot: string,
  i18n: I18nManager,
  providerName?: string,
  modelName?: string,
  providerConfig?: ProviderConfig,
  lspManager?: LSPManager,
): Promise<AgentExecutor> {
  const configuredProvider = providerName ?? 'deepseek';
  const factoryName = providerFactoryName(configuredProvider, providerConfig);
  const provider = createProvider(factoryName, {
    modelName,
    apiKey: providerConfig?.apiKey,
    baseUrl: providerConfig?.baseUrl,
  });
  const registry = buildRegistry({ root: projectRoot, lspManager, provider });
  await connectConfiguredMcp(registry, projectRoot);
  const permissionEngine = new PermissionEngine();
  const controller = new ExecutionController({ maxBudgetUsd: 5.0, deadLoopThreshold: 4, goalEvaluator: createGoalEvaluator(provider) });
  const approvalHandler = createApprovalHandler(i18n);

  if (_repoMap === null) _repoMap = await new SearchTools(projectRoot).repoMap();
  return new AgentExecutor({
    provider,
    registry,
    permissionEngine,
    controller,
    approvalHandler,
    i18n,
    projectRoot,
    repoMap: _repoMap,
  });
}
