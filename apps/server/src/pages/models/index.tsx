import { useEffect, useState } from 'react';
import { useAppTranslations } from '@/components/Layout';
import { Card, Button, Tag, Modal, Input, Select, Row, Col, Space, Popconfirm, Form, App, InputNumber, Alert, Checkbox } from 'antd';
import { PlusOutlined, DeleteOutlined, ApiOutlined, KeyOutlined, GlobalOutlined, EditOutlined, CheckCircleFilled, CloseCircleFilled, ThunderboltOutlined } from '@ant-design/icons';
import { getProviders, getModels, saveProvider, deleteProvider, saveModels, healthCheck, getProviderDetail, getEmbeddingConfig, saveEmbeddingConfig, embeddingHealthCheck, type ProviderInfo, type ModelsConfig, type EmbeddingConfig, type ModelCapabilities } from '@/lib/api';
import styles from './style.module.scss';

const PROTOCOL_OPTIONS = [
  { label: 'OpenAI 兼容', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'Google', value: 'google' },
  { label: 'Ollama', value: 'ollama' },
  { label: 'OpenRouter', value: 'openrouter' },
];
const TIERS = [
  { key: 'reader', labelKey: 'models.tierReader', descKey: 'models.tierReaderDesc' },
  { key: 'reasoning', labelKey: 'models.tierReasoning', descKey: 'models.tierReasoningDesc' },
  { key: 'action', labelKey: 'models.tierAction', descKey: 'models.tierActionDesc' },
] as const;

const CAPABILITY_OPTIONS: Array<{ key: keyof ModelCapabilities; label: string }> = [
  { key: 'imageGeneration', label: '图片生成' },
  { key: 'imageUnderstanding', label: '图片理解' },
  { key: 'fileUnderstanding', label: '文件理解' },
  { key: 'audio', label: '音频能力' },
  { key: 'video', label: '视频能力' },
];

export default function ModelsPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const embeddingProviderOptions = [
    { label: t('models.embeddingProviderHash'), value: 'hash' },
    { label: t('models.embeddingProviderOpenAI'), value: 'openai-compatible' },
  ];
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelsConfig | null>(null);
  const [embedding, setEmbedding] = useState<EmbeddingConfig>({ provider: 'hash', dimensions: 384 });
  const [embeddingSaving, setEmbeddingSaving] = useState(false);
  const [embeddingTesting, setEmbeddingTesting] = useState(false);
  const [embeddingTestResult, setEmbeddingTestResult] = useState<boolean | null>(null);

  // 添加弹窗
  const [addOpen, setAddOpen] = useState(false);
  const [newModelName, setNewModelName] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [newProtocol, setNewProtocol] = useState<string>('openai');
  const [newDirectEndpoint, setNewDirectEndpoint] = useState(false);
  const [newCapabilities, setNewCapabilities] = useState<ModelCapabilities>({});
  const [saving, setSaving] = useState(false);

  // 编辑弹窗
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<string>('');
  const [editModelName, setEditModelName] = useState('');
  const [editApiKey, setEditApiKey] = useState('');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editProtocol, setEditProtocol] = useState<string>('openai');
  const [editDirectEndpoint, setEditDirectEndpoint] = useState(false);
  const [editCapabilities, setEditCapabilities] = useState<ModelCapabilities>({});
  const [editSaving, setEditSaving] = useState(false);

  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, boolean | null>>({});

  const load = async () => {
    setLoading(true);
    try {
      const [p, m, e] = await Promise.all([getProviders().catch(() => []), getModels().catch(() => null), getEmbeddingConfig().catch(() => ({ provider: 'hash' as const, dimensions: 384 }))]);
      setProviders(p); setModels(m); setEmbedding(e);
    }
    catch { message.error(t('common.error')); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  // ── 添加 ──
  const handleAdd = async () => {
    if (!newModelName.trim()) return; setSaving(true);
    try {
      await saveProvider(newModelName.trim(), { apiKey: newApiKey || undefined, baseUrl: newBaseUrl || undefined, protocol: newProtocol, directEndpoint: newDirectEndpoint, capabilities: newCapabilities });
      setAddOpen(false); setNewModelName(''); setNewApiKey(''); setNewBaseUrl(''); setNewProtocol('openai'); setNewDirectEndpoint(false); setNewCapabilities({});
      await load(); message.success(t('common.success'));
    }
    catch { message.error(t('common.error')); } finally { setSaving(false); }
  };

  // ── 删除 ──
  const handleDelete = async (n: string) => { try { await deleteProvider(n); await load(); message.success(t('common.success')); } catch { message.error(t('common.error')); } };

  // ── 编辑 ──
  const openEdit = async (p: ProviderInfo) => {
    setEditTarget(p.name);
    setEditModelName(p.name);
    setEditApiKey('');
    try {
      const detail = await getProviderDetail(p.name);
      setEditApiKey(detail.apiKey ? '••••••••' : '');
      setEditBaseUrl(detail.baseUrl || '');
      setEditProtocol(detail.protocol || detail.detectedProtocol || 'openai');
      setEditCapabilities(detail.capabilities || {});
    } catch {
      setEditBaseUrl(p.baseUrl || '');
      setEditProtocol(p.protocol || p.detectedProtocol || 'openai');
      setEditCapabilities(p.capabilities || {});
    }
    setEditOpen(true);
  };
  const handleEdit = async () => {
    if (!editModelName.trim()) return; setEditSaving(true);
    try {
      const apiKey = editApiKey.includes('•') ? undefined : editApiKey || undefined;
      await saveProvider(editModelName.trim(), { oldName: editTarget, apiKey, baseUrl: editBaseUrl || undefined, protocol: editProtocol, directEndpoint: editDirectEndpoint, capabilities: editCapabilities });
      setEditOpen(false); setEditTarget(''); setEditModelName(''); setEditApiKey(''); setEditBaseUrl(''); setEditProtocol('openai'); setEditDirectEndpoint(false); setEditCapabilities({});
      await load(); message.success(t('common.success'));
    }
    catch { message.error(t('common.error')); } finally { setEditSaving(false); }
  };

  // ── 测试连接 ──
  const handleTest = async (n: string) => {
    setTesting(n);
    try { const r = await healthCheck(n); setResults((p) => ({ ...p, [n]: r.success })); message[r.success ? 'success' : 'error'](r.success ? t('models.connected') : t('models.connectionFailed')); }
    catch { setResults((p) => ({ ...p, [n]: false })); } finally { setTesting(null); }
  };

  const handleEmbeddingSave = async () => {
    setEmbeddingSaving(true);
    try {
      const saved = await saveEmbeddingConfig(embedding);
      setEmbedding(saved);
      setEmbeddingTestResult(null);
      message.success(t('common.success'));
    } catch { message.error(t('common.error')); } finally { setEmbeddingSaving(false); }
  };

  const handleEmbeddingTest = async () => {
    setEmbeddingTesting(true);
    try {
      const result = await embeddingHealthCheck();
      setEmbeddingTestResult(result.success);
      message[result.success ? 'success' : 'error'](result.message || (result.success ? t('models.connected') : t('models.connectionFailed')));
    } catch { setEmbeddingTestResult(false); message.error(t('common.error')); } finally { setEmbeddingTesting(false); }
  };

  // ── 层级分配 ──
  const handleModelChange = async (tier: string, val: string | undefined) => {
    if (!models) return;
    const updated = { ...models };
    const tc = updated[tier as keyof ModelsConfig];

    if (!val) {
      tc.active = '';
      setModels(updated);
      try { await saveModels(updated); } catch { message.error(t('common.error')); }
      return;
    }

    const colonIdx = val.indexOf(':');
    const provider = colonIdx >= 0 ? val.slice(0, colonIdx) : val;
    const name = colonIdx >= 0 ? val.slice(colonIdx + 1) : val;
    tc.active = name;
    if (!tc.list.some((m) => m.name === name && m.provider === provider)) {
      tc.list.push({ name, provider });
    }
    setModels(updated);
    try { await saveModels(updated); } catch { message.error(t('common.error')); }
  };

  return (
    <div className="space-y-6 animateFadeIn">
      <div className="flex items-center justify-between">
        <div><h1 className="pageTitle">{t('models.title')}</h1><p className="pageDesc">{t('models.description')}</p></div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>{t('models.addModel')}</Button>
      </div>

      <Card title={t('models.modelList')} size="small" loading={loading}>
        {providers.length === 0 ? <span className={styles.cardMeta}>{t('models.noProviders')}</span> : (
          <Row gutter={[12, 12]} align="stretch">
            {providers.map((p, index) => (
              <Col key={p.name} xs={24} sm={12} lg={8} xl={6} className={styles.providerGrid}>
                <Card size="small" className={styles.providerCard}>
                  <div className={styles.cardAction}>
                    <div className={styles.cardMain}><div className={styles.cardName} title={p.name}><Tag>序号 {index + 1}</Tag>{p.name}</div><div className={styles.cardMeta}><ThunderboltOutlined /> {p.protocol || p.detectedProtocol || 'openai'}</div></div>
                    <Space size={2} wrap={false}>
                      <Button size="small" type="text" loading={testing === p.name} onClick={() => { void handleTest(p.name); }}
                        icon={results[p.name] === true ? <CheckCircleFilled className="text-[var(--colorOk)]" /> : results[p.name] === false ? <CloseCircleFilled className="text-[var(--colorDanger)]" /> : <ApiOutlined />} />
                      <Button size="small" type="text" icon={<EditOutlined />} onClick={() => { void openEdit(p); }} />
                      <Popconfirm title={t('models.deleteProviderConfirm')} onConfirm={() => { void handleDelete(p.name); }}>
                        <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className={`${styles.cardMeta} text-xs`}><KeyOutlined /> {p.hasApiKey ? '••••••••' : '—'}</span>
                    {p.baseUrl && <span className={`${styles.cardMeta} ${styles.urlLine} text-xs`} title={p.baseUrl}><GlobalOutlined /> {p.baseUrl}</span>}
                    <Space size={[4, 4]} wrap>
                      {CAPABILITY_OPTIONS.filter(option => p.capabilities?.[option.key]).map(option => <Tag key={option.key} color="purple">{option.label}</Tag>)}
                    </Space>
                  </div>
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </Card>

      <Card title={t('models.embeddingConfig')} size="small" loading={loading}>
        <Alert className="mb-4" type="info" showIcon message={t('models.embeddingHint')} />
        <Form layout="vertical" size="middle">
          <Row gutter={[12, 12]}>
            <Col xs={24} lg={8}>
              <Form.Item label={t('models.embeddingProvider')}>
                <Select
                  value={embedding.provider}
                  options={embeddingProviderOptions}
                  onChange={(provider) => setEmbedding(prev => ({ ...prev, provider, dimensions: provider === 'hash' ? 384 : (prev.dimensions || 1024) }))}
                />
              </Form.Item>
            </Col>
            {embedding.provider === 'openai-compatible' && (
              <>
                <Col xs={24} lg={8}>
                  <Form.Item label="Base URL">
                    <Input value={embedding.baseUrl} onChange={(e) => setEmbedding(prev => ({ ...prev, baseUrl: e.target.value }))} placeholder="http://localhost:11434/v1" />
                  </Form.Item>
                </Col>
                <Col xs={24} lg={8}>
                  <Form.Item label={t('models.model')}>
                    <Input value={embedding.model} onChange={(e) => setEmbedding(prev => ({ ...prev, model: e.target.value }))} placeholder="bge-m3" />
                  </Form.Item>
                </Col>
                <Col xs={24} lg={8}>
                  <Form.Item label={t('models.apiKey')} help={embedding.hasApiKey ? t('models.embeddingApiKeyHint') : undefined}>
                    <Input.Password value={embedding.apiKey} onFocus={() => { if (embedding.apiKey?.includes('•')) setEmbedding(prev => ({ ...prev, apiKey: '' })); }} onChange={(e) => setEmbedding(prev => ({ ...prev, apiKey: e.target.value }))} placeholder={t('models.optional')} />
                  </Form.Item>
                </Col>
              </>
            )}
            <Col xs={24} lg={8}>
              <Form.Item label={t('models.dimensions')}>
                <InputNumber className="w-full" min={1} value={embedding.dimensions} onChange={(value) => setEmbedding(prev => ({ ...prev, dimensions: Number(value || (prev.provider === 'hash' ? 384 : 1024)) }))} />
              </Form.Item>
            </Col>
            <Col xs={24} lg={8}>
              <Form.Item label={t('models.status')}>
                <Space>
                  <Tag color={embedding.provider === 'hash' ? 'default' : 'blue'}>{embedding.provider === 'hash' ? t('models.localHash') : t('models.openAICompatible')}</Tag>
                  {embeddingTestResult === true && <Tag color="success">{t('models.connected')}</Tag>}
                  {embeddingTestResult === false && <Tag color="error">{t('models.connectionFailed')}</Tag>}
                </Space>
              </Form.Item>
            </Col>
          </Row>
          <Space>
            <Button type="primary" loading={embeddingSaving} onClick={() => { void handleEmbeddingSave(); }}>{t('models.saveEmbedding')}</Button>
            <Button icon={<ApiOutlined />} loading={embeddingTesting} onClick={() => { void handleEmbeddingTest(); }}>{t('models.testEmbedding')}</Button>
          </Space>
        </Form>
      </Card>

      {models && (
        <Card title={t('models.modelTiers')} size="small">
          <Row gutter={[12, 12]}>
            {TIERS.map(({ key, labelKey, descKey }) => {
              const tier = models[key as keyof ModelsConfig];
              const tierModelOpts = tier.list.map((m) => ({ label: `${m.provider} / ${m.name}`, value: `${m.provider}:${m.name}` }));
              const newProvOpts = providers
                .filter((p) => !tier.list.some((m) => m.provider === p.name))
                .map((p) => ({ label: `${p.name} / ${p.name}`, value: `${p.name}:${p.name}` }));
              return (
                <Col key={key} xs={24} lg={8}>
                  <Card size="small" title={t(labelKey)}>
                    <span className={styles.tierDesc}>{t(descKey)}</span>
                    <Select
                      value={tier.active ? `${tier.list.find((m) => m.name === tier.active)?.provider || ''}:${tier.active}` : undefined}
                      onChange={(v) => { void handleModelChange(key, v); }}
                      allowClear
                      placeholder={t('models.selectModelPlaceholder')}
                      className="w-full"
                      options={[...tierModelOpts, ...newProvOpts]}
                    />
                    {tier.list.length > 0 && <div className={styles.modelTags}>{tier.list.map((m) => <Tag key={`${m.provider}:${m.name}`} color={m.name === tier.active ? 'blue' : undefined} closable onClose={() => {
                      const updated = { ...models };
                      const tc = updated[key as keyof ModelsConfig];
                      tc.list = tc.list.filter((x) => !(x.name === m.name && x.provider === m.provider));
                      if (tc.active === m.name) tc.active = tc.list[0]?.name ?? '';
                      setModels(updated);
                      saveModels(updated).catch(() => message.error(t('common.error')));
                    }}>{m.provider}/{m.name}</Tag>)}</div>}
                  </Card>
                </Col>
              );
            })}
          </Row>
        </Card>
      )}

      {/* 添加弹窗 */}
      <Modal maskClosable={false} title={t('models.addModel')} open={addOpen} onCancel={() => { setAddOpen(false); setNewModelName(''); setNewApiKey(''); setNewBaseUrl(''); setNewProtocol('openai'); setNewDirectEndpoint(false); }} onOk={() => { void handleAdd(); }} confirmLoading={saving}>
        <Form layout="vertical" size="middle">
          <Form.Item label={t('models.modelName')}><Input value={newModelName} onChange={(e) => setNewModelName(e.target.value)} placeholder={t('models.modelNamePlaceholder')} /></Form.Item>
          <Form.Item label={t('models.apiKey')}><Input.Password value={newApiKey} onChange={(e) => setNewApiKey(e.target.value)} placeholder="sk-..." /></Form.Item>
          <Form.Item label={t('models.baseUrl')}><Input value={newBaseUrl} onChange={(e) => setNewBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" /></Form.Item>
          <Form.Item label={t('models.protocol')}><Select value={newProtocol} onChange={setNewProtocol} options={PROTOCOL_OPTIONS} /></Form.Item>
          <Form.Item label="直连端点" tooltip="开启后 Base URL 会作为完整请求地址使用，不再自动拼接接口路径。"><Checkbox checked={newDirectEndpoint} onChange={(event) => setNewDirectEndpoint(event.target.checked)}>Base URL 是完整接口地址</Checkbox></Form.Item>
          <Form.Item label="多模态能力">
            <Checkbox.Group
              value={CAPABILITY_OPTIONS.filter(option => newCapabilities[option.key]).map(option => option.key)}
              options={CAPABILITY_OPTIONS.map(option => ({ label: option.label, value: option.key }))}
              onChange={(values) => setNewCapabilities(Object.fromEntries(CAPABILITY_OPTIONS.map(option => [option.key, values.includes(option.key)])))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑弹窗 */}
      <Modal maskClosable={false} title={t('models.editModel')} open={editOpen} onCancel={() => { setEditOpen(false); setEditTarget(''); setEditModelName(''); setEditApiKey(''); setEditBaseUrl(''); setEditProtocol('openai'); setEditDirectEndpoint(false); }} onOk={() => { void handleEdit(); }} confirmLoading={editSaving}>
        <Form layout="vertical" size="middle">
          <Form.Item label={t('models.modelName')}><Input value={editModelName} onChange={(e) => setEditModelName(e.target.value)} placeholder={t('models.modelNamePlaceholder')} /></Form.Item>
          <Form.Item label={t('models.apiKey')} help={t('models.apiKeyEditHint')}><Input.Password value={editApiKey} onFocus={() => { if (editApiKey.includes('•')) setEditApiKey(''); }} onCopy={(e) => e.preventDefault()} onChange={(e) => setEditApiKey(e.target.value)} placeholder={t('models.apiKeyEditPlaceholder')} /></Form.Item>
          <Form.Item label={t('models.baseUrl')}><Input value={editBaseUrl} onChange={(e) => setEditBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" /></Form.Item>
          <Form.Item label={t('models.protocol')}><Select value={editProtocol} onChange={setEditProtocol} options={PROTOCOL_OPTIONS} /></Form.Item>
          <Form.Item label="直连端点" tooltip="开启后 Base URL 会作为完整请求地址使用，不再自动拼接接口路径。"><Checkbox checked={editDirectEndpoint} onChange={(event) => setEditDirectEndpoint(event.target.checked)}>Base URL 是完整接口地址</Checkbox></Form.Item>
          <Form.Item label="多模态能力">
            <Checkbox.Group
              value={CAPABILITY_OPTIONS.filter(option => editCapabilities[option.key]).map(option => option.key)}
              options={CAPABILITY_OPTIONS.map(option => ({ label: option.label, value: option.key }))}
              onChange={(values) => setEditCapabilities(Object.fromEntries(CAPABILITY_OPTIONS.map(option => [option.key, values.includes(option.key)])))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
