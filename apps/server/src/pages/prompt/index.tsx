import { useRef, useEffect, useState } from 'react';
import { useAppTranslations } from '@/components/Layout';
import { Card, Button, Drawer, Input, App, Tag, Popconfirm, Empty, Space, Checkbox, Skeleton, Select, Divider, Spin, Segmented } from 'antd';
import { EditOutlined, FileTextOutlined, FolderOutlined, DeleteOutlined, PlusOutlined, ImportOutlined, ExportOutlined, SendOutlined, RobotOutlined, SearchOutlined, UnorderedListOutlined, AppstoreOutlined } from '@ant-design/icons';

interface PromptProject {
  id: string; projectId: string; projectRoot?: string; projectName: string;
  customizePath: string; content: string; mtime: string; hasFile: boolean;
  isCurrent: boolean; selected: boolean; source: 'current' | 'project' | 'custom';
}
interface PromptChatMessage { role: 'user' | 'assistant'; content: string; }
interface KnowledgeFile { relativePath: string; category: string; format: string; fileSize: number; status: string; chunkCount?: number; score?: number; matchedBy?: 'path' | 'metadata' | 'content' | 'disk'; }
interface ReferencedKnowledgeFile { relativePath: string; content: string; }
type SourceFilter = 'all' | 'custom' | 'current' | 'project';
type StatusFilter = 'all' | 'selected' | 'unselected' | 'hasFile' | 'missingFile';
type SortMode = 'mtime' | 'name' | 'source' | 'selected';
type ViewMode = 'list' | 'card';

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
  return res.json() as Promise<{ success: boolean; id: string }>;
}
async function selectPrompts(selectedIds: string[]) {
  const res = await fetch('/api/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'select', selectedIds }) });
  if (!res.ok) throw new Error('Failed');
  return res.json();
}
async function importPrompts(payload: unknown) {
  const res = await fetch('/api/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'import', ...(payload && typeof payload === 'object' ? payload as Record<string, unknown> : { prompts: [] }) }) });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ success: boolean; imported: number }>;
}
async function fetchKnowledgeFiles(): Promise<KnowledgeFile[]> {
  return searchKnowledgeFiles('', false, 60);
}
async function fetchKnowledgeFileContent(relativePath: string): Promise<string> {
  const res = await fetch(`/api/kb/files/detail?relativePath=${encodeURIComponent(relativePath)}`);
  if (!res.ok) throw new Error('Failed');
  const data = await res.json() as { chunks?: Array<{ content?: string }> };
  return (data.chunks || []).map(chunk => chunk.content || '').filter(Boolean).join('\n\n').slice(0, 12000);
}
async function searchKnowledgeFiles(keyword: string, includeContent = true, limit = 30): Promise<KnowledgeFile[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (keyword.trim()) params.set('q', keyword.trim());
  if (!includeContent) params.set('includeContent', '0');
  const res = await fetch(`/api/kb/files/search?${params}`);
  if (!res.ok) return [];
  const data = await res.json() as { files?: KnowledgeFile[] };
  return data.files || [];
}
async function chatWithPrompt(payload: { name: string; content: string; message: string; history: PromptChatMessage[]; references: ReferencedKnowledgeFile[] }) {
  const res = await fetch('/api/prompt/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string };
      throw new Error(parsed.error || parsed.message || body || 'AI 对话失败');
    } catch {
      throw new Error(body || 'AI 对话失败');
    }
  }
  return res.json() as Promise<{ content: string }>;
}
function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function isCustomPrompt(p: PromptProject): boolean { return p.id.startsWith('custom:'); }
function getPromptSource(p: PromptProject): SourceFilter {
  if (isCustomPrompt(p)) return 'custom';
  if (p.isCurrent) return 'current';
  return 'project';
}
function sourceLabel(source: SourceFilter) {
  return source === 'custom' ? '我的提示词' : source === 'current' ? '当前项目' : source === 'project' ? '其他项目' : '全部';
}
function sourceColor(source: SourceFilter) {
  return source === 'custom' ? 'cyan' : source === 'current' ? 'green' : source === 'project' ? 'blue' : 'default';
}
function promptChatStorageKey(p: PromptProject | null, name: string, draftId?: string) {
  if (p) return `customize-agent:prompt-chat:${p.id}:${p.customizePath || p.projectName}`;
  return `customize-agent:prompt-chat:draft:${draftId || name || 'new'}`;
}
function readPromptChatHistory(key: string): PromptChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '[]') as PromptChatMessage[];
    return Array.isArray(parsed) ? parsed.filter(item => (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string').slice(-30) : [];
  } catch {
    return [];
  }
}
function writePromptChatHistory(key: string, messages: PromptChatMessage[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, JSON.stringify(messages.slice(-30)));
}
function movePromptChatHistory(fromKey: string, toKey: string) {
  if (typeof window === 'undefined' || !fromKey || !toKey || fromKey === toKey) return;
  const value = window.localStorage.getItem(fromKey);
  if (value && !window.localStorage.getItem(toKey)) window.localStorage.setItem(toKey, value);
}
function promptExcerpt(p: PromptProject, max = 220) {
  const text = p.hasFile && p.content ? p.content.replace(/^#.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim() : '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
function formatDate(value: string) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? '-' : new Date(time).toLocaleString();
}
function formatPromptExport(prompts: PromptProject[]) {
  return prompts.map(p => [
    `# Prompt: ${p.projectName}`,
    `Source: ${sourceLabel(getPromptSource(p))}`,
    `Path: ${p.customizePath || '-'}`,
    `Project: ${p.projectRoot || '-'}`,
    `Selected: ${p.selected ? 'true' : 'false'}`,
    `Updated: ${formatDate(p.mtime)}`,
    '',
    p.content || '',
  ].join('\n')).join('\n\n---\n\n');
}
function matchesPrompt(p: PromptProject, keyword: string) {
  const text = `${p.projectName}\n${p.projectRoot || ''}\n${p.customizePath || ''}\n${p.content || ''}`.toLowerCase();
  return text.includes(keyword.toLowerCase());
}
function getKnowledgeMentionQuery(value: string) {
  const match = value.match(/(^|\s)@([^\s@]*)$/);
  return match ? match[2] : null;
}
function replaceKnowledgeMention(value: string, relativePath: string) {
  return value.replace(/(^|\s)@([^\s@]*)$/, `$1@${relativePath} `);
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
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('custom');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('mtime');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [searchText, setSearchText] = useState('');
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const [checkedPromptIds, setCheckedPromptIds] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [chatMessages, setChatMessages] = useState<PromptChatMessage[]>([]);
  const [chatStorageKey, setChatStorageKey] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [knowledgeFiles, setKnowledgeFiles] = useState<KnowledgeFile[]>([]);
  const [knowledgeSearchResults, setKnowledgeSearchResults] = useState<KnowledgeFile[]>([]);
  const [selectedKnowledgeFiles, setSelectedKnowledgeFiles] = useState<string[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeSearching, setKnowledgeSearching] = useState(false);
  const [showKnowledgePicker, setShowKnowledgePicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const knowledgeMentionQuery = getKnowledgeMentionQuery(chatInput);

  const load = async () => {
    setLoading(true);
    try { setProjects(await fetchProjects()); } catch { message.error(t('common.error')); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const stored = window.localStorage.getItem('customize-agent:prompt-view-mode') as ViewMode | null;
    if (stored === 'list' || stored === 'card') setViewMode(stored);
  }, []);
  useEffect(() => {
    window.localStorage.setItem('customize-agent:prompt-view-mode', viewMode);
  }, [viewMode]);
  useEffect(() => {
    const node = chatListRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    if (chatStorageKey) writePromptChatHistory(chatStorageKey, chatMessages);
  }, [chatMessages, chatLoading, chatStorageKey]);
  useEffect(() => {
    if (!drawerOpen || knowledgeFiles.length > 0 || knowledgeLoading) return;
    setKnowledgeLoading(true);
    fetchKnowledgeFiles().then(setKnowledgeFiles).catch(() => undefined).finally(() => setKnowledgeLoading(false));
  }, [drawerOpen, knowledgeFiles.length, knowledgeLoading]);
  useEffect(() => {
    const keyword = knowledgeMentionQuery?.trim();
    if (!drawerOpen || !keyword) {
      setKnowledgeSearchResults([]);
      setKnowledgeSearching(false);
      return;
    }
    let cancelled = false;
    setKnowledgeSearching(true);
    const timer = window.setTimeout(() => {
      searchKnowledgeFiles(keyword).then(results => {
        if (!cancelled) setKnowledgeSearchResults(results);
      }).catch(() => {
        if (!cancelled) setKnowledgeSearchResults([]);
      }).finally(() => {
        if (!cancelled) setKnowledgeSearching(false);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [drawerOpen, knowledgeMentionQuery]);

  const currentProject = projects.find(p => p.isCurrent);
  const customPrompts = projects.filter(isCustomPrompt);
  const promptStats = {
    all: projects.length,
    custom: projects.filter(p => getPromptSource(p) === 'custom').length,
    current: projects.filter(p => getPromptSource(p) === 'current').length,
    project: projects.filter(p => getPromptSource(p) === 'project').length,
    selected: projects.filter(p => p.selected).length,
    unselected: projects.filter(p => !p.selected).length,
    hasFile: projects.filter(p => p.hasFile).length,
    missingFile: projects.filter(p => !p.hasFile).length,
  };

  const filteredProjects = projects.filter(p => {
    const source = getPromptSource(p);
    if (sourceFilter !== 'all' && source !== sourceFilter) return false;
    if (statusFilter === 'selected' && !p.selected) return false;
    if (statusFilter === 'unselected' && p.selected) return false;
    if (statusFilter === 'hasFile' && !p.hasFile) return false;
    if (statusFilter === 'missingFile' && p.hasFile) return false;
    if (searchText.trim() && !matchesPrompt(p, searchText.trim())) return false;
    return true;
  }).sort((a, b) => {
    if (sortMode === 'name') return a.projectName.localeCompare(b.projectName);
    if (sortMode === 'source') return ['custom', 'current', 'project'].indexOf(getPromptSource(a)) - ['custom', 'current', 'project'].indexOf(getPromptSource(b));
    if (sortMode === 'selected') return Number(b.selected) - Number(a.selected) || Date.parse(b.mtime || '') - Date.parse(a.mtime || '');
    return Date.parse(b.mtime || '') - Date.parse(a.mtime || '');
  });
  const activePrompt = filteredProjects.find(p => p.id === activePromptId) || filteredProjects[0] || null;
  const visibleCheckedIds = checkedPromptIds.filter(id => filteredProjects.some(p => p.id === id));
  const filteredKnowledgeFiles = knowledgeMentionQuery?.trim()
    ? knowledgeSearchResults
    : knowledgeFiles;

  const resetPromptChatInput = () => {
    setChatInput('');
    setChatLoading(false);
    setSelectedKnowledgeFiles([]);
    setShowKnowledgePicker(false);
  };

  const loadPromptChatHistory = (p: PromptProject | null, name: string, draftId?: string) => {
    const key = promptChatStorageKey(p, name, draftId);
    setChatStorageKey(key);
    setChatMessages(readPromptChatHistory(key));
    resetPromptChatInput();
  };

  const openEdit = (p: PromptProject) => {
    setEditing(p); setIsCreating(false);
    setEditName(p.projectName);
    setEditContent(p.content || '');
    loadPromptChatHistory(p, p.projectName);
    setDrawerOpen(true);
  };

  const openCreate = (p?: PromptProject) => {
    if (p?.projectRoot) {
      createProjectPrompt(p.projectRoot).then(() => { message.success(t('common.success')); void load(); }).catch(() => message.error(t('common.error')));
      return;
    }
    const nextDraftId = `new:${Date.now()}`;
    setEditing(null); setIsCreating(true);
    setEditName(''); setEditContent('');
    loadPromptChatHistory(null, 'new', nextDraftId);
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
        const created = await createCustomPrompt(editName.trim(), editContent || `# ${editName.trim()}\n`);
        movePromptChatHistory(chatStorageKey, promptChatStorageKey({ id: created.id, projectId: created.id, projectName: editName.trim(), customizePath: created.id, content: editContent, mtime: '', hasFile: true, isCurrent: false, selected: false, source: 'custom' }, editName.trim()));
        message.success(t('common.success'));
      }
      setDrawerOpen(false);
      await load();
    } catch { message.error(t('common.error')); } finally { setSaving(false); }
  };

  const insertKnowledgeReference = (relativePath: string) => {
    setSelectedKnowledgeFiles(items => items.includes(relativePath) ? items : [...items, relativePath]);
    setChatInput(value => replaceKnowledgeMention(value, relativePath));
    setShowKnowledgePicker(false);
  };

  const resolveKnowledgeReferences = async (input: string) => {
    const references = Array.from(new Set([
      ...selectedKnowledgeFiles,
      ...knowledgeFiles.filter(file => input.includes(`@${file.relativePath}`)).map(file => file.relativePath),
    ])).slice(0, 3);
    const results: ReferencedKnowledgeFile[] = [];
    for (const relativePath of references) {
      const content = await fetchKnowledgeFileContent(relativePath);
      if (content) results.push({ relativePath, content });
    }
    return results;
  };

  const handlePromptChat = async () => {
    const text = chatInput.trim();
    if (!text || chatLoading) return;
    const nextMessages: PromptChatMessage[] = [...chatMessages, { role: 'user', content: text }];
    setChatMessages(nextMessages);
    setChatInput('');
    setShowKnowledgePicker(false);
    setChatLoading(true);
    try {
      const references = await resolveKnowledgeReferences(text);
      const result = await chatWithPrompt({ name: editName || editing?.projectName || '未命名提示词', content: editContent, message: text, history: chatMessages, references });
      setChatMessages([...nextMessages, { role: 'assistant', content: result.content || 'AI 未返回内容' }]);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'AI 对话失败，请检查模型配置');
      setChatMessages(nextMessages);
    } finally {
      setChatLoading(false);
    }
  };

  const applyChatContent = (content: string) => {
    setEditContent(content);
    message.success('已应用到编辑内容，请确认后保存');
  };

  const handleSelect = async (p: PromptProject, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...projects.filter(x => x.selected).map(x => x.id), p.id]))
      : projects.filter(x => x.selected && x.id !== p.id).map(x => x.id);
    try { await selectPrompts(next); setProjects(items => items.map(x => ({ ...x, selected: next.includes(x.id) }))); }
    catch { message.error(t('common.error')); }
  };

  const handleBatchSelect = async (checked: boolean) => {
    const currentSelected = projects.filter(p => p.selected).map(p => p.id);
    const next = checked
      ? Array.from(new Set([...currentSelected, ...visibleCheckedIds]))
      : currentSelected.filter(id => !visibleCheckedIds.includes(id));
    try {
      await selectPrompts(next);
      setProjects(items => items.map(x => ({ ...x, selected: next.includes(x.id) })));
      setCheckedPromptIds([]);
      message.success(t('common.success'));
    } catch { message.error(t('common.error')); }
  };

  const handleDelete = async (p: PromptProject) => {
    try {
      const res = await fetch('/api/prompt', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: p.projectId, filePath: p.customizePath }) });
      if (!res.ok) throw new Error('Failed');
      message.success(t('common.success'));
      setCheckedPromptIds(items => items.filter(id => id !== p.id));
      await load();
    } catch { message.error(t('common.error')); }
  };

  const handleExport = (scope: 'custom' | 'filtered' | 'checked' = 'custom') => {
    const prompts = scope === 'checked' ? projects.filter(p => visibleCheckedIds.includes(p.id)) : scope === 'filtered' ? filteredProjects : customPrompts;
    downloadText(`customize-prompts-${new Date().toISOString().slice(0, 10)}.txt`, formatPromptExport(prompts));
    message.success(`已导出 ${prompts.length} 条提示词`);
  };

  const handleImportFile = async (file?: File) => {
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as unknown;
      const result = await importPrompts(payload);
      message.success(`已导入 ${result.imported} 条提示词`);
      await load();
    } catch {
      message.error('导入失败，请确认 JSON 文件格式正确');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const promptTags = (p: PromptProject) => {
    const source = getPromptSource(p);
    return <Space size={4} wrap>
      <Tag color={sourceColor(source)} style={{ margin: 0 }}>{sourceLabel(source)}</Tag>
      {p.selected && <Tag color="purple" style={{ margin: 0 }}>已选中</Tag>}
      {!p.hasFile && <Tag style={{ margin: 0 }}>无文件</Tag>}
    </Space>;
  };

  const promptActions = (p: PromptProject) => <Space size={6}>
    {p.hasFile && <Checkbox checked={p.selected} onChange={e => { void handleSelect(p, e.target.checked); }}>选中</Checkbox>}
    {!p.hasFile && p.projectRoot && <Button size="small" icon={<PlusOutlined />} onClick={() => openCreate(p)}>创建</Button>}
    {p.hasFile && <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(p)}>编辑</Button>}
    <Popconfirm title={isCustomPrompt(p) ? '删除自定义提示词？' : '删除项目记录及文件？'} onConfirm={() => { void handleDelete(p); }}>
      <Button size="small" danger icon={<DeleteOutlined />} />
    </Popconfirm>
  </Space>;

  const renderPromptListItem = (p: PromptProject) => {
    const excerpt = promptExcerpt(p, 180);
    const active = activePrompt?.id === p.id;
    return <div key={p.id} onClick={() => setActivePromptId(p.id)} style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr) auto', gap: 12, alignItems: 'center', padding: 14, border: `1px solid ${active ? 'var(--colorAccent)' : 'var(--colorBorderSecondary)'}`, borderRadius: 12, background: active ? 'var(--colorFillSecondary)' : 'var(--colorBgContainer)', cursor: 'pointer', transition: 'all .2s ease' }}>
      <Checkbox checked={checkedPromptIds.includes(p.id)} onClick={e => e.stopPropagation()} onChange={e => setCheckedPromptIds(items => e.target.checked ? Array.from(new Set([...items, p.id])) : items.filter(id => id !== p.id))} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <FileTextOutlined style={{ color: p.isCurrent ? 'var(--colorOk)' : 'var(--colorAccent)' }} />
          <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.projectName}</span>
          {promptTags(p)}
        </div>
        <div style={{ color: 'var(--colorTextSecondary)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: excerpt ? 6 : 0 }}>
          <FolderOutlined style={{ marginRight: 4 }} />{p.projectRoot || p.customizePath || '本地提示词'} · {formatDate(p.mtime)}
        </div>
        {excerpt && <div style={{ color: 'var(--colorTextSecondary)', fontSize: 12, lineHeight: 1.6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap' }}>{excerpt}</div>}
      </div>
      <div onClick={e => e.stopPropagation()}>{promptActions(p)}</div>
    </div>;
  };

  const renderPromptCard = (p: PromptProject) => {
    const excerpt = promptExcerpt(p, 180);
    const active = activePrompt?.id === p.id;
    return <Card key={p.id} size="small" hoverable onClick={() => setActivePromptId(p.id)} style={{ borderColor: active ? 'var(--colorAccent)' : undefined }} styles={{ body: { display: 'flex', flexDirection: 'column', minHeight: 210 } }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Checkbox checked={checkedPromptIds.includes(p.id)} onClick={e => e.stopPropagation()} onChange={e => setCheckedPromptIds(items => e.target.checked ? Array.from(new Set([...items, p.id])) : items.filter(id => id !== p.id))} />
        <FileTextOutlined style={{ color: p.isCurrent ? 'var(--colorOk)' : 'var(--colorAccent)' }} />
        <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{p.projectName}</span>
      </div>
      <div style={{ marginBottom: 8 }}>{promptTags(p)}</div>
      <div style={{ color: 'var(--colorTextSecondary)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 8 }}><FolderOutlined style={{ marginRight: 4 }} />{p.projectRoot || p.customizePath || '本地提示词'}</div>
      <div style={{ padding: 10, background: 'var(--colorFillAlter)', borderRadius: 8, color: 'var(--colorTextSecondary)', fontSize: 12, lineHeight: 1.6, minHeight: 72, maxHeight: 72, overflow: 'hidden', whiteSpace: 'pre-wrap' }}>{excerpt || '暂无内容预览'}</div>
      <div style={{ marginTop: 'auto', paddingTop: 10, borderTop: '1px solid var(--colorBorderSecondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} onClick={e => e.stopPropagation()}>
        <span style={{ color: 'var(--colorTextSecondary)', fontSize: 12 }}>{formatDate(p.mtime)}</span>
        {promptActions(p)}
      </div>
    </Card>;
  };

  if (loading) return (
    <div className="space-y-5 animateFadeIn">
      <Skeleton active title paragraph={{ rows: 1 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
        {Array.from({ length: 4 }).map((_, i) => <Card key={i} size="small"><Skeleton active paragraph={{ rows: 4 }} /></Card>)}
      </div>
    </div>
  );

  return (
    <div className="space-y-5 animateFadeIn">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div><h1 className="pageTitle">{t('nav.promptManagement')}</h1><p className="pageDesc">{t('prompt.description')}</p></div>
        <Space wrap>
          {currentProject && <Tag color="green" style={{ lineHeight: '22px' }}><FolderOutlined /> {currentProject.projectRoot}</Tag>}
          <input ref={fileInputRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={e => { void handleImportFile(e.target.files?.[0]); }} />
          <Button icon={<ImportOutlined />} loading={importing} onClick={() => fileInputRef.current?.click()}>导入</Button>
          <Button icon={<ExportOutlined />} disabled={filteredProjects.length === 0} onClick={() => handleExport('filtered')}>导出筛选</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>创建提示词</Button>
        </Space>
      </div>

      <Card size="small" styles={{ body: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } }}>
        <Input prefix={<SearchOutlined />} allowClear placeholder="搜索名称、内容、路径..." value={searchText} onChange={e => setSearchText(e.target.value)} style={{ width: 280 }} />
        <Select<SourceFilter> value={sourceFilter} onChange={setSourceFilter} style={{ width: 150 }} options={[
          { label: `全部 (${promptStats.all})`, value: 'all' },
          { label: `我的提示词 (${promptStats.custom})`, value: 'custom' },
          { label: `当前项目 (${promptStats.current})`, value: 'current' },
          { label: `其他项目 (${promptStats.project})`, value: 'project' },
        ]} />
        <Select<StatusFilter> value={statusFilter} onChange={setStatusFilter} style={{ width: 130 }} options={[
          { label: '全部状态', value: 'all' },
          { label: `已选中 (${promptStats.selected})`, value: 'selected' },
          { label: `未选中 (${promptStats.unselected})`, value: 'unselected' },
          { label: `有文件 (${promptStats.hasFile})`, value: 'hasFile' },
          { label: `无文件 (${promptStats.missingFile})`, value: 'missingFile' },
        ]} />
        <Select<SortMode> value={sortMode} onChange={setSortMode} style={{ width: 140 }} options={[
          { label: '最近修改优先', value: 'mtime' },
          { label: '名称 A-Z', value: 'name' },
          { label: '来源优先', value: 'source' },
          { label: '已选中优先', value: 'selected' },
        ]} />
        <Segmented value={viewMode} onChange={value => setViewMode(value as ViewMode)} options={[{ label: <UnorderedListOutlined />, value: 'list' }, { label: <AppstoreOutlined />, value: 'card' }]} />
        <div style={{ flex: 1 }} />
        <span style={{ color: 'var(--colorTextSecondary)', fontSize: 13 }}>已显示 {filteredProjects.length} / {projects.length}</span>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Card size="small" title="分组导航" styles={{ body: { padding: 8 } }}>
            {([
              ['all', '全部', promptStats.all], ['custom', '我的提示词', promptStats.custom], ['current', '当前项目', promptStats.current], ['project', '其他项目', promptStats.project],
            ] as Array<[SourceFilter, string, number]>).map(([key, label, count]) => (
              <button key={key} onClick={() => setSourceFilter(key)} style={{ width: '100%', border: 'none', background: sourceFilter === key ? 'var(--colorFillSecondary)' : 'transparent', color: 'var(--colorText)', padding: '9px 10px', borderRadius: 8, display: 'flex', justifyContent: 'space-between', cursor: 'pointer', fontWeight: sourceFilter === key ? 700 : 400 }}>
                <span>{label}</span><span>{count}</span>
              </button>
            ))}
            <Divider style={{ margin: '8px 0' }} />
            {([
              ['selected', '已选中', promptStats.selected], ['unselected', '未选中', promptStats.unselected],
            ] as Array<[StatusFilter, string, number]>).map(([key, label, count]) => (
              <button key={key} onClick={() => setStatusFilter(statusFilter === key ? 'all' : key)} style={{ width: '100%', border: 'none', background: statusFilter === key ? 'var(--colorFillSecondary)' : 'transparent', color: 'var(--colorText)', padding: '9px 10px', borderRadius: 8, display: 'flex', justifyContent: 'space-between', cursor: 'pointer', fontWeight: statusFilter === key ? 700 : 400 }}>
                <span>{label}</span><span>{count}</span>
              </button>
            ))}
          </Card>

          <Card size="small" title="详情预览" styles={{ body: { height: 300, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden' } }}>
            {!activePrompt ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择一个提示词" /> : <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}><FileTextOutlined style={{ color: 'var(--colorAccent)', flexShrink: 0 }} /><strong style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activePrompt.projectName}</strong></div>
              <div style={{ minWidth: 0, overflow: 'hidden' }}>{promptTags(activePrompt)}</div>
              <div style={{ color: 'var(--colorTextSecondary)', fontSize: 12, lineHeight: 1.7, minWidth: 0 }}>
                <div>更新时间：{formatDate(activePrompt.mtime)}</div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>文件路径：{activePrompt.customizePath || '-'}</div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>项目路径：{activePrompt.projectRoot || '-'}</div>
              </div>
              <div style={{ flex: 1, minHeight: 0, padding: 10, borderRadius: 8, background: 'var(--colorFillAlter)', color: 'var(--colorTextSecondary)', fontSize: 12, lineHeight: 1.7, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{promptExcerpt(activePrompt, 800) || '暂无内容预览'}</div>
              <div>{promptActions(activePrompt)}</div>
            </>}
          </Card>
        </div>

        <div style={{ minWidth: 0 }}>
          {visibleCheckedIds.length > 0 && (
            <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }}>
              <span style={{ fontWeight: 600 }}>已选择 {visibleCheckedIds.length} 项</span>
              <Button size="small" onClick={() => { void handleBatchSelect(true); }}>批量选中</Button>
              <Button size="small" onClick={() => { void handleBatchSelect(false); }}>取消选中</Button>
              <Button size="small" icon={<ExportOutlined />} onClick={() => handleExport('checked')}>导出选中</Button>
              <Button size="small" onClick={() => setCheckedPromptIds([])}>清空选择</Button>
            </Card>
          )}
          {filteredProjects.length === 0 ? (
            <Card><Empty description={searchText || statusFilter !== 'all' ? '没有找到匹配的提示词，请尝试更换关键词或清空筛选条件' : '当前分组没有提示词'} /></Card>
          ) : viewMode === 'list' ? (
            <Space direction="vertical" size={10} style={{ width: '100%' }}>{filteredProjects.map(renderPromptListItem)}</Space>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>{filteredProjects.map(renderPromptCard)}</div>
          )}
        </div>
      </div>

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
        width={980} maskClosable={false}
        style={{ borderRadius: '12px 0 0 12px' }}
        styles={{ body: { padding: '16px 24px', display: 'grid', gridTemplateRows: 'minmax(320px, 1fr) 420px', gap: 14, height: '100%' }, header: { borderRadius: '12px 0 0 0', borderBottom: '1px solid var(--colorBorderSecondary)' } }}
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" loading={saving} onClick={() => { void handleSave(); }}>{t('common.save')}</Button>
          </Space>
        }
      >
        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ marginBottom: 12 }}>
            {isCreating || (editing && isCustomPrompt(editing)) ? (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Input placeholder="提示词名称" value={editName} onChange={e => setEditName(e.target.value)} style={{ maxWidth: 520 }} />
                {!isCreating && <div style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>{editing?.customizePath}</div>}
              </Space>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>{editing?.customizePath}</div>
            )}
          </div>
          <Input.TextArea
            value={editContent}
            onChange={e => setEditContent(e.target.value)}
            style={{ flex: 1, minHeight: 280, fontFamily: 'SF Mono, Monaco, Consolas, monospace', fontSize: 13, resize: 'none' }}
          />
        </div>

        <div style={{ minHeight: 0, border: '1px solid var(--colorBorderSecondary)', borderRadius: 10, background: 'var(--colorBgContainer)', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 8px 24px rgba(15, 23, 42, 0.06)' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--colorBorderSecondary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Space size={6}><RobotOutlined style={{ color: 'var(--colorAccent)' }} /><span style={{ fontWeight: 600 }}>AI 提示词助手</span></Space>
            <Space size={6}>
              {chatMessages.length > 0 && <Button size="small" onClick={() => setChatMessages([])}>清空历史</Button>}
              {chatLoading ? <Tag color="processing" style={{ margin: 0 }}>生成中</Tag> : <Tag color="blue" style={{ margin: 0 }}>可对话优化</Tag>}
            </Space>
          </div>
          <div ref={chatListRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14, background: 'var(--colorFillAlter)' }}>
            {chatMessages.length === 0 && !chatLoading ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入 @ 召回知识库文件，再描述你的优化目标" />
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {chatMessages.map((item, index) => {
                  const isUser = item.role === 'user';
                  return (
                    <div key={`${item.role}-${index}`} style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
                      <div style={{ maxWidth: '78%', padding: '10px 12px', borderRadius: 12, background: isUser ? 'var(--colorFillSecondary)' : 'var(--colorBgContainer)', color: 'var(--colorText)', border: '1px solid var(--colorBorderSecondary)', whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: 13, transition: 'all .2s ease' }}>
                        {item.content}
                        {!isUser && (
                          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                            <Button size="small" type="primary" onClick={() => applyChatContent(item.content)}>应用</Button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {chatLoading && (
                  <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                    <div style={{ padding: '10px 12px', borderRadius: 12, background: 'var(--colorBgContainer)', border: '1px solid var(--colorBorderSecondary)', color: 'var(--colorTextSecondary)', fontSize: 13 }}>
                      <Spin size="small" style={{ marginRight: 8 }} />AI 正在分析并生成内容...
                    </div>
                  </div>
                )}
              </Space>
            )}
          </div>
          <Divider style={{ margin: 0 }} />
          <div style={{ padding: 12 }}>
            {selectedKnowledgeFiles.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                {selectedKnowledgeFiles.map(file => (
                  <Tag key={file} closable onClose={() => setSelectedKnowledgeFiles(items => items.filter(item => item !== file))} style={{ margin: 0, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }}>@{file}</Tag>
                ))}
              </div>
            )}
            {showKnowledgePicker && (
              <div style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 8, border: '1px solid var(--colorBorderSecondary)', borderRadius: 12, background: 'var(--colorBgElevated, var(--colorBgContainer))', boxShadow: '0 16px 40px rgba(15, 23, 42, 0.14)' }}>
                <div style={{ position: 'sticky', top: 0, zIndex: 1, padding: '10px 12px', borderBottom: '1px solid var(--colorBorderSecondary)', background: 'var(--colorBgElevated, var(--colorBgContainer))', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                  <div>
                    <div style={{ color: 'var(--colorText)', fontSize: 13, fontWeight: 700 }}>召回知识库文件</div>
                    <div style={{ color: 'var(--colorTextSecondary)', fontSize: 11 }}>支持文件名与知识库内容检索，最多召回 3 个文件</div>
                  </div>
                  <Tag color={knowledgeMentionQuery ? 'blue' : 'default'} style={{ margin: 0, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>{knowledgeMentionQuery ? `@${knowledgeMentionQuery}` : '输入 @关键词'}</Tag>
                </div>
                {knowledgeLoading ? (
                  <div style={{ padding: 14, color: 'var(--colorTextSecondary)', fontSize: 12 }}><Spin size="small" style={{ marginRight: 8 }} />正在加载知识库文件...</div>
                ) : knowledgeFiles.length === 0 ? (
                  <div style={{ padding: 14, color: 'var(--colorTextSecondary)', fontSize: 12 }}>暂无可召回的知识库文件</div>
                ) : filteredKnowledgeFiles.length === 0 ? (
                  <div style={{ padding: 14, color: 'var(--colorTextSecondary)', fontSize: 12 }}>{knowledgeSearching ? <><Spin size="small" style={{ marginRight: 8 }} />正在检索知识库内容...</> : '没有匹配的知识库文件，请换个关键词'}</div>
                ) : <>
                  {knowledgeSearching && <div style={{ padding: '8px 12px', color: 'var(--colorTextSecondary)', fontSize: 12, borderBottom: '1px solid var(--colorBorderSecondary)' }}><Spin size="small" style={{ marginRight: 8 }} />正在继续检索内容匹配...</div>}
                  {filteredKnowledgeFiles.slice(0, 30).map(file => (
                    <div key={file.relativePath} onMouseDown={e => { e.preventDefault(); insertKnowledgeReference(file.relativePath); }} style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid var(--colorBorderSecondary)', fontSize: 12, display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) auto', gap: 10, alignItems: 'center' }}>
                      <div style={{ width: 22, height: 22, borderRadius: 7, background: 'var(--colorFillSecondary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><FileTextOutlined style={{ color: 'var(--colorAccent)' }} /></div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: 'var(--colorText)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 700 }}>{file.relativePath}</div>
                        <div style={{ color: 'var(--colorTextSecondary)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.category || '未分类'} · {file.format || '未知格式'}{typeof file.score === 'number' ? ` · score ${file.score.toFixed(2)}` : ''}</div>
                      </div>
                      <Space size={4}>
                        <Tag color={file.matchedBy === 'content' ? 'purple' : file.matchedBy === 'disk' ? 'orange' : 'blue'} style={{ margin: 0 }}>{file.matchedBy === 'content' ? '内容匹配' : file.matchedBy === 'disk' ? '磁盘文件' : '文件匹配'}</Tag>
                        <Tag style={{ margin: 0 }}>{file.status}</Tag>
                      </Space>
                    </div>
                  ))}
                </>}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <Input.TextArea
                value={chatInput}
                onChange={e => { const value = e.target.value; setChatInput(value); setShowKnowledgePicker(getKnowledgeMentionQuery(value) !== null); }}
                onFocus={() => setShowKnowledgePicker(getKnowledgeMentionQuery(chatInput) !== null)}
                onPressEnter={e => { if (!e.shiftKey) { e.preventDefault(); void handlePromptChat(); } }}
                disabled={chatLoading}
                placeholder="输入 @ 召回知识库文件，再描述优化目标..."
                autoSize={{ minRows: 2, maxRows: 5 }}
                style={{ fontSize: 13, lineHeight: 1.6 }}
              />
              <Button type="primary" icon={<SendOutlined />} loading={chatLoading} disabled={!chatInput.trim()} onClick={() => { void handlePromptChat(); }}>发送</Button>
            </div>
          </div>
        </div>
      </Drawer>
    </div>
  );
}
