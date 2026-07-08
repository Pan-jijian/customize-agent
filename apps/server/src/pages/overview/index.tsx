import { useEffect, useState, useCallback } from 'react';
import { useAppTranslations } from '@/components/Layout';
import { Card, Row, Col, Statistic, Progress, Tag, Space, Button } from 'antd';
import { CloudServerOutlined, ApiOutlined, ThunderboltOutlined, CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined, FileTextOutlined, HddOutlined, FormOutlined, SafetyOutlined, LayoutOutlined, NodeIndexOutlined, RobotOutlined } from '@ant-design/icons';
import { getSystemStats, type SystemStats, getProviders, getDocumentRoles, getDocumentSpecs, getDocumentTemplates, getEmbeddingConfig, type EmbeddingConfig } from '@/lib/api';

export default function OverviewPage() {
  const t = useAppTranslations();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [providerCount, setProviderCount] = useState(0);
  const [fileRoleCount, setFileRoleCount] = useState(0);
  const [promptRoleCount, setPromptRoleCount] = useState(0);
  const [specCount, setSpecCount] = useState(0);
  const [templateCount, setTemplateCount] = useState(0);
  const [embeddingConfig, setEmbeddingConfig] = useState<EmbeddingConfig | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, provs, rolesResult, specsResult, templatesResult, embConfig] = await Promise.all([
        getSystemStats(),
        getProviders().catch(() => []),
        getDocumentRoles().catch(() => ({ roles: [], configs: [] })),
        getDocumentSpecs().catch(() => ({ specs: [] })),
        getDocumentTemplates().catch(() => ({ templates: [] })),
        getEmbeddingConfig().catch(() => null),
      ]);
      setStats(s);
      setProviderCount(Array.isArray(provs) ? provs.length : 0);
      const roles = Array.isArray(rolesResult.roles) ? rolesResult.roles : [];
      setFileRoleCount(roles.filter(r => r.type === 'file').length);
      setPromptRoleCount(roles.filter(r => r.type === 'prompt').length);
      setSpecCount(Array.isArray(specsResult.specs) ? specsResult.specs.length : 0);
      setTemplateCount(Array.isArray(templatesResult.templates) ? templatesResult.templates.length : 0);
      setEmbeddingConfig(embConfig);
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

      {/* CPU + 内存 */}
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

      {/* 统计信息 */}
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}>
          <Card size="small"><Statistic title="运行时间" value={stats ? Math.floor(stats.uptime / 3600) : 0} suffix="小时" prefix={<ApiOutlined />} /></Card>
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

      {/* 资源状态 */}
      <Card size="small" title="资源概览">
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} md={8} lg={4}>
            <Card size="small" style={{ height: '100%' }}><Statistic title="文件角色" value={fileRoleCount} prefix={<FileTextOutlined style={{ color: 'var(--colorAccent)' }} />} /></Card>
          </Col>
          <Col xs={24} sm={12} md={8} lg={4}>
            <Card size="small" style={{ height: '100%' }}><Statistic title="提示词角色" value={promptRoleCount} prefix={<FormOutlined style={{ color: 'var(--colorWarning)' }} />} /></Card>
          </Col>
          <Col xs={24} sm={12} md={8} lg={4}>
            <Card size="small" style={{ height: '100%' }}><Statistic title="文档规范包" value={specCount} prefix={<SafetyOutlined style={{ color: 'var(--colorOk)' }} />} /></Card>
          </Col>
          <Col xs={24} sm={12} md={8} lg={4}>
            <Card size="small" style={{ height: '100%' }}><Statistic title="模板" value={templateCount} prefix={<LayoutOutlined style={{ color: 'var(--colorDanger)' }} />} /></Card>
          </Col>
          <Col xs={24} sm={12} md={8} lg={4}>
            <Card size="small" style={{ height: '100%', overflow: 'hidden' }}>
              <Statistic
                title="语义模型"
                value={embeddingConfig?.provider === 'openai-compatible' ? '外部 Embedding' : embeddingConfig ? '本地语义模型' : '—'}
                prefix={<NodeIndexOutlined style={{ color: 'var(--colorAccent)' }} />}
                valueStyle={{ fontSize: 18, whiteSpace: 'nowrap' }}
              />
              {embeddingConfig?.model && (
                <div className="text-xs mt-1" style={{ color: 'var(--colorTextSecondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${embeddingConfig.model}${embeddingConfig.dimensions ? ` · ${embeddingConfig.dimensions}维` : ''}`}>
                  {embeddingConfig.model}{embeddingConfig.dimensions ? ` · ${embeddingConfig.dimensions}维` : ''}
                </div>
              )}
            </Card>
          </Col>
          <Col xs={24} sm={12} md={8} lg={4}>
            <Card size="small" style={{ height: '100%' }}><Statistic title="模型供应商" value={providerCount} prefix={<RobotOutlined style={{ color: 'var(--colorAccent)' }} />} /></Card>
          </Col>
        </Row>
      </Card>

      {/* 热门模型 + 任务类型 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12}>
          <Card size="small" title={t('overview.topModel')} style={{ height: '100%' }}>
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
          <Card size="small" title={t('overview.taskTypes')} style={{ height: '100%' }}>
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
    </div>
  );
}
