import { useEffect, useState } from 'react';
import { useAppTranslations } from '@/components/Layout';
import { Card, Button, Tag, Drawer, Input, Select, Row, Col, Space, Popconfirm, Form, App, InputNumber, Alert, Checkbox, Skeleton } from 'antd';
import { PlusOutlined, DeleteOutlined, ApiOutlined, KeyOutlined, GlobalOutlined, EditOutlined, CheckCircleFilled, CloseCircleFilled, ThunderboltOutlined } from '@ant-design/icons';
import { getProviders, getModels, saveProvider, deleteProvider, saveModels, healthCheck, getProviderDetail, getEmbeddingConfig, saveEmbeddingConfig, embeddingHealthCheck, type ProviderInfo, type ModelsConfig, type EmbeddingConfig, type ModelCapabilities } from '@/lib/api';

const PROTOCOL_OPTIONS = [
  { label: 'OpenAI 兼容', value: 'openai' }, { label: 'Anthropic', value: 'anthropic' }, { label: 'Google', value: 'google' },
  { label: 'Ollama', value: 'ollama' }, { label: 'OpenRouter', value: 'openrouter' },
];
const TIERS = [
  { key: 'reader', labelKey: 'models.tierReader', descKey: 'models.tierReaderDesc' },
  { key: 'reasoning', labelKey: 'models.tierReasoning', descKey: 'models.tierReasoningDesc' },
  { key: 'action', labelKey: 'models.tierAction', descKey: 'models.tierActionDesc' },
] as const;
const CAPABILITY_OPTIONS: Array<{ key: keyof ModelCapabilities; label: string }> = [
  { key: 'imageGeneration', label: '图片生成' }, { key: 'imageUnderstanding', label: '图片理解' },
  { key: 'fileUnderstanding', label: '文件理解' }, { key: 'audio', label: '音频能力' }, { key: 'video', label: '视频能力' },
];

export default function ModelsPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelsConfig | null>(null);
  const [embedding, setEmbedding] = useState<EmbeddingConfig>({ provider: 'hash', dimensions: 384 });
  const [embeddingSaving, setEmbeddingSaving] = useState(false);
  const [embeddingTesting, setEmbeddingTesting] = useState(false);
  const [embeddingTestResult, setEmbeddingTestResult] = useState<boolean | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, boolean | null>>({});

  // Shared Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTarget, setEditTarget] = useState('');
  const [formName, setFormName] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formProtocol, setFormProtocol] = useState('openai');
  const [formDirect, setFormDirect] = useState(false);
  const [formCapabilities, setFormCapabilities] = useState<ModelCapabilities>({});
  const [formSaving, setFormSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [p, m, e] = await Promise.all([
        getProviders().catch(() => []), getModels().catch(() => null),
        getEmbeddingConfig().catch(() => ({ provider: 'hash' as const, dimensions: 384 })),
      ]);
      setProviders(p); setModels(m); setEmbedding(e);
    } catch { message.error(t('common.error')); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const openAddDrawer = () => {
    setIsEditing(false); setEditTarget('');
    setFormName(''); setFormApiKey(''); setFormBaseUrl(''); setFormProtocol('openai');
    setFormDirect(false); setFormCapabilities({});
    setDrawerOpen(true);
  };

  const openEditDrawer = async (p: ProviderInfo) => {
    setIsEditing(true); setEditTarget(p.name);
    setFormName(p.name); setFormApiKey(''); setFormBaseUrl(p.baseUrl || '');
    setFormProtocol(p.protocol || p.detectedProtocol || 'openai'); setFormCapabilities(p.capabilities || {});
    try {
      const detail = await getProviderDetail(p.name);
      setFormApiKey(detail.apiKey ? '••••••••' : '');
      setFormBaseUrl(detail.baseUrl || ''); setFormCapabilities(detail.capabilities || {});
    } catch { /* use existing */ }
    setDrawerOpen(true);
  };

  const handleSaveProvider = async () => {
    if (!formName.trim()) return; setFormSaving(true);
    try {
      const apiKey = isEditing && formApiKey.includes('•') ? undefined : formApiKey || undefined;
      await saveProvider(formName.trim(), { oldName: isEditing ? editTarget : undefined, apiKey, baseUrl: formBaseUrl || undefined, protocol: formProtocol, directEndpoint: formDirect, capabilities: formCapabilities });
      setDrawerOpen(false); await load(); message.success(t('common.success'));
    } catch { message.error(t('common.error')); } finally { setFormSaving(false); }
  };

  const handleDelete = async (n: string) => { try { await deleteProvider(n); await load(); message.success(t('common.success')); } catch { message.error(t('common.error')); } };
  const handleTest = async (n: string) => {
    setTesting(n);
    try { const r = await healthCheck(n); setResults(p => ({ ...p, [n]: r.success })); message[r.success ? 'success' : 'error'](r.success ? t('models.connected') : t('models.connectionFailed')); }
    catch { setResults(p => ({ ...p, [n]: false })); } finally { setTesting(null); }
  };
  const handleModelChange = async (tier: string, val: string | undefined) => {
    if (!models) return;
    const updated = { ...models };
    const tc = updated[tier as keyof ModelsConfig];
    if (!val) { tc.active = ''; setModels(updated); try { await saveModels(updated); } catch { message.error(t('common.error')); } return; }
    const [provider, name] = val.includes(':') ? val.split(':') : [val, val];
    tc.active = name;
    if (!tc.list.some(m => m.name === name && m.provider === provider)) tc.list.push({ name, provider });
    setModels(updated);
    try { await saveModels(updated); } catch { message.error(t('common.error')); }
  };
  const handleEmbeddingSave = async () => { setEmbeddingSaving(true); try { const s = await saveEmbeddingConfig(embedding); setEmbedding(s); setEmbeddingTestResult(null); message.success(t('common.success')); } catch { message.error(t('common.error')); } finally { setEmbeddingSaving(false); } };
  const handleEmbeddingTest = async () => { setEmbeddingTesting(true); try { const r = await embeddingHealthCheck(); setEmbeddingTestResult(r.success); message[r.success ? 'success' : 'error'](r.message || (r.success ? t('models.connected') : t('models.connectionFailed'))); } catch { setEmbeddingTestResult(false); } finally { setEmbeddingTesting(false); } };

  if (loading) return (
    <div className="space-y-5 animateFadeIn">
      <Skeleton active title paragraph={{ rows: 1 }} />
      <Card size="small"><Skeleton active paragraph={{ rows: 6 }} /></Card>
      <Card size="small"><Skeleton active paragraph={{ rows: 4 }} /></Card>
      <Card size="small"><Skeleton active paragraph={{ rows: 3 }} /></Card>
    </div>
  );

  return (
    <div className="space-y-5 animateFadeIn">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div><h1 className="pageTitle">{t('models.title')}</h1><p className="pageDesc">{t('models.description')}</p></div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAddDrawer}>{t('models.addModel')}</Button>
      </div>

      {/* Provider List */}
      <Card size="small" title={`${t('models.modelList')} (${providers.length})`}>
        {providers.length === 0 ? <span style={{ color: 'var(--colorTextSecondary)', fontSize: 12 }}>{t('models.noProviders')}</span> : (
          <Row gutter={[12, 12]}>
            {providers.map((p, index) => (
              <Col key={p.name} xs={24} sm={12} lg={8} xl={6}>
                <Card size="small" hoverable style={{ height: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 8, minWidth: 0 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}><ThunderboltOutlined /> {p.protocol || p.detectedProtocol || 'openai'}</div>
                    </div>
                    <Space size={2}>
                      <Button size="small" loading={testing === p.name} onClick={() => { void handleTest(p.name); }}
                        icon={results[p.name] === true ? <CheckCircleFilled style={{ color: 'var(--colorOk)' }} /> : results[p.name] === false ? <CloseCircleFilled style={{ color: 'var(--colorDanger)' }} /> : <ApiOutlined />} />
                      <Button size="small" icon={<EditOutlined />} onClick={() => { void openEditDrawer(p); }} />
                      <Popconfirm title={t('models.deleteProviderConfirm')} onConfirm={() => { void handleDelete(p.name); }}>
                        <Button size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}><KeyOutlined /> {p.hasApiKey ? '••••••••' : '—'}</span>
                    {p.baseUrl && <span style={{ fontSize: 12, color: 'var(--colorTextSecondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.baseUrl}><GlobalOutlined /> {p.baseUrl}</span>}
                    <Space size={4} wrap>
                      {CAPABILITY_OPTIONS.filter(o => p.capabilities?.[o.key]).map(o => <Tag key={o.key} color="purple" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>{o.label}</Tag>)}
                    </Space>
                  </div>
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </Card>

      {/* Embedding */}
      <Card size="small" title={t('models.embeddingConfig')}>
        <Alert type="info" showIcon message={t('models.embeddingHint')} style={{ marginBottom: 16 }} />
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={8}>
            <div style={{ fontSize: 12, marginBottom: 4, color: 'var(--colorTextSecondary)' }}>{t('models.embeddingProvider')}</div>
            <Select value={embedding.provider} style={{ width: '100%' }}
              options={[{ label: t('models.embeddingProviderHash'), value: 'hash' }, { label: '本地语义模型', value: 'transformers-local' }, { label: t('models.embeddingProviderOpenAI'), value: 'openai-compatible' }]}
              onChange={v => setEmbedding(prev => ({ ...prev, provider: v as EmbeddingConfig['provider'], model: v === 'transformers-local' ? (prev.model || 'BAAI/bge-small-zh-v1.5') : prev.model, dimensions: v === 'hash' ? 384 : v === 'transformers-local' ? 512 : (prev.dimensions || 1024) }))} />
          </Col>
          {embedding.provider === 'openai-compatible' && (
            <>
              <Col xs={24} sm={8}><div style={{ fontSize: 12, marginBottom: 4, color: 'var(--colorTextSecondary)' }}>Base URL</div><Input value={embedding.baseUrl} onChange={e => setEmbedding(p => ({ ...p, baseUrl: e.target.value }))} placeholder="http://localhost:11434/v1" /></Col>
              <Col xs={24} sm={8}><div style={{ fontSize: 12, marginBottom: 4, color: 'var(--colorTextSecondary)' }}>{t('models.model')}</div><Input value={embedding.model} onChange={e => setEmbedding(p => ({ ...p, model: e.target.value }))} placeholder="bge-m3" /></Col>
              <Col xs={24} sm={8}>
                <div style={{ fontSize: 12, marginBottom: 4, color: 'var(--colorTextSecondary)' }}>{t('models.apiKey')}</div>
                <Input.Password value={embedding.apiKey} onFocus={() => { if (embedding.apiKey?.includes('•')) setEmbedding(p => ({ ...p, apiKey: '' })); }} onChange={e => setEmbedding(p => ({ ...p, apiKey: e.target.value }))} placeholder={t('models.optional')} />
                {embedding.hasApiKey && <div style={{ fontSize: 11, color: 'var(--colorTextSecondary)', marginTop: 4 }}>{t('models.embeddingApiKeyHint')}</div>}
              </Col>
            </>
          )}
          {embedding.provider === 'transformers-local' && (
            <Col xs={24} sm={8}><div style={{ fontSize: 12, marginBottom: 4, color: 'var(--colorTextSecondary)' }}>{t('models.model')}</div><Input value={embedding.model} onChange={e => setEmbedding(p => ({ ...p, model: e.target.value }))} placeholder="BAAI/bge-small-zh-v1.5" /></Col>
          )}
          <Col xs={24} sm={8}>
            <div style={{ fontSize: 12, marginBottom: 4, color: 'var(--colorTextSecondary)' }}>{t('models.dimensions')}</div>
            <InputNumber style={{ width: '100%' }} min={1} value={embedding.dimensions} onChange={v => setEmbedding(p => ({ ...p, dimensions: Number(v || (p.provider === 'hash' ? 384 : 1024)) }))} />
          </Col>
          <Col xs={24} sm={8}>
            <div style={{ fontSize: 12, marginBottom: 4, color: 'var(--colorTextSecondary)' }}>{t('models.status')}</div>
            <Space>
              <Tag color={embedding.provider === 'hash' ? 'default' : 'blue'}>{embedding.provider === 'hash' ? t('models.localHash') : embedding.provider === 'transformers-local' ? '本地语义模型' : t('models.openAICompatible')}</Tag>
              {embeddingTestResult === true && <Tag color="success">{t('models.connected')}</Tag>}
              {embeddingTestResult === false && <Tag color="error">{t('models.connectionFailed')}</Tag>}
            </Space>
          </Col>
        </Row>
        <Space style={{ marginTop: 16 }}>
          <Button type="primary" loading={embeddingSaving} onClick={() => { void handleEmbeddingSave(); }}>{t('models.saveEmbedding')}</Button>
          <Button loading={embeddingTesting} onClick={() => { void handleEmbeddingTest(); }}>{t('models.testEmbedding')}</Button>
        </Space>
      </Card>

      {/* Model Tiers */}
      {models && (
        <Card size="small" title={t('models.modelTiers')}>
          <Row gutter={[12, 12]}>
            {TIERS.map(({ key, labelKey, descKey }) => {
              const tier = models[key as keyof ModelsConfig];
              const tierOpts = tier.list.map(m => ({ label: `${m.provider} / ${m.name}`, value: `${m.provider}:${m.name}` }));
              const newOpts = providers.filter(p => !tier.list.some(m => m.provider === p.name)).map(p => ({ label: p.name, value: `${p.name}:${p.name}` }));
              return (
                <Col key={key} xs={24} lg={8}>
                  <Card size="small" title={<span style={{ fontSize: 13 }}>{t(labelKey)}</span>}>
                    <div style={{ fontSize: 12, color: 'var(--colorTextSecondary)', marginBottom: 8 }}>{t(descKey)}</div>
                    <Select value={tier.active ? `${tier.list.find(m => m.name === tier.active)?.provider || ''}:${tier.active}` : undefined}
                      onChange={v => { void handleModelChange(key, v); }} allowClear placeholder={t('models.selectModelPlaceholder')}
                      style={{ width: '100%' }} options={[...tierOpts, ...newOpts]} />
                    {tier.list.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                        {tier.list.map(m => (
                          <Tag key={`${m.provider}:${m.name}`} color={m.name === tier.active ? 'blue' : undefined} closable onClose={() => {
                            const u = { ...models }; const tc = u[key as keyof ModelsConfig];
                            tc.list = tc.list.filter(x => !(x.name === m.name && x.provider === m.provider));
                            if (tc.active === m.name) tc.active = tc.list[0]?.name ?? '';
                            setModels(u); saveModels(u).catch(() => message.error(t('common.error')));
                          }} style={{ margin: 0, fontSize: 11 }}>{m.provider}/{m.name}</Tag>
                        ))}
                      </div>
                    )}
                  </Card>
                </Col>
              );
            })}
          </Row>
        </Card>
      )}

      {/* Provider Drawer (Add / Edit) */}
      <Drawer
        title={isEditing ? t('models.editModel') : t('models.addModel')}
        open={drawerOpen} onClose={() => setDrawerOpen(false)} width={800} maskClosable={false}
        style={{ borderRadius: '12px 0 0 12px' }}
        styles={{ body: { padding: '16px 24px' }, header: { borderRadius: '12px 0 0 0', borderBottom: '1px solid var(--colorBorderSecondary)' } }}
        extra={<Button type="primary" loading={formSaving} onClick={() => { void handleSaveProvider(); }}>{t('common.save')}</Button>}
      >
        <Form layout="vertical">
          <Form.Item label={t('models.modelName')}><Input value={formName} onChange={e => setFormName(e.target.value)} placeholder={t('models.modelNamePlaceholder')} /></Form.Item>
          <Form.Item label={t('models.apiKey')} help={isEditing ? t('models.apiKeyEditHint') : undefined}>
            <Input.Password value={formApiKey} onFocus={() => { if (isEditing && formApiKey.includes('•')) setFormApiKey(''); }} onChange={e => setFormApiKey(e.target.value)} placeholder={isEditing ? t('models.apiKeyEditPlaceholder') : 'sk-...'} />
          </Form.Item>
          <Form.Item label={t('models.baseUrl')}><Input value={formBaseUrl} onChange={e => setFormBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" /></Form.Item>
          <Form.Item label={t('models.protocol')}><Select value={formProtocol} onChange={setFormProtocol} options={PROTOCOL_OPTIONS} /></Form.Item>
          <Form.Item label="直连端点"><Checkbox checked={formDirect} onChange={e => setFormDirect(e.target.checked)}>Base URL 是完整接口地址</Checkbox></Form.Item>
          <Form.Item label="多模态能力">
            <Checkbox.Group value={CAPABILITY_OPTIONS.filter(o => formCapabilities[o.key]).map(o => o.key)}
              options={CAPABILITY_OPTIONS.map(o => ({ label: o.label, value: o.key }))}
              onChange={values => setFormCapabilities(Object.fromEntries(CAPABILITY_OPTIONS.map(o => [o.key, values.includes(o.key)])))} />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
