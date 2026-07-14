import { getMultiProjectManager } from './kbService';
import type { DocumentTemplateChapter } from './documentWorkflowService';
import { readEngineeringDocumentConfig } from './engineeringDocumentConfigService';

function normalizeTitle(title: string) {
  return title.replace(/^第[一二三四五六七八九十百]+章\s*/u, '').replace(/^\d+(?:\.\d+)*[、.．\s]*/u, '').trim();
}

function uniqueChapters(chapters: DocumentTemplateChapter[]) {
  const seen = new Set<string>();
  return chapters.filter(chapter => {
    const key = normalizeTitle(chapter.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function chapterFromTitle(title: string, index: number): DocumentTemplateChapter {
  const normalized = normalizeTitle(title);
  return {
    id: `review-standard-${index + 1}`,
    title: normalized,
    purpose: `依据招标文件示范文本“技术文件详细评审标准”中的“${normalized}”要求编写，必须响应评审要点并结合当前项目资料展开。`,
    queries: [normalized, '技术文件详细评审标准', '评审标准'],
    requiredFacts: ['项目名称', '施工范围', '工期要求', '质量要求', '安全要求'],
    sections: [],
    tableSections: [],
    tableRequirements: [],
  };
}

function extractChapterTitles(text: string) {
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const startIndex = lines.findIndex(line => /技术文件详细评审标准|详细评审标准|技术标.*评审/iu.test(line));
  const scope = (startIndex >= 0 ? lines.slice(startIndex, startIndex + 120) : lines).join('\n');
  const titles = [...scope.matchAll(/(?:第[一二三四五六七八九十百]+章\s*)?([^\n：:；;。]{2,40}(?:措施|方案|计划|体系|部署|概况|依据|方法|工艺|管理|保障|保护|响应|承诺))/gu)]
    .map(match => normalizeTitle(match[1] || ''))
    .filter(title => title.length >= 4 && !/评分|分值|标准|目录|页码|投标人|评委|得分|合计/iu.test(title));
  return [...new Set(titles)].slice(0, 12);
}

export async function deriveTenderReviewChapters(projectRoot: string): Promise<DocumentTemplateChapter[]> {
  const queries = readEngineeringDocumentConfig().reviewStandardQueries;
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
  return [...titles].map(chapterFromTitle);
}

export function mergeWithConfiguredSupplementalChapters(chapters: DocumentTemplateChapter[]) {
  return uniqueChapters([
    ...chapters,
    ...readEngineeringDocumentConfig().supplementalChapters,
  ]);
}
