import { Card, Col, Collapse, Divider, Row, Steps, Tag, Timeline, Typography } from 'antd';
import { CheckCircleOutlined, FormOutlined, RocketOutlined, SafetyCertificateOutlined, SettingOutlined } from '@ant-design/icons';
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
    items: ['创建模板', '上下文召回', '知识库证据增强', '动态执行状态'],
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
    checks: ['文件角色有名称', '已选择处理类型', '具体项目文件由生成流程自动识别'],
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
      '为章节填写查询词和必需事实；系统会自动按章节检索知识库证据。',
      '高级优先证据通常无需填写；只有必须指定某份官方资料、图纸或表格时才使用。',
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
      '系统会先绑定文件角色和提示词角色，再按当前项目召回短期/长期上下文；上下文只作为偏好和历史纠偏参考，不覆盖知识库事实。',
      '系统会按章节自动检索知识库证据；只有在必须指定官方资料、图纸或表格时，才需要使用高级优先证据。',
      '执行状态会根据当前模板、后台自动规范、文件角色、提示词角色、上下文召回、证据增强和章节自动生成，不是固定工程流程。',
      '当前执行节点会高亮显示，子状态会展示正在处理的章节、事实字段、文件角色、增强贡献或门禁规则。',
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
      '查看“结构化事实”，确认事实字段是否按后台自动规范动态 schema 抽取，并检查冲突提示。',
      '查看“来源”，确认事实来自后台自动规范要求的文件角色和绑定资料。',
      '查看“缺失项”，补齐缺失资料或调整角色配置。',
      '查看“校验”，优先处理 error；warning 表示可导出但建议复核。',
      '查看“导出门禁”，真实 blockingIssues 会作为风险提示保留，但不阻断用户导出。',
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

    <Card title="文件角色和提示词角色案例：它们在模板生成中到底起什么作用">
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="案例 A：创建文件角色“招标文件事实源”">
            <Paragraph><Text strong>怎么创建：</Text>类型选择 file，处理类型选择“项目事实文件”，绑定招标文件、合同摘要或项目概况。</Paragraph>
            <Paragraph><Text strong>生成时的作用：</Text>系统会从这个角色绑定的文件里抽取工程名称、建设地点、工期、质量目标、范围边界等事实，并把来源带入结构化事实和章节证据。</Paragraph>
            <Paragraph><Text strong>带来的提升：</Text>模型不再凭空补项目事实；章节生成和导出校验都会追踪“这句话来自哪个文件角色、哪个文件”。</Paragraph>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="案例 B：创建文件角色“工程量清单表格”">
            <Paragraph><Text strong>怎么创建：</Text>类型选择 file，处理类型选择“表格数据”，绑定 Excel、CSV、清单表或计划表。</Paragraph>
            <Paragraph><Text strong>生成时的作用：</Text>系统会读取 Sheet、表头、行列和来源范围，把表格数据转换成可引用的结构化资源证据。</Paragraph>
            <Paragraph><Text strong>带来的提升：</Text>章节中涉及数量、清单、计划、资源配置时，优先引用表格来源，减少数字编造和漏项。</Paragraph>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="案例 C：创建提示词角色“章节生成规则”">
            <Paragraph><Text strong>怎么创建：</Text>先在提示词管理中写好生成规则，例如“必须引用来源、不要写无来源数据、输出正式报告语气”；再创建 prompt 角色，执行类型选择“章节生成”。</Paragraph>
            <Paragraph><Text strong>生成时的作用：</Text>系统生成每个章节时会把这个提示词加入 LLM 上下文，用它约束语气、结构、引用方式和禁止事项。</Paragraph>
            <Paragraph><Text strong>带来的提升：</Text>同一套资料可以生成更稳定的文档风格；不同模板只需替换提示词角色，就能调整写法而不改知识库文件。</Paragraph>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="案例 D：创建提示词角色“导出前校验规则”">
            <Paragraph><Text strong>怎么创建：</Text>提示词内容写清楚必须检查的交付要求，例如“不能出现资料未提供、图片引用必须可访问、关键事实必须有来源”；prompt 角色执行类型选择“校验”或“格式化”。</Paragraph>
            <Paragraph><Text strong>生成时的作用：</Text>生成完成后，系统会结合后台自动规范、证据来源和导出门禁检查文档是否可交付。</Paragraph>
            <Paragraph><Text strong>带来的提升：</Text>把人工审稿经验前置到生成流程，降低导出后才发现缺来源、缺图片、格式不合格的概率。</Paragraph>
          </Card>
        </Col>
      </Row>
    </Card>

    <Card title="我的数据和门禁规则说明">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}><Card size="small" title="使用自己的数据"><Paragraph>文件、提示词、角色配置和规范包都来自用户自己创建或上传的内容，生成流程会按当前项目配置读取并参与校验。</Paragraph></Card></Col>
        <Col xs={24} md={8}><Card size="small" title="自定义门禁类型会执行"><Paragraph>门禁规则由后台根据模板、提示词和角色绑定自动形成，并与系统门禁一起参与生成校验，不需要用户手动维护规范包。</Paragraph></Card></Col>
        <Col xs={24} md={8}><Card size="small" title="上传后关注索引状态"><Paragraph>文件上传完成后，知识库索引会继续在后台写入。请在文件管理页查看状态，如果失败，页面会展示原因，方便重新配置模型或重试。</Paragraph></Card></Col>
      </Row>
    </Card>

    <Card title="上下文、知识库证据和增强贡献说明">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}><Card size="small" title="上下文召回不是事实来源"><Paragraph>生成前会按当前项目召回短期/长期上下文，但它只用于用户偏好、历史纠偏和连续性参考。如果上下文与知识库证据冲突，系统提示词会要求以知识库证据、模板要求和规范包为准。</Paragraph></Card></Col>
        <Col xs={24} md={8}><Card size="small" title="自动检索为主"><Paragraph>模板章节的查询词、章节目的和必需事实会驱动系统自动检索知识库证据。高级优先证据只是兜底能力，用于必须指定官方资料、图纸或表格的场景，不是日常必填项。</Paragraph></Card></Col>
        <Col xs={24} md={8}><Card size="small" title="增强贡献可追踪"><Paragraph>生成流程会展示知识库证据、人工确认/固定证据、项目上下文和自动检索证据的数量，帮助判断本次增强是否真的参与生成，而不是增加用户维护成本。</Paragraph></Card></Col>
      </Row>
    </Card>

    <Card title="动态 schema、证据和执行状态说明">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}><Card size="small" title="动态事实 schema"><Paragraph>系统不会写死工程字段。后台自动规范会结合模板章节 requiredFacts、角色绑定和提示词形成抽取 schema，并驱动事实抽取、冲突检测和导出门禁。</Paragraph></Card></Col>
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
            <Paragraph>如果存在明确风险问题，例如正文包含临时图片生成 URL、出现“资料未提供”占位、真实 blockingIssues 未解决，导出门禁会提示风险，但仍保留 DOCX/PDF 导出能力。</Paragraph>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title="导出门禁规则">
            <Paragraph>门禁分为“高风险提示”和“复核建议”。系统不会禁止导出，但会在出现高风险问题时提醒用户复核交付质量。</Paragraph>
            <ul className="list-disc pl-5 space-y-1"><li>Markdown/HTML 更适合快速预览和人工调整。</li><li>DOCX/PDF 会启用真实门禁检查。</li><li>草稿历史可保留多个版本，便于对比和再次导出。</li></ul>
          </Card>
        </Col>
      </Row>
    </Card>

    <Card title="生成资源和知识库的关系">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card size="small" title="生成资源手动加入知识库">
            <Paragraph>模板运行生成的文档、图片、封面或后处理资源会登记到生成资源管理页，默认不会自动回流知识库，避免模型产物污染事实来源。</Paragraph>
            <Paragraph>确认资源可复用后，可在资源管理页点击“加入知识库”，再写入 knowledgeBase/生成资源 并完成索引。</Paragraph>
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
        <Col xs={24} md={12} xl={6}><Card size="small" title="资料完整性"><ul className="list-disc pl-5 space-y-1"><li>事实源、规则源、表格源、图片/图纸源分开绑定。</li><li>关键事实在知识库检索中可以搜索到。</li><li>表格有清晰表头，图片和图纸有说明文字。</li><li>只有必须指定资料时才维护高级优先证据。</li></ul></Card></Col>
        <Col xs={24} md={12} xl={6}><Card size="small" title="角色配置"><ul className="list-disc pl-5 space-y-1"><li>文件角色处理类型选对。</li><li>提示词角色执行类型选对。</li><li>项目角色配置排序符合生成流程。</li><li>生成后查看增强贡献，确认上下文和证据是否真实参与。</li></ul></Card></Col>
        <Col xs={24} md={12} xl={6}><Card size="small" title="规范包"><ul className="list-disc pl-5 space-y-1"><li>required fact 不要过度配置。</li><li>sourceRoleIds 只绑定真正应该提供该事实的角色。</li><li>gateRules 区分 error 和 warning。</li></ul></Card></Col>
        <Col xs={24} md={12} xl={6}><Card size="small" title="交付检查"><ul className="list-disc pl-5 space-y-1"><li>草稿历史记录状态合理。</li><li>warning 原因已经阅读。</li><li>导出文件打开正常，图片和表格可读。</li></ul></Card></Col>
      </Row>
    </Card>

    <Card title="常见问题和处理建议">
      <Collapse items={[
        { key: 'warning-export', label: '为什么生成完成后显示 warning，但仍然可以导出？', children: <Paragraph>warning 表示文档已生成，但存在建议复核的问题，例如来源角色不完全匹配、某些事实需要人工确认或格式可优化。它不是失败，也不会阻断导出；真实 blockingIssues 或 error 级门禁问题会作为高风险提示展示，导出后请人工复核。</Paragraph> },
        { key: 'missing-facts', label: '为什么提示必需事实缺失？', children: <Paragraph>优先检查后台自动规范生成的事实字段、模板章节 requiredFacts 和文件角色绑定。很多情况下不是模型失败，而是资料没有被绑定到正确角色，或字段要求比资料实际内容更严格。</Paragraph> },
        { key: 'draft-duration', label: '草稿历史里的耗时怎么计算？', children: <Paragraph>耗时使用生成记录的 createdAt 到 completedAt 计算；旧记录或未完成记录会使用 updatedAt 兜底。它用于判断本次生成链路整体成本，包括知识库检索、事实抽取、章节生成、资源处理、校验和格式化。</Paragraph> },
        { key: 'asset-index', label: '生成资源会如何进入知识库？', children: <Paragraph>生成资源完成后会先进入生成资源管理页，默认不自动入库，避免生成内容再次被当作事实证据召回。确认需要复用时，可在资源管理页手动点击“加入知识库”，系统会写入 knowledgeBase/生成资源 并建立索引。</Paragraph> },
        { key: 'context-accuracy', label: '上下文召回会不会影响准确度？', children: <Paragraph>上下文只作为当前项目的偏好、历史纠偏和连续性参考，不作为事实来源。生成和审查提示词都要求：如果上下文与知识库证据、模板要求或后台自动规范冲突，以知识库证据和后台自动规范为准。</Paragraph> },
        { key: 'priority-evidence', label: '什么时候需要维护高级优先证据？', children: <Paragraph>日常不需要维护。只有当某章必须引用指定官方资料、图纸、表格，或自动检索结果不稳定时，才从知识库搜索页复制文件路径并填入章节高级优先证据。</Paragraph> },
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
