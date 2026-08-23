import type { DocumentDraftChapter, ValidationIssue } from './types';
import { DEVICE_SPEC_RE, PROCESS_PARAMETER_RE } from './parameterPatterns';

export { DEVICE_SPEC_RE, PROCESS_PARAMETER_RE } from './parameterPatterns';

/**
 * L4 校验体系：面向施工组织设计的专业性审计校验器。
 *
 * 原有校验器只查"有没有数字"，本组校验器查"什么数字、什么段落、什么表格"：
 * 1. duplicateParagraphIssues      —— 跨小节重复段落检测（同段出现在多个小节）
 * 2. fillerParagraphIssues         —— 废话段落模式检测（模板化空话）
 * 3. processParameterDensityIssues —— 工艺参数密度（区分概况数字与工艺参数）
 * 4. sectionCardStructureIssues    —— 工作包三段式结构完整性
 * 5. tableCompletenessIssues       —— 表格空字段检测
 * 6. reviewResponseIssues          —— 招标硬性要求响应检测
 */

/** 废话段模式库：与既有 16 短语词表互补，覆盖 LLM 常见的整句式空话 */
const FILLER_PARAGRAPH_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /本小节围绕.+展开，结合绑定项目资料/u, label: '模板化开篇套话' },
  { pattern: /明确适用范围、控制目标、责任岗位与过程要求/u, label: '泛化目标罗列' },
  { pattern: /实施前应完成资料核对、技术交底和作业条件确认/u, label: '泛化前置条件' },
  { pattern: /交底覆盖率按\s*100%?\s*控制/u, label: '空泛交底承诺' },
  { pattern: /关键问题在\s*24\s*小时内形成整改责任/u, label: '空泛整改时限' },
  { pattern: /按施工准备→过程实施→检查验收→问题整改→资料归档的闭环组织/u, label: '通用闭环套话' },
  { pattern: /按作业条件确认→技术交底→过程实施→自检互检→整改复查/u, label: '通用流程套话' },
  { pattern: /依据本项目已确认资料中的项目边界/u, label: '资料依据套话' },
  { pattern: /执行日巡查、周复核和节点验收制度/u, label: '泛化巡查制度' },
  { pattern: /一般问题\s*7\s*日内闭环/u, label: '泛化整改时限' },
  { pattern: /由项目经理、技术负责人和专职安全员联合复核/u, label: '岗位名单堆砌' },
  { pattern: /确保与总体施工部署、工期计划和验收要求保持一致/u, label: '原则性呼应' },
  { pattern: /结合现场实际情况(?:，|,)?合理(?:组织|安排|布置|配置)/u, label: '结合实际套话' },
  { pattern: /严格(?:执行|落实|按照)国家(?:现行)?(?:有关)?(?:规范|标准|规程)/u, label: '规范泛引用' },
  { pattern: /做到(?:文明施工|安全生产|质量第一|安全第一)/u, label: '口号式承诺' },
  { pattern: /(?:确保|保证)工程(?:质量|安全|进度|文明施工)/u, label: '目标口号' },
  { pattern: /建立(?:健全)?(?:完善)?(?:的)?(?:管理)?体系(?:和|，)?(?:落实|确保|保证)/u, label: '体系空话' },
];

const WORK_PACKAGE_SECTION_PATTERNS = [/主要分部分项工程施工方案/u, /主要施工方法/u, /主要施工内容/u, /施工方案/u];

const BASIC_FACT_RE = /(?:建筑面积|面积|总建筑面积)[约]?\s*\d+(?:\.\d+)?\s*(?:㎡|m²)|计划工期\s*\d+|日历天|地上\s*\d+\s*层|框架结构|质量标准[:：]?\s*合格/giu;

/** 招标文件硬性要求关键词（评标响应检查基准） */
const REVIEW_RESPONSE_ITEMS: Array<{ key: string; patterns: RegExp[] }> = [
  { key: '质量标准', patterns: [/质量标准|质量要求|合格率/u] },
  { key: '计划工期', patterns: [/计划工期|工期要求|合同工期|日历天/u] },
  { key: '缺陷责任期/保修', patterns: [/缺陷责任期|保修|质保/u] },
  { key: '安全文明目标', patterns: [/安全.*目标|文明.*目标|安全事故.*零/u] },
  { key: '项目经理要求', patterns: [/项目经理|项目负责人|注册建造师/u] },
];

function extractSectionBlocks(content: string): Array<{ heading: string; body: string }> {
  const lines = content.split('\n');
  const blocks: Array<{ heading: string; body: string }> = [];
  let currentHeading = '';
  let currentBody: string[] = [];
  for (const line of lines) {
    const heading = /^#{3,4}\s+(.+)$/u.exec(line.trim());
    if (heading) {
      if (currentHeading || currentBody.length > 0) blocks.push({ heading: currentHeading, body: currentBody.join('\n') });
      currentHeading = heading[1].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentHeading || currentBody.length > 0) blocks.push({ heading: currentHeading, body: currentBody.join('\n') });
  return blocks;
}

function normalizeParagraph(text: string) {
  return text.replace(/[，。,.;；:：、（）()【】[\]《》“”"'`\s]/gu, '');
}

/** 从正文中提取段落（按句号分段的完整句组，长度≥60 字的才算可重复段落） */
function extractParagraphs(body: string): string[] {
  const cleaned = body
    .replace(/^#{1,6}\s+.*$/gmu, '')
    .replace(/^\s*\|.*\|\s*$/gmu, '')
    .replace(/^\s*[-|]\s*$/gmu, '')
    .replace(/^\s*\[.*?\]\(.*?\)\s*$/gmu, '');
  return cleaned
    .split(/\n{1,}/u)
    .map(item => item.trim())
    .filter(item => item.length >= 60 && item.length <= 400 && !/^\s*[-*]\s+/u.test(item));
}

/** 1. 跨小节重复段落检测：同一段落出现在 ≥2 个不同小节即为重复 */
export function duplicateParagraphIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const paragraphLocations = new Map<string, Array<{ chapter: string; section: string }>>();
  for (const chapter of chapters) {
    const blocks = extractSectionBlocks(chapter.content);
    for (const block of blocks) {
      const section = block.heading || chapter.title;
      for (const paragraph of extractParagraphs(block.body)) {
        const key = normalizeParagraph(paragraph);
        if (key.length < 60) continue;
        const locations = paragraphLocations.get(key) || [];
        if (!locations.some(item => item.chapter === chapter.title && item.section === section)) {
          locations.push({ chapter: chapter.title, section });
        }
        paragraphLocations.set(key, locations);
      }
    }
  }
  const reported = new Set<string>();
  for (const [key, locations] of paragraphLocations) {
    const uniqueLocations = locations.filter((item, index, array) => array.findIndex(other => other.chapter === item.chapter && other.section === item.section) === index);
    if (uniqueLocations.length < 2) continue;
    const fingerprint = uniqueLocations.map(item => `${item.chapter}::${item.section}`).sort().join('|');
    if (reported.has(fingerprint)) continue;
    reported.add(fingerprint);
    const sample = locations[0];
    const preview = sample ? `（如：${sample.section} 中「${key.slice(0, 30)}…」）` : '';
    issues.push({
      level: uniqueLocations.length >= 3 ? 'error' : 'warning',
      severity: uniqueLocations.length >= 3 ? 'blocker' : 'warning',
      message: `发现相同段落出现在 ${uniqueLocations.length} 个不同小节：${uniqueLocations.map(item => item.section).slice(0, 6).join('、')}${preview}`,
      suggestion: '每个小节必须针对其标题写专属内容，不得复制粘贴相同段落；重复小节应合并或删除后重写。',
    });
    if (issues.length >= 8) break;
  }
  return issues;
}

/** 2. 废话段落模式检测 */
export function fillerParagraphIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const blocks = extractSectionBlocks(chapter.content);
    const chapterHits: string[] = [];
    for (const block of blocks) {
      for (const { pattern, label } of FILLER_PARAGRAPH_PATTERNS) {
        if (pattern.test(block.body) && !chapterHits.includes(label)) chapterHits.push(label);
      }
    }
    if (chapterHits.length >= 3) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        message: `${chapter.title} 存在大量模板化空话（${chapterHits.slice(0, 6).join('、')}）`,
        suggestion: '删除"本小节围绕…展开""按100%控制"式套话，按"责任岗位+执行动作+量化标准+检查频次+整改时限"重写。',
      });
    } else if (chapterHits.length > 0) {
      issues.push({
        level: 'warning',
        severity: 'warning',
        message: `${chapter.title} 存在模板化空话：${chapterHits.join('、')}`,
        suggestion: '替换为具体量化做法；同一小节不得重复出现套话段落。',
      });
    }
  }
  return issues;
}

/** 3. 工艺参数密度：区分概况数字（面积/工期/层数）与工艺参数（mm/MPa/间距/偏差/试验） */
export function processParameterDensityIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const blocks = extractSectionBlocks(chapter.content);
    for (const block of blocks) {
      const isWorkPackageSection = WORK_PACKAGE_SECTION_PATTERNS.some(pattern => pattern.test(block.heading) || pattern.test(chapter.title));
      if (!isWorkPackageSection) continue;
      const processParams = new Set(block.body.match(PROCESS_PARAMETER_RE) || []);
      const basicFacts = new Set(block.body.match(BASIC_FACT_RE) || []);
      const deviceSpecs = new Set(block.body.match(DEVICE_SPEC_RE) || []);
      const bodyChars = block.body.length;
      if (bodyChars < 400) continue;
      const density = processParams.size / (bodyChars / 1000);
      // 拆除/清理/清底/运输类作业以工程量、作业边界与成品保护为核心控制点，参数载体为保护挑网宽度、警戒距离等 m 级安全参数；
      // 要求其 mm/MPa 级工艺参数既不符合专业实际，也会把合格的拆除方案误判为阻断项。
      const isDemolitionSection = /拆除|清理|清底|清运|弃置|运输|搬运/u.test(block.heading);
      if (processParams.size === 0) {
        // 设备清单型小节（如安装工程施工方案的配电箱配置）以型号/容量/等级参数为载体，不按工艺参数阻断
        if (deviceSpecs.size >= 6) {
          issues.push({
            level: 'warning',
            severity: 'warning',
            message: `${chapter.title} / ${block.heading} 以设备配置参数为主：设备型号/容量参数 ${deviceSpecs.size} 项，工艺参数待补充`,
            suggestion: '设备清单型小节保留型号规格参数即可；如补充安装工艺（试验压力、坡度、间距、偏差），应同步写入工艺参数与验收节点。',
          });
          continue;
        }
        if (isDemolitionSection) {
          issues.push({
            level: 'warning',
            severity: 'warning',
            message: `${chapter.title} / ${block.heading} 以工程量与保护措施为主，建议补充拆除深度偏差、保护挑网宽度、警戒距离等参数`,
            suggestion: '拆除类作业补充拆除厚度偏差（mm）、防护挑网/安全网宽度（m）、警戒区距离（m）等安全与技术参数即可，不强制 mm/MPa 级工艺参数。',
          });
          continue;
        }
        issues.push({
          level: 'error',
          severity: 'blocker',
          message: `${chapter.title} / ${block.heading} 无工艺参数：全文只有概况性数字，缺乏 mm/MPa/间距/偏差/试验压力等工艺级参数`,
          suggestion: '必须写入工艺参数（如桩位偏差≤50mm、搭接宽度≥100mm、闭水试验48h），参数来自绑定资料或行业规范值。',
        });
      } else if (density < (isDemolitionSection ? 0.3 : 1.5)) {
        issues.push({
          level: 'warning',
          severity: 'warning',
          message: `${chapter.title} / ${block.heading} 工艺参数密度偏低：每千字 ${processParams.size} 个工艺参数（概况数字 ${basicFacts.size} 个）`,
          suggestion: '增加工艺级参数落位；概况数字（面积、工期、层数）不能替代工艺参数。',
        });
      }
    }
  }
  return issues;
}

/** 4. 工作包三段式结构完整性（概况/流程/方法） */
export function sectionCardStructureIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const blocks = extractSectionBlocks(chapter.content);
    for (const block of blocks) {
      if (!/主要分部分项工程施工方案|主要施工方法/u.test(block.heading)) continue;
      const subPackages = block.body.split(/^####\s+/gmu).slice(1).map(item => item.trim()).filter(Boolean);
      if (subPackages.length === 0) continue;
      const incomplete = subPackages.filter(pkg => {
        const hasScope = /(?:施工)?(?:概况|范围)[:：]\s*\S/u.test(pkg) || /工程量|范围/u.test(pkg);
        const hasProcess = /(?:施工)?(?:流程|工序|顺序)[:：]\s*\S/u.test(pkg) || /→/u.test(pkg);
        const hasMethod = /(?:施工)?方法[:：]\s*\S/u.test(pkg);
        return !hasScope || !hasProcess || !hasMethod;
      });
      if (incomplete.length > 0) {
        issues.push({
          level: 'warning',
          severity: 'warning',
          message: `${chapter.title} / ${block.heading} 有 ${incomplete.length}/${subPackages.length} 个分部分项未按"概况/流程/方法"三段式展开`,
          suggestion: '参照"项目主要施工内容"工作包写法：概况=对象+工程量，流程=→工序链，方法=工艺参数+检测验收。',
        });
      }
    }
  }
  return issues;
}

/** 5. 表格空字段检测 */
export function tableCompletenessIssues(chapters: DocumentDraftChapter[], markdown = ''): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const wholeText = markdown || chapters.map(chapter => chapter.content).join('\n\n');
  // 按行扫描表格块：连续两个以上以 | 开头的行视为一个表格
  const lines = wholeText.split('\n');
  let tableIndex = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!/^\|.+\|$/u.test(line)) {
      index += 1;
      continue;
    }
    const tableLines: string[] = [];
    while (index < lines.length && /^\|.+\|$/u.test(lines[index].trim())) {
      tableLines.push(lines[index].trim());
      index += 1;
    }
    if (tableLines.length < 3) continue;
    tableIndex += 1;
    const header = tableLines[0];
    const columnCount = header.split('|').length - 2;
    const bodyRows = tableLines.filter((row, rowIndex) => {
      if (rowIndex === 0) return false;
      const withoutBars = row.replace(/\|/gu, '').replace(/[\s\-:]/gu, '');
      return withoutBars.length > 0; // 跳过对齐分隔行
    });
    const emptyCellCount = bodyRows.reduce((total, row) => {
      const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
      return total + cells.filter(cell => cell === '' || cell === '-' || cell === '—' || cell === '/').length;
    }, 0);
    const totalCells = bodyRows.length * Math.max(1, columnCount);
    if (emptyCellCount > 0 && emptyCellCount / Math.max(1, totalCells) >= 0.4) {
      issues.push({
        level: 'warning',
        severity: 'warning',
        message: `第 ${tableIndex} 个表格存在 ${emptyCellCount} 个空单元格（${bodyRows.length} 行），表格信息不完整`,
        suggestion: '表格每一列都必须填写，缺失字段应从资料补齐；无法确认的字段应删除该行而非留空。',
      });
    }
    if (issues.length >= 5) break;
  }
  return issues;
}

/** 6. 招标硬性要求响应检测 */
export function reviewResponseIssues(chapters: DocumentDraftChapter[], markdown = ''): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const wholeText = markdown || chapters.map(chapter => chapter.content).join('\n\n');
  for (const item of REVIEW_RESPONSE_ITEMS) {
    if (item.patterns.some(pattern => pattern.test(wholeText))) continue;
    issues.push({
      level: 'warning',
      severity: 'warning',
      message: `未检测到对招标硬性要求的响应：${item.key}`,
      suggestion: '招标文件中的工期、质量、保修、安全目标等硬性要求必须在施工组织设计中明确响应并落实责任。',
    });
  }
  return issues;
}

/** 全部审计校验器聚合 */
export function constructionOrgProfessionalAuditIssues(chapters: DocumentDraftChapter[], markdown = ''): ValidationIssue[] {
  return [
    ...duplicateParagraphIssues(chapters),
    ...fillerParagraphIssues(chapters),
    ...processParameterDensityIssues(chapters),
    ...sectionCardStructureIssues(chapters),
    ...tableCompletenessIssues(chapters, markdown),
    ...reviewResponseIssues(chapters, markdown),
  ];
}
