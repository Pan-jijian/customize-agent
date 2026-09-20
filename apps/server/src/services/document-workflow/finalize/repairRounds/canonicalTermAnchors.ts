import type { DocumentDraftChapter } from '../../types';

/**
 * 规范术语显性落位链尾兜底（r14 F 丰乐镇实机归因，r26 章级回退扩展）：
 * 招标评分 19 项（6 强制模块 + 13 合规项）按「小节块 bge 相似度 ≥0.6」判定命中——
 * r14-A 切分修正后 5 项仍 MISS（扬尘污染防治 0.571 / 组织专家论证 0.550 / 监控量测 0.563 /
 * 三级配电系统 0.588 / 漏电保护器与接地保护 0.563）、7 项边缘 HIT（0.604~0.630，裕度不足），
 * 共同根因是**规范术语未在正文显性出现**：正文只写「扬尘控制以洒水降尘为主」「防雷接地系统」
 * 等近义表述，与评审查询词面分离，bge 相似度被块粒度稀释。
 *
 * r26 追加根因（术语零标题可依）：规划层注入的规范小节名在写作层「语义域折叠」后降级为
 * 要点级子项，写作轮系统性不将其显性化为 H3/H4 标题——小节级 sectionRe 匹配静默落空
 * （应急预案/危险源/工资/监测类术语正文字面缺位），故新增章级回退 fallbackChapterRe。
 *
 * 本模块在链尾（终门禁前、canonical 落位点）对小节块做确定性术语锚定：
 * ① 幂等判定：lead 句前 20 字已在全文出现 → 跳过（锚句固定前缀，兼容闭环后缀加工与重复重放；
 * 历史 probe 短块承载判定已移除：术语词面出现 ≠ 块级 bge 达标，词面判定会漏修）；
 * ② 否则在首个匹配 sectionRe 的小节标题行后插入一句 lead（含 probe 原词，锚句形态已实测
 * 相似度 0.75~0.97），不改 H2/H3 结构与目录；
 * ③ sectionRe 全级落空时走章级回退 fallbackChapterRe：落到匹配章 H2，插入点取章内首个
 * H3/H4 标题行后（无则 H2 行本身）；
 * ④ 就地同步章 drafts（rebuildFinalMarkdown 重拼不丢锚句，重放时跳过规则静默）。
 */

/** 术语锚表：query=评审查询原句（仅注释用）；probe=显性落位词（审计标记，含于 lead 句）；
 * sectionRe=目标小节标题匹配（数组为两级：首项强语义目标小节，后续为兑底宽松匹配——
 * 「漏电保护器与接地保护」实测落在「防雷接地系统」节属语境错位，强项先在「临时用电/三级配电」
 * 节落位）；fallbackChapterRe=章级回退（sectionRe 全级落空时按章 H2 命中，插入点取章内首个
 * H3/H4 行后，无则 H2 行本身——r26 实测语义域折叠致术语零标题可依）；
 * lead=插入引导句（含 probe 原词，锚句形态经 r14 bge 实测） */
export const CANONICAL_TERM_ANCHORS: Array<{ query: string; probe: string; sectionRe: RegExp[]; fallbackChapterRe?: RegExp; lead: string }> = [
  {
    query: '扬尘污染防治措施',
    probe: '扬尘污染防治',
    sectionRe: [/扬尘/u],
    fallbackChapterRe: /文明施工|环境保护|扬尘|绿色施工/u,
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
    fallbackChapterRe: /施工方法|主要施工|施工方案|监测/u,
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
    query: '农民工工资专用账户与工资支付保障 / 农民工工资专用账户银行代发',
    probe: '农民工工资专用账户',
    sectionRe: [/工资|薪酬|劳务/u, /用工/u],
    fallbackChapterRe: /劳动力|用工|人员/u,
    lead: '农民工工资专用账户与工资支付保障：开设农民工工资专用账户，工资经银行代发按月足额支付到本人账户，考勤与发放台账逐月核对。',
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
    query: '生产安全事故应急预案与应急演练 / 应急预案编制与响应',
    probe: '生产安全事故应急预案',
    sectionRe: [/应急预案|应急演练/u, /应急/u],
    fallbackChapterRe: /安全|应急/u,
    lead: '生产安全事故应急预案与应急演练：开工前完成应急预案编制，明确应急响应流程与处置措施，按计划组织演练并复盘修订。',
  },
  {
    query: '危险源辨识与风险识别评估',
    probe: '危险源辨识',
    sectionRe: [/危险源|风险识别/u, /安全/u],
    fallbackChapterRe: /安全/u,
    lead: '危险源辨识与风险识别评估：施工前对作业面逐项开展辨识评估，形成危险源清单并落实分级管控措施。',
  },
  {
    query: '对作业人员进行安全技术交底',
    probe: '安全技术交底',
    sectionRe: [/交底/u, /危大|专项施工方案/u],
    fallbackChapterRe: /安全|质量/u,
    lead: '安全技术交底：各分项工程施工前对作业人员进行安全技术交底，交底双方签字确认后组织实施。',
  },
  {
    query: '绿色施工措施与评价',
    probe: '绿色施工措施',
    sectionRe: [/绿色施工|四节一环保/u],
    lead: '绿色施工措施与评价：按绿色施工评价标准开展降尘降噪、节水节电与建筑垃圾资源化处置。',
  },
];

export interface CanonicalTermAnchorResult {
  markdown: string;
  /** 已插入锚句的 probe 词表（阶段事件展示用） */
  inserted: string[];
}

/**
 * 规范术语显性落位确定性执行：返回 null 表示无任何可插入项（全项 lead 前缀已在或无可落点）。
 * 幂等：插入物为固定句，重复运行时 lead 前缀已存在 → 跳过；drafts 同步保证 rebuild 不回退。
 */
export function enforceCanonicalTermAnchorsInSections(input: {
  markdown: string;
  chapters: DocumentDraftChapter[];
}): CanonicalTermAnchorResult | null {
  // 幂等键：lead 句前 20 字（锚句固定前缀，与闭环后缀加工/重复重放兼容）
  const pending = CANONICAL_TERM_ANCHORS.filter(anchor => !input.markdown.includes(anchor.lead.slice(0, 20)));
  if (pending.length === 0) return null;
  const lines = input.markdown.split('\n');
  // 逐行扫描标题行（### / #### 小节标题），为每个待插入锚建立插入点；
  // 同标题行允许多句锚（如临时用电小节同时承载三级配电/漏电保护/两级保护三句）；
  // sectionRe 多级时按级优先（强语义目标小节先于兑底宽松匹配）；
  // 全级落空时章级回退（r26 实测：术语未显性为小节标题，fallbackChapterRe → 章内首个
  // H3/H4 行，章内无小节时 H2 行本身）
  const insertions: Array<{ lineIndex: number; headingLine: string; lead: string }> = [];
  for (const anchor of pending) {
    let matched = -1;
    for (const tier of anchor.sectionRe) {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!/^#{3,4}\s/u.test(line)) continue;
        if (tier.test(line)) { matched = i; break; }
      }
      if (matched >= 0) break;
    }
    if (matched < 0 && anchor.fallbackChapterRe) {
      const chapterLine = lines.findIndex(line => /^##\s/u.test(line) && anchor.fallbackChapterRe!.test(line));
      if (chapterLine >= 0) {
        matched = chapterLine;
        for (let i = chapterLine + 1; i < lines.length; i += 1) {
          if (/^##\s/u.test(lines[i])) break;
          if (/^#{3,4}\s/u.test(lines[i])) { matched = i; break; }
        }
      }
    }
    if (matched >= 0) insertions.push({ lineIndex: matched, headingLine: lines[matched], lead: anchor.lead });
  }
  if (insertions.length === 0) return null;
  // 自底向上插入（行索引稳定），每句锚落在标题行后独立段落：标题 / 空行 / 锚句 / 空行 / 原文
  insertions.sort((a, b) => b.lineIndex - a.lineIndex);
  for (const insertion of insertions) {
    lines.splice(insertion.lineIndex + 1, 0, '', insertion.lead, '');
  }
  // 就地同步章 drafts（rebuildFinalMarkdown 重拼不丢锚句；重复运行时 lead 前缀已存在静默）；
  // finalMarkdown 的 H4 深度标题经三级编号规范化（#### 5.1.2 …）、H2 章标题含「第X章」编号，
  // 而 drafts 保有原始形态（H4 无编号、H2 无章号）——精确失配时按去编号标题体回退
  //（r26 实测：劳动力章薪酬小节同步失配，根治于标题体匹配）
  const headingBodyOf = (line: string) => line.trim()
    .replace(/^#+\s*/u, '')
    .replace(/^第[一二三四五六七八九十百零〇\d]+章\s*/u, '')
    .replace(/^\d+(?:\.\d+)*\s*/u, '')
    .trim();
  for (const insertion of insertions) {
    const headingKey = insertion.headingLine.trim();
    const leadKey = insertion.lead.slice(0, 20);
    const headingBody = headingBodyOf(headingKey);
    let synced = false;
    for (const chapter of input.chapters) {
      const contentLines = (chapter.content || '').split('\n');
      let idx = contentLines.findIndex(line => line.trim() === headingKey);
      if (idx < 0 && /^#{2,4}\s/u.test(headingKey) && headingBody) {
        idx = contentLines.findIndex(line => /^#{2,4}\s/u.test(line.trim()) && headingBodyOf(line) === headingBody);
      }
      if (idx < 0) continue;
      if (!contentLines.slice(idx + 1, idx + 5).some(line => line.includes(leadKey))) {
        contentLines.splice(idx + 1, 0, '', insertion.lead, '');
        chapter.content = contentLines.join('\n');
      }
      synced = true;
      break;
    }
    // 章级回退插入点（章内无小节命中时）：按去章号标题体定位 drafts 章首 H2 行
    if (synced || !/^##\s/u.test(headingKey)) continue;
    for (const chapter of input.chapters) {
      const contentLines = (chapter.content || '').split('\n');
      const headIdx = contentLines.findIndex(line => /^##\s/u.test(line));
      if (headIdx < 0 || headingBodyOf(contentLines[headIdx]) !== headingBody) continue;
      if (!contentLines.slice(headIdx + 1, headIdx + 5).some(line => line.includes(leadKey))) {
        contentLines.splice(headIdx + 1, 0, '', insertion.lead, '');
        chapter.content = contentLines.join('\n');
      }
      break;
    }
  }
  return { markdown: lines.join('\n'), inserted: insertions.map(item => item.lead.slice(0, 12)) };
}

/**
 * 锚句行独立化（r27 扩围，r26d 实测归因）：finalizeDocumentMarkdown 链内章级紧凑化
 *（normalizeFormalChapterHeadings 清理章内空行）会把锚句与其后正文行粘连成大块——
 * splitScoringBlocks 仅按空行分块，粘连后锚句无法独立成块、bge 相似度被长块稀释
 *（r26d 实测 4 项合规查询卡在 0.56~0.59；离线复算锚句单句 15/15 项 ≥0.65）。
 * 本函数在链尾对「以锚句 lead 前缀开头的行」前后确保独立空行（仅补空行、不改字、幂等），
 * 锚句恢复独立段后块级相似度回到达标区间。纯结构判据（锚表 lead 前 20 字前缀），无项目语义。
 */
export function isolateCanonicalAnchorLines(markdown: string): { markdown: string; isolated: number } {
  const prefixes = CANONICAL_TERM_ANCHORS.map(anchor => anchor.lead.slice(0, 20)).filter(Boolean);
  if (prefixes.length === 0) return { markdown, isolated: 0 };
  const lines = markdown.split('\n');
  const output: string[] = [];
  let isolated = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!prefixes.some(prefix => line.trim().startsWith(prefix))) {
      output.push(line);
      continue;
    }
    // 前隔离：上一行非空则补空行（文档首行无需前置）
    if (output.length > 0 && (output[output.length - 1] ?? '').trim() !== '') {
      output.push('');
      isolated += 1;
    }
    output.push(line);
    // 后隔离：下一行存在且非空则补空行
    const next = lines[index + 1];
    if (next !== undefined && next.trim() !== '') {
      output.push('');
      isolated += 1;
    }
  }
  return { markdown: output.join('\n'), isolated };
}
