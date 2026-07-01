import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card, Button, Modal, Input, App, Spin, Row, Col, Tag, Descriptions, Popconfirm } from 'antd';
import { EditOutlined, FileTextOutlined, FolderOutlined, ClockCircleOutlined, DeleteOutlined } from '@ant-design/icons';

interface PromptProject {
  projectId: string;
  projectRoot: string;
  projectName: string;
  customizePath: string;
  content: string;
  mtime: string;
  hasFile: boolean;
}

async function fetchProjects(): Promise<PromptProject[]> {
  const res = await fetch('/api/prompt');
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

async function saveProject(filePath: string, content: string) {
  const res = await fetch('/api/prompt', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath, content }),
  });
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

export default function PromptPage() {
  const t = useTranslations();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<PromptProject[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<PromptProject | null>(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setProjects(await fetchProjects()); } catch { message.error(t('common.error')); } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const openEdit = (p: PromptProject) => {
    setEditing(p);
    setEditContent(p.content || '');
    setEditOpen(true);
  };

  const handleSave = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await saveProject(editing.customizePath, editContent);
      message.success(t('common.success'));
      setEditOpen(false);
      await load();
    } catch { message.error(t('common.error')); } finally { setSaving(false); }
  };

  if (loading) return <div className="flex justify-center py-16"><Spin size="large" /></div>;

  return (
    <div className="space-y-6 animateFadeIn">
      <div className="flex items-center justify-between">
        <div><h1 className="pageTitle">{t('nav.promptManagement')}</h1><p className="pageDesc">{t('prompt.description')}</p></div>
      </div>

      <Row gutter={[16, 16]}>
        {projects.map((p) => (
          <Col key={p.projectId} xs={24} sm={12} lg={8}>
            <Card
              size="small"
              title={<><FileTextOutlined /> {p.projectName}</>}
              extra={
                <span style={{ display: 'flex', gap: 4 }}>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(p)} />
                  <Popconfirm title={t('models.deleteProviderConfirm')} onConfirm={async () => {
                    try { await fetch('/api/prompt', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: p.customizePath }) }); message.success(t('common.success')); await load(); } catch { message.error(t('common.error')); }
                  }}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </span>
              }
            >
              <div style={{ fontSize: 12, color: 'var(--colorTextSecondary)', marginBottom: 8 }}>
                <FolderOutlined /> {p.projectRoot}
              </div>
              <div style={{ fontSize: 12, color: 'var(--colorTextSecondary)', marginBottom: 8 }}>
                <ClockCircleOutlined /> {p.mtime ? new Date(p.mtime).toLocaleString() : t('common.never')}
              </div>
              {p.hasFile ? (
                <Tag color="blue">{t('prompt.hasFile')}</Tag>
              ) : (
                <Tag color="default">{t('prompt.noFile')}</Tag>
              )}
              {p.hasFile && p.content && (
                <div style={{
                  marginTop: 8, padding: 8, background: 'var(--colorBgSecondary)',
                  borderRadius: 8, fontSize: 12, maxHeight: 80, overflow: 'hidden',
                  color: 'var(--colorTextSecondary)', whiteSpace: 'pre-wrap',
                }}>
                  {p.content.slice(0, 200)}{p.content.length > 200 ? '...' : ''}
                </div>
              )}
            </Card>
          </Col>
        ))}
      </Row>

      {projects.length === 0 && (
        <Card size="small"><span style={{ color: 'var(--colorTextSecondary)' }}>{t('prompt.noProjects')}</span></Card>
      )}

      <Modal
        title={`${t('common.edit')} CUSTOMIZE.md — ${editing?.projectName || ''}`}
        open={editOpen}
        width={800}
        onCancel={() => setEditOpen(false)}
        onOk={() => { void handleSave(); }}
        confirmLoading={saving}
      >
        <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--colorTextSecondary)' }}>
          {editing?.customizePath}
        </div>
        <Input.TextArea
          value={editContent}
          onChange={e => setEditContent(e.target.value)}
          rows={25}
          style={{ fontFamily: 'SF Mono, Monaco, Consolas, monospace', fontSize: 13 }}
        />
      </Modal>
    </div>
  );
}
