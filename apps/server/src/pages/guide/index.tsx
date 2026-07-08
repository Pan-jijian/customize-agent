import { Card, Col, Collapse, Divider, Row, Steps, Tag, Timeline, Typography } from 'antd';
import { CheckCircleOutlined, FileSearchOutlined, FormOutlined, RocketOutlined, SafetyCertificateOutlined, SettingOutlined } from '@ant-design/icons';
import { useAppTranslations } from '@/components/Layout';

const { Paragraph, Title, Text } = Typography;

const stageCards = [
  {
    icon: <SettingOutlined />,
    title: '准备阶段',
    color: 'blue',
    items: ['配置模型', '上传知识库资料', '创建提示词'],
  },
  {
    icon: <FormOutlined />,
    title: '编排阶段',
    color: 'purple',
    items: ['创建文件角色', '创建提示词角色', '创建项目角色配置并排序'],
  },
  {
    icon: <RocketOutlined />,
    title: '生成阶段',
    color: 'geekblue',
    items: ['创建模板', '后台生成轮询', '动态执行状态'],
  },
  {
    icon: <SafetyCertificateOutlined />,
    title: '交付阶段',
    color: 'green',
    items: ['审查事实和来源', '检查导出门禁', '导出正式文件'],
  },
];

const operationSections = [
  {
    title: '第一步：配置模型',
    goal: '让系统具备 LLM JSON 事实抽取、章节生成和校验能力。',
    path: '左侧菜单 → 模型配置',
    steps: [
      '点击新增供应商，选择 OpenAI、DeepSeek、OpenRouter、Ollama 或其他兼容 OpenAI 协议的服务。',
      '填写 Base URL、API Key、供应商名称并保存。',
      '添加模型名称，建议至少准备一个用于生成和推理的模型。',
      '把模型设置为当前启用模型。',
      '执行健康检查，确认模型可调用。',
    ],
    checks: ['模型健康检查通过', '至少有一个启用模型', 'API Key 和 Base URL 正确'],
    tips: '如果模型不可用，系统会回退到本地确定性抽取，但事实抽取质量会下降。',
  },
  {
    title: '第二步：上传知识库资料',
    goal: '把项目资料放入系统，让后续文件角色可以绑定。',
    path: '左侧菜单 → 知识库 → 文件管理 / 管理',
    steps: [
      '上传招标文件、工程概况、合同条件、技术要求等项目事实资料。',
      '上传工程量清单、劳动力计划、机械设备计划、材料计划等表格资料。',
      '上传图纸目录、图纸说明、设计说明等图纸类资料。',
      '上传规范、规程、企业标准、评分办法、编制要求等规则类资料。',
      '等待索引完成，并在知识库文件列表中确认文件可见。',
    ],
    checks: ['文件上传成功', '索引完成', '文件能在文件角色绑定下拉框中看到'],
    tips: '表格资料最好有清晰表头；图纸资料最好附带目录或文字说明。',
  },
  {
    title: '第三步：创建提示词',
    goal: '定义每个执行阶段的模型行为。',
    path: '左侧菜单 → 提示词管理',
    steps: [
      '创建事实抽取提示词：要求只抽取资料中明确出现的事实，返回结构化 JSON，不允许编造。',
      '创建章节生成提示词：定义文档类型、专业语气、章节风格、引用事实和禁止事项。',
      '创建校验提示词：检查工程名称、工期、质量目标、数字、表格引用、章节完整性。',
      '创建格式化提示词：定义封面、目录、编号、表格、分页和正式输出样式。',
      '保存后确认提示词能在提示词角色绑定下拉框中看到。',
    ],
    checks: ['事实抽取提示词已创建', '章节生成提示词已创建', '校验或格式化提示词已创建'],
    tips: '提示词越明确，生成结果越稳定。建议明确写上“没有来源的数据不要写”。',
  },
  {
    title: '第四步：创建文件角色',
    goal: '告诉系统每个文件在生成流程中的用途。',
    path: '左侧菜单 → 角色配置 → 新建文件角色',
    steps: [
      '填写角色名称，例如“招标文件事实源”“工程量清单表格”“图纸说明文件”。',
      '选择处理类型：规则文件、项目事实文件、表格数据、图纸文件、规范文件或参考资料。',
      '绑定对应知识库文件。',
      '保存角色。',
      '按文件用途创建多个文件角色，不建议把不同用途资料混在一个角色里。',
    ],
    checks: ['文件角色有名称', '已选择处理类型', '已绑定知识库文件'],
    tips: '处理类型很重要：系统会根据它决定是否进行表格解析、事实抽取、规则引用或来源追踪。',
  },
  {
    title: '第五步：创建提示词角色',
    goal: '告诉系统每条提示词在哪个执行阶段使用。',
    path: '左侧菜单 → 角色配置 → 新建提示词角色',
    steps: [
      '填写角色名称，例如“施工组织设计事实抽取”“章节生成规则”“导出前校验规则”。',
      '选择执行类型：事实抽取、章节生成、校验、格式化或参考。',
      '绑定对应提示词。',
      '保存角色。',
      '一个执行阶段可以有多个提示词角色，后续在项目角色配置中排序。',
    ],
    checks: ['提示词角色有名称', '已选择执行类型', '已绑定提示词'],
    tips: '角色名称可以完全自定义，但执行类型必须选对。系统依赖执行类型驱动多阶段流程。',
  },
  {
    title: '第六步：创建项目角色配置并排序',
    goal: '把文件角色和提示词角色组合成一个可复用的项目生成方案。',
    path: '左侧菜单 → 角色配置 → 新建项目配置',
    steps: [
      '填写配置名称，例如“某项目施工组织设计配置”。',
      '添加文件角色，并设置顺序。推荐：规则文件 → 项目事实文件 → 表格数据 → 图纸文件 → 规范文件 → 参考资料。',
      '添加提示词角色，并设置顺序。推荐：事实抽取 → 章节生成 → 校验 → 格式化 → 参考。',
      '保存项目角色配置。',
      '后续模板只绑定项目角色配置，不再重复绑定文件和提示词。',
    ],
    checks: ['至少包含一个文件角色', '至少包含一个提示词角色', '顺序符合业务流程'],
    tips: '排序决定系统读取资料和应用提示词的优先级，是生产级生成稳定性的关键。',
  },
  {
    title: '第七步：创建模板并绑定项目配置',
    goal: '定义要生成哪种文档，以及使用哪套项目角色配置。',
    path: '左侧菜单 → 生成编辑 → 新建模板',
    steps: [
      '填写模板 ID。ID 由系统生成或保持唯一，不建议手动频繁修改。',
      '填写模板名称，例如“施工组织设计”“技术标文件”“专项施工方案”。',
      '填写分类、输出标题和模板说明。',
      '选择第六步创建的项目角色配置。',
      '保存模板。',
    ],
    checks: ['模板名称清晰', '输出标题正确', '已绑定项目角色配置'],
    tips: '模板负责文档入口；项目角色配置负责资料、提示词和顺序。两者分离后更容易复用。',
  },
  {
    title: '第八步：执行生成并查看状态',
    goal: '让用户明确知道生成流程进行到哪一步。',
    path: '左侧菜单 → 生成编辑 → 选择模板 → 点击生成',
    steps: [
      '点击生成按钮后，页面会出现“执行状态”卡片。',
      '执行状态会根据当前模板、文档规范包、文件角色、提示词角色和章节自动生成，不是固定工程流程。',
      '当前执行节点会高亮显示，子状态会展示正在处理的章节、事实字段、文件角色或门禁规则。',
      '生成任务在后台运行，页面通过 documentId 轮询；切换页面后回到生成编辑仍可恢复状态。',
      '生成完成后，系统会用后端真实 executionStages 回填最终状态。',
      '如果导出门禁未通过，生成完成节点会提示需要检查校验结果。',
    ],
    checks: ['执行状态 Card 出现', '当前节点有高亮', '生成完成后有执行阶段结果'],
    tips: '如果长时间停留在某一步，优先检查模型配置、知识库索引和文件角色绑定。',
  },
  {
    title: '第九步：审查结果并导出',
    goal: '确保文档可追溯、可校验、可交付，同时能区分阻断问题和可复核 warning。',
    path: '生成编辑 → 编辑器下方 Tabs → 导出按钮 / 草稿历史',
    steps: [
      '查看“结构化事实”，确认事实字段是否按文档规范包动态 schema 抽取，并检查冲突提示。',
      '查看“来源”，确认事实来自规范包要求的文件角色和绑定资料。',
      '查看“缺失项”，补齐缺失资料或调整角色配置。',
      '查看“校验”，优先处理 error；warning 表示可导出但建议复核。',
      '查看“导出门禁”，真实 blockingIssues 会阻断 PDF/DOCX 导出，普通 warning 不阻断。',
      '在草稿历史中确认生成状态、warning 原因、整体生成耗时，并可删除不需要的记录。',
      '可以先导出 HTML 预览排版，再导出 DOCX/PDF。',
    ],
    checks: ['无真实阻断问题', '关键事实有来源', '章节有证据', 'warning 原因已复核', '导出文件可打开'],
    tips: '导出不是简单放行：真实阻断仍会拦截；生成完成但存在可复核问题时显示 warning，用户可以继续导出并按原因优化资料。',
  },
];

export default function GuidePage() {
  const t = useAppTranslations();
  return <div className="space-y-6 animateFadeIn">
    <Card className="cardGlass" styles={{ body: { padding: 24 } }}>
      <Title level={2} className="mb-2">{t('guide.title')}</Title>
      <Paragraph className="pageDesc mb-0">{t('guide.description')}</Paragraph>
    </Card>

    <Row gutter={[16, 16]}>
      {stageCards.map(stage => <Col xs={24} md={12} xl={6} key={stage.title}>
        <Card className="h-full" title={<span className="flex items-center gap-2">{stage.icon}{stage.title}</span>}>
          <div className="space-y-2">{stage.items.map(item => <div key={item}><Tag color={stage.color}>{item}</Tag></div>)}</div>
        </Card>
      </Col>)}
    </Row>

    <Card title={t('guide.fullFlow')}>
      <Steps direction="vertical" items={operationSections.map(section => ({ title: section.title, description: `${section.goal}（入口：${section.path}）` }))} />
    </Card>

    <Card title="详细步骤说明：照着做即可跑通">
      <Timeline
        mode="left"
        items={operationSections.map(section => ({
          dot: <CheckCircleOutlined />,
          children: <div className="space-y-3">
            <Title level={4} className="mb-0">{section.title}</Title>
            <Paragraph><Text strong>目标：</Text>{section.goal}</Paragraph>
            <Paragraph><Text strong>入口：</Text>{section.path}</Paragraph>
            <div>
              <Text strong>操作步骤：</Text>
              <ol className="list-decimal pl-6 mt-2 space-y-1">{section.steps.map(step => <li key={step}>{step}</li>)}</ol>
            </div>
            <div>
              <Text strong>完成检查：</Text>
              <div className="mt-2 flex flex-wrap gap-2">{section.checks.map(check => <Tag key={check} color="success">{check}</Tag>)}</div>
            </div>
            <Paragraph><Text strong>提示：</Text>{section.tips}</Paragraph>
            <Divider />
          </div>,
        }))}
      />
    </Card>

    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}>
        <Card title={t('guide.roleDesign')}>
          <Paragraph>{t('guide.roleDesignDesc')}</Paragraph>
          <div className="space-y-3">
            <div><Tag color="blue">file</Tag><Text strong>{t('guide.fileRole')}</Text><Paragraph>{t('guide.fileRoleDesc')}</Paragraph></div>
            <div><Tag color="purple">prompt</Tag><Text strong>{t('guide.promptRole')}</Text><Paragraph>{t('guide.promptRoleDesc')}</Paragraph></div>
            <div><Tag color="geekblue">config</Tag><Text strong>{t('guide.projectConfig')}</Text><Paragraph>{t('guide.projectConfigDesc')}</Paragraph></div>
          </div>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card title={t('guide.generationEngine')}>
          <Paragraph>{t('guide.generationEngineDesc')}</Paragraph>
          <div className="space-y-2">
            <Tag>{t('roles.factExtraction')}</Tag>
            <Tag>{t('roles.chapterGeneration')}</Tag>
            <Tag>{t('roles.validation')}</Tag>
            <Tag>{t('roles.formatting')}</Tag>
            <Tag>{t('documents.exportGate')}</Tag>
          </div>
        </Card>
      </Col>
    </Row>

    <Card title="我的数据、内置示例和门禁规则说明">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}><Card size="small" title="默认优先看我的数据"><Paragraph>文件、提示词、角色配置和规范包默认优先展示用户自己创建的内容。内置示例只用于学习，不能直接覆盖或删除，需要使用时请先复制。</Paragraph></Card></Col>
        <Col xs={24} md={8}><Card size="small" title="自定义门禁类型会执行"><Paragraph>用户在文档规范包中创建的门禁类型，需要选择校验对象和校验方式。保存后它会和系统门禁类型一样参与生成校验，不只是备注说明。</Paragraph></Card></Col>
        <Col xs={24} md={8}><Card size="small" title="上传后关注索引状态"><Paragraph>文件上传完成后，知识库索引会继续在后台写入。请在文件管理页查看状态，如果失败，页面会展示原因，方便重新配置模型或重试。</Paragraph></Card></Col>
      </Row>
    </Card>

    <Card title="动态 schema、证据和执行状态说明">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}><Card size="small" title="动态事实 schema"><Paragraph>系统不会写死工程字段。文档规范包的事实字段、模板章节 requiredFacts、字段 sourceRoleIds 和 extractionHint 会共同组成抽取 schema，并驱动事实抽取、冲突检测和导出门禁。</Paragraph></Card></Col>
        <Col xs={24} md={8}><Card size="small" title="结构化资源证据"><Paragraph>文本、PDF/Word、Excel/CSV、图片、地图图纸和其他附件都会被整理成资源证据，包含文件角色、处理类型、正文用途、关联事实和证据片段，模型据此理解资料关系。</Paragraph></Card></Col>
        <Col xs={24} md={8}><Card size="small" title="动态执行状态"><Paragraph>生成编辑页的执行节点会随模板、规范包、文件角色、提示词角色、章节和门禁规则变化；用户生成不同项目文件时看到的是对应项目的流程，而不是固定示例流程。</Paragraph></Card></Col>
      </Row>
    </Card>

    <Card title="生成记录、warning 和导出门禁怎么理解">
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card size="small" title="草稿历史记录">
            <Paragraph>每次后台生成都会写入全局项目目录 <Text code>~/.customize-agent/projects/{'{projectId}'}/generatedDocuments</Text>。记录会保存标题、模板、状态、创建时间、完成时间、生成耗时、正文、结构化结果和资源引用。</Paragraph>
            <ul className="list-disc pl-5 space-y-1"><li>completed：生成完成且无需要关注的问题。</li><li>warning：生成完成，但存在可复核问题。</li><li>failed：生成失败，需要查看错误原因。</li><li>generating：后台任务仍在执行，可轮询恢复。</li></ul>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title="warning 不是失败">
            <Paragraph>warning 用于提醒用户“文档已经生成，但建议复核”。例如必需事实没有在最佳来源角色中抽到、部分来源需要人工确认、格式或内容有优化建议。warning 会显示在草稿历史和校验详情中，并保留导出能力。</Paragraph>
            <Paragraph>如果是明确阻断问题，例如正文包含临时图片生成 URL、出现“资料未提供”占位、真实 blockingIssues 未解决，则导出门禁仍会阻断 DOCX/PDF。</Paragraph>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title="导出门禁规则">
            <Paragraph>门禁分为“真实阻断”和“复核建议”。系统不会因为普通 warning 简单禁止导出，但会在出现阻断级问题时保护交付质量。</Paragraph>
            <ul className="list-disc pl-5 space-y-1"><li>Markdown/HTML 更适合快速预览和人工调整。</li><li>DOCX/PDF 会启用真实门禁检查。</li><li>草稿历史可保留多个版本，便于对比和再次导出。</li></ul>
          </Card>
        </Col>
      </Row>
    </Card>

    <Card title="生成资源和知识库的关系">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card size="small" title="生成资源自动回流知识库">
            <Paragraph>模型生成的图片、封面或后处理资源会登记到生成资源管理页，并自动回流到 knowledgeBase/生成资源 下完成索引。</Paragraph>
            <Paragraph>后续文档可以继续检索和复用这些已生成资源，资源管理页也会展示入库状态。</Paragraph>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title="资源预览和坏图处理">
            <Paragraph>资源预览会从全局 generatedDocuments 目录解析文件，不依赖当前页面临时路径。图片下载会识别“image is generating”等占位响应，并校验 PNG/JPEG/WebP 字节，避免把占位文本当成图片保存。</Paragraph>
            <Paragraph>如果预览失败，优先查看资源管理页中的文件路径、资源状态和原始生成记录。</Paragraph>
          </Card>
        </Col>
      </Row>
    </Card>

    <Card title="文件角色处理类型大白话说明">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}><Card size="small" title="规则文件"><Paragraph>用来告诉系统“必须怎么写、不能怎么写、按什么标准判断”。适合放评分办法、甲方编制要求、攻略写作要求、输出格式要求。生成时会优先作为约束使用。</Paragraph></Card></Col>
        <Col xs={24} md={12}><Card size="small" title="项目事实文件"><Paragraph>用来告诉系统“真实情况是什么”。适合放项目概况、合同摘要、招标文件关键信息、游戏角色资料、产品资料。事实字段通常从这里抽取。</Paragraph></Card></Col>
        <Col xs={24} md={12}><Card size="small" title="表格数据"><Paragraph>用来解析结构化数据。适合放 Excel、CSV、清单、计划表、评分表、推荐指数表。系统会读取 Sheet、表头、行列和来源范围。</Paragraph></Card></Col>
        <Col xs={24} md={12}><Card size="small" title="图纸文件"><Paragraph>用来表达空间关系、路线、结构、站位或设计说明。可以是图纸目录、设计说明、路线示意、阵型图说明。没有 CAD 时也可以用文字图纸说明。</Paragraph></Card></Col>
        <Col xs={24} md={12}><Card size="small" title="规范文件"><Paragraph>用来作为专业依据。适合放国家规范、行业标准、企业标准、攻略结构规范、质量标准。校验和生成时会把它当成依据。</Paragraph></Card></Col>
        <Col xs={24} md={12}><Card size="small" title="参考资料"><Paragraph>只作为辅助阅读材料，不建议放关键事实。适合放图片来源、公开网页链接、背景资料、案例资料。系统可以参考，但不应把它当成强事实。</Paragraph></Card></Col>
      </Row>
    </Card>

    <Card title="推荐资料清单">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}><Card size="small" title="必备资料"><ul className="list-disc pl-5"><li>项目事实文件</li><li>招标或编制规则</li><li>章节生成提示词</li></ul></Card></Col>
        <Col xs={24} md={8}><Card size="small" title="强烈建议"><ul className="list-disc pl-5"><li>表格数据</li><li>图纸说明</li><li>规范或企业标准</li></ul></Card></Col>
        <Col xs={24} md={8}><Card size="small" title="导出前确认"><ul className="list-disc pl-5"><li>无 error 校验</li><li>事实有来源</li><li>导出门禁通过</li></ul></Card></Col>
      </Row>
    </Card>

    <Card title="生产级生成前检查清单">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12} xl={6}><Card size="small" title="资料完整性"><ul className="list-disc pl-5 space-y-1"><li>事实源、规则源、表格源、图片/图纸源分开绑定。</li><li>关键事实在知识库检索中可以搜索到。</li><li>表格有清晰表头，图片和图纸有说明文字。</li></ul></Card></Col>
        <Col xs={24} md={12} xl={6}><Card size="small" title="角色配置"><ul className="list-disc pl-5 space-y-1"><li>文件角色处理类型选对。</li><li>提示词角色执行类型选对。</li><li>项目角色配置排序符合生成流程。</li></ul></Card></Col>
        <Col xs={24} md={12} xl={6}><Card size="small" title="规范包"><ul className="list-disc pl-5 space-y-1"><li>required fact 不要过度配置。</li><li>sourceRoleIds 只绑定真正应该提供该事实的角色。</li><li>gateRules 区分 error 和 warning。</li></ul></Card></Col>
        <Col xs={24} md={12} xl={6}><Card size="small" title="交付检查"><ul className="list-disc pl-5 space-y-1"><li>草稿历史记录状态合理。</li><li>warning 原因已经阅读。</li><li>导出文件打开正常，图片和表格可读。</li></ul></Card></Col>
      </Row>
    </Card>

    <Card title="常见问题和处理建议">
      <Collapse items={[
        { key: 'warning-export', label: '为什么生成完成后显示 warning，但仍然可以导出？', children: <Paragraph>warning 表示文档已生成，但存在建议复核的问题，例如来源角色不完全匹配、某些事实需要人工确认或格式可优化。它不是失败，也不是导出阻断。只有真实 blockingIssues 或 error 级门禁问题才会阻断 DOCX/PDF 导出。</Paragraph> },
        { key: 'missing-facts', label: '为什么提示必需事实缺失？', children: <Paragraph>优先检查文档规范包中的 factFields、sourceRoleIds、模板章节 requiredFacts 和文件角色绑定。很多情况下不是模型失败，而是资料没有被绑定到正确角色，或字段要求比资料实际内容更严格。</Paragraph> },
        { key: 'draft-duration', label: '草稿历史里的耗时怎么计算？', children: <Paragraph>耗时使用生成记录的 createdAt 到 completedAt 计算；旧记录或未完成记录会使用 updatedAt 兜底。它用于判断本次生成链路整体成本，包括知识库检索、事实抽取、章节生成、资源处理、校验和格式化。</Paragraph> },
        { key: 'asset-index', label: '生成资源会如何进入知识库？', children: <Paragraph>生成资源完成后会自动回流到 knowledgeBase/生成资源 并建立索引，便于后续模板继续复用。资源管理页会展示入库状态，错误资源可以删除后重新生成。</Paragraph> },
      ]} />
    </Card>

    <Collapse items={[
      { key: 'prepare', label: t('guide.prepareTitle'), children: <Paragraph>{t('guide.prepareContent')}</Paragraph> },
      { key: 'roles', label: t('guide.rolesTitle'), children: <Paragraph>{t('guide.rolesContent')}</Paragraph> },
      { key: 'template', label: t('guide.templateTitle'), children: <Paragraph>{t('guide.templateContent')}</Paragraph> },
      { key: 'generate', label: t('guide.generateTitle'), children: <Paragraph>{t('guide.generateContent')}</Paragraph> },
      { key: 'qa', label: t('guide.qaTitle'), children: <Paragraph>{t('guide.qaContent')}</Paragraph> },
    ]} />
  </div>;
}
