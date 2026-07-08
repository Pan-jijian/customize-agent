import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { App, Alert, Button, Card, Col, Descriptions, Drawer, Empty, Form, Input, List, Modal, Popconfirm, Row, Select, Skeleton, Space, Spin, Steps, Tabs, Tag, Tooltip, Typography } from 'antd';
import { FileTextOutlined, ThunderboltOutlined, DownloadOutlined, SaveOutlined, ReloadOutlined, CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ApartmentOutlined, DatabaseOutlined, EyeOutlined, BulbOutlined, FormOutlined, PictureOutlined, SafetyCertificateOutlined, CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, FileDoneOutlined, LoadingOutlined, PlayCircleOutlined, SettingOutlined } from '@ant-design/icons';
import { abortGeneratedDocument, deleteDocumentTemplate, deleteGeneratedDocument, duplicateDocumentTemplate, exportDocument, generateDocumentDraft, getGeneratedDocument, getGeneratedDocuments, getDocumentRoles, getDocumentSpecs, getDocumentTemplates, regenerateDocumentChapter, saveDocumentDraft, saveDocumentTemplate, updateGeneratedDocument, validateDocumentTemplate, type DocumentDraftChapter, type DocumentRole, type DocumentSpecPackage, type DocumentTemplate, type DocumentTemplateValidation, type GeneratedDocumentDraft, type GeneratedDocumentRecord, type ProjectRoleConfig } from '@/lib/api';
import { useAppTranslations } from '@/components/Layout';

const { TextArea } = Input;
const { Paragraph, Text } = Typography;

type FlowStepStatus = 'wait' | 'process' | 'finish' | 'warning' | 'error';
interface FlowSubStep { key: string; title: string; status: FlowStepStatus; }
interface FlowStep { key: string; title: string; description: string; status: FlowStepStatus; icon: ReactNode; subSteps: FlowSubStep[]; }

interface GenerationTaskState {
  id: number; templateId: string; loading: boolean;
  flowSteps: FlowStep[]; activeFlowKey: string | null;
  promise: Promise<{ draft?: GeneratedDocumentDraft; taskId?: string; documentId?: string; record?: GeneratedDocumentRecord }>;
  documentId?: string; draft?: GeneratedDocumentDraft; content?: string; error?: string;
  listeners: Set<() => void>;
}

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

const STAGE_TITLES: Record<string, string> = {
  role_binding: '角色配置绑定', knowledge_retrieval: '知识库检索', file_understanding: '多模态文件理解',
  fact_extraction: 'LLM 事实抽取', chapter_generation: 'LLM 章节生成', asset_generation: '多模态资源生成',
  validation: '规则校验', formatting: '格式化排版', llm_review: 'LLM 审查优化',
  export_ready: '导出就绪', reference: '参考资源处理',
};

export default function DocumentsPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [form] = Form.useForm<DocumentTemplate>();
  const editorRef = useRef<HTMLDivElement>(null);

  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [templateId, setTemplateId] = useState('construction-organization-design');
  const [roles, setRoles] = useState<DocumentRole[]>([]);
  const [roleConfigs, setRoleConfigs] = useState<ProjectRoleConfig[]>([]);
  const [documentSpecs, setDocumentSpecs] = useState<DocumentSpecPackage[]>([]);
  const [pageLoading, setPageLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<GeneratedDocumentDraft | null>(null);
  const [content, setContent] = useState('');
  const [drafts, setDrafts] = useState<GeneratedDocumentRecord[]>([]);
  const [currentDocumentId, setCurrentDocumentId] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [regeneratingChapter, setRegeneratingChapter] = useState<string | null>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateValidations, setTemplateValidations] = useState<Record<string, DocumentTemplateValidation>>({});
  const [flowSteps, setFlowSteps] = useState<FlowStep[]>([]);
  const [activeFlowKey, setActiveFlowKey] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<string>('templates');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<'workflow' | 'editor'>('workflow');
  const recoveryPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadDrafts = async () => { try { setDrafts((await getGeneratedDocuments()).documents); } catch { setDrafts([]); } };

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
      getDocumentSpecs().then(d => setDocumentSpecs(d.specs)),
      loadDrafts(),
    ]).catch(() => message.error(t('common.error'))).finally(() => setPageLoading(false));
  }, [message, t]);

  // 页面刷新恢复：检查是否有未完成的生成任务
  useEffect(() => {
    if (drafts.length === 0) return;
    const savedDocId = localStorage.getItem('activeGenDocId');
    if (!savedDocId) return;
    const match = drafts.find(d => d.id === savedDocId && d.status === 'generating');
    if (!match) { localStorage.removeItem('activeGenDocId'); return; }
    // 后台轻量轮询：刷新生成记录列表，保持刷新后生成中状态同步
    const poll = setInterval(() => {
      void (async () => {
        try {
          const { document: d } = await getGeneratedDocument(savedDocId);
          await loadDrafts();
          if (d.status !== 'generating') {
            localStorage.removeItem('activeGenDocId');
            clearInterval(poll);
          }
        } catch { clearInterval(poll); }
      })();
    }, 3000);
    return () => clearInterval(poll);
  }, [drafts]);

  const currentTemplate = useMemo(() => templates.find(t => t.id === templateId), [templates, templateId]);
  const roleConfigOptions = roleConfigs.map(c => ({ label: c.name, value: c.id }));
  const documentSpecOptions = documentSpecs.map(s => ({ label: s.name, value: s.id }));
  const activeFlowIndex = Math.max(0, flowSteps.findIndex(s => s.key === activeFlowKey));

  const openDrawerForWorkflow = (id: string) => {
    setTemplateId(id); setCurrentDocumentId(null); setDraft(null); setContent('');
    setDrawerMode('workflow'); setDrawerOpen(true); setLeftTab('drafts');
  };
  const openDrawerForEditor = async (item: GeneratedDocumentRecord) => {
    setCurrentDocumentId(item.id); setTemplateId(item.templateId);
    const isGenerating = isDraftGenerating(item.status);
    if (isGenerating || item.status === 'failed') {
      genStarted.current = true;
      setDraft(null); setContent(''); setLoading(isGenerating);
      setDrawerMode('workflow'); setDrawerOpen(true);
      try {
        const { document } = await getGeneratedDocument(item.id);
        applyGeneratedRecordToWorkflow(document);
        if (isDraftGenerating(document.status)) startRecoveredGenerationPolling(document.id);
        else await loadDrafts();
      } catch {
        applyGeneratedRecordToWorkflow(item);
      }
      return;
    }

    setDrawerMode('editor'); setFlowSteps([]); setActiveFlowKey(null);
    try {
      const { document } = await getGeneratedDocument(item.id);
      setDraft(document.draft || null); setContent(document.editedMarkdown || document.markdown);
    } catch { message.error(t('common.error')); }
    setDrawerOpen(true);
  };

  const subSteps = (items: string[]): FlowSubStep[] => items.map((t, i) => ({ key: `sub-${i}`, title: t, status: 'wait' as FlowStepStatus }));
  const createInitialFlowSteps = (tpl = currentTemplate): FlowStep[] => {
    const spec = documentSpecs.find(s => s.id === tpl?.documentSpecId);
    const cfg = roleConfigs.find(c => c.id === tpl?.projectRoleConfigId);
    const fns = (cfg?.fileRoles || []).map(r => roles.find(x => x.id === r.roleId)?.name || r.roleId);
    const pns = (cfg?.promptRoles || []).map(r => roles.find(x => x.id === r.roleId)?.name || r.roleId);
    const facts = spec?.factFields.map(f => f.name) || tpl?.chapters.flatMap(c => c.requiredFacts) || [];
    const chs = tpl?.chapters.map(c => c.title) || [];
    const hasAsset = pns.some(n => /封面|图片|资源|cover|image/iu.test(n));
    return [
      { key: 'prepare', title: t('documents.flowPrepare'), description: `读取"${tpl?.name || '当前模板'}"并创建后台生成任务`, status: 'process', icon: <FileTextOutlined />, subSteps: subSteps(['读取模板参数', tpl?.documentSpecId ? `加载规范包：${spec?.name || tpl.documentSpecId}` : '未绑定规范包，使用模板章节要求', '创建后台生成任务']) },
      { key: 'role_binding', title: '动态角色配置绑定', description: `绑定 ${fns.length} 个文件角色、${pns.length} 个提示词角色`, status: 'wait', icon: <ApartmentOutlined />, subSteps: subSteps([...(fns.length ? fns.map(n => `文件角色：${n}`) : ['没有文件角色，使用模板绑定文件']), ...(pns.length ? pns.map(n => `提示词角色：${n}`) : ['没有提示词角色，使用默认生成策略'])].slice(0, 10)) },
      { key: 'knowledge_retrieval', title: '知识库证据检索', description: `按 ${chs.length} 个章节检索文本、文档、表格、图片、图纸和附件`, status: 'wait', icon: <DatabaseOutlined />, subSteps: subSteps(chs.length ? chs.slice(0, 10).map(n => `检索章节：${n}`) : ['按模板标题检索证据']) },
      { key: 'file_understanding', title: '多类型文件理解', description: '按文件角色处理文本、PDF/Word、表格、图片、图纸和附件', status: 'wait', icon: <EyeOutlined />, subSteps: subSteps(['识别文件类型和角色', '构建结构化资源证据包', '必要时调用多模态文件理解']) },
      { key: 'fact_extraction', title: '动态 schema 事实抽取', description: `按 ${facts.length} 个规范/章节事实字段抽取并检测冲突`, status: 'wait', icon: <BulbOutlined />, subSteps: subSteps(facts.length ? facts.slice(0, 10).map(n => `抽取事实：${n}`) : ['抽取模板要求的事实', '合并来源和角色', '检测事实冲突']) },
      { key: 'chapter_generation', title: '章节生成', description: `按 ${chs.length} 个模板章节逐章生成`, status: 'wait', icon: <FormOutlined />, subSteps: subSteps(chs.length ? chs.slice(0, 10).map(n => `生成：${n}`) : ['构造章节提示词', '等待 LLM 生成', '整理章节证据']) },
      ...(hasAsset ? [{ key: 'asset_generation' as const, title: '生成资源处理', description: '根据资源/图片提示词生成或登记本地资源', status: 'wait' as const, icon: <PictureOutlined />, subSteps: subSteps(['生成资源提示词', '保存到 generatedDocuments/assets', '登记资源元数据']) }] : []),
      { key: 'validation', title: '规范包与门禁校验', description: spec ? `执行 ${spec.gateRules.length} 条门禁规则` : '执行模板基础校验', status: 'wait', icon: <SafetyCertificateOutlined />, subSteps: subSteps([...(spec?.factFields.filter(f => f.required).map(f => `必填事实：${f.name}`) || []), ...(spec?.gateRules.map(r => `门禁：${r.name}`) || ['检查章节证据', '检查缺失项', '检查导出门禁'])].slice(0, 10)) },
      { key: 'formatting', title: t('documents.flowFormatting'), description: '整理标题、表格、图片、附件引用和正式 Markdown', status: 'wait', icon: <CheckCircleOutlined />, subSteps: subSteps(['整理标题层级', '整理多类型资源引用', '生成正式 Markdown']) },
      { key: 'llm_review', title: 'LLM 审查优化', description: '再次使用动态 schema、角色和结构化证据审查优化初稿', status: 'wait', icon: <ThunderboltOutlined />, subSteps: subSteps(['构造审查提示词', '检查事实来源和冲突', '回填优化后的 Markdown']) },
      { key: 'export_ready', title: '导出就绪', description: '确认 Markdown/HTML/DOCX/PDF 可导出', status: 'wait', icon: <FileDoneOutlined />, subSteps: subSteps(['生成导出检查清单', '确认阻断项', '准备导出格式']) },
      { key: 'done', title: t('documents.flowDone'), description: t('documents.flowDoneDesc'), status: 'wait', icon: <DownloadOutlined />, subSteps: subSteps(['展示生成结果', '允许编辑正文', '允许导出文件']) },
    ];
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
  const draftStatusColor = (s: GeneratedDocumentRecord['status']) => s === 'completed' ? 'success' : s === 'warning' ? 'warning' : s === 'failed' ? 'error' : 'processing';
  const draftStatusText = (s: GeneratedDocumentRecord['status']) => s === 'completed' ? '已完成' : s === 'warning' ? '需复核' : s === 'failed' ? '失败' : '生成中';
  const isDraftGenerating = (s: GeneratedDocumentRecord['status']) => s !== 'completed' && s !== 'warning' && s !== 'failed';

  const subIcon = (s: FlowStepStatus) => {
    if (s === 'process') return <LoadingOutlined />;
    if (s === 'finish') return <CheckCircleOutlined />;
    if (s === 'warning') return <SafetyCertificateOutlined style={{ color: 'var(--colorWarning)' }} />;
    if (s === 'error') return <DeleteOutlined />;
    return <span style={{ display: 'inline-block', height: 6, width: 6, borderRadius: '50%', background: 'var(--colorTextTertiary)' }} />;
  };
  const stepDesc = (step: FlowStep) => (
    <div><div>{step.description}</div>
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
  const stageToFlowStatus = (status: GeneratedDocumentDraft['executionStages'][number]['status']): FlowStepStatus => status === 'failed' ? 'error' : status === 'fallback' ? 'warning' : 'finish';
  const buildFlowStepsFromRecord = (record: GeneratedDocumentRecord): { steps: FlowStep[]; activeKey: string | null } => {
    const tpl = templates.find(x => x.id === record.templateId) || currentTemplate;
    const stages = record.executionStages || record.draft?.executionStages || [];
    const stageByType = new Map(stages.map(stage => [stage.type, stage]));
    const framework = createInitialFlowSteps(tpl);
    const steps = framework.map(step => {
      if (step.key === 'prepare') {
        const status: FlowStepStatus = stages.length > 0 ? 'finish' : record.status === 'generating' ? 'process' : 'finish';
        return { ...step, status, subSteps: updSubs(step, status) };
      }
      if (step.key === 'done') {
        const status: FlowStepStatus = record.status === 'completed' ? 'finish' : record.status === 'warning' ? 'warning' : 'wait';
        return { ...step, status, subSteps: updSubs(step, status) };
      }
      const matched = stageByType.get(step.key as GeneratedDocumentDraft['executionStages'][number]['type']);
      if (!matched) return step;
      const status = stageToFlowStatus(matched.status);
      return { ...step, status, description: matched.message || step.description, subSteps: updSubs(step, status) };
    });
    let activeKey: string | null;
    if (record.status === 'generating') {
      const lastStageIndex = Math.max(-1, ...stages.map(stage => steps.findIndex(step => step.key === stage.type)).filter(index => index >= 0));
      const next = steps.slice(lastStageIndex + 1).find(step => step.key !== 'done' && step.status === 'wait') || steps.find(step => step.status === 'process') || steps.find(step => step.key === 'done');
      activeKey = next?.key || 'prepare';
      for (const step of steps) if (step.key === activeKey && step.status === 'wait') { step.status = 'process'; step.subSteps = updSubs(step, 'process'); }
    } else if (record.status === 'failed') {
      activeKey = steps.find(step => step.status === 'error')?.key || stages.at(-1)?.type || 'prepare';
    } else {
      activeKey = 'done';
    }
    return { steps, activeKey };
  };
  const applyGeneratedRecordToWorkflow = (record: GeneratedDocumentRecord) => {
    const { steps, activeKey } = buildFlowStepsFromRecord(record);
    setFlowSteps(steps); setActiveFlowKey(activeKey); setLoading(isDraftGenerating(record.status));
    if (record.status === 'failed') setDrawerMode('workflow');
    if ((record.status === 'completed' || record.status === 'warning') && record.draft) {
      setDraft(record.draft); setContent(record.editedMarkdown || record.markdown); setDrawerMode('editor'); setFlowSteps([]); setActiveFlowKey(null);
    }
  };
  const startRecoveredGenerationPolling = (documentId: string) => {
    if (recoveryPollRef.current) clearInterval(recoveryPollRef.current);
    recoveryPollRef.current = setInterval(() => {
      void (async () => {
        try {
          const { document } = await getGeneratedDocument(documentId);
          applyGeneratedRecordToWorkflow(document);
          await loadDrafts();
          if (!isDraftGenerating(document.status)) {
            if (recoveryPollRef.current) clearInterval(recoveryPollRef.current);
            recoveryPollRef.current = null;
            localStorage.removeItem('activeGenDocId');
          }
        } catch { /* ignore */ }
      })();
    }, 2000);
  };
  const updFlow = (key: string, st: FlowStepStatus, desc?: string) => { setActiveFlowKey(key); setFlowSteps(prev => { const n = prev.map(s => s.key === key ? { ...s, status: st, description: desc || s.description, subSteps: updSubs(s, st) } : s); setSnap(n, key); return n; }); };
  useEffect(() => {
    if (!loading || !activeFlowKey) return undefined;
    const t = window.setInterval(() => setFlowSteps(prev => {
      const n = prev.map(s => { if (s.key !== activeFlowKey || s.status !== 'process') return s; const cur = s.subSteps.findIndex(x => x.status === 'process'); const nxt = cur < 0 ? 0 : Math.min(cur + 1, s.subSteps.length - 1); return { ...s, subSteps: s.subSteps.map((x, i) => i < nxt ? { ...x, status: 'finish' as const } : i === nxt ? { ...x, status: 'process' as const } : { ...x, status: 'wait' as const }) }; });
      setSnap(n, activeFlowKey); return n;
    }), 1400);
    return () => window.clearInterval(t);
  }, [activeFlowKey, loading]);
  const finishPrev = (key: string) => { setFlowSteps(prev => { const idx = prev.findIndex(s => s.key === key); const n = prev.map((s, i) => i < idx && s.status !== 'error' ? { ...s, status: 'finish' as const, subSteps: updSubs(s, 'finish') } : s); setSnap(n, key); return n; }); };

  const openEditor = (tpl?: DocumentTemplate) => {
    const value = tpl ?? { id: `tpl-${Date.now()}`, name: '', description: '', category: '自定义', outputTitle: '', projectRoleConfigId: undefined, documentSpecId: undefined, chapters: [] };
    form.setFieldsValue({ ...value, chapters: value.chapters.map(chapter => ({ ...chapter, queriesText: chapter.queries.join('\n'), requiredFactsText: chapter.requiredFacts.join('\n') })) });
    setTemplateModalOpen(true);
  };
  const saveTpl = async () => {
    try {
      const v = await form.validateFields();
      const template = { ...v, chapters: (v.chapters || []).map((chapter: DocumentTemplate['chapters'][number] & { queriesText?: string; requiredFactsText?: string }) => ({ ...chapter, queries: String(chapter.queriesText || '').split(/\r?\n/u).map(item => item.trim()).filter(Boolean), requiredFacts: String(chapter.requiredFactsText || '').split(/\r?\n/u).map(item => item.trim()).filter(Boolean), queriesText: undefined, requiredFactsText: undefined })) } as DocumentTemplate;
      const r = await saveDocumentTemplate(template);
      setTemplates(r.templates); setTemplateId(r.template.id); setTemplateModalOpen(false); await loadDrafts(); message.success(t('common.success'));
    } catch (e) { if (e instanceof Error) message.error(e.message); }
  };
  const dupTpl = async (id: string) => { try { const r = await duplicateDocumentTemplate(id); setTemplates(r.templates); setTemplateId(r.template.id); message.success(t('common.success')); } catch { message.error(t('common.error')); } };
  const delTpl = async (id: string) => { try { const r = await deleteDocumentTemplate(id); setTemplates(r.templates); setTemplateId(r.templates[0]?.id ?? ''); message.success(t('common.success')); } catch { message.error(t('common.error')); } };
  const runTemplateWithValidation = async (id: string) => {
    try {
      const { validation } = await validateDocumentTemplate(id);
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
  const delDraft = async (id: string) => { try { await deleteGeneratedDocument(id); if (currentDocumentId === id) { setCurrentDocumentId(null); setDraft(null); setContent(''); } await loadDrafts(); message.success(t('common.success')); } catch { message.error(t('common.error')); } };

  const waitForDoc = async (docId: string) => {
    const pf = [{ k: 'chapter_generation', m: '后台任务已创建，正在轮询等待 LLM 章节生成完成…' }, { k: 'asset_generation', m: '正在轮询等待封面和生成资源写入本地记录…' }, { k: 'validation', m: '正在轮询等待校验、导出门禁和格式化完成…' }, { k: 'llm_review', m: '正在轮询等待 LLM 审查优化完成…' }];
    let tick = 0;
    for (;;) {
      const { document } = await getGeneratedDocument(docId);
      applyGeneratedRecordToWorkflow(document);
      if ((document.status === 'completed' || document.status === 'warning') && document.draft) return document;
      if (document.status === 'failed') throw new Error(document.error || '生成失败');
      if ((document.executionStages || document.draft?.executionStages || []).length === 0) {
        const c = pf[Math.min(tick, pf.length - 1)]!; finishPrev(c.k); updFlow(c.k, 'process', c.m);
      }
      tick++; await new Promise(r => window.setTimeout(r, 1500));
    }
  };

  const handleGenerate = async () => {
    if (!templateId) return;
    if (activeGenerationTask?.loading) { setFlowSteps(activeGenerationTask.flowSteps); setActiveFlowKey(activeGenerationTask.activeFlowKey); setLoading(true); return; }
    setLoading(true);
    const tpl = templates.find(x => x.id === templateId) || currentTemplate;
    const initial = createInitialFlowSteps(tpl);
    const promise = generateDocumentDraft({ templateId });
    activeGenerationTask = { id: Date.now(), templateId, loading: true, flowSteps: initial, activeFlowKey: 'prepare', promise, listeners: new Set() };
    setFlowSteps(initial); setActiveFlowKey('prepare');
    const preview = [{ k: 'role_binding', m: '正在读取模板、文件角色、提示词角色和文档规范包…' }, { k: 'knowledge_retrieval', m: '正在从知识库检索章节证据、表格、图片和附件…' }, { k: 'file_understanding', m: '正在准备多模态文件理解…' }, { k: 'fact_extraction', m: '正在等待 LLM 事实抽取和后续章节生成结果…' }];
    const timers = preview.map((x, i) => window.setTimeout(() => { finishPrev(x.k); updFlow(x.k, 'process', x.m); }, 600 + i * 900));
    try {
      const started = await promise;
      if (started.documentId) { localStorage.setItem('activeGenDocId', started.documentId); setCurrentDocumentId(started.documentId); if (activeGenerationTask?.promise === promise) activeGenerationTask.documentId = started.documentId; }
      await loadDrafts(); // 立即刷新列表，展示"生成中"记录
      const doc = started.documentId ? await waitForDoc(started.documentId) : undefined;
      const result = started.draft || doc?.draft;
      if (!result) throw new Error('生成结果为空');
      if (started.documentId || doc?.id) setCurrentDocumentId(started.documentId || doc!.id);
      timers.forEach(x => window.clearTimeout(x));
      finishPrev('done');
      setDraft(result); setContent(doc?.editedMarkdown || doc?.markdown || result.markdown);
      if (activeGenerationTask?.promise === promise) { activeGenerationTask.draft = result; activeGenerationTask.content = doc?.editedMarkdown || doc?.markdown || result.markdown; }
      setFlowSteps(prev => {
        const n = prev.map(s => {
          const stage = result.executionStages.find(x => x.type === s.key);
          if (s.key === 'prepare') return { ...s, status: 'finish' as const, description: t('documents.flowPrepareDone'), subSteps: updSubs(s, 'finish') };
          if (s.key === 'done') { const has = result.validationIssues.some(x => x.level === 'error' || x.level === 'warning') || !result.exportGate.passed; const st: FlowStepStatus = has ? 'warning' : 'finish'; const reason = result.validationIssues.find(x => x.level === 'error' || x.level === 'warning')?.message; return { ...s, status: st, description: has ? `生成完成，但需复核：${reason || t('documents.flowGateFailed')}` : t('documents.flowDoneDesc'), subSteps: updSubs(s, st) }; }
          if (!stage) return s.status === 'process' ? { ...s, status: 'finish' as const, subSteps: updSubs(s, 'finish') } : s;
          const st: FlowStepStatus = stage.status === 'failed' ? 'error' : 'finish';
          return { ...s, status: st, description: `${stage.status.toUpperCase()}：${stage.message || s.description}`, subSteps: updSubs(s, st) };
        });
        setSnap(n, 'done', false); return n;
      });
      setActiveFlowKey('done');
      if (activeGenerationTask?.promise === promise) { activeGenerationTask.activeFlowKey = 'done'; activeGenerationTask.loading = false; notifyGenerationTask(); }
      localStorage.removeItem('activeGenDocId');
      await loadDrafts();
      message.success(t('common.success'));
      window.setTimeout(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
    } catch (error) {
      localStorage.removeItem('activeGenDocId');
      const msg = error instanceof Error ? error.message : t('common.error');
      setFlowSteps(prev => { const n = prev.map(s => s.status === 'process' ? { ...s, status: 'error' as const, description: msg, subSteps: updSubs(s, 'error') } : s); setSnap(n, activeFlowKey, false); return n; });
      if (activeGenerationTask?.promise === promise) { activeGenerationTask.loading = false; activeGenerationTask.error = msg; notifyGenerationTask(); }
      message.error(msg);
    } finally { timers.forEach(x => window.clearTimeout(x)); setLoading(false); if (activeGenerationTask?.promise === promise) { activeGenerationTask.loading = false; notifyGenerationTask(); } }
  };

  // 当抽屉以工作流模式打开时自动启动生成
  const genStarted = useRef(false);

  const handleAbortGeneration = () => {
    void (async () => {
      if (currentDocumentId) await abortGeneratedDocument(currentDocumentId).catch(() => undefined);
      if (activeGenerationTask) {
        activeGenerationTask.loading = false;
        activeGenerationTask.error = '用户中止';
        notifyGenerationTask();
        activeGenerationTask = null;
      }
      localStorage.removeItem('activeGenDocId');
      if (recoveryPollRef.current) { clearInterval(recoveryPollRef.current); recoveryPollRef.current = null; }
      setLoading(false); setFlowSteps([]); setActiveFlowKey(null);
      setDrawerOpen(false);
      await loadDrafts();
      message.info('已中止生成任务');
    })();
  };

  const handleAbortDraft = async (item: GeneratedDocumentRecord) => {
    if (activeGenerationTask?.loading) {
      activeGenerationTask.loading = false;
      activeGenerationTask.error = '用户中止';
      notifyGenerationTask();
      activeGenerationTask = null;
      setLoading(false);
    }
    localStorage.removeItem('activeGenDocId');
    if (recoveryPollRef.current) { clearInterval(recoveryPollRef.current); recoveryPollRef.current = null; }
    try {
      await abortGeneratedDocument(item.id);
      await loadDrafts();
      if (currentDocumentId === item.id) { setCurrentDocumentId(null); setDraft(null); setContent(''); }
      message.success('已中止生成任务');
    } catch { message.error(t('common.error')); }
  };
  useEffect(() => {
    if (drawerOpen && drawerMode === 'workflow' && !genStarted.current && !activeGenerationTask?.loading && currentTemplate?.projectRoleConfigId) {
      genStarted.current = true;
      window.setTimeout(() => { void handleGenerate(); }, 300);
    }
    if (!drawerOpen) genStarted.current = false;
  }, [drawerOpen, drawerMode]);

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
      const wp = documentSpecs.find(s => s.id === currentTemplate?.documentSpecId)?.wordTemplatePath;
      const blob = await exportDocument({ documentId: currentDocumentId || undefined, title: draft.title, markdown: content, format: fmt, enforceGate: false, exportGate: draft.exportGate, wordTemplatePath: wp });
      dl(blob, `${draft.title}.${ext}`, mimes[fmt]);
    } catch (e) { message.error(e instanceof Error ? e.message : t('common.error')); } finally { setExporting(null); }
  };
  const saveDraft = async () => {
    if (!draft) return;
    try { if (currentDocumentId) await updateGeneratedDocument(currentDocumentId, { editedMarkdown: content, markdown: content }); else { const r = await saveDocumentDraft({ ...draft, markdown: content }); setDraft(r.draft); } await loadDrafts(); message.success(t('common.success')); } catch { message.error(t('common.error')); }
  };
  const replaceCh = (old: DocumentDraftChapter, nw: DocumentDraftChapter) => { setContent(prev => prev.includes(old.content) ? prev.replace(old.content, nw.content) : `${prev}\n\n${nw.content}`); };
  const regenCh = async (ch: DocumentDraftChapter) => {
    if (!draft) return; setRegeneratingChapter(ch.id);
    try { const r = await regenerateDocumentChapter({ templateId: draft.templateId, chapterId: ch.id, documentId: currentDocumentId || undefined, currentMarkdown: content, existingFacts: draft.structuredFacts?.map(fact => fact.value) }); setDraft({ ...draft, chapters: draft.chapters.map(c => c.id === ch.id ? r.chapter : c) }); replaceCh(ch, r.chapter); message.success(t('common.success')); } catch { message.error(t('common.error')); } finally { setRegeneratingChapter(null); }
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
            <List dataSource={templates} renderItem={(item, index) => (
              <List.Item style={{ cursor: 'pointer', padding: '10px 0' }}
                actions={[
                  <Button key="cfg" size="small" icon={<SettingOutlined />} onClick={(e) => { e.stopPropagation(); openEditor(item); }}>配置</Button>,
                  <Button key="run" size="small" type="primary" icon={<PlayCircleOutlined />} onClick={(e) => { e.stopPropagation(); void runTemplateWithValidation(item.id); }}>运行</Button>,
                  <Button key="copy" size="small" icon={<CopyOutlined />} onClick={(e) => { e.stopPropagation(); void dupTpl(item.id); }} />,
                  <Popconfirm key="del" title={t('documents.deleteTemplateConfirm')} disabled={item.builtIn} onConfirm={(e) => { e?.stopPropagation(); void delTpl(item.id); }}>
                    <Button size="small" danger icon={<DeleteOutlined />} disabled={item.builtIn} onClick={(e) => e.stopPropagation()} />
                  </Popconfirm>,
                ]}
                onClick={() => setTemplateId(item.id)}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0, flex: 1 }}>
                  {templateIcon(item.category, templateId === item.id)}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <span style={{ fontWeight: templateId === item.id ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                      {item.builtIn && <Tag color="gold" style={{ margin: 0, fontSize: 10, lineHeight: '16px', flexShrink: 0 }}>内置</Tag>}
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
                            {templateValidations[item.id]!.spec && <Tag color="cyan">规范包 {templateValidations[item.id]!.spec!.name}</Tag>}
                          </Space>
                          {templateValidations[item.id]!.issues.length > 0 ? templateValidations[item.id]!.issues.map(issue => <Alert key={issue.message} type={issue.level === 'error' ? 'error' : 'warning'} message={issue.message} showIcon />) : <Alert type="success" message="文件角色、提示词角色和规范包检查通过，可以运行。" showIcon />}
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
                    : item.status === 'failed' ? <CloseCircleOutlined style={{ fontSize: 18, color: 'var(--colorDanger)', flexShrink: 0, marginTop: 2 }} />
                    : item.status === 'warning' ? <SafetyCertificateOutlined style={{ fontSize: 18, color: 'var(--colorWarning)', flexShrink: 0, marginTop: 2 }} />
                    : <SyncOutlined spin style={{ fontSize: 18, color: '#1677ff', flexShrink: 0, marginTop: 2 }} />}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>{item.title}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', color: 'var(--colorTextSecondary)', fontSize: 11 }}>
                      <span>{new Date(item.updatedAt).toLocaleString()}</span>
                      <span>耗时 {fmtDuration(item)}</span>
                    </div>
                    {(item.status === 'warning' || item.status === 'failed') && (
                      <div style={{ marginTop: 3, color: item.status === 'failed' ? 'var(--colorError)' : 'var(--colorWarning)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.warningIssues?.[0] || item.draft?.validationIssues.find(x => x.level === 'error' || x.level === 'warning')?.message || '需复核'}
                      </div>
                    )}
                  </div>
                  <Space size={4} align="center">
                    <Tag color={draftStatusColor(item.status)} style={{ margin: 0, fontSize: 10, lineHeight: '18px' }}>{draftStatusText(item.status)}</Tag>
                    <Tag style={{ margin: 0, fontSize: 10, lineHeight: '18px' }}>#{index + 1}</Tag>
                    <Popconfirm title="确认删除？" onConfirm={(e) => { e?.stopPropagation(); void delDraft(item.id); }}>
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
          <Button icon={<SaveOutlined />} onClick={() => { void saveDraft(); }}>{t('documents.saveDraft')}</Button>
          <Button icon={<DownloadOutlined />} loading={exporting === 'markdown'} onClick={() => { void doExport('markdown'); }}>MD</Button>
          <Button loading={exporting === 'html'} onClick={() => { void doExport('html'); }}>HTML</Button>
          <Button loading={exporting === 'docx'} onClick={() => { void doExport('docx'); }}>DOCX</Button>
          <Button type="primary" loading={exporting === 'pdf'} onClick={() => { void doExport('pdf'); }}>PDF</Button>
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
                  { key: 'edit', label: t('documents.edit'), children: <TextArea rows={35} value={content} onChange={e => setContent(e.target.value)} /> },
                  {
                    key: 'chapters-facts', label: '章节与事实',
                    children: <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      {draft.chapters.length > 0 && <div>
                        <Text strong style={{ fontSize: 13, marginBottom: 8, display: 'block' }}>章节 ({draft.chapters.length})</Text>
                        <List size="small" dataSource={draft.chapters} renderItem={c => (
                          <List.Item actions={[<Button key="regen" size="small" icon={<ReloadOutlined />} loading={regeneratingChapter === c.id} onClick={() => { void regenCh(c); }}>重新生成</Button>]}>
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
                          title={<Text style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{`${STAGE_TITLES[s.type] || s.type} · ${s.roleId}`}</Text>}
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

      <Modal maskClosable={false} title={t('documents.templateEditor')} open={templateModalOpen} onOk={() => { void saveTpl(); }} onCancel={() => setTemplateModalOpen(false)} width={760} centered okText={t('common.save')} cancelText={t('common.cancel')}>
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
          <Form.Item name="documentSpecId" label={t('documents.documentSpec')}>
            <Select allowClear showSearch placeholder={t('documents.documentSpecPlaceholder')} options={documentSpecOptions} />
          </Form.Item>
          <Form.List name="chapters">
            {(fields, { add, remove }) => (
              <div>
                <Space style={{ marginBottom: 8 }}><Text strong>章节结构</Text><Button size="small" icon={<PlusOutlined />} onClick={() => add({ id: `chapter-${Date.now()}`, title: '', purpose: '', queries: [], requiredFacts: [] })}>添加章节</Button></Space>
                {fields.map(field => (
                  <Card key={field.key} size="small" style={{ marginBottom: 8 }}>
                    <Row gutter={8}>
                      <Col span={6}><Form.Item name={[field.name, 'id']} label="章节 ID" rules={[{ required: true }]}><Input /></Form.Item></Col>
                      <Col span={8}><Form.Item name={[field.name, 'title']} label="标题" rules={[{ required: true }]}><Input /></Form.Item></Col>
                      <Col span={8}><Form.Item name={[field.name, 'purpose']} label="目的"><Input /></Form.Item></Col>
                      <Col span={2}><Button danger size="small" onClick={() => remove(field.name)}>删除</Button></Col>
                      <Col span={12}><Form.Item name={[field.name, 'queriesText']} label="查询词（每行一个）"><TextArea rows={3} /></Form.Item></Col>
                      <Col span={12}><Form.Item name={[field.name, 'requiredFactsText']} label="必需事实（每行一个）"><TextArea rows={3} /></Form.Item></Col>
                    </Row>
                  </Card>
                ))}
              </div>
            )}
          </Form.List>
        </Form>
      </Modal>
    </div>
  );
}
