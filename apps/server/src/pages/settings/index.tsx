import { useEffect, useState } from 'react';
import { useAppLocale, useAppTranslations } from '@/components/Layout';
import { useTheme } from 'next-themes';
import { Skeleton, Progress } from 'antd';
import { Sun, Moon, Monitor, Languages, Info, Server, Database } from 'lucide-react';
import { getSystemStats, getEmbeddingConfig, getHealth, type EmbeddingConfig, type SystemStats } from '@/lib/api';

const iconBadge = (icon: React.ReactNode, bg: string, color: string) => (
  <div style={{ width: 32, height: 32, borderRadius: 8, background: bg, display: 'flex', alignItems: 'center', justifyItems: 'center', color, flexShrink: 0 }}>
    {icon}
  </div>
);

export default function SettingsPage() {
  const t = useAppTranslations('settings');
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { locale, setLocale } = useAppLocale();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [health, setHealth] = useState<{ status: string; uptime: number } | null>(null);
  const [embConfig, setEmbConfig] = useState<EmbeddingConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void Promise.all([
      getSystemStats().catch(() => null),
      getHealth().catch(() => null),
      getEmbeddingConfig().catch(() => null),
    ]).then(([s, h, e]) => { setStats(s); setHealth(h); setEmbConfig(e); }).finally(() => setLoading(false));
  }, []);

  const activeTheme = theme === 'system' ? 'system' : resolvedTheme;

  const formatUptime = (seconds: number) => {
    const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d} ${t('days')} ${h} ${t('hours')}`;
    if (h > 0) return `${h} ${t('hours')} ${m} ${t('minutes')}`;
    return `${m} ${t('minutes')}`;
  };

  if (loading) return (
    <div className="space-y-12 animateFadeIn">
      <Skeleton active title paragraph={{ rows: 1 }} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="p-6 border border-[var(--borderColor)]"><Skeleton active paragraph={{ rows: 4 }} /></div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-12 animateFadeIn">
      <div className="pb-6 border-b border-[var(--borderColor)]">
        <h1 className="text-3xl font-extrabold tracking-tight text-[var(--colorText)] mb-2">{t('title')}</h1>
        <p className="text-sm text-[var(--colorTextSecondary)]">{t('description')}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-16">
        {/* 语言 + 主题 */}
        <div>
          <div className="flex items-center gap-3 mb-6">
            <Languages size={20} className="text-[var(--colorTextTertiary)]" />
            <div>
              <div className="font-semibold text-base">{t('language')}</div>
              <div className="text-xs text-[var(--colorTextSecondary)] mt-1">{t('languageDesc')}</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button className={`px-4 py-2 text-sm font-medium rounded-md border transition-colors ${locale === 'zh-CN' ? 'bg-[var(--colorText)] text-[var(--colorBg)] border-transparent' : 'bg-transparent text-[var(--colorTextSecondary)] border-[var(--borderColor)] hover:border-[var(--colorTextTertiary)]'}`} onClick={() => setLocale('zh-CN')}>中文</button>
            <button className={`px-4 py-2 text-sm font-medium rounded-md border transition-colors ${locale === 'en-US' ? 'bg-[var(--colorText)] text-[var(--colorBg)] border-transparent' : 'bg-transparent text-[var(--colorTextSecondary)] border-[var(--borderColor)] hover:border-[var(--colorTextTertiary)]'}`} onClick={() => setLocale('en-US')}>English</button>
          </div>
        </div>

        <div>
          <div className="flex items-center gap-3 mb-6">
            <Monitor size={20} className="text-[var(--colorTextTertiary)]" />
            <div>
              <div className="font-semibold text-base">{t('theme')}</div>
              <div className="text-xs text-[var(--colorTextSecondary)] mt-1">{t('themeDesc')}</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md border transition-colors ${activeTheme === 'light' ? 'bg-[var(--colorText)] text-[var(--colorBg)] border-transparent' : 'bg-transparent text-[var(--colorTextSecondary)] border-[var(--borderColor)] hover:border-[var(--colorTextTertiary)]'}`} onClick={() => setTheme('light')}><Sun size={14} />{t('light')}</button>
            <button className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md border transition-colors ${activeTheme === 'dark' ? 'bg-[var(--colorText)] text-[var(--colorBg)] border-transparent' : 'bg-transparent text-[var(--colorTextSecondary)] border-[var(--borderColor)] hover:border-[var(--colorTextTertiary)]'}`} onClick={() => setTheme('dark')}><Moon size={14} />{t('dark')}</button>
            <button className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md border transition-colors ${activeTheme === 'system' ? 'bg-[var(--colorText)] text-[var(--colorBg)] border-transparent' : 'bg-transparent text-[var(--colorTextSecondary)] border-[var(--borderColor)] hover:border-[var(--colorTextTertiary)]'}`} onClick={() => setTheme('system')}><Monitor size={14} />{t('system')}</button>
          </div>
        </div>

        {/* 服务状态 */}
        <div>
          <div className="flex items-center gap-3 mb-6">
            <Server size={20} className="text-[var(--colorTextTertiary)]" />
            <div>
              <div className="font-semibold text-base">{t('serverStatus')}</div>
              <div className="text-xs text-[var(--colorTextSecondary)] mt-1">{t('serverStatusDesc')}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 bg-[var(--colorBgHover)] rounded-lg">
              <div className="text-xs text-[var(--colorTextTertiary)] uppercase tracking-wider mb-2">{t('status')}</div>
              <div className={`font-semibold ${health?.status === 'ok' ? 'text-[var(--colorOk)]' : 'text-[var(--colorDanger)]'}`}>{health?.status === 'ok' ? t('healthy') : t('unknown')}</div>
            </div>
            <div className="p-4 bg-[var(--colorBgHover)] rounded-lg">
              <div className="text-xs text-[var(--colorTextTertiary)] uppercase tracking-wider mb-2">{t('uptime')}</div>
              <div className="font-semibold text-[var(--colorText)]">{health ? formatUptime(health.uptime) : '—'}</div>
            </div>
            <div className="col-span-2 p-4 bg-[var(--colorBgHover)] rounded-lg flex items-center gap-6">
              <Progress type="dashboard" percent={stats?.cpu.usagePercent ?? 0} size={48} strokeColor={(stats?.cpu.usagePercent ?? 0) > 80 ? 'var(--colorDanger)' : 'var(--colorText)'} strokeWidth={12} showInfo={false} />
              <div>
                <div className="text-xs text-[var(--colorTextTertiary)] uppercase tracking-wider mb-1">{t('cpu')}</div>
                <div className="font-mono text-[var(--colorText)]">{stats ? `${stats.cpu.usagePercent.toFixed(1)}%` : '—'} <span className="text-xs text-[var(--colorTextTertiary)] ml-1">({stats?.cpu.cores ?? 0} {t('cores')})</span></div>
              </div>
            </div>
            <div className="col-span-2 p-4 bg-[var(--colorBgHover)] rounded-lg flex items-center gap-6">
              <Progress type="dashboard" percent={stats?.memory.usagePercent ?? 0} size={48} strokeColor={(stats?.memory.usagePercent ?? 0) > 80 ? 'var(--colorDanger)' : 'var(--colorTextSecondary)'} strokeWidth={12} showInfo={false} />
              <div>
                <div className="text-xs text-[var(--colorTextTertiary)] uppercase tracking-wider mb-1">{t('memory')}</div>
                <div className="font-mono text-[var(--colorText)]">{stats ? `${stats.memory.processMB} MB` : '—'} <span className="text-xs text-[var(--colorTextTertiary)] ml-1">/ {stats?.memory.totalMB ?? 0} MB</span></div>
              </div>
            </div>
          </div>
        </div>

        {/* 嵌入配置 */}
        <div>
          <div className="flex items-center gap-3 mb-6">
            <Database size={20} className="text-[var(--colorTextTertiary)]" />
            <div>
              <div className="font-semibold text-base">{t('embeddingConfig')}</div>
              <div className="text-xs text-[var(--colorTextSecondary)] mt-1">{t('embeddingConfigDesc')}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 p-4 bg-[var(--colorBgHover)] rounded-lg">
              <div className="text-xs text-[var(--colorTextTertiary)] uppercase tracking-wider mb-2">{t('provider')}</div>
              <div className="font-mono text-sm text-[var(--colorText)]">{embConfig?.provider || '—'}</div>
            </div>
            <div className="col-span-2 p-4 bg-[var(--colorBgHover)] rounded-lg">
              <div className="text-xs text-[var(--colorTextTertiary)] uppercase tracking-wider mb-2">{t('model')}</div>
              <div className="font-mono text-sm text-[var(--colorText)] truncate">{embConfig?.model || '—'}</div>
            </div>
            <div className="p-4 bg-[var(--colorBgHover)] rounded-lg">
              <div className="text-xs text-[var(--colorTextTertiary)] uppercase tracking-wider mb-2">{t('apiKey')}</div>
              <div className={`font-semibold ${embConfig?.hasApiKey ? 'text-[var(--colorOk)]' : 'text-[var(--colorTextSecondary)]'}`}>{embConfig?.hasApiKey ? t('configured') : t('none')}</div>
            </div>
            <div className="p-4 bg-[var(--colorBgHover)] rounded-lg">
              <div className="text-xs text-[var(--colorTextTertiary)] uppercase tracking-wider mb-2">{t('dimensions')}</div>
              <div className="font-mono text-[var(--colorText)]">{embConfig?.dimensions ? `${embConfig.dimensions}` : '—'}</div>
            </div>
          </div>
        </div>

        {/* 关于 */}
        <div className="col-span-1 md:col-span-2 pt-8 border-t border-[var(--borderColor)]">
          <div className="flex items-center gap-3 mb-6">
            <Info size={20} className="text-[var(--colorTextTertiary)]" />
            <div>
              <div className="font-semibold text-base">{t('localData')}</div>
              <div className="text-xs text-[var(--colorTextSecondary)] mt-1">{t('localDataDesc')}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: t('directory'), value: '~/.customize-agent/', mono: true },
              { label: t('knowledgeBase'), value: t('localVectors') },
              { label: t('tasks'), value: stats ? stats.tasks.total.toLocaleString() : '—' },
              { label: t('tokens'), value: stats ? stats.tokens.total.toLocaleString() : '—' },
            ].map(item => (
              <div key={item.label} className="p-4 bg-[var(--colorBgHover)] rounded-lg">
                <div className="text-[10px] text-[var(--colorTextTertiary)] uppercase tracking-wider mb-2">{item.label}</div>
                <div className={`text-sm ${item.mono ? 'font-mono' : 'font-medium'} text-[var(--colorText)] truncate`} title={item.value}>{item.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
