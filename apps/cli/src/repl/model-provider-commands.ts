import type { ConfigStore, ModelRegistry, ModelTier } from '@customize-agent/runtime';
import { resolveProtocol } from '@customize-agent/runtime';
import type { I18nManager } from '../i18n/manager.js';
import { t, s } from '../tui/renderer.js';

export interface ModelProviderCommandDeps {
  configStore: ConfigStore;
  modelRegistry: ModelRegistry;
  i18n: I18nManager;
  write?: (text: string) => void;
  readLine?: (prompt: string) => Promise<string>;
  selectList?: <T>(title: string, items: Array<{ label: string; detail?: string; value: T }>) => Promise<T | null>;
}

const PROTOCOL_OPTIONS = [
  { label: 'OpenAI 兼容 (openai)', detail: 'OpenAI / DeepSeek / 等兼容 API', value: 'openai' as const },
  { label: 'Anthropic', detail: 'Claude 系列模型', value: 'anthropic' as const },
  { label: 'Google', detail: 'Gemini 系列模型', value: 'google' as const },
  { label: 'Ollama', detail: '本地 Ollama 服务', value: 'ollama' as const },
  { label: 'OpenRouter', detail: 'OpenRouter 聚合 API', value: 'openrouter' as const },
];

const TIER_OPTIONS: { label: string; detail: string; value: ModelTier }[] = [
  { label: 'Reader（只读）', detail: '读取文件、搜索等只读操作', value: 'reader' },
  { label: 'Reasoning（推理）', detail: '分析、规划等推理操作', value: 'reasoning' },
  { label: 'Action（操作）', detail: '写文件、执行命令等操作', value: 'action' },
];

export class ModelProviderCommands {
  constructor(private deps: ModelProviderCommandDeps) {}

  async handleModelCommand(args: string): Promise<boolean> {
    if (!args) { this.showModelView(); return false; }
    const parts = args.split(/\s+/);
    const sub = parts[0]!;
    const rest = parts.slice(1);

    switch (sub) {
      case 'add': {
        if (rest.length === 0) {
          await this.addModelInteractive();
        } else {
          this.addModelOneShot(rest);
        }
        return false;
      }
      case 'set': {
        if (rest.length === 0) {
          await this.setActiveModelInteractive();
        } else {
          this.setActiveModelOneShot(rest);
        }
        return false;
      }
      case 'rm': {
        if (rest.length === 0) {
          await this.removeModelInteractive();
        } else {
          this.removeModelOneShot(rest);
        }
        return false;
      }
      case 'key': return this.setModelProviderKey(rest);
      case 'fallback': this.showFallbackChains(); return false;
      default:
        this.write(t.warning(this.deps.i18n.t('model.unknown_subcmd', { sub }) + '\n\n'));
        return false;
    }
  }

  handleProviderCommand(args: string): boolean {
    if (!args) { this.showProviderList(); return false; }
    const parts = args.split(/\s+/);
    const sub = parts[0]!;
    const rest = parts.slice(1);
    switch (sub) {
      case 'key': {
        if (rest.length < 2) { this.write(t.warning(this.deps.i18n.t('provider.key_usage') + '\n\n')); return false; }
        this.deps.configStore.setProviderKey(rest[0]!, rest.slice(1).join(' ').trim());
        this.write(t.success(this.deps.i18n.t('provider.key_set', { name: rest[0]! }) + '\n\n'));
        return false;
      }
      case 'url': {
        if (rest.length < 2) { this.write(t.warning(this.deps.i18n.t('provider.url_usage') + '\n\n')); return false; }
        this.deps.configStore.setProviderUrl(rest[0]!, rest.slice(1).join(' '));
        this.write(t.success(this.deps.i18n.t('provider.url_set', { name: rest[0]! }) + '\n\n'));
        return false;
      }
      case 'protocol': {
        if (rest.length < 2) { this.write(t.warning(this.deps.i18n.t('provider.protocol_usage') + '\n\n')); return false; }
        this.deps.configStore.setProviderProtocol(rest[0]!, rest[1]!);
        this.write(t.success(this.deps.i18n.t('provider.protocol_set', { name: rest[0]!, protocol: rest[1]! }) + '\n\n'));
        return false;
      }
      default:
        this.write(t.warning(this.deps.i18n.t('provider.unknown_subcmd', { sub }) + '\n\n'));
        return false;
    }
  }

  // ── 交互式 /model add ──

  private async addModelInteractive(): Promise<void> {
    const readLine = this.deps.readLine;
    const selectList = this.deps.selectList;
    if (!readLine || !selectList) {
      this.write(t.warning(this.deps.i18n.t('model.interactive_not_supported') + '\n\n'));
      return;
    }

    this.write('\n' + s.bold(this.deps.i18n.t('model.add_wizard_title')) + '\n');
    this.write(t.dim(this.deps.i18n.t('model.add_wizard_desc')) + '\n\n');

    // 步骤 1：模型名称
    const modelName = await readLine(t.accent('① ' + this.deps.i18n.t('model.add_step_name') + ': '));
    if (!modelName.trim()) {
      this.write(t.warning(this.deps.i18n.t('model.add_cancelled') + '\n\n'));
      return;
    }

    // 步骤 2：API Key
    const apiKey = await readLine(t.accent('② ' + this.deps.i18n.t('model.add_step_key') + ': '));
    if (!apiKey.trim()) {
      this.write(t.warning(this.deps.i18n.t('model.add_cancelled') + '\n\n'));
      return;
    }

    // 步骤 3：Base URL（可选）
    const baseUrl = await readLine(t.accent('③ ' + this.deps.i18n.t('model.add_step_url') + ' ' + t.dim('(' + this.deps.i18n.t('model.optional') + ')') + ': '));

    // 步骤 4：协议选择面板
    const protocol = await selectList(
      this.deps.i18n.t('model.add_step_protocol'),
      PROTOCOL_OPTIONS,
    );
    if (!protocol) {
      this.write(t.warning(this.deps.i18n.t('model.add_cancelled') + '\n\n'));
      return;
    }

    // 步骤 5：层级选择面板
    const tier = await selectList(
      this.deps.i18n.t('model.add_step_tier'),
      TIER_OPTIONS,
    );
    if (!tier) {
      this.write(t.warning(this.deps.i18n.t('model.add_cancelled') + '\n\n'));
      return;
    }

    // 保存
    const providerName = modelName.trim();
    this.deps.configStore.ensureProvider(providerName);
    this.deps.configStore.setProviderKey(providerName, apiKey.trim());
    if (baseUrl.trim()) {
      this.deps.configStore.setProviderUrl(providerName, baseUrl.trim());
    }
    this.deps.configStore.setProviderProtocol(providerName, protocol);
    this.deps.configStore.addModel(tier, { name: providerName, provider: providerName });

    // 打印摘要
    const tierLabel = TIER_OPTIONS.find(o => o.value === tier)?.label || tier;
    const protoLabel = PROTOCOL_OPTIONS.find(o => o.value === protocol)?.label || protocol;
    this.write('\n' + s.bold(this.deps.i18n.t('model.add_summary')) + '\n');
    this.write(`  ${t.dim(this.deps.i18n.t('model.modelName'))}  ${s.bold(providerName)}\n`);
    this.write(`  ${t.dim(this.deps.i18n.t('models.apiKey'))}  ${apiKey.length > 10 ? apiKey.slice(0, 6) + '****' + apiKey.slice(-4) : '****'}\n`);
    this.write(`  ${t.dim(this.deps.i18n.t('models.baseUrl'))}  ${baseUrl.trim() || t.dim('(default)')}\n`);
    this.write(`  ${t.dim(this.deps.i18n.t('models.protocol'))}  ${protoLabel}\n`);
    this.write(`  ${t.dim(this.deps.i18n.t('model.add_tier_label'))}  ${tierLabel}\n`);
    this.write('\n' + t.success(this.deps.i18n.t('model.added', { name: providerName, provider: providerName, tier: tierLabel })) + '\n\n');
  }

  // ── 交互式 /model set ──

  private async setActiveModelInteractive(): Promise<void> {
    const selectList = this.deps.selectList;
    if (!selectList) {
      this.write(t.warning(this.deps.i18n.t('model.interactive_not_supported') + '\n\n'));
      return;
    }

    // 选择层级
    const tier = await selectList(
      this.deps.i18n.t('model.set_select_tier'),
      TIER_OPTIONS,
    );
    if (!tier) return;

    const cfg = this.deps.configStore.load();
    const tc = cfg.models[tier];

    if (tc.list.length === 0) {
      this.write(t.warning(this.deps.i18n.t('model.empty_tier', { tier }) + '\n\n'));
      return;
    }

    const modelOpts = tc.list.map(m => ({
      label: `${m.name} @${m.provider}`,
      detail: m.name === tc.active ? this.deps.i18n.t('model.current_active') : '',
      value: m.name,
    }));

    const selected = await selectList(
      this.deps.i18n.t('model.set_select_model'),
      modelOpts,
    );
    if (!selected) return;

    this.deps.configStore.setActiveModel(tier, selected);
    this.write(t.success(this.deps.i18n.t('model.active_set', { tier, name: selected }) + '\n\n'));
  }

  // ── 交互式 /model rm ──

  private async removeModelInteractive(): Promise<void> {
    const selectList = this.deps.selectList;
    if (!selectList) {
      this.write(t.warning(this.deps.i18n.t('model.interactive_not_supported') + '\n\n'));
      return;
    }

    // 选择层级
    const tier = await selectList(
      this.deps.i18n.t('model.rm_select_tier'),
      TIER_OPTIONS,
    );
    if (!tier) return;

    const cfg = this.deps.configStore.load();
    const tc = cfg.models[tier];

    if (tc.list.length === 0) {
      this.write(t.warning(this.deps.i18n.t('model.empty_tier', { tier }) + '\n\n'));
      return;
    }

    const modelOpts = tc.list.map(m => ({
      label: `${m.name} @${m.provider}`,
      detail: '',
      value: m.name,
    }));

    const selected = await selectList(
      this.deps.i18n.t('model.rm_select_model'),
      modelOpts,
    );
    if (!selected) return;

    this.deps.configStore.removeModel(tier, selected);
    this.write(t.success(this.deps.i18n.t('model.removed', { name: selected, tier }) + '\n\n'));
  }

  // ── 一键式命令（保留作为快捷方式） ──

  private addModelOneShot(rest: string[]): void {
    if (rest.length < 3) { this.write(t.warning(this.deps.i18n.t('model.add_usage') + '\n' + t.dim(this.deps.i18n.t('model.add_interactive_hint') + '\n\n'))); return; }
    const tier = rest[0]! as ModelTier;
    if (!this.isTier(tier)) { this.write(t.error(this.deps.i18n.t('model.invalid_tier', { tier }) + '\n\n')); return; }
    const prov = rest[1]!;
    const name = rest.slice(2).join(' ');
    this.deps.configStore.addModel(tier, { name, provider: prov });
    this.write(t.success(this.deps.i18n.t('model.added', { name, provider: prov, tier: this.deps.i18n.t('tier.' + tier) || tier }) + '\n\n'));
  }

  private setActiveModelOneShot(rest: string[]): void {
    if (rest.length < 2) { this.write(t.warning(this.deps.i18n.t('model.set_usage') + '\n' + t.dim(this.deps.i18n.t('model.set_interactive_hint') + '\n\n'))); return; }
    const tier = rest[0]! as ModelTier;
    if (!this.isTier(tier)) { this.write(t.error(this.deps.i18n.t('model.invalid_tier', { tier }) + '\n\n')); return; }
    const name = rest.slice(1).join(' ');
    this.deps.configStore.setActiveModel(tier, name);
    this.write(t.success(this.deps.i18n.t('model.active_set', { tier: this.deps.i18n.t('tier.' + tier) || tier, name }) + '\n\n'));
  }

  private removeModelOneShot(rest: string[]): void {
    if (rest.length < 2) { this.write(t.warning(this.deps.i18n.t('model.rm_usage') + '\n' + t.dim(this.deps.i18n.t('model.rm_interactive_hint') + '\n\n'))); return; }
    const tier = rest[0]! as ModelTier;
    if (!this.isTier(tier)) { this.write(t.error(this.deps.i18n.t('model.invalid_tier', { tier }) + '\n\n')); return; }
    const name = rest.slice(1).join(' ');
    this.deps.configStore.removeModel(tier, name);
    this.write(t.success(this.deps.i18n.t('model.removed', { name, tier: this.deps.i18n.t('tier.' + tier) || tier }) + '\n\n'));
  }

  // ── 视图 ──

  showModelView(): void {
    const cfg = this.deps.configStore.load();
    const tiers: ModelTier[] = ['reader', 'reasoning', 'action'];

    this.write('\n');
    for (const tier of tiers) {
      const tc = cfg.models[tier];
      const r = this.deps.modelRegistry.resolve(tier);
      const label = this.deps.i18n.t('tier.' + tier) || tier;
      const desc = this.deps.i18n.t('tier.' + tier + '_desc') || '';
      const icon = tier === 'reader' ? t.blue('◆') : tier === 'reasoning' ? t.purple('◆') : t.success('◆');
      this.write(`  ${icon} ${s.bold(label)}  ${t.faint(desc)}\n`);
      if (!tc.list.length) {
        this.write(`    ${t.faint(this.deps.i18n.t('model.empty'))}\n`);
      } else {
        for (const m of tc.list) {
          const mark = m.name === tc.active ? t.accent('▶') : ' ';
          const keyOk = cfg.providers[m.provider]?.apiKey ? t.success('🔑') : t.faint('🔒');
          this.write(`    ${mark} ${m.name}  ${t.dim('@' + m.provider)} ${keyOk}\n`);
        }
      }
      if (!tc.active && tc.list.length === 0) {
        this.write(`    ${t.faint(this.deps.i18n.t('model.not_configured'))}\n`);
      } else if (r && r.name !== tc.active) {
        this.write(`    ${t.faint('→ ' + this.deps.i18n.t('model.fallback_label') + ' ' + r.name)}\n`);
      }
    }
    this.write('\n');
    this.write(`  ${t.dim(this.deps.i18n.t('model.quick_start'))}\n`);
    this.write(`  ${t.accent('/model add')}  ${t.dim(this.deps.i18n.t('model.add_interactive_hint'))}\n`);
    this.write(`  ${t.accent('/model set')}   ${t.dim(this.deps.i18n.t('model.set_interactive_hint'))}\n`);
    this.write(`  ${t.accent('/model rm')}    ${t.dim(this.deps.i18n.t('model.rm_interactive_hint'))}\n`);
    this.write(`  ${t.accent('/model key')}   ${t.dim(this.deps.i18n.t('model.example_key'))}\n`);
    this.write('\n');
  }

  showProviderList(): void {
    const cfg = this.deps.configStore.load();
    const names = Object.keys(cfg.providers);
    if (!names.length) { this.write(t.dim(this.deps.i18n.t('provider.none') + '\n\n')); return; }
    this.write('\n');
    for (const name of names) {
      const p = cfg.providers[name]!;
      const proto = resolveProtocol(name, p);
      const keyIcon = p.apiKey ? t.success('🔑') : t.faint('🔒');
      const urlInfo = p.baseUrl ? t.dim(' | ' + p.baseUrl) : '';
      this.write(`  ${s.bold(name)}  ${t.dim('protocol: ' + proto)}  ${keyIcon}${urlInfo}\n`);
    }
    this.write(`\n  ${t.dim(this.deps.i18n.t('provider.hint'))}\n\n`);
  }

  showFallbackChains(): void {
    for (const tier of ['reader', 'reasoning', 'action'] as ModelTier[]) {
      const chain = this.deps.modelRegistry.getFallbackChain(tier);
      const parts = chain.map(c => `${c.model.name} ${t.dim('(' + this.deps.i18n.t('tier.' + c.from) + ')')}`);
      const sep = this.deps.i18n.t('model.chain_separator');
      this.write(`${s.bold(this.deps.i18n.t('tier.' + tier) || tier)}: ${parts.join(sep)}\n`);
    }
    this.write('\n');
  }

  private setModelProviderKey(rest: string[]): boolean {
    if (rest.length < 2) { this.write(t.warning(this.deps.i18n.t('model.key_usage') + '\n\n')); return false; }
    const prov = rest[0]!;
    const cleanKey = rest.slice(1).join(' ').trim();
    this.deps.configStore.setProviderKey(prov, cleanKey);
    const masked = cleanKey.length > 10 ? cleanKey.slice(0, 6) + '****' + cleanKey.slice(-4) : '****';
    this.write(t.success(this.deps.i18n.t('model.key_set', { provider: prov, masked }) + '\n\n'));
    return false;
  }

  private isTier(tier: string): tier is ModelTier {
    return ['reader', 'reasoning', 'action'].includes(tier);
  }

  private write(text: string): void {
    (this.deps.write ?? process.stdout.write.bind(process.stdout))(text);
  }
}
