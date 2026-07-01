'use client';

import { useEffect, useState } from 'react';
import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';
import { ConfigProvider, App, Spin } from 'antd';
import { antdTheme } from '@/lib/antdTheme';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';

function resolveLocaleFromCookie(): string {
  if (typeof document === 'undefined') return 'zh-CN';
  const match = document.cookie.match(/NEXT_LOCALE=([^;]+)/);
  return match?.[1] || 'zh-CN';
}

async function loadMessages(locale: string): Promise<AbstractIntlMessages> {
  const mod = await import(`../../../messages/${locale}.json`);
  return mod.default || mod;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState('zh-CN');
  const [messages, setMessages] = useState<AbstractIntlMessages | null>(null);

  useEffect(() => {
    const loc = resolveLocaleFromCookie();
    setLocale(loc);
    void loadMessages(loc).then(setMessages);
  }, []);

  if (!messages) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <NextThemesProvider attribute="class" defaultTheme="light" enableSystem>
      <NextIntlClientProvider locale={locale} messages={messages}>
        <ConfigProvider theme={antdTheme}>
          <App>
            <Sidebar />
            <div className="mainContent">
              <Header />
              <main className="mainInner">{children}</main>
            </div>
          </App>
        </ConfigProvider>
      </NextIntlClientProvider>
    </NextThemesProvider>
  );
}
