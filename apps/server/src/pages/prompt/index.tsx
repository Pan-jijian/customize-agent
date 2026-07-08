import { useEffect, useState } from 'react';
import { useAppTranslations } from '@/components/Layout';
import { Card, Button, Drawer, Input, App, Tag, Popconfirm, Empty, Space, Checkbox, Skeleton, Select } from 'antd';
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
async function saveProject(filePath: string, content: string, name?: string) {
  const res = await fetch('/api/prompt', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath, content, name }) });
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

function isBuiltInPrompt(p: PromptProject): boolean { return p.id.startsWith('builtin:'); }
function isCustomPrompt(p: PromptProject): boolean { return p.id.startsWith('custom:'); }

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
  const [sourceFilter, setSourceFilter] = useState<'all' | 'custom' | 'project' | 'builtin'>('custom');

  const load = async () => {
    setLoading(true);
    try { setProjects(await fetchProjects()); } catch { message.error(t('common.error')); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const openEdit = (p: PromptProject) => {
    if (isBuiltInPrompt(p)) {
      setEditing(null); setIsCreating(true);
      setEditName(p.projectName.replace(/^内置｜/, '') + ' Copy');
      setEditContent(p.content || '');
      setDrawerOpen(true);
      message.info('内置提示词不可直接编辑，已为你创建副本');
      return;
    }
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
        await saveProject(editing.customizePath, editContent, isCustomPrompt(editing) ? editName.trim() : undefined);
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
  const builtInPrompts = projects.filter(isBuiltInPrompt);
  const customPrompts = projects.filter(isCustomPrompt);
  const projectPrompts = projects.filter(p => !isBuiltInPrompt(p) && !isCustomPrompt(p));
  const filteredProjects = sourceFilter === 'all'
    ? projects
    : sourceFilter === 'builtin' ? builtInPrompts
      : sourceFilter === 'custom' ? customPrompts
        : projectPrompts;

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
          <Select value={sourceFilter} onChange={setSourceFilter} style={{ width: 160 }} options={[
            { label: `全部 (${projects.length})`, value: 'all' },
            { label: `我的提示词 (${customPrompts.length})`, value: 'custom' },
            { label: `项目提示词 (${projectPrompts.length})`, value: 'project' },
            { label: `内置示例 (${builtInPrompts.length})`, value: 'builtin' },
          ]} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>创建提示词</Button>
        </Space>
      </div>

      {filteredProjects.length === 0 ? <Empty description={t('prompt.noProjects')} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
          {filteredProjects.map(p => {
            const excerpt = p.hasFile && p.content ? p.content.replace(/^#.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim() : '';
            return (
            <Card key={p.id} size="small" hoverable styles={{ body: { display: 'flex', flexDirection: 'column', height: '100%' } }}>
              {/* 标题 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <FileTextOutlined style={{ color: p.isCurrent ? 'var(--colorOk)' : 'var(--colorAccent)', fontSize: 14, flexShrink: 0 }} />
                <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{p.projectName}</span>
                {!p.hasFile && p.projectRoot && (
                  <Button size="small" icon={<PlusOutlined />} onClick={() => openCreate(p)} />
                )}
              </div>

              {/* 元信息 */}
              {p.projectRoot && (
                <div style={{ fontSize: 11, color: 'var(--colorTextSecondary)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <FolderOutlined style={{ marginRight: 4 }} />{p.projectRoot}
                </div>
              )}

              {/* 标签 */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                {p.isCurrent && <Tag color="green" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>当前项目</Tag>}
                {isBuiltInPrompt(p) && <Tag color="gold" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>内置示例</Tag>}
                {isCustomPrompt(p) && <Tag color="cyan" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>我的提示词</Tag>}
                {!isBuiltInPrompt(p) && !isCustomPrompt(p) && <Tag color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>项目提示词</Tag>}
                {p.selected && <Tag color="purple" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>已选中</Tag>}
                {p.hasFile ? <Tag color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>有文件</Tag> : <Tag color="default" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>无文件</Tag>}
              </div>

              {/* 内容预览 — 仅在有非空内容时渲染 */}
              {excerpt && (
                <div style={{ padding: 8, background: 'var(--colorFillAlter)', borderRadius: 6, fontSize: 11, maxHeight: 80, overflow: 'hidden', color: 'var(--colorTextSecondary)', whiteSpace: 'pre-wrap', fontFamily: 'monospace', marginBottom: 8, lineHeight: 1.5 }}>
                  {excerpt.slice(0, 180)}{excerpt.length > 180 ? '...' : ''}
                </div>
              )}

              {/* 操作 — 固定在底部 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 8, borderTop: '1px solid var(--colorBorderSecondary)', marginTop: 'auto' }}>
                {p.hasFile ? <Checkbox checked={p.selected} onChange={e => { void handleSelect(p, e.target.checked); }} style={{ fontSize: 12 }}>选中</Checkbox> : <span />}
                <div style={{ flex: 1 }} />
                {p.hasFile && <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(p)}>{isBuiltInPrompt(p) ? '复制' : '编辑'}</Button>}
                <Popconfirm title={isBuiltInPrompt(p) ? '删除内置提示词？' : isCustomPrompt(p) ? '删除自定义提示词？' : '删除项目记录及文件？'} disabled={isBuiltInPrompt(p)} onConfirm={() => { void handleDelete(p); }}>
                  <Button size="small" danger icon={<DeleteOutlined />} disabled={isBuiltInPrompt(p)} />
                </Popconfirm>
              </div>
            </Card>
          )})}
        </div>
      )}

      <Drawer
        title={
          isCreating
            ? '创建提示词'
            : editing && isCustomPrompt(editing)
              ? `编辑我的提示词 — ${editName || editing.projectName}`
              : `编辑项目提示词 — ${editing?.projectName || ''}`
        }
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
          {isCreating || (editing && isCustomPrompt(editing)) ? (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Input placeholder="提示词名称" value={editName} onChange={e => setEditName(e.target.value)} style={{ maxWidth: 400 }} />
              {!isCreating && <div style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>{editing?.customizePath}</div>}
            </Space>
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
