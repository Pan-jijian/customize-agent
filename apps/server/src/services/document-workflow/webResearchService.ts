import type { DocumentEvidence, DocumentFact, RuntimePromptRuleSet, WebAccessConfig } from './types';

const WEB_CHAPTER_PATTERN = /安全|文明|质量|绿色施工|环保|扬尘|消防|应急|危大|风险|规范|标准|管理要求|施工工艺|技术措施|验收/u;
const LOCAL_FACT_PATTERN = /项目名称|工程名称|建设地点|建设单位|招标人|发包人|建设规模|招标范围|合同工期|计划工期|质量标准|危大工程清单|工程量|材料规格|设备型号|图纸参数|报价|单价|利润|税率|合同金额|联系方式|品牌/u;
const COMMERCIAL_PATTERN = /报价|单价|合价|金额|利润|税率|增值税|招标控制价|最高投标限价|中标价|合同价|暂列金额/u;
const WEB_PROCESS_TERMS = /联网增强|联网检索|网页资料|搜索结果|根据网页|互联网资料|在线资料|浏览器|搜索引擎/u;
const PROJECT_FACT_WORDS = ['项目名称', '工程名称', '建设地点', '建设单位', '招标人', '发包人', '建设规模', '招标范围', '合同工期', '计划工期', '工程量', '报价', '单价'];

function decodeHtml(text: string) {
  return text
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/<[^>]+>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function factValueText(value: unknown) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

function localFactValues(facts: DocumentFact[]) {
  return facts.map(fact => factValueText(fact.value)).filter(value => value.length >= 3 && value.length <= 80);
}

function stripProjectFacts(text: string, facts: DocumentFact[]) {
  let next = text;
  for (const word of PROJECT_FACT_WORDS) next = next.replace(new RegExp(`${word}[^。；;\n]{0,80}`, 'gu'), '');
  for (const value of localFactValues(facts)) next = next.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu'), '');
  return next.replace(COMMERCIAL_PATTERN, '').trim();
}

function shouldUseWebForChapter(title: string, sections: string[]) {
  const text = `${title} ${sections.join(' ')}`;
  if (!WEB_CHAPTER_PATTERN.test(text)) return false;
  if (/项目概况|工程概况|建设地点|建设规模|招标范围|工程量|报价|造价/u.test(text) && !/安全|文明|质量|危大|环保|工艺|措施/u.test(text)) return false;
  return true;
}

function buildQueries(chapterTitle: string, sectionTitles: string[], maxQueries: number) {
  const themeText = `${chapterTitle} ${sectionTitles.join(' ')}`;
  const candidates = [
    /危大/u.test(themeText) ? '危大工程 专项施工方案 管理规定 安全措施' : '',
    /安全|文明/u.test(themeText) ? '建筑工程 安全文明施工 管理要求' : '',
    /质量|验收/u.test(themeText) ? '建筑工程 质量控制 质量验收 通用要求' : '',
    /扬尘|环保|绿色/u.test(themeText) ? '施工现场 扬尘治理 绿色施工 环保要求' : '',
    /消防|应急/u.test(themeText) ? '施工现场 消防 应急管理 要求' : '',
    /工艺|技术措施/u.test(themeText) ? '建筑工程 施工工艺 技术措施 通用要求' : '',
  ].filter(Boolean);
  const fallback = `${chapterTitle.replace(LOCAL_FACT_PATTERN, '')} 公开规范 通用要求`.trim();
  return [...new Set(candidates.length ? candidates : [fallback])].slice(0, maxQueries);
}

function sourceTypeForUrl(url: string): DocumentEvidence['source'] {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes('.gov.cn') || lowerUrl.includes(['mo', 'hurd'].join('')) || lowerUrl.includes('zjt') || url.includes('住建')) return 'web-policy';
  return 'web-evidence';
}

async function searchDuckDuckGo(query: string, maxResults: number, trustedDomains: string[], forbiddenTerms: string[], signal?: AbortSignal) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 compatible; customize-agent web research' }, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  });
  if (!response.ok) return [];
  const html = await response.text();
  const matches = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/giu)];
  return matches.map(match => {
    const rawUrl = decodeHtml(match[1] || '');
    const title = decodeHtml(match[2] || '');
    const snippet = decodeHtml(match[3] || '');
    const directUrl = /uddg=([^&]+)/u.exec(rawUrl)?.[1];
    const resultUrl = directUrl ? decodeURIComponent(directUrl) : rawUrl;
    return { url: resultUrl, title, snippet };
  }).filter(item => {
    const text = `${item.title} ${item.snippet} ${item.url}`;
    if (!item.url || !item.snippet) return false;
    if (LOCAL_FACT_PATTERN.test(text) || COMMERCIAL_PATTERN.test(text) || WEB_PROCESS_TERMS.test(text)) return false;
    if (forbiddenTerms.some(term => term && text.includes(term))) return false;
    if (trustedDomains.length === 0) return true;
    return trustedDomains.some(domain => item.url.includes(domain));
  }).slice(0, maxResults);
}

export async function retrieveWebEvidence(input: { config: WebAccessConfig; chapterId: string; chapterTitle: string; sectionTitles: string[]; runtimeRules: RuntimePromptRuleSet; localFacts: DocumentFact[]; signal?: AbortSignal }) {
  if (!input.config.enabled || !shouldUseWebForChapter(input.chapterTitle, input.sectionTitles)) return { evidence: [] as DocumentEvidence[], queries: [] as string[], filtered: 0 };
  const queries = buildQueries(input.chapterTitle, input.sectionTitles, input.config.maxQueriesPerChapter);
  const evidence: DocumentEvidence[] = [];
  let filtered = 0;
  for (const query of queries) {
    try {
      const results = await searchDuckDuckGo(query, input.config.maxResultsPerQuery, input.config.trustedDomains, input.runtimeRules.forbiddenTerms || [], input.signal);
      for (const result of results) {
        const cleaned = stripProjectFacts(result.snippet, input.localFacts);
        if (!cleaned || cleaned.length < 20) { filtered += 1; continue; }
        evidence.push({
          chapterId: input.chapterId,
          filePath: result.url,
          score: 0.42,
          content: `参考依据：${result.title}\n${cleaned}`,
          source: sourceTypeForUrl(result.url),
          sectionTitle: input.chapterTitle,
        });
      }
    } catch {
      filtered += 1;
    }
  }
  return { evidence, queries, filtered };
}

export function webAccessPrompt(enabled: boolean) {
  if (!enabled) return '';
  return [
    '公开资料补充使用规则：',
    '1. 公开资料只可用于补充通用规范、政策、工艺和措施。',
    '2. 不得使用公开资料新增或修改项目名称、建设地点、建设规模、工期、质量标准、工程量、材料规格、图纸参数、商务数据。',
    '3. 本地项目资料与公开资料冲突时，必须以本地项目资料为准。',
    '4. 不得在正文中出现任何检索过程、外部页面、工具调用或系统内部过程性表述。',
    '5. 不得把公开资料中的其他项目案例参数写入本项目正文。',
  ].join('\n');
}

export function webEvidenceLeakageIssues(markdown: string) {
  const issues = [] as Array<{ level: 'warning' | 'error' | 'info'; message: string; suggestion?: string }>;
  if (WEB_PROCESS_TERMS.test(markdown)) issues.push({ level: 'warning', message: '正文包含联网增强过程性表述', suggestion: '请删除联网检索、网页资料、搜索结果等过程性话术，改为正式交付语言。' });
  return issues;
}
