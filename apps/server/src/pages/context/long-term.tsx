import { useEffect, useState } from 'react';
import { useAppTranslations } from '@/components/Layout';
import { Card, Table, Tag, Input, App, Button, Popconfirm, Modal, Form, Statistic, Space } from 'antd';
import { SearchOutlined, InfoCircleOutlined, DeleteOutlined, EditOutlined, CompressOutlined, ClearOutlined, DatabaseOutlined } from '@ant-design/icons';
import { getContexts, deleteContextById, updateContextById, getContextStats, compressContexts, clearContexts, type ContextEntry } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

const TYPE_LABELS: Record<string, string> = {
  project_fact: '项目知识', user_preference: '用户偏好',
  feedback: '历史纠偏', pattern: '解决方案',
};
const IMPORTANCE_COLORS: Record<string, string> = { high: 'red', medium: 'orange', low: 'default' };

export default function LongTermContextPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ContextEntry[]>([]);
  const [stats, setStats] = useState({ count: 0, totalBytes: 0 });
  const [search, setSearch] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<ContextEntry | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editContext, setEditContext] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async (s?: string) => {
    setLoading(true);
    try {
      const [items, stat] = await Promise.all([getContexts('long_term', s), getContextStats('long_term')]);
      setData(items);
      setStats(stat);
    } catch { message.error(t('common.error')); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const handleDelete = async (id: string) => {
    try { await deleteContextById(id); message.success(t('common.success')); await load(search); } catch { message.error(t('common.error')); }
  };

  const handleCompress = async () => {
    try { await compressContexts('long_term'); message.success(t('common.success')); await load(search); } catch { message.error(t('common.error')); }
  };

  const handleClear = async () => {
    try { await clearContexts('long_term'); message.success(t('common.success')); await load(search); } catch { message.error(t('common.error')); }
  };

  const openEdit = (entry: ContextEntry) => {
    setEditing(entry);
    setEditContent(entry.content);
    setEditContext('');
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editing || !editContent.trim()) return;
    setSaving(true);
    try {
      await updateContextById(editing.id, { content: editContent.trim(), context: editContext || undefined });
      message.success(t('common.success'));
      setEditOpen(false);
      await load(search);
    } catch { message.error(t('common.error')); } finally { setSaving(false); }
  };

  const columns = [
    { title: '序号', key: 'index', width: 70, render: (_: unknown, __: ContextEntry, index: number) => index + 1 },
    { title: t('models.modelName'), dataIndex: 'title', ellipsis: true, width: 180 },
    { title: '类型', dataIndex: 'type', width: 90, render: (v: string) => <Tag>{TYPE_LABELS[v] || v}</Tag> },
    { title: t('context.content'), dataIndex: 'content', ellipsis: true },
    { title: t('context.importance'), dataIndex: 'importance', width: 80, render: (v: string) => <Tag color={IMPORTANCE_COLORS[v] || 'default'}>{v === 'high' ? '高' : v === 'medium' ? '中' : '低'}</Tag> },
    { title: t('context.source'), dataIndex: 'source', width: 100, ellipsis: true },
    { title: t('context.updatedAt'), dataIndex: 'updated_at', width: 140, render: (v: number) => v ? new Date(v).toLocaleString() : '-' },
    {
      title: t('common.edit'), width: 100,
      render: (_: unknown, record: ContextEntry) => (
        <span style={{ display: 'flex', gap: 4 }}>
          <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          <Popconfirm title={t('models.deleteProviderConfirm')} onConfirm={() => { void handleDelete(record.id); }}>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6 animateFadeIn">
      <div className="flex items-center justify-between">
        <div><h1 className="pageTitle">{t('nav.longTermContext')}</h1><p className="pageDesc">{t('context.longTermDesc')}</p></div>
        <Space wrap>
          <Input prefix={<SearchOutlined />} placeholder={t('common.search')} value={search} onChange={e => setSearch(e.target.value)} onPressEnter={() => { void load(search); }} allowClear style={{ width: 240 }} />
          <Button icon={<CompressOutlined />} onClick={() => { void handleCompress(); }}>压缩</Button>
          <Popconfirm title="确定清除长期上下文吗？" onConfirm={() => { void handleClear(); }}><Button danger icon={<ClearOutlined />}>清除</Button></Popconfirm>
        </Space>
      </div>
      <Card size="small">
        <Statistic title="总上下文大小" value={formatBytes(stats.totalBytes)} prefix={<DatabaseOutlined />} suffix={` / ${stats.count} 条`} />
      </Card>
      <Card size="small">
        <div style={{ marginBottom: 12, color: 'var(--colorTextSecondary)', fontSize: 13 }}>
          <InfoCircleOutlined /> {t('context.longTermSource')}
        </div>
        <Table rowKey="id" columns={columns} dataSource={data} loading={loading} size="small" pagination={{ pageSize: 15 }} />
      </Card>

      <Modal maskClosable={false} title={t('models.editModel')} open={editOpen} onCancel={() => setEditOpen(false)} onOk={() => { void handleEdit(); }} confirmLoading={saving}>
        <Form layout="vertical" size="middle">
          <Form.Item label={t('context.content')}>
            <Input.TextArea rows={6} value={editContent} onChange={e => setEditContent(e.target.value)} />
          </Form.Item>
          <Form.Item label={t('context.source')}>
            <Input value={editContext} onChange={e => setEditContext(e.target.value)} placeholder={t('context.sourceHint')} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
