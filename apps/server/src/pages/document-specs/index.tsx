import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Col, Empty, Form, Input, InputNumber, List, Modal, Popconfirm, Row, Select, Space, Switch, Tabs, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { deleteDocumentSpec, getDocumentRoles, getDocumentSpecs, saveDocumentSpec, type DocumentRole, type DocumentSpecPackage } from '@/lib/api';
import { useAppTranslations } from '@/components/Layout';

const fieldTypeOptions = [
  { label: '文本', value: 'text' },
  { label: '数字', value: 'number' },
  { label: '日期', value: 'date' },
  { label: '表格', value: 'table' },
  { label: '列表', value: 'list' },
];
const gateTypeOptions = [
  { label: '必需事实', value: 'required_fact' },
  { label: '必需章节', value: 'required_chapter' },
  { label: '必需文件角色', value: 'required_file_role' },
  { label: '必需提示词角色', value: 'required_prompt_role' },
  { label: '事实必须有来源', value: 'source_required' },
  { label: '禁止出现文本', value: 'forbidden_text' },
  { label: '章节最低字数', value: 'min_chapter_length' },
  { label: '必须有表格', value: 'table_required' },
];
const levelOptions = [
  { label: '错误（阻断）', value: 'error' },
  { label: '警告（提醒）', value: 'warning' },
  { label: '信息（提示）', value: 'info' },
];

export default function DocumentSpecsPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [form] = Form.useForm<DocumentSpecPackage>();
  const [specs, setSpecs] = useState<DocumentSpecPackage[]>([]);
  const [roles, setRoles] = useState<DocumentRole[]>([]);
  const [open, setOpen] = useState(false);

  const load = async () => {
    const [specData, roleData] = await Promise.all([getDocumentSpecs(), getDocumentRoles()]);
    setSpecs(specData.specs);
    setRoles(roleData.roles);
  };

  useEffect(() => { void load().catch(() => message.error(t('common.error'))); }, [message, t]);

  const fileRoleOptions = roles.filter(role => role.type === 'file').map(role => ({ label: role.name, value: role.id }));
  const promptRoleOptions = roles.filter(role => role.type === 'prompt').map(role => ({ label: role.name, value: role.id }));
  const factOptions = Form.useWatch('factFields', form)?.map((field: { id?: string; name?: string }) => ({ label: field.name || field.id, value: field.id })) ?? [];

  const openEditor = (spec?: DocumentSpecPackage) => {
    form.setFieldsValue(spec ?? { id: `spec-${Date.now()}`, name: '', description: '', factFields: [], chapterRules: [], gateRules: [] });
    setOpen(true);
  };

  const save = async () => {
    try {
      const values = await form.validateFields();
      const result = await saveDocumentSpec(values);
      setSpecs(result.specs);
      setOpen(false);
      message.success(t('common.success'));
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    }
  };

  const remove = async (id: string) => {
    const result = await deleteDocumentSpec(id);
    setSpecs(result.specs);
  };

  return <div className="space-y-6 animateFadeIn">
    <Card className="cardGlass" styles={{ body: { padding: 24 } }}>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div><h1 className="pageTitle mb-1">{t('specs.title')}</h1><p className="pageDesc mb-0">{t('specs.description')}</p></div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>{t('specs.newSpec')}</Button>
      </div>
    </Card>

    <Alert type="info" showIcon message={t('specs.plainGuideTitle')} description={t('specs.plainGuideDesc')} />

    <Card title={t('specs.list')}>
      <List
        dataSource={specs}
        locale={{ emptyText: <Empty description={t('common.noData')} /> }}
        renderItem={spec => <List.Item actions={[<Button key="edit" type="text" icon={<EditOutlined />} onClick={() => openEditor(spec)} />, <Popconfirm key="delete" title={t('common.confirm')} disabled={spec.builtIn} onConfirm={() => { void remove(spec.id); }}><Button type="text" danger icon={<DeleteOutlined />} disabled={spec.builtIn} /></Popconfirm>]}>
          <List.Item.Meta title={<Space><span>{spec.name}</span>{spec.builtIn && <Tag color="gold">{t('documents.builtIn')}</Tag>}<Tag>{spec.id}</Tag></Space>} description={`${spec.description || '-'} · ${t('specs.facts')}: ${spec.factFields.length} · ${t('specs.chapters')}: ${spec.chapterRules.length} · ${t('specs.gates')}: ${spec.gateRules.length}`} />
        </List.Item>}
      />
    </Card>

    <Modal maskClosable={false} title={t('specs.editor')} open={open} onOk={() => { void save(); }} onCancel={() => setOpen(false)} width={980} centered okText={t('common.save')}>
      <Form form={form} layout="vertical">
        <Row gutter={12}><Col span={8}><Form.Item name="id" label="ID" rules={[{ required: true }]}><Input disabled /></Form.Item></Col><Col span={8}><Form.Item name="name" label={t('specs.name')} rules={[{ required: true }]}><Input /></Form.Item></Col><Col span={8}><Form.Item name="wordTemplatePath" label={t('specs.wordTemplatePath')}><Input placeholder="/path/to/template.docx" /></Form.Item></Col></Row>
        <Form.Item name="description" label={t('specs.specDescription')}><Input /></Form.Item>
        <Tabs items={[
          { key: 'facts', label: t('specs.facts'), children: <Form.List name="factFields">{(fields, { add, remove }) => <Space direction="vertical" className="w-full">{fields.map(field => <Card size="small" key={field.key}><Row gutter={8}><Col span={5}><Form.Item name={[field.name, 'id']} label="ID" initialValue={`fact-${Date.now()}`}><Input disabled /></Form.Item></Col><Col span={5}><Form.Item name={[field.name, 'name']} label={t('specs.factName')} rules={[{ required: true }]}><Input /></Form.Item></Col><Col span={4}><Form.Item name={[field.name, 'type']} label={t('specs.factType')} initialValue="text"><Select options={fieldTypeOptions} /></Form.Item></Col><Col span={4}><Form.Item name={[field.name, 'required']} label={t('specs.required')} valuePropName="checked"><Switch /></Form.Item></Col><Col span={5}><Form.Item name={[field.name, 'sourceRoleIds']} label={t('specs.sourceRoles')}><Select mode="multiple" options={fileRoleOptions} /></Form.Item></Col><Col span={1}><Button danger onClick={() => remove(field.name)}>-</Button></Col></Row><Form.Item name={[field.name, 'extractionHint']} label={t('specs.extractionHint')}><Input /></Form.Item><Form.Item name={[field.name, 'validationHint']} label={t('specs.validationHint')}><Input /></Form.Item></Card>)}<Button onClick={() => add({ id: `fact-${Date.now()}`, type: 'text', required: true })}>{t('specs.addFact')}</Button></Space>}</Form.List> },
          { key: 'chapters', label: t('specs.chapters'), children: <Form.List name="chapterRules">{(fields, { add, remove }) => <Space direction="vertical" className="w-full">{fields.map((field, index) => <Card size="small" key={field.key}><Row gutter={8}><Col span={4}><Form.Item name={[field.name, 'id']} label="ID" initialValue={`chapter-${Date.now()}`}><Input disabled /></Form.Item></Col><Col span={5}><Form.Item name={[field.name, 'title']} label={t('specs.chapterTitle')} rules={[{ required: true }]}><Input /></Form.Item></Col><Col span={3}><Form.Item name={[field.name, 'order']} label={t('specs.order')} initialValue={index}><InputNumber className="w-full" /></Form.Item></Col><Col span={3}><Form.Item name={[field.name, 'minWords']} label={t('specs.minWords')}><InputNumber className="w-full" /></Form.Item></Col><Col span={3}><Form.Item name={[field.name, 'required']} label={t('specs.required')} valuePropName="checked"><Switch /></Form.Item></Col><Col span={5}><Form.Item name={[field.name, 'requiredFactIds']} label={t('specs.requiredFacts')}><Select mode="multiple" options={factOptions} /></Form.Item></Col><Col span={1}><Button danger onClick={() => remove(field.name)}>-</Button></Col></Row><Row gutter={8}><Col span={12}><Form.Item name={[field.name, 'requiredFileRoleIds']} label={t('specs.requiredFileRoles')}><Select mode="multiple" options={fileRoleOptions} /></Form.Item></Col><Col span={12}><Form.Item name={[field.name, 'requiredPromptRoleIds']} label={t('specs.requiredPromptRoles')}><Select mode="multiple" options={promptRoleOptions} /></Form.Item></Col></Row><Form.Item name={[field.name, 'generationHint']} label={t('specs.generationHint')}><Input /></Form.Item></Card>)}<Button onClick={() => add({ id: `chapter-${Date.now()}`, order: fields.length, required: true })}>{t('specs.addChapter')}</Button></Space>}</Form.List> },
          { key: 'gates', label: t('specs.gates'), children: <Form.List name="gateRules">{(fields, { add, remove }) => <Space direction="vertical" className="w-full">{fields.map(field => <Row key={field.key} gutter={8}><Col span={4}><Form.Item name={[field.name, 'id']} initialValue={`gate-${Date.now()}`}><Input disabled /></Form.Item></Col><Col span={5}><Form.Item name={[field.name, 'name']} rules={[{ required: true }]}><Input placeholder={t('specs.gateName')} /></Form.Item></Col><Col span={5}><Form.Item name={[field.name, 'type']} initialValue="required_fact"><Select options={gateTypeOptions} /></Form.Item></Col><Col span={4}><Form.Item name={[field.name, 'level']} initialValue="error"><Select options={levelOptions} /></Form.Item></Col><Col span={3}><Form.Item name={[field.name, 'target']}><Input placeholder="target" /></Form.Item></Col><Col span={2}><Form.Item name={[field.name, 'value']}><Input placeholder="value" /></Form.Item></Col><Col span={1}><Button danger onClick={() => remove(field.name)}>-</Button></Col></Row>)}<Button onClick={() => add({ id: `gate-${Date.now()}`, type: 'required_fact', level: 'error' })}>{t('specs.addGate')}</Button></Space>}</Form.List> },
        ]} />
      </Form>
    </Modal>
  </div>;
}
