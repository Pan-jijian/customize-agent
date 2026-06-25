import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── 模型三层架构类型 ──

/** 模型层级 */
export type ModelTier = 'reader' | 'reasoning' | 'action';

/** 单个模型条目 */
export interface ModelEntry {
  /** 模型名称（如 gpt-5.3-codex, deepseek-v4-flash） */
  name: string;
  /** 提供商（deepseek | openai | anthropic | google | openrouter | ollama） */
  provider: string;
  /** API Key（可选，优先于环境变量） */
  apiKey?: string;
}

/** 每层模型的配置 */
export interface TierConfig {
  /** 当前激活的模型名（空串 = 未设置，触发回退） */
  active: string;
  /** 该层可用的模型列表 */
  list: ModelEntry[];
}

/** 所有层模型配置 */
export interface ModelsConfig {
  reader: TierConfig;
  reasoning: TierConfig;
  action: TierConfig;
}

/** 用户持久化配置结构 */
export interface UserConfig {
  /** 界面语言 (zh | en) */
  language: 'zh' | 'en';
  /** 三级模型配置 */
  models: ModelsConfig;
}

const EMPTY_TIER: TierConfig = { active: '', list: [] };

const DEFAULT_CONFIG: UserConfig = {
  language: 'zh',
  models: {
    reader: { ...EMPTY_TIER },
    reasoning: { ...EMPTY_TIER },
    action: { ...EMPTY_TIER },
  },
};

/**
 * 用户配置持久化存储。
 *
 * 路径: ~/.customize-agent/config.json
 *
 * 模型三层架构:
 *   reader      — 只读操作（读文件、搜索符号、浏览代码）
 *   reasoning   — 分析推理（整合信息、制定修改方案）
 *   action      — 执行操作（修改文件、执行命令）
 *
 * 回退规则: 缺层时按 reasoning → action → reader 优先级继承
 */
export class ConfigStore {
  private filePath: string;
  private _cache: UserConfig | null = null;

  constructor(storagePath?: string) {
    const dir = storagePath ?? path.join(os.homedir(), '.customize-agent');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'config.json');
  }

  /** 读取配置（优先缓存） */
  load(): UserConfig {
    if (this._cache) return this._cache;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<{ language: string; models: Partial<ModelsConfig> }>;
      this._cache = {
        language: (parsed.language === 'zh' || parsed.language === 'en') ? parsed.language : DEFAULT_CONFIG.language,
        models: {
          reader: this._parseTier(parsed.models?.reader),
          reasoning: this._parseTier(parsed.models?.reasoning),
          action: this._parseTier(parsed.models?.action),
        },
      };
    } catch {
      this._cache = {
        language: DEFAULT_CONFIG.language,
        models: {
          reader: { ...EMPTY_TIER },
          reasoning: { ...EMPTY_TIER },
          action: { ...EMPTY_TIER },
        },
      };
      this.save(this._cache);
    }
    return this._cache;
  }

  /** 写入配置 */
  save(config: Partial<UserConfig>): UserConfig {
    const merged = { ...(this._cache ?? DEFAULT_CONFIG), ...config };
    fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2), 'utf-8');
    this._cache = merged;
    return merged;
  }

  /** 获取单个字段 */
  get<K extends keyof UserConfig>(key: K): UserConfig[K] {
    return this.load()[key];
  }

  /** 设置单个字段 */
  set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): UserConfig {
    return this.save({ [key]: value });
  }

  /** 文件路径 */
  get path(): string { return this.filePath; }

  // ── 模型层操作 ──

  /** 获取指定层的模型列表 */
  getTier(tier: ModelTier): TierConfig {
    return this.load().models[tier];
  }

  /** 设置指定层当前激活模型 */
  setActiveModel(tier: ModelTier, name: string): UserConfig {
    const config = this.load();
    config.models[tier].active = name;
    return this.save(config);
  }

  /** 添加模型到指定层 */
  addModel(tier: ModelTier, entry: ModelEntry): UserConfig {
    const config = this.load();
    const tierConfig = config.models[tier];
    // 去重：同名同 provider 不重复添加
    if (!tierConfig.list.some(m => m.name === entry.name && m.provider === entry.provider)) {
      tierConfig.list.push(entry);
    }
    // 如果是该层第一个模型，自动设为 active
    if (!tierConfig.active && tierConfig.list.length === 1) {
      tierConfig.active = entry.name;
    }
    return this.save(config);
  }

  /** 设置指定层某个模型的 API Key */
  setModelKey(tier: ModelTier, name: string, apiKey: string): UserConfig {
    const config = this.load();
    const tierConfig = config.models[tier];
    const model = tierConfig.list.find(m => m.name === name);
    if (!model) throw new Error(`Model "${name}" not found in ${tier}`);
    model.apiKey = apiKey || undefined;
    return this.save(config);
  }

  /** 从指定层移除模型 */
  removeModel(tier: ModelTier, name: string): UserConfig {
    const config = this.load();
    const tierConfig = config.models[tier];
    tierConfig.list = tierConfig.list.filter(m => m.name !== name);
    // 如果移除的是当前激活模型，清空 active
    if (tierConfig.active === name) {
      tierConfig.active = tierConfig.list[0]?.name ?? '';
    }
    return this.save(config);
  }

  /** 判断是否首次运行（三层全空） */
  isFirstRun(): boolean {
    const config = this.load();
    return config.models.reader.list.length === 0
        && config.models.reasoning.list.length === 0
        && config.models.action.list.length === 0;
  }

  // ── 私有 ──

  private _parseTier(raw: Partial<TierConfig> | undefined): TierConfig {
    if (!raw || !Array.isArray(raw.list)) return { ...EMPTY_TIER };
    return {
      active: typeof raw.active === 'string' ? raw.active : '',
      list: raw.list.filter(e => typeof e.name === 'string' && typeof e.provider === 'string'),
    };
  }
}

/**
 * 模型注册中心 — 根据分层架构解析各层实际使用的模型。
 *
 * 回退规则:
 *   1. 该层 list 非空 + active 已在 list 中 → 直接使用
 *   2. 该层 list 非空 + active 不在 list 中 → 用 list[0]
 *   3. 该层 list 为空 → 按 reasoning → action → reader 顺序查找有模型的层
 *   4. 所有层空 → 返回 null
 */
export class ModelRegistry {
  private config: ConfigStore;

  constructor(configStore: ConfigStore) {
    this.config = configStore;
  }

  /** 获取指定层最终使用的 ModelEntry（含回退） */
  resolve(tier: ModelTier): ModelEntry | null {
    const config = this.config.load();
    const tierConfig = config.models[tier];

    // 查找最佳候选
    const entry = this._resolveTier(tierConfig);
    if (entry) return entry;

    // 回退: reasoning > action > reader
    const fallbackOrder: ModelTier[] = ['reasoning', 'action', 'reader'];
    for (const fb of fallbackOrder) {
      if (fb === tier) continue;
      const fbEntry = this._resolveTier(config.models[fb]);
      if (fbEntry) return fbEntry;
    }

    return null;
  }

  /** 获取当前三层 resolve 结果 */
  resolveAll(): Record<ModelTier, ModelEntry | null> {
    return {
      reader: this.resolve('reader'),
      reasoning: this.resolve('reasoning'),
      action: this.resolve('action'),
    };
  }

  /** 获取回退路径描述（调试/展示用） */
  getFallbackChain(tier: ModelTier): { model: ModelEntry; from: ModelTier }[] {
    const result: { model: ModelEntry; from: ModelTier }[] = [];
    const config = this.config.load();
    const tierConfig = config.models[tier];

    const direct = this._resolveTier(tierConfig);
    if (direct) {
      result.push({ model: direct, from: tier });
      return result;
    }

    const fallbackOrder: ModelTier[] = ['reasoning', 'action', 'reader'];
    for (const fb of fallbackOrder) {
      if (fb === tier) continue;
      const fbEntry = this._resolveTier(config.models[fb]);
      if (fbEntry) {
        result.push({ model: fbEntry, from: fb });
        return result;
      }
    }

    return result;
  }

  private _resolveTier(tier: TierConfig): ModelEntry | null {
    if (tier.list.length === 0) return null;
    const active = tier.list.find(m => m.name === tier.active);
    if (active) return active;
    return tier.list[0] ?? null;
  }
}
