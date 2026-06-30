import type { I18nManager } from '../i18n/manager.js';

export interface ReplCommandInfo {
  name: string;
  desc: string;
}

export function buildDefaultCommands(i18n: I18nManager): ReplCommandInfo[] {
  return [
    { name: '/plan', desc: i18n.t('help.plan') },
    { name: '/rewind', desc: i18n.t('help.rewind') },
    { name: '/resume', desc: i18n.t('help.resume') },
    { name: '/clear', desc: i18n.t('help.clear') },
    { name: '/reset', desc: i18n.t('help.clear') },
    { name: '/sessions', desc: i18n.t('help.sessions') },
    { name: '/history', desc: i18n.t('help.sessions') },
    { name: '/model', desc: i18n.t('help.model') },
    { name: '/provider', desc: i18n.t('help.provider') },
    { name: '/memory', desc: i18n.t('help.memory') },
    { name: '/web', desc: i18n.t('help.web') },
    { name: '/export', desc: i18n.t('help.export') },
    { name: '/doctor', desc: i18n.t('help.doctor') },
    { name: '/checkpoint', desc: i18n.t('help.checkpoint') },
    { name: '/git', desc: i18n.t('help.git') },
    { name: '/test', desc: i18n.t('help.test') },
    { name: '/build', desc: i18n.t('help.build') },
    { name: '/lint', desc: i18n.t('help.lint') },
    { name: '/preview', desc: i18n.t('help.preview') },
    { name: '/file', desc: i18n.t('help.file') },
    { name: '/zip', desc: i18n.t('help.zip') },
    { name: '/repo', desc: i18n.t('help.repo') },
    { name: '/symbol', desc: i18n.t('help.symbol') },
    { name: '/deps', desc: i18n.t('help.deps') },
    { name: '/mcp', desc: i18n.t('help.mcp') },
    { name: '/plugin', desc: i18n.t('help.plugin') },
    { name: '/version', desc: i18n.t('help.version') },
    { name: '/language', desc: i18n.t('help.language') },
    { name: '/help', desc: i18n.t('help.help') },
    { name: '/exit', desc: i18n.t('help.exit') },
  ];
}
