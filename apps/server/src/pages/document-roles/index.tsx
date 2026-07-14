import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, App, Button, Card, Col, Drawer, Empty, Form, Input, Popconfirm, Row, Select, Space, Tabs, Tag, Typography } from 'antd';
import {
  DeleteOutlined, EditOutlined, PlusOutlined, FileTextOutlined, FormOutlined,
  AuditOutlined, ProfileOutlined, TableOutlined, PictureOutlined, LinkOutlined,
  SearchOutlined, EyeOutlined, CheckCircleOutlined, AlignLeftOutlined,
  DownOutlined, UpOutlined, ImportOutlined, ExportOutlined,
} from '@ant-design/icons';
import { deleteDocumentRole, deleteProjectRoleConfig, getDocumentRoles, getPromptProjects, saveDocumentRole, saveProjectRoleConfig, searchKbFiles, type DocumentRole, type ProjectRoleConfig, type KbFileItem, type PromptProject } from '@/lib/api';
import { useAppTranslations } from '@/components/Layout';

const { Paragraph } = Typography;

const FILE_TYPE_ICONS: Record<string, ReactNode> = {
  rule: <AuditOutlined />, project_fact: <ProfileOutlined />, table: <TableOutlined />,
  drawing: <PictureOutlined />, specification: <FileTextOutlined />, reference: <LinkOutlined />,
};
const PROMPT_TYPE_ICONS: Record<string, ReactNode> = {
  fact_extraction: <SearchOutlined />, chapter_generation: <EditOutlined />, llm_review: <EyeOutlined />,
  validation: <CheckCircleOutlined />, formatting: <AlignLeftOutlined />, reference: <LinkOutlined />,
};
const FILE_TYPE_COLORS: Record<string, string> = { rule: '#fa8c16', project_fact: '#1677ff', table: '#52c41a', drawing: '#722ed1', specification: '#eb2f96', reference: '#13c2c2' };
const PROMPT_TYPE_COLORS: Record<string, string> = { fact_extraction: '#fa8c16', chapter_generation: '#1677ff', llm_review: '#722ed1', validation: '#52c41a', formatting: '#eb2f96', reference: '#13c2c2' };
const FILE_TYPE_LABELS: Record<string, string> = { rule: 'roles.ruleFile', project_fact: 'roles.projectFactFile', table: 'roles.tableFile', drawing: 'roles.drawingFile', specification: 'roles.specificationFile', reference: 'roles.reference' };
const PROMPT_TYPE_LABELS: Record<string, string> = { fact_extraction: 'roles.factExtraction', chapter_generation: 'roles.chapterGeneration', llm_review: 'roles.llmReview', validation: 'roles.validation', formatting: 'roles.formatting', reference: 'roles.reference' };

const tagRender = (props: { label: ReactNode; value: string; closable: boolean; onClose: () => void }) => (
  <Tag closable={props.closable} onClose={props.onClose} color="blue" style={{ margin: '1px 2px', fontSize: 11, lineHeight: '18px' }}>{props.label}</Tag>
);

/** 获取角色类型的国际化标签文本 */
function roleTypeLabel(role: DocumentRole, t: (key: string) => string) {
  const key = role.type === 'file' ? FILE_TYPE_LABELS[role.processingType ?? ''] : PROMPT_TYPE_LABELS[role.executionType ?? ''];
  return key ? t(key) : (role.type === 'file' ? role.processingType : role.executionType) ?? '';
}
/** 获取角色类型的图标 */
function roleTypeIcon(role: DocumentRole) {
  if (role.type === 'file') return FILE_TYPE_ICONS[role.processingType ?? ''] ?? <FileTextOutlined />;
  return PROMPT_TYPE_ICONS[role.executionType ?? ''] ?? <FormOutlined />;
}
/** 获取角色类型的颜色 */
function roleTypeColor(role: DocumentRole) {
  if (role.type === 'file') return FILE_TYPE_COLORS[role.processingType ?? ''] ?? 'var(--colorAccent)';
  return PROMPT_TYPE_COLORS[role.executionType ?? ''] ?? 'var(--colorWarning)';
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
function safeFilename(value: string) {
  return value.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'untitled';
}
function formatRolesExport(roles: DocumentRole[], configs: ProjectRoleConfig[]) {
  return { type: 'customize-agent.documentRoles', version: 1, exportedAt: new Date().toISOString(), roles, configs };
}

export default function DocumentRolesPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const [roleForm] = Form.useForm<DocumentRole>();
  const [configForm] = Form.useForm<ProjectRoleConfig>();
  const [roles, setRoles] = useState<DocumentRole[]>([]);
  const [configs, setConfigs] = useState<ProjectRoleConfig[]>([]);
  const [kbFiles, setKbFiles] = useState<KbFileItem[]>([]);
  const [fileSearching, setFileSearching] = useState(false);
  const [prompts, setPrompts] = useState<PromptProject[]>([]);
  const [roleDrawerOpen, setRoleDrawerOpen] = useState(false);
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);
  const [guideExpanded, setGuideExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('file');
  const [sourceFilter, setSourceFilter] = useState<'custom' | 'all'>('custom');
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = async () => {
    const [roleData, fileData, promptData] = await Promise.all([getDocumentRoles(), searchKbFiles({ limit: 200, includeContent: false }), getPromptProjects()]);
    setRoles(roleData.roles); setConfigs(roleData.configs); setKbFiles(fileData.files); setPrompts(promptData);
  };
  useEffect(() => { void load().catch(() => message.error(t('common.error'))); }, [message, t]);

  const customRoles = roles;
  const customConfigs = configs;
  const sourceMatches = () => sourceFilter === 'all' || sourceFilter === 'custom';
  const visibleRoles = roles.filter(sourceMatches);
  const visibleConfigs = configs.filter(sourceMatches);
  const fileRoles = visibleRoles.filter(r => r.type === 'file');
  const promptRoles = visibleRoles.filter(r => r.type === 'prompt');
  const allFileRoles = roles.filter(r => r.type === 'file');
  const allPromptRoles = roles.filter(r => r.type === 'prompt');

  /** 保存角色信息 */
  const saveRole = async () => {
    try { const v = await roleForm.validateFields(); const r = await saveDocumentRole(v); setRoles(r.roles); setConfigs(r.configs); setRoleDrawerOpen(false); message.success(t('common.success')); }
    catch { message.error(t('common.error')); }
  };
  /** 保存项目角色配置（规范化排序参数） */
  const saveConfig = async () => {
    try {
      const v = await configForm.validateFields();
      const norm = (items?: Array<{ roleId: string; order?: number }>) => (items ?? []).map((item, i) => ({ roleId: item.roleId, order: Number(item.order ?? i) }));
      const r = await saveProjectRoleConfig({ ...v, fileRoles: norm(v.fileRoles), promptRoles: norm(v.promptRoles) });
      setRoles(r.roles); setConfigs(r.configs); setConfigDrawerOpen(false); message.success(t('common.success'));
    } catch { message.error(t('common.error')); }
  };
  /** 删除指定角色 */
  const removeRole = async (role: DocumentRole) => { const r = await deleteDocumentRole(role.type, role.id); setRoles(r.roles); setConfigs(r.configs); };
  /** 删除指定项目配置 */
  const removeConfig = async (id: string) => { const r = await deleteProjectRoleConfig(id); setRoles(r.roles); setConfigs(r.configs); };

  const exportAllCustom = () => {
    downloadJson(`customize-document-roles-${new Date().toISOString().slice(0, 10)}.json`, formatRolesExport(customRoles, customConfigs));
    message.success(`已导出 ${customRoles.length} 个角色、${customConfigs.length} 个配置`);
  };
  const exportRole = (role: DocumentRole) => {
    downloadJson(`customize-role-${safeFilename(role.name)}-${new Date().toISOString().slice(0, 10)}.json`, formatRolesExport([role], []));
    message.success('已导出 1 个角色');
  };
  const exportConfig = (config: ProjectRoleConfig) => {
    const roleIds = new Set([...config.fileRoles.map(item => item.roleId), ...config.promptRoles.map(item => item.roleId)]);
    downloadJson(`customize-role-config-${safeFilename(config.name)}-${new Date().toISOString().slice(0, 10)}.json`, formatRolesExport(roles.filter(role => roleIds.has(role.id) && !role.builtIn), [config]));
    message.success('已导出 1 个配置');
  };
  const importRolesFile = async (file?: File) => {
    if (!file) return;
    setImporting(true);
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const res = await fetch('/api/documents/roles?mode=import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { roles: DocumentRole[]; configs: ProjectRoleConfig[]; importedRoles: number; importedConfigs: number };
      setRoles(data.roles); setConfigs(data.configs);
      message.success(`已导入 ${data.importedRoles} 个角色、${data.importedConfigs} 个配置`);
    } catch {
      message.error('导入失败，请确认 JSON 文件格式正确');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /** 打开角色编辑抽屉 */
  const openRoleDrawer = (role?: DocumentRole, type: 'file' | 'prompt' = 'file') => {
    roleForm.setFieldsValue(role ? { ...role, resourceIds: role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : [] } : { id: `role-${Date.now()}`, name: '', description: '', type, resourceIds: [], executionType: type === 'prompt' ? 'reference' : undefined, processingType: type === 'file' ? 'reference' : undefined });
    setRoleDrawerOpen(true);
  };
  /** 打开配置编辑抽屉 */
  const openConfigDrawer = (config?: ProjectRoleConfig) => {
    configForm.setFieldsValue(config ?? { id: `config-${Date.now()}`, name: '', description: '', fileRoles: [], promptRoles: [], builtIn: false });
    setConfigDrawerOpen(true);
  };

  const getRoleById = (id: string) => roles.find(r => r.id === id);
  const searchRoleFiles = async (query: string) => {
    setFileSearching(true);
    try {
      const result = await searchKbFiles({ query, limit: 80, includeContent: Boolean(query.trim()) });
      setKbFiles(result.files);
    } catch {
      message.error('知识库文件检索失败');
    } finally {
      setFileSearching(false);
    }
  };
  const fileOptions = kbFiles.map(file => ({
    label: (
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.relativePath}</span>
        <Space size={4}>
          <Tag color={file.matchedBy === 'content' ? 'purple' : file.matchedBy === 'disk' ? 'orange' : 'blue'} style={{ margin: 0 }}>{file.matchedBy === 'content' ? '内容' : file.matchedBy === 'disk' ? '磁盘' : '文件'}</Tag>
          <Tag style={{ margin: 0 }}>{file.status}</Tag>
        </Space>
      </div>
    ),
    value: file.relativePath,
  }));

  const roleCardGrid = (list: DocumentRole[], tFn: (key: string) => string) => {
    if (list.length === 0) return <Empty description={t('common.noData')} />;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: 12 }}>
        {list.map((role, index) => {
          const resources = (role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : []);
          const display = resources.slice(0, 3);
          const remaining = resources.length - display.length;
          const icon = roleTypeIcon(role);
          const iconColor = roleTypeColor(role);
          return (
            <Card key={role.id} size="small" hoverable style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                  <span style={{ color: iconColor, fontSize: 16, flexShrink: 0, lineHeight: 1 }}>{icon}</span>
                  <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '20px' }}>{role.name}</span>
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <Tag color="cyan" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>我的角色</Tag>
                </div>
              </div>
              {role.description && <Paragraph ellipsis={{ rows: 2 }} style={{ fontSize: 12, color: 'var(--colorTextSecondary)', marginBottom: 8 }}>{role.description}</Paragraph>}
              <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Tag color={role.type === 'file' ? 'blue' : 'purple'} style={{ margin: 0 }}>{roleTypeLabel(role, tFn)}</Tag>
                {resources.length > 0 && <span style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>绑定 {resources.length} 个资源</span>}
              </div>
              {display.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {display.map(r => <Tag key={r} color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r}</Tag>)}
                    {remaining > 0 && <Tag style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>+{remaining}</Tag>}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, paddingTop: 4, borderTop: '1px solid var(--colorBorderSecondary)' }}>
                <Button size="small" icon={<EditOutlined />} onClick={() => openRoleDrawer(role)}>编辑</Button>
                {!role.builtIn && <Button size="small" icon={<ExportOutlined />} onClick={() => exportRole(role)}>导出</Button>}
                <Popconfirm title={t('common.confirm')} onConfirm={() => { void removeRole(role); }}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </div>
            </Card>
          );
        })}
      </div>
    );
  };

  return <div className="space-y-5 animateFadeIn">
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
      <div><h1 className="pageTitle">{t('roles.title')}</h1><p className="pageDesc">{t('roles.description')}</p></div>
      <Space>
        <Select value={sourceFilter} onChange={setSourceFilter} style={{ width: 170 }} options={[
          { label: `我的配置 (${customRoles.length + customConfigs.length})`, value: 'custom' },
          { label: `全部来源 (${roles.length + configs.length})`, value: 'all' },
        ]} />
        <input ref={fileInputRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={e => { void importRolesFile(e.target.files?.[0]); }} />
        <Button icon={<ImportOutlined />} loading={importing} onClick={() => fileInputRef.current?.click()}>导入</Button>
        <Button icon={<ExportOutlined />} disabled={customRoles.length + customConfigs.length === 0} onClick={exportAllCustom}>导出全部</Button>
        <Button icon={<PlusOutlined />} onClick={() => openRoleDrawer(undefined, 'file')}>{t('roles.newFileRole')}</Button>
        <Button icon={<PlusOutlined />} onClick={() => openRoleDrawer(undefined, 'prompt')}>{t('roles.newPromptRole')}</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openConfigDrawer()}>{t('roles.newConfig')}</Button>
      </Space>
    </div>

    <Alert type="info" showIcon
      message={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{t('roles.plainGuideTitle')}</span>
        <Button type="link" size="small" icon={guideExpanded ? <UpOutlined /> : <DownOutlined />} onClick={() => setGuideExpanded(!guideExpanded)} style={{ padding: '0 4px' }}>{guideExpanded ? '收起说明' : '展开说明'}</Button>
      </div>}
      description={guideExpanded ? t('roles.plainGuideDesc') : undefined}
    />

    <Card size="small"
      tabList={[
        { key: 'file', label: `文件角色 (${fileRoles.length})` },
        { key: 'prompt', label: `提示词角色 (${promptRoles.length})` },
        { key: 'configs', label: `项目角色配置 (${visibleConfigs.length})` },
      ]}
      activeTabKey={activeTab} onTabChange={setActiveTab}
    >
      {activeTab === 'configs' ? (
        visibleConfigs.length === 0 ? <Empty description={t('common.noData')} /> : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {visibleConfigs.map((config) => {
              const fileItems = config.fileRoles.map(fr => ({ ...fr, role: getRoleById(fr.roleId) })).filter(x => x.role);
              const promptItems = config.promptRoles.map(pr => ({ ...pr, role: getRoleById(pr.roleId) })).filter(x => x.role);
              return (
                <Card key={config.id} size="small" hoverable style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{config.name}</span>
                    <Tag color="cyan" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>我的配置</Tag>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <Button size="small" icon={<EditOutlined />} onClick={() => openConfigDrawer(config)}>编辑</Button>
                      {!config.builtIn && <Button size="small" icon={<ExportOutlined />} onClick={() => exportConfig(config)}>导出</Button>}
                      <Popconfirm title={t('common.confirm')} onConfirm={() => { void removeConfig(config.id); }}>
                        <Button size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </div>
                  </div>
                  {config.description && <Paragraph ellipsis={{ rows: 2 }} style={{ fontSize: 12, color: 'var(--colorTextSecondary)', marginBottom: 8 }}>{config.description}</Paragraph>}
                  <div style={{ fontSize: 12, color: 'var(--colorTextSecondary)' }}>
                    <div style={{ marginBottom: 4 }}>
                      <span>文件角色 ({config.fileRoles.length}): </span>
                      {fileItems.length > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                          {fileItems.slice(0, 4).map(fr => <Tag key={fr.roleId} color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>{fr.role!.name}</Tag>)}
                          {fileItems.length > 4 && <Tag style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>+{fileItems.length - 4}</Tag>}
                        </div>
                      ) : <span style={{ color: 'var(--colorTextQuaternary)' }}>无</span>}
                    </div>
                    <div>
                      <span>提示词角色 ({config.promptRoles.length}): </span>
                      {promptItems.length > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                          {promptItems.slice(0, 4).map(pr => <Tag key={pr.roleId} color="purple" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>{pr.role!.name}</Tag>)}
                          {promptItems.length > 4 && <Tag style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>+{promptItems.length - 4}</Tag>}
                        </div>
                      ) : <span style={{ color: 'var(--colorTextQuaternary)' }}>无</span>}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )
      ) : (activeTab === 'file' ? roleCardGrid(fileRoles, t) : roleCardGrid(promptRoles, t))}
    </Card>

    {/* 角色编辑器抽屉 */}
    <Drawer
      title={t('roles.roleEditor')}
      open={roleDrawerOpen} onClose={() => setRoleDrawerOpen(false)}
      width={800} maskClosable={false}
      style={{ borderRadius: '12px 0 0 12px' }}
      styles={{ body: { padding: '16px 24px' }, header: { borderRadius: '12px 0 0 0', borderBottom: '1px solid var(--colorBorderSecondary)' } }}
      extra={<Button type="primary" onClick={() => { void saveRole(); }}>{t('common.save')}</Button>}
    >
      <Form form={roleForm} layout="vertical">
        <Form.Item name="id" hidden><Input /></Form.Item>
        <Row gutter={16}>
          <Col span={12}><Form.Item name="type" label={t('roles.roleType')} rules={[{ required: true }]}><Select options={[{ label: t('roles.fileRole'), value: 'file' }, { label: t('roles.promptRole'), value: 'prompt' }]} /></Form.Item></Col>
          <Col span={12}><Form.Item name="name" label={t('roles.roleName')} rules={[{ required: true }]}><Input /></Form.Item></Col>
        </Row>
        <Form.Item name="description" label={t('roles.roleDescription')}><Input.TextArea rows={2} /></Form.Item>
        <Form.Item noStyle shouldUpdate={(prev, cur) => prev.type !== cur.type}>{({ getFieldValue }) => {
          const isPrompt = getFieldValue('type') === 'prompt';
          return (
            <Card size="small" title={isPrompt ? '提示词角色配置' : '文件角色配置'} style={{ border: '1px solid var(--colorBorderSecondary)' }}>
              {isPrompt ? (
                <>
                  <Form.Item name="executionType" label={t('roles.executionType')} rules={[{ required: true }]} style={{ marginBottom: 12 }}>
                    <Select options={[
                      { label: t('roles.factExtraction'), value: 'fact_extraction' }, { label: t('roles.chapterGeneration'), value: 'chapter_generation' },
                      { label: t('roles.validation'), value: 'validation' }, { label: t('roles.formatting'), value: 'formatting' }, { label: t('roles.reference'), value: 'reference' },
                    ]} />
                  </Form.Item>
                  <Form.Item name="resourceIds" label={t('roles.bindPrompt')} style={{ marginBottom: 0 }} help={<span style={{ fontSize: 11, color: 'var(--colorTextSecondary)' }}>{t('roles.multiBindPromptHelp')}</span>}>
                    <Select mode="multiple" showSearch tagRender={tagRender} placeholder="选择提示词" options={prompts.filter(x => x.hasFile).map(x => ({ label: x.projectName, value: x.id }))} />
                  </Form.Item>
                </>
              ) : (
                <>
                  <Form.Item name="processingType" label={t('roles.processingType')} rules={[{ required: true }]} style={{ marginBottom: 12 }}>
                    <Select options={[
                      { label: t('roles.ruleFile'), value: 'rule' }, { label: t('roles.projectFactFile'), value: 'project_fact' },
                      { label: t('roles.tableFile'), value: 'table' }, { label: t('roles.drawingFile'), value: 'drawing' },
                      { label: t('roles.specificationFile'), value: 'specification' }, { label: t('roles.reference'), value: 'reference' },
                    ]} />
                  </Form.Item>
                  <Form.Item name="resourceIds" label={t('roles.bindFile')} style={{ marginBottom: 0 }} help={<span style={{ fontSize: 11, color: 'var(--colorTextSecondary)' }}>{t('roles.multiBindFileHelp')}</span>}>
                    <Select mode="multiple" showSearch filterOption={false} loading={fileSearching} onSearch={value => { void searchRoleFiles(value); }} onFocus={() => { void searchRoleFiles(''); }} tagRender={tagRender} placeholder="输入关键词搜索知识库文件" options={fileOptions} optionLabelProp="value" />
                  </Form.Item>
                </>
              )}
            </Card>
          );
        }}</Form.Item>
      </Form>
    </Drawer>

    {/* 配置编辑器抽屉 */}
    <Drawer
      title={t('roles.configEditor')}
      open={configDrawerOpen} onClose={() => setConfigDrawerOpen(false)}
      width={800} maskClosable={false}
      style={{ borderRadius: '12px 0 0 12px' }}
      styles={{ body: { padding: '16px 24px' }, header: { borderRadius: '12px 0 0 0', borderBottom: '1px solid var(--colorBorderSecondary)' } }}
      extra={<Button type="primary" onClick={() => { void saveConfig(); }}>{t('common.save')}</Button>}
    >
      <Form form={configForm} layout="vertical">
        <Form.Item name="id" hidden><Input /></Form.Item>
        <Row gutter={16}>
          <Col span={12}><Form.Item name="name" label={t('roles.configName')} rules={[{ required: true }]}><Input /></Form.Item></Col>
          <Col span={12}><Form.Item name="description" label={t('roles.configDescription')}><Input /></Form.Item></Col>
        </Row>
        <Tabs destroyInactiveTabPane={false} items={[
          {
            key: 'file', label: `文件角色 (${fileRoles.length})`,
            children: <Form.List name="fileRoles">{(fields, { add, remove }) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {fields.length === 0 && <Empty description="暂未添加文件角色" />}
                {fields.map((field, index) => (
                  <Card key={field.key} size="small" style={{ border: '1px solid var(--colorBorderSecondary)', position: 'relative' }}>
                    <div style={{ position: 'absolute', top: -10, left: 12, background: '#1677ff', color: '#fff', fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 10 }}>#{index + 1}</div>
                    <Button danger size="small" icon={<DeleteOutlined />} onClick={() => remove(field.name)} style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }} />
                    <Row gutter={[16, 8]} align="middle" style={{ marginTop: 4 }}>
                      <Col flex="auto">
                        <Form.Item name={[field.name, 'roleId']} label="文件角色" rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                          <Select placeholder="选择文件角色" size="small" options={allFileRoles.map(r => ({ label: `${r.name} (${t(FILE_TYPE_LABELS[r.processingType ?? ''] || 'roles.reference')})`, value: r.id }))} />
                        </Form.Item>
                      </Col>
                      <Col style={{ width: 90 }}>
                        <Form.Item name={[field.name, 'order']} label="排序" initialValue={index} style={{ marginBottom: 0 }}>
                          <Input type="number" size="small" />
                        </Form.Item>
                      </Col>
                    </Row>
                  </Card>
                ))}
                <Button icon={<PlusOutlined />} onClick={() => add({ order: fields.length })}>{t('roles.addRole')}</Button>
              </div>
            )}</Form.List>
          },
          {
            key: 'prompt', label: `提示词角色 (${allPromptRoles.length})`,
            children: <Form.List name="promptRoles">{(fields, { add, remove }) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {fields.length === 0 && <Empty description="暂未添加提示词角色" />}
                {fields.map((field, index) => (
                  <Card key={field.key} size="small" style={{ border: '1px solid var(--colorBorderSecondary)', position: 'relative' }}>
                    <div style={{ position: 'absolute', top: -10, left: 12, background: '#722ed1', color: '#fff', fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 10 }}>#{index + 1}</div>
                    <Button danger size="small" icon={<DeleteOutlined />} onClick={() => remove(field.name)} style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }} />
                    <Row gutter={[16, 8]} align="middle" style={{ marginTop: 4 }}>
                      <Col flex="auto">
                        <Form.Item name={[field.name, 'roleId']} label="提示词角色" rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                          <Select placeholder="选择提示词角色" size="small" options={allPromptRoles.map(r => ({ label: `${r.name} (${t(PROMPT_TYPE_LABELS[r.executionType ?? ''] || 'roles.reference')})`, value: r.id }))} />
                        </Form.Item>
                      </Col>
                      <Col style={{ width: 90 }}>
                        <Form.Item name={[field.name, 'order']} label="排序" initialValue={index} style={{ marginBottom: 0 }}>
                          <Input type="number" size="small" />
                        </Form.Item>
                      </Col>
                    </Row>
                  </Card>
                ))}
                <Button icon={<PlusOutlined />} onClick={() => add({ order: fields.length })}>{t('roles.addRole')}</Button>
              </div>
            )}</Form.List>
          },
        ]} />
      </Form>
    </Drawer>
  </div>;
}
