import { useEffect, useState, useCallback } from 'react';
import { useAppTranslations } from '@/components/Layout';
import { Card, Row, Col, Statistic, Progress, Tag, Space, Button } from 'antd';
import { useRouter } from 'next/router';
import { CloudServerOutlined, ApiOutlined, ThunderboltOutlined, CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined, FileTextOutlined, HddOutlined } from '@ant-design/icons';
import { getSystemStats, type SystemStats, getProviders } from '@/lib/api';

export default function OverviewPage() {
  const t = useAppTranslations();
  const router = useRouter();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [providerCount, setProviderCount] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, provs] = await Promise.all([getSystemStats(), getProviders().catch(() => [])]);
      setStats(s);
      setProviderCount(Array.isArray(provs) ? provs.length : 0);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); const timer = setInterval(() => { void load(); }, 10000); return () => clearInterval(timer); }, [load]);

  const cpuColor = (stats?.cpu.usagePercent ?? 0) > 80 ? 'var(--colorDanger)' : (stats?.cpu.usagePercent ?? 0) > 50 ? 'var(--colorWarning)' : 'var(--colorOk)';
  const memColor = (stats?.memory.usagePercent ?? 0) > 80 ? 'var(--colorDanger)' : (stats?.memory.usagePercent ?? 0) > 50 ? 'var(--colorWarning)' : 'var(--colorOk)';
  const successRate = stats?.tasks.total ? Math.round((stats.tasks.success / stats.tasks.total) * 100) : 0;
  const topModel = stats?.models?.[0];

  return (
    <div className="space-y-6 animateFadeIn">
      <div className="flex items-center justify-between">
        <div><h1 className="pageTitle">{t('overview.title')}</h1><p className="pageDesc">{t('overview.description')}</p></div>
        <Button icon={<ReloadOutlined spin={loading} />} loading={loading} onClick={() => { void load(); }}>{t('common.retry')}</Button>
      </div>

      {/* CPU + Memory */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12}>
          <Card size="small" title={<><CloudServerOutlined /> CPU</>}>
            <div style={{ textAlign: 'center' }}>
              <Progress type="circle" percent={stats?.cpu.usagePercent ?? 0} size={120} strokeColor={cpuColor} format={pct => `${pct?.toFixed(1)}%`} />
              <div className="text-xs mt-2" style={{ color: 'var(--colorTextSecondary)' }}>{stats?.cpu.cores ?? 0} {t('overview.cores')}</div>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12}>
          <Card size="small" title={<><HddOutlined /> {t('overview.memory')}</>}>
            <div style={{ textAlign: 'center' }}>
              <Progress type="circle" percent={stats?.memory.usagePercent ?? 0} size={120} strokeColor={memColor} format={pct => `${pct}%`} />
              <div className="text-xs mt-2" style={{ color: 'var(--colorTextSecondary)' }}>{stats?.memory.processMB ?? 0} MB / {stats?.memory.totalMB ?? 0} MB</div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* Stats */}
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}>
          <Card size="small"><Statistic title={t('overview.providersCount')} value={providerCount} prefix={<ApiOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small"><Statistic title={t('overview.tokensUsed')} value={stats?.tokens.total ?? 0} prefix={<ThunderboltOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small"><Statistic title={t('overview.tasksTotal')} value={stats?.tasks.total ?? 0} prefix={<FileTextOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small"><Statistic title={t('overview.successRate')} value={successRate} suffix="%" prefix={successRate > 80 ? <CheckCircleOutlined style={{ color: 'var(--colorOk)' }} /> : <CloseCircleOutlined style={{ color: 'var(--colorDanger)' }} />} /></Card>
        </Col>
      </Row>

      {/* Top Model + Task Types */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12}>
          <Card size="small" title={t('overview.topModel')}>
            {topModel ? (
              <div className="flex items-center gap-4">
                <ApiOutlined style={{ fontSize: 24, color: 'var(--colorAccent)' }} />
                <div>
                  <div className="font-semibold">{topModel.model}</div>
                  <div style={{ color: 'var(--colorTextSecondary)', fontSize: 12 }}>
                    @{topModel.provider} — {topModel.count} {t('overview.calls')}
                  </div>
                </div>
              </div>
            ) : <span style={{ color: 'var(--colorTextSecondary)' }}>{t('common.noData')}</span>}
          </Card>
        </Col>
        <Col xs={24} sm={12}>
          <Card size="small" title={t('overview.taskTypes')}>
            {stats?.tasks.types && Object.keys(stats.tasks.types).length > 0 ? (
              <Space wrap>
                {Object.entries(stats.tasks.types).map(([taskType, count]) => (
                  <Tag key={taskType}>{taskType.slice(0, 30)}: {count}</Tag>
                ))}
              </Space>
            ) : <span style={{ color: 'var(--colorTextSecondary)' }}>{t('common.noData')}</span>}
          </Card>
        </Col>
      </Row>

      {/* Quick Actions */}
      <Card title={t('overview.quickActions')} size="small">
        <Space wrap>
          <Button onClick={() => { void router.push('/knowledge/manage'); }}>{t('overview.goToKnowledge')}</Button>
          <Button onClick={() => { void router.push('/models'); }}>{t('overview.goToModels')}</Button>
          <Button onClick={() => { void router.push('/settings'); }}>{t('overview.goToSettings')}</Button>
          <Button onClick={() => { void router.push('/prompt'); }}>{t('nav.promptManagement')}</Button>
          <Button onClick={() => { void router.push('/context/long-term'); }}>{t('nav.contextEngineering')}</Button>
        </Space>
      </Card>
    </div>
  );
}
