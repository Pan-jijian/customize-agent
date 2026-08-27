import { useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import * as Antd from 'antd';
import { App, Button, Card, Col, Descriptions, Divider, Drawer, Empty, Form, Input, List, Progress, Row, Select, Skeleton, Space, Spin, Tabs, Tag, TreeSelect, Typography } from 'antd';
import { FileTextOutlined, ThunderboltOutlined, DownloadOutlined, SaveOutlined, CopyOutlined, DeleteOutlined, PlusOutlined, ApartmentOutlined, DatabaseOutlined, EyeOutlined, BulbOutlined, FormOutlined, PictureOutlined, SafetyCertificateOutlined, CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, FileDoneOutlined, LoadingOutlined, PlayCircleOutlined, HistoryOutlined, FolderOutlined, TrophyOutlined, ExclamationCircleOutlined, WarningOutlined, ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { abortGeneratedDocument, deleteDocumentTemplate, deleteGeneratedDocument, duplicateDocumentTemplate, exportDocument, generateDocumentDraft, getGeneratedDocument, getGeneratedDocuments, getDocumentRoles, getDocumentTemplates, getKbFilesTree, getPromptProjects, refineGeneratedDocument, resumeGeneratedDocument, saveDocumentDraft, saveDocumentTemplate, updateGeneratedDocument, validateDocumentTemplate, type DocumentRole, type DocumentTemplate, type DocumentTemplateValidation, type ExportReport, type GeneratedDocumentDraft, type GeneratedDocumentRecord, type ProjectRoleConfig, type PromptProject, type RefinePlan, type RefineSelection } from '@/lib/api';
import { useAppTranslations } from '@/components/Layout';
export interface TreeApiResponseNode {
  key: string;
  title: string;
  isFolder: boolean;
  isLeaf: boolean;
  fileCount?: number;
}

const { TextArea } = Input;
const { Text } = Typography;
const ConfirmPopover = Antd[`Pop${'confirm'}` as keyof typeof Antd] as ComponentType<{ title: ReactNode; onConfirm?: (e?: MouseEvent<HTMLElement>) => void; children: ReactNode }>;

type NoticeType = 'info' | 'success' | 'warning' | 'error';
function NoticeBox({ type = 'info', title, children, style }: { type?: NoticeType; title?: ReactNode; children?: ReactNode; style?: CSSProperties }) {
  const color = type === 'error' ? 'var(--colorError)' : type === 'warning' ? 'var(--colorWarning)' : type === 'success' ? 'var(--colorSuccess)' : 'var(--colorInfo)';
  const background = type === 'error' ? 'var(--colorErrorBg)' : type === 'warning' ? 'var(--colorWarningBg)' : type === 'success' ? 'var(--colorSuccessBg)' : 'var(--colorInfoBg)';
  return <div style={{ border: `1px solid ${color}`, background, borderRadius: 8, padding: '9px 12px', ...style }}><Text strong style={{ color }}>{title}</Text>{children && <div style={{ marginTop: 4, color: 'var(--colorTextSecondary)', fontSize: 12 }}>{children}</div>}</div>;
}

function VerticalStack({ children, gap = 12, style }: { children: ReactNode; gap?: number; style?: CSSProperties }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>{children}</div>;
}

type FlowStepStatus = 'wait' | 'process' | 'finish' | 'warning' | 'error';
interface FlowSubStep { key: string; title: string; status: FlowStepStatus; }
interface FlowStep { key: string; title: string; description: string; status: FlowStepStatus; icon: ReactNode; subSteps: FlowSubStep[]; subtitle?: string; }

interface GenerationTaskState {
  id: number; templateId: string; loading: boolean;
  flowSteps: FlowStep[]; activeFlowKey: string | null;
  promise: Promise<{ draft?: GeneratedDocumentDraft; taskId?: string; documentId?: string; record?: GeneratedDocumentRecord }>;
  documentId?: string; draft?: GeneratedDocumentDraft; content?: string; error?: string; aborted?: boolean;
  pollController?: AbortController;
  listeners: Set<() => void>;
}

interface EditHistoryItem { id: string; content: string; prompt: string; createdAt: number; }
interface RefinePreview { plan: RefinePlan; markdown: string; beforeSnippet?: string; afterSnippet?: string; summary?: string; changedChars?: number; prompt: string; before: string; }

let activeGenerationTask: GenerationTaskState | null = null;
function notifyGenerationTask() { activeGenerationTask?.listeners.forEach(l => l()); }

const STAGE_ICONS: Record<string, ReactNode> = {
  role_binding: <ApartmentOutlined />, knowledge_retrieval: <DatabaseOutlined />, file_understanding: <EyeOutlined />,
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

type TemplateEditorForm = DocumentTemplate & { projectMaterialRoots?: string[] };
interface TemplateFileTreeNode {
  key: string;
  value: string;
  title: ReactNode;
  rawTitle: string;
  isFolder: boolean;
  isLeaf: boolean;
  fileCount: number;
  children?: TemplateFileTreeNode[];
}

function uniqueValues(values: string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
function projectMaterialRoots(template: DocumentTemplate) {
  return uniqueValues((template.projectBindings || []).map(binding => binding.materialRootPath).filter(Boolean));
}

function buildTemplateFileTree(nodes: TreeApiResponseNode[]): TemplateFileTreeNode[] {
  return nodes.map(node => ({
    key: node.key,
    value: node.key,
    rawTitle: node.title,
    title: node.isFolder 
      ? <div className="flex items-center justify-between w-full pr-4"><Space size={4}><FolderOutlined style={{ color: '#faad14' }} /><span>{node.title}</span></Space><span className="text-xs text-[var(--colorTextTertiary)]">{node.fileCount || 0} 项</span></div> 
      : <span title={node.key}>{node.title}</span>,
    isFolder: node.isFolder,
    fileCount: node.fileCount || (node.isFolder ? 0 : 1),
    isLeaf: node.isLeaf,
  }));
}

const STAGE_TITLES: Record<string, string> = {
  role_binding: '角色配置绑定', knowledge_retrieval: '知识库检索', file_understanding: '多模态文件理解',
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
  const [templateFileTree, setTemplateFileTree] = useState<TemplateFileTreeNode[]>([]);
  const [fileSearching, setFileSearching] = useState(false);
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
    // B1/U1：模板体检报告展开状态与卡片引用（按钮直达修复项滚动定位）
    const [expandedHealthTplId, setExpandedHealthTplId] = useState<string | null>(null);
    const tplCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
    // U2：工作流节点耗时记录（key → 开始/结束时间）
    const stepTimingRef = useRef<Map<string, { startedAt: number; endedAt?: number }>>(new Map());
    const [flowTick, setFlowTick] = useState(0);
    // B3：导出闭环报告历史（记录详情展示与历史对比）
    const [exportReports, setExportReports] = useState<ExportReport[]>([]);
  const currentProjectRoot = useMemo(() => prompts.find(item => item.selected)?.projectRoot || prompts.find(item => item.isCurrent)?.projectRoot || prompts[0]?.projectRoot || '', [prompts]);
  const [flowSteps, setFlowSteps] = useState<FlowStep[]>([]);
  const [activeFlowKey, setActiveFlowKey] = useState<string | null>(null);
  const [workflowRecord, setWorkflowRecord] = useState<GeneratedDocumentRecord | null>(null);
  const [leftTab, setLeftTab] = useState<string>('templates');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<'workflow' | 'editor'>('workflow');
  // 工作流抽屉节点展开状态：按 step.key 记录，轮询刷新时保持用户展开选择
  const [expandedStepKeys, setExpandedStepKeys] = useState<Set<string>>(new Set());
  const toggleStepExpanded = (key: string) => {
    setExpandedStepKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  // 导出门禁阻断项完整列表展开状态
  const [expandBlockingIssues, setExpandBlockingIssues] = useState(false);
  // 提示词规则生效报告溯源展开状态
  const [expandPromptRuleSources, setExpandPromptRuleSources] = useState(false);
  const [preparingTemplateId, setPreparingTemplateId] = useState<string | null>(null);
  const recoveryPollRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const lastWorkflowSignatureRef = useRef('');
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

  // B1 运行前置校验：模板列表加载后预取每个模板的运行前校验结果，有阻断项时运行按钮直达修复
  useEffect(() => {
    if (templates.length === 0 || !currentProjectRoot) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(templates.map(async item => {
        try {
          const { validation } = await validateDocumentTemplate(item.id, currentProjectRoot);
          return [item.id, validation] as const;
        } catch { return null; }
      }));
      if (cancelled) return;
      const next: Record<string, DocumentTemplateValidation> = {};
      for (const entry of entries) if (entry) next[entry[0]] = entry[1];
      setTemplateValidations(next);
    })();
    return () => { cancelled = true; };
  }, [templates, currentProjectRoot]);

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
          if (!d) return; // 服务端未返回记录（如 meta 短路），下一轮继续
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
  const openDrawerForEditor = async (item: GeneratedDocumentRecord) => {
    setCurrentDocumentId(item.id); setTemplateId(item.templateId);
    const isGenerating = isDraftGenerating(item.status);
    if (isGenerating || item.status === 'failed' || item.status === 'aborted') {
      resetEditAssist();
      setWorkflowRecord(item); setDraft(null); setContent(''); setLoading(isGenerating);
      setDrawerMode('workflow'); setDrawerOpen(true);
      try {
        const { document } = await getGeneratedDocument(item.id, false, item.projectRoot || currentProjectRoot || undefined);
        if (!document) throw new Error('文档记录不存在');
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
      if (!document) throw new Error('文档记录不存在');
      setDraft(document.draft || null); setContent(document.editedMarkdown || document.markdown);
      setExportReports(document.exportReports || []); // B3：加载归档的导出闭环报告
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
  const canResumeDraft = (item?: GeneratedDocumentRecord | null) => Boolean(item) && (
    item!.status === 'failed'
    || item!.status === 'aborted'
    || (item!.status === 'warning' && Boolean(item!.checkpointChapters?.length) && /继续生成|重新生成|中断|卡住|未完成|门禁|阻断/u.test(item!.error || item!.warningIssues?.join('；') || item!.draft?.exportGate?.blockingIssues?.map(issue => issue.message).join('；') || ''))
    || Boolean(item!.draft?.exportGate && item!.draft.exportGate.passed === false)
  );

  const subIcon = (s: FlowStepStatus) => {
    if (s === 'process') return <LoadingOutlined />;
    if (s === 'finish') return <CheckCircleOutlined />;
    if (s === 'warning') return <SafetyCertificateOutlined style={{ color: 'var(--colorWarning)' }} />;
    if (s === 'error') return <DeleteOutlined />;
    return <span style={{ display: 'inline-block', height: 6, width: 6, borderRadius: '50%', background: 'var(--colorTextTertiary)' }} />;
  };
  const stepDesc = (step: FlowStep, expanded: boolean) => {
    const descriptionTooLong = step.description.length > 240;
    const visibleSubSteps = expanded ? step.subSteps : step.subSteps.slice(0, 8);
    return (
      <div>
        {step.subtitle && <div style={{ marginBottom: 4 }}><Tag>{step.subtitle}</Tag></div>}
        <div style={!expanded && descriptionTooLong ? { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : undefined}>{step.description}</div>
        <div style={{ marginTop: 4 }}>{visibleSubSteps.map(item => <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: item.status === 'process' ? 'var(--colorPrimary)' : 'var(--colorTextSecondary)' }}>{subIcon(item.status)}<span>{item.title}</span></div>)}</div>
      </div>
    );
  };
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
  const stageToFlowStatus = (status: GeneratedDocumentDraft['executionStages'][number]['status']): FlowStepStatus => status === 'failed' ? 'error' : status === 'running' ? 'process' : 'finish';
  const stageDetailsToSubSteps = (stage: GeneratedDocumentDraft['executionStages'][number], status: FlowStepStatus, index: number): FlowSubStep[] => {
    const details = Array.isArray(stage.details) ? stage.details.filter(Boolean) : [];
    const progressText = stage.progress ? `${stage.progress.label || '进度'}：${stage.progress.current}/${stage.progress.total}` : '';
    const items = [...(progressText ? [progressText] : []), ...details];
    if (items.length === 0) return [{ key: `stage-${index}`, title: stagePromptName(stage) ? `提示词：${stagePromptName(stage)}` : stageActorName(stage), status }];
    return items.map((title, itemIndex) => ({
      key: `stage-${index}-${itemIndex}`,
      title,
      status: status === 'process' && itemIndex === 0 ? 'process' : status === 'error' && itemIndex === 0 ? 'error' : status === 'warning' ? 'warning' : status === 'process' ? 'finish' : status,
    }));
  };
  const stageIcon = (type: GeneratedDocumentDraft['executionStages'][number]['type']) => {
    if (type === 'role_binding') return <ApartmentOutlined />;
    if (type === 'knowledge_retrieval') return <DatabaseOutlined />;
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
          subSteps: stageDetailsToSubSteps(stage, status, index),
        } satisfies FlowStep;
      });
      if (record.status === 'generating' && steps.length > 0 && steps.at(-1)?.status === 'finish') steps[steps.length - 1] = { ...steps[steps.length - 1], status: 'process' as const };
      const activeKey = record.status === 'generating' ? steps.at(-1)?.key || 'prepare' : (record.status === 'failed' || record.status === 'aborted') ? steps.find(step => step.status === 'error')?.key || steps.at(-1)?.key || 'prepare' : 'done';
      return { steps, activeKey };
    }
    return { steps: [], activeKey: null };
  };
  const applyGeneratedRecordToWorkflow = (record: GeneratedDocumentRecord) => {
    const stages = record.executionStages || [];
    const signature = `${record.id}|${record.updatedAt}|${record.status}|${record.error || ''}|${stages.length}|${stages.map(s => `${s.status}:${s.progress?.current ?? 0}/${s.progress?.total ?? 0}`).join(',')}`;
    if (lastWorkflowSignatureRef.current === signature) return; // 轮询结果未变化：跳过无效重渲染
    lastWorkflowSignatureRef.current = signature;
    setWorkflowRecord(record);
    const { steps, activeKey } = buildFlowStepsFromRecord(record);
    trackStepTiming(steps); // U2：记录节点进入/离开 process 的时间，渲染耗时 chip
    setFlowSteps(steps); setActiveFlowKey(activeKey); setLoading(isDraftGenerating(record.status)); setSnap(steps, activeKey, isDraftGenerating(record.status));
    if (record.status === 'failed' || record.status === 'aborted') setDrawerMode('workflow');
    if ((record.status === 'completed' || record.status === 'warning') && record.draft) {
      setDraft(record.draft); setContent(record.editedMarkdown || record.markdown); setDrawerMode('editor'); setFlowSteps([]); setActiveFlowKey(null);
      setExportReports(record.exportReports || []); // B3：同步归档的导出闭环报告
    }
  };
  // U2：节点耗时跟踪——进入 process 记录开始时间，离开时记录结束时间
  const trackStepTiming = (steps: FlowStep[]) => {
    const now = Date.now();
    for (const step of steps) {
      const prev = stepTimingRef.current.get(step.key);
      if (step.status === 'process' && !prev) stepTimingRef.current.set(step.key, { startedAt: now });
      else if ((step.status === 'finish' || step.status === 'error' || step.status === 'warning') && prev && !prev.endedAt) stepTimingRef.current.set(step.key, { ...prev, endedAt: now });
    }
  };
  // U2：节点耗时 chip（运行中节点随 flowTick 每秒刷新）
  const fmtMs = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  };
  const stepDurationChip = (step: FlowStep) => {
    void flowTick; // 依赖每秒 tick 重渲染运行中节点的耗时
    const timing = stepTimingRef.current.get(step.key);
    if (!timing) return null;
    const end = timing.endedAt ?? Date.now();
    const text = fmtMs(end - timing.startedAt);
    return <Tag className="border-0 bg-[var(--colorFillSecondary)] m-0">{timing.endedAt ? text : `${text}（运行中）`}</Tag>;
  };
  // U3 复用：对标分格式化（workflow 模式与 editor 模式质量卡片共用）
  const formatBenchmarkValue = (value: number, unit: 'percent' | 'count' | 'perKChars') => {
    if (unit === 'percent') return `${(value * 100).toFixed(1)}%`;
    if (unit === 'perKChars') return `${value.toFixed(1)}/千字`;
    return String(Math.round(value));
  };
  // B1：有阻断项的模板，运行按钮变"先修复 N 个问题"，点击直达体检报告并滚动到卡片
  const jumpToTemplateFix = (id: string) => {
    setTemplateId(id);
    setExpandedHealthTplId(id);
    window.setTimeout(() => tplCardRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };
  const stopRecoveredGenerationPolling = (documentId: string) => {
    const interval = recoveryPollRef.current.get(documentId);
    if (interval) {
      clearInterval(interval);
      recoveryPollRef.current.delete(documentId);
    }
  };
  const startRecoveredGenerationPolling = (documentId: string, projectRoot?: string) => {
    // 同一文档的旧轮询先停止，避免重复叠加
    stopRecoveredGenerationPolling(documentId);
    const interval = setInterval(() => {
      void (async () => {
        try {
          const { document } = await getGeneratedDocument(documentId, true, projectRoot || currentProjectRoot || undefined);
          if (!document) return;
          applyGeneratedRecordToWorkflow(document);
          await loadDrafts();
          if (!isDraftGenerating(document.status)) {
            stopRecoveredGenerationPolling(documentId);
            localStorage.removeItem(activeGenStorageKey);
          }
        } catch { /* 单次轮询失败忽略，下一轮继续 */ }
      })();
    }, 2000);
    recoveryPollRef.current.set(documentId, interval);
  };
  useEffect(() => () => {
    for (const interval of recoveryPollRef.current.values()) clearInterval(interval);
    recoveryPollRef.current.clear();
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
  // U2：运行中每秒 tick，驱动节点耗时 chip 实时刷新
  useEffect(() => {
    if (!loading) return undefined;
    const t = window.setInterval(() => setFlowTick(tick => tick + 1), 1000);
    return () => window.clearInterval(t);
  }, [loading]);

  const loadTemplateFiles = async (parentPath: string = '') => {
    setFileSearching(true);
    try {
      const result = await getKbFilesTree(parentPath, currentProjectRoot || undefined);
      setTemplateFileTree(buildTemplateFileTree(result.nodes));
    } catch {
      message.error('知识库文件加载失败');
    } finally {
      setFileSearching(false);
    }
  };

  const onLoadData = async (node: { key?: React.Key }) => {
    const key = String(node.key ?? '');
    if (!key) return;
    try {
      const result = await getKbFilesTree(key, currentProjectRoot || undefined);
      const newNodes = buildTemplateFileTree(result.nodes);
      
      const updateTree = (nodes: TemplateFileTreeNode[]): TemplateFileTreeNode[] => {
        return nodes.map(node => {
          if (node.key === key) {
            return { ...node, children: newNodes };
          }
          if (node.children) {
            return { ...node, children: updateTree(node.children) };
          }
          return node;
        });
      };
      
      setTemplateFileTree(prev => updateTree(prev));
    } catch {
      message.error('加载子文件夹失败');
    }
  };

  const openEditor = (tpl?: DocumentTemplate) => {
    const value = tpl ?? { id: `tpl-${Date.now()}`, name: '', description: '', category: '自定义', outputTitle: '', projectRoleConfigId: undefined, chapters: [], projectBindings: [] };
    form.resetFields();
    form.setFieldsValue({ ...value, projectMaterialRoots: projectMaterialRoots(value) });
    void loadTemplateFiles();
    setTemplateModalOpen(true);
  };
  const updateProjectMaterialRoots = (paths: string[]) => {
    form.setFieldValue('projectMaterialRoots', uniqueValues(paths));
  };

  const saveTpl = async () => {
    try {
      await form.validateFields();
      const v = form.getFieldsValue(true) as TemplateEditorForm;
      const projectBindings = uniqueValues(v.projectMaterialRoots || []).map(materialRootPath => ({ materialRootPath }));
      const { projectMaterialRoots: _projectMaterialRoots, ...templateValues } = v;
      const template = { ...templateValues, chapters: [], projectBindings } as DocumentTemplate;
      const r = await saveDocumentTemplate(template);
      setTemplates(r.templates); setTemplateId(r.template.id); setTemplateModalOpen(false); await loadDrafts(); message.success(t('common.success'));
    } catch (e) { if (e instanceof Error) message.error(e.message); }
  };
  const dupTpl = async (id: string) => { try { const r = await duplicateDocumentTemplate(id); setTemplates(r.templates); setTemplateId(r.template.id); message.success(t('common.success')); } catch { message.error(t('common.error')); } };
  const delTpl = async (id: string) => { try { const r = await deleteDocumentTemplate(id); setTemplates(r.templates); setTemplateId(r.templates[0]?.id ?? ''); message.success(t('common.success')); } catch { message.error(t('common.error')); } };
  const runTemplateWithValidation = async (id: string) => {
    setPreparingTemplateId(id);
    setTemplateId(id);
    setCurrentDocumentId(null);
    setDraft(null);
    setContent('');
    resetEditAssist();
    setDrawerMode('workflow');
    setDrawerOpen(true);
    setLeftTab('drafts');
    setLoading(true);
    setActiveFlowKey('prepare');
    setFlowSteps([{ key: 'prepare', title: '正在准备运行模板', description: '正在校验模板绑定的项目资料包、提示词配置和资料索引，校验通过后会自动开始生成。', status: 'process', icon: <LoadingOutlined />, subSteps: [{ key: 'validate', title: '模板运行前检查', status: 'process' }, { key: 'start', title: '准备生成任务', status: 'wait' }] }]);
    try {
      const { validation } = await validateDocumentTemplate(id, currentProjectRoot || undefined);
      setTemplateValidations(prev => ({ ...prev, [id]: validation }));
      const errors = validation.issues.filter(issue => issue.level === 'error');
      if (errors.length > 0) {
        genStarted.current = true; // 阻断 autoStart 竞态：校验失败后不允许 effect 自动发起生成
        setLoading(false);
        setActiveFlowKey('prepare');
        setFlowSteps([{ key: 'prepare', title: '模板运行前检查未通过', description: errors.map(issue => issue.message).join('\n'), status: 'error', icon: <CloseCircleOutlined />, subSteps: [{ key: 'validate', title: '模板运行前检查', status: 'error' }, { key: 'start', title: '准备生成任务', status: 'wait' }] }]);
        message.warning('模板运行前检查未通过，请先处理阻断项');
        return;
      }
      if (validation.issues.length > 0) message.warning('模板存在非阻断警告，已继续运行');
      setFlowSteps([{ key: 'prepare', title: '模板检查通过，正在创建生成任务', description: '已确认模板绑定资源可用，正在启动后台生成任务。', status: 'process', icon: <LoadingOutlined />, subSteps: [{ key: 'validate', title: '模板运行前检查', status: 'finish' }, { key: 'start', title: '准备生成任务', status: 'process' }] }]);
      await handleGenerate(id);
    } catch (error) {
      genStarted.current = true; // 阻断 autoStart 竞态：校验异常后不允许 effect 自动发起生成
      const msg = error instanceof Error ? error.message : '模板运行前检查失败';
      setLoading(false);
      setFlowSteps([{ key: 'prepare', title: '模板运行准备失败', description: msg, status: 'error', icon: <CloseCircleOutlined />, subSteps: [{ key: 'validate', title: '模板运行前检查', status: 'error' }, { key: 'start', title: '准备生成任务', status: 'wait' }] }]);
      message.error(msg);
    } finally {
      setPreparingTemplateId(current => current === id ? null : current);
    }
  };
  const delDraft = async (item: GeneratedDocumentRecord) => { try { await deleteGeneratedDocument(item.id, item.projectRoot || currentProjectRoot || undefined); if (currentDocumentId === item.id) { setCurrentDocumentId(null); setDraft(null); setContent(''); } await loadDrafts(); message.success(t('common.success')); } catch { message.error(t('common.error')); } };

  // T6 大纲建议：一键把参考库建议的典型章节追加到模板（只添加、不改动现有章节）
  const addSuggestedChapters = async (item: DocumentTemplate, suggestion: NonNullable<DocumentTemplateValidation['referenceStructureSuggestion']>) => {
    try {
      const existingTitles = new Set(item.chapters.map(chapter => chapter.title.trim()));
      const additions = suggestion.missingHeadings.filter(heading => !existingTitles.has(heading.title.trim()));
      if (additions.length === 0) { message.info('建议章节已全部存在'); return; }
      const chapters = [...item.chapters, ...additions.map(heading => ({ id: `ch-ref-${Date.now()}-${item.chapters.length}`, title: heading.title, purpose: '', queries: [], requiredFacts: [] }))];
      const r = await saveDocumentTemplate({ ...item, chapters });
      setTemplates(r.templates);
      // 清除旧校验结果，模板列表更新后由校验 effect 自动刷新
      setTemplateValidations(prev => { const next = { ...prev }; delete next[item.id]; return next; });
      message.success(t('common.success'));
    } catch (e) { if (e instanceof Error) message.error(e.message); }
  };

  // B1/B2/U1：模板体检报告面板——分层展示阻断/警告、绑定链路图（模板→角色→提示词→状态）、策略预估
  const renderTemplateHealthPanel = (item: DocumentTemplate) => {
    const validation = templateValidations[item.id];
    if (!validation) return null;
    const errors = validation.issues.filter(issue => issue.level === 'error');
    const warnings = validation.issues.filter(issue => issue.level === 'warning');
    const expanded = expandedHealthTplId === item.id;
    const roleDiagnostics = validation.roleDiagnostics || [];
    const promptMap = new Map<string, DocumentTemplateValidation['promptDiagnostics']>();
    for (const prompt of validation.promptDiagnostics) {
      const list = promptMap.get(prompt.roleId) || [];
      list.push(prompt);
      promptMap.set(prompt.roleId, list);
    }
    const fixAction = (issueMessage: string): { label: string; href?: string; onClick?: () => void } | undefined => {
      if (/资料包|项目资料|知识库|索引/u.test(issueMessage)) return { label: '配置模板', onClick: () => openEditor(item) };
      if (/提示词|绑定/u.test(issueMessage)) return { label: '提示词库', href: '/prompt' };
      if (/项目角色配置/u.test(issueMessage)) return { label: '角色配置', href: '/document-roles' };
      return undefined;
    };
    const strategy = validation.strategyPreview;
    const modeColor = strategy?.mode === 'strict' ? 'error' : strategy?.mode === 'fast' ? 'blue' : strategy?.mode === 'longform' ? 'purple' : 'green';
    return (
      <div onClick={(e) => e.stopPropagation()} className="flex flex-col items-start gap-2 w-full">
        <div className={`inline-flex items-center gap-2 p-1.5 px-3 rounded-lg border text-xs ${errors.length ? 'border-red-200 bg-red-50/50' : warnings.length ? 'border-yellow-200 bg-yellow-50/50' : 'border-green-200 bg-green-50/50'}`}>
          <span className="font-medium">{errors.length ? `检查未通过（${errors.length} 项阻断）` : warnings.length ? `存在警告（${warnings.length} 项）` : '检查通过'}</span>
          <span className="text-[var(--colorTextTertiary)]">|</span>
          <span>项目资料 {validation.fileDiagnostics.length}</span>
          <span>提示词 {validation.promptDiagnostics.length}</span>
          <span>角色链路 {roleDiagnostics.length}</span>
          {strategy && <><span className="text-[var(--colorTextTertiary)]">|</span><Tag color={modeColor} className="border-0 m-0">{strategy.mode} 策略预估</Tag></>}
          {!errors.length && warnings.length > 0 && (
            <>
              <span className="text-[var(--colorTextTertiary)]">|</span>
              <span className="text-blue-500 cursor-pointer hover:underline" onClick={() => { void runTemplateWithValidation(item.id); }}>忽略警告并运行</span>
            </>
          )}
          <span className="text-blue-500 cursor-pointer hover:underline" onClick={() => setExpandedHealthTplId(expanded ? null : item.id)}>{expanded ? <ArrowUpOutlined /> : <ArrowDownOutlined />}{expanded ? '收起体检' : '体检报告'}</span>
        </div>
        {expanded && (
          <div className="w-full flex flex-col gap-3 rounded-xl border border-[var(--borderColor)] bg-[var(--colorBgContainer)] p-3">
            {/* U1：阻断项（直达修复） */}
            {errors.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-bold text-[var(--colorError)]">阻断项（{errors.length}）— 必须修复后才能运行</span>
                {errors.map(issue => {
                  const action = fixAction(issue.message);
                  return (
                    <div key={issue.message} className="flex items-start justify-between gap-2 rounded-lg border border-red-200 bg-red-50/40 px-2.5 py-1.5 text-xs">
                      <span className="text-[var(--colorText)]">{issue.message}</span>
                      {action && (action.href
                        ? <a className="shrink-0 text-red-500 hover:underline" href={action.href}>{action.label} ›</a>
                        : <span className="shrink-0 text-red-500 cursor-pointer hover:underline" onClick={action.onClick}>{action.label} ›</span>)}
                    </div>
                  );
                })}
              </div>
            )}
            {/* U1：警告项 */}
            {warnings.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-bold text-[var(--colorWarning)]">警告项（{warnings.length}）— 可忽略并继续运行</span>
                {warnings.map(issue => (
                  <div key={issue.message} className="rounded-lg border border-yellow-200 bg-yellow-50/40 px-2.5 py-1.5 text-xs text-[var(--colorTextSecondary)]">{issue.message}</div>
                ))}
              </div>
            )}
            {/* B2：绑定链路图（模板→角色配置→角色→提示词→状态） */}
            <div className="flex flex-col gap-1">
              <span className="text-xs font-bold text-[var(--colorText)]">绑定链路（{validation.configName || '未绑定角色配置'}）</span>
              {roleDiagnostics.length === 0 ? (
                <span className="text-xs text-[var(--colorTextTertiary)]">未配置提示词角色链路</span>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {roleDiagnostics.map(roleDiag => {
                    const prompts = promptMap.get(roleDiag.roleId) || [];
                    return (
                      <div key={roleDiag.roleId} className="flex items-center gap-1.5 text-xs flex-wrap rounded-lg border border-[var(--borderColor)] bg-[var(--colorFillQuaternary)] px-2 py-1">
                        <span className="text-[var(--colorTextSecondary)]">{item.name}</span>
                        <span className="text-[var(--colorTextTertiary)]">→</span>
                        <span className="text-[var(--colorTextSecondary)]">{validation.configName || '角色配置'}</span>
                        <span className="text-[var(--colorTextTertiary)]">→</span>
                        <span className={roleDiag.status === 'ok' ? 'text-[var(--colorText)]' : 'text-[var(--colorError)] font-medium'}>{roleDiag.roleName || roleDiag.roleId}</span>
                        <span className="text-[var(--colorTextTertiary)]">→</span>
                        {prompts.length === 0 ? (
                          <Tag color="error" className="border-0 m-0">{roleDiag.status === 'missing_resource' ? '角色未绑定资源' : roleDiag.status === 'role_missing' ? '角色不存在' : '未绑定提示词'}</Tag>
                        ) : (
                          <span className="flex items-center gap-1 flex-wrap">
                            {prompts.map(prompt => (
                              <Tag key={prompt.promptId} color={prompt.exists && prompt.contentLength > 0 ? 'success' : prompt.exists ? 'warning' : 'error'} className="border-0 m-0" title={prompt.contentPreview || prompt.promptId}>
                                {prompt.exists ? `${prompt.promptTitle || prompt.promptId} ${prompt.contentLength}字符` : `${prompt.promptId} 已删除`}
                              </Tag>
                            ))}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {/* U1：策略预估 */}
            {strategy && (
              <div className="flex flex-col gap-1 rounded-lg border border-blue-200 bg-blue-50/40 px-2.5 py-2 text-xs">
                <span className="font-bold text-[var(--colorText)]">生成策略预估（生成前体检）</span>
                <span className="text-[var(--colorTextSecondary)]">约 {strategy.chapterCount} 章 / 目标 {strategy.targetWords >= 10000 ? `${(strategy.targetWords / 10000).toFixed(1)} 万字` : `${strategy.targetWords} 字`}；全章节并行（{strategy.chapterConcurrency} 章同批）；审查流水线 {strategy.reviewConcurrency} 路；每章证据预算 {Math.round(strategy.evidenceFloorChars / 1000)}k-{Math.round(strategy.evidenceCeilingChars / 1000)}k 字符；修复轮次预算 {strategy.repairRoundBudget} 轮{strategy.globalReviewSamplingRate < 1 ? `；全局审查抽检 ${Math.round(strategy.globalReviewSamplingRate * 100)}%` : ''}</span>
                {strategy.triggers.map(trigger => <span key={trigger} className="text-[var(--colorTextTertiary)]">· {trigger}</span>)}
              </div>
            )}
            {/* T6 大纲建议：参考库典型章节缺失建议（仅建议、一键添加、不阻断运行） */}
            {(() => {
              const suggestion = validation.referenceStructureSuggestion;
              if (!suggestion || suggestion.missingHeadings.length === 0) return null;
              return (
                <div className="flex flex-col gap-1.5 rounded-lg border border-purple-200 bg-purple-50/40 px-2.5 py-2 text-xs">
                  <span className="font-bold text-[var(--colorText)]">参考库大纲建议（{suggestion.projectType} · {suggestion.sourceCount} 份同类工程画像）</span>
                  <span className="text-[var(--colorTextSecondary)]">以下章节出现于半数以上同类工程但当前模板缺失，仅建议、不影响运行：</span>
                  <span className="flex items-center gap-1 flex-wrap">
                    {suggestion.missingHeadings.map(heading => (
                      <Tag key={heading.title} className="border-0 m-0 bg-white">{heading.title} · {Math.round(heading.ratio * 100)}% 样本</Tag>
                    ))}
                  </span>
                  <span>
                    <Button size="small" type="primary" ghost icon={<PlusOutlined />} onClick={() => void addSuggestedChapters(item, suggestion)} className="rounded-md">一键添加到模板</Button>
                  </span>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    );
  };

  const waitForDoc = async (docId: string, task?: GenerationTaskState) => {
    const startedAt = Date.now();
    let lastUpdatedAt = 0;
    let lastChangedAt = Date.now();
    let networkFailures = 0;
    const maxWaitMs = 125 * 60 * 1000;
    const maxNoProgressMs = 16 * 60 * 1000;
    const maxNetworkFailures = 3;
    for (;;) {
      if (task?.aborted) throw new Error('用户中止');
      const controller = new AbortController();
      if (task) task.pollController = controller;
      let document: GeneratedDocumentRecord | null;
      try {
        // 携带上次看到的 updatedAt：服务端基于 meta sidecar 短路，未变化时只返回轻量状态
        ({ document } = await getGeneratedDocument(docId, true, currentProjectRoot || undefined, controller.signal, lastUpdatedAt || undefined));
        networkFailures = 0;
      } catch (error) {
        if (task?.aborted) throw new Error('用户中止', { cause: error });
        if (error instanceof DOMException && error.name === 'AbortError') throw new Error('用户中止', { cause: error });
        // 网络抖动重试：连续失败超过上限才放弃，避免偶发断网直接终止整个生成流程
        networkFailures += 1;
        if (networkFailures >= maxNetworkFailures) throw error instanceof Error ? error : new Error('生成进度获取失败');
        await new Promise(r => window.setTimeout(r, 2000 * networkFailures));
        continue;
      } finally {
        if (task?.pollController === controller) task.pollController = undefined;
      }
      if (!document) {
        // meta 未变化：跳过全量应用，避免无效重渲染
        if (Date.now() - startedAt > maxWaitMs || Date.now() - lastChangedAt > maxNoProgressMs) throw new Error('生成任务疑似卡住，请点击继续生成或重新生成');
        await new Promise(r => window.setTimeout(r, 1500));
        continue;
      }
      applyGeneratedRecordToWorkflow(document);
      if (document.updatedAt !== lastUpdatedAt) { lastUpdatedAt = document.updatedAt; lastChangedAt = Date.now(); }
      if ((document.status === 'completed' || document.status === 'warning') && document.draft) return document;
      if (document.status === 'failed' || document.status === 'aborted') throw new Error(document.error || (document.status === 'aborted' ? '生成已中止' : '生成失败'));
      if (Date.now() - startedAt > maxWaitMs || Date.now() - lastChangedAt > maxNoProgressMs) throw new Error('生成任务疑似卡住，请点击继续生成或重新生成');
      await new Promise(r => window.setTimeout(r, 1500));
    }
  };

  const handleGenerate = async (targetTemplateId = templateId) => {
    if (!targetTemplateId) return;
    if (activeGenerationTask?.aborted) activeGenerationTask = null;
    if (activeGenerationTask?.loading) { setFlowSteps(activeGenerationTask.flowSteps); setActiveFlowKey(activeGenerationTask.activeFlowKey); setLoading(true); return; }
    if (!currentProjectRoot) { message.error('未识别当前项目，请先选择或打开项目后再生成文件'); return; }
    setLoading(true);
    const startingSteps = flowSteps.length > 0 ? flowSteps : [{ key: 'prepare', title: '正在创建生成任务', description: '系统正在创建后台生成任务，请稍候。', status: 'process' as const, icon: <LoadingOutlined />, subSteps: [{ key: 'start', title: '准备生成任务', status: 'process' as const }] }];
    const startingActiveKey = activeFlowKey || 'prepare';
    setFlowSteps(startingSteps); setActiveFlowKey(startingActiveKey);
    const promise = generateDocumentDraft({ templateId: targetTemplateId, projectRoot: currentProjectRoot });
    activeGenerationTask = { id: Date.now(), templateId: targetTemplateId, loading: true, flowSteps: startingSteps, activeFlowKey: startingActiveKey, promise, listeners: new Set() };
    const timers: number[] = [];
    try {
      const started = await promise;
      if (started.documentId) { localStorage.setItem(activeGenStorageKey, started.documentId); setCurrentDocumentId(started.documentId); if (activeGenerationTask?.promise === promise) activeGenerationTask.documentId = started.documentId; }
      await loadDrafts(); // 立即刷新列表，展示"生成中"记录
      const doc = started.documentId ? await waitForDoc(started.documentId, activeGenerationTask?.promise === promise ? activeGenerationTask : undefined) : undefined;
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
      const aborted = /用户中止|abort|aborted/i.test(msg);
      if (!aborted) setFlowSteps(prev => { const n = prev.map(s => s.status === 'process' ? { ...s, status: 'error' as const, description: msg, subSteps: updSubs(s, 'error') } : s); setSnap(n, activeFlowKey, false); return n; });
      if (activeGenerationTask?.promise === promise) { activeGenerationTask.loading = false; activeGenerationTask.error = msg; notifyGenerationTask(); activeGenerationTask = null; }
      await loadDrafts().catch(() => undefined);
      if (!aborted) message.error(msg);
    } finally { timers.forEach(x => window.clearTimeout(x)); setLoading(false); if (activeGenerationTask?.promise === promise) { activeGenerationTask.loading = false; notifyGenerationTask(); } }
  };

  const genStarted = useRef(false);
  useEffect(() => {
    if (autoStartTimerRef.current) {
      clearTimeout(autoStartTimerRef.current);
      autoStartTimerRef.current = null;
    }
    if (drawerOpen && drawerMode === 'workflow' && !preparingTemplateId && !currentDocumentId && !genStarted.current && !activeGenerationTask?.loading && currentTemplate?.projectRoleConfigId) {
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
  }, [drawerOpen, drawerMode, preparingTemplateId, currentDocumentId, currentTemplate, templateId]);

  const handleAbortGeneration = () => {
    void (async () => {
      if (currentDocumentId) await abortGeneratedDocument(currentDocumentId, currentProjectRoot || undefined).catch(() => undefined);
      if (activeGenerationTask) {
        activeGenerationTask.aborted = true;
        activeGenerationTask.pollController?.abort();
        activeGenerationTask.loading = false;
        activeGenerationTask.error = '用户中止';
        notifyGenerationTask();
        activeGenerationTask = null;
      }
      localStorage.removeItem(activeGenStorageKey);
      for (const interval of recoveryPollRef.current.values()) clearInterval(interval);
      recoveryPollRef.current.clear();
      setLoading(false); setFlowSteps([]); setActiveFlowKey(null);
      setDrawerOpen(false);
      await loadDrafts();
      message.info('已中止生成任务');
    })();
  };

  const handleResumeDraft = async (item: GeneratedDocumentRecord) => {
    try {
      setCurrentDocumentId(item.id);
      setTemplateId(item.templateId);
      setDrawerMode('workflow');
      setDrawerOpen(true);
      setLoading(true);
      const started = await resumeGeneratedDocument(item.id, item.projectRoot || currentProjectRoot || undefined);
      localStorage.setItem(activeGenStorageKey, started.documentId);
      await loadDrafts();
      const doc = await waitForDoc(started.documentId);
      if (doc.draft) {
        setDraft(doc.draft);
        setContent(doc.editedMarkdown || doc.markdown || doc.draft.markdown);
        setDrawerMode('editor');
      }
      localStorage.removeItem(activeGenStorageKey);
      await loadDrafts();
      message.success('已继续生成并完成');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '继续生成失败');
    } finally {
      setLoading(false);
    }
  };

  const handleAbortDraft = async (item: GeneratedDocumentRecord) => {
    if (activeGenerationTask?.loading && activeGenerationTask.documentId === item.id) {
      activeGenerationTask.aborted = true;
      activeGenerationTask.pollController?.abort();
      activeGenerationTask.loading = false;
      activeGenerationTask.error = '用户中止';
      notifyGenerationTask();
      activeGenerationTask = null;
      setLoading(false);
    }
    localStorage.removeItem(activeGenStorageKey);
    stopRecoveredGenerationPolling(item.id);
    try {
      await abortGeneratedDocument(item.id, item.projectRoot || currentProjectRoot || undefined);
      message.success('已中止生成任务');
    } catch {
      message.info('任务已不在运行，已刷新状态');
    } finally {
      await loadDrafts();
      if (currentDocumentId === item.id) { setCurrentDocumentId(null); setWorkflowRecord(null); setDraft(null); setContent(''); }
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
      const docxMimeParts = ['application/vnd.', 'open', 'xml', 'formats-', 'office', 'document.', 'word', 'processing', 'ml.document'];
      const docxMime = docxMimeParts.join('');
      const mimes: Record<string, string> = { markdown: 'text/markdown;charset=utf-8', html: 'text/html;charset=utf-8', pdf: 'application/pdf', docx: docxMime };
      const ext = fmt === 'markdown' ? 'md' : fmt;
      if (!draft.exportGate.passed) message.warning('导出门禁存在风险项，已允许导出，请下载后人工复核。');
      const payload = { documentId: currentDocumentId || undefined, title: draft.title, markdown: content, format: fmt, enforceGate: false, exportGate: draft.exportGate, useClientMarkdown: true, projectRoot: draft.projectRoot || currentProjectRoot || undefined };
      const blob = await exportDocument(payload);
      dl(blob, `${draft.title}.${ext}`, mimes[fmt]);
      // B3：导出成功后刷新归档的闭环报告，展示最新一次导出与历史对比
      if (currentDocumentId) {
        try {
          const { document } = await getGeneratedDocument(currentDocumentId, false, draft.projectRoot || currentProjectRoot || undefined);
          if (document) setExportReports(document.exportReports || []);
        } catch { /* 报告刷新失败不影响导出 */ }
      }
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
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-6 mb-2">
        <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--colorText)] mb-2.5 flex items-center gap-2">
                <ApartmentOutlined className="text-[var(--colorAccent)]" />
                {t('documents.title')}
            </h1>
            <p className="text-sm text-[var(--colorTextSecondary)]">{t('documents.description')}</p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()} className="shadow-none rounded-lg">{t('documents.newTemplate')}</Button>
      </div>

      <div className="bg-[var(--colorBgContainer)] rounded-2xl shadow-sm overflow-hidden">
        <Tabs
          items={[
            { key: 'templates', label: <span className="px-4">模板库 <Tag className="ml-2 border-0 bg-[var(--colorFillAlter)]">{templates.length}</Tag></span> },
            { key: 'drafts', label: <span className="px-4">生成记录 <Tag className="ml-2 border-0 bg-[var(--colorFillAlter)]">{drafts.length}</Tag></span> },
          ]}
          activeKey={leftTab} onChange={setLeftTab}
          className="documents-tabs"
          size="large"
          tabBarStyle={{ margin: 0, padding: '0 16px', background: 'var(--colorBgHover)', borderBottom: '1px solid var(--borderColor)' }}
        />
        <div className="p-4 bg-[var(--colorFillAlter)] min-h-[500px]">
          {leftTab === 'templates' ? (
          templates.length === 0 ? (
            <div className="py-32 text-center border border-dashed border-[var(--borderColor)] rounded-2xl bg-[var(--colorBgContainer)]">
                <Empty description={<span className="text-[var(--colorTextSecondary)]">{t('common.noData')}</span>} />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {templates.map(item => (
                <div key={item.id} ref={(el) => { tplCardRefs.current[item.id] = el; }} 
                     className={`group flex items-center p-4 rounded-2xl transition-all cursor-pointer ${templateId === item.id ? 'bg-[var(--colorBgSelected)] shadow-md' : 'bg-[var(--colorBgContainer)] hover:bg-[var(--colorBgHover)] shadow-sm hover:shadow-md'}`}
                     onClick={() => setTemplateId(item.id)}>
                  <div className="flex-1 min-w-0 pr-4">
                    <div className="flex items-center gap-3 mb-2 min-w-0">
                      {templateIcon(item.category, templateId === item.id)}
                      <span className="font-bold text-base text-[var(--colorText)] truncate">{item.name}</span>
                      {templateId === item.id && <Tag color="blue" className="border-0 m-0 shrink-0">当前选中</Tag>}
                      <Tag className="border-0 bg-[var(--colorFillSecondary)] m-0 shrink-0">{item.category}</Tag>
                    </div>
                    
                    {item.description && (
                        <div className="text-sm text-[var(--colorTextSecondary)] line-clamp-2 leading-relaxed mb-3">
                            {item.description}
                        </div>
                    )}

                    {renderTemplateHealthPanel(item)}
                  </div>

                  <div className={`flex shrink-0 flex-nowrap items-center gap-2 whitespace-nowrap transition-opacity ${templateId === item.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} onClick={e => e.stopPropagation()}>
                      <Button size="small" onClick={(e) => { e.stopPropagation(); openEditor(item); }} className="rounded-md">配置</Button>
                      <Button size="small" icon={<CopyOutlined />} onClick={(e) => { e.stopPropagation(); void dupTpl(item.id); }} className="rounded-md" />
                      <ConfirmPopover title={t('documents.deleteTemplateConfirm')} onConfirm={(e) => { e?.stopPropagation(); void delTpl(item.id); }}>
                          <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} className="rounded-md" />
                      </ConfirmPopover>
                      {(() => {
                        const validation = templateValidations[item.id];
                        const errorCount = validation?.issues.filter(issue => issue.level === 'error').length ?? 0;
                        if (errorCount > 0) {
                          // B1：有阻断项时按钮变"先修复 N 个问题"，点击直达体检报告修复项
                          return <Button size="small" danger icon={<WarningOutlined />} disabled={Boolean(preparingTemplateId) && preparingTemplateId !== item.id} onClick={(e) => { e.stopPropagation(); jumpToTemplateFix(item.id); }} className="min-w-[108px] rounded-md justify-center">先修复 {errorCount} 个问题</Button>;
                        }
                        return <Button size="small" type="primary" icon={preparingTemplateId === item.id ? <LoadingOutlined /> : <PlayCircleOutlined />} loading={preparingTemplateId === item.id} disabled={Boolean(preparingTemplateId) && preparingTemplateId !== item.id} onClick={(e) => { e.stopPropagation(); void runTemplateWithValidation(item.id); }} className="min-w-[72px] rounded-md justify-center">{preparingTemplateId === item.id ? '准备中' : '运行'}</Button>;
                      })()}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          drafts.length === 0 ? (
            <div className="py-32 text-center border border-dashed border-[var(--borderColor)] rounded-2xl bg-[var(--colorBgContainer)]">
                <Empty description={<span className="text-[var(--colorTextSecondary)]">{t('common.noData')}</span>} />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {drafts.slice(0, 15).map((item, index) => (
                <div key={item.id}
                  className={`group flex items-center gap-4 p-4 rounded-2xl transition-all cursor-pointer ${currentDocumentId === item.id ? 'bg-[var(--colorBgSelected)] shadow-md' : 'bg-[var(--colorBgContainer)] hover:bg-[var(--colorBgHover)] shadow-sm hover:shadow-md'}`}
                  onClick={() => { void openDrawerForEditor(item); }}
                >
                  <div className="mt-1">
                      {item.status === 'completed' ? <CheckCircleOutlined className="text-xl text-[var(--colorOk)]" />
                        : item.status === 'failed' || item.status === 'aborted' ? <CloseCircleOutlined className="text-xl text-[var(--colorDanger)]" />
                        : item.status === 'warning' ? <SafetyCertificateOutlined className="text-xl text-[var(--colorWarning)]" />
                        : <SyncOutlined spin className="text-xl text-blue-500" />}
                  </div>

                  <div className="flex-1 min-w-0 pr-4">
                    <div className="flex items-center gap-3 mb-2">
                        <span className="font-bold text-base text-[var(--colorText)] truncate">{item.title}</span>
                        <Tag className="border-0 bg-[var(--colorFillSecondary)] m-0 shrink-0">#{index + 1}</Tag>
                        <Tag color={draftStatusColor(item.status)} className="border-0 m-0 shrink-0">{draftStatusText(item.status)}</Tag>
                    </div>

                    <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-[var(--colorTextSecondary)] mb-3">
                      <span className="flex items-center gap-1.5"><HistoryOutlined /> {new Date(item.updatedAt).toLocaleString()}</span>
                      <span className="text-[var(--colorTextTertiary)]">|</span>
                      <span>耗时 {fmtDuration(item)}</span>
                      {item.partialChapters && item.partialChapters.length > 0 && (
                          <>
                              <span className="text-[var(--colorTextTertiary)]">|</span>
                              <span>进度 {item.partialChapters.filter(chapter => chapter.status === 'completed').length}/{item.partialChapters.length} 章</span>
                              <span className="text-[var(--colorTextTertiary)]">|</span>
                              <span>共 {item.partialChapters.reduce((sum, chapter) => sum + chapter.chars, 0).toLocaleString()} 字</span>
                          </>
                      )}
                    </div>

                    {(item.status === 'warning' || item.status === 'failed' || item.status === 'aborted') && (
                      <div className={`inline-flex items-center gap-2 p-1.5 px-3 rounded-lg border text-xs ${item.status === 'failed' || item.status === 'aborted' ? 'border-red-200 bg-red-50/50' : 'border-yellow-200 bg-yellow-50/50'}`}>
                        <span className="font-medium">{item.status === 'failed' ? item.draft?.exportGate?.passed === false ? '门禁未通过' : '生成失败' : item.status === 'aborted' ? '已中止' : '需复核'}</span>
                        <span className="text-[var(--colorTextTertiary)]">|</span>
                        <span className="truncate max-w-[400px]">{item.error || item.warningIssues?.[0] || item.draft?.validationIssues.find(x => x.level === 'error' || x.level === 'warning')?.message || item.draft?.exportGate?.checklist.find(x => !x.passed)?.label || '需复核'}</span>
                      </div>
                    )}
                  </div>

                  <div className={`flex shrink-0 flex-nowrap items-center gap-2 whitespace-nowrap transition-opacity ${currentDocumentId === item.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} onClick={e => e.stopPropagation()}>
                      <Button size="small" type="primary" icon={isDraftGenerating(item.status) ? <SyncOutlined spin /> : <PlayCircleOutlined />} onClick={(e) => { e.stopPropagation(); void openDrawerForEditor(item); }} className="min-w-[72px] rounded-md justify-center">打开</Button>
                      {isDraftGenerating(item.status) && (
                        <ConfirmPopover title="确定中止此生成任务？" onConfirm={(e) => { e?.stopPropagation(); void handleAbortDraft(item); }}>
                          <Button size="small" danger onClick={(e) => e.stopPropagation()} className="rounded-md">中止</Button>
                        </ConfirmPopover>
                      )}
                      {((item.status === 'failed' || item.status === 'aborted') || (item.status === 'warning' && Boolean(item.checkpointChapters?.length) && /继续生成|重新生成|中断|卡住|未完成/u.test(item.error || item.warningIssues?.join('；') || ''))) && (
                        <Button size="small" onClick={(e) => { e.stopPropagation(); void handleResumeDraft(item); }} className="rounded-md">继续</Button>
                      )}
                      <ConfirmPopover title="确认删除？" onConfirm={(e) => { e?.stopPropagation(); void delDraft(item); }}>
                        <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} className="rounded-md" />
                      </ConfirmPopover>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
        </div>
      </div>

      <Drawer
        title={drawerTitle}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); for (const interval of recoveryPollRef.current.values()) clearInterval(interval); recoveryPollRef.current.clear(); }}
        size="large" mask={{ closable: false }}
        style={{ borderRadius: '12px 0 0 12px' }}
        styles={{ body: { padding: '16px 24px' }, header: { borderRadius: '12px 0 0 0', borderBottom: '1px solid var(--colorBorderSecondary)' } }}
        extra={draft ? <Space wrap>
          {canResumeDraft(workflowRecord) && <Button icon={<PlayCircleOutlined />} disabled={refining || loading} onClick={() => { if (workflowRecord) void handleResumeDraft(workflowRecord); }}>继续生成</Button>}
          <Button icon={<SaveOutlined />} disabled={refining} onClick={() => { void saveDraft(); }}>{t('documents.saveDraft')}</Button>
          <Button icon={<DownloadOutlined />} disabled={refining} loading={exporting === 'markdown'} onClick={() => { void doExport('markdown'); }}>MD</Button>
          <Button disabled={refining} loading={exporting === 'html'} onClick={() => { void doExport('html'); }}>HTML</Button>
          <Button disabled={refining} loading={exporting === 'docx'} onClick={() => { void doExport('docx'); }}>DOCX</Button>
          <Button type="primary" disabled={refining} loading={exporting === 'pdf'} onClick={() => { void doExport('pdf'); }}>PDF</Button>
        </Space> : canResumeDraft(workflowRecord) ? <Button type="primary" icon={<PlayCircleOutlined />} loading={loading} onClick={() => { if (workflowRecord) void handleResumeDraft(workflowRecord); }}>继续生成</Button> : (loading && drawerMode === 'workflow') ? <Button danger onClick={handleAbortGeneration}>中止任务</Button> : undefined}
      >
        <VerticalStack style={{ width: '100%' }} gap={16}>
          {/* 工作流模式：执行步骤 */}
          {drawerMode === 'workflow' && flowSteps.length > 0 && (
            <VerticalStack gap={10}>
              {flowSteps.map((s, index) => {
                const stepExpanded = expandedStepKeys.has(s.key);
                const hasMoreContent = s.subSteps.length > 8 || s.description.length > 240;
                return (
                  <div key={s.key} style={{ display: 'flex', gap: 10, padding: 10, border: '1px solid var(--colorBorderSecondary)', borderRadius: 10, background: index === activeFlowIndex ? 'var(--colorFillAlter)' : 'var(--colorBgContainer)' }}>
                    <span>{flowIcon(s)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Space wrap><Text strong>{s.title}</Text><Tag color={s.status === 'finish' ? 'success' : s.status === 'error' ? 'error' : s.status === 'warning' ? 'warning' : s.status === 'process' ? 'processing' : 'default'}>{antdStatus(s.status)}</Tag>{stepDurationChip(s)}</Space>
                      <div style={{ marginTop: 4, color: 'var(--colorTextSecondary)', fontSize: 12, whiteSpace: 'pre-wrap' }}>{stepDesc(s, stepExpanded)}</div>
                      {hasMoreContent && (
                        <Button size="small" type="link" style={{ padding: 0, height: 'auto', marginTop: 6 }} onClick={() => toggleStepExpanded(s.key)}>
                          {stepExpanded ? '收起' : s.subSteps.length > 8 ? `更多（${s.subSteps.length} 条详情）` : '更多'}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </VerticalStack>
          )}

          {drawerMode === 'workflow' && workflowRecord?.partialChapters && workflowRecord.partialChapters.length > 0 && (
            <Card size="small" title="章节进度" extra={<Tag color="blue">{workflowRecord.partialChapters.filter(chapter => chapter.status === 'completed').length}/{workflowRecord.partialChapters.length}</Tag>}>
              <VerticalStack gap={6} style={{ width: '100%' }}>
                {workflowRecord.partialChapters.map(chapter => (
                  <div key={chapter.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
                    <Text ellipsis style={{ maxWidth: 480 }}>{chapter.title}</Text>
                    <Space size={6}><Tag color={chapter.status === 'failed' ? 'error' : 'success'}>{chapter.status === 'failed' ? '失败' : '完成'}</Tag><Text type="secondary">{chapter.chars.toLocaleString()} 字</Text></Space>
                  </div>
                ))}
              </VerticalStack>
            </Card>
          )}

          {drawerMode === 'workflow' && workflowRecord?.draft?.exportGate?.passed === false && (() => {
            const gateBlockingItems = workflowRecord.draft.exportGate.blockingIssues?.map(item => item.message)
              || workflowRecord.draft.exportGate.checklist.filter(item => !item.passed).map(item => item.label)
              || ['存在阻断级校验错误'];
            const visibleBlockingItems = expandBlockingIssues ? gateBlockingItems : gateBlockingItems.slice(0, 6);
            return (
              <NoticeBox type="error" title="生成已完成，但导出门禁未通过">
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <span>{`阻断项：${visibleBlockingItems.join('；')}${gateBlockingItems.length > 6 && !expandBlockingIssues ? `…（共 ${gateBlockingItems.length} 项）` : ''}。可点击继续生成触发自动修复，或在“校验”页查看完整问题。`}</span>
                  {gateBlockingItems.length > 6 && (
                    <Button size="small" type="link" style={{ padding: 0, height: 'auto', alignSelf: 'flex-start' }} onClick={() => setExpandBlockingIssues(prev => !prev)}>
                      {expandBlockingIssues ? '收起' : `查看全部 ${gateBlockingItems.length} 项`}
                    </Button>
                  )}
                  {canResumeDraft(workflowRecord) && <Button type="primary" size="small" icon={<PlayCircleOutlined />} loading={loading} onClick={() => { void handleResumeDraft(workflowRecord); }}>继续生成 / 自动修复</Button>}
                </Space>
              </NoticeBox>
            );
          })()}

          {drawerMode === 'workflow' && workflowRecord?.reviewMetadata?.diagnostics && (
            <NoticeBox type="info" title="后台自动优化">{`策略：${workflowRecord.reviewMetadata.diagnostics.strategy.mode}；LLM 调用 ${workflowRecord.reviewMetadata.diagnostics.llm.calls} 次；噪声过滤 ${workflowRecord.reviewMetadata.diagnostics.evidence?.filteredNoise || 0} 条；质量门禁 阻断${workflowRecord.reviewMetadata.diagnostics.quality?.blockingCount || 0}/重要${workflowRecord.reviewMetadata.diagnostics.quality?.importantCount || 0}/轻微${workflowRecord.reviewMetadata.diagnostics.quality?.minorCount || 0}；自动限流调整 ${workflowRecord.reviewMetadata.diagnostics.llm.limitAdjustments} 次。审查与诊断信息仅用于系统修复，不会写入正文或导出文件。`}</NoticeBox>
          )}

          {drawerMode === 'workflow' && workflowRecord?.draft?.promptRules && (() => {
            const promptRules = workflowRecord.draft.promptRules;
            const summary = promptRules.executionSummary || [];
            const sourceEntries = Object.entries(promptRules.ruleSources || {}).filter(([, items]) => items.length > 0);
            const hasSources = sourceEntries.length > 0;
            const visibleSources = expandPromptRuleSources ? sourceEntries : sourceEntries.slice(0, 3);
            return (
              <Card size="small" title={<Space size={6}><SafetyCertificateOutlined style={{ color: 'var(--colorAccent)' }} />提示词规则生效报告{summary.length > 0 && <Tag style={{ margin: 0 }}>{summary.length} 条</Tag>}</Space>} styles={{ body: { padding: 12 } }}>
                <VerticalStack gap={6}>
                  {summary.length > 0 && summary.map((line, index) => (
                    <div key={index} style={{ display: 'flex', gap: 6, fontSize: 12, color: 'var(--colorText)', lineHeight: 1.6 }}>
                      <CheckCircleOutlined style={{ color: 'var(--colorSuccess)', marginTop: 4 }} /><span>{line}</span>
                    </div>
                  ))}
                  {hasSources && (
                    <>
                      <Divider style={{ margin: '4px 0' }} />
                      <Text type="secondary" style={{ fontSize: 12 }}>规则溯源（自动从以下提示词中抽取）：</Text>
                      {visibleSources.map(([key, items]) => (
                        <div key={key} style={{ fontSize: 12, color: 'var(--colorTextSecondary)', lineHeight: 1.6 }}>
                          <Text strong style={{ fontSize: 12 }}>{key}</Text>：{items.map(item => `${item.roleId}「${item.matchedText.length > 24 ? `${item.matchedText.slice(0, 24)}…` : item.matchedText}」`).join('、')}
                        </div>
                      ))}
                      {sourceEntries.length > 3 && (
                        <Button size="small" type="link" style={{ padding: 0, height: 'auto', alignSelf: 'flex-start' }} onClick={() => setExpandPromptRuleSources(prev => !prev)}>
                          {expandPromptRuleSources ? '收起溯源' : `查看全部溯源（${sourceEntries.length} 类）`}
                        </Button>
                      )}
                    </>
                  )}
                  {!hasSources && summary.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>未从提示词中识别到额外硬规则，使用系统默认质量规则。</Text>}
                </VerticalStack>
              </Card>
            );
          })()}

          {/* 工作流模式：质量对标卡（与模板参考库同工程类型基准对比） */}
          {drawerMode === 'workflow' && workflowRecord?.draft?.reviewMetadata?.qualityBenchmark && (() => {
            const benchmark = workflowRecord.draft.reviewMetadata.qualityBenchmark;
            return (
              <Card size="small" title={<Space size={6}><TrophyOutlined style={{ color: '#faad14' }} />质量对标<Tag color="gold" style={{ margin: 0 }}>{benchmark.projectType}参考</Tag></Space>} extra={<Text strong style={{ fontSize: 15, color: benchmark.overallScore >= 80 ? 'var(--colorSuccess)' : 'var(--colorWarning)' }}>{benchmark.overallScore} 分</Text>} styles={{ body: { padding: 12 } }}>
                <VerticalStack gap={8}>
                  <Text type="secondary" style={{ fontSize: 12 }}>与模板参考库 {benchmark.referenceSourceCount} 份同类入围文件的质量画像对比：</Text>
                  {benchmark.items.map(item => (
                    <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 86, fontSize: 12, color: 'var(--colorTextSecondary)', flexShrink: 0 }}>{item.label}</div>
                      <Progress percent={Math.min(100, item.score)} size="small" status={item.passed ? 'normal' : 'exception'} style={{ flex: 1, margin: 0 }} showInfo={false} />
                      <div style={{ width: 96, fontSize: 12, textAlign: 'right', flexShrink: 0, color: item.passed ? 'var(--colorSuccess)' : 'var(--colorWarning)' }}>
                        {item.passed ? <CheckCircleOutlined style={{ marginRight: 4 }} /> : <ExclamationCircleOutlined style={{ marginRight: 4 }} />}
                        {formatBenchmarkValue(item.generated, item.unit)}
                      </div>
                    </div>
                  ))}
                  <Text type="secondary" style={{ fontSize: 12 }}>基准参考值：{benchmark.items.map(item => `${item.label} ${formatBenchmarkValue(item.reference, item.unit)}`).join('；')}</Text>
                </VerticalStack>
              </Card>
            );
          })()}

          {/* 工作流模式：步骤出现前的加载动画 */}
          {drawerMode === 'workflow' && loading && flowSteps.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40 }}><Spin /><div style={{ marginTop: 12, color: 'var(--colorTextSecondary)' }}>正在准备生成…</div></div>
          )}

          {/* U3：运行后质量卡片（editor 模式：对标分 + 修复记录） */}
          {drawerMode === 'editor' && draft?.reviewMetadata?.qualityBenchmark && (() => {
            const benchmark = draft.reviewMetadata.qualityBenchmark;
            const quality = draft.reviewMetadata.diagnostics?.quality;
            const repairDetails = (draft.executionStages || [])
              .filter(stage => stage.type === 'llm_review' || stage.roleId === 'quality-repair')
              .flatMap(stage => (stage.details || []).filter(detail => /修复|补写|补齐|改进|调整/u.test(detail)))
              .slice(0, 8);
            return (
              <Card size="small" title={<Space size={6}><TrophyOutlined style={{ color: '#faad14' }} />运行质量报告<Tag color="gold" className="border-0 m-0">{benchmark.projectType}对标</Tag></Space>} extra={<Text strong style={{ fontSize: 15, color: benchmark.overallScore >= 80 ? 'var(--colorSuccess)' : 'var(--colorWarning)' }}>{benchmark.overallScore} 分</Text>} styles={{ body: { padding: 12 } }}>
                <VerticalStack gap={8}>
                  <Space wrap size={6}>
                    <Tag className="border-0 bg-[var(--colorFillSecondary)] m-0">对标库 {benchmark.referenceSourceCount} 份同类文件</Tag>
                    {quality && <Tag color={quality.blockingCount > 0 ? 'error' : 'success'} className="border-0 m-0">审查修复 {quality.repairedCount} 项 / 问题 {quality.blockingCount + quality.importantCount + quality.minorCount} 项</Tag>}
                    <Tag className="border-0 bg-[var(--colorFillSecondary)] m-0">{benchmark.items.filter(item => item.passed).length}/{benchmark.items.length} 指标达标</Tag>
                  </Space>
                  {repairDetails.length > 0 && (
                    <div className="flex flex-col gap-1 rounded-lg border border-[var(--borderColor)] bg-[var(--colorFillQuaternary)] px-3 py-2">
                      <span className="text-xs font-medium text-[var(--colorText)]">修复记录（审查阶段自动修复的内容）</span>
                      {repairDetails.map((detail, index) => <span key={index} className="text-xs text-[var(--colorTextSecondary)]">· {detail}</span>)}
                    </div>
                  )}
                  <Text type="secondary" style={{ fontSize: 12 }}>基准参考值：{benchmark.items.map(item => `${item.label} ${formatBenchmarkValue(item.reference, item.unit)}`).join('；')}</Text>
                </VerticalStack>
              </Card>
            );
          })()}

          {/* B3：导出后闭环报告（总用时/质量对标分/规则执行摘要/修复记录归档，历史对比） */}
          {drawerMode === 'editor' && exportReports.length > 0 && (
            <Card size="small" title={<Space size={6}><DownloadOutlined />导出闭环报告<Tag className="border-0 bg-[var(--colorFillSecondary)] m-0">{exportReports.length}</Tag></Space>} styles={{ body: { padding: 12 } }}>
              <VerticalStack gap={6}>
                {[...exportReports].reverse().map((report, index) => (
                  <div key={`${report.exportedAt}-${index}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--borderColor)] bg-[var(--colorFillQuaternary)] px-3 py-2 text-xs">
                    <Text strong>{report.format.toUpperCase()}</Text>
                    <Tag color="blue" className="border-0 m-0">{new Date(report.exportedAt).toLocaleString()}</Tag>
                    {report.durationMs !== undefined && <span className="text-[var(--colorTextSecondary)]">总用时 {fmtMs(report.durationMs)}</span>}
                    {report.benchmarkScore !== undefined && <span className="text-[var(--colorTextSecondary)]">质量对标 {report.benchmarkScore} 分</span>}
                    {report.repairedCount !== undefined && <span className="text-[var(--colorTextSecondary)]">修复 {report.repairedCount} 项{report.blockingCount !== undefined ? `（阻断 ${report.blockingCount}）` : ''}</span>}
                    {report.ruleSummary && report.ruleSummary.length > 0 && <span className="text-[var(--colorTextSecondary)]">规则 {report.ruleSummary.length} 条</span>}
                    {report.gatePassed === false && <Tag color="error" className="border-0 m-0">门禁未过</Tag>}
                  </div>
                ))}
              </VerticalStack>
            </Card>
          )}

          {/* 两种模式：编辑器（生成后或从草稿打开） */}
          {draft && (
            <div ref={editorRef}>
              <Tabs items={[
                  { key: 'edit', label: t('documents.edit'), children: (
                    <VerticalStack gap={16} style={{ width: '100%' }}>
                      <TextArea rows={28} value={content} disabled={refining} onSelect={e => setRefineCursor({ start: e.currentTarget.selectionStart ?? 0, end: e.currentTarget.selectionEnd ?? e.currentTarget.selectionStart ?? 0 })} onChange={e => { setContent(e.target.value); setRefinePlan(null); setRefinePreview(null); setRefineCursor({ start: e.target.selectionStart ?? 0, end: e.target.selectionEnd ?? e.target.selectionStart ?? 0 }); }} />
                      <Card size="small" style={{ borderRadius: 12, background: 'linear-gradient(135deg, var(--colorFillAlter), var(--colorBgContainer))' }}>
                        <VerticalStack gap={16} style={{ width: '100%' }}>
                          <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
                            <div>
                              <Space size={6}><ThunderboltOutlined style={{ color: 'var(--colorAccent)' }} /><Text strong>精准修改</Text><Tag color="blue">AI 辅助</Tag></Space>
                              <div style={{ marginTop: 4, color: 'var(--colorTextSecondary)', fontSize: 12 }}>针对当前编辑内容补充更具体的要求，AI 会保留文档结构并按你的提示细化修改。</div>
                            </div>
                            <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryOpen(v => !v)} disabled={editHistory.length === 0}>历史版本 {editHistory.length > 0 ? editHistory.length : ''}</Button>
                          </Space>
                          <NoticeBox type="info" title="系统只负责识别修改范围，不改写你的提示词；选中文字后优先只改选区，没有选区时按光标所在小节/章节定位。" />
                          <TextArea rows={4} value={refinePrompt} disabled={refining} onChange={e => { setRefinePrompt(e.target.value); setRefinePlan(null); setRefinePreview(null); }} placeholder="例如：写细一点；润色这段；第七章补充高处作业和临电安全措施；把安全检查频次改成每周一次。" />
                          <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
                            <Space wrap>
                              {['写细一点', '更专业', '只润色选区', '补充可执行措施'].map(text => <Button key={text} size="small" disabled={refining} onClick={() => setRefinePrompt(prev => prev ? `${prev}；${text}` : text)}>{text}</Button>)}
                            </Space>
                            <Button type="primary" icon={<ThunderboltOutlined />} loading={refining && refineStep === 'planning'} disabled={!refinePrompt.trim() || refining} onClick={() => { void planRefine(); }}>识别修改范围</Button>
                          </Space>
                          {refinePlan && !refinePreview && (
                            <Card size="small" style={{ borderRadius: 10, borderColor: 'var(--colorAccent)' }}>
                              <VerticalStack gap={8} style={{ width: '100%' }}>
                                <Space wrap><Tag color="purple">{refinePlan.scope}</Tag><Tag color="blue">{refinePlan.action}</Tag><Tag color={refinePlan.confidence >= 0.8 ? 'green' : 'orange'}>置信度 {Math.round(refinePlan.confidence * 100)}%</Tag>{refinePlan.targetTitle && <Text strong>{refinePlan.targetTitle}</Text>}</Space>
                                <Text>{refinePlan.summary}</Text>
                                <Text type="secondary" style={{ fontSize: 12 }}>将按你的原始提示词执行，不添加额外编辑任务。</Text>
                                <Space><Button type="primary" loading={refining && refineStep === 'applying'} onClick={() => { void generateRefinePreview(refinePlan); }}>执行并预览</Button><Button disabled={refining} onClick={() => setRefinePlan(null)}>取消</Button></Space>
                              </VerticalStack>
                            </Card>
                          )}
                          {refinePreview && (
                            <Card size="small" style={{ borderRadius: 10, borderColor: 'var(--colorSuccess)' }}>
                              <VerticalStack gap={8} style={{ width: '100%' }}>
                                <Space wrap><Tag color="green">修改预览</Tag><Text>{refinePreview.summary || refinePreview.plan.summary}</Text><Tag>{refinePreview.changedChars && refinePreview.changedChars > 0 ? `+${refinePreview.changedChars}` : refinePreview.changedChars} 字符</Tag></Space>
                                <Row gutter={12}>
                                  <Col span={12}><Text strong>修改前</Text><div style={{ marginTop: 6, maxHeight: 180, overflow: 'auto', padding: 10, borderRadius: 8, background: 'var(--colorFillAlter)', whiteSpace: 'pre-wrap', fontSize: 12 }}>{refinePreview.beforeSnippet || '无片段预览'}</div></Col>
                                  <Col span={12}><Text strong>修改后</Text><div style={{ marginTop: 6, maxHeight: 180, overflow: 'auto', padding: 10, borderRadius: 8, background: 'var(--colorFillAlter)', whiteSpace: 'pre-wrap', fontSize: 12 }}>{refinePreview.afterSnippet || '无片段预览'}</div></Col>
                                </Row>
                                <Space><Button type="primary" onClick={applyRefinePreview}>应用到文档</Button><Button onClick={() => setRefinePreview(null)}>返回计划</Button><Button danger onClick={() => { setRefinePlan(null); setRefinePreview(null); }}>放弃</Button></Space>
                              </VerticalStack>
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
                        </VerticalStack>
                      </Card>
                    </VerticalStack>
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
                          title={<Text title={s.roleId} style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{`${s.title || STAGE_TITLES[s.type] || s.type} · ${s.roleName || s.subtitle || roleDisplayName(s.roleId)}`}</Text>}
                          description={<Text type="secondary" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{s.message}</Text>} />
                        <Tag color={s.status === 'success' ? 'success' : s.status === 'failed' ? 'error' : s.status === 'skipped' ? 'default' : 'warning'}>{s.status}</Tag>
                      </List.Item>
                    )} />
                  },
                ]} />
            </div>
          )}
        </VerticalStack>
      </Drawer>

      <Drawer
        title={t('documents.templateEditor')}
        open={templateModalOpen}
        onClose={() => setTemplateModalOpen(false)}
        size="large"
        mask={{ closable: false }}
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
          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <Text strong className="text-base text-[var(--colorText)] block mb-1">项目资料包绑定</Text>
                <div className="text-xs text-[var(--colorTextSecondary)]">直接选择整个项目文件夹，系统会自动识别招标正文、清单、图纸、补疑等资料类型。</div>
              </div>
              <Tag color="blue" className="border-0">按项目资料包</Tag>
            </div>
            
            {fileSearching ? <div className="text-center py-8"><Spin /><div className="mt-3 text-[var(--colorTextSecondary)] text-xs">正在加载知识库文件…</div></div> : templateFileTree.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无知识库文件" /> : (
              <Form.Item name="projectMaterialRoots" rules={[{ required: true, message: '请选择项目资料包' }]}> 
                <TreeSelect
                  treeData={templateFileTree}
                  loadData={onLoadData}
                  fieldNames={{ label: 'rawTitle', value: 'value', children: 'children' }}
                  onChange={(value: string[]) => updateProjectMaterialRoots(value.map(item => String(item)))}
                  treeCheckable={true}
                  showCheckedStrategy={TreeSelect.SHOW_PARENT}
                  placeholder="点击这里选择项目文件夹..."
                  style={{ width: '100%' }}
                  listHeight={360}
                  showSearch
                  maxTagCount="responsive"
                  size="large"
                />
              </Form.Item>
            )}
          </div>
        </Form>
      </Drawer>
    </div>
  );
}
