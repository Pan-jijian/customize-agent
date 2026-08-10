import { Card, Col, Collapse, Row, Space, Tag, Timeline, Typography } from 'antd';
import { BookOutlined, CheckCircleOutlined, DatabaseOutlined, FileSearchOutlined, FileTextOutlined, NodeIndexOutlined, PlayCircleOutlined, SettingOutlined } from '@ant-design/icons';

const { Title, Paragraph, Text } = Typography;

const steps = [
  {
    icon: <DatabaseOutlined />,
    title: '上传项目资料包',
    goal: '将同一项目的招标正文、清单、图纸、补疑等资料放在同一个项目文件夹下。',
    checks: ['资料已上传', '索引完成', '可选择项目文件夹'],
  },
  {
    icon: <SettingOutlined />,
    title: '维护提示词角色',
    goal: '只配置写作、事实抽取、质量审查、格式化等提示词角色；项目资料类型由系统自动识别。',
    checks: ['角色已绑定提示词', '编排配置已保存'],
  },
  {
    icon: <FileTextOutlined />,
    title: '配置文档模板',
    goal: '选择项目资料包，配置章节结构、输出标题、页数目标和提示词编排。',
    checks: ['资料包已绑定', '章节结构完整', '运行前校验通过'],
  },
  {
    icon: <PlayCircleOutlined />,
    title: '运行工作流',
    goal: '系统构建项目理解，并按章节组合招标正文、清单、图纸、补疑等证据生成文档。',
    checks: ['项目理解完成', '章节逐步生成', '证据来源可追溯'],
  },
  {
    icon: <CheckCircleOutlined />,
    title: '审查与导出',
    goal: '查看结构化事实、来源、缺失项和导出门禁，确认文档可交付。',
    checks: ['无阻断问题', '正文无后台话术', '导出结果可打开'],
  },
];

const materialCards = [
  { title: '招标文件正文', desc: '确定项目边界、响应要求、工期质量安全目标和评审关注点。', color: 'blue' },
  { title: '工程量清单', desc: '确定主要工程内容、分部分项、项目特征、工程量和资源配置依据。', color: 'green' },
  { title: '图纸/设计资料', desc: '确定施工对象、空间关系、构造做法、专业接口和重点难点。', color: 'purple' },
  { title: '补疑/澄清/答疑', desc: '修正招标正文、清单或图纸口径；与原文件冲突时优先采用。', color: 'orange' },
];

const flowCards = [
  { icon: <FileSearchOutlined />, title: '自动资料识别', desc: '根据文件名、目录和内容线索识别资料类型。' },
  { icon: <NodeIndexOutlined />, title: '项目理解', desc: '建立项目资料包视角，提炼工程范围、招标要求、清单内容、图纸对象和补疑修正项。' },
  { icon: <BookOutlined />, title: '章节证据计划', desc: '不同章节按不同资料组合召回，减少泛化套话和无来源事实。' },
];

export default function GuidePage() {
  return <div className="p-6 max-w-7xl mx-auto">
    <div className="w-full flex flex-col gap-6">
      <Card
        title={<><BookOutlined /> 使用指南</>}
        className="rounded-2xl"
        extra={<Space wrap>
          <Tag color="blue" className="px-3 py-1">项目资料包</Tag>
          <Tag color="green" className="px-3 py-1">自动识别</Tag>
          <Tag color="purple" className="px-3 py-1">项目理解</Tag>
        </Space>}
      >
        <Paragraph type="secondary" className="!mb-0 max-w-3xl">
          模板直接绑定整个项目资料包，系统自动识别招标正文、工程量清单、图纸、补疑、技术规范等资料类型，并基于项目理解生成专业文档。
        </Paragraph>
      </Card>

      <Card className="rounded-2xl" styles={{ body: { padding: 24 } }}>
        <div className="flex items-center justify-between gap-4 mb-5">
          <div>
            <Title level={4} className="!mb-1">推荐操作流程</Title>
            <Text type="secondary">从资料入库到文档导出，按以下步骤完成。</Text>
          </div>
        </div>
        <Row gutter={[16, 16]}>
          {steps.map((step, index) => <Col xs={24} md={12} xl={8} key={step.title}>
            <Card className="h-full rounded-2xl border-[var(--colorBorderSecondary)]" styles={{ body: { padding: 18 } }}>
              <div className="flex items-start gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-[var(--colorFillSecondary)] text-[var(--colorPrimary)] flex items-center justify-center text-lg">{step.icon}</div>
                <div className="min-w-0">
                  <Tag color="blue" className="mb-2">Step {index + 1}</Tag>
                  <div className="font-semibold text-[var(--colorText)]">{step.title}</div>
                </div>
              </div>
              <Paragraph className="text-sm text-[var(--colorTextSecondary)] min-h-[44px] !mb-4">{step.goal}</Paragraph>
              <div className="flex flex-wrap gap-1.5">
                {step.checks.map(check => <Tag key={check}>{check}</Tag>)}
              </div>
            </Card>
          </Col>)}
        </Row>
      </Card>

      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} lg={10}>
          <Card title="项目资料包如何组织" className="rounded-2xl h-full" styles={{ body: { padding: 24 } }}>
            <Timeline
              items={[
                { color: 'blue', children: <div><Text strong>一个项目一个文件夹</Text><Paragraph className="!mb-0 text-sm text-[var(--colorTextSecondary)]">例如“徽光阁项目/”，模板绑定时直接选择该文件夹。</Paragraph></div> },
                { color: 'green', children: <div><Text strong>资料集中放置</Text><Paragraph className="!mb-0 text-sm text-[var(--colorTextSecondary)]">招标正文、清单、图纸、补疑、技术规范等资料放在同一个资料包下。</Paragraph></div> },
                { color: 'purple', children: <div><Text strong>系统自动理解</Text><Paragraph className="!mb-0 text-sm text-[var(--colorTextSecondary)]">生成前构建项目资料画像和项目理解模型。</Paragraph></div> },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title="关键资料职责" className="rounded-2xl h-full" styles={{ body: { padding: 24 } }}>
            <Row gutter={[12, 12]}>
              {materialCards.map(item => <Col xs={24} md={12} key={item.title}>
                <Card size="small" className="rounded-xl h-full border-[var(--colorBorderSecondary)]">
                  <Tag color={item.color} className="mb-2">{item.title}</Tag>
                  <Paragraph className="!mb-0 text-sm text-[var(--colorTextSecondary)]">{item.desc}</Paragraph>
                </Card>
              </Col>)}
            </Row>
          </Card>
        </Col>
      </Row>

      <Card title="生成链路说明" className="rounded-2xl" styles={{ body: { padding: 24 } }}>
        <Row gutter={[16, 16]}>
          {flowCards.map((item, index) => <Col xs={24} md={8} key={item.title}>
            <Card className="rounded-2xl h-full border-[var(--colorBorderSecondary)]" styles={{ body: { padding: 18 } }}>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 rounded-xl bg-[var(--colorFillSecondary)] text-[var(--colorPrimary)] flex items-center justify-center">{item.icon}</div>
                <div>
                  <Tag color="blue">{index + 1}</Tag>
                  <Text strong>{item.title}</Text>
                </div>
              </div>
              <Paragraph className="!mb-0 text-sm text-[var(--colorTextSecondary)]">{item.desc}</Paragraph>
            </Card>
          </Col>)}
        </Row>
      </Card>

      <Collapse className="rounded-2xl overflow-hidden" items={[
        { key: 'binding', label: '模板为什么只需要绑定项目资料包？', children: <Paragraph className="!mb-0">因为资料职责已经由系统自动识别。用户只需要告诉系统“本次生成使用哪个项目”，系统会自动在该项目资料包内组织资料关系。</Paragraph> },
        { key: 'addendum', label: '补疑/澄清如何处理？', children: <Paragraph className="!mb-0">补疑、澄清、答疑属于高优先级资料。如与招标正文、清单或图纸存在冲突，生成时优先采用补疑/澄清口径。</Paragraph> },
        { key: 'quality', label: '专业性如何保证？', children: <Paragraph className="!mb-0">生成链路会结合项目理解、章节证据计划、结构化事实、质量审查和导出门禁，减少泛化套话和无来源事实。</Paragraph> },
      ]} />
    </div>
  </div>;
}
