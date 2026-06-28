import zh from './zh.js';
import en from './en.js';

export type Language = 'zh' | 'en';

const TRANSLATIONS: Record<Language, Record<string, string | string[]>> = { zh, en };

/**
 * 国际化管理器。
 *
 * 使用方式:
 *   const i18n = new I18nManager('zh');
 *   i18n.t('tool.read_file')  // → "读取文件"
 *   i18n.t('cmd.unknown', { cmd: '/foo' }) // → "未知命令: /foo"
 */
export class I18nManager {
  private _lang: Language;

  constructor(lang: Language = 'zh') {
    this._lang = lang;
  }

  get language(): Language { return this._lang; }

  /** 切换语言 */
  setLanguage(lang: Language): void {
    this._lang = lang;
  }

  /**
   * 获取翻译文本。
   * @param key 翻译键
   * @param params 插值参数 {k:v} — 替换文本中的 {k}
   */
  t(key: string, params?: Record<string, string>): string {
    const pack = TRANSLATIONS[this._lang];
    const val = pack[key];
    if (typeof val !== 'string') {
      // 回退到中文
      const zhVal = TRANSLATIONS['zh'][key];
      if (typeof zhVal === 'string') {
        return this._interpolate(zhVal, params);
      }
      return key;
    }
    return this._interpolate(val, params);
  }

  private _interpolate(text: string, params?: Record<string, string>): string {
    if (!params) return text;
    let result = text;
    for (const [k, v] of Object.entries(params)) {
      result = result.replaceAll(`{${k}}`, v);
    }
    return result;
  }

  /** 获取字符串数组类型翻译（如 tips 池） */
  tList(key: string): string[] {
    const pack = TRANSLATIONS[this._lang];
    const val = pack[key];
    if (Array.isArray(val)) return val;
    // fallback to zh
    const zhVal = TRANSLATIONS['zh'][key];
    if (Array.isArray(zhVal)) return zhVal;
    return [];
  }

  /** 获取工具中文/英文名 */
  toolLabel(toolName: string): string {
    const key = `tool.${toolName}`;
    return this.t(key);
  }
}
