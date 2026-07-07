import { useEffect, useState } from 'react';
import { useAppLocale, useAppTranslations } from '@/components/Layout';
import { useTheme } from 'next-themes';
import { Card, Row, Col, Tag, Skeleton } from 'antd';
import { Sun, Moon, Monitor, Languages, Info, Server, Database } from 'lucide-react';
import { getSystemStats, getEmbeddingConfig, getHealth, type EmbeddingConfig, type SystemStats } from '@/lib/api';

const iconBadge = (icon: React.ReactNode, bg: string, color: string) => (
  <div style={{ width: 32, height: 32, borderRadius: 8, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', color, flexShrink: 0 }}>
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
  const pill = (active: boolean) => `applePill${active ? ' applePillActive' : ''}`;

  const formatUptime = (seconds: number) => {
    const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    return `${m} 分`;
  };

  if (loading) return (
    <div className="space-y-5 animateFadeIn">
      <Skeleton active title paragraph={{ rows: 1 }} />
      <Row gutter={[16, 16]}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Col xs={24} md={12} key={i}><Card size="small"><Skeleton active paragraph={{ rows: 2 }} /></Card></Col>
        ))}
        <Col xs={24}><Card size="small"><Skeleton active paragraph={{ rows: 4 }} /></Card></Col>
      </Row>
    </div>
  );

  return (
    <div className="space-y-5 animateFadeIn">
      <div>
        <h1 className="pageTitle">{t('title')}</h1>
        <p className="pageDesc">{t('description')}</p>
      </div>

      <Row gutter={[16, 16]}>
        {/* Language + Theme */}
        <Col xs={24} md={12} style={{ display: 'flex' }}>
          <Card size="small" style={{ flex: 1 }} styles={{ body: { padding: '14px 18px' } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              {iconBadge(<Languages size={16} />, 'rgba(88,86,214,0.1)', '#5856d6')}
              <div><div style={{ fontWeight: 600, fontSize: 14 }}>{t('language')}</div><div style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>{t('languageDesc')}</div></div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className={pill(locale === 'zh-CN')} onClick={() => setLocale('zh-CN')}>中文</button>
              <button className={pill(locale === 'en-US')} onClick={() => setLocale('en-US')}>English</button>
            </div>
          </Card>
        </Col>

        <Col xs={24} md={12} style={{ display: 'flex' }}>
          <Card size="small" style={{ flex: 1 }} styles={{ body: { padding: '14px 18px' } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              {iconBadge(<Monitor size={16} />, 'rgba(250,140,22,0.1)', '#fa8c16')}
              <div><div style={{ fontWeight: 600, fontSize: 14 }}>{t('theme')}</div><div style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>{t('themeDesc')}</div></div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className={pill(activeTheme === 'light')} onClick={() => setTheme('light')}><Sun size={14} />{t('light')}</button>
              <button className={pill(activeTheme === 'dark')} onClick={() => setTheme('dark')}><Moon size={14} />{t('dark')}</button>
              <button className={pill(activeTheme === 'system')} onClick={() => setTheme('system')}><Monitor size={14} />{t('system')}</button>
            </div>
          </Card>
        </Col>

        {/* Service Stats */}
        <Col xs={24} md={12} style={{ display: 'flex' }}>
          <Card size="small" style={{ flex: 1 }} styles={{ body: { padding: '14px 18px' } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              {iconBadge(<Server size={16} />, 'rgba(22,119,255,0.1)', '#1677ff')}
              <div><div style={{ fontWeight: 600, fontSize: 14 }}>服务运行状态</div><div style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>查看当前服务是否正常，以及本机资源占用情况。</div></div>
            </div>
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <div style={{ background: 'var(--colorFillAlter)', borderRadius: 8, padding: '10px 12px', textAlign: 'left' }}>
                  <div style={{ fontSize: 11, color: 'var(--colorTextSecondary)', marginBottom: 4 }}>状态</div>
                  <Tag color={health?.status === 'ok' ? 'success' : 'error'} style={{ margin: 0 }}>{health?.status === 'ok' ? '运行中' : '—'}</Tag>
                </div>
              </Col>
              <Col span={12}>
                <div style={{ background: 'var(--colorFillAlter)', borderRadius: 8, padding: '10px 12px', textAlign: 'left' }}>
                  <div style={{ fontSize: 11, color: 'var(--colorTextSecondary)', marginBottom: 4 }}>运行时间</div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{health ? formatUptime(health.uptime) : '—'}</div>
                </div>
              </Col>
              <Col span={12}>
                <div style={{ background: 'var(--colorFillAlter)', borderRadius: 8, padding: '10px 12px', textAlign: 'left' }}>
                  <div style={{ fontSize: 11, color: 'var(--colorTextSecondary)', marginBottom: 4 }}>CPU</div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{stats ? `${stats.cpu.usagePercent.toFixed(1)}%` : '—'}</div>
                  <div style={{ fontSize: 10, color: 'var(--colorTextSecondary)' }}>{stats?.cpu.cores ?? 0} 核</div>
                </div>
              </Col>
              <Col span={12}>
                <div style={{ background: 'var(--colorFillAlter)', borderRadius: 8, padding: '10px 12px', textAlign: 'left' }}>
                  <div style={{ fontSize: 11, color: 'var(--colorTextSecondary)', marginBottom: 4 }}>内存</div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{stats ? `${stats.memory.processMB} MB` : '—'}</div>
                  <div style={{ fontSize: 10, color: 'var(--colorTextSecondary)' }}>/ {stats?.memory.totalMB ?? 0} MB</div>
                </div>
              </Col>
            </Row>
          </Card>
        </Col>

        {/* Embedding */}
        <Col xs={24} md={12} style={{ display: 'flex' }}>
          <Card size="small" style={{ flex: 1 }} styles={{ body: { padding: '14px 18px' } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              {iconBadge(<Database size={16} />, 'rgba(82,196,26,0.1)', '#52c41a')}
              <div><div style={{ fontWeight: 600, fontSize: 14 }}>知识库向量配置</div><div style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>用于知识库检索。修改模型或维度后，建议重新索引知识库。</div></div>
            </div>
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <div style={{ background: 'var(--colorFillAlter)', borderRadius: 8, padding: '10px 12px', textAlign: 'left' }}>
                  <div style={{ fontSize: 11, color: 'var(--colorTextSecondary)', marginBottom: 4 }}>供应商</div>
                  <Tag color="blue" style={{ margin: 0 }}>{embConfig?.provider || '—'}</Tag>
                </div>
              </Col>
              <Col span={12}>
                <div style={{ background: 'var(--colorFillAlter)', borderRadius: 8, padding: '10px 12px', textAlign: 'left' }}>
                  <div style={{ fontSize: 11, color: 'var(--colorTextSecondary)', marginBottom: 4 }}>密钥状态</div>
                  {embConfig?.hasApiKey ? <Tag color="success" style={{ margin: 0 }}>已配置</Tag> : <Tag color="default" style={{ margin: 0 }}>未配置</Tag>}
                </div>
              </Col>
              <Col span={12}>
                <div style={{ background: 'var(--colorFillAlter)', borderRadius: 8, padding: '10px 12px', textAlign: 'left' }}>
                  <div style={{ fontSize: 11, color: 'var(--colorTextSecondary)', marginBottom: 4 }}>模型</div>
                  <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{embConfig?.model || '—'}</div>
                </div>
              </Col>
              <Col span={12}>
                <div style={{ background: 'var(--colorFillAlter)', borderRadius: 8, padding: '10px 12px', textAlign: 'left' }}>
                  <div style={{ fontSize: 11, color: 'var(--colorTextSecondary)', marginBottom: 4 }}>维度</div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{embConfig?.dimensions ? `${embConfig.dimensions}` : '—'}</div>
                </div>
              </Col>
            </Row>
          </Card>
        </Col>

        {/* About */}
        <Col xs={24}>
          <Card size="small" styles={{ body: { padding: '14px 18px' } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              {iconBadge(<Info size={16} />, 'rgba(114,46,209,0.1)', '#722ed1')}
              <div><div style={{ fontWeight: 600, fontSize: 14 }}>本地数据与使用概况</div><div style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>用户数据保存在本机，包含知识库、提示词、角色配置、规范包、生成记录和日志。</div></div>
            </div>
            <Row gutter={[8, 8]}>
              {[
                { label: '用户数据目录', value: '~/.customize-agent/', mono: true },
                { label: '知识库数据', value: '本地索引与向量库' },
                { label: '生成记录', value: '草稿、导出和资源' },
                { label: '配置数据', value: '提示词、角色、规范包' },
                { label: '累计任务', value: stats ? stats.tasks.total.toLocaleString() : '—' },
                { label: 'Token 用量', value: stats ? stats.tokens.total.toLocaleString() : '—' },
                { label: '日志', value: '本地运行日志' },
                { label: '数据范围', value: '仅保存在本机' },
              ].map(item => (
                <Col xs={12} sm={6} key={item.label}>
                  <div style={{ background: 'var(--colorFillAlter)', borderRadius: 8, padding: '8px 12px' }}>
                    <div style={{ fontSize: 11, color: 'var(--colorTextSecondary)', marginBottom: 2 }}>{item.label}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, fontFamily: item.mono ? 'monospace' : undefined }}>{item.value}</div>
                  </div>
                </Col>
              ))}
            </Row>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
