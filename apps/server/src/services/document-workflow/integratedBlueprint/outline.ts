/**
 * 阶段 B/C 大纲与配方（章节激活裁剪、施工方法小节、工作包组装）与章规划确定性转换（蓝图切片 → 主题块结构，语义域回退）
 *
 * S6 零行为拆分自 integratedBlueprint.ts（门面 re-export，对外导出不变）：仅机械搬迁，未改动任何语句与常量。
 */
import { majorConstructionSkeletonNames, parseMajorConstructionPackages } from '../chapterPostProcessing';
import { matchProcessKnowledgeCards } from '../constructionProcessKnowledge';
import { disambiguateBlockTitles } from '../sectionNamingGovernance';
import { normalizeSubsectionTitleForDedup } from '../utils';
import { DIVISION_SECTION_RE, MAJOR_CONTENT_SECTION_RE, isCriticalSectionTitle } from '../writingSpec';
import type { BillOfQuantitiesResult, BoqEntry } from '../billOfQuantitiesParser';
import type { DocumentEvidence } from '../types';
import { buildThemedBlocksForSubSection, bigramOverlap, capacityPlanChapterBlocks, isClimateClassPointTitle, isContainerSectionTitle, isResourceTriadSection, mergeUniqueSkeletonNames, sameSectionText, sectionDomain, CAPACITY_MAX_BLOCK_WORDS, CAPACITY_MIN_BLOCK_WORDS, CAPACITY_SKELETON_WORDS_PER_PACKAGE, DEFAULT_SUBSECTION_TARGET_WORDS, MAX_SUB_POINTS_PER_BLOCK, TITLE_MERGE_OVERLAP_THRESHOLD } from './capacity';
import type { PlannedChapterBlock, PlannedChapterSubPoint, PlannedChapterStructure } from './capacity';
import { extractFeatureClauses, extractMethodPhrases } from './parse';
import type { BlueprintChapter, BlueprintOutline, BlueprintSubSection, BlueprintWorkPackage, BlueprintWorkPackageQuantity } from './types';

// ═══════════════════════════════ 阶段 B：outline 大纲规划（一期确定性映射） ═══════════════════════════════

/** 三期收口：docType 章节激活裁剪——专项施工方案类文档不承接总平面布置/施工部署类章节（单位工程施工组织设计全激活） */
function resolveChapterActivation(docType: string, chapterTitle: string): boolean {
  if (/专项施工方案|专项方案|危大/u.test(docType) && /总平面|平面布置|施工部署|总体部署/u.test(chapterTitle)) return false;
  return true;
}

/** 清单分部名 → 大纲小节名规范化（丰乐镇实测：清单「八、其他」分部把房前屋后整理/墙面彩绘/杆线整治/
 * 仿木护栏等环境整治条目归入「其他」——计量分部名不是大纲小节名，按条目内容确定性归纳更名；
 * round-27 扩展：房建定额子分部名同样需要规范化——「其他装饰工程」→零星装饰工程、
 * 「措施项目」（模板/脚手架/化粪池费用分部）→按条目归纳、「墙柱面装饰与隔断幕墙工程」无幕墙时去幕墙措辞） */
function normalizeConstructionSectionTitle(section: string, entries: BoqEntry[]): string {
  const trimmed = section.trim();
  if (/^其他$|^其他工程$/u.test(trimmed)) {
    const names = entries.map(entry => entry.name);
    if (names.some(name => /彩绘|护栏|围栏|小品|标识|标牌|墙面|整治/u.test(name))) return '环境整治工程';
    if (names.some(name => /绿化|栽植|铺装|种植/u.test(name))) return '景观附属工程';
    if (names.some(name => /拆除|清理|清淤|清运/u.test(name))) return '清理整治工程';
    return '零星工程';
  }
  if (/^其他装饰/u.test(trimmed)) return '零星装饰工程';
  if (/^措施项目$/u.test(trimmed)) {
    const names = entries.map(entry => entry.name);
    if (names.some(name => /化粪池|吊装|安装/u.test(name))) return '模板、脚手架及化粪池安装工程';
    return '模板与脚手架工程';
  }
  if (/墙[、,]?柱面装饰/u.test(trimmed)) {
    const hasCurtainWall = entries.some(entry => /幕墙|隔断/u.test(entry.name));
    return hasCurtainWall ? trimmed : '墙柱面装饰工程';
  }
  return trimmed;
}

/** 施工方法章小节构建：顶层小节 = 清单分部/单位工程（计量分部名规范化后的大纲小节）；
 * 单位工程（如「2.3 公厕」）内部子分部聚合为小节下子工作包（作为小节内主题块要点），
 * 不再平铺成独立小节（历史缺陷：公厕 15 个子分部升级为 15 个章级小节，房建通用分部名
 * 「门窗工程/墙柱面装饰与隔断幕墙工程」混入美丽乡村项目大纲） */
function buildConstructionMethodSubSections(boq: BillOfQuantitiesResult, chapterId: string): BlueprintSubSection[] {
  const sectionGroups = new Map<string, BoqEntry[]>();
  for (const entry of boq.entries) {
    // 无分部分节结构的条目不参与分桶：不合成「未分部条目」占位小节（系统不创作结构）——
    // 无小节可归属时不进入本章，由覆盖校验按无结构条目豁免；有真实分部的条目正常分桶
    if (!entry.section) continue;
    const list = sectionGroups.get(entry.section) || [];
    list.push(entry);
    sectionGroups.set(entry.section, list);
  }
  const subSections: BlueprintSubSection[] = [];
  let subIndex = 0;
  for (const [section, entries] of sectionGroups) {
    const title = normalizeConstructionSectionTitle(section, entries);
    const isUnitProject = entries.some(entry => entry.sectionKind === 'unit-project');
    const packages: BlueprintWorkPackage[] = [];
    if (isUnitProject) {
      // 单位工程小节：内部子分部（subsection）各为一个工作包，小节内按子分部展开要点
      const bySub = new Map<string, BoqEntry[]>();
      for (const entry of entries) {
        const key = entry.subsection || title;
        const list = bySub.get(key) || [];
        list.push(entry);
        bySub.set(key, list);
      }
      for (const [subName, subEntries] of bySub) {
        // round-27：子分部名同走清单分部名规范化（措施项目→模板脚手架工程、其他装饰工程→零星装饰工程）
        packages.push(buildWorkPackageFromBoqSection(normalizeConstructionSectionTitle(subName, subEntries), subEntries));
      }
    } else {
      packages.push(buildWorkPackageFromBoqSection(title, entries));
    }
    subIndex += 1;
    subSections.push({
      id: `${chapterId}.${subIndex}`,
      title,
      targetWords: DEFAULT_SUBSECTION_TARGET_WORDS,
      requiredParams: packages.flatMap(workPackage => Object.keys(workPackage.quantities).slice(0, 5).map(quantityName => ({ path: `data.quantities.${quantityName}`, mode: 'must_cite' as const, strict: true }))),
      tablePlans: [],
      workPackages: packages,
    });
  }
  return subSections;
}

/** 阶段 B：模板章节目录 → 蓝图大纲（工作包骨架挂接） */
export function buildBlueprintOutline(input: {
  chapterTitles: string[];
  boq: BillOfQuantitiesResult;
  docType: string;
}): BlueprintOutline {
  const { chapterTitles, boq } = input;
  const chapters: BlueprintChapter[] = chapterTitles.map((title, index) => {
    const id = String(index + 1);
    // 主要施工方法章承接全部工作包（确定性挂接：清单分部 → 工作包）。
    // 丰乐镇三期验收实测：泛匹配「主要施工」把「拟投入的主要施工机械、设备计划」误判为施工方法章，
    // 23 个清单分部串入机械章（4.1 道路工程…4.23 管网工程）；机械章无「分部分项/施工方案/施工方法」完整词，泛词已删除
    const isConstructionChapter = /主要分部分项|施工方案|施工方法/u.test(title);
    const subSections: BlueprintSubSection[] = isConstructionChapter ? buildConstructionMethodSubSections(boq, id) : [];
    return { id, title, isActive: resolveChapterActivation(input.docType, title), requiredParams: [], subSections };
  });
  return { chapters };
}

// ═══════════════════════════════ 阶段 C：节级配方补全（清单条目原序归纳，确定性） ═══════════════════════════════

/** 阶段 C：清单分部条目 → 工作包（工序链按清单条目原序、参数/做法按特征原文提取、知识卡补验收与规范） */
export function buildWorkPackageFromBoqSection(section: string, entries: BoqEntry[]): BlueprintWorkPackage {
  const sorted = [...entries].sort((left, right) => left.seq - right.seq);
  const quantities: Record<string, BlueprintWorkPackageQuantity> = {};
  const byName = new Map<string, number>();
  for (const entry of sorted) {
    if (!entry.name) continue;
    byName.set(entry.name, (byName.get(entry.name) || 0) + entry.quantity);
  }
  for (const [name, total] of byName) {
    const unit = sorted.find(entry => entry.name === name)?.unit || '';
    quantities[name] = { value: Math.round(total * 1000) / 1000, unit };
  }
  // 工序链：清单条目名称原序（去重），条目名称即工序动作
  const processChain = [...new Set(sorted.map(entry => entry.name).filter(Boolean))].slice(0, 16);
  const methods = extractMethodPhrases(sorted);
  const params: BlueprintWorkPackage['params'] = [];
  const seenParams = new Set<string>();
  for (const entry of sorted) {
    for (const clause of extractFeatureClauses(entry.description)) {
      const dedupeKey = `${clause.key}=${clause.value}`;
      if (seenParams.has(dedupeKey)) continue;
      seenParams.add(dedupeKey);
      params.push({ key: clause.key, value: clause.value, source: 'boq' });
      if (params.length >= 24) break;
    }
    if (params.length >= 24) break;
  }
  // 验收：清单特征验收类条款（压实度/试验/隐蔽） + 知识卡补
  const acceptance: string[] = [];
  for (const entry of sorted) {
    const clauses = extractFeatureClauses(entry.description);
    for (const clause of clauses) {
      if (/压实|试验|检测|验收|闭水|合格/u.test(`${clause.key}${clause.value}`) && acceptance.length < 12 && !acceptance.includes(clause.value)) {
        acceptance.push(clause.value);
      }
    }
  }
  const knowledgeCards = matchProcessKnowledgeCards([section]);
  const standards: string[] = [];
  if (acceptance.length === 0 && knowledgeCards.length > 0) {
    acceptance.push(...knowledgeCards[0].acceptance.slice(0, 6).map(item => `${item}（知识卡）`));
  }
  for (const card of knowledgeCards.slice(0, 2)) {
    for (const standard of card.standards) {
      if (!standards.includes(standard)) standards.push(standard);
    }
  }
  return {
    name: section,
    kind: 'major',
    quantities,
    processChain,
    methods,
    params,
    acceptance,
    standards,
    source: 'boq',
    coveredSeqs: sorted.map(entry => entry.seq),
  };
}

/** 阶段 C 回退：现有 parseMajorConstructionPackages 产物直填（蓝图工作包解析失败时启用） */
export function fallbackWorkPackagesFromExisting(projectContext: string): BlueprintWorkPackage[] {
  try {
    const packages = parseMajorConstructionPackages(projectContext);
    return packages.map(workPackage => ({
      name: workPackage.name,
      kind: 'major' as const,
      quantities: {},
      processChain: workPackage.process || [],
      methods: [],
      params: (workPackage.quantities || []).map(item => ({ key: item, value: item, source: 'boq' as const })),
      acceptance: workPackage.acceptance || [],
      standards: [],
      source: 'fallback' as const,
      coveredSeqs: [],
    }));
  } catch {
    return [];
  }
}

/** 确定性回退结构：蓝图切片不可用时按语义域分组，域内高相似细目合并进同一 H4（每块 ≤6 个 H4）；
 * 块顺序严格保持 inputSections 原顺序（域块取该域首次出现位置）——历史实现把人材机/容器块
 * 无条件前置，推翻了规划层 prioritizeOverviewSections 的调序（第一章 1.1 应为「编制说明与工程概况」） */
export function fallbackStructureForSections(inputSections: string[], chapterTitle: string, targetWords: number): PlannedChapterStructure {
  const byDomain = new Map<string, string[]>();
  // 成块单元顺序：人材机三小节与工作包容器小节各自独立成块（H3），普通小节按语义域聚合成块；
  // 单元按 inputSections 首次出现顺序登记（域块位置 = 该域第一个小节的位置）
  const unitOrder: Array<{ kind: 'solo'; section: string } | { kind: 'domain'; key: string }> = [];
  for (const section of inputSections) {
    if (isResourceTriadSection(section) || MAJOR_CONTENT_SECTION_RE.test(section) || DIVISION_SECTION_RE.test(section)) {
      unitOrder.push({ kind: 'solo', section });
      continue;
    }
    const key = sectionDomain(section);
    if (!byDomain.has(key)) {
      byDomain.set(key, []);
      unitOrder.push({ kind: 'domain', key });
    }
    byDomain.get(key)!.push(section);
  }
  // 域内确定性合并：与上一条细目互为包含或二字滑窗重叠率 ≥75% 时并入同一 H4（无 LLM 可用时仍保持目录瘦身）；关键细目不参与合并
  const mergeDomainSections = (items: string[]): PlannedChapterSubPoint[] => {
    const merged: PlannedChapterSubPoint[] = [];
    for (const section of items) {
      const last = merged[merged.length - 1];
      const lastSource = last ? last.sources[last.sources.length - 1] : '';
      if (!isCriticalSectionTitle(section) && !isResourceTriadSection(section) && last && (sameSectionText(section, lastSource) || bigramOverlap(section, lastSource) >= TITLE_MERGE_OVERLAP_THRESHOLD)) {
        last.sources.push(section);
        if (section.length > last.title.length) last.title = section;
      } else {
        merged.push({ title: section, sources: [section] });
      }
    }
    return merged;
  };
  const blocks: PlannedChapterBlock[] = [];
  for (const unit of unitOrder) {
    if (unit.kind === 'solo') {
      blocks.push({ title: unit.section, subPoints: [{ title: unit.section, sources: [unit.section] }], facts: [], targetWords: 0 });
      continue;
    }
    const mergedPoints = mergeDomainSections(byDomain.get(unit.key) || []);
    for (let offset = 0; offset < mergedPoints.length; offset += MAX_SUB_POINTS_PER_BLOCK) {
      const chunk = mergedPoints.slice(offset, offset + MAX_SUB_POINTS_PER_BLOCK);
      blocks.push({ title: chunk[0].title || chapterTitle, subPoints: chunk, facts: [], targetWords: 0 });
    }
  }
  // 容量规划：章目标一次成型分配（幂等；蓝图路径末尾统一规划时重算结果一致）
  capacityPlanChapterBlocks(blocks, targetWords);
  return { blocks, coveredSections: inputSections.slice(), fallbackSections: [] };
}

// （原 foldSubPointsToQuota + compressOversizedChapterStructure 事后要点折叠/块数压缩已删除：
//  要点数超容的场景由容量规划在规划层处理——块数上限 = 章目标/1200、点配额由 tier 权重归一，
//  块内每个要点带 quotaWords 下发写作详略；点配额与块预算在规划层精确守恒，
//  写作/检测/修复三层共用同一套数值，消除「写作逐点展开→事后折叠→检测再报警」的三角冲突）

/**
 * 章规划结构确定性转换（三期收口：蓝图唯一规划路径，LLM 章规划删除）：
 * 蓝图章切片存在 → 每个 sub_section 一个主题块、每个工作包一个 H4 要点（工作包名即要点标题）；
 * 切片缺失 → fallbackStructureForSections 语义域分组兜底（确定性内部回退，永不回退逐小节碎片化）。
 * 三期验收两处写作根因修正：
 * 1. 模板小节零丢失——蓝图路径覆盖不到的模板小节不再只统计不挂回，语义域分组挂回为追加主题块；
 * 2. 容器块骨架同源——提供 projectContext/evidence 时，关键施工容器块的 H4 要点改用
 *    majorConstructionSkeletonNames 展开（与写作层骨架锁定同源提取），拆半不再发生在错误粒度。
 */
export function buildChapterStructureFromBlueprint(input: {
  blueprintChapter?: BlueprintChapter;
  inputSections: string[];
  chapterTitle: string;
  targetWords: number;
  /** 容器小节骨架展开输入（可选）：提供后，关键施工容器块的工作包 H4 名与写作层骨架锁定同源 */
  projectContext?: string;
  evidence?: DocumentEvidence[];
}): PlannedChapterStructure {
  const { blueprintChapter, inputSections, chapterTitle, targetWords } = input;
  let blocks: PlannedChapterBlock[] = [];
  let coveredSections: string[] = [];
  let fallbackSections: string[];
  if (!blueprintChapter || blueprintChapter.subSections.length === 0) {
    const fallback = fallbackStructureForSections(inputSections, chapterTitle, targetWords);
    blocks = fallback.blocks;
    coveredSections = fallback.coveredSections;
    fallbackSections = fallback.fallbackSections;
  } else {
    for (const subSection of blueprintChapter.subSections) {
      // 详略级别随工作包 kind 下发（major=清单主要分部/评分重点 → core 详写；其余 general）
      const subPoints: PlannedChapterSubPoint[] = subSection.workPackages.map(workPackage => ({ title: workPackage.name, sources: [workPackage.name], tier: workPackage.kind === 'major' ? 'core' as const : 'general' as const }));
      if (subPoints.length > MAX_SUB_POINTS_PER_BLOCK) {
        // 单位工程多工作包按主题域语义化切块（「公厕结构与基础工程」），杜绝「公厕（1）（2）」防撞名泄漏目录
        blocks.push(...buildThemedBlocksForSubSection(subSection.title, subPoints));
      } else {
        // 块预算由末尾容量规划统一分配（占位 0，规划层一次成型）
        blocks.push({ title: subSection.title, subPoints, facts: [], targetWords: 0 });
      }
    }
    if (blocks.length === 0) {
      const fallback = fallbackStructureForSections(inputSections, chapterTitle, targetWords);
      blocks = fallback.blocks;
      coveredSections = fallback.coveredSections;
      fallbackSections = fallback.fallbackSections;
    } else {
      coveredSections = inputSections.filter(section => blocks.some(block => sameSectionText(block.title, section) || block.subPoints.some(point => point.sources.some(source => sameSectionText(source, section)) || sameSectionText(point.title, section))));
      fallbackSections = inputSections.filter(section => !coveredSections.includes(section));
    }
  }
  // 模板小节零丢失：蓝图路径覆盖不到的模板小节（如「市政工程专项施工工艺」）语义域分组挂回为追加主题块
  if (fallbackSections.length > 0) {
    const appendedBlocks = fallbackStructureForSections(fallbackSections, chapterTitle, targetWords).blocks;
    for (const block of appendedBlocks) {
      const duplicated = blocks.some(existing => sameSectionText(existing.title, block.title)
        || block.subPoints.some(point => existing.subPoints.some(existingPoint => sameSectionText(existingPoint.title, point.title))));
      if (!duplicated) blocks.push(block);
    }
    coveredSections = [...coveredSections, ...fallbackSections];
    fallbackSections = [];
  }
  // 容器块骨架同源展开：关键施工容器块的真实输出单元是工作包 H4（三要素正文），
  // 块规划层用与写作层骨架锁定同一提取函数把 H4 名铺进 subPoints——两套结构同源后，
  // 拆半不再发生在容器块（subPoints≥3），halfFocus 不再与三要素硬要求冲突；
  // 三期验收回归：蓝图 outline 章切片的分部清单（模板大纲确定性解析产物）作为第四来源兑底——
  // 上下文瘦身/证据缺失时三来源全部哑火，容器块不展开 → LLM 自由发挥 → 三要素丢失
  if (input.projectContext && input.evidence) {
    const context = input.projectContext;
    const evidence = input.evidence;
    // P2.5 分部章容器块不展开蓝图分部名：本章蓝图分部名已独立成块（每分部一块），
    // 容器小节（「主要分部分项工程施工方案」模板细目挂回块）再展开同名单会与分部块重复成稿
    //（同一分部写两遍）——分部章的容器块只保留三来源骨架名，不足时退化为概述块
    const outlineNames = DIVISION_SECTION_RE.test(chapterTitle) ? [] : (input.blueprintChapter?.subSections ?? []).map(subSection => subSection.title);
    // P2.7 分部章容器块展开排除分部块标题（P0 验收实测）：三来源骨架名含与蓝图分部同名的工作包
    // （景观工程/绿化工程等）→ 容器块展开后与分部块重复成稿，且写作层 otherBlockTitleSet 会把
    // 这些 H4 判清单外 → 容器块双重必败；与 P2.5「分部章容器块不展开蓝图分部名」同口径：
    // 已独立成块的分部名一律不展开，展开后不足 minCount 即退化为概述块（要素融合提示词接管）
    const divisionBlockTitleSet = DIVISION_SECTION_RE.test(chapterTitle)
      ? new Set(blocks.map(block => normalizeSubsectionTitleForDedup(block.title)).filter(Boolean))
      : new Set<string>();
    blocks = blocks.map(block => {
      if (!isContainerSectionTitle(block.title)) return block;
      // 4.19.5 回归（丰乐镇第二轮验收）：分部章的分部容器块（「主要分部分项工程施工方案」在
      // 「主要施工方法」章内）不展开任何骨架名——本章分部已独立成块，容器块是全章总述小节。
      // 4.19.4 只过滤与分部块同名的骨架名，剩余子特征骨架名（生态池/连接路等，实为分部块内部
      // 工序粒度）仍会展开 → 诱导 LLM 在容器块内复写分部方案（清单外+三要素重复）→
      // 两轮重试+确定性兜底全灭 → 章阻断。容器块保持单要点，写作层对其下发总述提示词（正文直接展开）。
      if (DIVISION_SECTION_RE.test(chapterTitle) && DIVISION_SECTION_RE.test(block.title)) return block;
      const skeletonNames = mergeUniqueSkeletonNames([
        ...majorConstructionSkeletonNames(context, evidence).filter(name => {
          // 4.19.3 回归：骨架名带「3、绿化工程」/「三、绿化工程」式编号+分隔符前缀时，
          // normalizeSubsectionTitleForDedup 剥编号正则（只剥数字+点/空格紧跟）不命中中文编号形态 →
          // 归一化残留编号 → 与分部块标题「绿化工程」不等 → 漏过滤 → 容器块展开分部名 H4 →
          // 与章内分部块 H3 同名 → finalize 串章骨架清理整块删除 → 容器块成空壳。
          // 先剥「编号（含中文数字）+分隔符」前缀再归一化，与分部块标题同口径比较。
          const bare = name.replace(/^[一二三四五六七八九十百\d]+[、.．\s:：-]+/u, '');
          return !divisionBlockTitleSet.has(normalizeSubsectionTitleForDedup(bare));
        }),
        ...outlineNames,
      ], 12);
      if (skeletonNames.length < 3) return block;
      // 容量规划（规划层详略设计）：容器块骨架展开数按章目标预算缩放（每包三要素概览最低可写量
      // 350 字），超出容量的包名汇总为「其他分部分项工程施工要点」概览点（tier=brief，sources 保留
      // 全部原名——覆盖校验/清单外白名单不受影响）——详略在规划层一次完成，写作层无折叠动作
      const containerCount = Math.max(1, blocks.filter(item => isContainerSectionTitle(item.title)).length);
      const expandCap = Math.max(3, Math.min(skeletonNames.length, Math.floor(targetWords / CAPACITY_SKELETON_WORDS_PER_PACKAGE / containerCount)));
      if (skeletonNames.length <= expandCap) {
        return { ...block, subPoints: skeletonNames.map(name => ({ title: name, sources: [name], tier: 'core' as const })) };
      }
      const detailed = skeletonNames.slice(0, expandCap);
      const deferred = skeletonNames.slice(expandCap);
      return {
        ...block,
        subPoints: [
          ...detailed.map(name => ({ title: name, sources: [name], tier: 'core' as const })),
          { title: '其他分部分项工程施工要点', sources: deferred, tier: 'brief' as const },
        ],
      };
    });
  }
  // C2 气候/特殊时段要点独立成块（4.44 丰乐镇实机两轮实证：写作模型系统性拒写此类要点 H4——
  // 基线轮 2/2 失守、隔离重写带点名反馈仍 4/4 拒写 → 块两轮质检失败 → 工期章阻断 → 整单 warning）。
  // 独立单点块的要点标题与块标题同名 → 写作层同名过滤后 sectionTitles 空集 → 「缺 H4 要点」
  // missing 判定结构性为空，H3 外壳承担标题存在性，该类要点改走正文直接展开路径
  blocks = extractClimatePointsAsBlocks(blocks);
  // 命名治理收口（L1）：章内块标题唯一化——重名者注入序号兜底（极端：续块首包名与域标签同名）
  const governedTitles = disambiguateBlockTitles(blocks.map(block => ({ title: block.title })));
  blocks.forEach((block, index) => { block.title = governedTitles[index]!; });
  // 容量规划（规划层唯一结构/字数决策点）：块数 × 块预算 × 点配额一次成型；
  // 块数超容量时在规划层按点数均衡归并（容器块标题优先保留），写作层收到的即最终结构，无事后折叠
  capacityPlanChapterBlocks(blocks, targetWords);
  // C1 管线收敛补齐：空章节确定性兜底（模板细目被大纲主题过滤全部剔除、且无蓝图切片时，
  // 语义域分组无输入可聚 → blocks 为空素下游规划块管线无块可写将阻断整章）。退化为
  // 「整章单块」结构：块标题=章标题、无 H4 要点（正文直接展开），块目标=整章目标（封顶单块上限）——
  // 保证章节无论小节数（0/1/2/5/30）恒有确定性成稿路径，不再因 blocks=[] 阻断
  if (blocks.length === 0 && chapterTitle.trim()) {
    blocks = [{ title: chapterTitle, subPoints: [], facts: [], targetWords: Math.min(CAPACITY_MAX_BLOCK_WORDS, Math.max(CAPACITY_MIN_BLOCK_WORDS, targetWords)) }];
  }
  return { blocks, coveredSections, fallbackSections };
}

/** C2 气候/特殊时段要点独立成块（调用点见 buildChapterStructureFromBlueprint 规划链）：
 * 4.44 丰乐镇实机两轮实证——写作模型对此类要点系统性拒写 H4（基线 2/2 失守，隔离重写带点名
 * 反馈仍 4/4 拒写），块两轮质检失败 → 工期章阻断 → 整单 warning。提取为独立单点块后，要点标题
 * 与块标题同名：写作层 blockSectionPoints 同名过滤 → sectionTitles 空集 → 「缺 H4 要点」missing
 * 判定结构性为空，H3 外壳承担标题存在性，该类要点改由正文直接展开。三类边界不提取（防结构/
 * 覆盖损失）：同名点（块外壳已承担）、已有同题块（不重复拆分）、提取后原块将空（保留原结构）。 */
function extractClimatePointsAsBlocks(blocks: PlannedChapterBlock[]): PlannedChapterBlock[] {
  if (!blocks.some(block => block.subPoints.some(point => isClimateClassPointTitle(point.title)))) return blocks;
  const occupiedTitles = new Set(blocks.map(block => normalizeSubsectionTitleForDedup(block.title)).filter(Boolean));
  const result: PlannedChapterBlock[] = [];
  for (const block of blocks) {
    const blockTitle = normalizeSubsectionTitleForDedup(block.title);
    const extracted = block.subPoints.filter(point => isClimateClassPointTitle(point.title)
      && normalizeSubsectionTitleForDedup(point.title) !== blockTitle
      && !occupiedTitles.has(normalizeSubsectionTitleForDedup(point.title)));
    const kept = block.subPoints.filter(point => !extracted.includes(point));
    if (extracted.length === 0 || kept.length === 0) {
      result.push(block);
      continue;
    }
    result.push({ ...block, subPoints: kept });
    for (const point of extracted) {
      occupiedTitles.add(normalizeSubsectionTitleForDedup(point.title));
      result.push({ title: point.title, subPoints: [{ ...point }], facts: [], targetWords: 0 });
    }
  }
  return result;
}

/** 章预算可行性估算（4.35 容量密度可行性闭环，章预算重校准输入；确定性无 LLM）：
 * 要点数（近似）= 蓝图工作包数（每包一个 H4）+ 未被蓝图覆盖的模板小节数。
 * 覆盖判定与 buildChapterStructureFromBlueprint 的 coveredSections 同口径（subSection 标题/
 * 工作包名 与模板小节 去空白互相包含）；
 * 近似边界：① fallback 语义域合并可能略减实际点数（高估 → 预算偏充足，安全侧）；
 * ② 无蓝图切片的容器块骨架展开可能额外增加点数（低估，由块内超密度守卫兜底）。
 * 最小可行预算 = 块数下限（ceil(要点数/单块要点上限)）× 单块可写下限（CAPACITY_MIN_BLOCK_WORDS）——
 * 低于此值意味着归并块密度物理不可写（每要点预算 < 最小可写量），写作层骨架质检必然失守。 */
export function estimateChapterMinFeasibleWords(blueprintChapter: BlueprintChapter | undefined, inputSections: string[]): { points: number; minFeasibleWords: number } {
  const sections = inputSections.filter(Boolean);
  let points = sections.length;
  if (blueprintChapter && blueprintChapter.subSections.length > 0) {
    points = blueprintChapter.subSections.reduce((sum, subSection) => sum + subSection.workPackages.length, 0);
    const covered = sections.filter(section => blueprintChapter.subSections.some(subSection => sameSectionText(subSection.title, section) || subSection.workPackages.some(workPackage => sameSectionText(workPackage.name, section)))).length;
    points += sections.length - covered;
  }
  const minBlocks = Math.ceil(points / MAX_SUB_POINTS_PER_BLOCK);
  return { points, minFeasibleWords: minBlocks * CAPACITY_MIN_BLOCK_WORDS };
}
