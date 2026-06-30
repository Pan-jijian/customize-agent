import type { ConfigStore, ModelRegistry, ModelTier } from '@customize-agent/runtime';
import { resolveProtocol } from '@customize-agent/runtime';
import type { I18nManager } from '../i18n/manager.js';
import { t, s } from '../tui/renderer.js';

export interface ModelProviderCommandDeps {
  configStore: ConfigStore;
  modelRegistry: ModelRegistry;
  i18n: I18nManager;
  write?: (text: string) => void;
}

export class ModelProviderCommands {
  constructor(private deps: ModelProviderCommandDeps) {}

  handleModelCommand(args: string): boolean {
    if (!args) { this.showModelView(); return false; }
    const parts = args.split(/\s+/);
    const sub = parts[0]!;
    const rest = parts.slice(1);
    switch (sub) {
      case 'add': return this.addModel(rest);
      case 'set': return this.setActiveModel(rest);
      case 'rm': return this.removeModel(rest);
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
      if (r && r.name !== tc.active) {
        this.write(`    ${t.faint('→ ' + this.deps.i18n.t('model.fallback_label') + ' ' + r.name)}\n`);
      }
    }
    this.write('\n');
    this.write(`  ${t.dim(this.deps.i18n.t('model.quick_start'))}\n`);
    this.write(`  ${t.dim(this.deps.i18n.t('model.example_add'))}\n`);
    this.write(`  ${t.dim(this.deps.i18n.t('model.example_key'))}\n`);
    this.write(`  ${t.dim(this.deps.i18n.t('model.example_more'))}\n`);
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
      this.write(`  ${s.bold(name)}  ${t.dim('protocol: ' + proto)}  ${keyIcon}\n`);
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

  private addModel(rest: string[]): boolean {
    if (rest.length < 3) { this.write(t.warning(this.deps.i18n.t('model.add_usage') + '\n\n')); return false; }
    const tier = rest[0]! as ModelTier;
    if (!this.isTier(tier)) { this.write(t.error(this.deps.i18n.t('model.invalid_tier', { tier }) + '\n\n')); return false; }
    const prov = rest[1]!;
    const name = rest.slice(2).join(' ');
    this.deps.configStore.addModel(tier, { name, provider: prov });
    this.write(t.success(this.deps.i18n.t('model.added', { name, provider: prov, tier: this.deps.i18n.t('tier.' + tier) || tier }) + '\n\n'));
    return false;
  }

  private setActiveModel(rest: string[]): boolean {
    if (rest.length < 2) { this.write(t.warning(this.deps.i18n.t('model.set_usage') + '\n\n')); return false; }
    const tier = rest[0]! as ModelTier;
    if (!this.isTier(tier)) { this.write(t.error(this.deps.i18n.t('model.invalid_tier', { tier }) + '\n\n')); return false; }
    const name = rest.slice(1).join(' ');
    this.deps.configStore.setActiveModel(tier, name);
    this.write(t.success(this.deps.i18n.t('model.active_set', { tier: this.deps.i18n.t('tier.' + tier) || tier, name }) + '\n\n'));
    return false;
  }

  private removeModel(rest: string[]): boolean {
    if (rest.length < 2) { this.write(t.warning(this.deps.i18n.t('model.rm_usage') + '\n\n')); return false; }
    const tier = rest[0]! as ModelTier;
    if (!this.isTier(tier)) { this.write(t.error(this.deps.i18n.t('model.invalid_tier', { tier }) + '\n\n')); return false; }
    const name = rest.slice(1).join(' ');
    this.deps.configStore.removeModel(tier, name);
    this.write(t.success(this.deps.i18n.t('model.removed', { name, tier: this.deps.i18n.t('tier.' + tier) || tier }) + '\n\n'));
    return false;
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
