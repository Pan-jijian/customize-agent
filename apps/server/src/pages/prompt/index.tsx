import { useRef, useEffect, useState } from 'react';
import { useAppTranslations } from '@/components/Layout';
import { Button, Drawer, Input, App, Tag, Popconfirm, Empty, Space, Checkbox, Skeleton, Select, Divider, Spin, Segmented } from 'antd';
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
function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
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
function sourceLabel(source: SourceFilter, t: any) {
  return source === 'custom' ? t('prompt.customPrompt') : source === 'current' ? t('prompt.currentProject') : source === 'project' ? t('prompt.otherProjects') : t('prompt.allPrompts');
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
  return {
    type: 'customize-agent.prompts',
    version: 1,
    exportedAt: new Date().toISOString(),
    prompts: prompts.map(p => ({
      name: p.projectName,
      content: p.content || '',
      selected: p.selected,
      source: getPromptSource(p),
    })),
  };
}
function safeFilename(value: string) {
  return value.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'untitled';
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
    downloadJson(`customize-prompts-${new Date().toISOString().slice(0, 10)}.json`, formatPromptExport(prompts));
    message.success(`已导出 ${prompts.length} 条提示词`);
  };

  const handleExportOne = (p: PromptProject) => {
    downloadJson(`customize-prompt-${safeFilename(p.projectName)}-${new Date().toISOString().slice(0, 10)}.json`, formatPromptExport([p]));
    message.success('已导出 1 条提示词');
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
      <Tag color={sourceColor(source)} style={{ margin: 0 }}>{sourceLabel(source, t)}</Tag>
      {p.selected && <Tag color="purple" style={{ margin: 0 }}>{t('prompt.selected')}</Tag>}
      {!p.hasFile && <Tag style={{ margin: 0 }}>{t('prompt.missingFileStatus')}</Tag>}
    </Space>;
  };

  const promptActions = (p: PromptProject) => <div className="flex items-center gap-1.5">
    {p.hasFile && <Checkbox checked={p.selected} onChange={e => { void handleSelect(p, e.target.checked); }} className="mr-1">{t('prompt.selected')}</Checkbox>}
    {!p.hasFile && p.projectRoot && <Button size="small" icon={<PlusOutlined />} onClick={() => openCreate(p)}>{t('common.add')}</Button>}
    {p.hasFile && <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(p)}>{t('common.edit')}</Button>}
    {p.hasFile && <Button size="small" icon={<ExportOutlined />} onClick={() => handleExportOne(p)}>导出</Button>}
    <Popconfirm title={isCustomPrompt(p) ? '删除自定义提示词？' : '删除项目记录及文件？'} onConfirm={() => { void handleDelete(p); }}>
      <Button size="small" danger icon={<DeleteOutlined />} />
    </Popconfirm>
  </div>;

  const renderPromptListItem = (p: PromptProject) => {
    const excerpt = promptExcerpt(p, 180);
    const active = activePrompt?.id === p.id;
    return <div key={p.id} onClick={() => setActivePromptId(p.id)} className={`group grid grid-cols-[28px_1fr_auto] gap-4 items-center p-4 rounded-xl transition-all cursor-pointer ${active ? 'bg-[var(--colorBgSelected)] shadow-md' : 'bg-transparent hover:bg-[var(--colorBgHover)] hover:shadow-sm'}`}>
      <Checkbox checked={checkedPromptIds.includes(p.id)} onClick={e => e.stopPropagation()} onChange={e => setCheckedPromptIds(items => e.target.checked ? Array.from(new Set([...items, p.id])) : items.filter(id => id !== p.id))} />
      <div className="min-w-0">
        <div className="flex items-center gap-3 mb-1.5">
          <FileTextOutlined className={p.isCurrent ? 'text-[var(--colorOk)] text-lg' : 'text-[var(--colorTextSecondary)] text-lg'} />
          <span className="font-semibold truncate text-[var(--colorText)] text-base">{p.projectName}</span>
          {promptTags(p)}
        </div>
        <div className="text-xs text-[var(--colorTextTertiary)] truncate flex items-center gap-1.5 font-medium">
          <FolderOutlined /> {p.projectRoot || p.customizePath || '本地提示词'}
          <span className="text-[var(--colorBorderSecondary)]">|</span>
          {formatDate(p.mtime)}
        </div>
        {excerpt && <div className="mt-2.5 bg-[var(--colorFillAlter)] p-2.5 rounded-lg overflow-hidden"><div className="text-sm text-[var(--colorTextSecondary)] line-clamp-2 leading-normal">{excerpt}</div></div>}
      </div>
      <div onClick={e => e.stopPropagation()} className={`transition-opacity flex items-center ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
        {promptActions(p)}
      </div>
    </div>;
  };

  const renderPromptCard = (p: PromptProject) => {
    const excerpt = promptExcerpt(p, 180);
    const active = activePrompt?.id === p.id;
    return <div key={p.id} onClick={() => setActivePromptId(p.id)} className={`group flex flex-col p-5 rounded-2xl transition-all cursor-pointer ${active ? 'bg-[var(--colorBgSelected)] shadow-md' : 'bg-[var(--colorBgContainer)] hover:bg-[var(--colorBgHover)] shadow-sm hover:shadow-md'}`}>
      <div className="flex items-start justify-between gap-3 mb-4 min-w-0">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Checkbox checked={checkedPromptIds.includes(p.id)} onClick={e => e.stopPropagation()} onChange={e => setCheckedPromptIds(items => e.target.checked ? Array.from(new Set([...items, p.id])) : items.filter(id => id !== p.id))} />
          <FileTextOutlined className={p.isCurrent ? 'text-[var(--colorOk)] text-lg' : 'text-[var(--colorTextSecondary)] text-lg'} />
          <span className="font-bold text-base text-[var(--colorText)] truncate mb-1">{p.projectName}</span>
        </div>
      </div>
      <div className="mb-3">{promptTags(p)}</div>
      <div className="text-xs text-[var(--colorTextTertiary)] truncate flex items-center gap-1.5 mb-4 bg-[var(--colorFillAlter)] p-1.5 rounded inline-flex self-start">
        <FolderOutlined />
        {p.projectRoot || p.customizePath || '本地提示词'}
      </div>
      <div className="flex-1 bg-[var(--colorFillAlter)] p-3 rounded-xl mb-4 overflow-hidden">
        {excerpt ? <div className="text-sm text-[var(--colorTextSecondary)] line-clamp-3 leading-normal">{excerpt}</div> : <div className="text-sm text-[var(--colorTextQuaternary)] italic">暂无内容预览</div>}
      </div>
      <div className="mt-auto pt-4 flex justify-between items-center" onClick={e => e.stopPropagation()}>
        <span className="text-xs font-medium text-[var(--colorTextTertiary)] bg-[var(--colorFillSecondary)] px-2 py-1 rounded">{formatDate(p.mtime)}</span>
        <div className={`transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>{promptActions(p)}</div>
      </div>
    </div>;
  };

  if (loading) return (
    <div className="space-y-12">
      <Skeleton active title paragraph={{ rows: 1 }} />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="p-4 border border-[var(--borderColor)]"><Skeleton active paragraph={{ rows: 4 }} /></div>)}
      </div>
    </div>
  );

  return (
    <div className="space-y-8 animateFadeIn">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-6 mb-2">
        <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--colorText)] mb-2.5 flex items-center gap-2">
                <FileTextOutlined className="text-[var(--colorAccent)]" />
                {t('nav.promptManagement')}
            </h1>
            <p className="text-sm text-[var(--colorTextSecondary)]">{t('prompt.description')}</p>
        </div>
        <Space wrap>
          {currentProject && <Tag color="green" style={{ lineHeight: '22px' }} bordered={false}><FolderOutlined /> {currentProject.projectRoot}</Tag>}
          <input ref={fileInputRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={e => { void handleImportFile(e.target.files?.[0]); }} />
          <Button icon={<ImportOutlined />} loading={importing} onClick={() => fileInputRef.current?.click()} className="rounded-lg">{t('prompt.import')}</Button>
          <Button icon={<ExportOutlined />} disabled={filteredProjects.length === 0} onClick={() => handleExport('filtered')} className="rounded-lg">{t('prompt.exportFiltered')}</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()} className="shadow-none rounded-lg">{t('prompt.createPrompt')}</Button>
        </Space>
      </div>

      <div className="flex flex-wrap items-center gap-3 bg-[var(--colorBgContainer)] p-3 rounded-xl shadow-sm mb-6">
        <Input prefix={<SearchOutlined className="text-[var(--colorTextTertiary)]" />} allowClear placeholder={t('prompt.searchPrompt')} value={searchText} onChange={e => setSearchText(e.target.value)} style={{ width: 280 }} bordered={false} className="bg-[var(--colorBgHover)] rounded-lg hover:bg-[var(--colorFillAlter)] focus:bg-[var(--colorBgElevated)] transition-colors" />
        <div className="h-4 w-[1px] bg-[var(--borderColorStrong)] mx-1"></div>
        <Select<SourceFilter> value={sourceFilter} onChange={setSourceFilter} style={{ width: 150 }} variant="borderless" options={[
          { label: `${t('prompt.allPrompts')} (${promptStats.all})`, value: 'all' },
          { label: `${t('prompt.customPrompt')} (${promptStats.custom})`, value: 'custom' },
          { label: `${t('prompt.currentProject')} (${promptStats.current})`, value: 'current' },
          { label: `${t('prompt.otherProjects')} (${promptStats.project})`, value: 'project' },
        ]} />
        <Select<StatusFilter> value={statusFilter} onChange={setStatusFilter} style={{ width: 130 }} variant="borderless" options={[
          { label: t('prompt.promptStatus'), value: 'all' },
          { label: `${t('prompt.selected')} (${promptStats.selected})`, value: 'selected' },
          { label: `${t('prompt.unselected')} (${promptStats.unselected})`, value: 'unselected' },
          { label: `${t('prompt.hasFileStatus')} (${promptStats.hasFile})`, value: 'hasFile' },
          { label: `${t('prompt.missingFileStatus')} (${promptStats.missingFile})`, value: 'missingFile' },
        ]} />
        <Select<SortMode> value={sortMode} onChange={setSortMode} style={{ width: 140 }} variant="borderless" options={[
          { label: t('prompt.sortByMtime'), value: 'mtime' },
          { label: t('prompt.sortByName'), value: 'name' },
          { label: t('prompt.sortBySource'), value: 'source' },
          { label: t('prompt.sortBySelected'), value: 'selected' },
        ]} />
        <div className="flex-1"></div>
        <Segmented value={viewMode} onChange={value => setViewMode(value as ViewMode)} options={[{ label: <UnorderedListOutlined />, value: 'list' }, { label: <AppstoreOutlined />, value: 'card' }]} className="bg-[var(--colorBgHover)] p-1 rounded-lg" />
      </div>

      <div className="grid grid-cols-1 gap-8 items-start">
        <div className="min-w-0">
          {visibleCheckedIds.length > 0 && (
            <div className="flex items-center gap-3 flex-wrap p-4 mb-6 bg-[var(--colorBgHover)] rounded-xl shadow-sm">
              <span className="font-semibold text-sm">已选择 <span className="text-[var(--colorAccent)]">{visibleCheckedIds.length}</span> 项</span>
              <div className="h-4 w-[1px] bg-[var(--borderColorStrong)] mx-1"></div>
              <Button size="small" onClick={() => { void handleBatchSelect(true); }}>{t('prompt.batchSelect')}</Button>
              <Button size="small" onClick={() => { void handleBatchSelect(false); }}>{t('prompt.cancelSelect')}</Button>
              <Button size="small" icon={<ExportOutlined />} onClick={() => handleExport('checked')}>{t('prompt.exportSelected')}</Button>
              <Button size="small" danger onClick={() => setCheckedPromptIds([])}>{t('prompt.clearSelect')}</Button>
            </div>
          )}
          {filteredProjects.length === 0 ? (
            <div className="py-32 text-center border border-dashed border-[var(--borderColor)] rounded-2xl bg-[var(--colorBgHover)]">
                <Empty 
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={<span className="text-[var(--colorTextSecondary)]">{searchText || statusFilter !== 'all' ? t('prompt.noMatchDesc') : t('prompt.noPromptInGroup')}</span>} 
                />
            </div>
          ) : viewMode === 'list' ? (
            <div className="flex flex-col gap-3">{filteredProjects.map(renderPromptListItem)}</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">{filteredProjects.map(renderPromptCard)}</div>
          )}
        </div>
      </div>

      <Drawer
        title={
          isCreating
            ? t('prompt.createPrompt')
            : editing && isCustomPrompt(editing)
              ? `${t('prompt.customPrompt')} — ${editName || editing.projectName}`
              : `${t('prompt.currentProject')} — ${editing?.projectName || ''}`
        }
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={1080}
        maskClosable={false}
        styles={{ body: { padding: '24px 32px', display: 'grid', gridTemplateRows: 'minmax(320px, 1fr) 420px', gap: 24, height: '100%' }, header: { borderBottom: '1px solid var(--colorBorderSecondary)', padding: '16px 32px' } }}
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" loading={saving} onClick={() => { void handleSave(); }}>{t('common.save')}</Button>
          </Space>
        }
      >
        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ marginBottom: 16 }}>
            {isCreating || (editing && isCustomPrompt(editing)) ? (
              <Input size="large" placeholder={t('prompt.promptName')} value={editName} onChange={e => setEditName(e.target.value)} style={{ maxWidth: '100%', fontWeight: 500, fontSize: 16 }} />
            ) : null}
          </div>
          <Input.TextArea
            value={editContent}
            onChange={e => setEditContent(e.target.value)}
            style={{ flex: 1, minHeight: 280, fontFamily: 'SF Mono, Monaco, Consolas, monospace', fontSize: 13, resize: 'none' }}
          />
        </div>

        <div style={{ minHeight: 0, border: '1px solid var(--colorBorderSecondary)', borderRadius: 10, background: 'var(--colorBgContainer)', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 8px 24px rgba(15, 23, 42, 0.06)' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--colorBorderSecondary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Space size={6}><RobotOutlined style={{ color: 'var(--colorAccent)' }} /><span style={{ fontWeight: 600 }}>{t('prompt.aiPromptAssistant')}</span></Space>
            <Space size={6}>
              {chatMessages.length > 0 && <Button size="small" onClick={() => setChatMessages([])}>{t('prompt.clearHistory')}</Button>}
              {chatLoading ? <Tag color="processing" style={{ margin: 0 }}>{t('prompt.generating')}</Tag> : <Tag color="blue" style={{ margin: 0 }}>{t('prompt.canConverse')}</Tag>}
            </Space>
          </div>
          <div ref={chatListRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14, background: 'var(--colorFillAlter)' }}>
            {chatMessages.length === 0 && !chatLoading ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('prompt.mentionRecallHint')} />
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
                            <Button size="small" type="primary" onClick={() => applyChatContent(item.content)}>{t('prompt.apply')}</Button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {chatLoading && (
                  <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                    <div style={{ padding: '10px 12px', borderRadius: 12, background: 'var(--colorBgContainer)', border: '1px solid var(--colorBorderSecondary)', color: 'var(--colorTextSecondary)', fontSize: 13 }}>
                      <Spin size="small" style={{ marginRight: 8 }} />{t('prompt.aiAnalyzing')}
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
                    <div style={{ color: 'var(--colorText)', fontSize: 13, fontWeight: 700 }}>{t('prompt.recallKbFiles')}</div>
                    <div style={{ color: 'var(--colorTextSecondary)', fontSize: 11 }}>{t('prompt.recallLimitHint')}</div>
                  </div>
                  <Tag color={knowledgeMentionQuery ? 'blue' : 'default'} style={{ margin: 0, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>{knowledgeMentionQuery ? `@${knowledgeMentionQuery}` : t('prompt.inputAtKeyword')}</Tag>
                </div>
                {knowledgeLoading ? (
                  <div style={{ padding: 14, color: 'var(--colorTextSecondary)', fontSize: 12 }}><Spin size="small" style={{ marginRight: 8 }} />{t('prompt.loadingKbFiles')}</div>
                ) : knowledgeFiles.length === 0 ? (
                  <div style={{ padding: 14, color: 'var(--colorTextSecondary)', fontSize: 12 }}>{t('prompt.noRecallableKbFiles')}</div>
                ) : filteredKnowledgeFiles.length === 0 ? (
                  <div style={{ padding: 14, color: 'var(--colorTextSecondary)', fontSize: 12 }}>{knowledgeSearching ? <><Spin size="small" style={{ marginRight: 8 }} />{t('prompt.searchingKbContent')}</> : t('prompt.noMatchingKbFiles')}</div>
                ) : <>
                  {knowledgeSearching && <div style={{ padding: '8px 12px', color: 'var(--colorTextSecondary)', fontSize: 12, borderBottom: '1px solid var(--colorBorderSecondary)' }}><Spin size="small" style={{ marginRight: 8 }} />{t('prompt.continueSearchingKb')}</div>}
                  {filteredKnowledgeFiles.slice(0, 30).map(file => (
                    <div key={file.relativePath} onMouseDown={e => { e.preventDefault(); insertKnowledgeReference(file.relativePath); }} style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid var(--colorBorderSecondary)', fontSize: 12, display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) auto', gap: 10, alignItems: 'center' }}>
                      <div style={{ width: 22, height: 22, borderRadius: 7, background: 'var(--colorFillSecondary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><FileTextOutlined style={{ color: 'var(--colorAccent)' }} /></div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: 'var(--colorText)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 700 }}>{file.relativePath}</div>
                        <div style={{ color: 'var(--colorTextSecondary)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.category || t('prompt.unclassified')} · {file.format || t('prompt.unknownFormat')}{typeof file.score === 'number' ? ` · score ${file.score.toFixed(2)}` : ''}</div>
                      </div>
                      <Space size={4}>
                        <Tag color={file.matchedBy === 'content' ? 'purple' : file.matchedBy === 'disk' ? 'orange' : 'blue'} style={{ margin: 0 }}>{file.matchedBy === 'content' ? t('prompt.contentMatch') : file.matchedBy === 'disk' ? t('prompt.diskFile') : t('prompt.fileMatch')}</Tag>
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
                placeholder={t('prompt.mentionRecallPlaceholder')}
                autoSize={{ minRows: 2, maxRows: 5 }}
                style={{ fontSize: 13, lineHeight: 1.6 }}
              />
              <Button type="primary" icon={<SendOutlined />} loading={chatLoading} disabled={!chatInput.trim()} onClick={() => { void handlePromptChat(); }}>{t('prompt.send')}</Button>
            </div>
          </div>
        </div>
      </Drawer>
    </div>
  );
}
