import zh from './zh.js';
import en from './en.js';

export type Language = 'zh' | 'en';

const TRANSLATIONS: Record<Language, Record<string, string>> = { zh, en };

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
    let text = pack[key];
    if (text === undefined) {
      // 回退到中文
      text = TRANSLATIONS['zh'][key];
      if (text === undefined) return key;
    }
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replaceAll(`{${k}}`, v);
      }
    }
    return text;
  }

  /** 获取工具中文/英文名 */
  toolLabel(toolName: string): string {
    const key = `tool.${toolName}`;
    return this.t(key);
  }
}
