/**
 * stagePrepare：阶段 0 —— 角色绑定/资料锁定/索引同步/准备度/硬约束提示词。
 * P1 六阶段拆分（方案 5.1）：由 documentGenerator.generateDocumentDraft 阶段 0 代码块机械搬迁而来，
 * 变量读写经 session 子对象显式化，业务生成语义与原巨型函数逐字一致（行为保持）。
 */
import * as path from 'node:path';
import { computeProjectId } from '@customize-agent/knowledge';
import { getMultiProjectManager, getProjectKbRoot, getProjectRoot } from '../../knowledge/kbService';
import { getConfigStore } from '../../common/configService';
import { getProjectRoleConfig } from '../../document-core/documentRoleService';
import { autoSpecPrompt, getOrCreateAutoDocumentSpec } from '../../document-core/autoDocumentSpecService';
import { buildProjectMaterialSummary, projectMaterialPrompt } from '../../document-core/projectMaterialService';
import { resolveDocumentDomainProfile } from '../../document-core/documentDomainProfileService';
import { evaluateDocumentReadiness, readinessPrompt } from '../../document-validation/documentReadinessService';
import type { DocumentDraftChapter, DocumentExecutionStage, WebAccessConfig } from '../types';
import { buildPromptBindingPlan, defaultProjectRoleConfigIdForTemplate, getDocumentTemplate } from '../templateStore';
import { extractExplicitOutlineFromSources } from '../outline';
import { plannedStructurePrompt } from '../markdownComposer';
import { buildRuntimePromptRules, runtimePromptRulesPrompt } from '../promptRuleExtraction';
import { emptyRequirementSemanticPlan, parseRequirementSemantics } from '../requirementSemantics';
import { webAccessPrompt } from '../webResearchService';
import { resolveAgentMaterialScope } from '../agentWorkflow';
import { buildProjectMaterialProfile, buildProjectUnderstanding, materialKindMaps } from '../projectMaterialProfile';
import { promptTextsForResolvedPrompts } from '../rolePipeline';
import { displayStage, upsertProgressStage } from '../progress';
import { analyzeDefectHeatmap, buildWritingConstraintsReminder } from '../defectHeatmap';
import type { GenerationSession } from './generationSession';

/**
 * P19 写作硬约束自进化（默认开启）：读取本项目最近生成的导出闭环报告历史（B3 存储），
 * 分析跨文档缺陷热力图，把高频修复失败缺陷的规避提醒（≤300 字符）追加到写作硬约束 L1 可变段末尾。
 * 历史读取失败静默降级（自进化提醒不得影响生成主链路）；动态 import 破 document-core ↔ document-workflow 循环依赖。
 */
async function resolveWritingConstraintsReminder(projectRoot: string): Promise<string> {
  try {
    const { listGeneratedDocuments, getGeneratedDocument } = await import('../../document-core/generatedDocumentService');
    // 仅读已完成/已终态记录：生成中记录无导出报告且 getGeneratedDocument 会触发陈旧任务落盘写副作用
    const recent = listGeneratedDocuments(projectRoot).filter(item => item.status !== 'generating').slice(0, 20);
    const history = recent
      .map(item => getGeneratedDocument(item.id, projectRoot))
      .filter((record): record is NonNullable<typeof record> => Boolean(record))
      .flatMap(record => (record.exportReports || []).map(report => ({ exportedAt: report.exportedAt, repairHeat: report.repairHeat })));
    const { constraintSuggestions } = analyzeDefectHeatmap(history);
    return buildWritingConstraintsReminder(constraintSuggestions);
  } catch {
    return '';
  }
}

export async function stagePrepare(session: GenerationSession): Promise<void> {
  const baseTemplate = getDocumentTemplate(session.global.input.templateId);
  if (!baseTemplate) throw new Error('Document template not found');
  session.prepare.projectRoot = path.resolve(session.global.input.projectRoot || getProjectRoot());
  if (!session.prepare.projectRoot) throw new Error('No knowledge base project found');
  session.prepare.projectId = computeProjectId(session.prepare.projectRoot);
  session.prepare.template = baseTemplate;
  session.understanding.manager = getMultiProjectManager();
  session.global.chapterDrafts = [];
  session.global.checkpointChapterOrderIds = [];
  session.global.emitProgress = (checkpointChapters?: DocumentDraftChapter[], stages: DocumentExecutionStage[] = session.global.progressStages) => {
    const chapters = checkpointChapters ? [...checkpointChapters].sort((a, b) => {
      const ia = session.global.checkpointChapterOrderIds.indexOf(a.id);
      const ib = session.global.checkpointChapterOrderIds.indexOf(b.id);
      return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
    }) : undefined;
    session.global.input.onProgress?.([...stages], chapters ? { chapters } : undefined);
  };
  const heartbeatMs = Math.max(15_000, Math.min(60_000, Number(process.env.DOCUMENT_GENERATION_HEARTBEAT_MS ?? 30_000)));
  session.global.withProgressHeartbeat = async <T>(work: () => Promise<T>, stages: DocumentExecutionStage[] = session.global.progressStages): Promise<T> => {
    const timer = setInterval(() => {
      if (!session.global.input.signal?.aborted) session.global.emitProgress(session.global.chapterDrafts, stages);
    }, heartbeatMs);
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  };
  session.prepare.projectRoleConfigId = defaultProjectRoleConfigIdForTemplate(session.prepare.template) || 'none';
  session.prepare.projectRoleConfigName = getProjectRoleConfig(session.prepare.projectRoleConfigId)?.name || session.prepare.projectRoleConfigId;
  session.global.progressStages = [displayStage({
    type: 'role_binding',
    roleId: session.prepare.projectRoleConfigId,
    status: 'running',
    message: `生成任务已创建，正在读取模板与角色配置：${session.prepare.template.name}`,
    details: [`当前项目：${session.prepare.projectId}`, `资料目录：${getProjectKbRoot(session.prepare.projectRoot)}`, '正在读取项目资料包和提示词配置'],
    progress: { current: 1, total: 4, label: '初始化配置' },
  }, { subtitle: session.prepare.projectRoleConfigName, roleName: session.prepare.projectRoleConfigName, order: 0 })];
  session.global.emitProgress();
  session.prepare.promptPlan = buildPromptBindingPlan(session.prepare.template);
  session.prepare.promptBindings = session.prepare.promptPlan.bindings;
  upsertProgressStage(session.global.progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'running',
    message: '正在分析模板规范、用户要求与项目资料包',
    details: ['解析 OUTLINE 与模板章节', '读取项目资料包', '自动识别资料类型并构建项目理解'],
    progress: { current: 1, total: 3, label: '准备分析' },
  }, { subtitle: '生成准备', order: session.global.progressStages.length }));
  session.global.emitProgress();
  // 资料范围锁定（单点解析）：解析一次后沿 preflight / 入库复用 / Agent 工作流全链传递，避免重复扫描
  session.prepare.materialScope = resolveAgentMaterialScope(session.prepare.projectRoot, session.prepare.template, session.global.input.requirement || '');
  if (session.prepare.materialScope.ambiguous || !session.prepare.materialScope.locked || session.prepare.materialScope.selectedFiles.length === 0) {
    throw new Error(`资料范围未锁定：${session.prepare.materialScope.reason}`);
  }
  session.prepare.materialFilePaths = session.prepare.materialScope.selectedFiles;
  if (session.prepare.materialFilePaths.length === 0) throw new Error('模板未绑定可用项目资料包，请先在模板中绑定需要参与生成的项目文件夹。');
  // B1 守卫已改为非破坏性口径隔离（4.22.3）：不再删除知识库中非绑定资料组的切片索引——
  // 多项目资料共库是合法使用形态，生成启动时清库会导致其他项目的切片数据丢失（丰乐镇实测回归：
  // 库内徽光阁/合肥师范学院等资料组切片被整体清空且 bound_groups 残留导致重新同步无法恢复）；
  // 生成隔离由下游全链路 scopedFilePaths 口径过滤保证（kbIndexHealth/证据召回/事实提取均按绑定清单过滤），
  // 此处仅提示本次生成使用的绑定资料组，不触碰库内任何其他数据
  const boundMaterialGroups = session.prepare.materialScope.selectedRoots;
  if (boundMaterialGroups.length > 0) {
    upsertProgressStage(session.global.progressStages, displayStage({
      type: 'validation',
      roleId: 'document-preparation',
      status: 'running',
      message: '知识库索引与绑定文件清单已同步',
      details: [`本次生成仅使用绑定资料组：${boundMaterialGroups.join('、')}（${session.prepare.materialFilePaths.length} 份资料），库内其他资料组切片保留不清理`],
      progress: { current: 1, total: 3, label: '准备分析' },
    }, { subtitle: '生成准备', order: session.global.progressStages.length }));
    session.global.emitProgress();
  }
  session.prepare.projectMaterialProfile = buildProjectMaterialProfile(session.prepare.projectRoot, session.prepare.template, { requirement: session.global.input.requirement });
  session.prepare.projectUnderstanding = buildProjectUnderstanding(session.prepare.template, session.prepare.projectMaterialProfile);
  const { kindByPath, processingByPath } = materialKindMaps(session.prepare.projectMaterialProfile);
  session.prepare.kindByPath = kindByPath;
  session.prepare.processingByPath = processingByPath;
  const promptOutlineTexts = promptTextsForResolvedPrompts([...session.prepare.promptPlan.writerPrompts, ...session.prepare.promptPlan.chapterPrompts]);
  session.prepare.explicitPromptChapters = extractExplicitOutlineFromSources([
    { text: session.global.input.requirement, source: '用户需求', strict: true },
    { text: promptOutlineTexts, source: '提示词角色', strict: true },
  ]);
  session.prepare.hasExplicitOutline = session.prepare.explicitPromptChapters.length >= 2;
  if (session.prepare.hasExplicitOutline) session.prepare.template = { ...baseTemplate, chapters: session.prepare.explicitPromptChapters };
  session.prepare.projectMaterialSummary = await session.global.withProgressHeartbeat(() => Promise.resolve(buildProjectMaterialSummary(session.prepare.projectRoot, { requirement: session.global.input.requirement, boundFilePaths: session.prepare.materialFilePaths })));
  upsertProgressStage(session.global.progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'running',
    message: '正在生成自动文档规格并评估生成准备度',
    details: [`项目资料：${session.prepare.materialFilePaths.length} 份`, `资料类型：${Object.values(session.prepare.projectMaterialProfile.groups).filter(files => files.length > 0).length} 类`, '生成事实字段与章节约束'],
    progress: { current: 2, total: 3, label: '规格评估' },
  }, { subtitle: '生成准备', order: session.global.progressStages.length }));
  session.global.emitProgress();
  const autoSpec = await session.global.withProgressHeartbeat(() => Promise.resolve(getOrCreateAutoDocumentSpec(session.prepare.template, session.global.input.requirement || '')));
  session.prepare.documentSpec = autoSpec.spec;
  session.prepare.domainProfile = resolveDocumentDomainProfile(session.prepare.template, session.global.input.requirement || '');
  const resolvedMaterialRoles: Parameters<typeof evaluateDocumentReadiness>[0]['resolvedRoles'] = [];
  session.prepare.readiness = evaluateDocumentReadiness({ template: session.prepare.template, spec: session.prepare.documentSpec, summary: session.prepare.projectMaterialSummary, resolvedRoles: resolvedMaterialRoles });
  if (!session.prepare.readiness.ready) throw new Error(`生成准备度不足：${session.prepare.readiness.blockingIssues.join('；')}`);
  // round-20 S5/W7 P6-3：写作硬约束前置到生成提示词——禁编日期/禁商务数据/禁来源罗列/禁概况复述/禁后台话术
  // 在生成时即遵守，替代“先生成后检测删除”的事后修补（历史缺陷：修补链每轮 patch 都会冲掉前一轮修复）
  session.prepare.generationWritingConstraintsPrompt = ['【全文写作硬约束（每一章生成时必须遵守，违反即评审失分）】',
    '1. 禁止编造时间事实：开工日期、竣工日期、工期起止等未在项目资料中确认的日期一律不得写入正文；进度表述改用“开工后第 N 天”“第 N 周”等相对口径，或引用资料中已确认的日期。',
    '2. 禁止商务数据：暂列金额、暂估价、综合单价、清单合价、税率、投标报价等商务条款数据不得写入施工组织设计正文，商务口径只允许出现在项目信息表中。',
    '3. 禁止资料来源罗列话术：不得出现“根据/依据招标文件、工程量清单、图纸及答疑”式来源罗列句，直接陈述项目事实与施工安排；编制依据小节可集中列出依据文件。',
    // round-26：编制依据必须列出具体法规名称及文号（丰乐镇实测缺陷：只写「国家现行法律、行政法规」
    // 类别话术被判内容空泛；法规名与文号属公共知识，可依据现行有效版本直接引用）
    '3b. 编制依据小节必须列出具体法规名称及文号：国家法律法规条目列出《中华人民共和国建筑法》（主席令第91号公布，2019年修正）、《建设工程质量管理条例》（国务院令第279号公布，2019年修订）等具体名称及文号；地方性法规与政府规章条目按工程所在地列出具体名称（如《安徽省建筑市场管理条例》《合肥市城市绿化管理条例》）；规范标准条目列出《建筑工程施工质量验收统一标准》（GB 50300-2013）等具体编号；招标文件原文引用的法规按其原文列出。不得只写“国家现行法律、行政法规”“现行规范标准”“地方法规规章”等类别话术。',
    '4. 禁止跨章复述概况：除“工程概况/项目概况”章节外，其余章节不得以“本项目为/本工程为”开头整段复述项目总体概况，应直接展开本章主题内容。',
    '5. 禁止后台内部话术：不得出现“工作包”“WRITER_MISSING_SECTION”“已确认资料”等系统内部术语与兜底话术，一律改写为正式施工组织设计表述；不得模仿补写器格式书写“招标要求响应（前附表响应条款）”“按上述条款执行”等条款响应条幅——招标文件要求按正式表述落位各章节（如“本工程履约保证金按招标文件约定提交”）。',
    // round-21 S6：合规数值红线——安全/职业健康/危大工程章节是外部评审高危失分区（历史缺陷：
    // 高温停工写成 42℃、危大判定线张冠李戴、专家论证程序缺签章、同一监测指标两处数值矛盾），
    // 通用法规阈值前置到写作约束，从源头杜绝编造
    '6. 合规数值红线（安全、职业健康、危大工程章节必须逐条对照，违反即合规失分）：',
    '  a. 高温停工按《防暑降温措施管理办法》（安监总安健〔2012〕89号）：日最高气温达到40℃以上应停止当日室外露天作业；37℃~40℃时室外露天作业时间累计不得超过6小时且气温最高时段3小时内不得安排室外露天作业；35℃~37℃时应换班轮休缩短连续作业时间。不得写成42℃等其他阈值。',
    '  b. 危大工程判定线按住建部令第37号及建办质〔2018〕31号：基坑（槽）土方开挖、支护、降水，开挖深度超过3m（含3m）属危大工程，超过5m（含5m）属超过一定规模（需专家论证）；模板支撑搭设高度8m及以上或搭设跨度18m及以上属超过一定规模；落地式钢管脚手架搭设高度24m及以上属危大工程、50m及以上属超过一定规模，悬挑式脚手架分段架体搭设高度20m及以上属超过一定规模；采用非常规起重设备方法且单件起吊重量10kN及以上属危大工程、100kN及以上属超过一定规模。判定必须给出本项目对应参数（开挖深度/支撑高度/搭设高度/起吊重量），参数未在资料中确认的不得自行判定为危大或超危大。证据中含基坑底标高、±0.000对应绝对标高、垫层底标高等数值的，必须直接引用并据此给出开挖深度具体数值（开挖深度=地面标高-坑底标高），不得仅写“开挖深度超过3m”而不给数值；标高、坡率（如1:1.5）等设计参数应写入基坑支护与土方开挖相关小节。',
    '  c. 专家论证程序按住建部令第37号：超过一定规模的危大工程专项方案应组织不少于5名符合专业要求的专家（从地方住建主管部门专家库选取）论证；修改后的方案由施工单位技术负责人审核签字、加盖单位公章，并由总监理工程师审查签字、加盖执业印章后方可实施。',
    '  d. 监测预警值单一口径：同一监测指标（基坑位移速率、沉降预警值等）全文只能出现一个数值口径，不得前后矛盾；预警值优先引用设计文件明确值，无设计要求时按现行监测技术标准选取并注明依据。',
    '  e. 自设数值自洽：自设的防护尺寸、频次、时间节点等数值必须与同章及跨章表述一致，且尽量引用现行规范依据；无规范依据的自设值不得写成硬性规定。工期缓冲/预留天数的用途（如"竣工验收缓冲""工序衔接缓冲"）全文只能有一个口径，不得一处写竣工验收缓冲、另一处写工序衔接缓冲。',
    // round-25：表格口径自查泄漏治理（历史缺陷：写手把「合计行与明细不一致，故修正为…」的推算过程写进正文，
    // 与表格数值自相矛盾直接进成品）——自查过程必须留在推理中，正文只呈现自洽的最终数值
    '7. 禁止数据自查话术：不得把表格口径推算、数据一致性自查过程写入正文（如"上表合计行…与…不一致，故…修正为…"），表格与正文数值必须直接自洽；不得把招标条款编号碎片（如"3项规定""1委员会确定中""56m15：…"）作为小节标题。',
    // round-27：清单口径词泄漏治理（丰乐镇实测「措施项目工程量按清单口径为」「土方工程按清单汇总口径控制」——
    // 计量文件内部口径词按条抄入正文，评标人视角即口径推算话术）
    '7b. 禁止清单计量口径话术：不得出现"按清单口径""按清单汇总口径""清单口径为""按清单逐项""分部小计""本页小计"等工程量清单计量文件内部口径表述；工程量直接以正式施工组织设计口径陈述（"本工程土方挖方总量为…m³"），不得说明数值的清单来源或口径换算过程。',
    // round-27：小节标题污染治理（丰乐镇实测「4.1 每个单位工程独立制表（一）（二）」「8.3 业主确认环节与
    // 计量签证的前置管控措施」等模板说明性/商务口径标题被写成小节——小节标题必须是正式施组主题表述）
    '7c. 小节标题规范：小节标题必须是正式施工组织设计主题表述，禁止把模板说明性文字（"每个单位工程独立制表""制表（一）（二）"）、指令性文字（"详见XX""另见XX""按要求填写"）或商务口径词（"计量签证""计价""结算"）作为小节标题；章节编号必须连续（如 5.1、5.2、5.3），不得跳号。',
    // 评分报告问题2：纪律承诺段（「对参与本项目投标及施工组织设计编制的工作人员实行严格的纪律管理，
    // 确保投标活动合法合规」）被 LLM 写入正文——投标/评标纪律属商务投标函内容，技术标出现即降专业性
    '8. 禁止商务投标函内容：投标/评标纪律承诺、廉洁承诺、廉洁自律、行贿、串标、围标、弄虚作假、干扰评标等商务投标函条款与承诺一律不得写入施工组织设计正文（招标文件中的此类条款属商务文件应响应内容，不是技术标内容）；本节只写技术方案与管理措施，不得以承诺句形式响应此类条款。',
    // 丰乐镇十四版实测缺陷：一般路灯清单实为 100W 109套 + 120W 9套，正文写“100W 111套 + 120W 7套”——
    // 总数 118 对但拆分数值被 LLM 自行分配；清单给出规格拆分的必须逐项照抄，只有总量不得自行拆分
    '9. 禁止自行分配清单规格拆分数值：清单给出规格-数量拆分（如一般路灯 100W 109套、120W 9套）时必须逐项照抄原值，不得改动或重新分配；清单只给总量的不得自行拆分（“其中 A 套、B 套”式自拆即数据错误）。同一规格-数量拆分在全文各章必须一致。'].join('\n');
  // P19 写作硬约束自进化（默认开启，DOCUMENT_WRITING_CONSTRAINTS_EVOLUTION=0 关闭）：
  // 读取本项目历史导出闭环报告分析缺陷热力图，把高频修复失败缺陷的规避提醒（≤300 字符）
  // 追加到写作硬约束 L1 可变段末尾（写作前置规避，替代事后修复链）；无历史/读取失败时静默不注入
  if (process.env.DOCUMENT_WRITING_CONSTRAINTS_EVOLUTION !== '0') {
    const evolutionReminder = await resolveWritingConstraintsReminder(session.prepare.projectRoot);
    if (evolutionReminder) {
      session.prepare.generationWritingConstraintsPrompt = `${session.prepare.generationWritingConstraintsPrompt}\n${evolutionReminder}`;
      upsertProgressStage(session.global.progressStages, displayStage({
        type: 'validation',
        roleId: 'writing-constraints-evolution',
        status: 'success',
        message: `写作硬约束自进化：已注入缺陷热力图规避提醒 ${evolutionReminder.length} 字符`,
        details: [evolutionReminder],
      }, { subtitle: '写作硬约束' }));
    }
  }
  session.prepare.generationControlPrompt = [session.prepare.generationWritingConstraintsPrompt, session.prepare.projectUnderstanding.prompt, projectMaterialPrompt(session.prepare.projectMaterialSummary, { publicSafe: true }), autoSpecPrompt(session.prepare.documentSpec, autoSpec.sourceHash, { publicSafe: true }), readinessPrompt(session.prepare.readiness, { publicSafe: true })].filter(Boolean).join('\n\n');
  session.prepare.diagnosticControlPrompt = [session.prepare.projectUnderstanding.prompt, projectMaterialPrompt(session.prepare.projectMaterialSummary), autoSpecPrompt(session.prepare.documentSpec, autoSpec.sourceHash), readinessPrompt(session.prepare.readiness)].filter(Boolean).join('\n\n');
  const writingPromptTexts = promptTextsForResolvedPrompts([...session.prepare.promptPlan.writerPrompts, ...session.prepare.promptPlan.formattingPrompts]);
  const generalChapterPromptTexts = promptTextsForResolvedPrompts([...session.prepare.promptPlan.writerPrompts, ...session.prepare.promptPlan.chapterPrompts, ...session.prepare.promptPlan.formattingPrompts]);
  const sourcePromptTexts = promptTextsForResolvedPrompts(session.prepare.promptPlan.prompts);
  session.prepare.webAccessConfig = ((getConfigStore() as unknown as { load: () => { webAccess?: WebAccessConfig } }).load().webAccess || { enabled: false, allowProjectFacts: false, maxQueriesPerChapter: 2, maxResultsPerQuery: 3, trustedDomains: [] });
  session.prepare.runtimePromptRules = buildRuntimePromptRules({ promptTexts: [session.prepare.generationControlPrompt, sourcePromptTexts].filter(Boolean).join('\n\n'), requirement: session.global.input.requirement, template: session.prepare.template, rolePrompts: session.prepare.promptPlan.prompts });
  session.prepare.runtimeRulesText = [runtimePromptRulesPrompt(session.prepare.runtimePromptRules), webAccessPrompt(session.prepare.webAccessConfig.enabled)].filter(Boolean).join('\n\n');
  // 用户提示词语义解析第二通道（正则规则之上的语义层）：一次 LLM 调用把 requirement 解析为
  // 可逐条核验的强制要求清单（写作注入）+ 事实线索（检索查询构造）+ 风格要求；
  // 解析失败静默降级为空计划，不阻断生成。解析后把强制要求拼入运行时规则文本，
  // 使生成/检查/修复三条提示词链（promptTexts/factExtractionPromptTexts/reviewPromptTexts 均含 runtimeRulesText）全量可见
  session.prepare.requirementSemantics = await session.global.withProgressHeartbeat(() => parseRequirementSemantics({
    requirement: session.global.input.requirement,
    chapterTitles: session.prepare.template.chapters.map(chapter => chapter.title),
    signal: session.global.input.signal,
    diagnostics: undefined,
  }).catch(() => emptyRequirementSemanticPlan()));
  if (session.prepare.requirementSemantics.mandatoryBlockText) {
    session.prepare.runtimeRulesText = `${session.prepare.runtimeRulesText}\n\n${session.prepare.requirementSemantics.mandatoryBlockText}`;
  }
  session.prepare.promptTexts = [session.prepare.generationControlPrompt, session.prepare.runtimeRulesText, `生成前规划章节结构：\n${plannedStructurePrompt(session.prepare.template)}`, writingPromptTexts || generalChapterPromptTexts].filter(Boolean).join('\n\n');
  session.prepare.promptDocumentRules = session.prepare.runtimePromptRules;
  session.prepare.factExtractionPromptTexts = [session.prepare.diagnosticControlPrompt, session.prepare.runtimeRulesText, promptTextsForResolvedPrompts([...session.prepare.promptPlan.extractionPrompts, ...session.prepare.promptPlan.referencePrompts])].filter(Boolean).join('\n\n');
  session.prepare.reviewPromptTexts = [session.prepare.generationControlPrompt, session.prepare.runtimeRulesText, promptTextsForResolvedPrompts([...session.prepare.promptPlan.writerPrompts, ...session.prepare.promptPlan.chapterPrompts, ...session.prepare.promptPlan.formattingPrompts])].filter(Boolean).join('\n\n');
  // A3 修复类轻量提示词：跨章一致性修复/表格补写等 patch 级调用只背「写作硬约束+运行规则+格式规则」，
  // 不再携带全部写作/章节角色提示词全文（几十 k 字符中大部分与局部 patch 无关）——
  // 注意力聚焦的 patch 修复更精准，修复调用输入大幅瘦身；评审审查类调用仍用 reviewPromptTexts 全量视角
  session.prepare.repairPromptTexts = [session.prepare.generationControlPrompt, session.prepare.runtimeRulesText, promptTextsForResolvedPrompts(session.prepare.promptPlan.formattingPrompts)].filter(Boolean).join('\n\n');
  upsertProgressStage(session.global.progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'success',
    message: `模板规范与项目资料理解完成，识别 ${session.prepare.materialFilePaths.length} 份项目资料`,
    details: [`提示词绑定：${session.prepare.promptBindings.length} 个`, `项目资料包：${session.prepare.projectMaterialProfile.materialRoots.join('、') || '当前知识库'}`, session.prepare.hasExplicitOutline ? `识别 OUTLINE 章节：${session.prepare.explicitPromptChapters.length} 个` : '未识别显式 OUTLINE，使用模板章节'],
    progress: { current: 3, total: 3, label: '准备完成' },
  }, { subtitle: '生成准备', order: session.global.progressStages.length }));
  session.global.emitProgress();
}
