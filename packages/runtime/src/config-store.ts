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
export interface ModelCapabilities {
  imageGeneration?: boolean;
  imageUnderstanding?: boolean;
  fileUnderstanding?: boolean;
  audio?: boolean;
  video?: boolean;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  /** 协议：空=自动推断, openai, anthropic, google */
  protocol?: string;
  directEndpoint?: boolean;
  capabilities?: ModelCapabilities;
}

export interface EmbeddingConfig {
  provider: 'openai-compatible' | 'transformers-local';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
}

export interface UserConfig {
  language: 'zh' | 'en';
  providers: Record<string, ProviderConfig>;
  models: ModelsConfig;
  embedding: EmbeddingConfig;
}

// ── 协议自动推断 ──

const PROTOCOL_MAP: Record<string, string> = {
  deepseek: 'openai', openai: 'openai', openrouter: 'openai', ollama: 'ollama',
  anthropic: 'anthropic', google: 'google', gemini: 'google',
};

export function detectProtocol(providerName: string): string {
  const normalized = providerName.toLowerCase();
  if (PROTOCOL_MAP[normalized]) return PROTOCOL_MAP[normalized];
  if (normalized.startsWith('gemini-') || normalized.includes('/gemini-')) return 'google';
  if (normalized.startsWith('claude-') || normalized.includes('/claude-')) return 'anthropic';
  if (normalized.startsWith('gpt-') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4')) return 'openai';
  return 'openai';
}

export function resolveProtocol(providerName: string, config?: ProviderConfig): string {
  return config?.protocol || detectProtocol(providerName);
}

// ── 默认值 ──

const EMPTY_TIER: TierConfig = { active: '', list: [] };
const DEFAULT_EMBEDDING: EmbeddingConfig = { provider: 'transformers-local', model: 'BAAI/bge-small-zh-v1.5', dimensions: 512 };
const DEFAULT_CONFIG: UserConfig = { language: 'zh', providers: {}, models: { reader: { ...EMPTY_TIER }, reasoning: { ...EMPTY_TIER }, action: { ...EMPTY_TIER } }, embedding: { ...DEFAULT_EMBEDDING } };

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
      this._cache = { ...DEFAULT_CONFIG, models: { reader: { ...EMPTY_TIER }, reasoning: { ...EMPTY_TIER }, action: { ...EMPTY_TIER } }, embedding: { ...DEFAULT_EMBEDDING } };
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

  setProviderDirectEndpoint(name: string, directEndpoint: boolean): UserConfig {
    const cfg = this.load();
    cfg.providers[name] = { ...cfg.providers[name], directEndpoint };
    return this.save(cfg);
  }

  setProviderCapabilities(name: string, capabilities: ModelCapabilities): UserConfig {
    const cfg = this.load();
    cfg.providers[name] = { ...cfg.providers[name], capabilities };
    return this.save(cfg);
  }

  getProvider(name: string): ProviderConfig | undefined {
    return this.load().providers[name];
  }

  getEmbedding(): EmbeddingConfig {
    return this.load().embedding;
  }

  setEmbedding(embedding: EmbeddingConfig): UserConfig {
    const cfg = this.load();
    cfg.embedding = embedding;
    return this.save(cfg);
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
      providers: this._pProviders(raw.providers),
      models: {
        reader: this._pTier((raw.models as Record<string, unknown>)?.reader),
        reasoning: this._pTier((raw.models as Record<string, unknown>)?.reasoning),
        action: this._pTier((raw.models as Record<string, unknown>)?.action),
      },
      embedding: this._pEmbedding(raw.embedding),
    };
  }

  private _pProviders(raw: unknown): Record<string, ProviderConfig> {
    if (!raw || typeof raw !== 'object') return {};
    const result: Record<string, ProviderConfig> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const provider = value as Record<string, unknown>;
      const capabilities = provider.capabilities && typeof provider.capabilities === 'object' ? provider.capabilities as Record<string, unknown> : {};
      result[name] = {
        apiKey: typeof provider.apiKey === 'string' ? provider.apiKey : undefined,
        baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : undefined,
        protocol: typeof provider.protocol === 'string' ? provider.protocol : undefined,
        directEndpoint: provider.directEndpoint === true,
        capabilities: {
          imageGeneration: capabilities.imageGeneration === true,
          imageUnderstanding: capabilities.imageUnderstanding === true,
          fileUnderstanding: capabilities.fileUnderstanding === true,
          audio: capabilities.audio === true,
          video: capabilities.video === true,
        },
      };
    }
    return result;
  }

  private _pTier(raw: unknown): TierConfig {
    if (!raw || typeof raw !== 'object') return { ...EMPTY_TIER };
    const r = raw as Record<string, unknown>;
    return {
      active: typeof r.active === 'string' ? r.active : '',
      list: Array.isArray(r.list) ? (r.list as Array<Record<string, unknown>>).filter(e => typeof e.name === 'string' && typeof e.provider === 'string').map(e => ({ name: e.name as string, provider: e.provider as string })) : [],
    };
  }

  private _pEmbedding(raw: unknown): EmbeddingConfig {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_EMBEDDING };
    const r = raw as Record<string, unknown>;
    const provider = r.provider === 'openai-compatible' ? 'openai-compatible' : 'transformers-local';
    return {
      provider,
      baseUrl: provider === 'openai-compatible' && typeof r.baseUrl === 'string' ? r.baseUrl : undefined,
      apiKey: provider === 'openai-compatible' && typeof r.apiKey === 'string' ? r.apiKey : undefined,
      model: provider === 'transformers-local' ? 'BAAI/bge-small-zh-v1.5' : typeof r.model === 'string' && r.model ? r.model : undefined,
      dimensions: provider === 'transformers-local' ? 512 : typeof r.dimensions === 'number' && Number.isFinite(r.dimensions) ? r.dimensions : undefined,
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
