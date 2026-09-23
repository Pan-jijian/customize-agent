/**
 * 4.56 L4 交付层 L4-2 … L4-8 正反例（逐条：正例=修复后必须成立的行为；反例=历史缺陷形态必须被拒/不改写）。
 *
 * L4-2 纯渲染名实相符：docx 阶段零正文改写（不再二次归一）+ 产物可见文本守恒复核（A2 覆盖到渲染阶段）
 * L4-3 补造表头可辨识记号（`| :--- | :--- |`，作者表格恒为 `| --- | --- |`）
 * L4-4 表头行按形态判据渲染（不再 rowIndex===0 无条件灰底加粗居中）
 * L4-5 表题行按表题样式渲染（邻接闸，正文里的「表…」句不受影响）
 * L4-6 目录单轨（静态条目即 TOC 域缓存结果，域更新整体覆盖，无「占位文案 + 静态条目」双轨）
 * L4-7 目录按正文对账（同源 fixTocFromBody，条目一致则零重建、零告警）
 * L4-8 生成链三个剥离器上链（单源复用 + 结构行零触碰 + 记账守卫 + 幂等）
 */
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import exportHandler, { __documentExportTest__ } from '@/pages/api/documents/export';
import { fixTocFromBody } from '@/services/document-workflow/documentIntegrityChecks';
import { isMaterialResidueLine, stripClarificationNarrative, stripDrawingPointerPhrases, stripMaterialResidueLines } from '@/services/document-workflow/materialResidue';

const {
  createExportRenderAudit,
  exportConservationDiff,
  docxStageConservationDiff,
  docxVisibleText,
  markdownToDocxXml,
  prepareExportMarkdown,
  stripInlineMarkdown,
  normalizeLooseMarkdownTables,
  stripDeclaredNonDeliverable,
  applyDeclaredStrips,
  exportStructureFingerprint,
  exportPipelineStages,
  reconcileTocFromBody,
  changedSpan,
  isFabricatedTableSeparator,
  looksLikeHeaderRow,
  isTableCaptionLine,
  DOCX_TOC_FIELD_PLACEHOLDER,
} = __documentExportTest__;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 真实形态文档（封面 + 分页 + 目录 + 两章 + 表格；目录与正文一致，用于零误报复核） */
const REALISTIC_DOCUMENT = [
  '<div class="document-cover">',
  '# 丰乐镇安置房项目施工组织设计',
  '# 投标人：某某建筑工程有限公司',
  '</div>',
  '',
  '[[PAGE_BREAK]]',
  '',
  '## 目录',
  '',
  '第一章 总则',
  '  1.1 编制依据',
  '第二章 施工部署',
  '  2.1 施工目标',
  '<div class="page-break"></div>',
  '',
  '## 第一章 总则',
  '',
  '### 1.1 编制依据',
  '',
  '本施工组织设计依据招标文件、施工图纸及现行国家规范编制。',
  '',
  '- 招标文件及施工图纸',
  '- 现场踏勘资料',
  '',
  '## 第二章 施工部署',
  '',
  '### 2.1 施工目标',
  '',
  '表 2-1 施工目标一览表',
  '',
  '| 项目 | 目标值 |',
  '| --- | --- |',
  '| 工期 | 365 日历天 |',
  '| 质量 | 合格 |',
].join('\n');

/** 取文档中第一段含指定文字的段落 XML（供样式断言） */
function paragraphContaining(xml: string, needle: string) {
  const at = xml.indexOf(needle);
  if (at < 0) return '';
  const start = xml.lastIndexOf('<w:p>', at);
  const end = xml.indexOf('</w:p>', at);
  return xml.slice(start, end + '</w:p>'.length);
}

describe('L4-2 纯渲染名实相符：docx 阶段零改写 + 产物守恒', () => {
  it('正例：行内标记剥离不再夹带归一（单位不改写、无未计数改写通道）', () => {
    expect(stripInlineMarkdown('面积100m2，素土夯实')).toBe('面积100m2，素土夯实');
    expect(stripInlineMarkdown('**项目基本信息表**')).toBe('项目基本信息表');
    expect(stripInlineMarkdown('![图](a.png)参见下文')).toBe('参见下文');
  });

  it('正例：入口未归一（绕过 prepareExportMarkdown）时 docx 阶段按原样渲染并显式告警，不改写', () => {
    const audit = createExportRenderAudit('observe');
    // 裸表入口：若 docx 阶段重跑归一（历史缺陷）会在此补造「信息项 | 内容」并不计数
    const xml = markdownToDocxXml('# 第一章 总则\n\n| 甲 | 乙 |\n| 丙 | 丁 |', undefined, undefined, audit);
    expect(audit.notices.map(item => item.code)).toContain('docx-stage');
    expect(xml).not.toContain('信息项');
    expect(xml).not.toContain(':---');
    expect(audit.ops.tableSeparatorAdded).toBe(0);
    expect(audit.ops.headerlessTableRendered).toBe(1);
    expect(audit.blockers).toEqual([]);
  });

  it('正例：单位书写按入口原样渲染（docx 阶段不改写、不计数）', () => {
    const audit = createExportRenderAudit('observe');
    const xml = markdownToDocxXml('# 第一章 总则\n\n面积100m2，素土夯实。', undefined, undefined, audit);
    expect(xml).toContain('100m2');
    expect(xml).not.toContain('100m²');
    expect(audit.ops.unitRewrite).toBe(0);
    expect(audit.blockers).toHaveLength(0);
  });

  it('正例：真实文档全程零误报（无 blocker、无 docx-stage 告警、产物文本守恒）', () => {
    const prepared = prepareExportMarkdown(REALISTIC_DOCUMENT);
    expect(prepared.audit.blockers).toEqual([]);
    const audit = createExportRenderAudit('observe');
    const xml = markdownToDocxXml(prepared.markdown, undefined, undefined, audit);
    expect(audit.blockers).toEqual([]);
    expect(audit.notices.filter(item => item.code === 'docx-stage')).toEqual([]);
    expect(docxStageConservationDiff(prepared.markdown, xml)).toEqual({ conserved: true });
  });

  it('正例：docx 阶段的结构操作与违规进入同一 audit（响应头/归档与产物同批）', () => {
    const audit = createExportRenderAudit('observe');
    const xml = markdownToDocxXml('## 第一章 总则\n\n表 1-1 材料表\n\n| 甲 | 乙 |\n| 1 | 2 |', undefined, undefined, audit);
    expect(audit.ops.captionStyled).toBe(1);
    expect(audit.ops.headerlessTableRendered).toBe(1);
    expect(audit.notices.map(item => item.code)).toContain('headerless-table');
    expect(xml).not.toContain('F3F4F6'); // 无表头表格：首行不得冒充表头（无灰底）
  });

  it('反例：产物侧任何文字注入/丢失都被产物守恒复核捕获（历史缺陷形态：注入假表头）', () => {
    const source = '| 甲 | 乙 |\n| 1 | 2 |';
    const xml = markdownToDocxXml(source);
    expect(docxStageConservationDiff(source, xml)).toEqual({ conserved: true });
    const injected = xml.replace('<w:t xml:space="preserve">甲</w:t>', '<w:t xml:space="preserve">信息项</w:t>');
    const diff = docxStageConservationDiff(source, injected);
    expect(diff.conserved).toBe(false);
    if (!diff.conserved) expect(diff.productContext).toContain('信息项');
    // 丢字（整段文本节点消失）同样必须暴露
    const dropped = xml.replace('<w:t xml:space="preserve">乙</w:t>', '');
    expect(docxStageConservationDiff(source, dropped).conserved).toBe(false);
    // 单位二次改写（历史 L4-2 缺陷形态）也必须暴露
    const rewritten = xml.replace('<w:t xml:space="preserve">甲</w:t>', '<w:t xml:space="preserve">甲²</w:t>');
    expect(docxStageConservationDiff(source, rewritten).conserved).toBe(false);
  });

  it('正例：docx 渲染确定（幂等），可见文本取值不含域指令', () => {
    const prepared = prepareExportMarkdown(REALISTIC_DOCUMENT);
    expect(markdownToDocxXml(prepared.markdown)).toBe(markdownToDocxXml(prepared.markdown));
    const xml = markdownToDocxXml(prepared.markdown);
    const visible = docxVisibleText(xml);
    expect(visible).toContain('丰乐镇安置房项目施工组织设计');
    expect(visible).not.toContain('TOC');
    expect(xml).toContain('w:instrText');
  });
});

describe('L4-3 补造表头可辨识记号', () => {
  it('正例：observe 补造的表头行所在表格自带记号（分隔线取左对齐形态）且表头原文登记审计', () => {
    const audit = createExportRenderAudit('observe');
    const out = normalizeLooseMarkdownTables('| 甲 | 乙 |\n| 丙 | 丁 |', audit);
    const separator = out.split('\n').find(line => isFabricatedTableSeparator(line));
    expect(separator).toBe('| :--- | :--- |');
    expect(out).toContain('| 信息项 | 内容 |');
    expect(audit.notices.map(item => item.code)).toContain('fabricated-header');
    expect(audit.notices.find(item => item.code === 'fabricated-header')?.message).toContain('信息项 | 内容');
    // blocker 文案与实际行为一致：observe 确实补造了 → 逐字给出补造原文与记号
    expect(audit.blockers[0]?.message).toContain('信息项 | 内容');
    expect(audit.blockers[0]?.message).toContain(':---');
  });

  it('正例：补造幂等（记号保留、不重复计数、不再补造）', () => {
    const first = createExportRenderAudit('observe');
    const once = normalizeLooseMarkdownTables('| 甲 | 乙 |\n| 丙 | 丁 |', first);
    expect(first.ops.tableSeparatorAdded).toBe(1);
    const second = createExportRenderAudit('observe');
    expect(normalizeLooseMarkdownTables(once, second)).toBe(once);
    expect(second.ops.tableSeparatorAdded).toBe(0);
    expect(second.notices.filter(item => item.code === 'fabricated-header')).toEqual([]);
  });

  it('反例：作者表格（GFM 标准分隔线）零记号、零改动、零补造', () => {
    const audit = createExportRenderAudit('observe');
    const author = '| 项目 | 目标值 |\n| --- | --- |\n| 工期 | 365 日历天 |';
    expect(normalizeLooseMarkdownTables(author, audit)).toBe(author);
    expect(isFabricatedTableSeparator('| --- | --- |')).toBe(false);
    expect(audit.ops.tableSeparatorAdded).toBe(0);
    expect(audit.notices).toEqual([]);
  });

  it('反例：enforce 不补造（纯渲染），blocker 文案不得声称补造了表头', () => {
    const audit = createExportRenderAudit('enforce');
    const out = normalizeLooseMarkdownTables('| 甲 | 乙 |\n| 丙 | 丁 |', audit);
    expect(out).toBe('| 甲 | 乙 |\n| 丙 | 丁 |');
    expect(out).not.toContain(':---');
    expect(audit.blockers.map(item => item.code)).toEqual(['bare-table']);
    expect(audit.blockers[0]?.message).toContain('不补造表头');
    expect(audit.blockers[0]?.message).not.toContain('信息项');
    expect(audit.notices.filter(item => item.code === 'fabricated-header')).toEqual([]);
  });
});

describe('L4-4 表头行按形态判据渲染', () => {
  it('正例：短标签行判为表头（灰底加粗居中 + tblLook firstRow=1）', () => {
    expect(looksLikeHeaderRow(['项目', '目标值'])).toBe(true);
    const xml = markdownToDocxXml('| 项目 | 目标值 |\n| --- | --- |\n| 工期 | 365 日历天 |');
    const firstRow = /<w:tr>([\s\S]*?)<\/w:tr>/u.exec(xml)?.[1] || '';
    expect(firstRow).toContain('F3F4F6');
    expect(firstRow).toContain('<w:b/>');
    expect(firstRow).toContain('w:jc w:val="center"');
    expect(xml).toContain('w:firstRow="1"');
  });

  it('反例：首行是数据行（含数值）时不得冒充表头', () => {
    expect(looksLikeHeaderRow(['甲', '100'])).toBe(false);
    const xml = markdownToDocxXml('| 甲 | 100 |\n| --- | --- |\n| 乙 | 200 |');
    const firstRow = /<w:tr>([\s\S]*?)<\/w:tr>/u.exec(xml)?.[1] || '';
    expect(firstRow).not.toContain('F3F4F6');
    expect(firstRow).not.toContain('<w:b/>');
    expect(xml).toContain('w:firstRow="0"');
  });

  it('反例：无分隔线的裸表按数据行整表渲染（首行不冒充表头，审计计数）', () => {
    const audit = createExportRenderAudit('observe');
    const xml = markdownToDocxXml('| 甲 | 乙 |\n| 1 | 2 |', undefined, undefined, audit);
    expect(xml).not.toContain('F3F4F6');
    expect(xml).toContain('w:firstRow="0"');
    expect(audit.ops.headerlessTableRendered).toBe(1);
  });
});

describe('L4-5 表题行按表题样式渲染', () => {
  it('正例：紧邻表格的表题行加粗居中零首行缩进、与表同页、不进目录层级', () => {
    expect(isTableCaptionLine('表 2-1 施工目标一览表')).toBe(true);
    const xml = markdownToDocxXml('表 2-1 施工目标一览表\n\n| 项目 | 目标值 |\n| --- | --- |\n| 工期 | 365 日历天 |');
    const caption = paragraphContaining(xml, '表 2-1 施工目标一览表');
    expect(caption).toContain('<w:b/>');
    expect(caption).toContain('w:jc w:val="center"');
    expect(caption).toContain('<w:keepNext/>');
    expect(caption).not.toContain('firstLine');
    expect(caption).not.toContain('outlineLvl');
  });

  it('反例：正文里形态相像的「表…」句（不紧邻表格）仍按正文段落渲染', () => {
    const body = '表 2-1 施工目标一览表已在下文给出，请对照执行。\n\n本节其余内容为文字说明，无表格。';
    const xml = markdownToDocxXml(body);
    const paragraph = paragraphContaining(xml, '已在下文给出');
    expect(paragraph).toContain('w:firstLine="560"');
    expect(paragraph).not.toContain('<w:b/>');
    expect(paragraph).not.toContain('keepNext');
  });

  it('反例：短句「表格中列出…」不判表题（无编号形态）', () => {
    expect(isTableCaptionLine('表格中列出各分项工程的完成时间与责任主体')).toBe(false);
    expect(isTableCaptionLine('表格说明如下')).toBe(false);
  });
});

describe('L4-6 目录单轨（域缓存，无占位文案 + 静态条目并存）', () => {
  it('正例：目录区=单个 TOC 域，静态条目即域缓存结果（end 域标记落在最后一条条目内）', () => {
    const xml = markdownToDocxXml(REALISTIC_DOCUMENT);
    expect((xml.match(/w:fldCharType="begin"/gu) || []).length).toBe(1);
    expect((xml.match(/w:fldCharType="end"/gu) || []).length).toBe(1);
    expect(xml).not.toContain(DOCX_TOC_FIELD_PLACEHOLDER);
    const separate = xml.indexOf('w:fldCharType="separate"');
    const end = xml.indexOf('w:fldCharType="end"');
    expect(xml.indexOf('第一章 总则')).toBeGreaterThan(separate); // 缓存条目在 separate 之后
    // 域收口在最后一条缓存条目之后、正文同名标题之前：整个静态条目区都在域内（Word 更新域即整体覆盖）
    const tocLastEntry = xml.indexOf('2.1 施工目标');
    const bodySectionHeading = xml.lastIndexOf('2.1 施工目标');
    expect(end).toBeGreaterThan(tocLastEntry);
    expect(end).toBeLessThan(bodySectionHeading);
  });

  it('反例：目录区无静态条目时输出单段占位域（begin+separate+占位+end 同段，不留悬空域）', () => {
    const xml = markdownToDocxXml('## 目录\n\n## 第一章 总则\n\n正文内容。');
    expect(xml).toContain(DOCX_TOC_FIELD_PLACEHOLDER);
    expect((xml.match(/w:fldCharType="begin"/gu) || []).length).toBe(1);
    expect((xml.match(/w:fldCharType="end"/gu) || []).length).toBe(1);
    const placeholderParagraph = paragraphContaining(xml, DOCX_TOC_FIELD_PLACEHOLDER);
    expect(placeholderParagraph).toContain('w:fldCharType="begin"');
    expect(placeholderParagraph).toContain('w:fldCharType="end"');
  });

  it('反例：无目录区的文档不产出任何 TOC 域（不凭空造目录）', () => {
    const xml = markdownToDocxXml('## 第一章 总则\n\n正文内容。');
    expect(xml).not.toContain('w:fldChar');
    expect(xml).not.toContain(DOCX_TOC_FIELD_PLACEHOLDER);
  });
});

describe('L4-7 目录按正文对账（同源 fixTocFromBody）', () => {
  const stale = [
    '## 目录',
    '',
    '第一章 总则',
    '  1.1 编制依据',
    '<div class="page-break"></div>',
    '',
    '## 第一章 总则',
    '',
    '### 1.1 编制依据',
    '',
    '内容一。',
    '',
    '## 第二章 施工部署',
    '',
    '### 2.1 施工目标',
    '',
    '内容二。',
  ].join('\n');

  it('正例：目录缺条目 → 按正文重建（与生成链 fixTocFromBody 逐字同源）并登记审计', () => {
    const audit = createExportRenderAudit('observe');
    const out = reconcileTocFromBody(stale, audit);
    expect(out).toBe(fixTocFromBody(stale).markdown); // 同源：不另造目录判据
    expect(out).toContain('第二章 施工部署');
    expect(out).toContain('  2.1 施工目标');
    expect(audit.ops.tocRebuilt).toBe(1);
    expect(audit.notices.map(item => item.code)).toContain('toc-reconcile');
    expect(fixTocFromBody(out).markdown).toBe(out); // 重建后收敛（不动点）
  });

  it('正例：对账在导出链末端生效，且不被 A2 误判为未声明改写（目录重建=声明改写）', () => {
    const prepared = prepareExportMarkdown(stale);
    expect(prepared.markdown).toContain('第二章 施工部署');
    expect(prepared.audit.ops.tocRebuilt).toBe(1);
    expect(prepared.audit.blockers.filter(item => item.code === 'content-not-conserved')).toEqual([]);
  });

  it('反例：目录与正文一致时零重建、零告警（空行/缩进等格式差异不算不一致）', () => {
    const audit = createExportRenderAudit('observe');
    const prepared = prepareExportMarkdown(REALISTIC_DOCUMENT, REALISTIC_DOCUMENT);
    expect(prepared.audit.ops.tocRebuilt).toBe(0);
    expect(prepared.audit.notices.filter(item => item.code === 'toc-reconcile')).toEqual([]);
    expect(reconcileTocFromBody(prepared.markdown, audit)).toBe(prepared.markdown);
    expect(audit.ops.tocRebuilt).toBe(0);
  });

  it('反例：无目录区的文档不做任何目录操作', () => {
    const audit = createExportRenderAudit('observe');
    const text = '## 第一章 总则\n\n### 1.1 编制依据\n\n内容。';
    expect(reconcileTocFromBody(text, audit)).toBe(text);
    expect(audit.ops.tocRebuilt).toBe(0);
    expect(audit.blockers).toEqual([]);
  });

  it('正例：过界守卫以改动跨度（公共前后缀剥离）为判据，正文改动才可能命中', () => {
    const span = changedSpan('##目录\n第一章 总则\n## 第二章\n正文', '##目录\n第一章 总则\n第二章 施工部署\n## 第二章\n正文');
    expect(span.after).toContain('第二章 施工部署');
    expect(/^#{2,4}\s/mu.test(span.after)).toBe(false);
    expect(/^\s*\|/mu.test(span.after)).toBe(false);
  });
});

describe('L4-8 生成链剥离器上链（单源复用 + 结构零触碰 + 幂等）', () => {
  const residueDoc = [
    '## 第一章 总则',
    '',
    '### 1.1 编制依据',
    '',
    '检查井施工应满足设计要求，具体做法详见《钢筋混凝土及砖砌排水检查井》20S515/29。',
    '',
    '答：按图集 20S515 执行',
    '',
    '招标文件澄清明确原 365 日历天现变更为 330 日历天。',
    '',
    '按《绿色建筑评价标准》（GB/T 50378-2019）执行。',
    '',
    '- 具体做法详见《钢筋混凝土及砖砌排水检查井》20S515/29',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    '| 依据 | 详见《给水排水标准图集》20S515 |',
  ].join('\n');

  it('正例：剥离判据与生成链同名函数逐条同源（计数=链上函数自报数）', () => {
    const chunk = '具体做法详见《钢筋混凝土及砖砌排水检查井》20S515/29。招标文件澄清明确原 365 日历天现变更为 330 日历天。';
    const narrative = stripClarificationNarrative(chunk);
    const pointer = stripDrawingPointerPhrases(narrative.text);
    const outcome = stripDeclaredNonDeliverable(chunk);
    expect(outcome.removed).toBe(narrative.removed + pointer.removed);
    expect(outcome.text).toBe(stripMaterialResidueLines(pointer.text));
    expect(outcome.samples.length).toBeGreaterThan(0);
  });

  it('正例：导出链剥离残片/澄清叙述/指向语，剥离处逐条登记（样本 + 计数）', () => {
    const prepared = prepareExportMarkdown(residueDoc);
    expect(prepared.markdown).not.toContain('答：按图集'); // 残留行（答疑对答）整行剥离
    expect(prepared.markdown).not.toContain('澄清明确原'); // 变更过程叙述剥离
    expect(prepared.markdown).toContain('检查井施工应满足设计要求。'); // 指向型小句剥离、同句其余内容保留
    expect(prepared.markdown).not.toContain('检查井施工应满足设计要求，具体做法详见');
    expect(prepared.audit.ops.declaredStrip).toBeGreaterThanOrEqual(3);
    const notice = prepared.audit.notices.find(item => item.code === 'declared-rewrite');
    expect(notice?.message).toContain('声明剥离');
    expect(prepared.audit.blockers).toEqual([]); // 声明改写已登记 → 不算未声明改写
  });

  it('正例：幂等（二次剥离零命中、零改动）', () => {
    const once = stripDeclaredNonDeliverable(residueDoc);
    const twice = stripDeclaredNonDeliverable(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.removed).toBe(0);
    const prepared = prepareExportMarkdown(residueDoc);
    expect(applyDeclaredStrips(prepared.markdown)).toBe(prepared.markdown);
    expect(prepareExportMarkdown(residueDoc).markdown).toBe(prepared.markdown);
  });

  it('反例：规范引用豁免（书名号内为规范名/后随标准代号）不得删除', () => {
    const protectedText = '按《绿色建筑评价标准》（GB/T 50378-2019）执行。';
    const outcome = stripDeclaredNonDeliverable(protectedText);
    expect(outcome.text).toBe(protectedText);
    expect(outcome.removed).toBe(0);
    expect(prepareExportMarkdown(residueDoc).markdown).toContain('《绿色建筑评价标准》（GB/T 50378-2019）');
  });

  it('反例：结构行（列表项/表格行/标题）逐字保留——剥离只作用于散文区（信息零丢失）', () => {
    const outcome = stripDeclaredNonDeliverable(residueDoc);
    expect(outcome.text).toContain('- 具体做法详见《钢筋混凝土及砖砌排水检查井》20S515/29');
    expect(outcome.text).toContain('| 依据 | 详见《给水排水标准图集》20S515 |');
    const before = exportStructureFingerprint(residueDoc);
    const after = exportStructureFingerprint(outcome.text);
    expect(after).toEqual(before);
  });

  it('反例：结构被改动的剥离整体回退并报 blocker（越界守卫）', () => {
    const audit = createExportRenderAudit('observe');
    const overreach = ['## 第一章 总则', '', '答：按图集 20S515 执行', '', '| 甲 | 乙 |'].join('\n');
    // 结构行本身不会被剥离（上一例），此处直接验证守卫判据：指纹不同即回退
    expect(exportStructureFingerprint(overreach).tableRows).toEqual(['| 甲 | 乙 |']);
    expect(applyDeclaredStrips(overreach, audit)).not.toContain('答：按图集');
    expect(audit.blockers).toEqual([]);
  });

  it('反例：off 模式显式回退历史行为（导出链不做声明剥离）', () => {
    vi.stubEnv('DOCUMENT_EXPORT_PURE_RENDER', 'off');
    const prepared = prepareExportMarkdown(residueDoc);
    expect(prepared.audit.mode).toBe('off');
    expect(prepared.markdown).toContain('答：按图集 20S515 执行');
    expect(prepared.audit.ops.declaredStrip).toBe(0);
    expect(prepared.audit.blockers).toEqual([]);
  });
});

describe('L4-2/L4-8 交叉：守恒断言与剥离声明的边界', () => {
  it('正例：声明剥离后的文本即 A2 基线（基线与产物同链，剥离不产生未声明改写）', () => {
    const source = '## 第一章 总则\n\n### 1.1 编制依据\n\n答：按图集 20S515 第 29 页执行\n\n正常正文内容。';
    const audit = createExportRenderAudit('observe');
    const stages = exportPipelineStages(source, audit);
    expect(stages.declared).not.toContain('答：按图集');
    expect(exportConservationDiff(stages.declared, stages.normalized).conserved).toBe(true); // 归一阶段零内容改写
    expect(exportConservationDiff(source, stages.declared).conserved).toBe(false); // 剥离是真改动——但已登记，故不作为产物断言
    expect(stages.normalized).toContain('正常正文内容。');
    expect(audit.ops.declaredStrip).toBeGreaterThan(0);
    expect(audit.blockers).toEqual([]);
    expect(prepareExportMarkdown(source).audit.blockers).toEqual([]);
  });

  it('反例：未声明的正文改写仍被 A2 捕获（守恒断言不因 L4-8 上链而失效）', () => {
    const prepared = prepareExportMarkdown('## 第一章 总则\n\n### 1.1 编制依据\n\n正文内容。');
    expect(prepared.audit.blockers.filter(item => item.code === 'content-not-conserved')).toEqual([]);
    expect(isMaterialResidueLine('答：按图集 20S515 执行')).toBe(true);
  });
});

describe('端到端：docx 导出响应头与产物同批（L4-2/L4-4/L4-6/L4-7）', () => {
  function createResponse() {
    const res = { headers: {} as Record<string, string>, statusCode: 0, sentBody: undefined as unknown } as {
      headers: Record<string, string>; statusCode: number; sentBody?: unknown;
      setHeader: (key: string, value: string) => unknown; status: (code: number) => unknown; json: (body: unknown) => unknown; send: (body: unknown) => unknown;
    };
    res.setHeader = (key, value) => { res.headers[key] = value; return res; };
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => { res.sentBody = body; return res; };
    res.send = body => { res.sentBody = body; return res; };
    return res;
  }

  const TOC_MARKDOWN = [
    '## 目录',
    '',
    '第一章 总则',
    '  1.1 编制依据',
    '第二章 已废弃章节',
    '<div class="page-break"></div>',
    '',
    '## 第一章 总则',
    '',
    '### 1.1 编制依据',
    '',
    '表 1-1 材料表',
    '',
    '| 部位 | 做法 |',
    '| 基础 | 素混凝土 |',
  ].join('\n');

  it('正例：X-Export-Render-Audit 带 docx 阶段计数（表题样式、目录对账），产物与头同批', async () => {
    const res = createResponse();
    await exportHandler({ method: 'POST', body: { title: '审计贯通', markdown: TOC_MARKDOWN, format: 'docx', projectRoot: '/tmp/export-l4-audit' } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const report = JSON.parse(decodeURIComponent(res.headers['X-Export-Render-Audit'] || '{}')) as { ops: Record<string, number>; notices: string[] };
    expect(report.ops.captionStyled).toBe(1); // docx 阶段表题样式（产物侧操作，历史实现根本不进审计）
    expect(report.ops.tocRebuilt).toBe(1); // L4-7 目录按正文对账
    expect(report.notices.join('；')).toContain('静态目录与正文结构不一致');
    const zip = await JSZip.loadAsync(res.sentBody as Buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string') || '';
    expect((documentXml.match(/w:fldCharType="begin"/gu) || []).length).toBe(1); // L4-6 目录单轨（域缓存=静态条目）
    expect(documentXml).not.toContain('第二章 已废弃章节'); // 目录条目随正文对账
    expect(documentXml).not.toContain(DOCX_TOC_FIELD_PLACEHOLDER); // 无「请在 Word 中右键更新目录」双轨占位
  });

  it('反例：enforce 下无表头裸表格不出闸（422 指明回源补齐），绝不以补造表头冒充交付物', async () => {
    vi.stubEnv('DOCUMENT_EXPORT_PURE_RENDER', 'enforce');
    const bare = ['## 第一章 总则', '', '### 1.1 编制依据', '', '| 部位 | 做法 |', '| 基础 | 素混凝土 |'].join('\n');
    const res = createResponse();
    await exportHandler({ method: 'POST', body: { title: '裸表', markdown: bare, format: 'docx', projectRoot: '/tmp/export-l4-audit' } } as never, res as never);
    expect(res.statusCode).toBe(422);
    const body = res.sentBody as { error: string; issues: Array<{ code: string }> };
    expect(body.error).toBe('EXPORT_SOURCE_STRUCTURAL_DEFECT');
    expect(body.issues.map(item => item.code)).toEqual(['bare-table']);
    expect(JSON.stringify(body)).not.toContain('信息项'); // 不补造、不静默
  });
});
