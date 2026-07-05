import { useEffect, useState } from 'react';
import { App, Button, Card, Col, Empty, Form, Input, List, Modal, Popconfirm, Row, Select, Space, Tabs, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { deleteDocumentRole, deleteProjectRoleConfig, getDocumentRoles, getKbFiles, getPromptProjects, saveDocumentRole, saveProjectRoleConfig, type DocumentRole, type ProjectRoleConfig, type KbFileItem, type PromptProject } from '@/lib/api';
import { useAppTranslations } from '@/components/Layout';

export default function DocumentRolesPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [roleForm] = Form.useForm<DocumentRole>();
  const [configForm] = Form.useForm<ProjectRoleConfig>();
  const [roles, setRoles] = useState<DocumentRole[]>([]);
  const [configs, setConfigs] = useState<ProjectRoleConfig[]>([]);
  const [kbFiles, setKbFiles] = useState<KbFileItem[]>([]);
  const [prompts, setPrompts] = useState<PromptProject[]>([]);
  const [roleOpen, setRoleOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);

  const load = async () => {
    const [roleData, fileData, promptData] = await Promise.all([getDocumentRoles(), getKbFiles(), getPromptProjects()]);
    setRoles(roleData.roles);
    setConfigs(roleData.configs);
    setKbFiles(fileData.files);
    setPrompts(promptData);
  };

  useEffect(() => { void load().catch(() => message.error(t('common.error'))); }, [message, t]);

  const fileRoles = roles.filter(role => role.type === 'file');
  const promptRoles = roles.filter(role => role.type === 'prompt');

  const saveRole = async () => {
    try {
      const values = await roleForm.validateFields();
      const result = await saveDocumentRole(values);
      setRoles(result.roles);
      setConfigs(result.configs);
      setRoleOpen(false);
      message.success(t('common.success'));
    } catch { message.error(t('common.error')); }
  };

  const saveConfig = async () => {
    try {
      const values = await configForm.validateFields();
      const normalize = (items?: Array<{ roleId: string; order?: number }>) => (items ?? []).map((item, index) => ({ roleId: item.roleId, order: Number(item.order ?? index) }));
      const result = await saveProjectRoleConfig({ ...values, fileRoles: normalize(values.fileRoles), promptRoles: normalize(values.promptRoles) });
      setRoles(result.roles);
      setConfigs(result.configs);
      setConfigOpen(false);
      message.success(t('common.success'));
    } catch { message.error(t('common.error')); }
  };

  const removeRole = async (role: DocumentRole) => {
    const result = await deleteDocumentRole(role.type, role.id);
    setRoles(result.roles); setConfigs(result.configs);
  };

  const removeConfig = async (id: string) => {
    const result = await deleteProjectRoleConfig(id);
    setRoles(result.roles); setConfigs(result.configs);
  };

  const openRole = (role?: DocumentRole, type: 'file' | 'prompt' = 'file') => {
    roleForm.setFieldsValue(role ?? { id: `role-${Date.now()}`, name: '', description: '', type, executionType: type === 'prompt' ? 'reference' : undefined, processingType: type === 'file' ? 'reference' : undefined });
    setRoleOpen(true);
  };

  const openConfig = (config?: ProjectRoleConfig) => {
    configForm.setFieldsValue(config ?? { id: `config-${Date.now()}`, name: '', description: '', fileRoles: [], promptRoles: [] });
    setConfigOpen(true);
  };

  const roleList = (type: 'file' | 'prompt') => (
    <List
      dataSource={roles.filter(role => role.type === type)}
      locale={{ emptyText: <Empty description={t('common.noData')} /> }}
      renderItem={role => <List.Item actions={[<Button key="edit" type="text" icon={<EditOutlined />} onClick={() => openRole(role)} />, <Popconfirm key="delete" title={t('common.confirm')} onConfirm={() => { void removeRole(role); }}><Button type="text" danger icon={<DeleteOutlined />} /></Popconfirm>]}><List.Item.Meta title={<Space>{role.name}<Tag>{role.id}</Tag></Space>} description={<Space direction="vertical"><span>{role.description}</span><span>{role.type === 'prompt' ? role.executionType : role.processingType}</span><span>{role.resourceId || '-'}</span></Space>} /></List.Item>}
    />
  );

  return <div className="space-y-6 animateFadeIn">
    <Card className="cardGlass" styles={{ body: { padding: 24 } }}>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div><h1 className="pageTitle mb-1">{t('roles.title')}</h1><p className="pageDesc mb-0">{t('roles.description')}</p></div>
        <Space><Button icon={<PlusOutlined />} onClick={() => openRole(undefined, 'file')}>{t('roles.newFileRole')}</Button><Button icon={<PlusOutlined />} onClick={() => openRole(undefined, 'prompt')}>{t('roles.newPromptRole')}</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => openConfig()}>{t('roles.newConfig')}</Button></Space>
      </div>
    </Card>

    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}><Card title={t('roles.fileRoles')}>{roleList('file')}</Card></Col>
      <Col xs={24} lg={12}><Card title={t('roles.promptRoles')}>{roleList('prompt')}</Card></Col>
      <Col xs={24}><Card title={t('roles.configs')}><List dataSource={configs} locale={{ emptyText: <Empty description={t('common.noData')} /> }} renderItem={config => <List.Item actions={[<Button key="edit" type="text" icon={<EditOutlined />} onClick={() => openConfig(config)} />, <Popconfirm key="delete" title={t('common.confirm')} onConfirm={() => { void removeConfig(config.id); }}><Button type="text" danger icon={<DeleteOutlined />} /></Popconfirm>]}><List.Item.Meta title={<Space>{config.name}<Tag>{config.id}</Tag></Space>} description={`${t('roles.fileRoles')}: ${config.fileRoles.length} · ${t('roles.promptRoles')}: ${config.promptRoles.length}`} /></List.Item>} /></Card></Col>
    </Row>

    <Modal title={t('roles.roleEditor')} open={roleOpen} onOk={() => { void saveRole(); }} onCancel={() => setRoleOpen(false)} centered okText={t('common.save')}>
      <Form form={roleForm} layout="vertical">
        <Form.Item name="type" label={t('roles.roleType')} rules={[{ required: true }]}><Select options={[{ label: t('roles.fileRole'), value: 'file' }, { label: t('roles.promptRole'), value: 'prompt' }]} /></Form.Item>
        <Form.Item name="id" label="ID" rules={[{ required: true }]}><Input disabled /></Form.Item>
        <Form.Item name="name" label={t('roles.roleName')} rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="description" label={t('roles.roleDescription')}><Input /></Form.Item>
        <Form.Item noStyle shouldUpdate={(prev, cur) => prev.type !== cur.type}>{({ getFieldValue }) => getFieldValue('type') === 'prompt'
          ? <><Form.Item name="executionType" label={t('roles.executionType')} rules={[{ required: true }]}><Select options={[{ label: t('roles.factExtraction'), value: 'fact_extraction' }, { label: t('roles.chapterGeneration'), value: 'chapter_generation' }, { label: t('roles.validation'), value: 'validation' }, { label: t('roles.formatting'), value: 'formatting' }, { label: t('roles.reference'), value: 'reference' }]} /></Form.Item><Form.Item name="resourceId" label={t('roles.bindPrompt')}><Select showSearch options={prompts.filter(item => item.hasFile).map(item => ({ label: item.projectName, value: item.id }))} /></Form.Item></>
          : <><Form.Item name="processingType" label={t('roles.processingType')} rules={[{ required: true }]}><Select options={[{ label: t('roles.ruleFile'), value: 'rule' }, { label: t('roles.projectFactFile'), value: 'project_fact' }, { label: t('roles.tableFile'), value: 'table' }, { label: t('roles.drawingFile'), value: 'drawing' }, { label: t('roles.specificationFile'), value: 'specification' }, { label: t('roles.reference'), value: 'reference' }]} /></Form.Item><Form.Item name="resourceId" label={t('roles.bindFile')}><Select showSearch options={kbFiles.map(item => ({ label: item.relativePath, value: item.relativePath }))} /></Form.Item></>}
        </Form.Item>
      </Form>
    </Modal>

    <Modal title={t('roles.configEditor')} open={configOpen} onOk={() => { void saveConfig(); }} onCancel={() => setConfigOpen(false)} width={820} centered okText={t('common.save')}>
      <Form form={configForm} layout="vertical">
        <Row gutter={12}><Col span={8}><Form.Item name="id" label="ID" rules={[{ required: true }]}><Input disabled /></Form.Item></Col><Col span={8}><Form.Item name="name" label={t('roles.configName')} rules={[{ required: true }]}><Input /></Form.Item></Col><Col span={8}><Form.Item name="description" label={t('roles.configDescription')}><Input /></Form.Item></Col></Row>
        <Tabs items={[{ key: 'file', label: t('roles.fileRoles'), children: <Form.List name="fileRoles">{(fields, { add, remove }) => <Space direction="vertical" className="w-full">{fields.map((field, index) => <Row key={field.key} gutter={8}><Col span={16}><Form.Item name={[field.name, 'roleId']} rules={[{ required: true }]}><Select options={fileRoles.map(role => ({ label: role.name, value: role.id }))} /></Form.Item></Col><Col span={6}><Form.Item name={[field.name, 'order']} initialValue={index}><Input type="number" /></Form.Item></Col><Col span={2}><Button danger onClick={() => remove(field.name)}>-</Button></Col></Row>)}<Button onClick={() => add({ order: fields.length })}>{t('roles.addRole')}</Button></Space>}</Form.List> }, { key: 'prompt', label: t('roles.promptRoles'), children: <Form.List name="promptRoles">{(fields, { add, remove }) => <Space direction="vertical" className="w-full">{fields.map((field, index) => <Row key={field.key} gutter={8}><Col span={16}><Form.Item name={[field.name, 'roleId']} rules={[{ required: true }]}><Select options={promptRoles.map(role => ({ label: role.name, value: role.id }))} /></Form.Item></Col><Col span={6}><Form.Item name={[field.name, 'order']} initialValue={index}><Input type="number" /></Form.Item></Col><Col span={2}><Button danger onClick={() => remove(field.name)}>-</Button></Col></Row>)}<Button onClick={() => add({ order: fields.length })}>{t('roles.addRole')}</Button></Space>}</Form.List> }]} />
      </Form>
    </Modal>
  </div>;
}
