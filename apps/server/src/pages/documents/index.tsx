import { useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Col, Empty, Form, Input, List, Modal, Popconfirm, Row, Select, Space, Steps, Tabs, Tag, Typography } from 'antd';
import { FileTextOutlined, ThunderboltOutlined, DownloadOutlined, SaveOutlined, ReloadOutlined, CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { deleteDocumentTemplate, duplicateDocumentTemplate, exportDocument, generateDocumentDraft, getDocumentDrafts, getDocumentRoles, getDocumentTemplates, regenerateDocumentChapter, saveDocumentDraft, saveDocumentTemplate, type DocumentDraftChapter, type DocumentRole, type DocumentTemplate, type GeneratedDocumentDraft, type ProjectRoleConfig, type StoredDocumentDraft } from '@/lib/api';
import { useAppTranslations } from '@/components/Layout';

const { TextArea } = Input;
const { Paragraph } = Typography;

type FlowStepStatus = 'wait' | 'process' | 'finish' | 'error';

interface FlowStep {
  key: string;
  title: string;
  description: string;
  status: FlowStepStatus;
}

export default function DocumentsPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [form] = Form.useForm<DocumentTemplate>();
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [templateId, setTemplateId] = useState('construction-organization-design');
  const [roles, setRoles] = useState<DocumentRole[]>([]);
  const [roleConfigs, setRoleConfigs] = useState<ProjectRoleConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<GeneratedDocumentDraft | null>(null);
  const [content, setContent] = useState('');
  const [drafts, setDrafts] = useState<StoredDocumentDraft[]>([]);
  const [exporting, setExporting] = useState(false);
  const [regeneratingChapter, setRegeneratingChapter] = useState<string | null>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [flowSteps, setFlowSteps] = useState<FlowStep[]>([]);
  const [activeFlowKey, setActiveFlowKey] = useState<string | null>(null);

  const loadDrafts = async () => {
    try { setDrafts((await getDocumentDrafts()).drafts); } catch { setDrafts([]); }
  };

  useEffect(() => {
    getDocumentTemplates().then(data => {
      setTemplates(data.templates);
      setTemplateId(data.templates[0]?.id ?? 'construction-organization-design');
    }).catch(() => message.error(t('common.error')));
    getDocumentRoles().then(data => { setRoles(data.roles); setRoleConfigs(data.configs); }).catch(() => { setRoles([]); setRoleConfigs([]); });
    void loadDrafts();
  }, [message, t]);

  const currentTemplate = useMemo(() => templates.find(item => item.id === templateId), [templates, templateId]);
  const roleConfigOptions = roleConfigs.map(config => ({ label: config.name, value: config.id }));
  const activeFlowIndex = Math.max(0, flowSteps.findIndex(step => step.key === activeFlowKey));

  const createInitialFlowSteps = (): FlowStep[] => [
    { key: 'prepare', title: t('documents.flowPrepare'), description: t('documents.flowPrepareDesc'), status: 'process' },
    { key: 'fact_extraction', title: t('documents.flowFactExtraction'), description: t('documents.flowFactExtractionDesc'), status: 'wait' },
    { key: 'chapter_generation', title: t('documents.flowChapterGeneration'), description: t('documents.flowChapterGenerationDesc'), status: 'wait' },
    { key: 'validation', title: t('documents.flowValidation'), description: t('documents.flowValidationDesc'), status: 'wait' },
    { key: 'formatting', title: t('documents.flowFormatting'), description: t('documents.flowFormattingDesc'), status: 'wait' },
    { key: 'done', title: t('documents.flowDone'), description: t('documents.flowDoneDesc'), status: 'wait' },
  ];

  const updateFlowStep = (key: string, status: FlowStepStatus, description?: string) => {
    setActiveFlowKey(key);
    setFlowSteps(prev => prev.map(step => step.key === key ? { ...step, status, description: description || step.description } : step));
  };

  const finishPreviousSteps = (key: string) => {
    setFlowSteps(prev => {
      const index = prev.findIndex(step => step.key === key);
      return prev.map((step, stepIndex) => stepIndex < index && step.status !== 'error' ? { ...step, status: 'finish' } : step);
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

  const handleGenerate = async () => {
    if (!templateId) return;
    setLoading(true);
    const initialSteps = createInitialFlowSteps();
    setFlowSteps(initialSteps);
    setActiveFlowKey('prepare');
    const timers = [
      window.setTimeout(() => { finishPreviousSteps('fact_extraction'); updateFlowStep('fact_extraction', 'process'); }, 600),
      window.setTimeout(() => { finishPreviousSteps('chapter_generation'); updateFlowStep('chapter_generation', 'process'); }, 1800),
      window.setTimeout(() => { finishPreviousSteps('validation'); updateFlowStep('validation', 'process'); }, 3200),
      window.setTimeout(() => { finishPreviousSteps('formatting'); updateFlowStep('formatting', 'process'); }, 4600),
    ];
    try {
      const result = await generateDocumentDraft({ templateId });
      setDraft(result.draft);
      setContent(result.draft.markdown);
      setFlowSteps(prev => prev.map(step => {
        const stage = result.draft.executionStages.find(item => item.type === step.key);
        if (step.key === 'prepare') return { ...step, status: 'finish', description: t('documents.flowPrepareDone') };
        if (step.key === 'done') return { ...step, status: result.draft.exportGate.passed ? 'finish' : 'error', description: result.draft.exportGate.passed ? t('documents.flowDoneDesc') : t('documents.flowGateFailed') };
        if (!stage) return step.status === 'process' ? { ...step, status: 'finish' } : step;
        return { ...step, status: stage.status === 'failed' ? 'error' : 'finish', description: stage.message || step.description };
      }));
      setActiveFlowKey('done');
      message.success(t('common.success'));
    } catch (error) {
      setFlowSteps(prev => prev.map(step => step.status === 'process' ? { ...step, status: 'error', description: error instanceof Error ? error.message : t('common.error') } : step));
      message.error(error instanceof Error ? error.message : t('common.error'));
    } finally {
      timers.forEach(timer => window.clearTimeout(timer));
      setLoading(false);
    }
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleExport = async (format: 'markdown' | 'html' | 'pdf') => {
    if (!draft) return;
    setExporting(true);
    try {
      const blob = await exportDocument({ title: draft.title, markdown: content, format, enforceGate: format === 'pdf', exportGate: draft.exportGate });
      downloadBlob(blob, `${draft.title}.${format === 'markdown' ? 'md' : format}`);
    } catch { message.error(t('common.error')); } finally { setExporting(false); }
  };

  const handleSaveDraft = async () => {
    if (!draft) return;
    try {
      const saved = await saveDocumentDraft({ ...draft, markdown: content });
      setDraft(saved.draft);
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
              renderItem={item => (
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
                    title={<Space><span>{item.name}</span>{item.builtIn && <Tag>{t('documents.builtIn')}</Tag>}{templateId === item.id && <Tag color="blue">{t('documents.selected')}</Tag>}</Space>}
                    description={<Space direction="vertical" size={2}><span>{item.description}</span><Tag>{item.category}</Tag></Space>}
                  />
                </List.Item>
              )}
            />
          </Card>
          <Card className="mt-4" size="small" title={t('documents.draftHistory')}>
            <List
              size="small"
              dataSource={drafts.slice(0, 8)}
              locale={{ emptyText: <Empty description={t('common.noData')} /> }}
              renderItem={item => <List.Item onClick={() => { setDraft(item); setContent(item.markdown); setTemplateId(item.templateId); }} className="cursor-pointer"><List.Item.Meta title={item.title} description={new Date(item.updatedAt).toLocaleString()} /></List.Item>}
            />
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
                    items={flowSteps.map(step => ({ title: step.title, description: step.description, status: step.status }))}
                  />
                </Card>
              )}
            </Space>
          </Card>
        </Col>
      </Row>

      <Card size="small" title={t('documents.editor')} extra={<Space wrap>{draft && <><Button icon={<SaveOutlined />} onClick={() => { void handleSaveDraft(); }}>{t('documents.saveDraft')}</Button><Button icon={<DownloadOutlined />} loading={exporting} onClick={() => { void handleExport('markdown'); }}>{t('documents.downloadMarkdown')}</Button><Button loading={exporting} onClick={() => { void handleExport('html'); }}>{t('documents.exportHtml')}</Button><Button type="primary" loading={exporting} onClick={() => { void handleExport('pdf'); }}>{t('documents.exportPdf')}</Button></>}</Space>}>
        {!draft ? <Empty description={t('documents.noDraft')} /> : (
          <Tabs
            items={[
              { key: 'edit', label: t('documents.edit'), children: <TextArea rows={26} value={content} onChange={event => setContent(event.target.value)} /> },
              { key: 'chapters', label: t('documents.chapters'), children: <List dataSource={draft.chapters} renderItem={chapter => <List.Item actions={[<Button key="regen" size="small" icon={<ReloadOutlined />} loading={regeneratingChapter === chapter.id} onClick={() => { void handleRegenerateChapter(chapter); }}>{t('documents.regenerateChapter')}</Button>]}><List.Item.Meta title={chapter.title} description={<Space direction="vertical"><span>{t('documents.evidenceCount')}: {chapter.evidence.length}</span><span>{t('documents.missingCount')}: {chapter.missingFacts.length}</span></Space>} /></List.Item>} /> },
              { key: 'facts', label: t('documents.structuredFacts'), children: <List dataSource={draft.structuredFacts} renderItem={fact => <List.Item><List.Item.Meta title={`${fact.key}: ${fact.value}`} description={`${fact.sourceFile} · ${roles.find(role => role.id === fact.roleId)?.name || fact.roleId}`} /><Tag>{fact.confidence.toFixed(2)}</Tag></List.Item>} /> },
              { key: 'sources', label: t('documents.sources'), children: <List dataSource={draft.sources} renderItem={source => <List.Item><span>{source.filePath}</span><Tag>{source.count}</Tag></List.Item>} /> },
              { key: 'missing', label: t('documents.missingItems'), children: draft.missingItems.length === 0 ? <Empty description={t('common.noData')} /> : <List dataSource={draft.missingItems} renderItem={item => <List.Item>{item}</List.Item>} /> },
              { key: 'validation', label: t('documents.validation'), children: <Space direction="vertical" className="w-full">{draft.validationIssues.map(item => <Tag key={item.message} color={item.level === 'error' ? 'error' : item.level === 'warning' ? 'warning' : 'blue'}>{item.message}{item.suggestion ? `：${item.suggestion}` : ''}</Tag>)}</Space> },
              { key: 'gate', label: t('documents.exportGate'), children: <List dataSource={draft.exportGate.checklist} renderItem={item => <List.Item><span>{item.label}</span><Tag color={item.passed ? 'success' : 'error'}>{item.passed ? 'PASS' : 'FAIL'}</Tag></List.Item>} /> },
              { key: 'stages', label: t('documents.executionStages'), children: <List dataSource={draft.executionStages} renderItem={item => <List.Item><List.Item.Meta title={`${item.type} · ${item.roleId}`} description={item.message} /><Tag color={item.status === 'success' ? 'success' : item.status === 'failed' ? 'error' : 'warning'}>{item.status}</Tag></List.Item>} /> },
            ]}
          />
        )}
      </Card>

      <Modal title={t('documents.templateEditor')} open={templateModalOpen} onOk={() => { void handleSaveTemplate(); }} onCancel={() => setTemplateModalOpen(false)} width={760} centered okText={t('common.save')}>
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
        </Form>
      </Modal>

    </div>
  );
}
