import { useTranslations, useLocale } from 'next-intl';
import { useTheme } from 'next-themes';
import { Card, Tag } from 'antd';
import { Sun, Moon, Monitor, Languages, Info } from 'lucide-react';
import styles from './style.module.scss';

export default function SettingsPage() {
  const t = useTranslations('settings');
  const { theme, setTheme } = useTheme();
  const locale = useLocale();

  const switchLocale = (next: string) => {
    document.cookie = `NEXT_LOCALE=${next};path=/;max-age=31536000`;
    window.location.reload();
  };

  const pill = (active: boolean) => `applePill${active ? ' applePillActive' : ''}`;

  return (
    <div className="space-y-5 max-w-2xl animateFadeIn">
      <div>
        <h1 className="pageTitle">{t('title')}</h1>
        <p className="pageDesc">{t('description')}</p>
      </div>

      <Card title={
        <div className="flex items-center gap-2">
          <div className={`statItemIcon ${styles.langIcon}`}><Languages size={16} /></div>
          <div><div className={`text-sm font-semibold ${styles.sectionTitle}`}>{t('language')}</div><div className={`text-xs ${styles.sectionDesc}`}>{t('languageDesc')}</div></div>
        </div>
      }>
        <div className="flex gap-2">
          <button className={pill(locale === 'zh-CN')} onClick={() => switchLocale('zh-CN')}>中文</button>
          <button className={pill(locale === 'en-US')} onClick={() => switchLocale('en-US')}>English</button>
        </div>
      </Card>

      <Card title={
        <div className="flex items-center gap-2">
          <div className="statItemIcon"><Monitor size={16} /></div>
          <div><div className={`text-sm font-semibold ${styles.sectionTitle}`}>{t('theme')}</div><div className={`text-xs ${styles.sectionDesc}`}>{t('themeDesc')}</div></div>
        </div>
      }>
        <div className="flex gap-2">
          <button className={pill(theme === 'light')} onClick={() => setTheme('light')}><Sun size={14} />{t('light')}</button>
          <button className={pill(theme === 'dark')} onClick={() => setTheme('dark')}><Moon size={14} />{t('dark')}</button>
          <button className={pill(theme === 'system')} onClick={() => setTheme('system')}><Monitor size={14} />{t('system')}</button>
        </div>
      </Card>

      <Card title={
        <div className="flex items-center gap-2">
          <div className="statItemIcon"><Info size={16} /></div>
          <span className={`text-sm font-semibold ${styles.sectionTitle}`}>{t('about')}</span>
        </div>
      }>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2"><span className={styles.metaText}>{t('version')}</span><Tag color="blue">v0.1.0</Tag></div>
          <div className="flex items-center gap-2"><span className={styles.metaText}>{t('port')}</span><span className={styles.metaValue}>17321</span></div>
        </div>
      </Card>
    </div>
  );
}
