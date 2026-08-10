import { useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Drawer, Empty, Form, Input, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { CheckCircleOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ProfileOutlined, RobotOutlined } from '@ant-design/icons';
import { deleteDocumentRole, deleteProjectRoleConfig, getDocumentRoles, getPromptProjects, saveDocumentRole, saveProjectRoleConfig, type DocumentRole, type ProjectRoleConfig, type PromptProject } from '@/lib/api';

const { Paragraph, Text } = Typography;

const PROMPT_EXECUTION_OPTIONS = [
  { value: 'fact_extraction', label: '事实抽取', color: 'orange' },
  { value: 'chapter_generation', label: '章节生成', color: 'blue' },
  { value: 'llm_review', label: '质量审查', color: 'purple' },
  { value: 'validation', label: '校验规则', color: 'green' },
  { value: 'formatting', label: '格式控制', color: 'magenta' },
  { value: 'reference', label: '参考资料', color: 'cyan' },
];

function uniqueValues(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function executionMeta(value?: string) {
  return PROMPT_EXECUTION_OPTIONS.find(item => item.value === value) || PROMPT_EXECUTION_OPTIONS[PROMPT_EXECUTION_OPTIONS.length - 1];
}

export default function DocumentRolesPage() {
  const { message } = App.useApp();
  const [roleForm] = Form.useForm<DocumentRole>();
  const [configForm] = Form.useForm<ProjectRoleConfig>();
  const [roles, setRoles] = useState<DocumentRole[]>([]);
  const [configs, setConfigs] = useState<ProjectRoleConfig[]>([]);
  const [prompts, setPrompts] = useState<PromptProject[]>([]);
  const [roleDrawerOpen, setRoleDrawerOpen] = useState(false);
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);

  const load = async () => {
    const [roleData, promptData] = await Promise.all([getDocumentRoles('prompt'), getPromptProjects()]);
    setRoles(roleData.roles);
    setConfigs(roleData.configs);
    setPrompts(promptData);
  };

  useEffect(() => { void load().catch(() => message.error('加载失败')); }, [message]);

  const promptOptions = useMemo(() => prompts.map(prompt => ({ label: prompt.projectName, value: prompt.id })), [prompts]);
  const roleById = useMemo(() => new Map(roles.map(role => [role.id, role])), [roles]);
  const promptDisplayName = (value: string) => prompts.find(prompt => prompt.id === value)?.projectName || value;
  const selectedRoles = selectedRoleIds.map(roleId => roleById.get(roleId)).filter(Boolean) as DocumentRole[];

  const openRoleDrawer = (role?: DocumentRole) => {
    roleForm.resetFields();
    roleForm.setFieldsValue(role ? { ...role, resourceIds: role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : [] } : {
      id: `role-${Date.now()}`,
      name: '',
      description: '',
      type: 'prompt',
      resourceIds: [],
      executionType: 'reference',
    });
    setRoleDrawerOpen(true);
  };

  const saveRole = async () => {
    try {
      const values = await roleForm.validateFields();
      const resourceIds = uniqueValues(values.resourceIds || []);
      const result = await saveDocumentRole({ ...values, type: 'prompt', resourceIds, resourceId: resourceIds[0] });
      setRoles(result.roles);
      setConfigs(result.configs);
      setRoleDrawerOpen(false);
      message.success('保存成功');
    } catch {
      message.error('保存失败');
    }
  };

  const removeRole = async (role: DocumentRole) => {
    try {
      const result = await deleteDocumentRole('prompt', role.id);
      setRoles(result.roles);
      setConfigs(result.configs);
      setSelectedRoleIds(prev => prev.filter(roleId => roleId !== role.id));
      message.success('删除成功');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  const openConfigDrawer = (config?: ProjectRoleConfig) => {
    configForm.resetFields();
    configForm.setFieldsValue(config || { id: `config-${Date.now()}`, name: '', description: '', promptRoles: [] });
    setSelectedRoleIds((config?.promptRoles || []).sort((a, b) => a.order - b.order).map(item => item.roleId));
    setConfigDrawerOpen(true);
  };

  const toggleConfigRole = (roleId: string) => {
    setSelectedRoleIds(prev => prev.includes(roleId) ? prev.filter(item => item !== roleId) : [...prev, roleId]);
  };

  const saveConfig = async () => {
    try {
      const values = await configForm.validateFields();
      const promptRoles = uniqueValues(selectedRoleIds).map((roleId, order) => ({ roleId, order }));
      const result = await saveProjectRoleConfig({ ...values, promptRoles });
      setRoles(result.roles);
      setConfigs(result.configs);
      setConfigDrawerOpen(false);
      message.success('保存成功');
    } catch {
      message.error('保存失败');
    }
  };

  const removeConfig = async (id: string) => {
    try {
      const result = await deleteProjectRoleConfig(id);
      setRoles(result.roles);
      setConfigs(result.configs);
      message.success('删除成功');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  const RoleCard = ({ role, selected, onClick }: { role: DocumentRole; selected?: boolean; onClick?: () => void }) => {
    const meta = executionMeta(role.executionType);
    const resources = role.resourceIds?.length ? role.resourceIds : role.resourceId ? [role.resourceId] : [];
    return <Card
      size="small"
      hoverable={Boolean(onClick)}
      onClick={onClick}
      className={`h-full rounded-2xl transition-all ${selected ? 'border-[var(--colorPrimary)] shadow-md bg-[var(--colorFillTertiary)]' : 'border-[var(--colorBorderSecondary)]'}`}
      styles={{ body: { padding: 16 } }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-[var(--colorFillSecondary)] flex items-center justify-center text-[var(--colorPrimary)]"><RobotOutlined /></div>
          <div className="min-w-0">
            <div className="font-semibold truncate text-[var(--colorText)]">{role.name}</div>
            <Text type="secondary" className="text-xs">{role.id}</Text>
          </div>
        </div>
        {selected && <CheckCircleOutlined className="text-[var(--colorPrimary)] text-lg" />}
      </div>
      <Space size={6} wrap className="mb-3">
        <Tag color={meta.color}>{meta.label}</Tag>
        {role.builtIn && <Tag>内置</Tag>}
        <Tag>{resources.length} 个提示词</Tag>
      </Space>
      {role.description && <Paragraph ellipsis={{ rows: 2 }} className="text-xs !mb-3 text-[var(--colorTextSecondary)]">{role.description}</Paragraph>}
      <div className="flex flex-wrap gap-1">
        {resources.length === 0 ? <Text type="secondary" className="text-xs">未绑定提示词资源</Text> : resources.slice(0, 3).map(resource => <Tag key={resource} title={resource} className="max-w-full truncate">{promptDisplayName(resource)}</Tag>)}
        {resources.length > 3 && <Tag>+{resources.length - 3}</Tag>}
      </div>
    </Card>;
  };

  return <div className="p-6 max-w-7xl mx-auto">
    <Card title="提示词角色配置" className="rounded-2xl mb-6" extra={<Space wrap>
      <Button icon={<PlusOutlined />} onClick={() => openConfigDrawer()} className="rounded-xl">新建编排配置</Button>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => openRoleDrawer()} className="rounded-xl">新建提示词角色</Button>
    </Space>}>
      <Paragraph type="secondary" className="!mb-4">项目资料类型由系统自动识别，这里只维护生成链路中使用的提示词角色和编排方案。</Paragraph>
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl bg-[var(--colorFillSecondary)] p-4">
          <Text type="secondary">提示词角色</Text>
          <div className="text-2xl font-semibold mt-1">{roles.length}</div>
        </div>
        <div className="rounded-xl bg-[var(--colorFillSecondary)] p-4">
          <Text type="secondary">编排配置</Text>
          <div className="text-2xl font-semibold mt-1">{configs.length}</div>
        </div>
        <div className="rounded-xl bg-[var(--colorFillSecondary)] p-4">
          <Text type="secondary">项目资料识别</Text>
          <div className="text-2xl font-semibold mt-1">自动</div>
        </div>
      </div>
    </Card>

    <Card title={<Space><RobotOutlined />提示词角色</Space>} className="rounded-2xl mb-6" extra={<Button type="link" onClick={() => openRoleDrawer()}>新增</Button>}>
      {roles.length === 0 ? <Empty description="暂无提示词角色" /> : <Table<DocumentRole>
        dataSource={roles}
        rowKey="id"
        pagination={false}
        columns={[
          {
            title: '角色名称',
            dataIndex: 'name',
            render: (name: string) => <Text strong>{name}</Text>,
          },
          {
            title: '执行阶段',
            dataIndex: 'executionType',
            width: 120,
            render: (value: string) => {
              const meta = executionMeta(value);
              return <Tag color={meta.color}>{meta.label}</Tag>;
            },
          },
          {
            title: '提示词',
            width: 100,
            render: (_: unknown, record) => {
              const count = record.resourceIds?.length || (record.resourceId ? 1 : 0);
              return <Tag>{count} 个</Tag>;
            },
          },
          {
            title: '说明',
            dataIndex: 'description',
            ellipsis: true,
            render: (text: string) => text ? <Text type="secondary" className="text-xs">{text}</Text> : <Text type="secondary" className="text-xs">-</Text>,
          },
          {
            title: '操作',
            width: 100,
            render: (_: unknown, record) => <Space size={0}>
              <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openRoleDrawer(record)} />
              <Popconfirm title="确认删除该提示词角色？" onConfirm={() => { void removeRole(record); }} disabled={record.builtIn}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} disabled={record.builtIn} />
              </Popconfirm>
            </Space>,
          },
        ]}
      />}
    </Card>

    <Card title={<Space><ProfileOutlined />提示词编排配置</Space>} className="rounded-2xl">
      {configs.length === 0 ? <Empty description="暂无编排配置" /> : <Table<ProjectRoleConfig>
        dataSource={configs}
        rowKey="id"
        pagination={false}
        columns={[
          {
            title: '配置名称',
            dataIndex: 'name',
            render: (name: string) => <Text strong>{name}</Text>,
          },
          {
            title: '提示词角色编排',
            render: (_: unknown, record) => record.promptRoles.length === 0
              ? <Text type="secondary" className="text-xs">未选择</Text>
              : <Space size={4} wrap>
                {[...record.promptRoles].sort((a, b) => a.order - b.order).map((item, index) => <Tag key={`${item.roleId}-${index}`} color="purple">#{index + 1} {roleById.get(item.roleId)?.name || item.roleId}</Tag>)}
              </Space>,
          },
          {
            title: '说明',
            dataIndex: 'description',
            ellipsis: true,
            render: (text: string) => text ? <Text type="secondary" className="text-xs">{text}</Text> : <Text type="secondary" className="text-xs">-</Text>,
          },
          {
            title: '操作',
            width: 100,
            render: (_: unknown, record) => <Space size={0}>
              <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openConfigDrawer(record)} />
              <Popconfirm title="确认删除该编排配置？" onConfirm={() => { void removeConfig(record.id); }} disabled={record.builtIn}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} disabled={record.builtIn} />
              </Popconfirm>
            </Space>,
          },
        ]}
      />}
    </Card>

    <Drawer title="提示词角色" open={roleDrawerOpen} onClose={() => setRoleDrawerOpen(false)} styles={{ wrapper: { width: 560 } }} extra={<Space><Button onClick={() => setRoleDrawerOpen(false)}>取消</Button><Button type="primary" onClick={() => { void saveRole(); }}>保存</Button></Space>}>
      <Form form={roleForm} layout="vertical">
        <Form.Item name="id" label="角色 ID" rules={[{ required: true }]}><Input disabled /></Form.Item>
        <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input placeholder="例如：章节生成专家" /></Form.Item>
        <Form.Item name="description" label="说明"><Input.TextArea rows={3} placeholder="说明该提示词角色在生成链路中的职责" /></Form.Item>
        <Form.Item name="type" hidden><Input /></Form.Item>
        <Form.Item name="executionType" label="执行阶段" rules={[{ required: true }]}><Select options={PROMPT_EXECUTION_OPTIONS} /></Form.Item>
        <Form.Item name="resourceIds" label="绑定提示词资源"><Select mode="multiple" allowClear options={promptOptions} placeholder="选择一个或多个提示词资源" /></Form.Item>
      </Form>
    </Drawer>

    <Drawer title="提示词编排配置" open={configDrawerOpen} onClose={() => setConfigDrawerOpen(false)} styles={{ wrapper: { width: 720 } }} extra={<Space><Button onClick={() => setConfigDrawerOpen(false)}>取消</Button><Button type="primary" onClick={() => { void saveConfig(); }}>保存</Button></Space>}>
      <Form form={configForm} layout="vertical">
        <Form.Item name="id" label="配置 ID" rules={[{ required: true }]}><Input disabled /></Form.Item>
        <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input placeholder="例如：施工组织设计默认编排" /></Form.Item>
        <Form.Item name="description" label="说明"><Input.TextArea rows={3} placeholder="说明这组提示词编排适用的文档类型" /></Form.Item>
      </Form>
      <div className="mb-3 flex items-center justify-between">
        <Text strong>选择提示词角色</Text>
        <Text type="secondary" className="text-xs">已选择 {selectedRoleIds.length} 个，点击卡片可切换</Text>
      </div>
      {roles.length === 0 ? <Empty description="暂无可选提示词角色" /> : <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
        {roles.map(role => <RoleCard key={role.id} role={role} selected={selectedRoleIds.includes(role.id)} onClick={() => toggleConfigRole(role.id)} />)}
      </div>}
      {selectedRoles.length > 0 && <Card size="small" title="当前编排顺序" className="rounded-2xl">
        <div className="flex flex-wrap gap-2">
          {selectedRoles.map((role, index) => <Tag key={role.id} color="purple" className="px-2 py-1">#{index + 1} {role.name}</Tag>)}
        </div>
      </Card>}
    </Drawer>
  </div>;
}
