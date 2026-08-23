import { useEffect, useState, useCallback } from 'react';
import { useAppTranslations } from '@/components/Layout';
import { Progress, Space, Button } from 'antd';
import { ApiOutlined, ThunderboltOutlined, CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined, FileTextOutlined, RobotOutlined } from '@ant-design/icons';
import { getSystemStats, type SystemStats, getProviders, getDocumentRoles, getDocumentTemplates, getEmbeddingConfig, type EmbeddingConfig } from '@/lib/api';

/** 极简风格数据卡片组件 (Linear 风格无边框) */
function DashCard({ title, value, subtext, icon, colorClass, animationClass }: { title: React.ReactNode, value: React.ReactNode, subtext?: React.ReactNode, icon?: React.ReactNode, colorClass?: string, animationClass?: string }) {
  return (
    <div className={`p-4 animateFadeIn flex flex-col justify-between border-l-2 border-transparent hover:border-[var(--colorBrand)] transition-colors ${animationClass || ''}`} style={{ opacity: 0 }}>
      <div className="flex items-start justify-between mb-2">
        <div className="text-xs font-semibold text-[var(--colorTextSecondary)] tracking-wide uppercase">{title}</div>
        {icon && <div className={colorClass} style={{ opacity: 0.7 }}>{icon}</div>}
      </div>
      <div>
        <div className="text-3xl font-bold tracking-tight">{value}</div>
        {subtext && <div className="text-xs mt-1 truncate font-medium" style={{ color: 'var(--colorTextTertiary)' }}>{subtext}</div>}
      </div>
    </div>
  );
}

export default function OverviewPage() {
  const t = useAppTranslations();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [providerCount, setProviderCount] = useState(0);
  const [promptRoleCount, setPromptRoleCount] = useState(0);
  const [templateCount, setTemplateCount] = useState(0);
  const [embeddingConfig, setEmbeddingConfig] = useState<EmbeddingConfig | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, provs, rolesResult, templatesResult, embConfig] = await Promise.all([
        getSystemStats(),
        getProviders().catch(() => []),
        getDocumentRoles().catch(() => ({ roles: [], configs: [] })),
        getDocumentTemplates().catch(() => ({ templates: [] })),
        getEmbeddingConfig().catch(() => null),
      ]);
      setStats(s);
      setProviderCount(Array.isArray(provs) ? provs.length : 0);
      const roles = Array.isArray(rolesResult.roles) ? rolesResult.roles : [];
      setPromptRoleCount(roles.filter(r => r.type === 'prompt').length);
      setTemplateCount(Array.isArray(templatesResult.templates) ? templatesResult.templates.length : 0);
      setEmbeddingConfig(embConfig);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); const timer = setInterval(() => { void load(); }, 10000); return () => clearInterval(timer); }, [load]);

  const successRate = stats?.tasks.total ? Math.round((stats.tasks.success / stats.tasks.total) * 100) : 0;
  const topModel = stats?.models?.[0];
  const latestLogTime = stats?.logs.latestAt ? new Date(stats.logs.latestAt).toLocaleString() : t('overview.noLogs');

  return (
    <div className="space-y-12">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-6 border-b border-[var(--borderColor)]">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--colorText)] mb-2">{t('overview.title')}</h1>
          <p className="text-sm text-[var(--colorTextSecondary)]">{t('overview.description')}</p>
        </div>
        <Space>
          <span className="text-xs font-mono" style={{ color: 'var(--colorTextTertiary)' }}>{t('overview.updated')}: {latestLogTime}</span>
          <Button type="text" icon={<ReloadOutlined spin={loading} />} onClick={() => { void load(); }} />
        </Space>
      </div>

      {/* 核心指标层 - Vercel / Linear 横向数据流 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-8 divide-x border-b pb-8 border-[var(--borderColor)] divide-[var(--borderColor)] -mx-4 px-4">
        <DashCard 
          title={t('overview.uptime')} 
          value={`${stats ? Math.floor(stats.uptime / 3600) : 0}h`} 
          icon={<ApiOutlined size={16} />} 
          colorClass="text-[var(--colorBrand)]"
          animationClass="stagger-1"
        />
        <DashCard 
          title={t('overview.tokensUsed')} 
          value={(stats?.tokens.total ?? 0).toLocaleString()} 
          subtext={`P ${stats?.tokens.prompt ?? 0} / C ${stats?.tokens.completion ?? 0}`} 
          icon={<ThunderboltOutlined size={16} />} 
          colorClass="text-[var(--colorWarn)]"
          animationClass="stagger-2"
        />
        <DashCard 
          title={t('overview.tasksTotal')} 
          value={(stats?.tasks.total ?? 0).toLocaleString()} 
          subtext={`✓ ${stats?.tasks.success ?? 0} | ✗ ${stats?.tasks.failed ?? 0} | ↻ ${stats?.tasks.running ?? 0}`} 
          icon={<FileTextOutlined size={16} />} 
          colorClass="text-[var(--colorInfo)]"
          animationClass="stagger-3"
        />
        <DashCard 
          title={t('overview.successRate')} 
          value={`${successRate}%`} 
          icon={successRate > 80 ? <CheckCircleOutlined size={16} /> : <CloseCircleOutlined size={16} />} 
          colorClass={successRate > 80 ? "text-[var(--colorOk)]" : "text-[var(--colorDanger)]"}
          animationClass="stagger-4"
        />
      </div>

      {/* 资源分布 - 无边框网格 */}
      <div>
        <h2 className="text-sm font-semibold mb-6 uppercase tracking-wider text-[var(--colorTextSecondary)] animateFadeIn stagger-5" style={{ opacity: 0 }}>{t('overview.systemResources')}</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-y-8 gap-x-4">
          <DashCard title={t('overview.materialUnderstanding')} value="自动" animationClass="stagger-5" />
          <DashCard title={t('overview.promptRoles')} value={promptRoleCount} animationClass="stagger-5" />
          <DashCard title={t('overview.templateCount')} value={templateCount} animationClass="stagger-5" />
          <DashCard title={t('overview.semanticModel')} value={embeddingConfig?.provider === 'openai-compatible' ? t('overview.external') : embeddingConfig ? t('overview.local') : '—'} subtext={embeddingConfig?.model ?? t('overview.notConfigured')} animationClass="stagger-5" />
          <DashCard title={t('overview.modelProviders')} value={providerCount} animationClass="stagger-5" />
          <DashCard title={t('overview.auditLogs')} value={stats?.logs.events ?? 0} animationClass="stagger-5" />
        </div>
      </div>

      {/* 底部详细信息 - 两列式 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-12 pt-8 border-t border-[var(--borderColor)] animateFadeIn stagger-5" style={{ opacity: 0 }}>
        <div>
          <div className="text-sm font-semibold mb-6 uppercase tracking-wider text-[var(--colorTextSecondary)]">{t('overview.hardwareUsage')}</div>
          <div className="space-y-6">
            <div className="flex items-center gap-6">
              <Progress type="dashboard" percent={stats?.cpu.usagePercent ?? 0} size={64} strokeColor={(stats?.cpu.usagePercent ?? 0) > 80 ? 'var(--colorDanger)' : 'var(--colorText)'} strokeWidth={10} />
              <div>
                <div className="text-sm font-medium text-[var(--colorTextSecondary)]">{t('overview.cpuUsage')}</div>
                <div className="text-xl font-bold">{stats?.cpu.usagePercent?.toFixed(1) ?? '0.0'}%</div>
                <div className="text-xs text-[var(--colorTextTertiary)]">{stats?.cpu.cores ?? 0} {t('overview.cores')}</div>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <Progress type="dashboard" percent={stats?.memory.usagePercent ?? 0} size={64} strokeColor={(stats?.memory.usagePercent ?? 0) > 80 ? 'var(--colorDanger)' : 'var(--colorTextSecondary)'} strokeWidth={10} />
              <div>
                <div className="text-sm font-medium text-[var(--colorTextSecondary)]">{t('overview.memoryUsage')}</div>
                <div className="text-xl font-bold">{stats?.memory.usagePercent ?? 0}%</div>
                <div className="text-xs text-[var(--colorTextTertiary)]">{stats?.memory.processMB ?? 0} MB / {stats?.memory.totalMB ?? 0} MB</div>
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="text-sm font-semibold mb-6 uppercase tracking-wider text-[var(--colorTextSecondary)]">{t('overview.activityContext')}</div>
          <div className="space-y-6">
            <div>
              <div className="text-xs text-[var(--colorTextTertiary)] mb-1">{t('overview.topModel')}</div>
              {topModel ? (
                <div className="font-semibold flex items-center gap-2">
                  <RobotOutlined className="text-[var(--colorTextSecondary)]" /> {topModel.model} 
                  <span className="font-normal text-[var(--colorTextTertiary)] text-sm">@{topModel.provider}</span>
                </div>
              ) : <span className="text-sm text-[var(--colorTextTertiary)]">{t('overview.noDataAvailable')}</span>}
            </div>
            
            <div>
              <div className="text-xs text-[var(--colorTextTertiary)] mb-3">{t('overview.recentTaskTypes')}</div>
              {stats?.tasks.types && Object.keys(stats.tasks.types).length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(stats.tasks.types).sort((a, b) => b[1] - a[1]).map(([taskType, count]) => (
                    <div key={taskType} className="px-2 py-1 rounded text-xs font-mono bg-[var(--colorBgHover)] text-[var(--colorTextSecondary)]">
                      {taskType.slice(0, 30)} <span className="ml-2 font-bold text-[var(--colorText)]">{count}</span>
                    </div>
                  ))}
                </div>
              ) : <span className="text-sm text-[var(--colorTextTertiary)]">{t('common.noData')}</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
