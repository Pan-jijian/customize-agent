import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { App, Alert, Button, Card, Col, Descriptions, Drawer, Empty, Form, Input, List, Popconfirm, Row, Select, Skeleton, Space, Spin, Steps, Tabs, Tag, Tree, Typography } from 'antd';
import { FileTextOutlined, ThunderboltOutlined, DownloadOutlined, SaveOutlined, CopyOutlined, DeleteOutlined, PlusOutlined, ApartmentOutlined, DatabaseOutlined, EyeOutlined, BulbOutlined, FormOutlined, PictureOutlined, SafetyCertificateOutlined, CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, FileDoneOutlined, LoadingOutlined, PlayCircleOutlined, SettingOutlined, HistoryOutlined, FolderOutlined } from '@ant-design/icons';
import { abortGeneratedDocument, deleteDocumentTemplate, deleteGeneratedDocument, duplicateDocumentTemplate, exportDocument, generateDocumentDraft, getGeneratedDocument, getGeneratedDocuments, getDocumentRoles, getDocumentTemplates, getKbFiles, getPromptProjects, refineGeneratedDocument, saveDocumentDraft, saveDocumentTemplate, updateGeneratedDocument, validateDocumentTemplate, type DocumentRole, type DocumentTemplate, type DocumentTemplateValidation, type GeneratedDocumentDraft, type GeneratedDocumentRecord, type KbFileItem, type ProjectRoleConfig, type PromptProject, type RefinePlan, type RefineSelection } from '@/lib/api';
import { useAppTranslations } from '@/components/Layout';

const { TextArea } = Input;
const { Text } = Typography;

type FlowStepStatus = 'wait' | 'process' | 'finish' | 'warning' | 'error';
interface FlowSubStep { key: string; title: string; status: FlowStepStatus; }
interface FlowStep { key: string; title: string; description: string; status: FlowStepStatus; icon: ReactNode; subSteps: FlowSubStep[]; subtitle?: string; }

interface GenerationTaskState {
  id: number; templateId: string; loading: boolean;
  flowSteps: FlowStep[]; activeFlowKey: string | null;
  promise: Promise<{ draft?: GeneratedDocumentDraft; taskId?: string; documentId?: string; record?: GeneratedDocumentRecord }>;
  documentId?: string; draft?: GeneratedDocumentDraft; content?: string; error?: string;
  listeners: Set<() => void>;
}

interface EditHistoryItem { id: string; content: string; prompt: string; createdAt: number; }
interface RefinePreview { plan: RefinePlan; markdown: string; beforeSnippet?: string; afterSnippet?: string; summary?: string; changedChars?: number; prompt: string; before: string; }

let activeGenerationTask: GenerationTaskState | null = null;
function notifyGenerationTask() { activeGenerationTask?.listeners.forEach(l => l()); }

const STAGE_ICONS: Record<string, ReactNode> = {
  role_binding: <ApartmentOutlined />, context_recall: <BulbOutlined />, knowledge_retrieval: <DatabaseOutlined />, file_understanding: <EyeOutlined />,
  fact_extraction: <BulbOutlined />, chapter_generation: <FormOutlined />, asset_generation: <PictureOutlined />,
  validation: <SafetyCertificateOutlined />, formatting: <CheckCircleOutlined />, llm_review: <ThunderboltOutlined />,
  export_ready: <FileDoneOutlined />, reference: <PictureOutlined />,
};
const CATEGORY_ICONS: Record<string, ReactNode> = {
  '施工组织设计': <SafetyCertificateOutlined />,
  '投标文件': <FileDoneOutlined />,
  '技术方案': <BulbOutlined />,
  '报告': <FileTextOutlined />,
  '自定义': <FormOutlined />,
};

function templateIcon(category: string, isActive: boolean) {
  const icon = CATEGORY_ICONS[category] || <FileTextOutlined />;
  return <span style={{ color: isActive ? 'var(--colorAccent)' : 'var(--colorTextSecondary)', fontSize: 16, marginTop: 2, flexShrink: 0 }}>{icon}</span>;
}

type TemplateFileBinding = NonNullable<DocumentTemplate['fileBindings']>[number];
type TemplateEditorForm = DocumentTemplate & { fileBindingGroups?: Record<string, string[]> };
interface TemplateFileTreeNode {
  key: string;
  title: ReactNode;
  rawTitle: string;
  isFolder: boolean;
  fileCount: number;
  children?: TemplateFileTreeNode[];
}

function uniqueValues(values: string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
function fileDisplayName(value?: string) {
  return value ? value.split(/[\\/]/u).pop() || value : '';
}

function groupFileBindings(bindings: TemplateFileBinding[] = []) {
  return bindings.reduce<Record<string, string[]>>((groups, binding) => {
    if (!binding.roleId || !binding.filePath) return groups;
    groups[binding.roleId] = uniqueValues([...(groups[binding.roleId] || []), binding.filePath]);
    return groups;
  }, {});
}

function buildTemplateFileTree(files: KbFileItem[]): TemplateFileTreeNode[] {
  const root: Record<string, TemplateFileTreeNode> = {};
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'))) {
    const parts = file.relativePath.split('/').filter(Boolean);
    let currentPath = '';
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]!;
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      const isLast = index === parts.length - 1;
      if (!root[currentPath]) {
        root[currentPath] = {
          key: currentPath,
          rawTitle: name,
          title: isLast ? <span title={file.relativePath}>{name}</span> : <Space size={4}><FolderOutlined style={{ color: '#faad14' }} /><span>{name}</span></Space>,
          isFolder: !isLast,
          fileCount: isLast ? 1 : 0,
          ...(isLast ? {} : { children: [] }),
        };
        if (parentPath && root[parentPath]?.children) root[parentPath]!.children!.push(root[currentPath]!);
      }
      if (isLast) root[currentPath]!.fileCount = 1;
    }
  }
  const aggregate = (nodes: TemplateFileTreeNode[]) => {
    for (const node of nodes) {
      if (!node.children?.length) continue;
      aggregate(node.children);
      node.fileCount = node.children.reduce((sum, child) => sum + child.fileCount, 0);
      node.title = <Space size={4}><FolderOutlined style={{ color: '#faad14' }} /><span>{node.rawTitle}</span><Tag style={{ margin: 0 }}>{node.fileCount}</Tag></Space>;
    }
  };
  const topLevel = Object.values(root).filter(node => !node.key.includes('/'));
  aggregate(topLevel);
  return topLevel.filter(node => !node.isFolder || node.fileCount > 0);
}

function filterTemplateFileTree(nodes: TemplateFileTreeNode[], query: string): TemplateFileTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  return nodes.flatMap(node => {
    const children = node.children ? filterTemplateFileTree(node.children, q) : undefined;
    const matched = node.key.toLowerCase().includes(q) || node.rawTitle.toLowerCase().includes(q);
    if (matched || children?.length) return [{ ...node, children }];
    return [];
  });
}

function collectTemplateFileKeys(nodes: TemplateFileTreeNode[]) {
  const keys: string[] = [];
  const walk = (items: TemplateFileTreeNode[]) => {
    for (const item of items) {
      if (item.isFolder) {
        if (item.children) walk(item.children);
      } else {
        keys.push(item.key);
      }
    }
  };
  walk(nodes);
  return keys;
}

const STAGE_TITLES: Record<string, string> = {
  role_binding: '角色配置绑定', context_recall: '上下文召回', knowledge_retrieval: '知识库检索', file_understanding: '多模态文件理解',
  fact_extraction: 'LLM 事实抽取', chapter_generation: 'LLM 章节生成', asset_generation: '多模态资源生成',
  validation: '规则校验', formatting: '格式化排版', llm_review: 'LLM 审查优化',
  export_ready: '导出就绪', reference: '参考资源处理',
};
const STAGE_ROLE_NAMES: Record<string, string> = {
  'knowledge-base': '知识库', 'document-readiness': '生成准备度检查', 'quality-repair': '质量补写', 'export-gate': '导出门禁',
  'context-memory': '项目上下文', 'final-format': '正式排版', 'multimodal-files': '多模态文件理解', 'tender_announcement': '招标公告',
};

export default function DocumentsPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [form] = Form.useForm<TemplateEditorForm>();
  const editorRef = useRef<HTMLDivElement>(null);

  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [templateId, setTemplateId] = useState('construction-organization-design');
  const [roles, setRoles] = useState<DocumentRole[]>([]);
  const [roleConfigs, setRoleConfigs] = useState<ProjectRoleConfig[]>([]);
  const [prompts, setPrompts] = useState<PromptProject[]>([]);
  const [kbFiles, setKbFiles] = useState<KbFileItem[]>([]);
  const [fileSearching, setFileSearching] = useState(false);
  const [templateFileQuery, setTemplateFileQuery] = useState('');
  const [expandedTemplateFileKeys, setExpandedTemplateFileKeys] = useState<React.Key[]>([]);
  const [pageLoading, setPageLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<GeneratedDocumentDraft | null>(null);
  const [content, setContent] = useState('');
  const [drafts, setDrafts] = useState<GeneratedDocumentRecord[]>([]);
  const [currentDocumentId, setCurrentDocumentId] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [refinePrompt, setRefinePrompt] = useState('');
  const [refining, setRefining] = useState(false);
  const [refineStep, setRefineStep] = useState<'idle' | 'planning' | 'applying'>('idle');
  const [refinePlan, setRefinePlan] = useState<RefinePlan | null>(null);
  const [refinePreview, setRefinePreview] = useState<RefinePreview | null>(null);
  const [refineCursor, setRefineCursor] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [editHistory, setEditHistory] = useState<EditHistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateValidations, setTemplateValidations] = useState<Record<string, DocumentTemplateValidation>>({});
  const fileRoleOptions = roles.filter(role => role.type === 'file').map(role => ({ label: role.name, value: role.id }));
  const selectedGroups = (Form.useWatch('fileBindingGroups', form) || {}) as Record<string, string[]>;
  const templateFileTree = useMemo(() => buildTemplateFileTree(kbFiles), [kbFiles]);
  const filteredTemplateFileTree = useMemo(() => filterTemplateFileTree(templateFileTree, templateFileQuery), [templateFileTree, templateFileQuery]);
  const allTemplateFileKeys = useMemo(() => collectTemplateFileKeys(templateFileTree), [templateFileTree]);
  const currentProjectRoot = useMemo(() => prompts.find(item => item.selected)?.projectRoot || prompts.find(item => item.isCurrent)?.projectRoot || prompts[0]?.projectRoot || '', [prompts]);
  const allTemplateTreeKeys = useMemo(() => {
    const keys: string[] = [];
    const walk = (nodes: TemplateFileTreeNode[]) => {
      for (const node of nodes) { keys.push(node.key); if (node.children) walk(node.children); }
    };
    walk(templateFileTree);
    return keys;
  }, [templateFileTree]);
  const [flowSteps, setFlowSteps] = useState<FlowStep[]>([]);
  const [activeFlowKey, setActiveFlowKey] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<string>('templates');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<'workflow' | 'editor'>('workflow');
  const recoveryPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refineRequestRef = useRef(0);
  const activeGenStorageKey = useMemo(() => `activeGenDocId:${currentProjectRoot || 'default'}`, [currentProjectRoot]);

  const loadDrafts = async () => { try { setDrafts((await getGeneratedDocuments(currentProjectRoot || undefined)).documents); } catch { setDrafts([]); } };

  useEffect(() => {
    const sync = () => {
      if (!activeGenerationTask) return;
      setFlowSteps(activeGenerationTask.flowSteps); setActiveFlowKey(activeGenerationTask.activeFlowKey);
      setLoading(activeGenerationTask.loading);
      if (activeGenerationTask.documentId) setCurrentDocumentId(activeGenerationTask.documentId);
      if (activeGenerationTask.draft) setDraft(activeGenerationTask.draft);
      if (activeGenerationTask.content !== undefined) setContent(activeGenerationTask.content);
    };
    const task = activeGenerationTask;
    task?.listeners.add(sync); sync();
    return () => { task?.listeners.delete(sync); };
  }, []);

  useEffect(() => {
    setPageLoading(true);
    Promise.all([
      getDocumentTemplates().then(d => { setTemplates(d.templates); setTemplateId(d.templates[0]?.id ?? 'construction-organization-design'); }),
      getDocumentRoles().then(d => { setRoles(d.roles); setRoleConfigs(d.configs); }),
      getPromptProjects().then(items => setPrompts(items)),
    ]).catch(() => message.error(t('common.error'))).finally(() => setPageLoading(false));
  }, [message, t]);

  useEffect(() => {
    if (!currentProjectRoot) return;
    localStorage.removeItem('activeGenDocId');
    void loadDrafts();
  }, [currentProjectRoot]);

  // 页面刷新恢复：检查是否有未完成的生成任务
  useEffect(() => {
    if (drafts.length === 0) return;
    const storageKey = activeGenStorageKey;
    const savedDocId = localStorage.getItem(storageKey);
    if (!savedDocId) return;
    const match = drafts.find(d => d.id === savedDocId && d.status === 'generating');
    if (!match) { localStorage.removeItem(storageKey); return; }
    // 后台轻量轮询：刷新生成记录列表，保持刷新后生成中状态同步
    const poll = setInterval(() => {
      void (async () => {
        try {
          const { document: d } = await getGeneratedDocument(savedDocId, false, currentProjectRoot || undefined);
          await loadDrafts();
          if (d.status !== 'generating') {
            localStorage.removeItem(storageKey);
            clearInterval(poll);
          }
        } catch { clearInterval(poll); }
      })();
    }, 3000);
    return () => clearInterval(poll);
  }, [drafts]);

  const currentTemplate = useMemo(() => templates.find(t => t.id === templateId), [templates, templateId]);
  const roleConfigOptions = roleConfigs.map(c => ({ label: c.name, value: c.id }));
  const activeFlowIndex = Math.max(0, flowSteps.findIndex(s => s.key === activeFlowKey));
  const roleDisplayName = (roleId?: string) => roleId ? roles.find(role => role.id === roleId)?.name || STAGE_ROLE_NAMES[roleId] || '未知角色' : '';
  const promptDisplayName = (promptId?: string) => promptId ? prompts.find(prompt => prompt.id === promptId)?.projectName || roles.find(role => role.id === promptId)?.name || STAGE_ROLE_NAMES[promptId] || '未知提示词' : '';
  const stageActorName = (stage: GeneratedDocumentDraft['executionStages'][number]) => stage.subtitle || stage.roleName || roleDisplayName(stage.roleId) || STAGE_TITLES[stage.type] || stage.type;
  const stagePromptName = (stage: GeneratedDocumentDraft['executionStages'][number]) => stage.promptName || promptDisplayName(stage.promptId);

  const resetEditAssist = () => {
    refineRequestRef.current += 1;
    setRefinePrompt(''); setRefinePlan(null); setRefinePreview(null); setEditHistory([]); setHistoryOpen(false); setRefining(false); setRefineStep('idle');
  };
  const openDrawerForWorkflow = (id: string) => {
    setTemplateId(id); setCurrentDocumentId(null); setDraft(null); setContent(''); resetEditAssist();
    setDrawerMode('workflow'); setDrawerOpen(true); setLeftTab('drafts');
  };
  const openDrawerForEditor = async (item: GeneratedDocumentRecord) => {
    setCurrentDocumentId(item.id); setTemplateId(item.templateId);
    const isGenerating = isDraftGenerating(item.status);
    if (isGenerating || item.status === 'failed' || item.status === 'aborted') {
      resetEditAssist();
      setDraft(null); setContent(''); setLoading(isGenerating);
      setDrawerMode('workflow'); setDrawerOpen(true);
      try {
        const { document } = await getGeneratedDocument(item.id, false, item.projectRoot || currentProjectRoot || undefined);
        applyGeneratedRecordToWorkflow(document);
        if (isDraftGenerating(document.status)) startRecoveredGenerationPolling(document.id, document.projectRoot || item.projectRoot || currentProjectRoot || undefined);
        else await loadDrafts();
      } catch {
        applyGeneratedRecordToWorkflow(item);
      }
      return;
    }

    setDrawerMode('editor'); setFlowSteps([]); setActiveFlowKey(null); resetEditAssist();
    try {
      const { document } = await getGeneratedDocument(item.id, false, item.projectRoot || currentProjectRoot || undefined);
      setDraft(document.draft || null); setContent(document.editedMarkdown || document.markdown);
    } catch { message.error(t('common.error')); }
    setDrawerOpen(true);
  };

  const fmtDuration = (item: GeneratedDocumentRecord) => {
    const end = item.completedAt || item.updatedAt;
    const s = Math.max(0, Math.round((end - item.createdAt) / 1000));
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return rs ? `${m} 分 ${rs} 秒` : `${m} 分`;
    const h = Math.floor(m / 60), rm = m % 60;
    return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
  };
  const draftStatusColor = (s: GeneratedDocumentRecord['status']) => s === 'completed' ? 'success' : s === 'warning' ? 'warning' : s === 'failed' ? 'error' : s === 'aborted' ? 'default' : 'processing';
  const draftStatusText = (s: GeneratedDocumentRecord['status']) => s === 'completed' ? '已完成' : s === 'warning' ? '需复核' : s === 'failed' ? '失败' : s === 'aborted' ? '已中止' : '生成中';
  const isDraftGenerating = (s: GeneratedDocumentRecord['status']) => s !== 'completed' && s !== 'warning' && s !== 'failed' && s !== 'aborted';

  const subIcon = (s: FlowStepStatus) => {
    if (s === 'process') return <LoadingOutlined />;
    if (s === 'finish') return <CheckCircleOutlined />;
    if (s === 'warning') return <SafetyCertificateOutlined style={{ color: 'var(--colorWarning)' }} />;
    if (s === 'error') return <DeleteOutlined />;
    return <span style={{ display: 'inline-block', height: 6, width: 6, borderRadius: '50%', background: 'var(--colorTextTertiary)' }} />;
  };
  const stepDesc = (step: FlowStep) => (
    <div>
      {step.subtitle && <div style={{ marginBottom: 4 }}><Tag>{step.subtitle}</Tag></div>}
      <div>{step.description}</div>
      <div style={{ marginTop: 4 }}>{step.subSteps.map(item => <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--colorTextSecondary)' }}>{subIcon(item.status)}<span>{item.title}</span></div>)}</div>
    </div>
  );
  const flowIcon = (s: FlowStep) => s.status === 'process' ? <LoadingOutlined /> : s.status === 'warning' ? <SafetyCertificateOutlined style={{ color: 'var(--colorWarning)' }} /> : s.icon;
  const antdStatus = (s: FlowStepStatus) => s === 'warning' ? 'finish' as const : s;

  const setSnap = (steps: FlowStep[], key: string | null, isLoading = loading) => {
    if (activeGenerationTask?.loading) { activeGenerationTask.flowSteps = steps; activeGenerationTask.activeFlowKey = key; activeGenerationTask.loading = isLoading; notifyGenerationTask(); }
  };
  const updSubs = (step: FlowStep, st: FlowStepStatus) => {
    if (st === 'wait') return step.subSteps.map(s => ({ ...s, status: 'wait' as const }));
    if (st === 'finish') return step.subSteps.map(s => ({ ...s, status: 'finish' as const }));
    if (st === 'error') return step.subSteps.map((s, i) => ({ ...s, status: i === 0 ? 'error' as const : s.status }));
    const first = step.subSteps.findIndex(s => s.status === 'wait');
    return step.subSteps.map((s, i) => i < first || first === -1 ? { ...s, status: 'finish' as const } : i === first ? { ...s, status: 'process' as const } : s);
  };
  const stageToFlowStatus = (status: GeneratedDocumentDraft['executionStages'][number]['status']): FlowStepStatus => status === 'failed' ? 'error' : status === 'running' ? 'process' : status === 'fallback' ? 'warning' : 'finish';
  const stageIcon = (type: GeneratedDocumentDraft['executionStages'][number]['type']) => {
    if (type === 'role_binding') return <ApartmentOutlined />;
    if (type === 'knowledge_retrieval') return <DatabaseOutlined />;
    if (type === 'context_recall') return <BulbOutlined />;
    if (type === 'file_understanding') return <EyeOutlined />;
    if (type === 'fact_extraction') return <BulbOutlined />;
    if (type === 'chapter_generation') return <FormOutlined />;
    if (type === 'llm_review') return <ThunderboltOutlined />;
    if (type === 'validation') return <SafetyCertificateOutlined />;
    if (type === 'formatting') return <CheckCircleOutlined />;
    if (type === 'export_ready') return <FileDoneOutlined />;
    return <FileTextOutlined />;
  };
  const buildFlowStepsFromRecord = (record: GeneratedDocumentRecord): { steps: FlowStep[]; activeKey: string | null } => {
    const stages = record.executionStages || record.draft?.executionStages || [];
    if (stages.length > 0) {
      const steps = stages.map((stage, index) => {
        const status = (record.status === 'failed' || record.status === 'aborted') && stage.status === 'running' ? 'error' : stageToFlowStatus(stage.status);
        return {
          key: `${stage.type}-${index}`,
          title: stage.title || STAGE_TITLES[stage.type] || stage.type,
          subtitle: stageActorName(stage),
          description: stage.message || '',
          status,
          icon: stageIcon(stage.type),
          subSteps: [{ key: `stage-${index}`, title: stagePromptName(stage) ? `提示词：${stagePromptName(stage)}` : stageActorName(stage), status }],
        } satisfies FlowStep;
      });
      if (record.status === 'generating' && steps.length > 0 && steps.at(-1)?.status === 'finish') steps[steps.length - 1] = { ...steps[steps.length - 1], status: 'process' as const };
      const activeKey = record.status === 'generating' ? steps.at(-1)?.key || 'prepare' : (record.status === 'failed' || record.status === 'aborted') ? steps.find(step => step.status === 'error')?.key || steps.at(-1)?.key || 'prepare' : 'done';
      return { steps, activeKey };
    }
    return { steps: [], activeKey: null };
  };
  const applyGeneratedRecordToWorkflow = (record: GeneratedDocumentRecord) => {
    const { steps, activeKey } = buildFlowStepsFromRecord(record);
    setFlowSteps(steps); setActiveFlowKey(activeKey); setLoading(isDraftGenerating(record.status)); setSnap(steps, activeKey, isDraftGenerating(record.status));
    if (record.status === 'failed' || record.status === 'aborted') setDrawerMode('workflow');
    if ((record.status === 'completed' || record.status === 'warning') && record.draft) {
      setDraft(record.draft); setContent(record.editedMarkdown || record.markdown); setDrawerMode('editor'); setFlowSteps([]); setActiveFlowKey(null);
    }
  };
  const startRecoveredGenerationPolling = (documentId: string, projectRoot?: string) => {
    if (recoveryPollRef.current) clearInterval(recoveryPollRef.current);
    recoveryPollRef.current = setInterval(() => {
      void (async () => {
        try {
          const { document } = await getGeneratedDocument(documentId, true, projectRoot || currentProjectRoot || undefined);
          applyGeneratedRecordToWorkflow(document);
          await loadDrafts();
          if (!isDraftGenerating(document.status)) {
            if (recoveryPollRef.current) clearInterval(recoveryPollRef.current);
            recoveryPollRef.current = null;
            localStorage.removeItem(activeGenStorageKey);
          }
        } catch { /* ignore */ }
      })();
    }, 2000);
  };
  useEffect(() => () => {
    if (recoveryPollRef.current) {
      clearInterval(recoveryPollRef.current);
      recoveryPollRef.current = null;
    }
    if (autoStartTimerRef.current) {
      clearTimeout(autoStartTimerRef.current);
      autoStartTimerRef.current = null;
    }
  }, []);
  useEffect(() => {
    if (!loading || !activeFlowKey) return undefined;
    const t = window.setInterval(() => setFlowSteps(prev => {
      const n = prev.map(s => { if (s.key !== activeFlowKey || s.status !== 'process') return s; const cur = s.subSteps.findIndex(x => x.status === 'process'); const nxt = cur < 0 ? 0 : Math.min(cur + 1, s.subSteps.length - 1); return { ...s, subSteps: s.subSteps.map((x, i) => i < nxt ? { ...x, status: 'finish' as const } : i === nxt ? { ...x, status: 'process' as const } : { ...x, status: 'wait' as const }) }; });
      setSnap(n, activeFlowKey); return n;
    }), 1400);
    return () => window.clearInterval(t);
  }, [activeFlowKey, loading]);

  const loadTemplateFiles = async () => {
    setFileSearching(true);
    try {
      const result = await getKbFiles({ limit: 5000, projectRoot: currentProjectRoot || undefined });
      setKbFiles(result.files);
    } catch {
      message.error('知识库文件加载失败');
    } finally {
      setFileSearching(false);
    }
  };

  const openEditor = (tpl?: DocumentTemplate) => {
    const value = tpl ?? { id: `tpl-${Date.now()}`, name: '', description: '', category: '自定义', outputTitle: '', projectRoleConfigId: undefined, chapters: [], fileBindings: [] };
    form.resetFields();
    form.setFieldsValue({ ...value, fileBindingGroups: groupFileBindings(value.fileBindings) });
    setTemplateFileQuery('');
    void loadTemplateFiles();
    setTemplateModalOpen(true);
  };
  const updateTemplateFileBinding = (roleId: string, paths: string[]) => {
    const groups = (form.getFieldValue('fileBindingGroups') || {}) as Record<string, string[]>;
    form.setFieldValue('fileBindingGroups', { ...groups, [roleId]: uniqueValues(paths) });
  };

  const saveTpl = async () => {
    try {
      await form.validateFields();
      const v = form.getFieldsValue(true) as TemplateEditorForm;
      const groupValues = v.fileBindingGroups || {};
      const fileBindings = Object.entries(groupValues).flatMap(([roleId, paths]) => uniqueValues(paths || []).map(filePath => ({ roleId, filePath })));
      const { fileBindingGroups: _fileBindingGroups, ...templateValues } = v as TemplateEditorForm;
      const template = { ...templateValues, chapters: [], fileBindings } as DocumentTemplate;
      const r = await saveDocumentTemplate(template);
      setTemplates(r.templates); setTemplateId(r.template.id); setTemplateModalOpen(false); await loadDrafts(); message.success(t('common.success'));
    } catch (e) { if (e instanceof Error) message.error(e.message); }
  };
  const dupTpl = async (id: string) => { try { const r = await duplicateDocumentTemplate(id); setTemplates(r.templates); setTemplateId(r.template.id); message.success(t('common.success')); } catch { message.error(t('common.error')); } };
  const delTpl = async (id: string) => { try { const r = await deleteDocumentTemplate(id); setTemplates(r.templates); setTemplateId(r.templates[0]?.id ?? ''); message.success(t('common.success')); } catch { message.error(t('common.error')); } };
  const runTemplateWithValidation = async (id: string) => {
    try {
      const { validation } = await validateDocumentTemplate(id, currentProjectRoot || undefined);
      setTemplateValidations(prev => ({ ...prev, [id]: validation }));
      const errors = validation.issues.filter(issue => issue.level === 'error');
      setTemplateId(id);
      if (errors.length > 0) {
        message.warning('模板运行前检查未通过，请先处理阻断项');
        return;
      }
      if (validation.issues.length > 0) {
        message.warning('模板存在警告，可在检查面板确认后继续运行');
        return;
      }
      openDrawerForWorkflow(id);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '模板运行前检查失败');
    }
  };
  const delDraft = async (item: GeneratedDocumentRecord) => { try { await deleteGeneratedDocument(item.id, item.projectRoot || currentProjectRoot || undefined); if (currentDocumentId === item.id) { setCurrentDocumentId(null); setDraft(null); setContent(''); } await loadDrafts(); message.success(t('common.success')); } catch { message.error(t('common.error')); } };

  const waitForDoc = async (docId: string) => {
    for (;;) {
      const { document } = await getGeneratedDocument(docId, true, currentProjectRoot || undefined);
      applyGeneratedRecordToWorkflow(document);
      if ((document.status === 'completed' || document.status === 'warning') && document.draft) return document;
      if (document.status === 'failed' || document.status === 'aborted') throw new Error(document.error || (document.status === 'aborted' ? '生成已中止' : '生成失败'));
      await new Promise(r => window.setTimeout(r, 1500));
    }
  };

  const handleGenerate = async () => {
    if (!templateId) return;
    if (activeGenerationTask?.loading) { setFlowSteps(activeGenerationTask.flowSteps); setActiveFlowKey(activeGenerationTask.activeFlowKey); setLoading(true); return; }
    if (!currentProjectRoot) { message.error('未识别当前项目，请先选择或打开项目后再生成文件'); return; }
    setLoading(true);
    const promise = generateDocumentDraft({ templateId, projectRoot: currentProjectRoot });
    activeGenerationTask = { id: Date.now(), templateId, loading: true, flowSteps: [], activeFlowKey: null, promise, listeners: new Set() };
    setFlowSteps([]); setActiveFlowKey(null);
    const timers: number[] = [];
    try {
      const started = await promise;
      if (started.documentId) { localStorage.setItem(activeGenStorageKey, started.documentId); setCurrentDocumentId(started.documentId); if (activeGenerationTask?.promise === promise) activeGenerationTask.documentId = started.documentId; }
      await loadDrafts(); // 立即刷新列表，展示"生成中"记录
      const doc = started.documentId ? await waitForDoc(started.documentId) : undefined;
      const result = started.draft || doc?.draft;
      if (!result) throw new Error('生成结果为空');
      if (started.documentId || doc?.id) setCurrentDocumentId(started.documentId || doc!.id);
      timers.forEach(x => window.clearTimeout(x));
      setDraft(result); setContent(doc?.editedMarkdown || doc?.markdown || result.markdown);
      if (activeGenerationTask?.promise === promise) { activeGenerationTask.draft = result; activeGenerationTask.content = doc?.editedMarkdown || doc?.markdown || result.markdown; }
      const recordForFlow = doc || { id: started.documentId || `draft-${Date.now()}`, templateId, title: result.title, requirement: result.requirement, projectRoot: result.projectRoot || currentProjectRoot, projectId: result.projectId, markdown: result.markdown, status: result.validationIssues.some(x => x.level === 'error' || x.level === 'warning') || !result.exportGate.passed ? 'warning' as const : 'completed' as const, draft: result, executionStages: result.executionStages, assets: result.assets || [], createdAt: result.generatedAt, updatedAt: Date.now() };
      const { steps: finalSteps } = buildFlowStepsFromRecord(recordForFlow);
      setFlowSteps(finalSteps);
      setSnap(finalSteps, 'done', false);
      setActiveFlowKey('done');
      if (activeGenerationTask?.promise === promise) { activeGenerationTask.activeFlowKey = 'done'; activeGenerationTask.loading = false; notifyGenerationTask(); activeGenerationTask = null; }
      localStorage.removeItem(activeGenStorageKey);
      await loadDrafts();
      message.success(t('common.success'));
      window.setTimeout(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
    } catch (error) {
      localStorage.removeItem(activeGenStorageKey);
      const msg = error instanceof Error ? error.message : t('common.error');
      setFlowSteps(prev => { const n = prev.map(s => s.status === 'process' ? { ...s, status: 'error' as const, description: msg, subSteps: updSubs(s, 'error') } : s); setSnap(n, activeFlowKey, false); return n; });
      if (activeGenerationTask?.promise === promise) { activeGenerationTask.loading = false; activeGenerationTask.error = msg; notifyGenerationTask(); activeGenerationTask = null; }
      await loadDrafts().catch(() => undefined);
      message.error(msg);
    } finally { timers.forEach(x => window.clearTimeout(x)); setLoading(false); if (activeGenerationTask?.promise === promise) { activeGenerationTask.loading = false; notifyGenerationTask(); } }
  };

  const genStarted = useRef(false);
  useEffect(() => {
    if (autoStartTimerRef.current) {
      clearTimeout(autoStartTimerRef.current);
      autoStartTimerRef.current = null;
    }
    if (drawerOpen && drawerMode === 'workflow' && !currentDocumentId && !genStarted.current && !activeGenerationTask?.loading && currentTemplate?.projectRoleConfigId) {
      const startTemplateId = templateId;
      genStarted.current = true;
      autoStartTimerRef.current = setTimeout(() => {
        autoStartTimerRef.current = null;
        if (!drawerOpen || drawerMode !== 'workflow' || currentDocumentId || templateId !== startTemplateId) return;
        void handleGenerate();
      }, 300);
    }
    if (!drawerOpen) {
      genStarted.current = false;
    }
    return () => {
      if (autoStartTimerRef.current) {
        clearTimeout(autoStartTimerRef.current);
        autoStartTimerRef.current = null;
      }
    };
  }, [drawerOpen, drawerMode, currentDocumentId, currentTemplate, templateId]);

  const handleAbortGeneration = () => {
    void (async () => {
      if (currentDocumentId) await abortGeneratedDocument(currentDocumentId, currentProjectRoot || undefined).catch(() => undefined);
      if (activeGenerationTask) {
        activeGenerationTask.loading = false;
        activeGenerationTask.error = '用户中止';
        notifyGenerationTask();
        activeGenerationTask = null;
      }
      localStorage.removeItem(activeGenStorageKey);
      if (recoveryPollRef.current) { clearInterval(recoveryPollRef.current); recoveryPollRef.current = null; }
      setLoading(false); setFlowSteps([]); setActiveFlowKey(null);
      setDrawerOpen(false);
      await loadDrafts();
      message.info('已中止生成任务');
    })();
  };

  const handleAbortDraft = async (item: GeneratedDocumentRecord) => {
    if (activeGenerationTask?.loading && activeGenerationTask.documentId === item.id) {
      activeGenerationTask.loading = false;
      activeGenerationTask.error = '用户中止';
      notifyGenerationTask();
      activeGenerationTask = null;
      setLoading(false);
    }
    localStorage.removeItem(activeGenStorageKey);
    if (recoveryPollRef.current) { clearInterval(recoveryPollRef.current); recoveryPollRef.current = null; }
    try {
      await abortGeneratedDocument(item.id, item.projectRoot || currentProjectRoot || undefined);
      message.success('已中止生成任务');
    } catch {
      message.info('任务已不在运行，已刷新状态');
    } finally {
      await loadDrafts();
      if (currentDocumentId === item.id) { setCurrentDocumentId(null); setDraft(null); setContent(''); }
    }
  };
  const dl = (blob: Blob, name: string, mime: string) => {
    const b = new Blob([blob], { type: mime }); const u = URL.createObjectURL(b); const a = document.createElement('a');
    a.href = u; a.download = name; a.target = '_self'; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(u), 1000);
  };
  const doExport = async (fmt: 'markdown' | 'html' | 'pdf' | 'docx') => {
    if (!draft) return; setExporting(fmt);
    try {
      const mimes: Record<string, string> = { markdown: 'text/markdown;charset=utf-8', html: 'text/html;charset=utf-8', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
      const ext = fmt === 'markdown' ? 'md' : fmt;
      if (!draft.exportGate.passed) message.warning('导出门禁存在风险项，已允许导出，请下载后人工复核。');
      const payload = { documentId: currentDocumentId || undefined, title: draft.title, markdown: content, format: fmt, enforceGate: false, exportGate: draft.exportGate, useClientMarkdown: true };
      const blob = await exportDocument(payload);
      dl(blob, `${draft.title}.${ext}`, mimes[fmt]);
    } catch (e) { message.error(e instanceof Error ? e.message : t('common.error')); } finally { setExporting(null); }
  };
  const saveDraft = async () => {
    if (!draft) return;
    try { if (currentDocumentId) await updateGeneratedDocument(currentDocumentId, { editedMarkdown: content, markdown: content }, draft.projectRoot || currentProjectRoot || undefined); else { const r = await saveDocumentDraft({ ...draft, markdown: content }); setDraft(r.draft); } await loadDrafts(); message.success(t('common.success')); } catch { message.error(t('common.error')); }
  };
  const pushHistory = (value: string, prompt: string) => {
    setEditHistory(prev => [{ id: `${Date.now()}`, content: value, prompt, createdAt: Date.now() }, ...prev].slice(0, 12));
  };
  const resetRefineState = (clearPrompt = false) => {
    if (clearPrompt) setRefinePrompt('');
    setRefinePlan(null);
    setRefinePreview(null);
    setRefineCursor({ start: 0, end: 0 });
  };
  const currentRefineSelection = (): { selection?: RefineSelection; cursorOffset?: number } => {
    const start = refineCursor.start;
    const end = refineCursor.end;
    return end > start ? { selection: { start, end, text: content.slice(start, end) }, cursorOffset: start } : { cursorOffset: start };
  };
  const baseRefinePayload = (prompt: string, before: string) => ({
    title: draft?.title || '未命名文档',
    markdown: before,
    instruction: prompt,
    facts: draft?.structuredFacts?.map(fact => `${fact.key}: ${fact.value}`),
    chapters: draft?.chapters?.map(chapter => chapter.title),
    ...currentRefineSelection(),
  });
  const planRefine = async () => {
    const prompt = refinePrompt.trim();
    if (!draft || !prompt || refining) return;
    const requestId = refineRequestRef.current + 1;
    refineRequestRef.current = requestId;
    setRefining(true); setRefineStep('planning'); setRefinePreview(null);
    try {
      const documentId = currentDocumentId;
      const result = await refineGeneratedDocument({ mode: 'plan', ...baseRefinePayload(prompt, content) });
      if (refineRequestRef.current !== requestId || documentId !== currentDocumentId) return;
      if (!result.plan) throw new Error('AI 未返回修改计划');
      setRefinePlan(result.plan);
    } catch (e) { if (refineRequestRef.current === requestId) message.error(e instanceof Error ? e.message : t('common.error')); } finally { if (refineRequestRef.current === requestId) { setRefining(false); setRefineStep('idle'); } }
  };
  const generateRefinePreview = async (plan: RefinePlan) => {
    const prompt = refinePrompt.trim();
    if (!draft || !prompt || refining) return;
    const requestId = refineRequestRef.current + 1;
    refineRequestRef.current = requestId;
    setRefining(true); setRefineStep('applying');
    try {
      const before = content;
      const documentId = currentDocumentId;
      const result = await refineGeneratedDocument({ mode: 'apply', ...baseRefinePayload(prompt, before), plan });
      if (refineRequestRef.current !== requestId || documentId !== currentDocumentId) return;
      if (!result.markdown) throw new Error('AI 未返回修改结果');
      setRefinePreview({ plan: result.plan || plan, markdown: result.markdown, beforeSnippet: result.beforeSnippet, afterSnippet: result.afterSnippet, summary: result.summary, changedChars: result.changedChars, prompt, before });
    } catch (e) { if (refineRequestRef.current === requestId) message.error(e instanceof Error ? e.message : t('common.error')); } finally { if (refineRequestRef.current === requestId) { setRefining(false); setRefineStep('idle'); } }
  };
  const applyRefinePreview = () => {
    if (!refinePreview) return;
    pushHistory(refinePreview.before, refinePreview.prompt);
    setContent(refinePreview.markdown);
    resetRefineState(true);
    message.success('已应用精准修改');
  };
  const restoreHistory = (item: EditHistoryItem) => {
    pushHistory(content, '恢复前版本');
    setContent(item.content);
    resetRefineState(true);
    message.success('已恢复历史版本');
  };

  if (pageLoading) return (
    <div className="space-y-5 animateFadeIn">
      <Skeleton active title paragraph={{ rows: 1 }} />
      <Skeleton active paragraph={{ rows: 2 }} />
      <Skeleton active paragraph={{ rows: 8 }} />
    </div>
  );

  const drawerTitle = drawerMode === 'workflow'
    ? `工作流：${currentTemplate?.name || '选择模板'}`
    : `编辑：${draft?.title || currentTemplate?.outputTitle || '文档'}`;

  return (
    <div className="space-y-5 animateFadeIn">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div><h1 className="pageTitle">{t('documents.title')}</h1><p className="pageDesc">{t('documents.description')}</p></div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>{t('documents.newTemplate')}</Button>
      </div>

      <Card size="small"
        tabList={[
          { key: 'templates', label: `模板库 (${templates.length})` },
          { key: 'drafts', label: `生成记录 (${drafts.length})` },
        ]}
        activeTabKey={leftTab} onTabChange={setLeftTab}
      >
        {leftTab === 'templates' ? (
          templates.length === 0 ? <Empty description={t('common.noData')} /> : (
            <List dataSource={templates} renderItem={(item) => (
              <List.Item style={{ cursor: 'pointer', padding: '10px 0' }}
                actions={[
                  <Button key="cfg" size="small" icon={<SettingOutlined />} onClick={(e) => { e.stopPropagation(); openEditor(item); }}>配置</Button>,
                  <Button key="run" size="small" type="primary" icon={<PlayCircleOutlined />} onClick={(e) => { e.stopPropagation(); void runTemplateWithValidation(item.id); }}>运行</Button>,
                  <Button key="copy" size="small" icon={<CopyOutlined />} onClick={(e) => { e.stopPropagation(); void dupTpl(item.id); }} />,
                  <Popconfirm key="del" title={t('documents.deleteTemplateConfirm')} onConfirm={(e) => { e?.stopPropagation(); void delTpl(item.id); }}>
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                  </Popconfirm>,
                ]}
                onClick={() => setTemplateId(item.id)}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0, flex: 1 }}>
                  {templateIcon(item.category, templateId === item.id)}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <span style={{ fontWeight: templateId === item.id ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                      {templateId === item.id && <Tag color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px', flexShrink: 0 }}>当前</Tag>}
                      <Tag style={{ margin: 0, fontSize: 10, lineHeight: '16px', flexShrink: 0 }}>{item.category}</Tag>
                      {templateValidations[item.id] && <Tag color={templateValidations[item.id]!.issues.some(issue => issue.level === 'error') ? 'error' : templateValidations[item.id]!.issues.length ? 'warning' : 'success'} style={{ margin: 0, fontSize: 10, lineHeight: '16px', flexShrink: 0 }}>检查 {templateValidations[item.id]!.fileDiagnostics.length} 文件 / {templateValidations[item.id]!.promptDiagnostics.length} 提示词</Tag>}
                    </div>
                    {item.description && <Text type="secondary" style={{ fontSize: 12, lineHeight: '18px' }}>{item.description}</Text>}
                    {templateValidations[item.id] && (
                      <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 8, padding: 10, border: `1px solid ${templateValidations[item.id]!.issues.some(issue => issue.level === 'error') ? 'var(--colorErrorBorder)' : templateValidations[item.id]!.issues.length ? 'var(--colorWarningBorder)' : 'var(--colorSuccessBorder)'}`, borderRadius: 10, background: templateValidations[item.id]!.issues.some(issue => issue.level === 'error') ? 'var(--colorErrorBg)' : templateValidations[item.id]!.issues.length ? 'var(--colorWarningBg)' : 'var(--colorSuccessBg)' }}>
                        <Space direction="vertical" size={6} style={{ width: '100%' }}>
                          <Space wrap>
                            <Text strong>{templateValidations[item.id]!.issues.some(issue => issue.level === 'error') ? '运行前检查未通过' : templateValidations[item.id]!.issues.length ? '运行前检查存在警告' : '运行前检查通过'}</Text>
                            <Tag color="blue">文件角色 {templateValidations[item.id]!.fileDiagnostics.length}</Tag>
                            <Tag color="purple">提示词角色 {templateValidations[item.id]!.promptDiagnostics.length}</Tag>
                          </Space>
                          {templateValidations[item.id]!.issues.length > 0 ? templateValidations[item.id]!.issues.map(issue => <Alert key={issue.message} type={issue.level === 'error' ? 'error' : 'warning'} message={issue.message} showIcon />) : <Alert type="success" message="文件角色、提示词角色和后台自动规范检查通过，可以运行。" showIcon />}
                          {!templateValidations[item.id]!.issues.some(issue => issue.level === 'error') && templateValidations[item.id]!.issues.length > 0 && (
                            <div><Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => openDrawerForWorkflow(item.id)}>忽略警告并继续运行</Button></div>
                          )}
                        </Space>
                      </div>
                    )}
                  </div>
                </div>
              </List.Item>
            )} />
          )
        ) : (
          drafts.length === 0 ? <Empty description={t('common.noData')} /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {drafts.slice(0, 15).map((item, index) => (
                <div key={item.id}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', border: '1px solid var(--colorBorderSecondary)', borderRadius: 10, cursor: 'pointer', background: currentDocumentId === item.id ? 'var(--colorFillAlter)' : undefined, minWidth: 0 }}
                  onClick={() => { void openDrawerForEditor(item); }}
                >
                  {item.status === 'completed' ? <CheckCircleOutlined style={{ fontSize: 18, color: 'var(--colorOk)', flexShrink: 0, marginTop: 2 }} />
                    : item.status === 'failed' || item.status === 'aborted' ? <CloseCircleOutlined style={{ fontSize: 18, color: 'var(--colorDanger)', flexShrink: 0, marginTop: 2 }} />
                    : item.status === 'warning' ? <SafetyCertificateOutlined style={{ fontSize: 18, color: 'var(--colorWarning)', flexShrink: 0, marginTop: 2 }} />
                    : <SyncOutlined spin style={{ fontSize: 18, color: '#1677ff', flexShrink: 0, marginTop: 2 }} />}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>{item.title}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', color: 'var(--colorTextSecondary)', fontSize: 11 }}>
                      <span>{new Date(item.updatedAt).toLocaleString()}</span>
                      <span>耗时 {fmtDuration(item)}</span>
                    </div>
                    {(item.status === 'warning' || item.status === 'failed' || item.status === 'aborted') && (
                      <div style={{ marginTop: 3, color: item.status === 'failed' || item.status === 'aborted' ? 'var(--colorError)' : 'var(--colorWarning)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.error || item.warningIssues?.[0] || item.draft?.validationIssues.find(x => x.level === 'error' || x.level === 'warning')?.message || '需复核'}
                      </div>
                    )}
                  </div>
                  <Space size={4} align="center">
                    <Tag color={draftStatusColor(item.status)} style={{ margin: 0, fontSize: 10, lineHeight: '18px' }}>{draftStatusText(item.status)}</Tag>
                    <Tag style={{ margin: 0, fontSize: 10, lineHeight: '18px' }}>#{index + 1}</Tag>
                    <Popconfirm title="确认删除？" onConfirm={(e) => { e?.stopPropagation(); void delDraft(item); }}>
                      <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                    </Popconfirm>
                    {isDraftGenerating(item.status) && (
                      <Popconfirm title="确定中止此生成任务？" onConfirm={(e) => { e?.stopPropagation(); void handleAbortDraft(item); }}>
                        <Button size="small" danger onClick={(e) => e.stopPropagation()}>中止</Button>
                      </Popconfirm>
                    )}
                    <Button size="small" type="primary" icon={isDraftGenerating(item.status) ? <SyncOutlined spin /> : <PlayCircleOutlined />} onClick={(e) => { e.stopPropagation(); void openDrawerForEditor(item); }}>打开</Button>
                  </Space>
                </div>
              ))}
            </div>
          )
        )}
      </Card>

      <Drawer
        title={drawerTitle}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); if (recoveryPollRef.current) { clearInterval(recoveryPollRef.current); recoveryPollRef.current = null; } }}
        width={800} maskClosable={false}
        style={{ borderRadius: '12px 0 0 12px' }}
        styles={{ body: { padding: '16px 24px' }, header: { borderRadius: '12px 0 0 0', borderBottom: '1px solid var(--colorBorderSecondary)' } }}
        extra={draft ? <Space wrap>
          <Button icon={<SaveOutlined />} disabled={refining} onClick={() => { void saveDraft(); }}>{t('documents.saveDraft')}</Button>
          <Button icon={<DownloadOutlined />} disabled={refining} loading={exporting === 'markdown'} onClick={() => { void doExport('markdown'); }}>MD</Button>
          <Button disabled={refining} loading={exporting === 'html'} onClick={() => { void doExport('html'); }}>HTML</Button>
          <Button disabled={refining} loading={exporting === 'docx'} onClick={() => { void doExport('docx'); }}>DOCX</Button>
          <Button type="primary" disabled={refining} loading={exporting === 'pdf'} onClick={() => { void doExport('pdf'); }}>PDF</Button>
        </Space> : (loading && drawerMode === 'workflow') ? <Button danger onClick={handleAbortGeneration}>中止任务</Button> : undefined}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {/* 工作流模式：执行步骤 */}
          {drawerMode === 'workflow' && flowSteps.length > 0 && (
            <Steps direction="vertical" size="small" current={activeFlowIndex}
              items={flowSteps.map(s => ({ title: s.title, description: stepDesc(s), status: antdStatus(s.status), icon: flowIcon(s) }))} />
          )}

          {/* 工作流模式：步骤出现前的加载动画 */}
          {drawerMode === 'workflow' && loading && flowSteps.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40 }}><Spin tip="正在准备生成…" /></div>
          )}

          {/* 两种模式：编辑器（生成后或从草稿打开） */}
          {draft && (
            <div ref={editorRef}>
              <Tabs items={[
                  { key: 'edit', label: t('documents.edit'), children: (
                    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                      <TextArea rows={28} value={content} disabled={refining} onSelect={e => setRefineCursor({ start: e.currentTarget.selectionStart ?? 0, end: e.currentTarget.selectionEnd ?? e.currentTarget.selectionStart ?? 0 })} onChange={e => { setContent(e.target.value); setRefinePlan(null); setRefinePreview(null); setRefineCursor({ start: e.target.selectionStart ?? 0, end: e.target.selectionEnd ?? e.target.selectionStart ?? 0 }); }} />
                      <Card size="small" style={{ borderRadius: 12, background: 'linear-gradient(135deg, var(--colorFillAlter), var(--colorBgContainer))' }}>
                        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                          <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
                            <div>
                              <Space size={6}><ThunderboltOutlined style={{ color: 'var(--colorAccent)' }} /><Text strong>精准修改</Text><Tag color="blue">AI 辅助</Tag></Space>
                              <div style={{ marginTop: 4, color: 'var(--colorTextSecondary)', fontSize: 12 }}>针对当前编辑内容补充更具体的要求，AI 会保留文档结构并按你的提示细化修改。</div>
                            </div>
                            <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryOpen(v => !v)} disabled={editHistory.length === 0}>历史版本 {editHistory.length > 0 ? editHistory.length : ''}</Button>
                          </Space>
                          <Alert type="info" showIcon message="系统只负责识别修改范围，不改写你的提示词；选中文字后优先只改选区，没有选区时按光标所在小节/章节定位。" />
                          <TextArea rows={4} value={refinePrompt} disabled={refining} onChange={e => { setRefinePrompt(e.target.value); setRefinePlan(null); setRefinePreview(null); }} placeholder="例如：写细一点；润色这段；第七章补充高处作业和临电安全措施；把安全检查频次改成每周一次。" />
                          <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
                            <Space wrap>
                              {['写细一点', '更专业', '只润色选区', '补充可执行措施'].map(text => <Button key={text} size="small" disabled={refining} onClick={() => setRefinePrompt(prev => prev ? `${prev}；${text}` : text)}>{text}</Button>)}
                            </Space>
                            <Button type="primary" icon={<ThunderboltOutlined />} loading={refining && refineStep === 'planning'} disabled={!refinePrompt.trim() || refining} onClick={() => { void planRefine(); }}>识别修改范围</Button>
                          </Space>
                          {refinePlan && !refinePreview && (
                            <Card size="small" style={{ borderRadius: 10, borderColor: 'var(--colorAccent)' }}>
                              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                                <Space wrap><Tag color="purple">{refinePlan.scope}</Tag><Tag color="blue">{refinePlan.action}</Tag><Tag color={refinePlan.confidence >= 0.8 ? 'green' : 'orange'}>置信度 {Math.round(refinePlan.confidence * 100)}%</Tag>{refinePlan.targetTitle && <Text strong>{refinePlan.targetTitle}</Text>}</Space>
                                <Text>{refinePlan.summary}</Text>
                                <Text type="secondary" style={{ fontSize: 12 }}>将按你的原始提示词执行，不添加额外编辑任务。</Text>
                                <Space><Button type="primary" loading={refining && refineStep === 'applying'} onClick={() => { void generateRefinePreview(refinePlan); }}>执行并预览</Button><Button disabled={refining} onClick={() => setRefinePlan(null)}>取消</Button></Space>
                              </Space>
                            </Card>
                          )}
                          {refinePreview && (
                            <Card size="small" style={{ borderRadius: 10, borderColor: 'var(--colorSuccess)' }}>
                              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                                <Space wrap><Tag color="green">修改预览</Tag><Text>{refinePreview.summary || refinePreview.plan.summary}</Text><Tag>{refinePreview.changedChars && refinePreview.changedChars > 0 ? `+${refinePreview.changedChars}` : refinePreview.changedChars} 字符</Tag></Space>
                                <Row gutter={12}>
                                  <Col span={12}><Text strong>修改前</Text><div style={{ marginTop: 6, maxHeight: 180, overflow: 'auto', padding: 10, borderRadius: 8, background: 'var(--colorFillAlter)', whiteSpace: 'pre-wrap', fontSize: 12 }}>{refinePreview.beforeSnippet || '无片段预览'}</div></Col>
                                  <Col span={12}><Text strong>修改后</Text><div style={{ marginTop: 6, maxHeight: 180, overflow: 'auto', padding: 10, borderRadius: 8, background: 'var(--colorFillAlter)', whiteSpace: 'pre-wrap', fontSize: 12 }}>{refinePreview.afterSnippet || '无片段预览'}</div></Col>
                                </Row>
                                <Space><Button type="primary" onClick={applyRefinePreview}>应用到文档</Button><Button onClick={() => setRefinePreview(null)}>返回计划</Button><Button danger onClick={() => { setRefinePlan(null); setRefinePreview(null); }}>放弃</Button></Space>
                              </Space>
                            </Card>
                          )}
                          {historyOpen && (
                            <div style={{ borderTop: '1px solid var(--colorBorderSecondary)', paddingTop: 12 }}>
                              <List size="small" dataSource={editHistory} locale={{ emptyText: '暂无历史版本' }} renderItem={item => (
                                <List.Item actions={[<Button key="restore" size="small" disabled={refining} onClick={() => restoreHistory(item)}>恢复</Button>]}>
                                  <List.Item.Meta title={<Space><Text>{new Date(item.createdAt).toLocaleString()}</Text><Tag>{item.prompt}</Tag></Space>} description={<Text type="secondary" ellipsis>{item.content.replace(/\s+/gu, ' ').slice(0, 120)}</Text>} />
                                </List.Item>
                              )} />
                            </div>
                          )}
                        </Space>
                      </Card>
                    </Space>
                  ) },
                  {
                    key: 'chapters-facts', label: '章节与事实',
                    children: <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      {draft.chapters.length > 0 && <div>
                        <Text strong style={{ fontSize: 13, marginBottom: 8, display: 'block' }}>章节 ({draft.chapters.length})</Text>
                        <List size="small" dataSource={draft.chapters} renderItem={c => (
                          <List.Item>
                            <List.Item.Meta title={c.title} description={`证据: ${c.evidence.length} · 缺失: ${c.missingFacts.length}`} />
                          </List.Item>
                        )} />
                      </div>}
                      {draft.structuredFacts.length > 0 && <div>
                        <Text strong style={{ fontSize: 13, marginBottom: 8, display: 'block' }}>结构化事实 ({draft.structuredFacts.length})</Text>
                        <Descriptions size="small" column={1} bordered>
                          {draft.structuredFacts.map((f, i) => <Descriptions.Item key={i} label={f.key}><span>{f.value}</span><Tag style={{ marginLeft: 8 }}>{f.confidence.toFixed(2)}</Tag><Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>{f.sourceFile}</Text></Descriptions.Item>)}
                        </Descriptions>
                      </div>}
                    </div>
                  },
                  {
                    key: 'sources-missing', label: '来源与缺失',
                    children: <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      <div><Text strong style={{ fontSize: 13, marginBottom: 8, display: 'block' }}>引用来源 ({draft.sources.length})</Text>
                        {draft.sources.length === 0 ? <Empty description="暂无" /> : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{draft.sources.map(s => <Tag key={s.filePath} color="blue">{s.filePath} ({s.count})</Tag>)}</div>}
                      </div>
                      <div><Text strong style={{ fontSize: 13, marginBottom: 8, display: 'block' }}>缺失项 ({draft.missingItems.length})</Text>
                        {draft.missingItems.length === 0 ? <Empty description="无缺失" /> : <List size="small" dataSource={draft.missingItems} renderItem={m => <List.Item>{m}</List.Item>} />}
                      </div>
                    </div>
                  },
                  {
                    key: 'validation', label: `校验 (${draft.validationIssues.length})`,
                    children: draft.validationIssues.length === 0 ? <Empty description="校验通过" /> : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {draft.validationIssues.map(item => (
                          <div key={`${item.level}-${item.message}`} style={{ border: '1px solid var(--colorBorderSecondary)', borderRadius: 8, padding: 12 }}>
                            <Tag color={item.level === 'error' ? 'error' : item.level === 'warning' ? 'warning' : 'blue'}>{item.level}</Tag>
                            <div style={{ marginTop: 6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-all', lineHeight: 1.6 }}>{item.message}</div>
                            {item.suggestion && <div style={{ marginTop: 6, color: 'var(--colorTextSecondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-all' }}>{item.suggestion}</div>}
                          </div>
                        ))}
                        {draft.exportGate.checklist.length > 0 && <div style={{ marginTop: 8 }}>
                          <Text strong style={{ fontSize: 13, marginBottom: 8, display: 'block' }}>导出门禁</Text>
                          <List size="small" dataSource={draft.exportGate.checklist} renderItem={c => <List.Item><Text style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{c.label}</Text><Tag color={c.passed ? 'success' : 'error'}>{c.passed ? 'PASS' : 'FAIL'}</Tag></List.Item>} />
                        </div>}
                      </div>
                    )
                  },
                  {
                    key: 'stages', label: `执行阶段 (${draft.executionStages.length})`,
                    children: <List size="small" dataSource={draft.executionStages} renderItem={s => (
                      <List.Item>
                        <List.Item.Meta avatar={STAGE_ICONS[s.type] || <FileTextOutlined />}
                          title={<Text title={s.roleId} style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{`${STAGE_TITLES[s.type] || s.type} · ${s.roleName || roleDisplayName(s.roleId)}`}</Text>}
                          description={<Text type="secondary" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{s.message}</Text>} />
                        <Tag color={s.status === 'success' ? 'success' : s.status === 'failed' ? 'error' : s.status === 'skipped' ? 'default' : 'warning'}>{s.status}</Tag>
                      </List.Item>
                    )} />
                  },
                ]} />
            </div>
          )}
        </Space>
      </Drawer>

      <Drawer
        title={t('documents.templateEditor')}
        open={templateModalOpen}
        onClose={() => setTemplateModalOpen(false)}
        width={860}
        maskClosable={false}
        styles={{ body: { padding: 20, overflow: 'auto' }, header: { borderBottom: '1px solid var(--colorBorderSecondary)' } }}
        extra={
          <Space>
            <Button onClick={() => setTemplateModalOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => { void saveTpl(); }}>{t('common.save')}</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" requiredMark="optional">
          <Row gutter={12}>
            <Form.Item name="id" hidden><Input /></Form.Item>
            <Col xs={24} md={8}><Form.Item name="name" label={t('documents.templateName')} rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="category" label={t('documents.templateCategory')}><Input /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="outputTitle" label={t('documents.outputTitle')}><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="description" label={t('documents.templateDescription')}><Input /></Form.Item></Col>
          </Row>
          <Form.Item name="projectRoleConfigId" label={t('documents.projectRoleConfig')} rules={[{ required: true, message: t('documents.projectRoleConfigRequired') }]}>
            <Select showSearch placeholder={t('documents.projectRoleConfigRequired')} options={roleConfigOptions} />
          </Form.Item>
          <div style={{ marginBottom: 16 }}>
            <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text strong>项目文件绑定</Text>
              <Tag color="blue">按文件角色多选</Tag>
            </Space>
            <Alert type="info" showIcon style={{ marginBottom: 12 }} message="每个文件角色可直接勾选文件或文件夹；勾选文件夹会自动绑定该文件夹下所有文件。保存时仍按具体文件路径绑定，兼容现有模板和生成流程。" />
            <Input.Search allowClear placeholder="搜索文件或文件夹" value={templateFileQuery} onChange={e => setTemplateFileQuery(e.target.value)} style={{ marginBottom: 12 }} />
            {fileSearching ? <div style={{ textAlign: 'center', padding: 24 }}><Spin tip="正在加载知识库文件…" /></div> : fileRoleOptions.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可用文件角色" /> : templateFileTree.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无知识库文件" /> : fileRoleOptions.map(option => {
              const checkedPaths = uniqueValues(selectedGroups[option.value] || []).filter(path => allTemplateFileKeys.includes(path));
              const visibleFileKeys = new Set(collectTemplateFileKeys(filteredTemplateFileTree));
              return (
                <Card key={option.value} size="small" style={{ marginBottom: 12 }} title={<Space><Text>{option.label}</Text><Tag color="blue">已选 {checkedPaths.length}</Tag></Space>} extra={<Button size="small" disabled={checkedPaths.length === 0} onClick={() => updateTemplateFileBinding(option.value, [])}>清空</Button>}>
                  <Form.Item name={['fileBindingGroups', option.value]} hidden><Input /></Form.Item>
                  <div style={{ marginBottom: 8, color: 'var(--colorTextSecondary)', fontSize: 12 }}>
                    {checkedPaths.length > 0 ? checkedPaths.slice(0, 3).map(fileDisplayName).join('、') + (checkedPaths.length > 3 ? ` 等 ${checkedPaths.length} 个文件` : '') : '未选择文件'}
                  </div>
                  <Tree
                    checkable
                    blockNode
                    height={320}
                    treeData={filteredTemplateFileTree}
                    checkedKeys={checkedPaths}
                    expandedKeys={templateFileQuery.trim() ? allTemplateTreeKeys : expandedTemplateFileKeys}
                    onExpand={keys => setExpandedTemplateFileKeys(keys)}
                    onCheck={(_, info) => {
                      const selected = new Set(checkedPaths.filter(path => !visibleFileKeys.has(path)));
                      for (const node of info.checkedNodes as TemplateFileTreeNode[]) {
                        if (node.isFolder) collectTemplateFileKeys([node]).forEach(path => selected.add(path));
                        else selected.add(node.key);
                      }
                      updateTemplateFileBinding(option.value, Array.from(selected));
                    }}
                  />
                </Card>
              );
            })}
          </div>
          <Alert type="info" showIcon message="文档规范由后台根据模板、提示词和角色绑定自动生成，无需手动维护规范包。" />
        </Form>
      </Drawer>
    </div>
  );
}
