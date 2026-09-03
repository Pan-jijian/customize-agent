/**
 * workflowRules 配置收口（方案7）：所有枚举表（口径词表、语境分类词表、锚定清单、
 * minChars 表、验收阈值、专项规则文本）集中到一份配置结构，支持项目级覆盖。
 * 缓存版本跟随配置哈希自动变化（stableHash(workflowRules) 并入 canonicalFactCacheKey），
 * 消除手动 bump 版本号忘改导致复用陈旧裁决的问题（F3）。
 *
 * 项目级覆盖：在项目根目录放置 {projectRoot}/.customize-agent/workflow-rules.json，
 * 只需给出要覆盖的键（正则以字符串源形式给出），加载时逐层浅合并到默认配置。
 * 覆盖文件解析失败时静默回退默认配置，不阻断生成。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { stableHash } from './utils';

/** 工作流规则配置结构（正则均以字符串源表示，保证 JSON 可序列化与可哈希） */
export interface WorkflowRulesConfig {
  factGovernance: {
    /** 门槛型句式：比较限定词（不低于/不少于/不超过…），命中则数值为约束语义，剔除出裁决池 */
    thresholdComparison: string;
    /** 修正型句式：正式修正语（修正/调整/变更为…） */
    amendmentContext: string;
    /** 目标型句式：愿景/计划前缀（拟/规划/目标/力争…） */
    aspirationalPrefix: string;
    /** 修正型来源文件：补疑/答疑/澄清/补充/更正/修改 */
    addendumSource: string;
    /** 弱锚定阈值：数值与口径词间隔字符数超过该值视为弱锚定，裁决置信度降一级 */
    weakAnchorGapThreshold: number;
  };
  writingSpec: {
    /** 评标必查细目锚定清单：含这些词的输入细目必须保留为独立 H4 要点，不得被主题块聚类合并 */
    criticalSectionAnchors: string[];
    /** 关键小节判别正则源 */
    majorContentSection: string;
    divisionSection: string;
    divisionProcessLabel: string;
    /** 深度关键小节判别正则源（生成侧 blocker 门槛适用的标题集合） */
    criticalDeepSections: string[];
    /** 生成侧深度 blocker 门槛（最小字数） */
    blockerMinChars: { emergency: number; majorContent: number; division: number; focus: number };
    /** 分部分项专项验收阈值（4.17.9 起不再含箭头链环节数——工序顺序表达形式不限，见 hasProcessSequenceExpression） */
    divisionQuality: { blockerMinPackages: number; minPackages: number; minParamsPerPackage: number; minPackageChars: number; balanceRatio: number };
    /** 专项写法规则文本（迁自 chapterGeneration 硬编码提示词，单点化） */
    writeRules: { majorContent: string; division: string };
  };
}

/** 默认工作流规则（与历史硬编码值一致，是线上既有行为的等价迁移） */
export const DEFAULT_WORKFLOW_RULES: WorkflowRulesConfig = {
  factGovernance: {
    thresholdComparison: '不低于|不少于|不高于|不超过|不得少于|不得高于|不得小于|不小于|不大于|大于等于|小于等于|≥|≤|≧|≦|以上|及以上|以内|之内',
    amendmentContext: '修正|调整|变更|更改|更正|改为|澄清|更新|修订',
    aspirationalPrefix: '拟|规划|目标|力争|预计|期望|远期|未来|设想|建议|预期|争取|拟建|规划建设',
    addendumSource: '补疑|答疑|澄清|补充|更正|修改',
    weakAnchorGapThreshold: 9,
  },
  writingSpec: {
    criticalSectionAnchors: [
      '主要施工内容',
      '工程概况',
      '项目概况',
      '重点难点',
      '危大工程',
      '应急预案',
      '施工部署',
      '总平面',
      '主要分部分项工程施工方案',
      '主要施工方法',
    ],
    majorContentSection: '项目主要施工内容',
    divisionSection: '主要分部分项工程施工方案|主要施工方法',
    divisionProcessLabel: '工艺流程|施工流程',
    criticalDeepSections: [
      '项目特点.*重点.*难点|重点.*难点.*分析',
      '项目主要施工内容',
      '主要分部分项工程施工方案|主要施工方法',
      '危大工程专项施工方案审批流程',
      '原材料进场复试|见证取样',
    ],
    blockerMinChars: { emergency: 650, majorContent: 1800, division: 1200, focus: 1500 },
    divisionQuality: { blockerMinPackages: 3, minPackages: 5, minParamsPerPackage: 4, minPackageChars: 150, balanceRatio: 1 / 3 },
    writeRules: {
      majorContent: '【项目主要施工内容专项结构】只能根据绑定材料中的当前项目事实识别施工对象和工作包；不得套用固定行业模板，不得复述完整工程概况，不得写“以图纸清单为准”式空话；不得使用 Markdown 表格。必须按专业工程/分部分项工程逐项展开，每项使用“#### 工作包名称”作为三级小节标题，内容覆盖三方面要素：①作业对象与工程量（什么部位、什么规模）、②工序安排（先后顺序清晰）、③施工方法（怎么干、用什么参数验收）。呈现形式不限：可分段用“施工概况：/施工流程：/施工方法：”标签组织，也可按内容自然成文，三方面要素齐全、写法正确即可，标签只是可选的组织形式之一，不是硬性要求。工作包小节必须与上下文“主要施工工作包”列表一一对应，每个工作包只允许展开一次；严禁把同一个工作包以“X工程”“X工作包”两种口径重复写成两个小节，也不得新增图谱之外的工作包小节。作业对象与工程量要素必须写该工作包对应的本项目作业对象、部位、规模/工程量、材料设备或系统边界，写成连贯叙述，避免“xxx｜工程量”式清单原文罗列；工序要素必须有明确的工序顺序表达，形式由模型根据内容自然选择、不做统一要求——顺序词叙述（先测量放线，再基层处理，随后工序实施，然后检查验收）、编号步骤、有序/无序列表或箭头链（如“基层清理→放线定位→分层摊铺→碾压→压实度检测→验收”）均可，每个工作包至少 1 处不少于 4 个环节的工序顺序表达，不得只把工序顺序局限在一处标签段；施工方法要素写成连贯叙述，落到具体工具机具、测量/检测方法、工艺参数、材料规格、穿插关系、质量验收、复试检测和资料闭环，每个工作包施工方法宜落位至少 3 个具体工艺参数（厚度、间距、偏差、含水率、饱满度、坡度、压实度等），参数来自绑定材料或行业通用规范值，禁止“按规范施工”“结合实际执行”式空话，严禁把工程量清单条目原样罗列成“xxx：2台；xxx：1台；”式参数堆砌。施工方法写法样例（句式参照，内容按本项目事实替换）：“配电箱采用挂墙方式安装，箱体中心距地1.5m，盘面垂直度偏差不超过1.5/1000；柜内元器件按系统图接线，导线分色标识，接线紧固力矩按规格控制；安装完成后进行绝缘电阻测试并形成通电试运行记录。”至少形成 5 个施工工作包，工作包必须来自绑定材料证据。',
      division: '【主要分部分项工程施工方案专项要求】每个“#### 分项工程方案”三级小节内容需覆盖三方面要素：①作业对象与工程量（本项目作业对象、部位、工程量）、②工序安排（先后顺序清晰）、③施工方法（工具机具、材料规格、工艺参数、验收标准）。呈现形式不限：可分段用“施工概况/工艺流程/施工方法”标签组织，也可按内容自然成文，三方面要素齐全、写法正确即可。严禁用“**分项名**”粗体行代替“#### 分项名”小节标题，也不得把多个分项合并写在一个段落里。工序要素必须有明确的工序顺序表达，形式由模型根据内容自然选择、不做统一要求——顺序词叙述、编号步骤、有序/无序列表或箭头链（如“基层清理→放线定位→分层摊铺→碾压→压实度检测→验收”）均可，每个分项方案至少 1 处不少于 4 个环节的工序顺序表达，不得只把工序顺序局限在一处标签段；每个分项方案正文必须落位至少 4 个工艺参数（mm、MPa、间距、偏差、坡度、养护天数、试验压力、搭接长度等），参数来自绑定材料或行业通用规范值，不得编造；纯设备配置型小节必须写型号、规格、容量、数量参数；不得写“按规范施工”“结合实际执行”式空话。分项间深度必须均衡：门窗维修、立面修补、设备安装等小分项同样要写足作业对象、工序与工艺参数（每个分项不少于 150 字），不得一句话带过；严禁写“其他专业工序引用相应章节内容”“详见相关章节”等自我消解语，工序安排只能在本分项方案内展开，不得另行拆节复述。',
    },
  },
};

function projectRulesPath(projectRoot?: string) {
  if (!projectRoot) return undefined;
  return path.join(projectRoot, '.customize-agent', 'workflow-rules.json');
}

/** 逐层浅合并：项目覆盖只覆盖给出的键，缺失键回退默认值 */
function mergeRules(base: WorkflowRulesConfig, override: Partial<WorkflowRulesConfig> | undefined): WorkflowRulesConfig {
  if (!override) return base;
  const factGovernance = { ...base.factGovernance, ...(override.factGovernance || {}) };
  const blockerMinChars = { ...base.writingSpec.blockerMinChars, ...(override.writingSpec?.blockerMinChars || {}) };
  const divisionQuality = { ...base.writingSpec.divisionQuality, ...(override.writingSpec?.divisionQuality || {}) };
  const writeRules = { ...base.writingSpec.writeRules, ...(override.writingSpec?.writeRules || {}) };
  return {
    factGovernance,
    writingSpec: {
      ...base.writingSpec,
      ...(override.writingSpec || {}),
      blockerMinChars,
      divisionQuality,
      writeRules,
    },
  };
}

/** 项目级覆盖缓存（进程生命周期内不热更新） */
const rulesCache = new Map<string | undefined, WorkflowRulesConfig>();

/** 加载工作流规则：默认配置 + 项目级覆盖（.customize-agent/workflow-rules.json），解析失败静默回退 */
export function loadWorkflowRules(projectRoot?: string): WorkflowRulesConfig {
  const cached = rulesCache.get(projectRoot);
  if (cached) return cached;
  let rules = DEFAULT_WORKFLOW_RULES;
  const configPath = projectRulesPath(projectRoot);
  if (configPath && fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<WorkflowRulesConfig>;
      rules = mergeRules(DEFAULT_WORKFLOW_RULES, parsed);
    } catch {
      // 覆盖文件损坏时不阻断生成，回退默认规则
    }
  }
  rulesCache.set(projectRoot, rules);
  return rules;
}

/** 规则配置哈希：并入裁决缓存键，配置变化自动失效旧缓存（F3） */
export function workflowRulesHash(projectRoot?: string) {
  return stableHash(loadWorkflowRules(projectRoot));
}
