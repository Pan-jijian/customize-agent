import type { ValidationIssue } from './types';
import { buildSemanticSimilarity, SEMANTIC_COVERAGE_THRESHOLD } from './semanticSimilarity';

/**
 * C5 应急预案小节深度门槛（round-17）：
 * 应急预案/应急措施/应急响应类小节必须达到可落地深度——正文 ≥300 字且具备
 * “组织/流程/物资”三要素（应急组织体系、应急处置程序与演练、应急物资保障），
 * 缺任一要素或字数不足即 error 进修复循环（llm_repairable 定向补写）。
 * 标题召回 + 字数为确定性判定，三要素由本地 bge 语义判定（封闭词表升级为语义原型）。
 * 全文无应急小节时不报（小节缺失判定由结构类检测器负责，本检测器只做深度门槛）。
 *
 * round-18 修复（E6：应急预案深度修复未生效）：
 * 1. 三要素按全文应急内容聚合判定——组织体系/响应流程/物资储备通常由不同小节分工承担
 *    （“应急管理组织与职责”“应急响应流程”“应急物资储备”各司其职，docx 标尺的“组织机构及职责/
 *    响应流程/应急物资”本就是预案体系内的并列部分而非每节必备），按单小节独立要求三要素会对
 *    天气专项措施节（防汛/防雷/大风）与响应流程节误报，LLM 无从补写 → 修复永远不收敛；
 * 2. 词表补全现场变体（“应急管理领导小组”等），否则 LLM 已补写组织体系仍因词面失配被判缺失。
 */

/** 应急小节标题封闭集（H2-H4 标题召回，排除目录行与表格行；含组织/物资/演练等分工小节） */
const EMERGENCY_SECTION_RE = /应急预案|应急措施|应急响应|应急救援|突发事件|应急管理|应急物资|应急演练|应急组织|应急保障/u;

/** 三要素语义原型：组织体系 / 处置程序与演练 / 物资保障（bge 余弦 ≥ 阈值判定要素存在） */
const EMERGENCY_ELEMENT_QUERIES = {
  organization: '应急管理领导小组、应急救援队伍的组织机构与职责分工',
  procedure: '应急处置程序、应急响应流程与应急演练安排',
  resource: '应急物资、应急器材设备的储备与保障措施',
} as const;

/** F3 应急物资复检口径：LLM 补写常以「物资名+数量」清单形态出现（急救箱2个、灭火器10具…），
 * 纯语义原型可能漏判导致补写已落位仍复检不通过；封闭物资名 + 配备/储备类动词确定性兜底，与语义判定取或 */
const EMERGENCY_RESOURCE_MATERIALS_RE = /应急物资|急救箱|灭火器|沙袋|发电机|水泵|对讲机|应急照明|应急灯|防护服|救援绳|救生衣|铁锹|编织袋|抽水泵|警示带|应急器材/u;
const EMERGENCY_RESOURCE_PROVISION_RE = /配备|储备|保障|配置|数量|不少于|共计|套|具|个|台|把|只/u;

/** 应急小节深度门槛字数（连续应急小节区块累计） */
const EMERGENCY_MIN_CHARS = 300;

export async function emergencySectionDepthIssues(markdown: string): Promise<ValidationIssue[]> {
  const lines = markdown.split(/\r?\n/u);
  const issues: ValidationIssue[] = [];
  let inBlock = false;
  const blockTitles: string[] = [];
  let blockText = '';
  let blockChars = 0;
  for (const line of lines) {
    const heading = /^(#{2,4})\s+(.+)$/u.exec(line.trim());
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].replace(/^\d+(?:\.\d+)*\s+/u, '').trim();
      if (EMERGENCY_SECTION_RE.test(title)) {
        // 应急标题（任意层级）进入/延续应急区；H4 子小节标题也计入标题列表便于定位
        inBlock = true;
        blockTitles.push(title);
        continue;
      }
      // 非应急 H2/H3 收口当前应急区；H4 非应急子节继续计入应急区文本
      if (level <= 3 && inBlock) inBlock = false;
      continue;
    }
    if (inBlock && line.trim() && !/^\s*\|/u.test(line)) {
      const compact = line.replace(/\s+/gu, '');
      blockText += compact;
      blockChars += compact.length;
    }
  }
  if (blockTitles.length === 0) return issues;
  const missing: string[] = [];
  if (blockChars < EMERGENCY_MIN_CHARS) missing.push(`字数仅 ${blockChars} 字（要求 ≥${EMERGENCY_MIN_CHARS} 字）`);
  // 三要素 bge 块级判定：聚合文本按 ≤200 字切块（避免长文本嵌入截断），任一子块命中即判定要素存在
  const slices = blockText.match(/.{1,200}/gu) || [];
  const elementQueries = Object.values(EMERGENCY_ELEMENT_QUERIES);
  const elementSimilarity = await buildSemanticSimilarity(slices, elementQueries);
  const hasElement = (query: string) => slices.some(slice => elementSimilarity(slice, query) >= SEMANTIC_COVERAGE_THRESHOLD);
  if (!hasElement(EMERGENCY_ELEMENT_QUERIES.organization)) missing.push('应急组织体系');
  if (!hasElement(EMERGENCY_ELEMENT_QUERIES.procedure)) missing.push('应急处置程序/演练');
  // F3：物资要素判定 = 语义原型 或 确定性「物资名+配备词」兜底，避免补写已落位仍判缺失
  const resourceOk = hasElement(EMERGENCY_ELEMENT_QUERIES.resource)
    || (EMERGENCY_RESOURCE_MATERIALS_RE.test(blockText) && EMERGENCY_RESOURCE_PROVISION_RE.test(blockText));
  if (!resourceOk) missing.push('应急物资保障');
  if (missing.length > 0) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'structure',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `应急预案小节深度不足：${blockTitles.join('、')}（缺少：${missing.join('、')}）`,
      suggestion: '补写应急组织体系（领导小组/抢险队与职责）、应急处置程序与演练安排、应急物资清单与保障措施，达到可落地深度。',
      // F2 小节锚点：修复循环定位优先直连应急小节，不再依赖消息关键字反查
      sectionTitle: blockTitles[0],
    });
  }
  return issues;
}
