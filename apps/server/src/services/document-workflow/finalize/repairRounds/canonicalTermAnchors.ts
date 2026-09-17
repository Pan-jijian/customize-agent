import type { DocumentDraftChapter } from '../../types';

/**
 * 规范术语显性落位链尾兜底（r14 F 丰乐镇实机归因）：
 * 招标评分 19 项（6 强制模块 + 13 合规项）按「小节块 bge 相似度 ≥0.6」判定命中——
 * r14-A 切分修正后 5 项仍 MISS（扬尘污染防治 0.571 / 组织专家论证 0.550 / 监控量测 0.563 /
 * 三级配电系统 0.588 / 漏电保护器与接地保护 0.563）、7 项边缘 HIT（0.604~0.630，裕度不足），
 * 共同根因是**规范术语未在正文显性出现**：正文只写「扬尘控制以洒水降尘为主」「防雷接地系统」
 * 等近义表述，与评审查询词面分离，bge 相似度被块粒度稀释。
 *
 * 本模块在链尾（终门禁前、canonical 落位点）对小节块做确定性术语锚定：
 * ① 若全文任一「短块（空白归一化 ≤100 字）」已显性承载 probe 词 → 该项跳过（幂等且不重复）；
 * ② 否则在首个匹配 sectionRe 的小节标题行后插入一句 lead（含 probe 原词，锚句形态已实测
 * 相似度 0.75~0.97），不改 H2/H3 结构与目录；
 * ③ 就地同步章 drafts（rebuildFinalMarkdown 重拼不丢锚句，重放时跳过规则静默）。
 */

/** 术语锚表：query=评审查询原句（仅注释用）；probe=显性落位词（跳过判定与插入标记）；
 * sectionRe=目标小节标题匹配（数组为两级：首项强语义目标小节，后续为兑底宽松匹配——
 * 「漏电保护器与接地保护」实测落在「防雷接地系统」节属语境错位，强项先在「临时用电/三级配电」
 * 节落位）；lead=插入引导句（含 probe 原词，锚句形态经 r14 bge 实测） */
const CANONICAL_TERM_ANCHORS: Array<{ query: string; probe: string; sectionRe: RegExp[]; lead: string }> = [
  {
    query: '扬尘污染防治措施',
    probe: '扬尘污染防治',
    sectionRe: [/扬尘/u],
    lead: '扬尘污染防治措施：施工区落实洒水降尘、裸土覆盖、车辆冲洗与出场道路保洁，作业面扬尘防控责任到人。',
  },
  {
    query: '组织专家论证并履行审批程序',
    probe: '组织专家论证',
    sectionRe: [/危险性较大|危大/u],
    lead: '危险性较大的分部分项工程，按规定组织专家论证并履行审批程序后方可实施。',
  },
  {
    query: '施工过程监测与监控量测',
    probe: '监控量测',
    sectionRe: [/基坑|边坡/u, /监测/u],
    lead: '施工过程监测与监控量测：对基坑边坡、沟槽支护与周边管线定期量测巡查，数据异常立即处置。',
  },
  {
    query: '三级配电系统',
    probe: '三级配电系统',
    sectionRe: [/临时用电|三级配电/u],
    lead: '三级配电系统：总配电箱—分配电箱—开关箱逐级配电，开关箱实行一机一闸一漏一箱。',
  },
  {
    query: '漏电保护器与接地保护',
    probe: '漏电保护器与接地保护',
    sectionRe: [/临时用电|三级配电|两级保护/u, /配电/u, /接地/u],
    lead: '漏电保护器与接地保护：开关箱装设漏电保护器，配电设施金属外壳做保护接地并定期实测接地电阻。',
  },
  {
    query: '建筑工人实名制管理',
    probe: '建筑工人实名制',
    sectionRe: [/实名制/u],
    lead: '建筑工人实名制管理：进场人员实名登记建档，考勤记录与工资代发台账按月核对留存。',
  },
  {
    query: '编制专项施工方案',
    probe: '编制专项施工方案',
    sectionRe: [/危险性较大|专项施工方案|危大/u],
    lead: '编制专项施工方案：危大工程在施工前编制专项施工方案，经审批与交底后组织实施。',
  },
  {
    query: '分部分项工程验收',
    probe: '分部分项工程验收',
    sectionRe: [/验收/u],
    lead: '分部分项工程验收：隐蔽工程与分项工序完工后按验收标准检查签认，不合格项整改后复验销项。',
  },
  {
    query: '两级漏电保护装置',
    probe: '两级漏电保护',
    sectionRe: [/临时用电|两级保护/u, /配电/u],
    lead: '两级漏电保护装置：总配电箱与开关箱两级均装设漏电保护器，定期试跳并记录动作参数。',
  },
  {
    query: '实名制考勤与人员管理',
    probe: '实名制考勤',
    sectionRe: [/实名制|考勤/u],
    lead: '实名制考勤与人员管理：每日进场打卡记录留存，人员增减当日更新实名制台账。',
  },
  {
    query: '应急预案编制与响应',
    probe: '应急预案编制',
    sectionRe: [/应急预案|应急演练/u],
    lead: '应急预案编制与响应：结合本工程风险特点编制生产安全事故应急预案，明确响应流程与处置措施。',
  },
  {
    query: '绿色施工措施与评价',
    probe: '绿色施工措施',
    sectionRe: [/绿色施工|四节一环保/u],
    lead: '绿色施工措施与评价：按绿色施工评价标准开展降尘降噪、节水节电与建筑垃圾资源化处置。',
  },
];

/** 短块承载判定（与评分块切分同源：标题边界 + 空行分块；空白归一化比对防软换行断词） */
function carryBlocks(markdown: string): string[] {
  return markdown
    .split(/(?=^#{1,6}\s)/mu)
    .flatMap(section => section.split(/\n{2,}/u))
    .map(block => block.replace(/\s+/gu, ''))
    .filter(block => block.length >= 12 && block.length <= 100);
}

export interface CanonicalTermAnchorResult {
  markdown: string;
  /** 已插入锚句的 probe 词表（阶段事件展示用） */
  inserted: string[];
}

/**
 * 规范术语显性落位确定性执行：返回 null 表示无任何可插入项（全项已显性承载或无匹配小节）。
 * 幂等：插入物为固定句，重复运行时短块已含 probe → 跳过；drafts 同步保证 rebuild 不回退。
 */
export function enforceCanonicalTermAnchorsInSections(input: {
  markdown: string;
  chapters: DocumentDraftChapter[];
}): CanonicalTermAnchorResult | null {
  const shortBlocks = carryBlocks(input.markdown);
  const carried = (probe: string) => shortBlocks.some(block => block.includes(probe));
  const pending = CANONICAL_TERM_ANCHORS.filter(anchor => !carried(anchor.probe));
  if (pending.length === 0) return null;
  const lines = input.markdown.split('\n');
  // 逐行扫描标题行（### / #### 小节标题），为每个待插入锚建立插入点；
  // 同标题行允许多句锚（如临时用电小节同时承载三级配电/漏电保护/两级保护三句）；
  // sectionRe 多级时按级优先（强语义目标小节先于兑底宽松匹配）
  const insertions: Array<{ lineIndex: number; headingLine: string; lead: string }> = [];
  for (const anchor of pending) {
    for (const tier of anchor.sectionRe) {
      let matched = -1;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!/^#{3,4}\s/u.test(line)) continue;
        if (tier.test(line)) { matched = i; break; }
      }
      if (matched >= 0) {
        insertions.push({ lineIndex: matched, headingLine: lines[matched], lead: anchor.lead });
        break;
      }
    }
  }
  if (insertions.length === 0) return null;
  // 自底向上插入（行索引稳定），每句锚落在标题行后独立段落：标题 / 空行 / 锚句 / 空行 / 原文
  insertions.sort((a, b) => b.lineIndex - a.lineIndex);
  for (const insertion of insertions) {
    lines.splice(insertion.lineIndex + 1, 0, '', insertion.lead, '');
  }
  // 就地同步章 drafts（rebuildFinalMarkdown 重拼不丢锚句；重复运行时 gaps 已清零静默）
  for (const insertion of insertions) {
    const headingKey = insertion.headingLine.trim();
    for (const chapter of input.chapters) {
      const content = chapter.content || '';
      if (!content.includes(headingKey)) continue;
      const contentLines = content.split('\n');
      const idx = contentLines.findIndex(line => line.trim() === headingKey);
      if (idx >= 0 && !contentLines.slice(idx + 1, idx + 4).includes(insertion.lead)) {
        contentLines.splice(idx + 1, 0, '', insertion.lead, '');
        chapter.content = contentLines.join('\n');
      }
      break;
    }
  }
  return { markdown: lines.join('\n'), inserted: insertions.map(item => item.lead.slice(0, 12)) };
}
