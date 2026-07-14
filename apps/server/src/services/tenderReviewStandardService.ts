import { getMultiProjectManager } from './kbService';
import type { DocumentTemplateChapter } from './documentWorkflowService';
import { readEngineeringDocumentConfig, type ReviewChapterSectionDefaults } from './engineeringDocumentConfigService';

function normalizeTitle(title: string) {
  return title.replace(/^第[一二三四五六七八九十百]+章\s*/u, '').replace(/^\d+(?:\.\d+)*[、.．\s]*/u, '').trim();
}

function chapterSectionDefaults(defaults: ReviewChapterSectionDefaults, index: number) {
  return index === 0 ? defaults.firstChapterSections : defaults.chapterSections;
}

function chapterFromTitle(title: string, index: number, defaults: ReviewChapterSectionDefaults): DocumentTemplateChapter {
  const normalized = normalizeTitle(title);
  const sections = chapterSectionDefaults(defaults, index);
  return {
    id: `review-standard-${index + 1}`,
    title: normalized,
    purpose: `依据招标文件示范文本“技术文件详细评审标准”中的“${normalized}”要求编写，必须响应评审要点并结合当前项目资料展开。`,
    queries: [normalized, ...sections, '技术文件详细评审标准', '评审标准'],
    requiredFacts: ['项目名称', '施工范围', '工期要求', '质量要求', '安全要求'],
    sections,
    tableSections: index === 0 ? defaults.firstChapterTableSections : [],
    tableRequirements: index === 0 ? defaults.firstChapterTableRequirements : [],
  };
}

function reviewStandardScope(text: string) {
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const startIndex = lines.findIndex(line => /技术文件详细评审标准|详细评审标准|技术标.*评审|评审标准/iu.test(line));
  const scopedLines = startIndex >= 0 ? lines.slice(startIndex, startIndex + 220) : lines;
  const endIndex = scopedLines.findIndex((line, index) => index > 8 && /商务文件|报价文件|价格分|信用评价|投标报价|总分|评审汇总|评标办法正文/iu.test(line));
  return (endIndex > 0 ? scopedLines.slice(0, endIndex) : scopedLines).join('\n');
}

function extractChapterTitles(text: string) {
  const scope = reviewStandardScope(text);
  const normalizedScope = scope.replace(/\s*([；;。])\s*/gu, '$1\n');
  const lines = normalizedScope.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const preferredStartIndex = lines.findIndex(line => /但不限于以下内容/iu.test(line));
  const fallbackStartIndex = lines.findIndex(line => /施工组织设计进行评审|技术文件详细评审标准/iu.test(line));
  const startIndex = preferredStartIndex >= 0 ? preferredStartIndex : fallbackStartIndex;
  const numberedTitles: Array<{ order: number; title: string }> = [];
  let expectedOrder = 1;
  for (const line of lines.slice(startIndex >= 0 ? startIndex + 1 : 0)) {
    if (/注[:：]|建议编制要求|页面排版|字体|编制篇幅|评标委员会|一般得|本项满分|内容未提供|无任何针对性/iu.test(line)) break;
    const match = line.match(/^\s*(?:#{1,6}\s*)?(\d{1,2})[.．、]\s*([^\n；;。]{2,80}?)(?:[；;。])?\s*$/u);
    if (!match) {
      if (numberedTitles.length > 0 && !/^\s*#{1,6}\s*$/u.test(line)) break;
      continue;
    }
    const order = Number(match[1]);
    const title = normalizeTitle(match[2] || '');
    if (order !== expectedOrder) break;
    if (title.length >= 4 && title.length <= 60
      && !/^(评审因素|评审内容|评分标准|评分因素|分值|满分|备注|序号|条款号|评审项目)$/iu.test(title)
      && !/评分|得分|分值|满分|扣分|合计|总分|报价|商务|信用评价|投标人须知|评标委员会|公共资源交易|监督管理|建议编制|页面排版|字体图片|编制篇幅/iu.test(title)) {
      numberedTitles.push({ order, title });
      expectedOrder += 1;
    }
  }
  return [...new Map(numberedTitles.sort((a, b) => a.order - b.order).map(item => [item.title, item.title])).values()].slice(0, 30);
}

export async function deriveTenderReviewChapters(projectRoot: string): Promise<DocumentTemplateChapter[]> {
  const config = readEngineeringDocumentConfig();
  const queries = config.reviewStandardQueries;
  if (queries.length === 0) return [];
  const manager = getMultiProjectManager();
  const titles = new Set<string>();
  for (const query of queries) {
    try {
      const result = await manager.search(projectRoot, query, { limit: 12 });
      const text = result.results.map(item => `${item.filePath}\n${item.content || ''}`).join('\n');
      for (const title of extractChapterTitles(text)) titles.add(title);
    } catch {
      // 单个查询失败不影响其他查询。
    }
  }
  return [...titles].map((title, index) => chapterFromTitle(title, index, config.reviewChapterSectionDefaults));
}

