import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── 类型 ──

export type ModelTier = 'reader' | 'reasoning' | 'action';

export interface ModelEntry {
  name: string;
  provider: string;
}

export interface TierConfig {
  active: string;
  list: ModelEntry[];
}

export interface ModelsConfig {
  reader: TierConfig;
  reasoning: TierConfig;
  action: TierConfig;
}

/** Provider 配置 */
export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  /** 协议：空=自动推断, openai, anthropic, google */
  protocol?: string;
}

export interface UserConfig {
  language: 'zh' | 'en';
  providers: Record<string, ProviderConfig>;
  models: ModelsConfig;
}

// ── 协议自动推断 ──

const PROTOCOL_MAP: Record<string, string> = {
  deepseek: 'openai', openai: 'openai', openrouter: 'openai', ollama: 'ollama',
  anthropic: 'anthropic', google: 'google',
};

export function detectProtocol(providerName: string): string {
  return PROTOCOL_MAP[providerName] ?? 'openai';
}

export function resolveProtocol(providerName: string, config?: ProviderConfig): string {
  return config?.protocol || detectProtocol(providerName);
}

// ── 默认值 ──

const EMPTY_TIER: TierConfig = { active: '', list: [] };
const DEFAULT_CONFIG: UserConfig = { language: 'zh', providers: {}, models: { reader: { ...EMPTY_TIER }, reasoning: { ...EMPTY_TIER }, action: { ...EMPTY_TIER } } };

// ── ConfigStore ──

export class ConfigStore {
  private filePath: string;
  private _cache: UserConfig | null = null;
  private _cacheMtimeMs = 0;

  constructor(storagePath?: string) {
    const dir = storagePath ?? path.join(os.homedir(), '.customize-agent');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'config.json');
  }

  load(): UserConfig {
    try {
      const stat = fs.existsSync(this.filePath) ? fs.statSync(this.filePath) : null;
      if (this._cache && stat && stat.mtimeMs === this._cacheMtimeMs) return this._cache;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this._cache = this._parse(JSON.parse(raw));
      this._cacheMtimeMs = stat?.mtimeMs ?? 0;
    } catch {
      this._cache = { language: 'zh', providers: {}, models: { reader: { ...EMPTY_TIER }, reasoning: { ...EMPTY_TIER }, action: { ...EMPTY_TIER } } };
      this.save(this._cache);
    }
    return this._cache;
  }

  save(partial: Partial<UserConfig>): UserConfig {
    const current = this._readCurrentForSave();
    const merged = { ...current, ...partial };
    fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2), 'utf-8');
    this._cache = merged;
    this._cacheMtimeMs = fs.statSync(this.filePath).mtimeMs;
    return merged;
  }

  get path(): string { return this.filePath; }

  setLanguage(lang: 'zh' | 'en'): UserConfig { const c = this.load(); c.language = lang; return this.save(c); }

  // ── Provider ──

  ensureProvider(name: string): ProviderConfig {
    const cfg = this.load();
    if (!cfg.providers[name]) {
      cfg.providers[name] = {};
      this.save(cfg);
    }
    return cfg.providers[name]!;
  }

  setProviderKey(name: string, apiKey: string): UserConfig {
    const cfg = this.load();
    cfg.providers[name] = { ...cfg.providers[name], apiKey };
    return this.save(cfg);
  }

  setProviderProtocol(name: string, protocol: string): UserConfig {
    const cfg = this.load();
    cfg.providers[name] = { ...cfg.providers[name], protocol };
    return this.save(cfg);
  }

  setProviderUrl(name: string, baseUrl: string): UserConfig {
    const cfg = this.load();
    cfg.providers[name] = { ...cfg.providers[name], baseUrl };
    return this.save(cfg);
  }

  getProvider(name: string): ProviderConfig | undefined {
    return this.load().providers[name];
  }

  // ── Model ──

  getTier(tier: ModelTier): TierConfig { return this.load().models[tier]; }

  setActiveModel(tier: ModelTier, name: string): UserConfig {
    const c = this.load(); c.models[tier].active = name; return this.save(c);
  }

  addModel(tier: ModelTier, entry: ModelEntry): UserConfig {
    const c = this.load(); const t = c.models[tier];
    if (!t.list.some(m => m.name === entry.name && m.provider === entry.provider)) t.list.push(entry);
    if (!t.active && t.list.length === 1) t.active = entry.name;
    this.ensureProvider(entry.provider);
    return this.save(c);
  }

  removeModel(tier: ModelTier, name: string): UserConfig {
    const c = this.load(); const t = c.models[tier];
    t.list = t.list.filter(m => m.name !== name);
    if (t.active === name) t.active = t.list[0]?.name ?? '';
    return this.save(c);
  }

  isFirstRun(): boolean {
    const c = this.load();
    return c.models.reader.list.length === 0 && c.models.reasoning.list.length === 0 && c.models.action.list.length === 0;
  }

  private _readCurrentForSave(): UserConfig {
    try {
      if (fs.existsSync(this.filePath)) {
        return this._parse(JSON.parse(fs.readFileSync(this.filePath, 'utf-8')));
      }
    } catch {
      return this._cache ?? DEFAULT_CONFIG;
    }
    return this._cache ?? DEFAULT_CONFIG;
  }

  private _parse(raw: Record<string, unknown>): UserConfig {
    return {
      language: (raw.language === 'zh' || raw.language === 'en') ? raw.language : 'zh',
      providers: typeof raw.providers === 'object' ? (raw.providers as Record<string, ProviderConfig>) : {},
      models: {
        reader: this._pTier((raw.models as Record<string, unknown>)?.reader),
        reasoning: this._pTier((raw.models as Record<string, unknown>)?.reasoning),
        action: this._pTier((raw.models as Record<string, unknown>)?.action),
      },
    };
  }

  private _pTier(raw: unknown): TierConfig {
    if (!raw || typeof raw !== 'object') return { ...EMPTY_TIER };
    const r = raw as Record<string, unknown>;
    return {
      active: typeof r.active === 'string' ? r.active : '',
      list: Array.isArray(r.list) ? (r.list as Array<Record<string, unknown>>).filter(e => typeof e.name === 'string' && typeof e.provider === 'string').map(e => ({ name: e.name as string, provider: e.provider as string })) : [],
    };
  }
}

// ── ModelRegistry ──

export class ModelRegistry {
  private config: ConfigStore;

  constructor(configStore: ConfigStore) { this.config = configStore; }

  resolve(tier: ModelTier): ModelEntry | null {
    const c = this.config.load();
    const entry = this._r(c.models[tier]);
    if (entry) return entry;
    for (const fb of ['reasoning', 'action', 'reader'] as ModelTier[]) {
      if (fb === tier) continue;
      const e = this._r(c.models[fb]);
      if (e) return e;
    }
    return null;
  }

  resolveAll(): Record<ModelTier, ModelEntry | null> {
    return { reader: this.resolve('reader'), reasoning: this.resolve('reasoning'), action: this.resolve('action') };
  }

  getFallbackChain(tier: ModelTier): { model: ModelEntry; from: ModelTier }[] {
    const c = this.config.load();
    const d = this._r(c.models[tier]);
    if (d) return [{ model: d, from: tier }];
    for (const fb of ['reasoning', 'action', 'reader'] as ModelTier[]) {
      if (fb === tier) continue;
      const e = this._r(c.models[fb]);
      if (e) return [{ model: e, from: fb }];
    }
    return [];
  }

  private _r(t: TierConfig): ModelEntry | null {
    if (!t.list.length) return null;
    return t.list.find(m => m.name === t.active) ?? t.list[0] ?? null;
  }
}
