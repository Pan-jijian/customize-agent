/**
 * 渲染层（参数桶渲染、章/块切片、权威域注入、basis 行渲染、写时对齐对齐、must_cite 清单）——二期执行层输入
 *
 * S6 零行为拆分自 integratedBlueprint.ts（门面 re-export，对外导出不变）：仅机械搬迁，未改动任何语句与常量。
 */
import { buildAuthorityIndex, renderAuthorityDomains, renderAuthorityDomainsForBlock, type AuthorityDomain } from '../authorityIndex';
import { renderAuthorityPlaceholderCatalog } from './authorityPlaceholders';
import { parseChineseNumber } from '../budget';
import { THREE_SOURCE_WRITE_RULES } from '../writingSpec';
import { DEFAULT_SUBSECTION_TARGET_WORDS } from './capacity';
import type { BlueprintChapter, BlueprintData, BlueprintRequiredParam, BlueprintWorkPackage, IntegratedBlueprint } from './types';

// ═══════════════════════════════ 渲染函数（二期执行层输入） ═══════════════════════════════

/** 参数桶渲染：全文恒定段（各章写作 prompt 注入，同文档逐字节一致 → prefix cache 可命中） */
export function renderBlueprintDataText(data: BlueprintData): string {
  const lines: string[] = ['【一体化蓝图参数桶——全项目口径唯一权威源，正文引用必须与此一致，不得自行推导不同数值】'];
  lines.push('计划类数值（劳动力人数/工期/工程量/养护期）必须且只能引用以下锚点值：禁止将各工种人数相加推导峰值、禁止按定额自行估算、禁止改写锚点数值。');
  lines.push(`- 项目：${data.project.name}（${data.project.scope}）`);
  // V5 P2 数据驱动渲染：权威条目全量渲染（删除手写行与 12/15/10 物理截断——凡进蓝图 data 的
  // 对象自动进桶，渲染覆盖率测试防“数据有而桶无”复发）；非索引对象（检验批/决策锁/部署/重难点）紧随其后
  lines.push(...renderAuthorityDomains(buildAuthorityIndex(data)));
  if (data.inspectionBatches.length > 0) {
    lines.push(`- 检验批划分：${data.inspectionBatches.map(item => `${item.scope}——${item.planDesc}`).join('；')}`);
  }
  lines.push(`- 临时用电：${data.tempUtilities.powerLoad}`);
  lines.push(`- 临时用水：${data.tempUtilities.waterUsage}`);
  if (data.decisionLock.entries.length > 0) {
    lines.push(`- 关键决策锁：${data.decisionLock.entries.map(entry => `${entry.label}：${entry.values.join('、')}`).join('；')}`);
  }
  if (data.constructionDeployment.sections.length > 0) {
    lines.push(`- 施工部署：${data.constructionDeployment.flow}；施工顺序 ${data.constructionDeployment.sequence}`);
  }
  if (data.keyDifficulties.length > 0) {
    lines.push(`- 重难点（逐项列明）：${data.keyDifficulties.map(item => `${item.name}——${item.measure}`).join('；')}`);
  }
  lines.push(`- 金额禁区：${data.amountRule}`);
  lines.push(data.drawingNote);
  return lines.join('\n');
}

/** 块级聚焦参数桶（s1-slim 单块输入瘦身）：与 renderBlueprintDataText 同构、行文案同源，
 * 差异仅 quantity/material 域按块 token 条目级筛选 + 字符封顶（全量桶 36413 字符 → 块相关数千字符）。
 * 计划类恒定行（工期/劳动力峰值/机械/红线等）全量保留——它们是「计划类数值唯一口径」的可见性保障。 */
export function renderBlueprintDataTextForBlock(data: BlueprintData, options: { blockTokens: string[]; quantityCharsCap?: number; materialCharsCap?: number }): string {
  const lines: string[] = ['【一体化蓝图参数桶——全项目口径唯一权威源，正文引用必须与此一致，不得自行推导不同数值】'];
  lines.push('计划类数值（劳动力人数/工期/工程量/养护期）必须且只能引用以下锚点值：禁止将各工种人数相加推导峰值、禁止按定额自行估算、禁止改写锚点数值。');
  lines.push(`- 项目：${data.project.name}（${data.project.scope}）`);
  lines.push(...renderAuthorityDomainsForBlock(buildAuthorityIndex(data), options));
  if (data.inspectionBatches.length > 0) {
    lines.push(`- 检验批划分：${data.inspectionBatches.map(item => `${item.scope}——${item.planDesc}`).join('；')}`);
  }
  lines.push(`- 临时用电：${data.tempUtilities.powerLoad}`);
  lines.push(`- 临时用水：${data.tempUtilities.waterUsage}`);
  if (data.decisionLock.entries.length > 0) {
    lines.push(`- 关键决策锁：${data.decisionLock.entries.map(entry => `${entry.label}：${entry.values.join('、')}`).join('；')}`);
  }
  if (data.constructionDeployment.sections.length > 0) {
    lines.push(`- 施工部署：${data.constructionDeployment.flow}；施工顺序 ${data.constructionDeployment.sequence}`);
  }
  if (data.keyDifficulties.length > 0) {
    lines.push(`- 重难点（逐项列明）：${data.keyDifficulties.map(item => `${item.name}——${item.measure}`).join('；')}`);
  }
  lines.push(`- 金额禁区：${data.amountRule}`);
  lines.push(data.drawingNote);
  return lines.join('\n');
}

/** 章级数值锚点路由：权威域 → 章标题命中正则（确定性零 LLM；V5 P2 由 8 个手写 render
 * 升级为「域路由表 + 通用渲染器」——命中域的全部权威条目经 renderAuthorityDomains 聚焦注入）。
 * 路由只是「聚焦加分」，不是数据可见性门槛：未命中任何域的章仍在全局参数桶中看到全部权威；
 * 无路由的 domain 默认只进全局桶。行文案单一来源，与全局桶零漂移。 */
/**
 * 权威域注册表（G 线 P1-1）——**单一事实来源**，同时驱动「注入」与「写后确定性对齐」两条通道。
 *
 * ## 为什么必须统一
 *
 * 原实现有两条彼此不识的通道：
 * - **注入**：`AUTHORITY_DOMAIN_CHAPTER_ROUTES`，覆盖 11 个域，章标题命中即注入锚点行；
 * - **写后对齐**：`alignChapterContentToBlueprint` 里**硬编码 2 个域**（劳动力峰值、养护期），
 *   外加 `data.contract.total_days` 的特例分支。
 *
 * 于是「注入了锚点」与「写后会把错值纠回来」成了两件事：域可以只注入、不对齐，
 * 写作层写错后**没有任何确定性收口**——而两侧的章标题正则还是各写一份，改一处漏一处。
 * 本注册表把两条通道收进同一条声明：`chapterPattern` 同时用于注入与对齐路由，
 * `alignment` 声明该域写后对齐的锚点路径（缺省即**显式承认该域无写后对齐通道**）。
 *
 * ## 覆盖面差距是**显式**的
 *
 * 11 个域里目前只有 3 个（contract / labor / redline）声明了 alignment。这不是遗漏，
 * 是现状：其余域的权威值要么已在写作期强约束（锚点卡），要么尚无确定性对齐实现。
 * 把「没有」写成 `alignment: undefined` 而不是留白，是为了让差距可被统计与被审查——
 * `authorityDomainChannelReport()` 即输出该覆盖表，`assertAuthorityDomainChannels` 断言注册表自洽。
 */
export interface AuthorityDomainSpec {
  domain: AuthorityDomain;
  /** 章标题命中该正则：① 注入该域锚点行；② 若声明了 alignment 则参与写后对齐 */
  chapterPattern: RegExp;
  /**
   * 写后确定性对齐锚点（BlueprintRequiredParam.path）。缺省 = 该域**无**写后对齐通道，
   * 写作层写错后只能靠 S5 引用判定与终门禁兜底。
   */
  alignment?: { path: string };
}

export const AUTHORITY_DOMAIN_REGISTRY: readonly AuthorityDomainSpec[] = [
  { domain: 'contract', chapterPattern: /进度|工期|总体|部署|概况|工程|计划/u, alignment: { path: 'data.contract.total_days' } },
  { domain: 'schedule', chapterPattern: /进度|工期|部署|计划|总体|施工方案|分部分项/u },
  { domain: 'labor', chapterPattern: /劳动力|人员|资源|进度|工期|部署|概况/u, alignment: { path: 'data.resources.labor.peak_value' } },
  { domain: 'equipment', chapterPattern: /机械|设备|资源/u },
  { domain: 'material', chapterPattern: /物资|材料|资源|采购|亮化|路灯|照明/u },
  { domain: 'quantity', chapterPattern: /分部分项|施工方案|施工方法|土方|道路|管网|工程概况/u },
  { domain: 'spec', chapterPattern: /材料|物资|质量|技术|施工方案|分部分项/u },
  { domain: 'earthwork', chapterPattern: /土方|土石方|道路|管网|施工方案|分部分项/u },
  { domain: 'site', chapterPattern: /总平面|平面布置|临时设施|临时用地|驻地|堆场|加工区|施工方案/u },
  { domain: 'test', chapterPattern: /质量|试验|检测|验收/u },
  { domain: 'redline', chapterPattern: /绿化|种植|养护|苗木|技能|培训|成品保护|质量|亮化|路灯|照明|概况|工程|总体/u, alignment: { path: 'data.redline.greening_maintenance' } },
];

/** 注入路由（由注册表派生，行为与历史逐字一致） */
export const AUTHORITY_DOMAIN_CHAPTER_ROUTES: Array<{
  domain: AuthorityDomain;
  /** 章标题命中该正则注入该域锚点行 */
  chapterPattern: RegExp;
}> = AUTHORITY_DOMAIN_REGISTRY.map(spec => ({ domain: spec.domain, chapterPattern: spec.chapterPattern }));

/** 该章命中的、且声明了写后对齐的域锚点（写后对齐通道的路由来源） */
export function alignmentAnchorsForChapter(chapterTitle: string): string[] {
  return AUTHORITY_DOMAIN_REGISTRY
    .filter(spec => spec.alignment && spec.chapterPattern.test(chapterTitle))
    .map(spec => spec.alignment!.path);
}

/** 域级通道覆盖报告：哪些域有注入、哪些域**尚无**写后对齐（供诊断/审查显式看到差距） */
export function authorityDomainChannelReport(): { total: number; withAlignment: string[]; withoutAlignment: string[] } {
  const withAlignment = AUTHORITY_DOMAIN_REGISTRY.filter(spec => spec.alignment).map(spec => spec.domain);
  return {
    total: AUTHORITY_DOMAIN_REGISTRY.length,
    withAlignment,
    withoutAlignment: AUTHORITY_DOMAIN_REGISTRY.filter(spec => !spec.alignment).map(spec => spec.domain),
  };
}

/** 注册表自洽断言：域唯一、正则非空（供单测与发版前复核；不参与运行时链路） */
export function assertAuthorityDomainChannels(): void {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const spec of AUTHORITY_DOMAIN_REGISTRY) {
    if (seen.has(spec.domain)) errors.push(`权威域重复声明：${spec.domain}`);
    seen.add(spec.domain);
    if (!(spec.chapterPattern instanceof RegExp)) errors.push(`权威域 ${spec.domain} 的 chapterPattern 非正则`);
    if (spec.chapterPattern && spec.chapterPattern.global) errors.push(`权威域 ${spec.domain} 的 chapterPattern 带 g 标志（test 会因 lastIndex 抖动，路由不可复现）`);
  }
  if (errors.length > 0) throw new Error(`权威域注册表不自洽（${errors.length} 项）：${errors.join('；')}`);
}

/** 编制依据小节路由（basis_regulations 非索引对象特例：数据源 data.basisRegulations 而非索引） */
const BASIS_REGULATIONS_CHAPTER_PATTERN = /编制|工程概况|项目概况|概况|说明/u;

/** 编制依据小节锚点行：法规/条例/规范由写作模型依据行业公共知识自行列写（不得喂确定性清单，
 * 清单注入会限制模型结合项目实际情况的取舍）；本锚点只给写作要求与项目专属事实——招标文件
 * 引用法规必须照抄；类别话术（「国家现行法律、行政法规」等无具体名称表述）严禁空写，
 * 交付前由 basisRegulationsCoverageIssues 确定性兑底。 */
function renderBasisRegulationsLines(data: BlueprintData): string[] {
  const rows: string[] = [];
  if ((data.basisRegulations ?? []).length > 0) {
    rows.push(`- 招标文件引用法规（项目专属事实，编制依据小节必须列出法规名称及文号）：${data.basisRegulations.join('、')}`);
  }
  rows.push('- 编制依据小节由写作模型自行列写：国家法律法规及文号、工程所在地地方性法规、与本工程分部对应的现行施工验收规范名称及编号；不得空写「国家现行法律、行政法规」等类别话术，不得编造文号');
  return rows;
}

/** 施工验收规范确定性映射已移除（十度实测缺陷治理决策）：规范由写作模型依据行业公共知识
 * 自行列写，不得喂确定性清单；稳定性由交付前检测 basisRegulationsCoverageIssues 兑底。 */

/** 章级数值锚点卡：本章命中的权威域聚焦渲染 + 编制依据特例段（写作层强约束，禁止自行推导/加总/估算）。
 * 章标题未命中任何域且非编制依据章时返回空串（非数值章不注入，避免长文稀释注意力）。 */
export function renderBlueprintChapterAuthorityCard(chapter: BlueprintChapter, data: BlueprintData): string {
  const domains = AUTHORITY_DOMAIN_CHAPTER_ROUTES
    .filter(route => route.chapterPattern.test(chapter.title))
    .map(route => route.domain);
  const lines = renderAuthorityDomains(buildAuthorityIndex(data), domains);
  if (BASIS_REGULATIONS_CHAPTER_PATTERN.test(chapter.title)) {
    lines.push(...renderBasisRegulationsLines(data));
  }
  // G 线 P2-1 占位符协议：本章命中的、且有权威值的域锚点以 `{{AUTH:<path>}}` 目录形式给出，
  // 要求模型**引用占位符而不是自己写数**——数值的产出方从 LLM 换成权威层（生成后确定性填充）。
  // 目录只列有权威值的 path（列了填不进的会自造未决告警）。
  const placeholderPaths = alignmentAnchorsForChapter(chapter.title);
  const catalog = placeholderPaths.length > 0 ? renderAuthorityPlaceholderCatalog(placeholderPaths, data) : [];
  if (catalog.length > 0) {
    lines.push('【数值占位符协议】下列计划类数值请**原样写出占位符**，不要自行写数（生成后由系统确定性填充为权威值）：', ...catalog);
  }
  if (lines.length === 0) return '';
  return [
    '【本章数值锚点——计划类数值必须且只能引用以下锚点值；禁止将各工种人数相加推导峰值、禁止按定额自行估算、禁止改写或自设任何计划类数值】',
    ...lines,
  ].join('\n');
}

/** 章切片渲染：该章 sub_sections + work_packages 展开为「本项目专属事实」文本（执行层只读切片写作）。
 * data 传入时尾部追加章级数值锚点卡。 */
export function renderBlueprintChapterSlice(chapter: BlueprintChapter, data?: BlueprintData): string {
  // M4·写作三源规则：章切片权威提示与全局写作提示词（FORMAL_WRITING_RULES）共用同一份三源规则模板，
  // 写作层在本章看到的全部计划类数值均以切片与章域卡为准，禁止按定额重算（跨工程串位/口径分裂的提示词级防线）
  const lines: string[] = [
    `【第 ${chapter.id} 章「${chapter.title}」蓝图切片——以下项目专属事实由蓝图冻结锁定，正文必须一致引用】`,
    THREE_SOURCE_WRITE_RULES,
  ];
  for (const subSection of chapter.subSections) {
    lines.push(`\n## ${subSection.id} ${subSection.title}（目标 ${subSection.targetWords ?? DEFAULT_SUBSECTION_TARGET_WORDS} 字）`);
    const mustCite = subSection.requiredParams.filter(param => param.mode === 'must_cite').map(param => param.path);
    if (mustCite.length > 0) lines.push(`must_cite 参数（正文必须出现且与蓝图一致）：${mustCite.join('、')}`);
    for (const workPackage of subSection.workPackages) {
      lines.push(...renderWorkPackageLines(workPackage));
    }
  }
  const authorityCard = data ? renderBlueprintChapterAuthorityCard(chapter, data) : '';
  return [lines.join('\n'), authorityCard].filter(Boolean).join('\n\n');
}

/** 工作包详情行渲染（章切片/块级切片共用，行文案单一来源） */
function renderWorkPackageLines(workPackage: BlueprintWorkPackage): string[] {
  const lines: string[] = [`\n### 工作包：${workPackage.name}（${workPackage.kind === 'major' ? '主要' : '一般'}工作包）`];
  const quantityText = Object.entries(workPackage.quantities).map(([name, quantity]) => `${name} ${quantity.value}${quantity.unit}`).join('、');
  if (quantityText) lines.push(`- 工程量：${quantityText}`);
  if (workPackage.processChain.length > 0) lines.push(`- 工序链：${workPackage.processChain.join(' → ')}`);
  if (workPackage.methods.length > 0) lines.push(`- 施工方法（清单特征原文）：${workPackage.methods.join('；')}`);
  if (workPackage.params.length > 0) lines.push(`- 工艺参数：${workPackage.params.map(param => `${param.key}=${param.value}`).join('；')}`);
  if (workPackage.acceptance.length > 0) lines.push(`- 验收要求：${workPackage.acceptance.join('；')}`);
  if (workPackage.standards.length > 0) lines.push(`- 规范依据：${workPackage.standards.join('；')}`);
  return lines;
}

/** 块级切片渲染参数 */
export interface BlueprintBlockSliceOptions {
  /** 块标题（主题块 H3 标题） */
  blockTitle: string;
  /** 块内要点标题（H4 覆盖清单=骨架名同源） */
  subPointTitles: string[];
  /** 骨架名（工作包级块的可选补充匹配源） */
  skeletonNames?: string[];
  /** 切片字符封顶（默认 6000；超出按行级截断） */
  sliceCharsCap?: number;
}

/** 块级切片渲染（s1-slim 单块输入瘦身）：整章 103488 字符切片 → 只展开与块相关的工作包（实测块相关 5~10 个）。
 * 章级头部（三源规则/must_cite 汇总）与章域卡保留；无匹配工作包的块（容器块/总述块）给一行式工作包索引，
 * 不展开细节——容器块本就不得复写单个分部方案（divisionContainerOverviewPrompt 同口径）。 */
export function renderBlueprintBlockSlice(chapter: BlueprintChapter, data: BlueprintData, options: BlueprintBlockSliceOptions): string {
  const tokens = [options.blockTitle, ...options.subPointTitles, ...(options.skeletonNames ?? [])]
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  const matchesToken = (name: string): boolean => tokens.some(token => name.includes(token) || token.includes(name));
  const head: string[] = [
    `【第 ${chapter.id} 章「${chapter.title}」蓝图切片（本节聚焦）——以下项目专属事实由蓝图冻结锁定，正文必须一致引用】`,
    THREE_SOURCE_WRITE_RULES,
  ];
  const body: string[] = [];
  const mustCiteAll = [...new Set(chapter.subSections.flatMap(section => section.requiredParams.filter(param => param.mode === 'must_cite').map(param => param.path)))];
  if (mustCiteAll.length > 0) body.push(`本章 must_cite 参数（正文必须出现且与蓝图一致）：${mustCiteAll.join('、')}`);
  const sectionBlocks: string[] = [];
  for (const subSection of chapter.subSections) {
    const hits = subSection.workPackages.filter(workPackage => matchesToken(workPackage.name));
    if (hits.length === 0) continue;
    const lines: string[] = [`## ${subSection.id} ${subSection.title}`];
    const sectionMustCite = subSection.requiredParams.filter(param => param.mode === 'must_cite').map(param => param.path);
    if (sectionMustCite.length > 0) lines.push(`must_cite 参数：${sectionMustCite.join('、')}`);
    for (const workPackage of hits) lines.push(...renderWorkPackageLines(workPackage));
    sectionBlocks.push(lines.join('\n'));
  }
  const workPackageCount = chapter.subSections.reduce((sum, sub) => sum + sub.workPackages.length, 0);
  if (sectionBlocks.length === 0 && workPackageCount > 0) {
    const indexLines: string[] = [];
    for (const subSection of chapter.subSections) {
      const names = subSection.workPackages.map(workPackage => {
        const entries = Object.entries(workPackage.quantities);
        const quantityText = entries.slice(0, 3).map(([name, quantity]) => `${name} ${quantity.value}${quantity.unit}`).join('、');
        return quantityText ? `${workPackage.name}（${quantityText}${entries.length > 3 ? ' 等' : ''}）` : workPackage.name;
      });
      if (names.length > 0) indexLines.push(`- ${subSection.title}：${names.join('；')}`);
    }
    body.push(`【本章工作包索引（本节为章级总述/无专属工作包；各工作包详细参数见本章其他小节，本节不得复写单个分部方案）】\n${indexLines.join('\n')}`);
  } else {
    body.push(...sectionBlocks);
  }
  const authorityCard = renderBlueprintChapterAuthorityCard(chapter, data);
  // 行级封顶只作用于工作包展开段（body）：恒定段（头部三源规则 + 章域数值锚点卡/编制依据清单）
  // 是本章数值与编制依据的唯一可引口径，被截断即写手不可见——4.43 实测：工程概况章锚点卡
  // 10320 字符（工程量域 130 条全量渲染）超封顶 6000，编制依据 14 条法规清单随卡末尾被整体
  // 截掉，编制依据小节只剩类别话术（5 项 blocker 根因）；数值自编类缺陷同源。
  // body 超限仍按行截断加提示（保留前部内容）。
  const cap = options.sliceCharsCap ?? 6000;
  let bodyText = body.join('\n\n');
  if (bodyText.length > cap) {
    const kept: string[] = [];
    let total = 0;
    for (const line of bodyText.split('\n')) {
      if (total + line.length + 1 > cap) break;
      kept.push(line);
      total += line.length + 1;
    }
    bodyText = `${kept.join('\n')}\n（本节蓝图切片过长已截断，未展开工作包见本章其他小节与绑定材料）`;
  }
  return [...head, bodyText, authorityCard].filter(Boolean).join('\n\n');
}

/** 正则元字符转义（蓝图引用对齐锚定词安全） */
function escapeRegexForAlign(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 单位变体归一（与修复器 quantityUnitVariants 同源，零漂移实测）：清单单位 m2/m3/t 与正文
 *  上标写法（m²/㎡/m³）同义——检测正则只认一种写法时，上标值不入候选，分部拆分豁免
 *  （压膜 404.4+730=1134.4）无法触发导致误报「压膜 404.4」 */
export function quantityUnitDetectVariants(unit: string): string {
  const normalized = unit.trim().toLowerCase();
  if (/(?:m2|m²|㎡)/.test(normalized)) return '(?:㎡|m²|m2)';
  if (/(?:m3|m³)/.test(normalized)) return '(?:m³|m3)';
  if (normalized === 't' || normalized === '吨') return '(?:吨|t)';
  return escapeRegexForAlign(unit);
}

/** 章切片匹配：按模板章标题在蓝图大纲中定位章切片（构建时 title 即模板原始标题） */
export function findBlueprintChapter(blueprint: IntegratedBlueprint, chapterTitle: string): BlueprintChapter | undefined {
  const exact = blueprint.outline.chapters.find(chapter => chapter.title === chapterTitle);
  if (exact) return exact;
  return blueprint.outline.chapters.find(chapter => chapterTitle.includes(chapter.title) || chapter.title.includes(chapterTitle));
}

/** 蓝图引用对齐（二期切换·S5 收口）：章成稿后 must_cite+strict 参数数值与蓝图不一致时确定性回填
 * （只替换数字本身、不动句式，与 planDataMaster 对齐同构；权威源为蓝图 data）；
 * 未出现（missing）仅报告不阻断（缺口数字反馈与修复链兜底）。
 * 只覆盖 total_days / labor_peak_value / greening_maintenance 三类窄语境（「工期/高峰人数/养护年」
 * 词锚后紧跟数值，语义无歧义）；工程量（data.quantities.*）不在此写时直替——名称后首个「数值+单位」
 * 无法区分工程量与检测频次/分工程明细/批次描述，实测将「每20931.02m²不少于1点」的频次改成工程量
 * （2026-09 审计确认）；工程量不一致引用交 S5 判定链（collectBlueprintCitationCandidates → LLM 三态
 * → conflict 锚点 → fixQuantityAuthorityConflicts）统一裁决。 */
export function alignChapterContentToBlueprint(markdown: string, chapter: BlueprintChapter, data: BlueprintData): { markdown: string; fixed: Array<{ anchor: string; from: string; to: string }>; missing: string[] } {
  const fixed: Array<{ anchor: string; from: string; to: string }> = [];
  const missing: string[] = [];
  let result = markdown;
  const mustCiteStrict = chapter.subSections.flatMap(section => section.requiredParams.filter(param => param.mode === 'must_cite' && param.strict));
  // 域级锚点（章标题命中即对齐，不依赖 requiredParams 声明）：劳动力峰值/养护期是写作层高频自编数值，
  // 蓝图权威为唯一口径——章标题命中域即强制对齐（检测定位=修复定位同源锚点，与数值锚点卡注入同域）。
  // G 线 P1-1/P1-8：域级锚点由**权威域注册表**派生（与注入通道同源单声明），
  // 不再在两条通道各写一份章标题正则——历史缺陷正是两处正则各改各的、改一处漏一处。
  // 取值守卫（如劳动力峰值 <= 0 时跳过）留在下方 switch 的取值逻辑里，不在此重复判断。
  const domainAnchors: BlueprintRequiredParam[] = alignmentAnchorsForChapter(chapter.title)
    .map(path => ({ path, mode: 'must_cite' as const, strict: true }));
  const alignedParams = [...mustCiteStrict, ...domainAnchors];
  const seen = new Set<string>();
  for (const param of alignedParams) {
    if (seen.has(param.path)) continue;
    seen.add(param.path);
    if (param.path === 'data.contract.total_days') {
      if (data.contract.totalDays <= 0) continue;
      const dayRe = /(?:总工期|施工工期|合同工期|工期)(?:为|约|共计|控制)?[^\n。；;]{0,20}?(\d+(?:\.\d+)?)\s*(?:日历)?天/gu;
      let matched = false;
      result = result.replace(dayRe, (line, rawValue: string) => {
        matched = true;
        const value = Number(rawValue);
        if (value === data.contract.totalDays || value <= 0) return line;
        fixed.push({ anchor: '总工期', from: `${value}天`, to: `${data.contract.totalDays}天` });
        return line.replace(rawValue, String(data.contract.totalDays));
      });
      if (!matched) missing.push(`总工期 ${data.contract.totalDays} 日历天`);
      continue;
    }
    if (param.path === 'data.resources.labor.peak_value') {
      const peakValue = data.resources.labor.peakValue;
      if (peakValue <= 0) continue;
      // 峰值形态覆盖：「高峰人数 N 人」「峰值 N 人」「劳动力总人数 N 人」「各专业班组高峰人数合计为 N 人」
      // ——只替换数值本身、不动句式（「合计为/控制在」等隔断词不阻断锚定，替换后句式仍成立）
      const peakRe = /(?:高峰(?:期)?(?:人数)?|峰值|劳动力(?:总人数|峰值)|各专业班组高峰人数)[^。；;\n]{0,24}?(?:约)?\s*([\d,]+)\s*人/gu;
      let matched = false;
      result = result.replace(peakRe, (line, rawValue: string) => {
        matched = true;
        const value = Number(String(rawValue).replace(/,/g, ''));
        if (!Number.isFinite(value) || value === peakValue || value <= 0) return line;
        fixed.push({ anchor: '劳动力峰值', from: `${rawValue}人`, to: `${peakValue}人` });
        return line.replace(rawValue, String(peakValue));
      });
      if (!matched) missing.push(`劳动力峰值 ${peakValue} 人`);
      continue;
    }
    if (param.path === 'data.redline.greening_maintenance') {
      // 养护期权威：redLineFacts「绿化养护期=二级养护，养护二年」提取年数，正文「养护…X年」与权威不一致时回填
      const maintenanceFact = data.redLineFacts.find(fact => /养护/u.test(fact.key));
      if (!maintenanceFact) continue;
      const authorityMatch = /养护[^。；;|]{0,10}?([一二两三四五六七八九十]+|\d{1,2})\s*年/u.exec(maintenanceFact.value);
      if (!authorityMatch) continue;
      const authorityYears = parseChineseNumber(authorityMatch[1] ?? '');
      if (authorityYears === undefined || !Number.isFinite(authorityYears) || authorityYears <= 0) continue;
      const yearRe = /养护[^。；;\n|]{0,16}?([一二两三四五六七八九十]+|\d{1,2})\s*年/gu;
      let matched = false;
      result = result.replace(yearRe, (line, rawValue: string) => {
        matched = true;
        const value = parseChineseNumber(rawValue);
        if (value === undefined || !Number.isFinite(value) || value === authorityYears || value <= 0) return line;
        fixed.push({ anchor: '养护期', from: `${rawValue}年`, to: `${authorityYears}年` });
        return line.replace(rawValue, String(authorityYears));
      });
      if (!matched) missing.push(`养护期 ${authorityYears} 年`);
      continue;
    }
  }
  return { markdown: result, fixed, missing };
}

/** 章切片 must_cite+strict 参数渲染为「必须引用的数值清单」
 * （块质检第二轮反馈挂接用：未引用时定向反馈重试，不盲目重写） */
export function renderBlueprintMustCiteValues(chapter: BlueprintChapter, data: BlueprintData): string {
  const seen = new Set<string>();
  const values: string[] = [];
  const mustCiteStrict = chapter.subSections.flatMap(section => section.requiredParams.filter(param => param.mode === 'must_cite' && param.strict));
  for (const param of mustCiteStrict) {
    if (seen.has(param.path)) continue;
    seen.add(param.path);
    if (param.path === 'data.contract.total_days' && data.contract.totalDays > 0) {
      values.push(`总工期 ${data.contract.totalDays} 日历天`);
      continue;
    }
    if (param.path.startsWith('data.quantities.')) {
      const quantity = data.quantities[param.path.slice('data.quantities.'.length)];
      if (quantity && quantity.value > 0) values.push(`${param.path.slice('data.quantities.'.length)} ${quantity.value}${quantity.unit}`);
    }
  }
  return values.join('；');
}
