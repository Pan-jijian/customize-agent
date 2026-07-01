'use client';

import { useTheme } from 'next-themes';
import { useLocale, useTranslations } from 'next-intl';
import { Sun, Moon, Languages } from 'lucide-react';

export function Header() {
  const { theme, setTheme } = useTheme();
  const locale = useLocale();
  const t = useTranslations('settings');

  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');

  const toggleLocale = () => {
    const next = locale === 'zh-CN' ? 'en-US' : 'zh-CN';
    document.cookie = `NEXT_LOCALE=${next};path=/;max-age=31536000`;
    window.location.reload();
  };

  return (
    <header className="topbar">
      <div className="flex-1" />
      <button onClick={toggleTheme} className="topbarBtn">
        {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        <span>{theme === 'dark' ? t('light') : t('dark')}</span>
      </button>
      <button onClick={toggleLocale} className="topbarBtn">
        <Languages size={14} />
        <span>{locale === 'zh-CN' ? 'English' : '中文'}</span>
      </button>
    </header>
  );
}
