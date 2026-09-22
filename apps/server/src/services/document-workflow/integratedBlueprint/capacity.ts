/**
 * 容量密度规划（主题块构建、块数上限/点配额/超密度守卫、骨架名合并去重）——规划层一次成型，写作层不做结构性拆半/归并
 *
 * S6 零行为拆分自 integratedBlueprint.ts（门面 re-export，对外导出不变）：仅机械搬迁，未改动任何语句与常量。
 */
import { composeBlockTitle } from '../sectionNamingGovernance';
import { workPackageThemeLabel } from '../utils';
import { DIVISION_SECTION_RE, MAJOR_CONTENT_SECTION_RE } from '../writingSpec';

// ═══════════════════════════════ 三期收口：章规划确定性转换 + 蓝图引用一致性 ═══════════════════════════════
// （原 blueprintPlanAuthorities 蓝图权威映射已删除：V5 P4 起权威由 AuthorityIndex 全量投影机制生成，见 authorityIndex.ts）

// ── 章规划结构（三期收口：原 chapterPlanner 确定性逻辑移入蓝图模块，LLM 章规划删除）──
// 蓝图章切片（sub_sections + work_packages）确定性转换为「主题块 + H4 要点」执行结构；
// 蓝图切片不可用时按语义域分组确定性回退（永不回退逐小节碎片化成稿）。

export interface PlannedChapterSubPoint {
  /** H4 要点标题（成稿时作为四级小节标题） */
  title: string;
  /** 本 H4 覆盖的输入细目原文（逐字；多条 = 语义合并，覆盖校验与溯源用） */
  sources: string[];
  /** 容量规划配额：本要点在块预算内的目标字数（写作提示词按此下发育写详略）。
   * 契约边界：配额是指令层（告诉模型写多深），块质检只查块总字数区间与质量执行器、
   * 不逐点核对配额——检测口径与写作口径同源，避免「写作要详、检测要省」的相互冲突。 */
  quotaWords?: number;
  /** 容量规划详略级别：core=骨架工作包/评分重点（详写）；general=一般单元（标准）；brief=概览单元 */
  tier?: 'core' | 'general' | 'brief';
}

export interface PlannedChapterBlock {
  /** 三级主题块标题（目录级小节） */
  title: string;
  /** 本块必须输出的 H4 要点 */
  subPoints: PlannedChapterSubPoint[];
  /** 分配给本块的事实线索（证据关键句，≤60 字/条，来自绑定资料原文） */
  facts: string[];
  /** 本块目标字数（容量规划产物：章目标 × 块权重归一 + 可写下限保护；写作层达标区 [0.85,1.15]×此值，
   * 4.35 分层验收：接受区 [0.7,1.4] 直通、越界仅首轮重写一次） */
  targetWords: number;
}

export interface PlannedChapterStructure {
  blocks: PlannedChapterBlock[];
  /** 已被映射的输入细目 */
  coveredSections: string[];
  /** 未映射成功、由兜底逻辑挂回的输入细目 */
  fallbackSections: string[];
}

/** 主题块内 H4 要点上限：超过则切分新块，控制单次调用输出量 */
export const MAX_SUB_POINTS_PER_BLOCK = 6;
/** 容量规划（全链唯一字数口径，替代历史 4.33/4.34 的事后归并/拆半/压缩——那些机制在写作层之后
 * 改结构，与写作、检测、修复三方互相冲突）：规划层一次成型产出「块数 × 块预算 × 点配额」。
 * 4.35 校准（舒城/丰乐实测）：块目标必须落在模型自然输出区间（约 1900~2700 字）——小目标块
 * （319~959 字）系统性超产 2~3 倍、大目标块（3463 字）系统性欠产 0.67~0.78×，与字数合同错配
 * 是重写风暴（每块写作 2~4 次、9 章因块合同失守被阻断）的根源。
 * 下限=预算下限兼块数上限口径（块数上限 = 章目标/此值）；上限=拆块阈值（块预算超此值且拆分
 * 可行时按要点对半拆块，保证单块预算落在可写区间）。 */
export const CAPACITY_MIN_BLOCK_WORDS = 1800;
export const CAPACITY_MAX_BLOCK_WORDS = 2800;
/** 容量规划：单块预算硬上限（不可拆块的单次输出安全区；触顶时接受章级欠产显式暴露，
 * 绝不向写作层超发不可写预算） */
const CAPACITY_HARD_MAX_BLOCK_WORDS = 4500;
/** 容量规划：单点配额软下限（权重分配低于软下限时按比例回收，不强制逐点达标） */
const CAPACITY_POINT_MIN_QUOTA = 100;
/** 容量规划：详略权重（core=骨架工作包/评分重点详写；general=一般单元；brief=概览单元带过） */
const CAPACITY_TIER_WEIGHT: Record<'core' | 'general' | 'brief', number> = { core: 1.5, general: 1, brief: 0.6 };
/** 容器块骨架展开：单包预算基准（单包三要素概览的最低可写量，展开上限 = 章目标/此值） */
export const CAPACITY_SKELETON_WORDS_PER_PACKAGE = 350;
/** 容量规划：单要点最小可写量（骨架 H4 三要素展开的物理下限——要点数 × 此值 > 块预算时
 * 骨架质检（每 H4 三要素）物理不可达；块内超密度守卫按此封顶。与 CAPACITY_SKELETON_WORDS_PER_PACKAGE
 * 单包概览基准同源、取更低下限 300，保留条目级详略自由度） */
const CAPACITY_MIN_POINT_WORDS = 300;
/** 分部分项子小节缺省目标字数：容量规划前的占位缺省（真实块预算由容量规划按章目标 × 权重归一产出；
 * 产品生成参数，不进入交付物正文数值口径） */
export const DEFAULT_SUBSECTION_TARGET_WORDS = 2400;
/** 域内标题确定性合并的重叠阈值（二字滑窗 ≥ 此值视为同一细目并入同一 H4，无 LLM 时目录瘦身判定；
 * 产品内部判定参数，不产出文档数值） */
export const TITLE_MERGE_OVERLAP_THRESHOLD = 0.75;

/** 单位工程多工作包语义化切块：按主题域聚合工作包（域序 = 首现序，同域非相邻包聚合进同一域块防同名），
 * 每域一块；域内超过单块要点上限时续块标题用「单位工程短名+块内首工作包名」——首工作包裸名会跨
 * 单位工程撞名（「零星装饰工程」×4），命名治理器补拼 base 后全局唯一（清单原生名，目录友好） */
export function buildThemedBlocksForSubSection(subSectionTitle: string, subPoints: PlannedChapterSubPoint[]): PlannedChapterBlock[] {
  const base = subSectionTitle.replace(/工程$/u, '');
  const groups: Array<{ label: string; points: PlannedChapterSubPoint[] }> = [];
  const groupIndex = new Map<string, number>();
  for (const point of subPoints) {
    const label = workPackageThemeLabel(point.title);
    let index = groupIndex.get(label);
    if (index === undefined) {
      index = groups.length;
      groupIndex.set(label, index);
      groups.push({ label, points: [] });
    }
    groups[index]!.points.push(point);
  }
  const blocks: PlannedChapterBlock[] = [];
  for (const group of groups) {
    for (let offset = 0; offset < group.points.length; offset += MAX_SUB_POINTS_PER_BLOCK) {
      const chunk = group.points.slice(offset, offset + MAX_SUB_POINTS_PER_BLOCK);
      // 拼接命名过长公共串消除（「装饰」+「装饰装修工程」不再产生「装饰装饰装修工程」）
      const title = offset === 0 ? composeBlockTitle(base, group.label) : composeBlockTitle(base, chunk[0]!.title);
      // 块预算由末尾容量规划统一分配（占位 0，规划层一次成型）
      blocks.push({ title, subPoints: chunk, facts: [], targetWords: 0 });
    }
  }
  return blocks;
}

/** 二字滑窗重叠率：衡量两个标题的语义近似程度（挂接兜底用） */
export function bigramOverlap(left: string, right: string) {
  const bigrams = (text: string) => {
    const set = new Set<string>();
    for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2));
    return set;
  };
  const target = bigrams(right);
  const source = [...bigrams(left)];
  if (source.length === 0) return 0;
  return source.filter(pair => target.has(pair)).length / source.length;
}

/** 小节语义域：确定性回退分组用 */
export function sectionDomain(sectionTitle: string) {
  if (/工期|进度|节点|计划|纠偏|预警/u.test(sectionTitle)) return '工期进度';
  if (/质量|验收|三检|样板|隐蔽|复试|实测|通病/u.test(sectionTitle)) return '质量验收';
  if (/安全|危大|风险|隐患|应急|临边|洞口|消防|临电/u.test(sectionTitle)) return '安全风险';
  if (/文明|扬尘|噪声|绿色|废水|垃圾|环保|智慧/u.test(sectionTitle)) return '文明绿色';
  if (/劳务|工资|实名|银行|考勤|人员|岗位|组织|职责/u.test(sectionTitle)) return '组织劳务';
  if (/资源|材料|设备|机械|人材机|调配/u.test(sectionTitle)) return '资源保障';
  if (/施工|工艺|流程|顺序|穿插|部署|区段|流水/u.test(sectionTitle)) return '施工组织';
  return '综合管理';
}

/** 人材机三合一章资源三小节判定（结构补挂产物）：必须各自独立成主题块（H3）与 H4 要点，不得被语义域分组合并吞并 */
export function isResourceTriadSection(title: string) {
  return /^(?:确保\s*)?[人材机](?:员|力|料|械|工)?\s*的保障体系与措施$/u.test(title);
}

/** 细目文本匹配：去空白后相等或互相包含 */
export function sameSectionText(left: string, right: string) {
  const a = left.replace(/\s+/gu, '');
  const b = right.replace(/\s+/gu, '');
  return a === b || a.includes(b) || b.includes(a);
}

/** 容量规划：把「块 × 点」一次成型规划到章目标容量内（规划层唯一字数/结构决策点）。
 * 与历史事后链（4.33 分配层守恒 → 4.34 compressOversizedChapterStructure 事后折叠要点/合并块、
 * splitSinglePointOversizedBlocks 事后拆半）的本质区别：块数、块预算、点配额全部在写作前一次完成，
 * 写作层收到的就是最终结构（进度页可见），写作/检测/修复三层共用同一套预算与配额，无事后结构性动作。
 * 算法：
 * 1. 块数上限 = 章目标/单块可写下限（CAPACITY_MIN_BLOCK_WORDS——低于此值模型输出收敛失效）；
 * 2. 块数超上限时按点数均衡归并相邻块（保序、容器块标题优先保留、facts 并集）；
 * 3. 单块预算超拆块阈值（CAPACITY_MAX_BLOCK_WORDS）且拆分可行（块数仍有余量）时按要点对半拆块
 *    （与归并同属规划层动作；块数已达上限即停拆——拆出的块预算将低于可写下限）；
 * 4. 块预算 = 章目标 × 块权重归一，低于可写下限的块抬升至下限、抬升量按可回收量比例从大块
 *    回收（4.35 下限保护）→ Σ块预算 = 章目标精确守恒（向下取整余量补最大块；不可拆块触硬上限
 *    时接受章级欠产显式暴露）；
 * 5. 点配额 = 块预算 × tier 权重归一（软下限 100，保底溢出时严格归一）→ Σ点配额 = 块预算。 */
export function capacityPlanChapterBlocks(blocks: PlannedChapterBlock[], targetWords: number, options: { barrierTitles?: readonly string[] } = {}) {
  // 4.55.14 章级小节归并屏障（巢湖实测）：章级规划小节（用户提示词/OUTLINE 声明的小节）必须各自
  // 保留 H3 身份——被相邻块吸收会降为块内 H4 要点，而块内 H4 常常整点漏写（实测「编制依据与说明」
  // 章草稿 0 次），用户的固定小节就此在交付稿里消失。与容器块/气候块同为归并屏障。
  /** 降级治理：超密度守卫把要点合并为「概览要点」＝细节丢失，须可被上层渲染（原仅 console.warn） */
  const densityMergeWarnings: string[] = [];
  if (blocks.length === 0) return;
  const target = Math.max(0, Math.round(targetWords));
  const totalPoints = blocks.reduce((sum, block) => sum + Math.max(1, block.subPoints.length), 0);
  const maxBlocks = Math.max(1, Math.floor(target / CAPACITY_MIN_BLOCK_WORDS));
  // 1. 块容量归并：块数超上限时按点数均衡合并相邻块（保序；仅规划层动作，写作层无结构变更）。
  // 4.35 容器块归并屏障：容器块（全章总述）独立成组、不吸收分部要点——与分部块合并会令
  // 总述块卷入分部 H4 展开（P2.5/P2.7 契约：每分部一块、容器块只做总述），且其总述提示词
  // 与覆盖清单 H4 要求互斥
  // 4.35 密度封顶（容量密度可行性闭环）：归并后要点数超单块上限（MAX_SUB_POINTS_PER_BLOCK）
  // 强制成组——任何归并路径都不产出超密度块。根因实证（4.34 自测「主要施工方法」章阻断）：
  // 12 要点块 1800 字 → 每要点预算 150 字 < 单要点最小可写量 300 字（骨架 H4 三要素物理
  // 不可达）→ 块必败、章必败。点数均衡条件降级为「槽位有余」时的软条件，密度封顶优先——
  // 块数允许超 maxBlocks，扩容由软下限 floorValue=min(1800, T/块数) 与末尾 Σ 守恒收口自动
  // 吸收（无新守恒逻辑）
  let planned = blocks;
  if (planned.length > maxBlocks) {
    const groups: PlannedChapterBlock[][] = [];
    const targetPerGroup = Math.max(1, Math.ceil(totalPoints / maxBlocks));
    let current: PlannedChapterBlock[] = [];
    let currentPoints = 0;
    for (const block of planned) {
      // 4.44 C2：气候/特殊时段独立单点块（outline 提取）同为归并屏障——被邻块吸收会复活
      // 「要点拒写」故障模式（块标题≠要点标题即恢复 H4 要求）
      if (isContainerSectionTitle(block.title) || isClimateClassPointTitle(block.title) || (options.barrierTitles || []).some(title => sameSectionText(block.title, title))) {
        if (current.length > 0) {
          groups.push(current);
          current = [];
          currentPoints = 0;
        }
        groups.push([block]);
        continue;
      }
      const points = Math.max(1, block.subPoints.length);
      if (current.length > 0 && (currentPoints + points > MAX_SUB_POINTS_PER_BLOCK || (groups.length < maxBlocks - 1 && currentPoints + points > targetPerGroup))) {
        groups.push(current);
        current = [];
        currentPoints = 0;
      }
      current.push(block);
      currentPoints += points;
    }
    if (current.length > 0) groups.push(current);
    planned = groups.map(group => group.length === 1 ? group[0]! : {
      // 容器块标题优先保留（写作层骨架锁定按块标题判定，标题丢失会丢三要素结构）
      title: (group.find(block => isContainerSectionTitle(block.title)) || group[0]!).title,
      subPoints: group.flatMap(block => block.subPoints),
      facts: [...new Set(group.flatMap(block => block.facts))],
      targetWords: 0,
    });
  }
  // 1.5 块容量拆分：单块预算超拆块阈值时按要点对半拆块（与归并同属规划层动作——
  // 写作层收到的是最终结构，两半块共享父标题由章级拼接剥壳合并为一个小节）。与历史写作层
  // 事后拆半的本质区别：此处预算尚未下发，不存在「半块重设预算使父块合同失效」的口径冲突。
  // 4.35 拆分可行性：块数已达上限（章目标/可写下限）即停拆——再拆将使块预算低于可写下限
  //（下限回填后 Σ 超章目标、守恒失效），此时接受单块超阈值（分层验收与终检链兜底）
  for (let guard = 0; guard < 64 && planned.length < maxBlocks; guard += 1) {
    const weightsNow = planned.map(block => Math.max(0.5, block.subPoints.reduce((sum, point) => sum + CAPACITY_TIER_WEIGHT[point.tier || 'general'], 0)));
    const totalWeightNow = weightsNow.reduce((sum, weight) => sum + weight, 0) || planned.length;
    let widest = -1;
    let widestShare = CAPACITY_MAX_BLOCK_WORDS;
    planned.forEach((block, index) => {
      const share = Math.floor(target * weightsNow[index]! / totalWeightNow);
      if (block.subPoints.length >= 2 && share > widestShare) {
        widest = index;
        widestShare = share;
      }
    });
    if (widest < 0) break;
    const block = planned[widest]!;
    const mid = Math.ceil(block.subPoints.length / 2);
    planned.splice(widest, 1,
      { ...block, subPoints: block.subPoints.slice(0, mid), targetWords: 0 },
      { ...block, subPoints: block.subPoints.slice(mid), targetWords: 0 });
  }
  // 3. 块预算：权重归一 + 4.35 下限保护（低于可写下限的块抬升至下限，抬升量按可回收量——超出下限
  // 的部分——比例从高于下限的块回收；块数上限保证 Σ下限 ≤ 章目标，回收必然可行）→ Σ块预算 = 章目标
  // 精确守恒（向下取整余量补最大块）；单块触单次输出安全区硬上限时接受章级欠产显式暴露
  //（由章收口/终检链处理），绝不向写作层下发不可写预算（块合同必然失守的根源）
  const weights = planned.map(block => Math.max(0.5, block.subPoints.reduce((sum, point) => sum + CAPACITY_TIER_WEIGHT[point.tier || 'general'], 0)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || planned.length;
  // 软下限 = min(可写下限, 公平份额)：容器屏障场景下块数可略超上限（每容器占独立槽位），
  // 公平份额低于可写下限时以份额为准——保证任何结构下 Σ下限 ≤ 章目标、抬升量回收必然可行
  const floorValue = Math.min(CAPACITY_MIN_BLOCK_WORDS, Math.floor(target / Math.max(1, planned.length)));
  const budgets = planned.map((_, index) => Math.max(floorValue, Math.floor(target * weights[index]! / totalWeight)));
  const overflow = budgets.reduce((sum, budget) => sum + budget, 0) - target;
  if (overflow > 0) {
    const recoverable = budgets.map(budget => budget - floorValue);
    const totalRecoverable = recoverable.reduce((sum, value) => sum + value, 0);
    if (totalRecoverable > 0) {
      let recovered = 0;
      budgets.forEach((budget, index) => {
        const cut = Math.min(recoverable[index]!, Math.floor(overflow * recoverable[index]! / totalRecoverable));
        budgets[index] = budget - cut;
        recovered += cut;
      });
      // 比例回收的向下取整余数（< 块数）：逐字从当前最大的可回收块扣减
      for (let remainder = overflow - recovered; remainder > 0; remainder -= 1) {
        let candidate = -1;
        budgets.forEach((budget, index) => {
          if (budget <= floorValue) return;
          if (candidate < 0 || budget > budgets[candidate]!) candidate = index;
        });
        if (candidate < 0) break;
        budgets[candidate] = budgets[candidate]! - 1;
      }
    }
  }
  // Σ 守恒收口：向下取整丢失的余量（< 块数）补到预算最大的块，保证 Σ块预算 = 章目标
  const allocated = budgets.reduce((sum, budget) => sum + budget, 0);
  if (allocated < target) {
    let richest = 0;
    budgets.forEach((budget, index) => {
      if (budget > budgets[richest]!) richest = index;
    });
    budgets[richest] = budgets[richest]! + (target - allocated);
  }
  planned.forEach((block, index) => {
    block.targetWords = Math.max(1, Math.min(budgets[index]!, CAPACITY_HARD_MAX_BLOCK_WORDS));
  });
  // 3.5 块内超密度守卫（容量密度可行性闭环最后兜底）：预算分配后、点配额前，块内要点数超
  // 「块预算 ÷ 单要点最小可写量」时（小目标文档 / 极端参数下章预算重校准仍不可行），保留前
  // cap-1 个详写要点、其余合并为一个 brief 概览要点（sources 全量保留——覆盖清单/清单外
  // 白名单不受影响），复用容器块「其他分部分项工程施工要点」既有降级模式（不引入新语义）。
  // 目的：保证块内「要点数 × 300 字 ≤ 块预算」——骨架质检「每 H4 三要素最小可写量」物理可达
  planned.forEach(block => {
    const cap = Math.max(1, Math.floor(block.targetWords / CAPACITY_MIN_POINT_WORDS));
    if (block.subPoints.length <= cap) return;
    const originalCount = block.subPoints.length;
    const detailed = block.subPoints.slice(0, cap - 1);
    const deferred = block.subPoints.slice(cap - 1);
    block.subPoints = [
      ...detailed,
      { title: '其他分部分项工程施工要点', sources: [...new Set(deferred.flatMap(point => point.sources))], tier: 'brief' as const },
    ];
    // 降级治理：要点被合并为「概览要点」意味着**细节丢失**，只 console.warn 用户看不到。
    // 现同时写入蓝图降级警告（该警告已改为全量上屏）。
    const mergeWarning = `块「${block.title}」超密度守卫：要点数 ${originalCount} → ${block.subPoints.length}（块预算 ${block.targetWords} 字，密度上限 ${cap} 要点，${deferred.length} 个要点合并为概览要点，细节丢失）`;
    console.warn(`[blueprint] ${mergeWarning}`);
    densityMergeWarnings.push(mergeWarning);
  });
  // 4. 点配额：块内 tier 权重归一；软下限让位优先（汇总超块预算时严格归一，覆盖清单概览形态）
  for (const block of planned) {
    if (block.subPoints.length === 0) continue;
    const pointWeights = block.subPoints.map(point => CAPACITY_TIER_WEIGHT[point.tier || 'general']);
    const weightSum = pointWeights.reduce((sum, weight) => sum + weight, 0) || block.subPoints.length;
    const floored = pointWeights.map(weight => Math.max(CAPACITY_POINT_MIN_QUOTA, Math.floor(block.targetWords * weight / weightSum)));
    const flooredSum = floored.reduce((sum, quota) => sum + quota, 0);
    if (flooredSum > block.targetWords) {
      let remaining = block.targetWords;
      block.subPoints.forEach((point, index) => {
        const quota = index === block.subPoints.length - 1 ? Math.max(1, remaining) : Math.max(1, Math.floor(block.targetWords * pointWeights[index]! / weightSum));
        point.quotaWords = quota;
        remaining -= quota;
      });
      continue;
    }
    const tallest = pointWeights.reduce((best, weight, index) => (weight > pointWeights[best]! ? index : best), 0);
    const remainder = block.targetWords - flooredSum;
    block.subPoints.forEach((point, index) => {
      point.quotaWords = floored[index]! + (index === tallest ? remainder : 0);
    });
  }
  // 归并/拆分可能重建了数组（planned !== blocks）：把最终结构原位写回调用方数组，
  // 调用方持有的 blocks 引用必须反映容量规划产物
  if (planned !== blocks) {
    blocks.length = 0;
    blocks.push(...planned);
  }
  // 降级治理：超密度守卫的合并警告随数组带回调用方（本函数原位写回、无返回值），
  // 供上层渲染——只 console.warn 的话用户看不到「要点被合并＝细节丢失」。
  (blocks as unknown as { densityMergeWarnings?: string[] }).densityMergeWarnings = densityMergeWarnings;
}

/** 关键施工容器块判定（项目主要施工内容/主要分部分项工程施工方案）：其真实输出单元是
 * 写作层骨架锁定的工作包 H4（每包 × 三要素），与普通单要点块的结构语义不同 */
export function isContainerSectionTitle(title: string) {
  return MAJOR_CONTENT_SECTION_RE.test(title) || DIVISION_SECTION_RE.test(title);
}

/** C2 气候/特殊时段类要点判定（4.44 丰乐镇实机两轮实证：写作模型对「特殊时段/雨季/异常气候」
 * 类要点系统性拒写 H4——基线轮 2/2 失守，隔离重写带点名反馈仍 4/4 拒写）。此类要点在规划层
 * 提取为独立单点块，块标题=要点标题（提取见 buildChapterStructureFromBlueprint），同时作为
 * 容量归并屏障——被邻块吸收会恢复「块标题≠要点标题」的 H4 要求，故障模式复活。 */
const CLIMATE_CLASS_POINT_TITLE_RE = /^(特殊时段|异常气候|恶劣气候|恶劣天气|极端气候|极端天气|雨季|雨期|冬期|冬季|汛期|台风|高温|寒潮|全天候|节假日施工|夜间施工)/u;
export function isClimateClassPointTitle(title: string): boolean {
  // 先剥「编号（含中文数字）+分隔符」前缀再判定（与容器块骨架名同口径，防「3、雨季施工措施」式漏判）
  const bare = title.replace(/^[一二三四五六七八九十百\d]+[、.．\s:：-]+/u, '').trim();
  return CLIMATE_CLASS_POINT_TITLE_RE.test(bare);
}

/** 骨架名去重合并（与 majorConstructionSkeletonNames 同口径的去空白包含比较），并按上限截断 */
export function mergeUniqueSkeletonNames(names: string[], cap: number): string[] {
  const merged: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    const compact = name.replace(/\s+/gu, '');
    if (!compact || /^其他$|^其它$|^其他工程$|^其余/u.test(compact)) continue;
    if (merged.some(existing => {
      const existingCompact = existing.replace(/\s+/gu, '');
      return existingCompact.includes(compact) || compact.includes(existingCompact);
    })) continue;
    merged.push(name);
    if (merged.length >= cap) break;
  }
  return merged;
}

// （原 splitSinglePointOversizedBlocks 事后拆半已删除：容量规划在规划层按块数上限/点配额一次成型，
//  写作层之后不允许任何结构性拆半/归并动作——与写作、检测、修复的口径冲突已消除）

/**
 * 章级「供给面 ↔ 要求面」对齐核算（G 线 P1-3）。
 *
 * **缺陷**：容量规划只按字数分配块与小节，**从不核算这一章有多少可用的量化参数**。
 * 于是「章目标 8000 字、可用参数只有 3 个」这种供给严重不足的章照常开工——
 * 写不满就只能靠通用话术注水（正是模板化与空泛表述的来源），而检测端又按**固定的**
 * 参数密度线去扣分：写作端要不到料、检测端照样判不及格，两端各自成立、合起来无解。
 *
 * **现口径**：在容量规划期核算「章可用量化参数数 ÷ 章目标字数」，与检测端**同源常量**
 *（`CHAPTER_PARAMETER_DENSITY_PER_1000`，每千字所需量化参数数）。不足时给出**二选一**的
 * 同源处置：① 扩注入预算（把本章参数池优先级提前/加大限额）；② **同步下调**该章的
 * 密度要求与目标字数——二者必须一起动，只动一端就会重新制造「要不到料却照常扣分」。
 */
export const CHAPTER_PARAMETER_DENSITY_PER_1000 = 1.5;

export interface ChapterSupplyDemandAssessment {
  chapterTitle: string;
  targetWords: number;
  availableParameters: number;
  /** 每千字可用量化参数数 */
  densityPer1000: number;
  /** 检测端要求的密度线（同源常量） */
  requiredDensityPer1000: number;
  sufficient: boolean;
  /** 达到密度线所需的最少参数数 */
  requiredParameters: number;
  /** 差额（requiredParameters − availableParameters；≥0） */
  parameterShortfall: number;
  /** 同源处置建议（充足时为空） */
  remediation: string[];
  /** 供给分通道计数（供诊断消息说明「可用量化参数 N 个」是怎么数出来的） */
  supplyChannels?: ChapterParameterSupplyChannels;
}

/** 章级可用量化参数的分通道计数（去重后的并集为 total） */
export interface ChapterParameterSupplyChannels {
  /** 蓝图 must_cite 参数条数 */
  blueprint: number;
  /** 本章责任清单行的规格-数量对条数 */
  bill: number;
  /** 本章证据中提取的精确参数 token 数 */
  evidence: number;
  /** 本章需求解析出的量化事实值条数（写作端 factsForChapterNeeds 通道） */
  factNeeds: number;
  /** 各通道去重后的可用参数总数 */
  total: number;
}

/**
 * 章级可用量化参数统计（供给面真实口径）。
 *
 * **为什么不是只数蓝图 requiredParams**：`requiredParams` 只从清单工作包的 `quantities` 生成，
 * 因此凡不是清单驱动工作包的章（工程概况、物资计划、质量/安全/工期措施…）恒为 0 —— 实测
 * 丰乐镇 9/10 章被判「可用量化参数 0 个」，而同一套蓝图产出的成稿实测每千字 2.5 个量化参数
 * （专业评分「事实落位率」）、2.2 个工艺参数（「工艺参数密度」），两者不可能同时成立。
 * 正文里的量化参数来自多路供给，只数一路就会把「本项目正常」误报成「要不到料」。
 *
 * 现口径与写作端同源：写作层 `buildChapterFactCoverageContext` 的精确参数池 =
 * 本章证据精确 token ∪ 事实值，此处再并入蓝图 must_cite 与本章责任清单行的规格-数量对，
 * 按归一化 token 去重后计数。
 */
export function collectChapterParameterSupply(input: {
  blueprintParams?: Iterable<string>;
  billSpecs?: Iterable<string>;
  evidenceTokens?: Iterable<string>;
  /** 本章需求解析出的量化事实值（写作端 factsForChapterNeeds 通道，已由调用方按 HAS_QUANTIFIED_VALUE_RE 过滤） */
  factValues?: Iterable<string>;
}): ChapterParameterSupplyChannels {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/gu, '');
  const collect = (values?: Iterable<string>) => {
    const set = new Set<string>();
    for (const value of values ?? []) {
      const key = normalize(String(value ?? ''));
      if (key) set.add(key);
    }
    return set;
  };
  const blueprint = collect(input.blueprintParams);
  const bill = collect(input.billSpecs);
  const evidence = collect(input.evidenceTokens);
  const factNeeds = collect(input.factValues);
  const total = new Set([...blueprint, ...bill, ...evidence, ...factNeeds]).size;
  return { blueprint: blueprint.size, bill: bill.size, evidence: evidence.size, factNeeds: factNeeds.size, total };
}

/** 供给分通道明细（仅当调用方给了明细时拼接，保持历史消息对既有调用方逐字兼容） */
function supplyChannelLine(channels?: ChapterParameterSupplyChannels): string {
  if (!channels) return '';
  return `可用参数来源：蓝图 must_cite ${channels.blueprint} 个、本章责任清单行规格 ${channels.bill} 个、本章证据精确 token ${channels.evidence} 个、本章需求解析事实值 ${channels.factNeeds} 个（按归一化 token 去重后共 ${channels.total} 个）。`;
}

export function assessChapterSupplyDemand(input: {
  chapterTitle: string;
  targetWords: number;
  availableParameters: number;
  /** 供给分通道明细（可选；提供后诊断消息会说明计数来源） */
  supplyChannels?: ChapterParameterSupplyChannels;
}): ChapterSupplyDemandAssessment {
  const targetWords = Math.max(0, Math.round(input.targetWords));
  const availableParameters = Math.max(0, Math.round(input.availableParameters));
  const densityPer1000 = targetWords > 0 ? (availableParameters / targetWords) * 1000 : 0;
  const requiredParameters = Math.ceil((targetWords / 1000) * CHAPTER_PARAMETER_DENSITY_PER_1000);
  const parameterShortfall = Math.max(0, requiredParameters - availableParameters);
  const sufficient = targetWords === 0 || parameterShortfall === 0;
  const channelLine = supplyChannelLine(input.supplyChannels);
  const remediation = sufficient ? [] : [
    `本章目标 ${targetWords} 字，可用量化参数 ${availableParameters} 个（${densityPer1000.toFixed(2)}/千字），低于本条要求线 ${CHAPTER_PARAMETER_DENSITY_PER_1000}/千字（与块质检/构造审计同值），缺 ${parameterShortfall} 个。`,
    ...(channelLine ? [channelLine] : []),
    '二选一（端点必须一起动，只动一端会重新制造「要不到料却照常扣分」）：① 扩供给——把本章责任清单行/证据的取用优先级提前、放宽本章参数配额上限；② 同步下调——把本章目标字数降到 ' + `${Math.floor((availableParameters / CHAPTER_PARAMETER_DENSITY_PER_1000) * 1000)} 字` + ' 附近，使供给与要求对齐（目标字数与密度要求必须一起改）。',
  ];
  return { chapterTitle: input.chapterTitle, targetWords, availableParameters, densityPer1000, requiredDensityPer1000: CHAPTER_PARAMETER_DENSITY_PER_1000, sufficient, requiredParameters, parameterShortfall, remediation, supplyChannels: input.supplyChannels };
}
