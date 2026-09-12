/**
 * helpers/projectBasicInfo：项目基本信息事实/表格（P3 拆分，逐字机械搬移自 documentGeneratorHelpers.ts）。
 * 依赖 markdownCleanup（表格工具）。
 */
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, ValidationIssue } from '../types';
import { normalizeOcrFactText, isValidProjectBasicFactValue } from '../factsModel';
import { buildCanonicalFacts } from '../factGovernance';
import { mergeTableLineBreaks, normalizeInlineListBreaks, normalizeMarkdownTableDividers, normalizeTenderSourcePageRefs, removeAdjacentDuplicateHeadings, dedupeCrossLevelHeadingDuplicates, dedupeRepeatedBlocksWithinSections } from '../markdownComposer';
import { BID_DISCIPLINE_PHRASES, dedupeCrossSectionSkeletonH4s, dedupeRepeatedSubsections, isBidDisciplineSentence, stringifyFactValue, throwIfAborted, WORK_PACKAGE_SECTION_RE } from '../utils';
import { isMarkdownTableSeparatorLine, looksLikeMarkdownTableLine, splitMarkdownTableLine, normalizeBareMarkdownTables, stripProvenanceTableColumns } from './markdownCleanup';

export const PROJECT_BASIC_FACT_QUERIES = [
  '项目名称 项目编号 招标人 项目概况与招标范围 建设地点 建设规模 计划工期 质量标准 合同估算价',
  '计划工期 合同工期 总工期 日历天',
  '合同估算价 合同估算价格 投资估算 最高投标限价 招标控制价',
  '质量标准 质量目标 合格',
  '建设地点 建设规模 招标范围',
];

export function projectBasicFactScore(text: string) {
  const normalized = normalizeOcrFactText(text);
  let score = 0;
  if (/项目名称|工程名称|招标项目名称|项目编号|招标项目编号|招标人|建设单位|发包人/u.test(normalized)) score += 4;
  if (/计划工期|合同工期|总工期|\d+(?:\.\d+)?\s*(?:日历天|天|个月|月|年)/u.test(normalized)) score += 6;
  if (/合同估算价|投资估算|最高投标限价|招标控制价|\d+(?:\.\d+)?\s*(?:万元|元)/u.test(normalized)) score += 5;
  if (/质量标准|质量目标|合格|优良/u.test(normalized)) score += 4;
  if (/建设地点|建设规模|招标范围|项目概况与招标范围/u.test(normalized)) score += 4;
  if (/工程量|清单|图纸|设计说明|施工范围|施工内容|材料|设备|工艺|验收|复试|检测/u.test(normalized)) score += 3;
  // 窄过滤（模块1b）：只减分纯程序性短语（账户/开标评标程序/交易系统），放行前附表实质条款。
  // 历史缺陷：宽词「投标人须知」把整个前附表章节切片减分（实质条款如创优目标/绿色建筑等级被压出
  // 检索 Top-N）；「保证金」误伤履约/质量保证金；「违约金」误伤工期延误赔偿条款（施组必须响应）。
  if (/保证金账户|开户行|开户名称|收款账户|汇款|转账账户|电子交易系统|公共资源交易|开标时间|开标地点|评标委员会|评标办法/u.test(normalized)) score -= 4;
  return score;
}

export function projectBasicFactCandidates(facts: DocumentFact[]) {
  return facts.filter(fact => /项目名称|工程名称|项目编号|招标项目编号|招标人|建设单位|发包人|建设地点|建设规模|招标范围|计划工期|合同工期|周期要求|质量标准|合同估算|投资估算|最高投标限价|招标控制价/u.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`));
}

export function projectBasicValueFor(facts: DocumentFact[], patterns: RegExp[]) {
  return projectBasicFactCandidates(facts)
    .filter(fact => patterns.some(pattern => pattern.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`)))
    .filter(fact => isValidProjectBasicFactValue(fact.fieldId, fact.value))
    .sort((a, b) => {
      const aText = stringifyFactValue(a.value);
      const bText = stringifyFactValue(b.value);
      const aScore = (a.sourceFile?.includes('招标文件') ? 3 : 0) + (a.sourceRef?.sectionTitle && /项目概况|招标公告|前附表|招标范围/u.test(a.sourceRef.sectionTitle) ? 2 : 0) - Math.floor(aText.length / 80);
      const bScore = (b.sourceFile?.includes('招标文件') ? 3 : 0) + (b.sourceRef?.sectionTitle && /项目概况|招标公告|前附表|招标范围/u.test(b.sourceRef.sectionTitle) ? 2 : 0) - Math.floor(bText.length / 80);
      return bScore - aScore;
    })[0]?.value;
}

export function repairKnownProjectBasicPlaceholders(content: string, facts: DocumentFact[]) {
  const candidates = projectBasicFactCandidates(facts);
  if (candidates.length === 0) return content;
  let next = content;
  const valueFor = (patterns: RegExp[]) => projectBasicValueFor(facts, patterns);
  const replacements: Array<{ label: RegExp; value?: unknown }> = [
    { label: /计划工期|合同工期|周期要求/u, value: valueFor([/计划工期|合同工期|周期要求|schedule_requirement/u]) },
    { label: /质量标准|质量目标/u, value: valueFor([/质量标准|quality_standard/u]) },
    { label: /合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u, value: valueFor([/合同估算|投资估算|最高投标限价|招标控制价|project_investment_estimate/u]) },
    { label: /建设地点/u, value: valueFor([/建设地点|project_location/u]) },
    { label: /建设规模/u, value: valueFor([/建设规模|project_scale/u]) },
  ];
  for (const item of replacements) {
    const value = cleanInlineFactValue(stringifyFactValue(item.value || ''));
    if (!value) continue;
    next = next.replace(new RegExp(`(${item.label.source})(\\s*[|：:]\\s*)(?:资料未明确|系统暂未从知识库确认|项目资料暂未明确)[^|\\n。；;]*`, 'gu'), `$1$2${value}`);
  }
  return next;
}

export function cleanInlineFactValue(value: string) {
  return normalizeOcrFactText(value)
    // 完整页码引用（“PDF 第N页”含“第 5-8 页”范围形态）与正文侧 normalizeTenderSourcePageRefs
    // 同口径归一为“相关资料”，避免落入下方残片删除分支被误删成“ N 页”（空格+数字形态误删现场）
    .replace(/PDF\s*第\s*\d+(?:\s*[-—至到~～]\s*\d+)?\s*页/giu, '相关资料')
    // 残缺页码引用残片（“PDF 第”后无数字）：fact 抽取复制招标文件封面页码引用时截断，
    // 直接删除残片保留其前文本；lookahead 允许空格/tab 后跟数字（“PDF 第 3 页”属完整引用，由上一条归一），
    // 不跨行（\n 后数字的跨行残片仍删除）；数字与“日”间多余空格一并归一（“2026年8月19 日”）
    .replace(/PDF\s*第(?![ \t]*[0-9０-９])/giu, '')
    .replace(/(\d)\s+(日)/gu, '$1$2')
    .replace(/[。；;]$/u, '')
    .trim();
}

export function parseProjectBasicRowsFromMarkdown(content: string) {
  const rows = new Map<string, [string, string]>();
  for (const line of content.split(/\r?\n/u)) {
    if (!/^\|.*\|\s*$/u.test(line) || /^\|\s*:?-{3,}:?/u.test(line)) continue;
    const cells = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.replace(/\*\*/gu, '').trim());
    if (cells.length < 2) continue;
    const label = cells[0] === '序号' && cells.length >= 3 ? cells[1] : cells[0];
    const value = cells[0] === '序号' && cells.length >= 3 ? cells[2] : cells[1];
    const source = cells[0] === '序号' && cells.length >= 4 ? cells[3] : cells[2];
    const normalizedLabel = label.replace(/\/|：|:/gu, '').trim();
    if (!/项目名称|工程名称|项目编号|招标项目编号|招标人|项目业主|建设单位|发包人|建设地点|建设规模|施工范围|招标范围|计划工期|合同工期|质量标准|合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u.test(normalizedLabel)) continue;
    const fieldId = /计划工期|合同工期/u.test(normalizedLabel) ? 'schedule_requirement'
      : /质量标准/u.test(normalizedLabel) ? 'quality_standard'
        : /合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u.test(normalizedLabel) ? 'project_investment_estimate'
          : /招标人|项目业主|建设单位|发包人/u.test(normalizedLabel) ? 'owner'
            : /建设地点/u.test(normalizedLabel) ? 'project_location'
              : /项目编号|招标项目编号/u.test(normalizedLabel) ? 'project_code'
                : undefined;
    if (!value || /内容|参数|资料未明确|系统暂未从知识库确认|项目资料暂未明确/u.test(value) || !isValidProjectBasicFactValue(fieldId || 'project_name', value)) continue;
    rows.set(normalizedLabel, [cleanInlineFactValue(value), cleanInlineFactValue(source || '项目资料') || '项目资料']);
  }
  return rows;
}

export function markdownRowValue(parsedRows: Map<string, [string, string]>, patterns: RegExp[]) {
  for (const [label, value] of parsedRows.entries()) {
    if (patterns.some(pattern => pattern.test(label))) return value;
  }
  return undefined;
}

/** P5（评分报告合肥师范4）：基本信息表“质量标准”只写“合格”而创优目标（确保黄山 杯）落在
 * 创优目标事实/正文中——质量标准行补全创优目标短语，与正文创优响应同口径。
 * 仅在明确“确保X杯/奖/优质工程”表述存在且质量值未含创优词时附加，无创优目标项目零变化。
 * 丰乐镇第 3 轮实测：字符类必须排斥“、”——否则“确保创优目标不流于形式、奖惩承诺可追溯可执行”
 * 被截成残句“确保创优目标不流于形式、奖”（“奖惩”首字）写入质量标准单元格。 */

const AWARD_OBJECTIVE_IN_TEXT_RE = /(?:黄山杯|鲁班奖|白玉兰杯|钱江杯|扬子杯|安济杯|长安杯|汾水杯|省优|市优|国优|优质工程|确保[^。；;|，、,\n]{0,10}(?:杯|奖))/u;

function awardObjectivePhrase(facts: DocumentFact[], fullMarkdown: string): string | undefined {
  // 权威否定校验（丰乐镇第五轮）：招标文件「创优目标☑无」时不得杜撰创优短语——
  // 事实层明确否定（无/不设类）时阻断；无任何创优事实时保留正文口径兜底（第 3 轮设计），
  // 不强制要求创优事实存在（正文兜底场景：事实未提取但正文已写「确保黄山杯」）
  const awardFacts = facts.filter(fact => /创优|优质优价|奖项|奖惩|award/u.test(`${fact.fieldId || ''}${fact.key || ''}${fact.fieldName || ''}`));
  const hasExplicitNoAward = awardFacts.some(fact => {
    const value = cleanInlineFactValue(stringifyFactValue(fact.value || ''));
    return Boolean(value) && /^(?:无|否|不设|未设|无创优|无奖项|不作|不要求|不设创优)$/u.test(value.trim());
  });
  if (hasExplicitNoAward) return undefined;
  const texts: string[] = [];
  for (const fact of awardFacts) {
    texts.push(cleanInlineFactValue(stringifyFactValue(fact.value || '')));
  }
  texts.push(fullMarkdown);
  for (const text of texts) {
    const match = /(?:确保|争创|力争|确保获得)[^。；;|，、,\n]{0,12}(?:杯|奖|优质工程)/u.exec(text);
    if (!match) continue;
    const phrase = match[0].trim();
    if (phrase.length >= 5 && phrase.length <= 24) return phrase;
  }
  return undefined;
}

export function projectBasicInfoRows(facts: DocumentFact[], existingMarkdown = '', fullMarkdown = existingMarkdown) {
  const parsedRows = parseProjectBasicRowsFromMarkdown(existingMarkdown);
  const canonical = buildCanonicalFacts({ facts, markdown: fullMarkdown });
  const cleanProjectBasicCell = (value: unknown) => cleanInlineFactValue(stringifyFactValue(value || ''))
    .replace(/\|/gu, '')
    .replace(/\bCOL\d+\b/gu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  const fallbackProjectName = () => {
    const candidates = [
      /([\u4e00-\u9fa5A-Za-z0-9（）()\-—_\s·]+?(?:施工总承包项目|一期项目|学生宿舍一期|学生宿舍项目))/u.exec(fullMarkdown)?.[1],
      /项目名称[：:\s|]+([^|\n。；;]{6,80})/u.exec(fullMarkdown)?.[1],
    ].map(cleanProjectBasicCell).filter(value => value && isValidProjectBasicFactValue('project_name', value));
    return candidates[0] ? [candidates[0], '项目资料'] as [string, string] : undefined;
  };
  const pickCanonical = (key: string, fallbackPatterns: RegExp[]): [string, string] => {
    const fact = canonical.get(key);
    if (fact) {
      const value = cleanProjectBasicCell(fact.value);
      if (value && isValidProjectBasicFactValue(key, value)) return [value, fact.source || '项目资料'] as [string, string];
    }
    // 固化环路切断（丰乐镇第五轮）：旧 markdown 信息表捞值必须过同口径校验，
    // 脏值（编号粘连/创优截断/错源规模）不得自我复制固化回新表
    const fallbackRow = markdownRowValue(parsedRows, fallbackPatterns);
    if (fallbackRow && isValidProjectBasicFactValue(key, fallbackRow[0])) return [fallbackRow[0], fallbackRow[1] || '项目资料'];
    return (key === 'project_name' ? fallbackProjectName() : undefined) || ['', ''];
  };
  const rows: Array<[string, string, string]> = [
    ['项目名称', ...pickCanonical('project_name', [/项目名称|工程名称|project_name/u])],
    ['项目编号', ...pickCanonical('project_code', [/项目编号|招标项目编号|project_code/u])],
    ['招标人', ...pickCanonical('owner', [/招标人|项目业主|建设单位|发包人|owner/u])],
    ['建设地点', ...pickCanonical('project_location', [/建设地点|project_location/u])],
    ['建设规模', ...pickCanonical('project_scale', [/建设规模|project_scale/u])],
    ['计划工期', ...pickCanonical('schedule_requirement', [/计划工期|合同工期|周期要求|schedule_requirement/u])],
    ['质量标准', ...pickCanonical('quality_standard', [/质量标准|quality_standard/u])],
    ['合同估算价', ...pickCanonical('project_investment_estimate', [/合同估算|投资估算|最高投标限价|招标控制价|project_investment_estimate/u])],
  ];
  // P5（评分报告合肥师范4）：质量标准行补全创优目标（正文写“确保黄山杯”而汇总表只写“合格”）
  const qualityRow = rows.find(([label]) => label === '质量标准');
  if (qualityRow && qualityRow[1] && !AWARD_OBJECTIVE_IN_TEXT_RE.test(qualityRow[1])) {
    const objective = awardObjectivePhrase(facts, fullMarkdown);
    if (objective && !qualityRow[1].includes(objective)) qualityRow[1] = `${qualityRow[1]}，${objective}`;
  }
  return rows.filter(([, value]) => Boolean(value)).map(([label, value, source]) => [label, value, source || '项目资料'] as [string, string, string]);
}

export function projectBasicInfoTableMarkdown(facts: DocumentFact[], existingMarkdown = '', fullMarkdown = existingMarkdown) {
  const rows = projectBasicInfoRows(facts, existingMarkdown, fullMarkdown);
  return ['**项目基本信息表**', '', '| 信息项 | 内容 |', '|---|---|', ...rows.map(row => `| ${row[0]} | ${row[1]} |`)].join('\n');
}

const PROJECT_BASIC_LABELS = [/^项目名称$/u, /^工程名称$/u, /^项目编号$/u, /^招标项目编号$/u, /^招标人$/u, /^项目业主$/u, /^建设单位$/u, /^发包人$/u, /^建设地点$/u, /^实施地点$/u, /^建设规模$/u, /^工程规模$/u, /^计划工期$/u, /^合同工期$/u, /^总工期$/u, /^质量标准$/u, /^质量目标$/u, /^合同估算价$/u, /^投资估算$/u, /^最高投标限价$/u, /^招标控制价$/u];

function isProjectBasicLabel(label: string) {
  return PROJECT_BASIC_LABELS.some(pattern => pattern.test(label));
}

export function removeDuplicateProjectBasicInfoBlocks(markdown: string) {
  const lines = markdown.replace(/\r?\n/gu, '\n').split('\n');
  const output: string[] = [];
  let seenProjectBasicTable = false;
  const splitRow = (line: string) => splitMarkdownTableLine(line).map(cell => cell.replace(/\*\*/gu, '').trim());
  const isTwoColumnProjectBasicTable = (rows: string[]) => {
    const dataRows = rows.slice(2).map(splitRow).filter(cells => cells.length >= 2);
    const labels = dataRows.map(cells => cells[0] || '');
    const matched = labels.filter(isProjectBasicLabel).length;
    return matched >= 3 && matched >= Math.ceil(labels.length * 0.45);
  };
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    const next = lines[index + 1] || '';
    // eslint-disable-next-line no-control-regex -- [^\u000A] 与原始 [^\n] 语义等价（编辑工具会破坏字面换行转义，改用 unicode 转义）
    const namedProjectBasicTitle = /(?:\*\*[^\u000A]*项目基本信息表[^\u000A]*\*\*|####\s+[^\u000A]*项目基本信息表[^\u000A]*|###\s+[^\u000A]*项目基本信息表[^\u000A]*)/u.test(line);
    if (namedProjectBasicTitle) {
      const block: string[] = [line];
      index += 1;
      while (index < lines.length && !(looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) && (lines[index] || '').trim() === '') {
        block.push(lines[index] || '');
        index += 1;
      }
      if (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) {
        block.push(lines[index] || '', lines[index + 1] || '');
        index += 2;
        while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) {
          block.push(lines[index] || '');
          index += 1;
        }
      }
      if (!seenProjectBasicTable) {
        seenProjectBasicTable = true;
        output.push(...block);
      }
      continue;
    }
    if (/^###\s+(?:\d+\.\d+\s+)?(?:项目基本信息|工程概况|项目概况)\s*$/u.test(line)) {
      const block: string[] = [line];
      index += 1;
      while (index < lines.length && !(looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) && !/^###\s+/u.test(lines[index] || '')) {
        block.push(lines[index] || '');
        index += 1;
      }
      if (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) {
        const rows = [lines[index] || '', lines[index + 1] || ''];
        index += 2;
        while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) {
          rows.push(lines[index] || '');
          index += 1;
        }
        if (isTwoColumnProjectBasicTable(rows)) {
          if (!seenProjectBasicTable) {
            seenProjectBasicTable = true;
            output.push(...block, ...rows);
          } else {
            const prose = block.filter(item => item.trim() && !/^###\s+/u.test(item));
            if (prose.length) output.push(line, ...prose);
          }
          continue;
        }
        output.push(...block, ...rows);
        continue;
      }
      output.push(...block);
      continue;
    }
    if (looksLikeMarkdownTableLine(line) && isMarkdownTableSeparatorLine(next)) {
      const rows = [line, next];
      index += 2;
      while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) {
        rows.push(lines[index] || '');
        index += 1;
      }
      if (isTwoColumnProjectBasicTable(rows)) {
        if (!seenProjectBasicTable) {
          seenProjectBasicTable = true;
          output.push(...rows);
        }
        continue;
      }
      output.push(...rows);
      continue;
    }
    output.push(line);
    index += 1;
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\n{1,2}\|\s*信息项\s*\|\s*内容\s*\|\s*\n+(?:该小节围绕[^\n]*\n+)+\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*/gu, '\n\n');
}

function removeRedundantFormalTables(content: string) {
  const removeSectionByTitle = (markdown: string, titles: RegExp[]) => {
    const lines = markdown.split('\n');
    const output: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] || '';
      const heading = /^(#{3,5})\s+(.+)$/u.exec(line.trim());
      const normalizedTitle = heading?.[2]?.replace(/^\d+(?:\.\d+)*\s+/u, '').trim() || '';
      if (heading && titles.some(title => title.test(normalizedTitle))) {
        index += 1;
        while (index < lines.length && !/^#{2,5}\s+/u.test((lines[index] || '').trim())) index += 1;
        index -= 1;
        continue;
      }
      output.push(line);
    }
    return output.join('\n');
  };
  return removeSectionByTitle(content, [/^工程概况一览表$/u, /^招标文件?评分.*响应索引表$/u, /^招标评分项响应索引表$/u])
    .replace(/\*\*(?:工程概况一览表|招标文件?评分.*响应索引表|招标评分项响应索引表)\*\*[\s\S]*?(?=\n{2,}#{2,5}\s+|\n{2,}(?:[^|\n#]|$)|$)/gu, '')
    .replace(/\n{3,}/gu, '\n\n');
}

/** 旧项目基础信息表块删除（收窄版）：只删除「项目基础信息类」表格块——两列信息项表
 * （项目名称/招标人等标签行占比达标）或三列序号表（序号|项目名称|内容参数）。
 * 编制依据表（依据类别|主要文件及标准）、工程概况信息表等专业表格不在标签集内天然豁免，
 * 消除旧正则跨空行贪婪连坐删除聚合块（H4 子小节）内其他表格的缺陷。 */

function removeProjectBasicInfoTableBlocks(content: string) {
  const lines = content.split('\n');
  const output: string[] = [];
  const isBasicTable = (rows: string[]) => {
    const firstCells = splitMarkdownTableLine(rows[0] || '').map(cell => cell.replace(/\*\*/gu, '').trim());
    if (firstCells[0] === '序号' && /项目名称/u.test(firstCells[1] || '')) return true;
    const dataRows = rows.slice(2).map(splitMarkdownTableLine).filter(cells => cells.length >= 2);
    if (dataRows.length === 0) return false;
    const labels = dataRows.map(cells => (cells[0] || '').replace(/\*\*/gu, '').trim());
    const matched = labels.filter(isProjectBasicLabel).length;
    return matched >= 3 && matched >= Math.ceil(labels.length * 0.45);
  };
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    // 「**项目基本信息表**」加粗标题行（或 H3-H5 同名标题）及其紧随的表格块整体删除
    if (/^\s*\*\*[^\n]*项目基本信息表[^\n]*\*\*\s*$/u.test(line) || /^\s*#{3,5}\s+[^\n]*项目基本信息表\s*$/u.test(line)) {
      index += 1;
      while (index < lines.length && (lines[index] || '').trim() === '') index += 1;
      if (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) {
        index += 1;
        while (index < lines.length && (looksLikeMarkdownTableLine(lines[index] || '') || isMarkdownTableSeparatorLine(lines[index] || ''))) index += 1;
      }
      continue;
    }
    // 裸表格块（表头+分隔行+连续数据行）：仅项目基础信息类删除，其他表格完整保留
    if (looksLikeMarkdownTableLine(line) && index + 1 < lines.length && isMarkdownTableSeparatorLine(lines[index + 1] || '')) {
      const rows: string[] = [line, lines[index + 1] || ''];
      let cursor = index + 2;
      while (cursor < lines.length && looksLikeMarkdownTableLine(lines[cursor] || '')) {
        rows.push(lines[cursor] || '');
        cursor += 1;
      }
      if (isBasicTable(rows)) {
        index = cursor;
        continue;
      }
    }
    output.push(line);
    index += 1;
  }
  return output.join('\n');
}

export function normalizeProjectBasicInfoTable(content: string, facts: DocumentFact[]) {
  content = removeRedundantFormalTables(content);
  if (!/项目基本信息|项目概况|工程概况|招标范围/u.test(content)) return removeDuplicateProjectBasicInfoBlocks(normalizeBareMarkdownTables(stripProvenanceTableColumns(content)));
  // 注入锚点 H2~H4（舒城实测：第一章标题为「## 工程概况」H2 形态，原 #{3,4} 锚点永不命中
  // → 总控要求「项目基本信息表」整表缺失）；优先精确主题标题，退而求其次取章内第一个标题
  const projectHeadingRe = /^(#{2,4}\s+(?:\d+\.\d+\s+)?[^\n]*(?:项目概况|工程概况|项目基本信息|招标范围)[^\n]*\n)/mu;
  const fallbackHeadingRe = /^(#{2,4}\s+(?:\d+\.\d+\s+)?[^\n]*(?:概况|基本信息)[^\n]*\n)/mu;
  const findProjectHeading = () => projectHeadingRe.exec(content) ?? fallbackHeadingRe.exec(content);
  if (!/\|\s*信息项\s*\|\s*内容\s*\|/u.test(content) && projectBasicFactCandidates(facts).length > 0) {
    const firstProjectHeading = findProjectHeading();
    if (firstProjectHeading?.index || firstProjectHeading?.index === 0) {
      const insertAt = firstProjectHeading.index + firstProjectHeading[0].length;
      const table = `${projectBasicInfoTableMarkdown(facts, '', content)}\n\n`;
      content = `${content.slice(0, insertAt)}\n${table}${content.slice(insertAt).trimStart()}`;
    }
  }
  const projectSection = findProjectHeading();
  if (!projectSection?.index && projectSection?.index !== 0) return content;
  const sectionStart = projectSection.index;
  const sectionBodyStart = sectionStart + projectSection[0].length;
  // 小节边界必须停在下一个 H2/H3/H4（取更早者）：H4 边界缺失时聚合块（### 1.1 编制说明与工程概况
  // 下挂 #### 1.1.1/1.1.2/1.1.3 小节）的正文被整块吞入 body，旧表删除正则连坐删除
  // 编制依据表与工程概况信息表（真实生成缺陷：两张表数据行全部丢失）
  const nextHeading = /^#{2,4}\s+/gmu;
  nextHeading.lastIndex = sectionBodyStart;
  const nextMatch = nextHeading.exec(content);
  const sectionEnd = nextMatch?.index ?? content.length;
  const body = content.slice(sectionBodyStart, sectionEnd);
  const table = projectBasicInfoTableMarkdown(facts, body, content);
  const hasUsefulFact = projectBasicInfoRows(facts, body, content).some(row => !/资料未明确|系统暂未从知识库确认|项目资料暂未明确/u.test(row[1]));
  if (!hasUsefulFact) return content;
  // 旧基本信息表删除只作用于项目基础信息类表格块（标签集判定），
  // 编制依据表、工程概况信息表等专业表格完整保留（详见 removeProjectBasicInfoTableBlocks）
  const cleanedBody = removeProjectBasicInfoTableBlocks(body)
    // eslint-disable-next-line no-control-regex -- [^\u000A] 与原始 [^\n] 语义等价（编辑工具会破坏字面换行转义，改用 unicode 转义）
    .replace(/该小节围绕“[^”]+”进行补充说明[^\u000A]*(?:\u000A\u000A该小节围绕“[^”]+”进行补充说明[^\u000A]*)*/gu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  const rebuiltSection = `${projectSection[0].trimEnd()}\n\n${table}${cleanedBody ? `\n\n${cleanedBody}` : ''}\n\n`;
  return removeDuplicateProjectBasicInfoBlocks(normalizeBareMarkdownTables(stripProvenanceTableColumns(`${content.slice(0, sectionStart)}${rebuiltSection}${content.slice(sectionEnd).trimStart()}`)));
}

export function projectBasicPlaceholderIssues(markdown: string, facts: DocumentFact[]) {
  if (projectBasicFactCandidates(facts).length === 0 || !/资料未明确|系统暂未从知识库确认|项目资料暂未明确/u.test(markdown)) return [];
  const labels = ['计划工期', '合同工期', '质量标准', '合同估算价', '合同估算价格', '建设地点', '建设规模'];
  return labels.filter(label => new RegExp(`${label}[^\n|。；;]{0,40}(?:资料未明确|系统暂未从知识库确认|项目资料暂未明确)`, 'u').test(markdown)).map(label => ({ level: 'error' as const, message: `${label} 已抽取到项目资料事实但正文仍显示暂未明确`, suggestion: '请优先使用项目基础事实卡片中的资料原值，不得用占位表达覆盖已确认事实。' }));
}
