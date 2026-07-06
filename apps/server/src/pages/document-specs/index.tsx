import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Col, Drawer, Empty, Form, Input, InputNumber, List, Popconfirm, Row, Select, Space, Switch, Tabs, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, DownOutlined, UpOutlined } from '@ant-design/icons';
import { deleteDocumentSpec, getDocumentRoles, getDocumentSpecs, saveDocumentSpec, type DocumentRole, type DocumentSpecPackage } from '@/lib/api';
import { useAppTranslations } from '@/components/Layout';

const fieldTypeOptions = [
  { label: '文本', value: 'text' }, { label: '数字', value: 'number' }, { label: '日期', value: 'date' },
  { label: '表格', value: 'table' }, { label: '列表', value: 'list' },
];
const gateTypeOptions = [
  { label: '必需事实', value: 'required_fact' }, { label: '必需章节', value: 'required_chapter' },
  { label: '必需文件角色', value: 'required_file_role' }, { label: '必需提示词角色', value: 'required_prompt_role' },
  { label: '事实必须有来源', value: 'source_required' }, { label: '禁止出现文本', value: 'forbidden_text' },
  { label: '章节最低字数', value: 'min_chapter_length' }, { label: '必须有表格', value: 'table_required' },
];
const levelOptions = [
  { label: '错误（阻断）', value: 'error' }, { label: '警告（提醒）', value: 'warning' }, { label: '信息（提示）', value: 'info' },
];

const niceTagRender = (props: { label: React.ReactNode; value: string; closable: boolean; onClose: () => void }) => {
  const { label, closable, onClose } = props;
  return (
    <Tag closable={closable} onClose={onClose} color="blue" style={{ margin: '1px 2px', fontSize: 11, lineHeight: '18px' }}>
      {label}
    </Tag>
  );
};

function defaultFactFields(): DocumentSpecPackage['factFields'] {
  return [
    { id: 'document-goal', name: '文档目标', type: 'text', required: true },
    { id: 'target-audience', name: '目标读者', type: 'text', required: false },
    { id: 'key-conclusion', name: '关键结论', type: 'list', required: true },
  ];
}

export default function DocumentSpecsPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [form] = Form.useForm<DocumentSpecPackage>();
  const [specs, setSpecs] = useState<DocumentSpecPackage[]>([]);
  const [roles, setRoles] = useState<DocumentRole[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [guideExpanded, setGuideExpanded] = useState(false);

  const load = async () => {
    const [specData, roleData] = await Promise.all([getDocumentSpecs(), getDocumentRoles()]);
    setSpecs(specData.specs);
    setRoles(roleData.roles);
  };
  useEffect(() => { void load().catch(() => message.error(t('common.error'))); }, [message, t]);

  const fileRoleOptions = roles.filter(r => r.type === 'file').map(r => ({ label: r.name, value: r.id }));
  const promptRoleOptions = roles.filter(r => r.type === 'prompt').map(r => ({ label: r.name, value: r.id }));
  const [factCount, setFactCount] = useState(0);
  const [chapterCount, setChapterCount] = useState(0);
  const [gateCount, setGateCount] = useState(0);

  const refreshCounts = () => {
    setFactCount((form.getFieldValue('factFields') ?? []).length);
    setChapterCount((form.getFieldValue('chapterRules') ?? []).length);
    setGateCount((form.getFieldValue('gateRules') ?? []).length);
  };

  const watchedFactFields = Form.useWatch('factFields', form) ?? [];
  const factOptions = watchedFactFields
    .filter((f: { id?: string; name?: string }) => f.id && f.name)
    .map((f: { id: string; name: string }) => ({ label: `${f.name}（${f.id}）`, value: f.id }));

  const openEditor = (spec?: DocumentSpecPackage) => {
    form.setFieldsValue(spec ?? { id: `spec-${Date.now()}`, name: '', description: '', factFields: defaultFactFields(), chapterRules: [], gateRules: [] });
    setDrawerOpen(true);
    window.setTimeout(() => refreshCounts(), 50);
  };

  const save = async () => {
    try {
      const values = await form.validateFields();
      const result = await saveDocumentSpec(values);
      setSpecs(result.specs);
      setDrawerOpen(false);
      message.success(t('common.success'));
    } catch (error) { if (error instanceof Error) message.error(error.message); }
  };

  const remove = async (id: string) => {
    const result = await deleteDocumentSpec(id);
    setSpecs(result.specs);
  };

  return <div className="space-y-5 animateFadeIn">
    {/* Header */}
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
      <div><h1 className="pageTitle">{t('specs.title')}</h1><p className="pageDesc">{t('specs.description')}</p></div>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>{t('specs.newSpec')}</Button>
    </div>

    {/* Expandable guide */}
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

    {/* Spec list */}
    <Card size="small" title={`${t('specs.list')} (${specs.length})`}>
      {specs.length === 0 ? <Empty description={t('common.noData')} /> : (
        <List dataSource={specs} renderItem={(spec, index) => (
          <List.Item style={{ padding: '10px 0' }}
            actions={[
              <Button key="edit" size="small" icon={<EditOutlined />} onClick={() => openEditor(spec)}>编辑</Button>,
              <Popconfirm key="del" title={t('common.confirm')} disabled={spec.builtIn} onConfirm={() => { void remove(spec.id); }}>
                <Button size="small" danger icon={<DeleteOutlined />} disabled={spec.builtIn} />
              </Popconfirm>,
            ]}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0, flex: 1 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--colorFillSecondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--colorTextSecondary)', flexShrink: 0 }}>
                {index + 1}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{spec.name}</span>
                  {spec.builtIn && <Tag color="gold" style={{ margin: 0, fontSize: 10, lineHeight: '16px', flexShrink: 0 }}>内置</Tag>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {spec.description && <span style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>{spec.description}</span>}
                  <Space size={4}>
                    <Tag color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>事实 {spec.factFields.length}</Tag>
                    <Tag color="purple" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>章节 {spec.chapterRules.length}</Tag>
                    <Tag color="orange" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>门禁 {spec.gateRules.length}</Tag>
                  </Space>
                </div>
              </div>
            </div>
          </List.Item>
        )} />
      )}
    </Card>

    {/* Drawer: Spec Editor */}
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
                      <Col xs={24} sm={7}><Form.Item name={[field.name, 'name']} label={t('specs.factName')} rules={[{ required: true }]} style={{ marginBottom: 0 }}><Input size="small" /></Form.Item></Col>
                      <Col xs={12} sm={5}><Form.Item name={[field.name, 'type']} label={t('specs.factType')} style={{ marginBottom: 0 }}><Select options={fieldTypeOptions} size="small" /></Form.Item></Col>
                      <Col xs={12} sm={4}><Form.Item name={[field.name, 'required']} label={t('specs.required')} valuePropName="checked" style={{ marginBottom: 0 }}><Switch /></Form.Item></Col>
                      <Col xs={24} sm={8}><Form.Item name={[field.name, 'sourceRoleIds']} label={t('specs.sourceRoles')} style={{ marginBottom: 0 }}><Select mode="multiple" showSearch options={fileRoleOptions} tagRender={niceTagRender} placeholder="选择文件角色" size="small" /></Form.Item></Col>
                      <Col xs={24} sm={12}><Form.Item name={[field.name, 'extractionHint']} label={t('specs.extractionHint')} style={{ marginBottom: 0 }}><Input size="small" /></Form.Item></Col>
                      <Col xs={24} sm={12}><Form.Item name={[field.name, 'validationHint']} label={t('specs.validationHint')} style={{ marginBottom: 0 }}><Input size="small" /></Form.Item></Col>
                    </Row>
                  </Card>
                ))}
                <Button icon={<PlusOutlined />} onClick={() => add({ id: `fact-${Date.now()}`, type: 'text', required: true })}>{t('specs.addFact')}</Button>
              </div>
            )}</Form.List>
          },
          {
            key: 'chapters', label: `${t('specs.chapters')} (${chapterCount})`,
            children: <Form.List name="chapterRules">{(fields, { add, remove }) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
            )}</Form.List>
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
                      <Col xs={12} sm={6}><Form.Item name={[field.name, 'type']} label="类型" style={{ marginBottom: 0 }}><Select options={gateTypeOptions} size="small" /></Form.Item></Col>
                      <Col xs={12} sm={3}><Form.Item name={[field.name, 'level']} label="级别" style={{ marginBottom: 0 }}><Select options={levelOptions} size="small" /></Form.Item></Col>
                      <Col xs={12} sm={4}><Form.Item name={[field.name, 'target']} label="目标" style={{ marginBottom: 0 }}><Input placeholder="target" size="small" /></Form.Item></Col>
                      <Col xs={12} sm={5}><Form.Item name={[field.name, 'value']} label="值" style={{ marginBottom: 0 }}><Input placeholder="value" size="small" /></Form.Item></Col>
                    </Row>
                  </Card>
                ))}
                <Button icon={<PlusOutlined />} onClick={() => add({ id: `gate-${Date.now()}`, type: 'required_fact', level: 'error' })}>{t('specs.addGate')}</Button>
              </div>
            )}</Form.List>
          },
        ]} />
      </Form>
    </Drawer>
  </div>;
}
