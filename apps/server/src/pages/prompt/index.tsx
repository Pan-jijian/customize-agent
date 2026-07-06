import { useEffect, useState } from 'react';
import { useAppTranslations } from '@/components/Layout';
import { Card, Button, Modal, Input, App, Row, Col, Tag, Popconfirm, Empty, Space, Checkbox } from 'antd';
import { EditOutlined, FileTextOutlined, FolderOutlined, ClockCircleOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';

interface PromptProject {
  id: string;
  projectId: string;
  projectRoot?: string;
  projectName: string;
  customizePath: string;
  content: string;
  mtime: string;
  hasFile: boolean;
  isCurrent: boolean;
  selected: boolean;
  source: 'current' | 'project' | 'custom';
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

async function createProjectPrompt(projectRoot: string) {
  const res = await fetch('/api/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', projectRoot, content: '# CUSTOMIZE\n' }),
  });
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

async function createCustomPrompt(name = '自定义提示词') {
  const res = await fetch('/api/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'createCustom', name, content: `# ${name}\n` }),
  });
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

async function selectPrompts(selectedIds: string[]) {
  const res = await fetch('/api/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'select', selectedIds }),
  });
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

export default function PromptPage() {
  const t = useAppTranslations();
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

  const handleCreate = async (p?: PromptProject) => {
    try {
      if (p?.projectRoot) await createProjectPrompt(p.projectRoot);
      else {
        const name = window.prompt('请输入自定义提示词名称', '自定义提示词')?.trim();
        if (!name) return;
        await createCustomPrompt(name);
      }
      message.success(t('common.success'));
      await load();
    } catch { message.error(t('common.error')); }
  };

  const handleSelect = async (p: PromptProject, checked: boolean) => {
    const next = checked ? Array.from(new Set([...projects.filter(item => item.selected).map(item => item.id), p.id])) : projects.filter(item => item.selected && item.id !== p.id).map(item => item.id);
    try {
      await selectPrompts(next);
      setProjects(items => items.map(item => ({ ...item, selected: next.includes(item.id) })));
    } catch { message.error(t('common.error')); }
  };

  const handleDelete = async (p: PromptProject) => {
    try {
      const res = await fetch('/api/prompt', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: p.projectId, filePath: p.customizePath }) });
      if (!res.ok) throw new Error('Failed');
      message.success(t('common.success'));
      await load();
    } catch { message.error(t('common.error')); }
  };

  return (
    <div className="space-y-6 animateFadeIn">
      <div className="flex items-center justify-between">
        <div><h1 className="pageTitle">{t('nav.promptManagement')}</h1><p className="pageDesc">{t('prompt.description')}</p></div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { void handleCreate(); }}>创建提示词</Button>
      </div>

      {projects.find(p => p.isCurrent) && (
        <Card size="small">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Tag color="green" style={{ width: 'fit-content' }}>当前工作项目</Tag>
            <span style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}><FolderOutlined /> {projects.find(p => p.isCurrent)?.projectRoot}</span>
          </div>
        </Card>
      )}

      {projects.length === 0 && !loading ? <Empty /> : null}
      <Row gutter={[16, 16]}>
        {loading ? Array.from({ length: 3 }).map((_, index) => (
          <Col key={index} xs={24} sm={12} lg={8}><Card loading size="small" /></Col>
        )) : projects.map((p, index) => (
          <Col key={p.id} xs={24} sm={12} lg={8}>
            <Card
              size="small"
              title={<Space size={6}><Tag>序号 {index + 1}</Tag><FileTextOutlined /> {p.projectName}</Space>}
              extra={
                <span style={{ display: 'flex', gap: 4 }}>
                  {p.hasFile && <Checkbox checked={p.selected} onChange={e => { void handleSelect(p, e.target.checked); }}>选中</Checkbox>}
                  {!p.hasFile && p.projectRoot && <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => { void handleCreate(p); }} />}
                  {p.hasFile && <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(p)} />}
                  <Popconfirm title={p.source === 'custom' ? '删除自定义提示词？' : '删除项目记录及其提示词文件？'} disabled={p.id.startsWith('builtin:')} onConfirm={() => { void handleDelete(p); }}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} disabled={p.id.startsWith('builtin:')} />
                  </Popconfirm>
                </span>
              }
            >
              {p.projectRoot && <div style={{ fontSize: 12, color: 'var(--colorTextSecondary)', marginBottom: 8 }}>
                <FolderOutlined /> {p.projectRoot}
              </div>}
              <div style={{ fontSize: 12, color: 'var(--colorTextSecondary)', marginBottom: 8 }}>
                <ClockCircleOutlined /> {p.mtime ? new Date(p.mtime).toLocaleString() : t('common.never')}
              </div>
              <Space wrap>
                {p.isCurrent && <Tag color="green">当前项目</Tag>}
                {p.selected && <Tag color="purple">已选中</Tag>}
                {p.id.startsWith('builtin:') ? <Tag color="gold">内置</Tag> : p.source === 'custom' && <Tag color="cyan">自定义</Tag>}
                {p.hasFile ? (
                  <Tag color="blue">{t('prompt.hasFile')}</Tag>
                ) : (
                  <Tag color="default">{t('prompt.noFile')}</Tag>
                )}
              </Space>
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
        maskClosable={false}
        title={`${t('common.edit')} — ${editing?.projectName || ''}`}
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
