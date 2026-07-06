import { useEffect, useState } from 'react';
import { useAppTranslations } from '@/components/Layout';
import { Card, Button, Drawer, Input, App, Tag, Popconfirm, Empty, Space, Form, Checkbox, Skeleton } from 'antd';
import { EditOutlined, FileTextOutlined, FolderOutlined, DeleteOutlined, PlusOutlined, PlayCircleOutlined } from '@ant-design/icons';

interface PromptProject {
  id: string; projectId: string; projectRoot?: string; projectName: string;
  customizePath: string; content: string; mtime: string; hasFile: boolean;
  isCurrent: boolean; selected: boolean; source: 'current' | 'project' | 'custom';
}

async function fetchProjects(): Promise<PromptProject[]> {
  const res = await fetch('/api/prompt');
  if (!res.ok) throw new Error('Failed');
  return res.json();
}
async function saveProject(filePath: string, content: string) {
  const res = await fetch('/api/prompt', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath, content }) });
  if (!res.ok) throw new Error('Failed');
  return res.json();
}
async function createProjectPrompt(projectRoot: string) {
  const res = await fetch('/api/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', projectRoot, content: '# CUSTOMIZE\n' }) });
  if (!res.ok) throw new Error('Failed');
  return res.json();
}
async function createCustomPrompt(name: string, content: string) {
  const res = await fetch('/api/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'createCustom', name, content }) });
  if (!res.ok) throw new Error('Failed');
  return res.json();
}
async function selectPrompts(selectedIds: string[]) {
  const res = await fetch('/api/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'select', selectedIds }) });
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

export default function PromptPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<PromptProject[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<PromptProject | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setProjects(await fetchProjects()); } catch { message.error(t('common.error')); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const openEdit = (p: PromptProject) => {
    setEditing(p); setIsCreating(false);
    setEditName(p.projectName);
    setEditContent(p.content || '');
    setDrawerOpen(true);
  };

  const openCreate = (p?: PromptProject) => {
    if (p?.projectRoot) {
      createProjectPrompt(p.projectRoot).then(() => { message.success(t('common.success')); void load(); }).catch(() => message.error(t('common.error')));
      return;
    }
    setEditing(null); setIsCreating(true);
    setEditName(''); setEditContent('');
    setDrawerOpen(true);
  };

  const handleSave = async () => {
    if (!editName.trim()) { message.error('请输入名称'); return; }
    setSaving(true);
    try {
      if (editing) {
        await saveProject(editing.customizePath, editContent);
        message.success(t('common.success'));
      } else {
        await createCustomPrompt(editName.trim(), editContent || `# ${editName.trim()}\n`);
        message.success(t('common.success'));
      }
      setDrawerOpen(false);
      await load();
    } catch { message.error(t('common.error')); } finally { setSaving(false); }
  };

  const handleSelect = async (p: PromptProject, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...projects.filter(x => x.selected).map(x => x.id), p.id]))
      : projects.filter(x => x.selected && x.id !== p.id).map(x => x.id);
    try { await selectPrompts(next); setProjects(items => items.map(x => ({ ...x, selected: next.includes(x.id) }))); }
    catch { message.error(t('common.error')); }
  };

  const handleDelete = async (p: PromptProject) => {
    try {
      const res = await fetch('/api/prompt', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: p.projectId, filePath: p.customizePath }) });
      if (!res.ok) throw new Error('Failed');
      message.success(t('common.success'));
      await load();
    } catch { message.error(t('common.error')); }
  };

  const currentProject = projects.find(p => p.isCurrent);

  if (loading) return (
    <div className="space-y-5 animateFadeIn">
      <Skeleton active title paragraph={{ rows: 1 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} size="small"><Skeleton active paragraph={{ rows: 4 }} /></Card>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-5 animateFadeIn">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div><h1 className="pageTitle">{t('nav.promptManagement')}</h1><p className="pageDesc">{t('prompt.description')}</p></div>
        <Space>
          {currentProject && (
            <Tag color="green" style={{ lineHeight: '22px' }}><FolderOutlined /> {currentProject.projectRoot}</Tag>
          )}
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>创建提示词</Button>
        </Space>
      </div>

      {projects.length === 0 ? <Empty description={t('prompt.noProjects')} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
          {projects.map(p => {
            const excerpt = p.hasFile && p.content ? p.content.replace(/^#.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim() : '';
            return (
            <Card key={p.id} size="small" hoverable styles={{ body: { display: 'flex', flexDirection: 'column', height: '100%' } }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <FileTextOutlined style={{ color: p.isCurrent ? 'var(--colorOk)' : 'var(--colorAccent)', fontSize: 14, flexShrink: 0 }} />
                <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{p.projectName}</span>
                {!p.hasFile && p.projectRoot && (
                  <Button size="small" icon={<PlusOutlined />} onClick={() => openCreate(p)} />
                )}
              </div>

              {/* Meta */}
              {p.projectRoot && (
                <div style={{ fontSize: 11, color: 'var(--colorTextSecondary)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <FolderOutlined style={{ marginRight: 4 }} />{p.projectRoot}
                </div>
              )}

              {/* Tags */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                {p.isCurrent && <Tag color="green" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>当前项目</Tag>}
                {p.id.startsWith('builtin:') && <Tag color="gold" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>内置</Tag>}
                {!p.id.startsWith('builtin:') && p.source === 'custom' && <Tag color="cyan" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>自定义</Tag>}
                {p.selected && <Tag color="purple" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>已选中</Tag>}
                {p.hasFile ? <Tag color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>有文件</Tag> : <Tag color="default" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>无文件</Tag>}
              </div>

              {/* Content preview — only render if has non-empty content */}
              {excerpt && (
                <div style={{ padding: 8, background: 'var(--colorFillAlter)', borderRadius: 6, fontSize: 11, maxHeight: 80, overflow: 'hidden', color: 'var(--colorTextSecondary)', whiteSpace: 'pre-wrap', fontFamily: 'monospace', marginBottom: 8, lineHeight: 1.5 }}>
                  {excerpt.slice(0, 180)}{excerpt.length > 180 ? '...' : ''}
                </div>
              )}

              {/* Actions — pinned to bottom */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 8, borderTop: '1px solid var(--colorBorderSecondary)', marginTop: 'auto' }}>
                {p.hasFile ? <Checkbox checked={p.selected} onChange={e => { void handleSelect(p, e.target.checked); }} style={{ fontSize: 12 }}>选中</Checkbox> : <span />}
                <div style={{ flex: 1 }} />
                {p.hasFile && <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(p)}>编辑</Button>}
                <Popconfirm title={p.id.startsWith('builtin:') ? '删除内置提示词？' : p.source === 'custom' ? '删除自定义提示词？' : '删除项目记录及文件？'} disabled={p.id.startsWith('builtin:')} onConfirm={() => { void handleDelete(p); }}>
                  <Button size="small" danger icon={<DeleteOutlined />} disabled={p.id.startsWith('builtin:')} />
                </Popconfirm>
              </div>
            </Card>
          )})}
        </div>
      )}

      <Drawer
        title={isCreating ? '创建提示词' : `编辑 — ${editing?.projectName || ''}`}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={800} maskClosable={false}
        style={{ borderRadius: '12px 0 0 12px' }}
        styles={{ body: { padding: '16px 24px' }, header: { borderRadius: '12px 0 0 0', borderBottom: '1px solid var(--colorBorderSecondary)' } }}
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" loading={saving} onClick={() => { void handleSave(); }}>{t('common.save')}</Button>
          </Space>
        }
      >
        <div style={{ marginBottom: 12 }}>
          {isCreating ? (
            <Input placeholder="提示词名称" value={editName} onChange={e => setEditName(e.target.value)} style={{ maxWidth: 400 }} />
          ) : (
            <div style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>{editing?.customizePath}</div>
          )}
        </div>
        <Input.TextArea
          value={editContent}
          onChange={e => setEditContent(e.target.value)}
          rows={25}
          style={{ fontFamily: 'SF Mono, Monaco, Consolas, monospace', fontSize: 13 }}
        />
      </Drawer>
    </div>
  );
}
