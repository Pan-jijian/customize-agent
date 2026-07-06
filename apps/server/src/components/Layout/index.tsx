'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import { ConfigProvider, App } from 'antd';
import { getAntdTheme } from '@/lib/antdTheme';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import zhMessages from '../../../messages/zh-CN.json';
import enMessages from '../../../messages/en-US.json';

type Messages = typeof zhMessages;
type TranslationKey = string;

interface LocaleContextValue {
  locale: string;
  setLocale: (locale: string) => void;
  messages: Messages;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function useAppLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useAppLocale must be used inside Layout');
  return ctx;
}

function readNested(messages: Messages, key: TranslationKey): string {
  const value = key.split('.').reduce<unknown>((current, part) => {
    if (current && typeof current === 'object' && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, messages);
  return typeof value === 'string' ? value : key;
}

export function useAppTranslations(namespace?: string) {
  const { messages } = useAppLocale();
  return useCallback((key: TranslationKey) => readNested(messages, namespace ? `${namespace}.${key}` : key), [messages, namespace]);
}

function resolveLocaleFromCookie(): string {
  if (typeof document === 'undefined') return 'zh-CN';
  const match = document.cookie.match(/NEXT_LOCALE=([^;]+)/);
  return match?.[1] || 'zh-CN';
}

const MESSAGES: Record<string, Messages> = {
  'zh-CN': zhMessages,
  'en-US': enMessages,
};

function LayoutShell({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme();
  const router = useRouter();
  const [locale, setLocaleState] = useState('zh-CN');
  const [transitioning, setTransitioning] = useState(false);
  const isDark = resolvedTheme === 'dark';
  const messages = MESSAGES[locale] ?? MESSAGES['zh-CN'];

  useEffect(() => {
    setLocaleState(resolveLocaleFromCookie());
  }, []);

  useEffect(() => {
    const start = () => setTransitioning(true);
    const done = () => setTransitioning(false);
    router.events.on('routeChangeStart', start);
    router.events.on('routeChangeComplete', done);
    router.events.on('routeChangeError', done);
    return () => {
      router.events.off('routeChangeStart', start);
      router.events.off('routeChangeComplete', done);
      router.events.off('routeChangeError', done);
    };
  }, [router]);

  const setLocale = useCallback((nextLocale: string) => {
    document.cookie = `NEXT_LOCALE=${nextLocale};path=/;max-age=31536000;samesite=lax`;
    setLocaleState(nextLocale);
  }, []);

  const localeContext = useMemo(() => ({ locale, setLocale, messages }), [locale, setLocale, messages]);
  const theme = useMemo(() => getAntdTheme(isDark), [isDark]);

  return (
    <LocaleContext.Provider value={localeContext}>
      <ConfigProvider theme={theme}>
        <App>
          <Head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /></Head>
          <Sidebar />
          <div className="mainContent">
            <Header />
            <main className={`mainInner${transitioning ? ' pageTransitioning' : ''}`}>
              {children}
            </main>
          </div>
        </App>
      </ConfigProvider>
    </LocaleContext.Provider>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <LayoutShell>{children}</LayoutShell>
    </NextThemesProvider>
  );
}
