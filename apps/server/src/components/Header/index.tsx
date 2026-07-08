'use client';

import { useTheme } from 'next-themes';
import { useAppLocale, useAppTranslations } from '@/components/Layout';
import { Sun, Moon, Languages } from 'lucide-react';

/** 顶部导航栏：主题切换与语言切换按钮 */
export function Header() {
  const { resolvedTheme, setTheme } = useTheme();
  const { locale, setLocale } = useAppLocale();
  const t = useAppTranslations('settings');
  const isDark = resolvedTheme === 'dark';

  const toggleTheme = () => setTheme(isDark ? 'light' : 'dark');

  const toggleLocale = () => {
    setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN');
  };

  return (
    <header className="topbar">
      <div className="flex-1" />
      <button onClick={toggleTheme} className="topbarBtn">
        {isDark ? <Sun size={14} /> : <Moon size={14} />}
        <span>{isDark ? t('light') : t('dark')}</span>
      </button>
      <button onClick={toggleLocale} className="topbarBtn">
        <Languages size={14} />
        <span>{locale === 'zh-CN' ? 'English' : '中文'}</span>
      </button>
    </header>
  );
}
