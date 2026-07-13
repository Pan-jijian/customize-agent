import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Col, Drawer, Empty, Form, Input, InputNumber, List, Modal, Popconfirm, Row, Select, Space, Switch, Tabs, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, DownOutlined, UpOutlined } from '@ant-design/icons';
import { deleteDocumentGateType, deleteDocumentSpec, getDocumentRoles, getDocumentSpecs, saveDocumentGateType, saveDocumentSpec, type DocumentRole, type DocumentSpecGateType, type DocumentSpecPackage } from '@/lib/api';
import { useAppTranslations } from '@/components/Layout';

const chapterModeOptions = [
  { label: '动态章节', value: 'dynamic' },
  { label: '固定章节', value: 'fixed' },
];
const dynamicChapterSourceOptions = [
  { label: 'AI 根据资料自动规划', value: 'ai_plan' },
  { label: '从文件目录/标题识别', value: 'file_outline' },
  { label: '从指定文件角色识别', value: 'file_role' },
  { label: '按事实字段分组', value: 'fact_group' },
  { label: '按表格行生成', value: 'table_rows' },
];
const titleStrategyOptions = [
  { label: 'AI 摘要标题', value: 'ai_summary' },
  { label: '使用来源标题', value: 'source_title' },
  { label: '使用字段值', value: 'field_value' },
  { label: '标题模板', value: 'template' },
];
const levelOptions = [
  { label: '错误（阻断）', value: 'error' }, { label: '警告（提醒）', value: 'warning' }, { label: '信息（提示）', value: 'info' },
];
const subjectOptions = [
  { label: '全文', value: 'document' }, { label: '章节', value: 'chapter' }, { label: '事实字段', value: 'fact' },
  { label: '文件角色', value: 'file_role' }, { label: '提示词角色', value: 'prompt_role' }, { label: '表格', value: 'table' },
  { label: '图片', value: 'image' }, { label: '来源', value: 'source' },
];
const operatorOptions = [
  { label: '必须存在', value: 'exists' }, { label: '必须包含', value: 'contains' }, { label: '禁止包含', value: 'not_contains' },
  { label: '正则必须匹配', value: 'regex_match' }, { label: '正则禁止匹配', value: 'regex_not_match' },
  { label: '数量至少为 N', value: 'min_count' }, { label: '字数至少为 N', value: 'min_length' },
  { label: '全部必须有来源', value: 'all_have_source' }, { label: '图片必须有说明', value: 'image_caption_required' },
  { label: '表格必须有说明', value: 'table_explanation_required' },
];

const niceTagRender = (props: { label: React.ReactNode; value: string; closable: boolean; onClose: () => void }) => {
  const { label, closable, onClose } = props;
  return (
    <Tag closable={closable} onClose={onClose} color="blue" style={{ margin: '1px 2px', fontSize: 11, lineHeight: '18px' }}>
      {label}
    </Tag>
  );
};

/** 创建默认的事实字段列表（用于新规范包的初始值） */
function defaultFactFields(): DocumentSpecPackage['factFields'] {
  return [
    { id: 'document-goal', name: '文档目标', type: 'auto', required: true },
    { id: 'target-audience', name: '目标读者', type: 'auto', required: false },
    { id: 'key-conclusion', name: '关键结论', type: 'auto', required: true },
  ];
}

export default function DocumentSpecsPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [form] = Form.useForm<DocumentSpecPackage>();
  const [gateTypeForm] = Form.useForm<DocumentSpecGateType>();
  const [specs, setSpecs] = useState<DocumentSpecPackage[]>([]);
  const [gateTypes, setGateTypes] = useState<DocumentSpecGateType[]>([]);
  const [roles, setRoles] = useState<DocumentRole[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [gateTypeModalOpen, setGateTypeModalOpen] = useState(false);
  const [editingGateTypeId, setEditingGateTypeId] = useState<string | null>(null);
  const [guideExpanded, setGuideExpanded] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<'custom' | 'all'>('custom');
  const [activeListTab, setActiveListTab] = useState<'specs' | 'gateTypes'>('specs');
  const [editingSpec, setEditingSpec] = useState<DocumentSpecPackage | null>(null);

  const load = async () => {
    const [specData, roleData] = await Promise.all([getDocumentSpecs(), getDocumentRoles()]);
    setSpecs(specData.specs);
    setGateTypes(specData.gateTypes);
    setRoles(roleData.roles);
  };
  useEffect(() => { void load().catch(() => message.error(t('common.error'))); }, [message, t]);

  const fileRoleOptions = roles.filter(r => r.type === 'file').map(r => ({ label: r.name, value: r.id }));
  const promptRoleOptions = roles.filter(r => r.type === 'prompt').map(r => ({ label: r.name, value: r.id }));
  const customSpecs = specs;
  const customGateTypes = gateTypes.filter(type => !type.builtIn);
  const visibleSpecs = specs;
  const visibleGateTypes = sourceFilter === 'all' ? gateTypes : customGateTypes;
  const gateTypeSelectOptions = [
    { label: '系统门禁类型', options: gateTypes.filter(type => type.builtIn).map(type => ({ label: type.name, value: type.id })) },
    { label: '我的门禁类型', options: gateTypes.filter(type => !type.builtIn).map(type => ({ label: type.name, value: type.id })) },
  ];
  const [factCount, setFactCount] = useState(0);
  const [chapterCount, setChapterCount] = useState(0);
  const [gateCount, setGateCount] = useState(0);

  /** 刷新事实字段、章节规则和门禁规则的计数 */
  const refreshCounts = () => {
    setFactCount((form.getFieldValue('factFields') ?? []).length);
    setChapterCount((form.getFieldValue('chapterRules') ?? []).length);
    setGateCount((form.getFieldValue('gateRules') ?? []).length);
  };

  const watchedFactFields = Form.useWatch('factFields', form) ?? [];
  const factOptions = watchedFactFields
    .filter((f: { id?: string; name?: string }) => f.id && f.name)
    .map((f: { id: string; name: string }) => ({ label: `${f.name}（${f.id}）`, value: f.id }));

  /** 打开规范包编辑器 */
  const openEditor = (spec?: DocumentSpecPackage) => {
    const value = spec ?? { id: `spec-${Date.now()}`, name: '', description: '', factFields: defaultFactFields(), chapterMode: 'dynamic', chapterRules: [], dynamicChapterRule: { source: 'ai_plan', titleStrategy: 'ai_summary' }, gateRules: [] };
    setEditingSpec(value);
    form.resetFields();
    form.setFieldsValue(value);
    setDrawerOpen(true);
    window.setTimeout(() => refreshCounts(), 50);
  };

  /** 保存规范包 */
  const save = async () => {
    try {
      const values = await form.validateFields();
      const result = await saveDocumentSpec({
        ...(editingSpec ?? {}),
        ...values,
        factFields: values.factFields ?? editingSpec?.factFields ?? [],
        chapterRules: values.chapterRules ?? editingSpec?.chapterRules ?? [],
        dynamicChapterRule: values.dynamicChapterRule ?? editingSpec?.dynamicChapterRule ?? { source: 'ai_plan', titleStrategy: 'ai_summary' },
        gateRules: values.gateRules ?? editingSpec?.gateRules ?? [],
      } as DocumentSpecPackage);
      setSpecs(result.specs);
      setGateTypes(result.gateTypes);
      setDrawerOpen(false);
      message.success(t('common.success'));
    } catch (error) { if (error instanceof Error) message.error(error.message); }
  };

  /** 删除指定规范包 */
  const remove = async (id: string) => {
    const result = await deleteDocumentSpec(id);
    setSpecs(result.specs);
    setGateTypes(result.gateTypes);
  };

  /** 打开门禁类型编辑器，内置类型仅可查看 */
  const openGateTypeEditor = (gateType?: DocumentSpecGateType) => {
    if (gateType?.builtIn) {
      gateTypeForm.setFieldsValue(gateType);
      setEditingGateTypeId(gateType.id);
      setGateTypeModalOpen(true);
      return;
    }
    setEditingGateTypeId(gateType?.id ?? null);
    gateTypeForm.setFieldsValue(gateType ?? { id: `gate-type-${Date.now()}`, name: '', defaultLevel: 'error', evaluator: { subject: 'document', operator: 'contains' } });
    setGateTypeModalOpen(true);
  };

  /** 保存门禁类型 */
  const saveGateType = async () => {
    try {
      const values = await gateTypeForm.validateFields();
      if (gateTypes.find(type => type.id === values.id)?.builtIn) return;
      const result = await saveDocumentGateType(values);
      setGateTypes(result.gateTypes);
      setGateTypeModalOpen(false);
      setEditingGateTypeId(null);
      gateTypeForm.resetFields();
      message.success(t('common.success'));
    } catch (error) { if (error instanceof Error) message.error(error.message); }
  };

  /** 删除指定门禁类型 */
  const removeGateType = async (id: string) => {
    const result = await deleteDocumentGateType(id);
    setGateTypes(result.gateTypes);
  };

  /** 应用门禁类型的默认配置到指定门禁规则 */
  const applyGateType = (index: number, typeId: string) => {
    const gateType = gateTypes.find(item => item.id === typeId);
    if (!gateType) return;
    const gateRules = [...(form.getFieldValue('gateRules') ?? [])];
    gateRules[index] = {
      ...gateRules[index],
      type: gateType.id,
      level: gateRules[index]?.level || gateType.defaultLevel,
      name: gateRules[index]?.name || gateType.name,
      evaluator: { ...gateType.evaluator },
      target: gateRules[index]?.target || gateType.evaluator.target || '',
      value: gateRules[index]?.value || gateType.evaluator.value || '',
    };
    form.setFieldValue('gateRules', gateRules);
  };

  return <div className="space-y-5 animateFadeIn">
    {/* 页面头部 */}
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
      <div><h1 className="pageTitle">{t('specs.title')}</h1><p className="pageDesc">{t('specs.description')}</p></div>
      <Space wrap>
        <Select value={sourceFilter} onChange={setSourceFilter} style={{ width: 160 }} options={[
          { label: `我的 (${customSpecs.length + customGateTypes.length})`, value: 'custom' },
          { label: `全部来源 (${specs.length + gateTypes.length})`, value: 'all' },
        ]} />
        {activeListTab === 'gateTypes' && <Button onClick={() => openGateTypeEditor()}>新建门禁类型</Button>}
        {activeListTab === 'specs' && <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>{t('specs.newSpec')}</Button>}
      </Space>
    </div>

    {/* 可展开的使用说明 */}
    <Alert type="info" showIcon
      message={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{t('specs.plainGuideTitle')}</span>
          <Button type="link" size="small" icon={guideExpanded ? <UpOutlined /> : <DownOutlined />}
            onClick={() => setGuideExpanded(!guideExpanded)} style={{ padding: '0 4px' }}>
            {guideExpanded ? '收起说明' : '展开说明'}
          </Button>
        </div>
      }
      description={guideExpanded ? t('specs.plainGuideDesc') : undefined}
    />

    <Card size="small">
      <Tabs activeKey={activeListTab} onChange={(key) => setActiveListTab(key as 'specs' | 'gateTypes')} items={[
        {
          key: 'specs', label: `规范包列表 (${visibleSpecs.length})`, children: visibleSpecs.length === 0 ? <Empty description={t('common.noData')} /> : (
            <List dataSource={visibleSpecs} renderItem={(spec, index) => (
              <List.Item style={{ padding: '10px 0' }} actions={[
                <Button key="edit" size="small" icon={<EditOutlined />} onClick={() => openEditor(spec)}>编辑</Button>,
                <Popconfirm key="del" title={t('common.confirm')} onConfirm={() => { void remove(spec.id); }}><Button size="small" danger icon={<DeleteOutlined />} /></Popconfirm>,
              ]}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0, flex: 1 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--colorFillSecondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--colorTextSecondary)', flexShrink: 0 }}>{index + 1}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{spec.name}</span>
                      <Tag color="cyan" style={{ margin: 0, fontSize: 10, lineHeight: '16px', flexShrink: 0 }}>我的规范包</Tag>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {spec.description && <span style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>{spec.description}</span>}
                      <Space size={4}><Tag color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>事实 {spec.factFields.length}</Tag><Tag color="purple" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>{spec.chapterMode === 'dynamic' ? '动态章节' : `章节 ${spec.chapterRules.length}`}</Tag><Tag color="orange" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>门禁 {spec.gateRules.length}</Tag></Space>
                    </div>
                  </div>
                </div>
              </List.Item>
            )} />
          ),
        },
        {
          key: 'gateTypes', label: `门禁类型列表 (${visibleGateTypes.length})`, children: visibleGateTypes.length === 0 ? <Empty description={t('common.noData')} /> : (
            <List dataSource={visibleGateTypes} renderItem={(type, index) => (
              <List.Item style={{ padding: '10px 0' }} actions={[
                <Button key="edit" size="small" icon={<EditOutlined />} onClick={() => openGateTypeEditor(type)}>{type.builtIn ? '查看' : '编辑'}</Button>,
                <Popconfirm key="del" title={t('common.confirm')} disabled={type.builtIn} onConfirm={() => { void removeGateType(type.id); }}><Button size="small" danger icon={<DeleteOutlined />} disabled={type.builtIn} /></Popconfirm>,
              ]}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0, flex: 1 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--colorFillSecondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--colorTextSecondary)', flexShrink: 0 }}>{index + 1}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <span style={{ fontWeight: 600 }}>{type.name}</span>
                      {type.builtIn ? <Tag color="gold" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>系统门禁</Tag> : <Tag color="cyan" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>我的门禁</Tag>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {type.description && <span style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>{type.description}</span>}
                      <Space size={4}><Tag color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>{subjectOptions.find(item => item.value === type.evaluator.subject)?.label}</Tag><Tag color="purple" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>{operatorOptions.find(item => item.value === type.evaluator.operator)?.label}</Tag></Space>
                    </div>
                  </div>
                </div>
              </List.Item>
            )} />
          ),
        },
      ]} />
    </Card>

    {/* 抽屉：规范包编辑器 */}
    <Drawer
      title={t('specs.editor')}
      open={drawerOpen}
      onClose={() => setDrawerOpen(false)}
      width={800} maskClosable={false}
      style={{ borderRadius: '12px 0 0 12px' }}
      styles={{ body: { padding: '16px 24px' }, header: { borderRadius: '12px 0 0 0', borderBottom: '1px solid var(--colorBorderSecondary)' } }}
      extra={<Button type="primary" onClick={() => { void save(); }}>{t('common.save')}</Button>}
    >
      <Form form={form} layout="vertical" onValuesChange={() => refreshCounts()}>
        <Row gutter={12}>
          <Form.Item name="id" hidden><Input /></Form.Item>
          <Col xs={24} md={12}><Form.Item name="name" label={t('specs.name')} rules={[{ required: true }]}><Input /></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item name="description" label={t('specs.specDescription')}><Input /></Form.Item></Col>
        </Row>

        <Tabs destroyInactiveTabPane={false} items={[
          {
            key: 'facts', label: `${t('specs.facts')} (${factCount})`,
            children: <Form.List name="factFields">{(fields, { add, remove }) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {fields.map((field, idx) => (
                  <Card key={field.key} size="small" style={{ border: '1px solid var(--colorBorderSecondary)', position: 'relative' }}>
                    <Button danger size="small" icon={<DeleteOutlined />} onClick={() => remove(field.name)} style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }} />
                    <Form.Item name={[field.name, 'id']} hidden><Input /></Form.Item>
                    <Row gutter={[14, 8]}>
                      <Form.Item name={[field.name, 'type']} initialValue="auto" hidden><Input /></Form.Item>
                      <Col xs={24} sm={8}><Form.Item name={[field.name, 'name']} label={t('specs.factName')} rules={[{ required: true }]} style={{ marginBottom: 0 }}><Input size="small" /></Form.Item></Col>
                      <Col xs={12} sm={4}><Form.Item name={[field.name, 'required']} label={t('specs.required')} valuePropName="checked" style={{ marginBottom: 0 }}><Switch /></Form.Item></Col>
                      <Col xs={24} sm={12}><Form.Item name={[field.name, 'sourceRoleIds']} label={t('specs.sourceRoles')} style={{ marginBottom: 0 }}><Select mode="multiple" showSearch options={fileRoleOptions} tagRender={niceTagRender} placeholder="选择文件角色" size="small" /></Form.Item></Col>
                      <Col xs={24} sm={12}><Form.Item name={[field.name, 'extractionHint']} label={t('specs.extractionHint')} style={{ marginBottom: 0 }}><Input size="small" /></Form.Item></Col>
                      <Col xs={24} sm={12}><Form.Item name={[field.name, 'validationHint']} label={t('specs.validationHint')} style={{ marginBottom: 0 }}><Input size="small" /></Form.Item></Col>
                    </Row>
                  </Card>
                ))}
                <Button icon={<PlusOutlined />} onClick={() => add({ id: `fact-${Date.now()}`, type: 'auto', required: true })}>{t('specs.addFact')}</Button>
              </div>
            )}</Form.List>
          },
          {
            key: 'chapters', label: `${t('specs.chapters')} (${chapterCount})`,
            children: <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Form.Item name="chapterMode" label="章节生成方式" initialValue="dynamic">
                <Select options={chapterModeOptions} />
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(prev, next) => prev.chapterMode !== next.chapterMode}>
                {({ getFieldValue }) => getFieldValue('chapterMode') === 'fixed' ? <Form.List name="chapterRules">{(fields, { add, remove }) => (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <Alert type="info" showIcon message="固定章节模式" description="适合合同、标准报告等已明确章节数量和标题的文档。" />
                    {fields.map((field, idx) => (
                      <Card key={field.key} size="small" style={{ border: '1px solid var(--colorBorderSecondary)', position: 'relative' }}>
                        <Button danger size="small" icon={<DeleteOutlined />} onClick={() => remove(field.name)} style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }} />
                        <Form.Item name={[field.name, 'id']} hidden><Input /></Form.Item>
                        <Row gutter={[14, 8]}>
                          <Col xs={24} sm={7}><Form.Item name={[field.name, 'title']} label={t('specs.chapterTitle')} rules={[{ required: true }]} style={{ marginBottom: 0 }}><Input size="small" /></Form.Item></Col>
                          <Col xs={8} sm={3}><Form.Item name={[field.name, 'order']} label={t('specs.order')} initialValue={idx} style={{ marginBottom: 0 }}><InputNumber size="small" style={{ width: '100%' }} /></Form.Item></Col>
                          <Col xs={8} sm={3}><Form.Item name={[field.name, 'minWords']} label={t('specs.minWords')} style={{ marginBottom: 0 }}><InputNumber size="small" style={{ width: '100%' }} /></Form.Item></Col>
                          <Col xs={8} sm={3}><Form.Item name={[field.name, 'required']} label={t('specs.required')} valuePropName="checked" style={{ marginBottom: 0 }}><Switch /></Form.Item></Col>
                          <Col xs={24} sm={8}><Form.Item name={[field.name, 'requiredFactIds']} label={t('specs.requiredFacts')} style={{ marginBottom: 0 }}><Select mode="multiple" showSearch optionFilterProp="label" placeholder="选择事实字段" options={factOptions} tagRender={niceTagRender} size="small" /></Form.Item></Col>
                          <Col xs={24} sm={12}><Form.Item name={[field.name, 'requiredFileRoleIds']} label={t('specs.requiredFileRoles')} style={{ marginBottom: 0 }}><Select mode="multiple" showSearch options={fileRoleOptions} tagRender={niceTagRender} placeholder="选择文件角色" size="small" /></Form.Item></Col>
                          <Col xs={24} sm={12}><Form.Item name={[field.name, 'requiredPromptRoleIds']} label={t('specs.requiredPromptRoles')} style={{ marginBottom: 0 }}><Select mode="multiple" showSearch options={promptRoleOptions} tagRender={niceTagRender} placeholder="选择提示词角色" size="small" /></Form.Item></Col>
                          <Col xs={24}><Form.Item name={[field.name, 'generationHint']} label={t('specs.generationHint')} style={{ marginBottom: 0 }}><Input size="small" /></Form.Item></Col>
                        </Row>
                      </Card>
                    ))}
                    <Button icon={<PlusOutlined />} onClick={() => add({ id: `chapter-${Date.now()}`, order: fields.length, required: true })}>{t('specs.addChapter')}</Button>
                  </div>
                )}</Form.List> : <Card size="small" title="动态章节规则" style={{ border: '1px solid var(--colorBorderSecondary)' }}>
                  <Alert type="info" showIcon style={{ marginBottom: 12 }} message="动态章节模式" description="适合从资料目录、文件角色、表格行或 AI 规划中动态决定章节数量和标题。" />
                  <Row gutter={[14, 8]}>
                    <Col xs={24} sm={12}><Form.Item name={["dynamicChapterRule", "source"]} label="章节来源" initialValue="ai_plan"><Select options={dynamicChapterSourceOptions} /></Form.Item></Col>
                    <Col xs={24} sm={12}><Form.Item name={["dynamicChapterRule", "sourceRoleIds"]} label="来源文件角色"><Select mode="multiple" showSearch options={fileRoleOptions} tagRender={niceTagRender} placeholder="可选，限定从哪些文件角色规划章节" /></Form.Item></Col>
                    <Col xs={12} sm={6}><Form.Item name={["dynamicChapterRule", "minChapters"]} label="最少章节"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
                    <Col xs={12} sm={6}><Form.Item name={["dynamicChapterRule", "maxChapters"]} label="最多章节"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
                    <Col xs={12} sm={6}><Form.Item name={["dynamicChapterRule", "minWordsPerChapter"]} label="每章最低字数"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
                    <Col xs={12} sm={6}><Form.Item name={["dynamicChapterRule", "titleStrategy"]} label="标题方式" initialValue="ai_summary"><Select options={titleStrategyOptions} /></Form.Item></Col>
                    <Col xs={24} sm={12}><Form.Item name={["dynamicChapterRule", "requiredFactIds"]} label="每章优先使用事实"><Select mode="multiple" showSearch optionFilterProp="label" options={factOptions} tagRender={niceTagRender} placeholder="可选" /></Form.Item></Col>
                    <Col xs={24} sm={12}><Form.Item name={["dynamicChapterRule", "requiredPromptRoleIds"]} label="每章提示词角色"><Select mode="multiple" showSearch options={promptRoleOptions} tagRender={niceTagRender} placeholder="可选" /></Form.Item></Col>
                    <Col xs={24} sm={12}><Form.Item name={["dynamicChapterRule", "titleTemplate"]} label="标题模板"><Input placeholder="例如：第{{index}}章 {{sourceTitle}}" /></Form.Item></Col>
                    <Col xs={24} sm={12}><Form.Item name={["dynamicChapterRule", "requiredFileRoleIds"]} label="每章必须参考文件角色"><Select mode="multiple" showSearch options={fileRoleOptions} tagRender={niceTagRender} placeholder="可选" /></Form.Item></Col>
                    <Col xs={24}><Form.Item name={["dynamicChapterRule", "generationHint"]} label="动态章节生成说明"><Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} placeholder="例如：请按招标文件目录生成章节，保留原始编号和标题层级。" /></Form.Item></Col>
                  </Row>
                </Card>}
              </Form.Item>
            </div>
          },
          {
            key: 'gates', label: `${t('specs.gates')} (${gateCount})`,
            children: <Form.List name="gateRules">{(fields, { add, remove }) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {fields.map((field, idx) => (
                  <Card key={field.key} size="small" style={{ border: '1px solid var(--colorBorderSecondary)', position: 'relative' }}>
                    <Button danger size="small" icon={<DeleteOutlined />} onClick={() => remove(field.name)} style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }} />
                    <Form.Item name={[field.name, 'id']} hidden><Input /></Form.Item>
                    <Row gutter={[12, 8]} align="middle">
                      <Col xs={24} sm={6}><Form.Item name={[field.name, 'name']} label="名称" rules={[{ required: true }]} style={{ marginBottom: 0 }}><Input placeholder={t('specs.gateName')} size="small" /></Form.Item></Col>
                      <Col xs={12} sm={6}><Form.Item name={[field.name, 'type']} label="类型" rules={[{ required: true }]} style={{ marginBottom: 0 }}><Select options={gateTypeSelectOptions} size="small" onChange={(value) => applyGateType(idx, value)} /></Form.Item></Col>
                      <Col xs={12} sm={3}><Form.Item name={[field.name, 'level']} label="级别" style={{ marginBottom: 0 }}><Select options={levelOptions} size="small" /></Form.Item></Col>
                      <Col xs={12} sm={4}><Form.Item name={[field.name, 'target']} label="目标" style={{ marginBottom: 0 }}><Input placeholder="章节/事实/角色" size="small" /></Form.Item></Col>
                      <Col xs={12} sm={5}><Form.Item name={[field.name, 'value']} label="值" style={{ marginBottom: 0 }}><Input placeholder="关键词/正则/数值" size="small" /></Form.Item></Col>
                      <Col xs={12} sm={5}><Form.Item name={[field.name, 'evaluator', 'subject']} label="校验对象" rules={[{ required: true }]} style={{ marginBottom: 0 }}><Select options={subjectOptions} size="small" /></Form.Item></Col>
                      <Col xs={12} sm={6}><Form.Item name={[field.name, 'evaluator', 'operator']} label="校验方式" rules={[{ required: true }]} style={{ marginBottom: 0 }}><Select options={operatorOptions} size="small" /></Form.Item></Col>
                      <Col xs={12} sm={5}><Form.Item name={[field.name, 'evaluator', 'target']} label="执行目标" style={{ marginBottom: 0 }}><Input placeholder="默认取目标" size="small" /></Form.Item></Col>
                      <Col xs={12} sm={5}><Form.Item name={[field.name, 'evaluator', 'value']} label="执行值" style={{ marginBottom: 0 }}><Input placeholder="默认取值" size="small" /></Form.Item></Col>
                      <Col xs={12} sm={3}><Form.Item name={[field.name, 'evaluator', 'min']} label="N" style={{ marginBottom: 0 }}><InputNumber min={1} size="small" style={{ width: '100%' }} /></Form.Item></Col>
                    </Row>
                  </Card>
                ))}
                <Button icon={<PlusOutlined />} onClick={() => add({ id: `gate-${Date.now()}`, type: 'required_fact', level: 'error', evaluator: { subject: 'fact', operator: 'exists' } })}>{t('specs.addGate')}</Button>
              </div>
            )}</Form.List>
          },
        ]} />
      </Form>
    </Drawer>

    <Modal
      title={gateTypes.find(type => type.id === editingGateTypeId)?.builtIn ? '查看系统门禁类型' : editingGateTypeId ? '编辑门禁类型' : '新建门禁类型'}
      open={gateTypeModalOpen}
      onOk={() => { void saveGateType(); }}
      onCancel={() => { setGateTypeModalOpen(false); setEditingGateTypeId(null); }}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: Boolean(gateTypes.find(type => type.id === editingGateTypeId)?.builtIn) }}
    >
      <Form form={gateTypeForm} layout="vertical" disabled={Boolean(gateTypes.find(type => type.id === editingGateTypeId)?.builtIn)}>
        <Row gutter={12}>
          <Form.Item name="id" hidden><Input /></Form.Item>
          <Col span={12}><Form.Item name="name" label="类型名称" rules={[{ required: true }]}><Input placeholder="必须包含风险提示" /></Form.Item></Col>
          <Col span={12}><Form.Item name="description" label="说明"><Input placeholder="告诉用户这类门禁检查什么" /></Form.Item></Col>
          <Col span={12}><Form.Item name="defaultLevel" label="默认级别" rules={[{ required: true }]}><Select options={levelOptions} /></Form.Item></Col>
          <Col span={12}><Form.Item name={["evaluator", "subject"]} label="校验对象" rules={[{ required: true }]}><Select options={subjectOptions} /></Form.Item></Col>
          <Col span={12}><Form.Item name={["evaluator", "operator"]} label="校验方式" rules={[{ required: true }]}><Select options={operatorOptions} /></Form.Item></Col>
          <Col span={12}><Form.Item name={["evaluator", "target"]} label="默认目标"><Input placeholder="章节/事实/角色，可为空" /></Form.Item></Col>
          <Col span={12}><Form.Item name={["evaluator", "value"]} label="默认值"><Input placeholder="关键词/正则，可为空" /></Form.Item></Col>
          <Col span={12}><Form.Item name={["evaluator", "min"]} label="默认 N"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
        </Row>
      </Form>

    </Modal>
  </div>;
}
