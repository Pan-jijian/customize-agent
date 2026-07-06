import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { App, Button, Card, Col, Empty, Form, Input, List, Modal, Popconfirm, Row, Select, Space, Steps, Tabs, Tag, Typography } from 'antd';
import { FileTextOutlined, ThunderboltOutlined, DownloadOutlined, SaveOutlined, ReloadOutlined, CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ApartmentOutlined, DatabaseOutlined, EyeOutlined, BulbOutlined, FormOutlined, PictureOutlined, SafetyCertificateOutlined, CheckCircleOutlined, FileDoneOutlined, LoadingOutlined } from '@ant-design/icons';
import { deleteDocumentTemplate, deleteGeneratedDocument, duplicateDocumentTemplate, exportDocument, generateDocumentDraft, getGeneratedDocument, getGeneratedDocuments, getDocumentRoles, getDocumentSpecs, getDocumentTemplates, regenerateDocumentChapter, saveDocumentDraft, saveDocumentTemplate, updateGeneratedDocument, type DocumentDraftChapter, type DocumentRole, type DocumentSpecPackage, type DocumentTemplate, type GeneratedDocumentDraft, type GeneratedDocumentRecord, type ProjectRoleConfig } from '@/lib/api';
import { useAppTranslations } from '@/components/Layout';

const { TextArea } = Input;
const { Paragraph, Text } = Typography;

type FlowStepStatus = 'wait' | 'process' | 'finish' | 'warning' | 'error';

interface FlowSubStep {
  key: string;
  title: string;
  status: FlowStepStatus;
}

interface FlowStep {
  key: string;
  title: string;
  description: string;
  status: FlowStepStatus;
  icon: ReactNode;
  subSteps: FlowSubStep[];
}

interface GenerationTaskState {
  id: number;
  templateId: string;
  loading: boolean;
  flowSteps: FlowStep[];
  activeFlowKey: string | null;
  promise: Promise<{ draft?: GeneratedDocumentDraft; taskId?: string; documentId?: string; record?: GeneratedDocumentRecord }>;
  draft?: GeneratedDocumentDraft;
  content?: string;
  error?: string;
  listeners: Set<() => void>;
}

let activeGenerationTask: GenerationTaskState | null = null;

function notifyGenerationTask() {
  activeGenerationTask?.listeners.forEach(listener => listener());
}

export default function DocumentsPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [form] = Form.useForm<DocumentTemplate>();
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [templateId, setTemplateId] = useState('construction-organization-design');
  const [roles, setRoles] = useState<DocumentRole[]>([]);
  const [roleConfigs, setRoleConfigs] = useState<ProjectRoleConfig[]>([]);
  const [documentSpecs, setDocumentSpecs] = useState<DocumentSpecPackage[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<GeneratedDocumentDraft | null>(null);
  const [content, setContent] = useState('');
  const [drafts, setDrafts] = useState<GeneratedDocumentRecord[]>([]);
  const [currentDocumentId, setCurrentDocumentId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [regeneratingChapter, setRegeneratingChapter] = useState<string | null>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [flowSteps, setFlowSteps] = useState<FlowStep[]>([]);
  const [activeFlowKey, setActiveFlowKey] = useState<string | null>(null);

  const loadDrafts = async () => {
    try { setDrafts((await getGeneratedDocuments()).documents); } catch { setDrafts([]); }
  };

  useEffect(() => {
    const syncTask = () => {
      if (!activeGenerationTask) return;
      setFlowSteps(activeGenerationTask.flowSteps);
      setActiveFlowKey(activeGenerationTask.activeFlowKey);
      setLoading(activeGenerationTask.loading);
      if (activeGenerationTask.draft) setDraft(activeGenerationTask.draft);
      if (activeGenerationTask.content !== undefined) setContent(activeGenerationTask.content);
    };
    activeGenerationTask?.listeners.add(syncTask);
    syncTask();
    return () => { activeGenerationTask?.listeners.delete(syncTask); };
  }, []);

  useEffect(() => {
    getDocumentTemplates().then(data => {
      setTemplates(data.templates);
      setTemplateId(data.templates[0]?.id ?? 'construction-organization-design');
    }).catch(() => message.error(t('common.error')));
    getDocumentRoles().then(data => { setRoles(data.roles); setRoleConfigs(data.configs); }).catch(() => { setRoles([]); setRoleConfigs([]); });
    getDocumentSpecs().then(data => setDocumentSpecs(data.specs)).catch(() => setDocumentSpecs([]));
    void loadDrafts();
  }, [message, t]);

  const currentTemplate = useMemo(() => templates.find(item => item.id === templateId), [templates, templateId]);
  const roleConfigOptions = roleConfigs.map(config => ({ label: config.name, value: config.id }));
  const documentSpecOptions = documentSpecs.map(spec => ({ label: spec.name, value: spec.id }));
  const activeFlowIndex = Math.max(0, flowSteps.findIndex(step => step.key === activeFlowKey));

  const subSteps = (items: string[]): FlowSubStep[] => items.map((title, index) => ({ key: `sub-${index}`, title, status: 'wait' }));

  const createInitialFlowSteps = (template = currentTemplate): FlowStep[] => {
    const spec = documentSpecs.find(item => item.id === template?.documentSpecId);
    const config = roleConfigs.find(item => item.id === template?.projectRoleConfigId);
    const fileRoleNames = (config?.fileRoles || []).map(item => roles.find(role => role.id === item.roleId)?.name || item.roleId);
    const promptRoleNames = (config?.promptRoles || []).map(item => roles.find(role => role.id === item.roleId)?.name || item.roleId);
    const factNames = spec?.factFields.map(item => item.name) || template?.chapters.flatMap(chapter => chapter.requiredFacts) || [];
    const chapterNames = template?.chapters.map(chapter => chapter.title) || [];
    const hasAssetRole = promptRoleNames.some(name => /封面|图片|资源|cover|image/iu.test(name));
    return [
      { key: 'prepare', title: t('documents.flowPrepare'), description: `读取“${template?.name || '当前模板'}”并创建后台生成任务`, status: 'process', icon: <FileTextOutlined />, subSteps: subSteps(['读取模板参数', template?.documentSpecId ? `加载规范包：${spec?.name || template.documentSpecId}` : '未绑定规范包，使用模板章节要求', '创建后台生成任务']) },
      { key: 'role_binding', title: '动态角色配置绑定', description: `绑定 ${fileRoleNames.length} 个文件角色、${promptRoleNames.length} 个提示词角色`, status: 'wait', icon: <ApartmentOutlined />, subSteps: subSteps([...(fileRoleNames.length ? fileRoleNames.map(name => `文件角色：${name}`) : ['没有文件角色，使用模板绑定文件']), ...(promptRoleNames.length ? promptRoleNames.map(name => `提示词角色：${name}`) : ['没有提示词角色，使用默认生成策略'])].slice(0, 10)) },
      { key: 'knowledge_retrieval', title: '知识库证据检索', description: `按 ${chapterNames.length} 个章节检索文本、文档、表格、图片、图纸和附件`, status: 'wait', icon: <DatabaseOutlined />, subSteps: subSteps(chapterNames.length ? chapterNames.slice(0, 10).map(name => `检索章节：${name}`) : ['按模板标题检索证据']) },
      { key: 'file_understanding', title: '多类型文件理解', description: '按文件角色处理文本、PDF/Word、表格、图片、图纸和附件', status: 'wait', icon: <EyeOutlined />, subSteps: subSteps(['识别文件类型和角色', '构建结构化资源证据包', '必要时调用多模态文件理解']) },
      { key: 'fact_extraction', title: '动态 schema 事实抽取', description: `按 ${factNames.length} 个规范/章节事实字段抽取并检测冲突`, status: 'wait', icon: <BulbOutlined />, subSteps: subSteps(factNames.length ? factNames.slice(0, 10).map(name => `抽取事实：${name}`) : ['抽取模板要求的事实', '合并来源和角色', '检测事实冲突']) },
      { key: 'chapter_generation', title: '章节生成', description: `按 ${chapterNames.length} 个模板章节逐章生成`, status: 'wait', icon: <FormOutlined />, subSteps: subSteps(chapterNames.length ? chapterNames.slice(0, 10).map(name => `生成：${name}`) : ['构造章节提示词', '等待 LLM 生成', '整理章节证据']) },
      ...(hasAssetRole ? [{ key: 'asset_generation', title: '生成资源处理', description: '根据资源/图片提示词生成或登记本地资源', status: 'wait' as const, icon: <PictureOutlined />, subSteps: subSteps(['生成资源提示词', '保存到 generatedDocuments/assets', '登记资源元数据']) }] : []),
      { key: 'validation', title: '规范包与门禁校验', description: spec ? `执行 ${spec.gateRules.length} 条门禁规则` : '执行模板基础校验', status: 'wait', icon: <SafetyCertificateOutlined />, subSteps: subSteps([...(spec?.factFields.filter(item => item.required).map(item => `必填事实：${item.name}`) || []), ...(spec?.gateRules.map(item => `门禁：${item.name}`) || ['检查章节证据', '检查缺失项', '检查导出门禁'])].slice(0, 10)) },
      { key: 'formatting', title: t('documents.flowFormatting'), description: '整理标题、表格、图片、附件引用和正式 Markdown', status: 'wait', icon: <CheckCircleOutlined />, subSteps: subSteps(['整理标题层级', '整理多类型资源引用', '生成正式 Markdown']) },
      { key: 'llm_review', title: 'LLM 审查优化', description: '再次使用动态 schema、角色和结构化证据审查优化初稿', status: 'wait', icon: <ThunderboltOutlined />, subSteps: subSteps(['构造审查提示词', '检查事实来源和冲突', '回填优化后的 Markdown']) },
      { key: 'export_ready', title: '导出就绪', description: '确认 Markdown/HTML/DOCX/PDF 可导出', status: 'wait', icon: <FileDoneOutlined />, subSteps: subSteps(['生成导出检查清单', '确认阻断项', '准备导出格式']) },
      { key: 'done', title: t('documents.flowDone'), description: t('documents.flowDoneDesc'), status: 'wait', icon: <DownloadOutlined />, subSteps: subSteps(['展示生成结果', '允许编辑正文', '允许导出文件']) },
    ];
  };

  const stageIcon = (type: string) => {
    const iconMap: Record<string, ReactNode> = {
      role_binding: <ApartmentOutlined />,
      knowledge_retrieval: <DatabaseOutlined />,
      file_understanding: <EyeOutlined />,
      fact_extraction: <BulbOutlined />,
      chapter_generation: <FormOutlined />,
      asset_generation: <PictureOutlined />,
      validation: <SafetyCertificateOutlined />,
      formatting: <CheckCircleOutlined />,
      llm_review: <ThunderboltOutlined />,
      export_ready: <FileDoneOutlined />,
      reference: <PictureOutlined />,
    };
    return iconMap[type] || <FileTextOutlined />;
  };

  const stageTitle = (type: string) => {
    const titleMap: Record<string, string> = {
      role_binding: '角色配置绑定',
      knowledge_retrieval: '知识库检索',
      file_understanding: '多模态文件理解',
      fact_extraction: 'LLM 事实抽取',
      chapter_generation: 'LLM 章节生成',
      asset_generation: '多模态资源生成',
      validation: '规则校验',
      formatting: '格式化排版',
      llm_review: 'LLM 审查优化',
      export_ready: '导出就绪',
      reference: '参考资源处理',
    };
    return titleMap[type] || type;
  };

  const formatGenerationDuration = (item: GeneratedDocumentRecord) => {
    const endAt = item.completedAt || item.updatedAt;
    const seconds = Math.max(0, Math.round((endAt - item.createdAt) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const restSeconds = seconds % 60;
    if (minutes < 60) return restSeconds ? `${minutes} 分 ${restSeconds} 秒` : `${minutes} 分`;
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
  };

  const draftStatusColor = (status: GeneratedDocumentRecord['status']) => status === 'completed' ? 'success' : status === 'warning' ? 'warning' : status === 'failed' ? 'error' : 'processing';
  const draftWarningTextColor = (status: GeneratedDocumentRecord['status']) => status === 'failed' ? 'var(--colorError)' : status === 'warning' ? 'var(--colorWarning)' : 'var(--colorTextSecondary)';

  const subStepIcon = (status: FlowStepStatus) => {
    if (status === 'process') return <LoadingOutlined />;
    if (status === 'finish') return <CheckCircleOutlined />;
    if (status === 'warning') return <SafetyCertificateOutlined className="text-[var(--colorWarning)]" />;
    if (status === 'error') return <DeleteOutlined />;
    return <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--colorTextTertiary)]" />;
  };

  const stepDescription = (step: FlowStep) => (
    <div className="space-y-1">
      <div>{step.description}</div>
      <div className="space-y-0.5">
        {step.subSteps.map(item => (
          <div key={item.key} className="flex items-center gap-1 text-xs text-[var(--colorTextSecondary)]">
            {subStepIcon(item.status)}
            <span>{item.title}</span>
          </div>
        ))}
      </div>
    </div>
  );

  const flowStepIcon = (step: FlowStep) => step.status === 'process' ? <LoadingOutlined /> : step.status === 'warning' ? <SafetyCertificateOutlined className="text-[var(--colorWarning)]" /> : step.icon;
  const antdStepStatus = (status: FlowStepStatus) => status === 'warning' ? 'finish' : status;

  const setFlowSnapshot = (steps: FlowStep[], activeKey: string | null, isLoading = loading) => {
    if (activeGenerationTask?.loading) {
      activeGenerationTask.flowSteps = steps;
      activeGenerationTask.activeFlowKey = activeKey;
      activeGenerationTask.loading = isLoading;
      notifyGenerationTask();
    }
  };

  const updateSubSteps = (step: FlowStep, status: FlowStepStatus) => {
    if (status === 'wait') return step.subSteps.map(item => ({ ...item, status: 'wait' as const }));
    if (status === 'finish') return step.subSteps.map(item => ({ ...item, status: 'finish' as const }));
    if (status === 'error') return step.subSteps.map((item, index) => ({ ...item, status: index === 0 ? 'error' as const : item.status }));
    const firstWaiting = step.subSteps.findIndex(item => item.status === 'wait');
    return step.subSteps.map((item, index) => {
      if (index < firstWaiting || firstWaiting === -1) return { ...item, status: 'finish' as const };
      if (index === firstWaiting) return { ...item, status: 'process' as const };
      return item;
    });
  };

  const updateFlowStep = (key: string, status: FlowStepStatus, description?: string) => {
    setActiveFlowKey(key);
    setFlowSteps(prev => {
      const next = prev.map(step => step.key === key ? { ...step, status, description: description || step.description, subSteps: updateSubSteps(step, status) } : step);
      setFlowSnapshot(next, key);
      return next;
    });
  };

  useEffect(() => {
    if (!loading || !activeFlowKey) return undefined;
    const timer = window.setInterval(() => {
      setFlowSteps(prev => {
        const next = prev.map(step => {
          if (step.key !== activeFlowKey || step.status !== 'process') return step;
          const currentIndex = step.subSteps.findIndex(item => item.status === 'process');
          const nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, step.subSteps.length - 1);
          return {
            ...step,
            subSteps: step.subSteps.map((item, index) => {
              if (index < nextIndex) return { ...item, status: 'finish' as const };
              if (index === nextIndex) return { ...item, status: 'process' as const };
              return { ...item, status: 'wait' as const };
            }),
          };
        });
        setFlowSnapshot(next, activeFlowKey);
        return next;
      });
    }, 1400);
    return () => window.clearInterval(timer);
  }, [activeFlowKey, loading]);

  const finishPreviousSteps = (key: string) => {
    setFlowSteps(prev => {
      const index = prev.findIndex(step => step.key === key);
      const next = prev.map((step, stepIndex) => stepIndex < index && step.status !== 'error' ? { ...step, status: 'finish' as const, subSteps: updateSubSteps(step, 'finish') } : step);
      setFlowSnapshot(next, key);
      return next;
    });
  };

  const openTemplateEditor = (template?: DocumentTemplate) => {
    form.setFieldsValue(template ?? {
      id: `custom-template-${Date.now()}`,
      name: '',
      description: '',
      category: '自定义',
      outputTitle: '',
      projectRoleConfigId: undefined,
      documentSpecId: undefined,
      chapters: [],
    });
    setTemplateModalOpen(true);
  };

  const handleSaveTemplate = async () => {
    try {
      const values = await form.validateFields();
      const result = await saveDocumentTemplate(values);
      setTemplates(result.templates);
      setTemplateId(result.template.id);
      setTemplateModalOpen(false);
      await loadDrafts();
      message.success(t('common.success'));
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    }
  };

  const handleDuplicateTemplate = async (id: string) => {
    try {
      const result = await duplicateDocumentTemplate(id);
      setTemplates(result.templates);
      setTemplateId(result.template.id);
      message.success(t('common.success'));
    } catch { message.error(t('common.error')); }
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      const result = await deleteDocumentTemplate(id);
      setTemplates(result.templates);
      setTemplateId(result.templates[0]?.id ?? '');
      message.success(t('common.success'));
    } catch { message.error(t('common.error')); }
  };

  const handleDeleteDraft = async (id: string) => {
    try {
      await deleteGeneratedDocument(id);
      if (currentDocumentId === id) {
        setCurrentDocumentId(null);
        setDraft(null);
        setContent('');
      }
      await loadDrafts();
      message.success(t('common.success'));
    } catch { message.error(t('common.error')); }
  };

  const waitForGeneratedDocument = async (documentId: string) => {
    const pollFlow = [
      { key: 'chapter_generation', message: '后台任务已创建，正在轮询等待 LLM 章节生成完成…' },
      { key: 'asset_generation', message: '正在轮询等待封面和生成资源写入本地记录…' },
      { key: 'validation', message: '正在轮询等待校验、导出门禁和格式化完成…' },
      { key: 'llm_review', message: '正在轮询等待 LLM 审查优化完成…' },
    ];
    let tick = 0;
    for (;;) {
      const { document } = await getGeneratedDocument(documentId);
      if ((document.status === 'completed' || document.status === 'warning') && document.draft) return document;
      if (document.status === 'failed') throw new Error(document.error || '生成失败');
      const current = pollFlow[Math.min(tick, pollFlow.length - 1)]!;
      finishPreviousSteps(current.key);
      updateFlowStep(current.key, 'process', current.message);
      tick += 1;
      await new Promise(resolve => window.setTimeout(resolve, 1500));
    }
  };

  const handleGenerate = async () => {
    if (!templateId) return;
    if (activeGenerationTask?.loading) {
      setFlowSteps(activeGenerationTask.flowSteps);
      setActiveFlowKey(activeGenerationTask.activeFlowKey);
      setLoading(true);
      return;
    }
    setLoading(true);
    const selectedTemplate = templates.find(item => item.id === templateId) || currentTemplate;
    const initialSteps = createInitialFlowSteps(selectedTemplate);
    const promise = generateDocumentDraft({ templateId });
    activeGenerationTask = { id: Date.now(), templateId, loading: true, flowSteps: initialSteps, activeFlowKey: 'prepare', promise, listeners: new Set() };
    setFlowSteps(initialSteps);
    setActiveFlowKey('prepare');
    const previewFlow = [
      { key: 'role_binding', message: '正在读取模板、文件角色、提示词角色和文档规范包…' },
      { key: 'knowledge_retrieval', message: '正在从知识库检索章节证据、表格、图片和附件…' },
      { key: 'file_understanding', message: '正在准备多模态文件理解；如果模型支持图片/文件理解，会等待模型返回…' },
      { key: 'fact_extraction', message: '正在等待 LLM 事实抽取和后续章节生成结果，请不要关闭页面…' },
    ];
    const timers = previewFlow.map((item, index) => window.setTimeout(() => { finishPreviousSteps(item.key); updateFlowStep(item.key, 'process', item.message); }, 600 + index * 900));
    try {
      const started = await promise;
      const document = started.documentId ? await waitForGeneratedDocument(started.documentId) : undefined;
      const resultDraft = started.draft || document?.draft;
      if (!resultDraft) throw new Error('生成结果为空');
      if (started.documentId || document?.id) setCurrentDocumentId(started.documentId || document!.id);
      timers.forEach(timer => window.clearTimeout(timer));
      finishPreviousSteps('done');
      setDraft(resultDraft);
      setContent(document?.editedMarkdown || document?.markdown || resultDraft.markdown);
      if (activeGenerationTask?.promise === promise) {
        activeGenerationTask.draft = resultDraft;
        activeGenerationTask.content = document?.editedMarkdown || document?.markdown || resultDraft.markdown;
      }
      setFlowSteps(prev => {
        const next = prev.map(step => {
        const stage = resultDraft.executionStages.find(item => item.type === step.key);
        if (step.key === 'prepare') return { ...step, status: 'finish' as const, description: t('documents.flowPrepareDone'), subSteps: updateSubSteps(step, 'finish') };
        if (step.key === 'done') {
          const hasIssues = resultDraft.validationIssues.some(item => item.level === 'error' || item.level === 'warning') || !resultDraft.exportGate.passed;
          const status: FlowStepStatus = hasIssues ? 'warning' : 'finish';
          const reason = resultDraft.validationIssues.find(item => item.level === 'error' || item.level === 'warning')?.message;
          return { ...step, status, description: hasIssues ? `生成完成，但需要复核：${reason || t('documents.flowGateFailed')}` : t('documents.flowDoneDesc'), subSteps: updateSubSteps(step, status) };
        }
        if (!stage) return step.status === 'process' ? { ...step, status: 'finish' as const, subSteps: updateSubSteps(step, 'finish') } : step;
        const status: FlowStepStatus = stage.status === 'failed' ? 'error' : 'finish';
        return { ...step, status, description: `${stage.status.toUpperCase()}：${stage.message || step.description}`, subSteps: updateSubSteps(step, status) };
        });
        setFlowSnapshot(next, 'done', false);
        return next;
      });
      setActiveFlowKey('done');
      if (activeGenerationTask?.promise === promise) {
        activeGenerationTask.activeFlowKey = 'done';
        activeGenerationTask.loading = false;
        notifyGenerationTask();
      }
      await loadDrafts();
      message.success(t('common.success'));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('common.error');
      setFlowSteps(prev => {
        const next = prev.map(step => step.status === 'process' ? { ...step, status: 'error' as const, description: errorMessage, subSteps: updateSubSteps(step, 'error') } : step);
        setFlowSnapshot(next, activeFlowKey, false);
        return next;
      });
      if (activeGenerationTask?.promise === promise) {
        activeGenerationTask.loading = false;
        activeGenerationTask.error = errorMessage;
        notifyGenerationTask();
      }
      message.error(errorMessage);
    } finally {
      timers.forEach(timer => window.clearTimeout(timer));
      setLoading(false);
      if (activeGenerationTask?.promise === promise) {
        activeGenerationTask.loading = false;
        notifyGenerationTask();
      }
    }
  };

  const downloadBlob = (blob: Blob, filename: string, mimeType: string) => {
    const safeBlob = new Blob([blob], { type: mimeType });
    const url = URL.createObjectURL(safeBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.target = '_self';
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleExport = async (format: 'markdown' | 'html' | 'pdf' | 'docx') => {
    if (!draft) return;
    setExporting(true);
    try {
      const mimeTypes = {
        markdown: 'text/markdown;charset=utf-8',
        html: 'text/html;charset=utf-8',
        pdf: 'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
      const extension = format === 'markdown' ? 'md' : format;
      const wordTemplatePath = documentSpecs.find(spec => spec.id === currentTemplate?.documentSpecId)?.wordTemplatePath;
      const blob = await exportDocument({ documentId: currentDocumentId || undefined, title: draft.title, markdown: content, format, enforceGate: false, exportGate: draft.exportGate, wordTemplatePath });
      downloadBlob(blob, `${draft.title}.${extension}`, mimeTypes[format]);
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('common.error'));
    } finally { setExporting(false); }
  };

  const handleSaveDraft = async () => {
    if (!draft) return;
    try {
      if (currentDocumentId) {
        await updateGeneratedDocument(currentDocumentId, { editedMarkdown: content, markdown: content });
      } else {
        const saved = await saveDocumentDraft({ ...draft, markdown: content });
        setDraft(saved.draft);
      }
      await loadDrafts();
      message.success(t('common.success'));
    } catch { message.error(t('common.error')); }
  };

  const replaceChapterContent = (oldChapter: DocumentDraftChapter, newChapter: DocumentDraftChapter) => {
    setContent(prev => prev.includes(oldChapter.content) ? prev.replace(oldChapter.content, newChapter.content) : `${prev}\n\n${newChapter.content}`);
  };

  const handleRegenerateChapter = async (chapter: DocumentDraftChapter) => {
    if (!draft) return;
    setRegeneratingChapter(chapter.id);
    try {
      const result = await regenerateDocumentChapter({ templateId: draft.templateId, chapterId: chapter.id });
      const chapters = draft.chapters.map(item => item.id === chapter.id ? result.chapter : item);
      setDraft({ ...draft, chapters });
      replaceChapterContent(chapter, result.chapter);
      message.success(t('common.success'));
    } catch { message.error(t('common.error')); } finally { setRegeneratingChapter(null); }
  };

  return (
    <div className="space-y-6 animateFadeIn">
      <Card className="cardGlass" styles={{ body: { padding: 24 } }}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="pageTitle mb-1">{t('documents.title')}</h1>
            <p className="pageDesc mb-0">{t('documents.description')}</p>
          </div>
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => openTemplateEditor()}>{t('documents.newTemplate')}</Button>
        </div>
      </Card>

      <Row gutter={[16, 16]} align="top">
        <Col xs={24} lg={8}>
          <Card size="small" title={t('documents.templateLibrary')}>
            <List
              dataSource={templates}
              locale={{ emptyText: <Empty description={t('common.noData')} /> }}
              renderItem={(item, index) => (
                <List.Item
                  onClick={() => setTemplateId(item.id)}
                  className="cursor-pointer"
                  actions={[
                    <Button key="copy" size="small" type="text" icon={<CopyOutlined />} onClick={(event) => { event.stopPropagation(); void handleDuplicateTemplate(item.id); }} />,
                    <Button key="edit" size="small" type="text" icon={<EditOutlined />} disabled={item.builtIn} onClick={(event) => { event.stopPropagation(); openTemplateEditor(item); }} />,
                    <Popconfirm key="delete" title={t('documents.deleteTemplateConfirm')} disabled={item.builtIn} onConfirm={(event) => { event?.stopPropagation(); void handleDeleteTemplate(item.id); }}><Button size="small" type="text" danger icon={<DeleteOutlined />} disabled={item.builtIn} onClick={(event) => event.stopPropagation()} /></Popconfirm>,
                  ]}
                >
                  <List.Item.Meta
                    avatar={<FileTextOutlined />}
                    title={<Space><Tag>序号 {index + 1}</Tag><span>{item.name}</span>{item.builtIn && <Tag>{t('documents.builtIn')}</Tag>}{templateId === item.id && <Tag color="blue">{t('documents.selected')}</Tag>}</Space>}
                    description={<Space direction="vertical" size={2}><span>{item.description}</span><Tag>{item.category}</Tag></Space>}
                  />
                </List.Item>
              )}
            />
          </Card>
          <Card className="mt-4" size="small" title={t('documents.draftHistory')}>
            {drafts.length === 0 ? <Empty description={t('common.noData')} /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {drafts.slice(0, 8).map((item, index) => (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => { void (async () => { setCurrentDocumentId(item.id); setTemplateId(item.templateId); const { document } = await getGeneratedDocument(item.id); setDraft(document.draft || null); setContent(document.editedMarkdown || document.markdown); })(); }}
                    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.click(); }}
                    style={{ display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--colorBorderSecondary)', cursor: 'pointer', minWidth: 0 }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <Tag style={{ marginInlineEnd: 0 }}>序号 {index + 1}</Tag>
                        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{item.title}</span>
                        <Tag style={{ marginInlineEnd: 0 }} color={draftStatusColor(item.status)}>{item.status === 'warning' ? 'warning' : item.status}</Tag>
                      </div>
                      <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: '4px 8px', color: 'var(--colorTextSecondary)', fontSize: 12 }}>
                        <span>{new Date(item.updatedAt).toLocaleString()}</span>
                        <span>耗时：{formatGenerationDuration(item)}</span>
                      </div>
                      {item.status === 'warning' && <div style={{ marginTop: 4, color: draftWarningTextColor(item.status), fontSize: 12, overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflowWrap: 'anywhere', wordBreak: 'break-all' }}>{item.warningIssues?.[0] || item.draft?.validationIssues.find(issue => issue.level === 'error' || issue.level === 'warning')?.message || '生成完成，但存在需要复核的问题'}</div>}
                    </div>
                    <Popconfirm title="确认删除这条生成记录？" onConfirm={(event) => { event?.stopPropagation(); void handleDeleteDraft(item.id); }}>
                      <Button size="small" danger title="删除记录" aria-label="删除记录" icon={<DeleteOutlined />} onClick={(event) => event.stopPropagation()} />
                    </Popconfirm>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={16}>
          <Card size="small" title={t('documents.workflow')}>
            <Space direction="vertical" className="w-full" size="middle">
              <div>
                <span className="block mb-1">{t('documents.template')}</span>
                <Select className="w-full" value={templateId} onChange={setTemplateId} options={templates.map(item => ({ label: item.name, value: item.id }))} />
              </div>
              {currentTemplate && (
                <Card size="small" type="inner" title={currentTemplate.outputTitle}>
                  <Paragraph>{currentTemplate.description}</Paragraph>
                  <Space wrap>
                    {currentTemplate.projectRoleConfigId ? <Tag color="geekblue">{roleConfigs.find(config => config.id === currentTemplate.projectRoleConfigId)?.name || currentTemplate.projectRoleConfigId}</Tag> : <Tag color="warning">{t('documents.noRoleConfig')}</Tag>}
                    {currentTemplate.documentSpecId ? <Tag color="cyan">{documentSpecs.find(spec => spec.id === currentTemplate.documentSpecId)?.name || currentTemplate.documentSpecId}</Tag> : null}
                  </Space>
                </Card>
              )}
              {currentTemplate && (
                <Space direction="vertical" size={4}>
                  <span>{t('documents.projectRoleConfig')}: {roleConfigs.find(config => config.id === currentTemplate.projectRoleConfigId)?.name || t('documents.noRoleConfig')}</span>
                </Space>
              )}
              <Button type="primary" size="large" block icon={<ThunderboltOutlined />} loading={loading} disabled={!currentTemplate?.projectRoleConfigId} onClick={() => { void handleGenerate(); }}>{t('documents.generate')}</Button>
              {flowSteps.length > 0 && (
                <Card size="small" type="inner" title={t('documents.executionStatus')}>
                  <Steps
                    direction="vertical"
                    size="small"
                    current={activeFlowIndex}
                    items={flowSteps.map(step => ({ title: step.title, description: stepDescription(step), status: antdStepStatus(step.status), icon: flowStepIcon(step) }))}
                  />
                </Card>
              )}
            </Space>
          </Card>
        </Col>
      </Row>

      <Card size="small" title={t('documents.editor')} extra={<Space wrap>{draft && <><Button icon={<SaveOutlined />} onClick={() => { void handleSaveDraft(); }}>{t('documents.saveDraft')}</Button><Button icon={<DownloadOutlined />} loading={exporting} onClick={() => { void handleExport('markdown'); }}>{t('documents.downloadMarkdown')}</Button><Button loading={exporting} onClick={() => { void handleExport('html'); }}>{t('documents.exportHtml')}</Button><Button loading={exporting} onClick={() => { void handleExport('docx'); }}>{t('documents.exportDocx')}</Button><Button type="primary" loading={exporting} onClick={() => { void handleExport('pdf'); }}>{t('documents.exportPdf')}</Button></>}</Space>}>
        {!draft ? <Empty description={t('documents.noDraft')} /> : (
          <Tabs
            items={[
              { key: 'edit', label: t('documents.edit'), children: <TextArea rows={26} value={content} onChange={event => setContent(event.target.value)} /> },
              { key: 'chapters', label: t('documents.chapters'), children: <List dataSource={draft.chapters} renderItem={(chapter, index) => <List.Item actions={[<Button key="regen" size="small" icon={<ReloadOutlined />} loading={regeneratingChapter === chapter.id} onClick={() => { void handleRegenerateChapter(chapter); }}>{t('documents.regenerateChapter')}</Button>]}><List.Item.Meta title={<Space><Tag>序号 {index + 1}</Tag>{chapter.title}</Space>} description={<Space direction="vertical"><span>{t('documents.evidenceCount')}: {chapter.evidence.length}</span><span>{t('documents.missingCount')}: {chapter.missingFacts.length}</span></Space>} /></List.Item>} /> },
              { key: 'facts', label: t('documents.structuredFacts'), children: <List dataSource={draft.structuredFacts} renderItem={(fact, index) => <List.Item><List.Item.Meta title={<Space><Tag>序号 {index + 1}</Tag>{`${fact.key}: ${fact.value}`}</Space>} description={`${fact.sourceFile} · ${roles.find(role => role.id === fact.roleId)?.name || fact.roleId}`} /><Tag>{fact.confidence.toFixed(2)}</Tag></List.Item>} /> },
              { key: 'sources', label: t('documents.sources'), children: <List dataSource={draft.sources} renderItem={source => <List.Item><span>{source.filePath}</span><Tag>{source.count}</Tag></List.Item>} /> },
              { key: 'missing', label: t('documents.missingItems'), children: draft.missingItems.length === 0 ? <Empty description={t('common.noData')} /> : <List dataSource={draft.missingItems} renderItem={item => <List.Item>{item}</List.Item>} /> },
              { key: 'validation', label: t('documents.validation'), children: draft.validationIssues.length === 0 ? <Empty description={t('common.noData')} /> : <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}>{draft.validationIssues.map(item => <div key={`${item.level}-${item.message}`} style={{ minWidth: 0, maxWidth: '100%', overflow: 'hidden', border: '1px solid var(--colorBorderSecondary)', borderRadius: 8, padding: 12, background: 'var(--colorBgContainer)' }}><Tag color={item.level === 'error' ? 'error' : item.level === 'warning' ? 'warning' : 'blue'}>{item.level}</Tag><div style={{ marginTop: 6, maxWidth: '100%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-all', lineHeight: 1.6 }}>{item.message}</div>{item.suggestion && <div style={{ marginTop: 6, maxWidth: '100%', color: 'var(--colorTextSecondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-all', lineHeight: 1.6 }}>{item.suggestion}</div>}</div>)}</div> },
              { key: 'gate', label: t('documents.exportGate'), children: <List dataSource={draft.exportGate.checklist} renderItem={item => <List.Item className="min-w-0"><Space direction="vertical" size={2} className="min-w-0 flex-1"><Text className="block max-w-full" style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{item.label}</Text>{item.message && <Text type="secondary" className="block max-w-full" style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{item.message}</Text>}</Space><Tag color={item.passed ? 'success' : 'error'}>{item.passed ? 'PASS' : 'FAIL'}</Tag></List.Item>} /> },
              { key: 'stages', label: t('documents.executionStages'), children: <List dataSource={draft.executionStages} renderItem={item => <List.Item className="min-w-0"><List.Item.Meta avatar={stageIcon(item.type)} title={<Text className="block max-w-full" style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{`${stageTitle(item.type)} · ${item.roleId}`}</Text>} description={<Text type="secondary" className="block max-w-full whitespace-pre-wrap" style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{item.message}</Text>} /><Tag color={item.status === 'success' ? 'success' : item.status === 'failed' ? 'error' : item.status === 'skipped' ? 'default' : 'warning'}>{item.status}</Tag></List.Item>} /> },
            ]}
          />
        )}
      </Card>

      <Modal maskClosable={false} title={t('documents.templateEditor')} open={templateModalOpen} onOk={() => { void handleSaveTemplate(); }} onCancel={() => setTemplateModalOpen(false)} width={760} centered okText={t('common.save')}>
        <Form form={form} layout="vertical" requiredMark="optional">
          <Row gutter={12}>
            <Col xs={24} md={8}><Form.Item name="id" label="ID" rules={[{ required: true }]}><Input disabled /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="name" label={t('documents.templateName')} rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="category" label={t('documents.templateCategory')}><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="outputTitle" label={t('documents.outputTitle')}><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="description" label={t('documents.templateDescription')}><Input /></Form.Item></Col>
          </Row>
          <Form.Item name="projectRoleConfigId" label={t('documents.projectRoleConfig')} rules={[{ required: true, message: t('documents.projectRoleConfigRequired') }]}>
            <Select showSearch placeholder={t('documents.projectRoleConfigRequired')} options={roleConfigOptions} />
          </Form.Item>
          <Form.Item name="documentSpecId" label={t('documents.documentSpec')}>
            <Select allowClear showSearch placeholder={t('documents.documentSpecPlaceholder')} options={documentSpecOptions} />
          </Form.Item>
        </Form>
      </Modal>

    </div>
  );
}
