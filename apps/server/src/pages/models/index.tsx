// cSpell:ignore BAAI Popconfirm hoverable
import { useEffect, useState } from 'react';
import { useAppTranslations } from '@/components/Layout';
import { PageHeader } from '@/components/PageHeader';
import { Button, Tag, Drawer, Input, Select, Space, Popconfirm, Form, App, InputNumber, Checkbox, Skeleton, Switch } from 'antd';
import { PlusOutlined, DeleteOutlined, ApiOutlined, KeyOutlined, GlobalOutlined, EditOutlined, CheckCircleFilled, CloseCircleFilled, ThunderboltOutlined, SettingOutlined } from '@ant-design/icons';
import { getProviders, getModels, saveProvider, deleteProvider, saveModels, healthCheck, getProviderDetail, getEmbeddingConfig, saveEmbeddingConfig, embeddingHealthCheck, getWebAccessConfig, saveWebAccessConfig, type ProviderInfo, type ModelsConfig, type EmbeddingConfig, type ModelCapabilities, type WebAccessConfig } from '@/lib/api';

const PROTOCOL_OPTIONS = [
  { labelKey: 'models.openAICompatible', value: 'openai' }, { labelKey: 'models.anthropic', value: 'anthropic' }, { labelKey: 'models.google', value: 'google' },
  { labelKey: 'models.ollama', value: 'ollama' }, { labelKey: 'models.openRouter', value: 'openrouter' },
];
const TIERS = [
  { key: 'reader', labelKey: 'models.tierReader', descKey: 'models.tierReaderDesc' },
  { key: 'reasoning', labelKey: 'models.tierReasoning', descKey: 'models.tierReasoningDesc' },
  { key: 'action', labelKey: 'models.tierAction', descKey: 'models.tierActionDesc' },
] as const;
const CAPABILITY_OPTIONS: Array<{ key: keyof ModelCapabilities; labelKey: string }> = [
  { key: 'imageGeneration', labelKey: 'models.imageGeneration' }, { key: 'imageUnderstanding', labelKey: 'models.imageUnderstanding' },
  { key: 'fileUnderstanding', labelKey: 'models.fileUnderstanding' }, { key: 'audio', labelKey: 'models.audioCapability' }, { key: 'video', labelKey: 'models.videoCapability' },
];
const DEFAULT_WEB_ACCESS: WebAccessConfig = { enabled: false, allowProjectFacts: false, maxQueriesPerChapter: 2, maxResultsPerQuery: 3, trustedDomains: [] };

export default function ModelsPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelsConfig | null>(null);
  const [embedding, setEmbedding] = useState<EmbeddingConfig>({ provider: 'transformers-local', model: 'BAAI/bge-small-zh-v1.5', dimensions: 512 });
  const [webAccess, setWebAccess] = useState<WebAccessConfig>(DEFAULT_WEB_ACCESS);
  const [webAccessSaving, setWebAccessSaving] = useState(false);
  const [embeddingSaving, setEmbeddingSaving] = useState(false);
  const [embeddingTesting, setEmbeddingTesting] = useState(false);
  const [embeddingTestResult, setEmbeddingTestResult] = useState<boolean | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, boolean | null>>({});

  // 共享抽屉
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTarget, setEditTarget] = useState('');
  const [formName, setFormName] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formProtocol, setFormProtocol] = useState('openai');
  const [formDirect, setFormDirect] = useState(false);
  const [formCapabilities, setFormCapabilities] = useState<ModelCapabilities>({});
  const [formWebEnhancement, setFormWebEnhancement] = useState(false);
  const [formSaving, setFormSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [p, m, e, w] = await Promise.all([
        getProviders().catch(() => []), getModels().catch(() => null),
        getEmbeddingConfig().catch(() => ({ provider: 'transformers-local' as const, model: 'BAAI/bge-small-zh-v1.5', dimensions: 512 })),
        getWebAccessConfig().catch(() => DEFAULT_WEB_ACCESS),
      ]);
      setProviders(p); setModels(m); setEmbedding(e); setWebAccess(w);
    } catch { message.error(t('common.error')); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const openAddDrawer = () => {
    setIsEditing(false); setEditTarget('');
    setFormName(''); setFormApiKey(''); setFormBaseUrl(''); setFormProtocol('openai');
    setFormDirect(false); setFormCapabilities({});
    setFormWebEnhancement(false);
    setDrawerOpen(true);
  };

  const openEditDrawer = async (p: ProviderInfo) => {
    setIsEditing(true); setEditTarget(p.name);
    setFormName(p.name); setFormApiKey(''); setFormBaseUrl(p.baseUrl || '');
    setFormProtocol(p.protocol || p.detectedProtocol || 'openai'); setFormCapabilities(p.capabilities || {});
    setFormWebEnhancement(Boolean((p.capabilities as any)?.webSearch));
    try {
      const detail = await getProviderDetail(p.name);
      setFormApiKey(detail.apiKey ? '••••••••' : '');
      setFormBaseUrl(detail.baseUrl || ''); setFormCapabilities(detail.capabilities || {});
      setFormWebEnhancement(Boolean((detail.capabilities as any)?.webSearch));
    } catch { /* use existing */ }
    setDrawerOpen(true);
  };

  const handleSaveProvider = async () => {
    if (!formName.trim()) return; setFormSaving(true);
    try {
      const apiKey = isEditing && formApiKey.includes('•') ? undefined : formApiKey || undefined;
      const combinedCapabilities = { ...formCapabilities, webSearch: formWebEnhancement };
      await saveProvider(formName.trim(), { oldName: isEditing ? editTarget : undefined, apiKey, baseUrl: formBaseUrl || undefined, protocol: formProtocol, directEndpoint: formDirect, capabilities: combinedCapabilities });
      setDrawerOpen(false); await load(); message.success(t('common.success'));
    } catch { message.error(t('common.error')); } finally { setFormSaving(false); }
  };

  const handleDelete = async (n: string) => { try { await deleteProvider(n); await load(); message.success(t('common.success')); } catch { message.error(t('common.error')); } };
  const handleTest = async (n: string) => {
    setTesting(n);
    try {
      const r = await healthCheck(n);
      setResults(p => ({ ...p, [n]: r.success }));
      const detail = r.success ? t('models.connected') : `${t('models.connectionFailed')}${r.message ? `：${r.message}` : ''}${r.requestId ? ` (${r.requestId})` : ''}`;
      message[r.success ? 'success' : 'error'](detail);
    }
    catch (error) {
      setResults(p => ({ ...p, [n]: false }));
      message.error(error instanceof Error ? error.message : t('models.connectionFailed'));
    } finally { setTesting(null); }
  };
  const handleModelChange = async (tier: string, val: string | undefined) => {
    if (!models) return;
    const updated = { ...models };
    const tc = updated[tier as keyof ModelsConfig];
    if (!val) { tc.active = ''; setModels(updated); try { await saveModels(updated); } catch { message.error(t('common.error')); } return; }
    const [provider, name] = val.includes(':') ? val.split(':') : [val, val];
    tc.active = name;
    if (!tc.list.some(m => m.name === name && m.provider === provider)) tc.list.push({ name, provider, thinking: 'follow-task' });
    setModels(updated);
    try { await saveModels(updated); } catch { message.error(t('common.error')); }
  };
  const handleThinkingChange = async (tier: string, val: 'follow-task' | 'enabled' | 'disabled') => {
    if (!models) return;
    const updated = { ...models };
    const tc = updated[tier as keyof ModelsConfig];
    const target = tc.list.find(m => m.name === tc.active);
    if (!target) return;
    target.thinking = val;
    setModels(updated);
    try { await saveModels(updated); } catch { message.error(t('common.error')); }
  };
  const handleEmbeddingSave = async () => { setEmbeddingSaving(true); try { const s = await saveEmbeddingConfig(embedding); setEmbedding(s); setEmbeddingTestResult(null); message.success(t('common.success')); } catch { message.error(t('common.error')); } finally { setEmbeddingSaving(false); } };
  const handleEmbeddingTest = async () => { setEmbeddingTesting(true); try { const r = await embeddingHealthCheck(); setEmbeddingTestResult(r.success); message[r.success ? 'success' : 'error'](r.message || (r.success ? t('models.connected') : t('models.connectionFailed'))); } catch { setEmbeddingTestResult(false); } finally { setEmbeddingTesting(false); } };
  const handleWebAccessSave = async (next: WebAccessConfig) => {
    setWebAccess(next); setWebAccessSaving(true);
    try { const saved = await saveWebAccessConfig(next); setWebAccess(saved); message.success(t('common.success')); }
    catch { setWebAccess(webAccess); message.error(t('common.error')); }
    finally { setWebAccessSaving(false); }
  };

  if (loading) return (
    <div className="space-y-6">
      <Skeleton active title paragraph={{ rows: 1 }} />
      <div className="p-4 bg-[var(--colorBgHover)] rounded-xl border border-[var(--borderColor)]"><Skeleton active paragraph={{ rows: 6 }} /></div>
      <div className="p-4 bg-[var(--colorBgHover)] rounded-xl border border-[var(--borderColor)]"><Skeleton active paragraph={{ rows: 4 }} /></div>
      <div className="p-4 bg-[var(--colorBgHover)] rounded-xl border border-[var(--borderColor)]"><Skeleton active paragraph={{ rows: 3 }} /></div>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('models.title')}
        description={t('models.description')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openAddDrawer}>
            {t('models.addModel')}
          </Button>
        }
      />

      {/* 供应商列表 */}
      <div>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-base font-semibold text-[var(--colorText)] tracking-wide">{t('models.modelList')} <span className="text-[var(--colorTextTertiary)] ml-2 font-normal">({providers.length})</span></h2>
        </div>
        {providers.length === 0 ? <div className="text-center py-12 bg-[var(--colorBgHover)] rounded-2xl border border-dashed border-[var(--borderColorStrong)] text-[var(--colorTextTertiary)] text-sm">{t('models.noProviders')}</div> : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {providers.map(p => (
              <div key={p.name} className="group p-5 rounded-2xl border border-transparent hover:border-[var(--borderColorStrong)] bg-[var(--colorBgContainer)] hover:bg-[var(--colorBgHover)] hover:shadow-sm flex flex-col cursor-pointer transition-all duration-300">
                <div className="flex items-start justify-between gap-3 mb-4 min-w-0">
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-base text-[var(--colorText)] truncate mb-1">{p.name}</div>
                    <div className="text-xs text-[var(--colorTextTertiary)] flex items-center gap-1 uppercase tracking-wider font-semibold">
                      <ThunderboltOutlined /> {p.protocol || p.detectedProtocol || 'openai'}
                    </div>
                  </div>
                  <Space size={0} className="-mr-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button type="text" size="small" loading={testing === p.name} onClick={(e) => { e.stopPropagation(); void handleTest(p.name); }}
                      icon={results[p.name] === true ? <CheckCircleFilled className="text-[var(--colorOk)]" /> : results[p.name] === false ? <CloseCircleFilled className="text-[var(--colorDanger)]" /> : <ApiOutlined className="text-[var(--colorTextSecondary)]" />} />
                    <Button type="text" size="small" icon={<EditOutlined className="text-[var(--colorTextSecondary)]" />} onClick={(e) => { e.stopPropagation(); void openEditDrawer(p); }} />
                    <Popconfirm title={t('models.deleteProviderConfirm')} onConfirm={(e) => { e?.stopPropagation(); void handleDelete(p.name); }} onCancel={(e) => e?.stopPropagation()}>
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                    </Popconfirm>
                  </Space>
                </div>
                <div className="flex flex-col gap-3 mt-auto pt-4 border-t border-[var(--borderColor)]">
                  <div className="flex items-center justify-between text-xs text-[var(--colorTextSecondary)]">
                    <span className="flex items-center gap-1"><KeyOutlined /> {t('models.apiKey')}</span>
                    <span className="font-mono text-[var(--colorTextTertiary)]">{p.hasApiKey ? '••••••••' : t('models.none')}</span>
                  </div>
                  {p.baseUrl && (
                    <div className="flex items-center justify-between text-xs text-[var(--colorTextSecondary)]">
                      <span className="flex items-center gap-1"><GlobalOutlined /> URL</span>
                      <span className="truncate max-w-[120px] font-mono text-[var(--colorTextTertiary)]" title={p.baseUrl}>{p.baseUrl.replace(/^https?:\/\//, '')}</span>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1 mt-2">
                    {CAPABILITY_OPTIONS.filter(o => p.capabilities?.[o.key]).map(o => <Tag key={o.key} color="blue" bordered={false} className="m-0 text-[10px] bg-[var(--colorBrand)]/5 text-[var(--colorBrand)] leading-[18px]">{t(o.labelKey)}</Tag>)}
                    {(p.capabilities as any)?.webSearch && <Tag color="green" bordered={false} className="m-0 text-[10px] leading-[18px]">{t('models.webEnhancement')}</Tag>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>


      {/* 嵌入配置 - 沉浸式网格 */}
      <div>
        <h2 className="text-base font-semibold text-[var(--colorText)] tracking-wide mb-6">{t('models.embeddingConfig')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider mb-2 text-[var(--colorTextTertiary)]">{t('models.embeddingProvider')}</div>
            <Select value={embedding.provider} className="w-full h-10" variant="borderless"
              style={{ background: 'var(--colorBgHover)', borderRadius: '8px' }}
              options={[{ label: t('models.localRecommended'), value: 'transformers-local' }, { label: t('models.externalAdvanced'), value: 'openai-compatible' }]}
              onChange={v => setEmbedding(prev => ({ ...prev, provider: v as EmbeddingConfig['provider'], model: v === 'transformers-local' ? (prev.model || 'BAAI/bge-small-zh-v1.5') : prev.model, dimensions: v === 'transformers-local' ? 512 : (prev.dimensions || 1024) }))} />
          </div>
          {embedding.provider === 'openai-compatible' && (
            <>
              <div><div className="text-xs font-semibold uppercase tracking-wider mb-2 text-[var(--colorTextTertiary)]">{t('models.baseUrl')}</div><Input className="h-10 px-4 bg-[var(--colorBgHover)]" value={embedding.baseUrl} onChange={e => setEmbedding(p => ({ ...p, baseUrl: e.target.value }))} placeholder="http://localhost:11434/v1" /></div>
              <div><div className="text-xs font-semibold uppercase tracking-wider mb-2 text-[var(--colorTextTertiary)]">{t('models.model')}</div><Input className="h-10 px-4 bg-[var(--colorBgHover)]" value={embedding.model} onChange={e => setEmbedding(p => ({ ...p, model: e.target.value }))} placeholder="bge-m3" /></div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider mb-2 text-[var(--colorTextTertiary)]">{t('models.apiKey')}</div>
                <Input.Password className="h-10 px-4 bg-[var(--colorBgHover)]" value={embedding.apiKey} onFocus={() => { if (embedding.apiKey?.includes('•')) setEmbedding(p => ({ ...p, apiKey: '' })); }} onChange={e => setEmbedding(p => ({ ...p, apiKey: e.target.value }))} placeholder={t('models.optional')} />
              </div>
            </>
          )}
          {embedding.provider === 'transformers-local' && (
            <div><div className="text-xs font-semibold uppercase tracking-wider mb-2 text-[var(--colorTextTertiary)]">{t('models.model')}</div><Input className="h-10 px-4 bg-[var(--colorBgHover)]" value={embedding.model} onChange={e => setEmbedding(p => ({ ...p, model: e.target.value }))} placeholder="BAAI/bge-small-zh-v1.5" /></div>
          )}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider mb-2 text-[var(--colorTextTertiary)]">{t('models.dimensions')}</div>
            <InputNumber className="w-full h-10 px-2 bg-[var(--colorBgHover)] border-transparent flex items-center" min={1} value={embedding.dimensions} onChange={v => setEmbedding(p => ({ ...p, dimensions: Number(v || (p.provider === 'transformers-local' ? 512 : 1024)) }))} />
          </div>
        </div>
        <div className="mt-8 flex gap-3">
          <Button type="primary" className="h-10 px-6 font-medium shadow-none" loading={embeddingSaving} onClick={() => { void handleEmbeddingSave(); }}>{t('models.saveEmbedding')}</Button>
          <Button className="h-10 px-6 font-medium shadow-none bg-[var(--colorBgHover)] border-transparent hover:border-[var(--borderColorStrong)]" loading={embeddingTesting} onClick={() => { void handleEmbeddingTest(); }}>{t('models.testEmbedding')}</Button>
          <div className="ml-auto flex items-center h-10 gap-2">
            <Tag color="blue" bordered={false} className="m-0 bg-[var(--colorBgHover)] text-[var(--colorTextSecondary)]">{embedding.provider === 'transformers-local' ? t('models.localEmbedding') : t('models.openAICompatible')}</Tag>
            {embeddingTestResult === true && <Tag color="success" bordered={false} className="m-0" icon={<CheckCircleFilled />}>{t('models.connected')}</Tag>}
            {embeddingTestResult === false && <Tag color="error" bordered={false} className="m-0" icon={<CloseCircleFilled />}>{t('models.connectionFailed')}</Tag>}
          </div>
        </div>
      </div>


      {/* 模型层级 */}
      {models && (
        <>
          <div className="mb-6">
            <h2 className="text-base font-semibold text-[var(--colorText)] tracking-wide mb-6">{t('models.modelTiers')}</h2>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              {TIERS.map(({ key, labelKey, descKey }) => {
                const tier = models[key as keyof ModelsConfig];
                const tierOpts = tier.list.map(m => ({ label: `${m.provider} / ${m.name}`, value: `${m.provider}:${m.name}` }));
                const newOpts = providers.filter(p => !tier.list.some(m => m.provider === p.name)).map(p => ({ label: p.name, value: `${p.name}:${p.name}` }));
                const activeModel = tier.active ? tier.list.find(m => m.name === tier.active) : null;
                return (
                  <div key={key} className="p-6 bg-[var(--colorBgHover)] rounded-xl flex flex-col transition-colors border border-transparent hover:border-[var(--borderColorStrong)]">
                    <div className="text-sm font-semibold text-[var(--colorText)] uppercase tracking-wider mb-2">{t(labelKey)}</div>
                    <div className="text-xs text-[var(--colorTextTertiary)] mb-5 leading-relaxed flex-1">{t(descKey)}</div>
                    <Select value={tier.active ? `${activeModel?.provider || ''}:${tier.active}` : undefined}
                      onChange={v => { void handleModelChange(key, v); }} allowClear placeholder={t('models.selectModelPlaceholder')}
                      className="w-full h-10" variant="borderless" style={{ background: 'var(--colorBgElevated)', borderRadius: '8px' }} options={[...tierOpts, ...newOpts]} />
                    {activeModel && (() => {
                      const prov = providers.find(p => p.name === activeModel.provider);
                      return (
                        <>
                          <div className="mt-4 px-4 py-3 bg-[var(--colorBgElevated)] rounded-lg border border-[var(--borderColor)] flex items-center gap-3 transition-colors">
                            <ApiOutlined className="text-[var(--colorBrand)] text-base shrink-0" />
                            <span className="text-sm font-medium flex-1 min-w-0 truncate text-[var(--colorText)]">
                              {activeModel.provider}
                            </span>
                            {prov?.capabilities && CAPABILITY_OPTIONS.filter(o => prov.capabilities![o.key]).length > 0 && (
                              <div className="flex gap-1 shrink-0">
                                {CAPABILITY_OPTIONS.filter(o => prov.capabilities![o.key]).slice(0, 2).map(o => (
                                  <Tag key={o.key} color="blue" bordered={false} className="m-0 text-[10px] bg-[var(--colorBrand)]/5 text-[var(--colorBrand)] leading-[18px]">{t(o.labelKey)}</Tag>
                                ))}
                              </div>
                            )}
                            <Tag color="success" bordered={false} className="m-0 text-[10px] leading-[18px] shrink-0 uppercase">{t('models.active')}</Tag>
                          </div>
                          <div className="mt-3 flex items-center gap-3">
                            <span className="text-xs text-[var(--colorTextTertiary)] shrink-0">{t('models.thinkingMode')}</span>
                            <Select value={activeModel.thinking ?? 'follow-task'} size="small" style={{ flex: 1 }}
                              onChange={v => { void handleThinkingChange(key, v); }}
                              options={[
                                { label: t('models.thinkingFollowTask'), value: 'follow-task' },
                                { label: t('models.thinkingEnabled'), value: 'enabled' },
                                { label: t('models.thinkingDisabled'), value: 'disabled' },
                              ]} />
                          </div>
                        </>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* 供应商抽屉（添加 / 编辑） */}
      <Drawer
        title={isEditing ? t('models.editModel') : t('models.addModel')}
        open={drawerOpen} onClose={() => setDrawerOpen(false)}
        size="large"
        styles={{ body: { padding: '24px 32px' }, header: { padding: '16px 32px', borderBottom: '1px solid var(--colorBorderSecondary)' } }}
        extra={<Button type="primary" loading={formSaving} onClick={() => { void handleSaveProvider(); }}>{t('common.save')}</Button>}
      >
        <Form layout="vertical">
          <Form.Item label={t('models.modelName')}><Input value={formName} onChange={e => setFormName(e.target.value)} placeholder={t('models.modelNamePlaceholder')} /></Form.Item>
          <Form.Item label={t('models.apiKey')} help={isEditing ? t('models.apiKeyEditHint') : undefined}>
            <Input.Password value={formApiKey} onFocus={() => { if (isEditing && formApiKey.includes('•')) setFormApiKey(''); }} onChange={e => setFormApiKey(e.target.value)} placeholder={isEditing ? t('models.apiKeyEditPlaceholder') : 'sk-...'} />
          </Form.Item>
          <Form.Item label={t('models.baseUrl')}><Input value={formBaseUrl} onChange={e => setFormBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" /></Form.Item>
          <Form.Item label={t('models.protocol')}><Select value={formProtocol} onChange={setFormProtocol} options={PROTOCOL_OPTIONS.map(option => ({ label: t(option.labelKey), value: option.value }))} /></Form.Item>
          <Form.Item label={t('models.directEndpoint')}><Checkbox checked={formDirect} onChange={e => setFormDirect(e.target.checked)}>{t('models.directEndpointDesc')}</Checkbox></Form.Item>
          <Form.Item label={t('models.webEnhancement')}>
            <Switch checked={formWebEnhancement} onChange={setFormWebEnhancement} />
            <span className="ml-3 text-xs text-[var(--colorTextSecondary)]">{t('models.webEnhancementDesc')}</span>
          </Form.Item>
          <Form.Item label={t('models.capabilities')}>
            <Checkbox.Group value={CAPABILITY_OPTIONS.filter(o => formCapabilities[o.key]).map(o => o.key)}
              options={CAPABILITY_OPTIONS.map(o => ({ label: t(o.labelKey), value: o.key }))}
              onChange={values => setFormCapabilities(Object.fromEntries(CAPABILITY_OPTIONS.map(o => [o.key, values.includes(o.key)])))} />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
