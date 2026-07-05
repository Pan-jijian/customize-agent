import { useEffect, useState } from 'react';
import { useAppTranslations } from '@/components/Layout';
import { Card, Button, Tag, Modal, Input, Select, Row, Col, Space, Popconfirm, Form, App } from 'antd';
import { PlusOutlined, DeleteOutlined, ApiOutlined, KeyOutlined, GlobalOutlined, EditOutlined, CheckCircleFilled, CloseCircleFilled, ThunderboltOutlined } from '@ant-design/icons';
import { getProviders, getModels, saveProvider, deleteProvider, saveModels, healthCheck, getProviderDetail, type ProviderInfo, type ModelsConfig } from '@/lib/api';
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

export default function ModelsPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelsConfig | null>(null);

  // 添加弹窗
  const [addOpen, setAddOpen] = useState(false);
  const [newModelName, setNewModelName] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [newProtocol, setNewProtocol] = useState<string>('openai');
  const [saving, setSaving] = useState(false);

  // 编辑弹窗
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<string>('');
  const [editModelName, setEditModelName] = useState('');
  const [editApiKey, setEditApiKey] = useState('');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editProtocol, setEditProtocol] = useState<string>('openai');
  const [editSaving, setEditSaving] = useState(false);

  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, boolean | null>>({});

  const load = async () => {
    setLoading(true);
    try { const [p, m] = await Promise.all([getProviders().catch(() => []), getModels().catch(() => null)]); setProviders(p); setModels(m); }
    catch { message.error(t('common.error')); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  // ── 添加 ──
  const handleAdd = async () => {
    if (!newModelName.trim()) return; setSaving(true);
    try {
      await saveProvider(newModelName.trim(), { apiKey: newApiKey || undefined, baseUrl: newBaseUrl || undefined, protocol: newProtocol });
      setAddOpen(false); setNewModelName(''); setNewApiKey(''); setNewBaseUrl(''); setNewProtocol('openai');
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
    } catch {
      setEditBaseUrl(p.baseUrl || '');
      setEditProtocol(p.protocol || p.detectedProtocol || 'openai');
    }
    setEditOpen(true);
  };
  const handleEdit = async () => {
    if (!editModelName.trim()) return; setEditSaving(true);
    try {
      const apiKey = editApiKey.includes('•') ? undefined : editApiKey || undefined;
      await saveProvider(editModelName.trim(), { oldName: editTarget, apiKey, baseUrl: editBaseUrl || undefined, protocol: editProtocol });
      setEditOpen(false); setEditTarget(''); setEditModelName(''); setEditApiKey(''); setEditBaseUrl(''); setEditProtocol('openai');
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
            {providers.map((p) => (
              <Col key={p.name} xs={24} sm={12} lg={8} xl={6} className={styles.providerGrid}>
                <Card size="small" className={styles.providerCard}>
                  <div className={styles.cardAction}>
                    <div className={styles.cardMain}><div className={styles.cardName} title={p.name}>{p.name}</div><div className={styles.cardMeta}><ThunderboltOutlined /> {p.protocol || p.detectedProtocol || 'openai'}</div></div>
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
                  </div>
                </Card>
              </Col>
            ))}
          </Row>
        )}
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
      <Modal title={t('models.addModel')} open={addOpen} onCancel={() => { setAddOpen(false); setNewModelName(''); setNewApiKey(''); setNewBaseUrl(''); setNewProtocol('openai'); }} onOk={() => { void handleAdd(); }} confirmLoading={saving}>
        <Form layout="vertical" size="middle">
          <Form.Item label={t('models.modelName')}><Input value={newModelName} onChange={(e) => setNewModelName(e.target.value)} placeholder={t('models.modelNamePlaceholder')} /></Form.Item>
          <Form.Item label={t('models.apiKey')}><Input.Password value={newApiKey} onChange={(e) => setNewApiKey(e.target.value)} placeholder="sk-..." /></Form.Item>
          <Form.Item label={t('models.baseUrl')}><Input value={newBaseUrl} onChange={(e) => setNewBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" /></Form.Item>
          <Form.Item label={t('models.protocol')}><Select value={newProtocol} onChange={setNewProtocol} options={PROTOCOL_OPTIONS} /></Form.Item>
        </Form>
      </Modal>

      {/* 编辑弹窗 */}
      <Modal title={t('models.editModel')} open={editOpen} onCancel={() => { setEditOpen(false); setEditTarget(''); setEditModelName(''); setEditApiKey(''); setEditBaseUrl(''); setEditProtocol('openai'); }} onOk={() => { void handleEdit(); }} confirmLoading={editSaving}>
        <Form layout="vertical" size="middle">
          <Form.Item label={t('models.modelName')}><Input value={editModelName} onChange={(e) => setEditModelName(e.target.value)} placeholder={t('models.modelNamePlaceholder')} /></Form.Item>
          <Form.Item label={t('models.apiKey')} help={t('models.apiKeyEditHint')}><Input.Password value={editApiKey} onFocus={() => { if (editApiKey.includes('•')) setEditApiKey(''); }} onCopy={(e) => e.preventDefault()} onChange={(e) => setEditApiKey(e.target.value)} placeholder={t('models.apiKeyEditPlaceholder')} /></Form.Item>
          <Form.Item label={t('models.baseUrl')}><Input value={editBaseUrl} onChange={(e) => setEditBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" /></Form.Item>
          <Form.Item label={t('models.protocol')}><Select value={editProtocol} onChange={setEditProtocol} options={PROTOCOL_OPTIONS} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
