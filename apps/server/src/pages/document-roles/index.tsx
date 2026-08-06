import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, App, Button, Card, Col, Drawer, Empty, Form, Input, Popconfirm, Row, Select, Space, Tabs, Tag, Typography } from 'antd';
import {
  DeleteOutlined, EditOutlined, PlusOutlined, FileTextOutlined, FormOutlined,
  AuditOutlined, TableOutlined, PictureOutlined, LinkOutlined,
  SearchOutlined, EyeOutlined, CheckCircleOutlined, AlignLeftOutlined,
  DownOutlined, UpOutlined, ImportOutlined, ExportOutlined,
} from '@ant-design/icons';
import { deleteDocumentRole, deleteProjectRoleConfig, getDocumentRoles, getPromptProjects, saveDocumentRole, saveProjectRoleConfig, type DocumentRole, type ProjectRoleConfig, type PromptProject } from '@/lib/api';
import { useAppTranslations } from '@/components/Layout';

const { Paragraph } = Typography;

const FILE_TYPE_ICONS: Record<string, ReactNode> = {
  rule: <AuditOutlined />, table: <TableOutlined />,
  drawing: <PictureOutlined />, specification: <FileTextOutlined />, reference: <LinkOutlined />,
};
const PROMPT_TYPE_ICONS: Record<string, ReactNode> = {
  fact_extraction: <SearchOutlined />, chapter_generation: <EditOutlined />, llm_review: <EyeOutlined />,
  validation: <CheckCircleOutlined />, formatting: <AlignLeftOutlined />, reference: <LinkOutlined />,
};
const FILE_TYPE_COLORS: Record<string, string> = { rule: '#fa8c16', table: '#52c41a', drawing: '#722ed1', specification: '#eb2f96', reference: '#13c2c2' };
const PROMPT_TYPE_COLORS: Record<string, string> = { fact_extraction: '#fa8c16', chapter_generation: '#1677ff', llm_review: '#722ed1', validation: '#52c41a', formatting: '#eb2f96', reference: '#13c2c2' };
const FILE_TYPE_LABELS: Record<string, string> = { rule: 'roles.ruleFile', table: 'roles.tableFile', drawing: 'roles.drawingFile', specification: 'roles.specificationFile', reference: 'roles.reference' };
const PROMPT_TYPE_LABELS: Record<string, string> = { fact_extraction: 'roles.factExtraction', chapter_generation: 'roles.chapterGeneration', llm_review: 'roles.llmReview', validation: 'roles.validation', formatting: 'roles.formatting', reference: 'roles.reference' };

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
  const [prompts, setPrompts] = useState<PromptProject[]>([]);
  const [roleDrawerOpen, setRoleDrawerOpen] = useState(false);
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);
  const [guideExpanded, setGuideExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('file');
  const [sourceFilter, setSourceFilter] = useState<'custom' | 'all'>('custom');
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = async () => {
    const [roleData, promptData] = await Promise.all([getDocumentRoles(), getPromptProjects()]);
    setRoles(roleData.roles); setConfigs(roleData.configs); setPrompts(promptData);
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
    try { const v = await roleForm.validateFields(); const payload = v.type === 'file' ? { ...v, resourceId: undefined, resourceIds: [] } : v; const r = await saveDocumentRole(payload); setRoles(r.roles); setConfigs(r.configs); setRoleDrawerOpen(false); message.success(t('common.success')); }
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
  const removeRole = async (role: DocumentRole) => {
    try {
      const r = await deleteDocumentRole(role.type, role.id);
      setRoles(r.roles); setConfigs(r.configs);
      message.success('角色已删除');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '角色删除失败');
    }
  };
  /** 删除指定项目配置 */
  const removeConfig = async (id: string) => {
    try {
      const r = await deleteProjectRoleConfig(id);
      setRoles(r.roles); setConfigs(r.configs);
      message.success('项目角色配置已删除');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '项目角色配置删除失败');
    }
  };

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
  const roleResources = (role?: DocumentRole) => role?.type === 'prompt' ? (role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : []) : [];
  const promptDisplayName = (value: string) => prompts.find(prompt => prompt.id === value)?.projectName || value;
  const promptTagRender = (props: { label: ReactNode; value: string; closable: boolean; onClose: () => void }) => <Tag closable={props.closable} onClose={props.onClose} color="purple" title={props.value} style={{ margin: '1px 2px', fontSize: 11, lineHeight: '18px' }}>{promptDisplayName(props.value)}</Tag>;
  const selectedRoleSummary = (items: Array<{ roleId: string; order?: number }>, type: 'file' | 'prompt') => {
    const color = type === 'file' ? 'blue' : 'purple';
    const labelMap = type === 'file' ? FILE_TYPE_LABELS : PROMPT_TYPE_LABELS;
    const selected = [...items]
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
      .map(item => getRoleById(item.roleId))
      .filter((role): role is DocumentRole => Boolean(role));
    if (selected.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={type === 'file' ? t('roles.noFileRoleSelected') : t('roles.noPromptRoleSelected')} />;
    return <div className="flex flex-col gap-2">
      {selected.map((role, index) => {
        const resources = roleResources(role);
        const typeKey = role.type === 'file' ? role.processingType ?? '' : role.executionType ?? '';
        return <div key={role.id} className="flex items-center gap-2 p-2 rounded-lg bg-[var(--colorBgContainer)] border border-[var(--borderColor)]">
          <Tag color={color} className="m-0">#{index + 1}</Tag>
          <span className="font-semibold flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{role.name}</span>
          <Tag className="m-0">{t(labelMap[typeKey] || 'roles.reference')}</Tag>
          {role.type === 'prompt' && <span className="text-xs text-[var(--colorTextSecondary)]">{t('roles.bindPromptCount').replace('{count}', String(resources.length))}</span>}
        </div>;
      })}
    </div>;
  };
  const roleDetail = (role?: DocumentRole) => {
    if (!role) return null;
    const resources = roleResources(role);
    return <div style={{ marginTop: 8, padding: 8, borderRadius: 8, background: 'var(--colorFillQuaternary)', fontSize: 12, color: 'var(--colorTextSecondary)' }}>
      {role.description && <div style={{ marginBottom: role.type === 'prompt' ? 4 : 0 }}>{role.description}</div>}
      {role.type === 'prompt' && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {resources.slice(0, 4).map(resource => <Tag key={resource} title={resource} style={{ margin: 0, fontSize: 10, lineHeight: '16px', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{promptDisplayName(resource)}</Tag>)}
        {resources.length > 4 && <Tag style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>+{resources.length - 4}</Tag>}
        {resources.length === 0 && <span>未绑定提示词</span>}
      </div>}
    </div>;
  };

  const roleCardGrid = (list: DocumentRole[], tFn: (key: string) => string) => {
    if (list.length === 0) return <Empty description={t('common.noData')} />;
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {list.map((role) => {
          const resources = role.type === 'prompt' ? (role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : []) : [];
          const display = resources.slice(0, 3);
          const remaining = resources.length - display.length;
          const icon = roleTypeIcon(role);
          const iconColor = roleTypeColor(role);
          return (
            <div key={role.id} className="group p-5 rounded-xl border border-transparent hover:border-[var(--borderColorStrong)] bg-[var(--colorBgContainer)] hover:bg-[var(--colorBgHover)] hover:shadow-sm flex flex-col transition-all duration-300 min-w-0">
              <div className="flex items-start justify-between gap-3 mb-4 min-w-0">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span style={{ color: iconColor, fontSize: 20, flexShrink: 0, lineHeight: 1 }}>{icon}</span>
                  <span className="font-bold text-base text-[var(--colorText)] truncate mb-1">{role.name}</span>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <Tag color="cyan" bordered={false} className="m-0 text-[10px] leading-[18px]">我的角色</Tag>
                </div>
              </div>
              
              {role.description && <Paragraph ellipsis={{ rows: 2 }} className="text-xs text-[var(--colorTextSecondary)] mb-4">{role.description}</Paragraph>}
              
              <div className="flex flex-col gap-3 mt-auto pt-4 border-t border-[var(--borderColor)]">
                <div className="flex items-center gap-2 flex-wrap">
                  <Tag color={role.type === 'file' ? 'blue' : 'purple'} bordered={false} className="m-0">{roleTypeLabel(role, tFn)}</Tag>
                  {resources.length > 0 && <span className="text-xs text-[var(--colorTextSecondary)]">绑定 {resources.length} 个提示词</span>}
                </div>
                
                {display.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {display.map(r => <Tag key={r} color="purple" bordered={false} title={r} className="m-0 text-[10px] leading-[18px] max-w-[140px] truncate">{promptDisplayName(r)}</Tag>)}
                    {remaining > 0 && <Tag bordered={false} className="m-0 text-[10px] leading-[18px]">+{remaining}</Tag>}
                  </div>
                )}
                
                <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity mt-2">
                  <Button type="text" size="small" icon={<EditOutlined className="text-[var(--colorTextSecondary)]" />} onClick={() => openRoleDrawer(role)} />
                  {!role.builtIn && <Button type="text" size="small" icon={<ExportOutlined className="text-[var(--colorTextSecondary)]" />} onClick={() => exportRole(role)} />}
                  <Popconfirm title={t('common.confirm')} onConfirm={() => { void removeRole(role); }}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </div>
              </div>
            </div>
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

    <div className="bg-[var(--colorBg)] rounded-xl border border-[var(--borderColor)] mt-4">
      <Tabs
        className="px-6 pt-2 custom-tabs"
        items={[
          { key: 'file', label: `文件角色 (${fileRoles.length})` },
          { key: 'prompt', label: `提示词角色 (${promptRoles.length})` },
          { key: 'configs', label: `项目角色配置 (${visibleConfigs.length})` },
        ]}
        activeKey={activeTab} onChange={setActiveTab}
      />
      <div className="p-6 pt-2">
        {activeTab === 'configs' ? (
          visibleConfigs.length === 0 ? <Empty description={t('common.noData')} /> : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {visibleConfigs.map((config) => {
              const fileItems = config.fileRoles.map(fr => ({ ...fr, role: getRoleById(fr.roleId) })).filter(x => x.role);
              const promptItems = config.promptRoles.map(pr => ({ ...pr, role: getRoleById(pr.roleId) })).filter(x => x.role);
              return (
                <div key={config.id} className="group p-5 rounded-xl border border-transparent hover:border-[var(--borderColorStrong)] bg-[var(--colorBgContainer)] hover:bg-[var(--colorBgHover)] hover:shadow-sm flex flex-col transition-all duration-300 min-w-0">
                  <div className="flex items-start justify-between gap-3 mb-4 min-w-0">
                    <span className="font-bold text-base text-[var(--colorText)] truncate flex-1">{config.name}</span>
                    <div className="flex gap-2 flex-shrink-0">
                      <Tag color="cyan" bordered={false} className="m-0 text-[10px] leading-[18px]">我的配置</Tag>
                    </div>
                  </div>
                  
                  {config.description && <Paragraph ellipsis={{ rows: 2 }} className="text-xs text-[var(--colorTextSecondary)] mb-4">{config.description}</Paragraph>}
                  
                  <div className="flex flex-col gap-3 mt-auto pt-4 border-t border-[var(--borderColor)]">
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-[var(--colorTextSecondary)]">文件角色 ({config.fileRoles.length})</span>
                      {fileItems.length > 0 ? (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {fileItems.slice(0, 4).map(fr => <Tag key={fr.roleId} color="blue" bordered={false} className="m-0 text-[10px] leading-[18px]">{fr.role!.name}</Tag>)}
                          {fileItems.length > 4 && <Tag bordered={false} className="m-0 text-[10px] leading-[18px]">+{fileItems.length - 4}</Tag>}
                        </div>
                      ) : <span className="text-xs text-[var(--colorTextTertiary)]">无</span>}
                    </div>
                    
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-[var(--colorTextSecondary)]">提示词角色 ({config.promptRoles.length})</span>
                      {promptItems.length > 0 ? (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {promptItems.slice(0, 4).map(pr => <Tag key={pr.roleId} color="purple" bordered={false} className="m-0 text-[10px] leading-[18px]">{pr.role!.name}</Tag>)}
                          {promptItems.length > 4 && <Tag bordered={false} className="m-0 text-[10px] leading-[18px]">+{promptItems.length - 4}</Tag>}
                        </div>
                      ) : <span className="text-xs text-[var(--colorTextTertiary)]">无</span>}
                    </div>
                  </div>
                  
                  <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity mt-4">
                    <Button type="text" size="small" icon={<EditOutlined className="text-[var(--colorTextSecondary)]" />} onClick={() => openConfigDrawer(config)} />
                    {!config.builtIn && <Button type="text" size="small" icon={<ExportOutlined className="text-[var(--colorTextSecondary)]" />} onClick={() => exportConfig(config)} />}
                    <Popconfirm title={t('common.confirm')} onConfirm={() => { void removeConfig(config.id); }}>
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (activeTab === 'file' ? roleCardGrid(fileRoles, t) : roleCardGrid(promptRoles, t))}
      </div>
    </div>

    {/* 角色编辑器抽屉 */}
    <Drawer
      title={t('roles.roleEditor')}
      open={roleDrawerOpen} onClose={() => setRoleDrawerOpen(false)}
      width={800}
      maskClosable={false}
      styles={{ body: { padding: '24px 32px' }, header: { padding: '16px 32px', borderBottom: '1px solid var(--colorBorderSecondary)' } }}
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
                    <Select mode="multiple" showSearch tagRender={promptTagRender} placeholder="选择提示词" options={prompts.filter(x => x.hasFile).map(x => ({ label: x.projectName, value: x.id }))} />
                  </Form.Item>
                </>
              ) : (
                <>
                  <Form.Item name="processingType" label={t('roles.processingType')} rules={[{ required: true }]} style={{ marginBottom: 12 }}>
                    <Select options={[
                      { label: t('roles.ruleFile'), value: 'rule' },
                      { label: t('roles.tableFile'), value: 'table' }, { label: t('roles.drawingFile'), value: 'drawing' },
                      { label: t('roles.specificationFile'), value: 'specification' }, { label: t('roles.reference'), value: 'reference' },
                    ]} />
                  </Form.Item>
                  <Alert type="info" showIcon message="文件角色只定义处理类型" description="具体项目文件由生成流程自动识别，或在模板的高级固定绑定资料中手动覆盖；这里不再绑定知识库文件，避免角色复用时混入其他项目资料。" />
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
      width={800}
      maskClosable={false}
      styles={{ body: { padding: '24px 32px' }, header: { padding: '16px 32px', borderBottom: '1px solid var(--colorBorderSecondary)' } }}
      extra={<Button type="primary" onClick={() => { void saveConfig(); }}>{t('common.save')}</Button>}
    >
      <Form form={configForm} layout="vertical">
        <Form.Item name="id" hidden><Input /></Form.Item>
        <Row gutter={16}>
          <Col span={12}><Form.Item name="name" label={t('roles.configName')} rules={[{ required: true }]}><Input /></Form.Item></Col>
          <Col span={12}><Form.Item name="description" label={t('roles.configDescription')}><Input /></Form.Item></Col>
        </Row>
        <Form.Item noStyle shouldUpdate={(prev, cur) => prev.fileRoles !== cur.fileRoles || prev.promptRoles !== cur.promptRoles}>{({ getFieldValue }) => {
          const selectedFileRoles = (getFieldValue('fileRoles') || []) as Array<{ roleId: string; order?: number }>;
          const selectedPromptRoles = (getFieldValue('promptRoles') || []) as Array<{ roleId: string; order?: number }>;
          return <Tabs destroyInactiveTabPane={false} items={[
          {
            key: 'file', label: `文件角色 (${selectedFileRoles.length}/${allFileRoles.length})`,
            children: <Form.List name="fileRoles">{(fields, { add, remove }) => (
          <div className="flex flex-col gap-6 pt-4">
            <Card size="small" title="已选文件角色" className="bg-[var(--colorBgHover)] border-[var(--borderColorStrong)]" styles={{ header: { borderBottom: '1px solid var(--borderColorStrong)' } }}>{selectedRoleSummary(selectedFileRoles, 'file')}</Card>
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
                        <Form.Item noStyle shouldUpdate>{({ getFieldValue }) => roleDetail(getRoleById(getFieldValue(['fileRoles', field.name, 'roleId'])))}</Form.Item>
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
            key: 'prompt', label: `提示词角色 (${selectedPromptRoles.length}/${allPromptRoles.length})`,
            children: <Form.List name="promptRoles">{(fields, { add, remove }) => (
          <div className="flex flex-col gap-6 pt-4">
            <Card size="small" title="已选提示词角色" className="bg-[var(--colorBgHover)] border-[var(--borderColorStrong)]" styles={{ header: { borderBottom: '1px solid var(--borderColorStrong)' } }}>{selectedRoleSummary(selectedPromptRoles, 'prompt')}</Card>
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
                        <Form.Item noStyle shouldUpdate>{({ getFieldValue }) => roleDetail(getRoleById(getFieldValue(['promptRoles', field.name, 'roleId'])))}</Form.Item>
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
        ]} />;
        }}</Form.Item>
      </Form>
    </Drawer>
  </div>;
}
