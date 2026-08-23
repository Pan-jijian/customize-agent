const NL = String.fromCharCode(10);

/**
 * L5 编排导出：封面信息块 / 附图图位索引 / 关键工艺参数汇总附录。
 * 正文完成后追加到 Markdown 末尾，强化表格化渲染与图位管理。
 */

/** 施工组织设计标准封面：标题 + 项目基本信息表 */
export function composeEnhancedCoverMarkdown(title: string, facts?: Record<string, string>) {
  const factMap = facts || {};
  const pick = (...keys: string[]) => {
    const key = keys.find(item => Boolean(factMap[item]));
    return key ? String(factMap[key]).split('（来源')[0].trim() : '';
  };
  const projectName = pick('工程名称', '项目名称', '工程名');
  const builder = pick('建设单位', '建设单位名称', '发包人');
  const contractor = pick('施工单位', '承包单位', '承包人');
  const location = pick('建设地点', '工程地点', '项目地址');
  const scale = pick('建设规模', '建筑面积', '工程规模');
  const duration = pick('计划工期', '工期', '总工期');
  const quality = pick('质量标准', '质量目标', '质量等级');
  const infoRows = [
    ['工程名称', projectName || title],
    ['建设单位', builder],
    ['编制单位', contractor || builder],
    ['建设地点', location],
    ['建设规模', scale],
    ['计划工期', duration],
    ['质量标准', quality],
  ].filter(row => Boolean(row[1]));
  const coverTable = infoRows.length > 0
    ? ['', '| 项目 | 内容 |', '| --- | --- |', ...infoRows.map(row => `| ${row[0]} | ${row[1].replace(/\|/gu, '／')} |`)].join(NL)
    : '';
  return ['<div class="document-cover">', `# ${title}`, coverTable, '</div>'].filter(Boolean).join(NL);
}

function collectChapterTitles(markdown: string) {
  return [...markdown.matchAll(/^##\s+(.+)$/gmu)].map(match => ({ index: match.index || 0, title: (match[1] || '').trim() }));
}

function chapterTitleAt(titles: Array<{ index: number; title: string }>, index: number) {
  let current = '';
  for (const item of titles) {
    if (item.index > index) break;
    current = item.title;
  }
  return current;
}

/** 附录A：附图与图位索引 —— 归集正文引用的图号与引用上下文 */
export function composeDrawingIndexMarkdown(markdown: string) {
  const chapterTitles = collectChapterTitles(markdown);
  const refs = new Map<string, { chapter: string; caption: string }>();
  const drawingRefRe = /图\s*\d+(?:[-—–._]\s*\d+)?/gu;
  for (const match of markdown.matchAll(drawingRefRe)) {
    const index = match.index || 0;
    const before = markdown.slice(Math.max(0, index - 10), index);
    const tail = markdown.slice(index + match[0].length, index + match[0].length + 40);
    if (!/[见详参见如按依引用]/u.test(before) && !/所示|做法|大样|剖面|平面|立面|示意|附图/u.test(tail)) continue;
    const ref = match[0].replace(/\s+/gu, '');
    if (refs.has(ref)) continue;
    const caption = tail.replace(/\s+/gu, ' ').split(/[。；;|]/u)[0]?.trim().slice(0, 24) || '';
    refs.set(ref, { chapter: chapterTitleAt(chapterTitles, index), caption });
  }
  if (refs.size === 0) return '';
  const rows = [...refs.entries()].map(([ref, info]) => `| ${ref} | ${info.chapter} | ${info.caption ? `正文引用，上下文：${info.caption}` : '正文引用'} |`);
  return [
    '',
    '## 附录A：附图与图位索引',
    '',
    '> 图位说明：正文引用的图号由编制人按正式图纸目录替换核验，插图位置以各章小节内容对应布置。',
    '',
    '| 图号 | 所属章节 | 引用说明 |',
    '| --- | --- | --- |',
    ...rows,
  ].join(NL);
}

/** 附录B：关键工艺参数汇总 —— 归集正文工艺参数声明，供评标快速检索 */
export function composeProcessParameterSummaryMarkdown(markdown: string) {
  const chapterTitles = collectChapterTitles(markdown);
  const paramTermRe = /间距|偏差|厚度|压实度|坡度|强度等级|抗渗|配合比|坍落度|搭接长度|锚固长度|保护层|焊缝|闭水|严密性|垂直度|平整度|标高|涂层|养护|偏差值/u;
  const paramValueRe = /\d+(?:\.\d+)?\s*(?:mm|MPa|kN|kPa|℃|%|cm|m2|m3)/u;
  const rows: string[] = [];
  const seen = new Set<string>();
  const excludedTitles = new Set(['目录']);
  let offset = 0;
  for (const line of markdown.split(NL)) {
    offset += line.length + 1;
    if (!paramTermRe.test(line) || !paramValueRe.test(line)) continue;
    if (/^\s*[|#]/u.test(line)) continue;
    const compact = line.replace(/\s+/gu, ' ').trim();
    if (compact.length < 14 || compact.length > 100) continue;
    const chapter = chapterTitleAt(chapterTitles, offset);
    if (excludedTitles.has(chapter)) continue;
    const key = compact.slice(0, 36);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(`| ${chapter} | ${compact.replace(/\|/gu, '／')} |`);
    if (rows.length >= 40) break;
  }
  if (rows.length < 3) return '';
  return [
    '',
    '## 附录B：关键工艺参数汇总',
    '',
    '> 本表由正文工艺参数自动归集，供评标快速检索；正式投标文件以设计图纸与专项施工方案为准。',
    '',
    '| 所属章节 | 工艺参数要点 |',
    '| --- | --- |',
    ...rows,
  ].join(NL);
}

/** 汇总生成文档尾部的图位索引与参数汇总附录（无内容时返回空字符串） */
export function composeDocumentAppendicesMarkdown(markdown: string) {
  return [composeDrawingIndexMarkdown(markdown), composeProcessParameterSummaryMarkdown(markdown)].filter(Boolean).join(NL);
}
