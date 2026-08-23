import type { RetrievalWeights } from '@customize-agent/knowledge';
import { getMultiProjectManager } from './kbService';

export interface KbRetrievalEvalCase {
  id?: string;
  query: string;
  relevantFiles?: string[];
  relevantSnippets?: string[];
  expectedTerms?: string[];
  filePaths?: string[];
  filePathPrefixes?: string[];
  topK?: number;
}

export interface KbRetrievalEvalOptions {
  projectRoot: string;
  cases: KbRetrievalEvalCase[];
  topK?: number;
  weights?: RetrievalWeights;
  generationMode?: boolean;
  filePaths?: string[];
  filePathPrefixes?: string[];
  compact?: boolean;
  disableReranker?: boolean;
}

export type KbAutoEvalFileLayer = 'all' | 'document' | 'cad';

export interface KbAutoEvalCaseOptions {
  projectRoot: string;
  filePaths?: string[];
  filePathPrefixes?: string[];
  limit?: number;
  perFileLimit?: number;
  fileLayer?: KbAutoEvalFileLayer;
  includeExtensions?: string[];
  excludeExtensions?: string[];
}

export interface KbRetrievalEvalCaseResult {
  id: string;
  query: string;
  topK: number;
  returned: number;
  recall: number;
  precision: number;
  mrr: number;
  ndcg: number;
  hitUnits: number;
  totalUnits: number;
  firstHitRank?: number;
  matchedFiles: string[];
  missingFiles: string[];
  matchedSnippets: string[];
  missingSnippets: string[];
  matchedTerms: string[];
  missingTerms: string[];
  results: Array<{ rank: number; filePath: string; score: number; relevant: boolean; matchedBy: string[]; preview: string }>;
  debug?: unknown;
}

export interface KbRetrievalEvalReport {
  totalCases: number;
  validCases: number;
  invalidCases: number;
  topK: number;
  recallAtK: number;
  precisionAtK: number;
  mrr: number;
  ndcgAtK: number;
  pass95: boolean;
  cases: KbRetrievalEvalCaseResult[];
  invalid: Array<{ id: string; query: string; reason: string }>;
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/gu, '').trim();
}

function normalizePath(value: string) {
  return value.split('\\').join('/').toLowerCase();
}

function unique(values: string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function roundMetric(value: number) {
  return Math.round(value * 10000) / 10000;
}

function dcg(relevance: number[]) {
  return relevance.reduce((sum, rel, index) => sum + rel / Math.log2(index + 2), 0);
}

function itemMatchesFile(filePath: string, relevantFiles: string[]) {
  const normalized = normalizePath(filePath);
  return relevantFiles.some(file => {
    const target = normalizePath(file);
    return normalized === target || normalized.endsWith(target) || target.endsWith(normalized);
  });
}

function itemMatchesSnippet(content: string, snippets: string[]) {
  const normalized = normalizeText(content);
  return snippets.filter(snippet => normalized.includes(normalizeText(snippet)));
}

function itemMatchesTerm(content: string, terms: string[]) {
  const normalized = normalizeText(content);
  return terms.filter(term => normalized.includes(normalizeText(term)));
}

async function resolveScopedFilePaths(input: { projectRoot: string; filePaths?: string[]; filePathPrefixes?: string[] }, evalCase?: Pick<KbRetrievalEvalCase, 'filePaths' | 'filePathPrefixes'>) {
  const explicit = unique([...(input.filePaths || []), ...(evalCase?.filePaths || [])]);
  const prefixes = unique([...(input.filePathPrefixes || []), ...(evalCase?.filePathPrefixes || [])]).map(normalizePath);
  if (prefixes.length === 0) return explicit;
  const project = await getMultiProjectManager().getProject(input.projectRoot);
  const matched = project.listFiles()
    .map(file => file.relativePath)
    .filter(filePath => prefixes.some(prefix => normalizePath(filePath).startsWith(prefix)));
  return unique([...explicit, ...matched]);
}

const FACT_PATTERNS: Array<{ label: string; regex: RegExp; query: (value: string) => string }> = [
  { label: '项目名称', regex: /(?:招标项目名称|项目名称|工程名称)[:：\s|]*([^。；;\n|]{4,80})/gu, query: value => `${value} 项目名称 工程名称` },
  { label: '招标人', regex: /(?:招标人|项目业主|建设单位)[:：\s|]*([^。；;\n|]{4,80})/gu, query: value => `${value} 招标人 建设单位 项目业主` },
  { label: '建设地点', regex: /(?:建设地点|工程地点|项目地点)[:：\s|]*([^。；;\n|]{4,120})/gu, query: value => `${value} 建设地点 项目地点` },
  { label: '资金来源', regex: /(?:资金来源|资金落实情况)[:：\s|]*([^。；;\n|]{2,80})/gu, query: value => `${value} 资金来源` },
  { label: '出资比例', regex: /(?:出资比例|项目出资比例)[:：\s|]*([^。；;\n|]{2,80})/gu, query: value => `${value} 出资比例` },
  { label: '项目编号', regex: /(?:招标项目编号|项目编号|招标编号)[:：\s|]*([A-Za-z0-9（）()[\]【】-]{4,80})/gu, query: value => `${value} 项目编号 招标编号` },
  { label: '立项批准', regex: /(?:批准文号|备案表|立项批准文号)[:：\s|]*([^。；;\n|]{4,100})/gu, query: value => `${value} 立项批准 文号 备案` },
  { label: '工期', regex: /(?:计划工期|总工期|工期)[:：\s|]*([^。；;\n|]{2,100})/gu, query: value => `${value} 工期 计划工期` },
  { label: '质量标准', regex: /(?:质量标准|质量要求)[:：\s|]*([^。；;\n|]{2,100})/gu, query: value => `${value} 质量标准 质量要求` },
  { label: '建筑面积', regex: /(?:总建筑面积|建筑面积)[:：\s|约]*([0-9,.]+\s*(?:m2|㎡|平方米))/giu, query: value => `${value} 总建筑面积 建筑面积` },
  { label: '结构', regex: /(地上[一二三四五六七八九十\d]+层[^。；;\n|]{0,20}结构)/gu, query: value => `${value} 建筑结构 现状建筑物` },
  { label: '场地限制', regex: /(不具备材料堆场|搭设加工区|搭设办公区|搭设生活区|场地限制)/gu, query: value => `${value} 场地限制 材料堆场 办公区 生活区` },
  { label: '临水临电', regex: /(临水临电|临时水电接引|接驳点挂表计量|挂表计量|施工水电接引费)/gu, query: value => `${value} 临水临电 接驳点 挂表计量` },
  { label: '拆除修补', regex: /(改造维修项目|拆除内容比较多|破损处进行修补|拆除工程|修补)/gu, query: value => `${value} 改造维修 拆除 修补` },
  { label: '安全文明', regex: /(安全文明施工|安全生产|文明施工|扬尘治理|消防安全)/gu, query: value => `${value} 安全文明 安全生产 文明施工` },
];

function cleanFactValue(value: string) {
  return value.replace(/[|*_`#]/gu, '').replace(/\s+/gu, '').trim().slice(0, 80);
}

function isUsefulFactValue(value: string) {
  return value.length >= 2
    && !/^(?:无|否|是|详见|见|按|按图|相关资料|相关专业图纸)$/u.test(value)
    && !/^[-—:：|]+$/u.test(value)
    && !/[、，,]*(?:工程内容|金额|计入投标总价|产权单位|索赔|费用|事宜)[、，,]*/u.test(value)
    && !/^(?:第\d+页共\d+页|COL\d+|项目名称计算基础|所列的金额)/iu.test(value);
}

function normalizeEvalText(value: string) {
  return value
    .replace(/#{1,6}\s*/gu, '')
    .replace(/\|/gu, ' ')
    .replace(/\s+/gu, '')
    .trim();
}

function stripEvalMetadata(value: string) {
  return value
    .split(/\n+/u)
    .filter(line => !/^\s*(?:资料类型|MIME|文件大小|PDF\s*第|工作表：|COL\d+)/iu.test(line))
    .join('\n');
}

function hasDomainSignal(value: string) {
  return /工程|项目|施工|建筑|结构|装饰|电气|给排水|消防|暖通|平面|立面|剖面|节点|详图|材料|尺寸|标高|轴线|图层|门窗|墙|地面|顶面|照明|配电|弱电|空调|卫生间|楼梯|屋面|基础|柱|梁|板/u.test(value);
}

function isLikelyMojibake(value: string) {
  if (/[爀攀最椀猀琀礀开氀漀挀愀渀捁扄潓瑲湥獴慔汢]/u.test(value)) return true;
  const cjk = value.match(/[\u4e00-\u9fa5]/gu)?.length || 0;
  return cjk >= 8 && !hasDomainSignal(value);
}

function isReadableEvalSentence(value: string) {
  const readable = value.match(/[\u4e00-\u9fa5A-Za-z0-9（）()【】《》、，。；;：:,.\-/㎡%]/gu)?.length || 0;
  return readable / Math.max(1, value.length) >= 0.65 && !isLikelyMojibake(value);
}

function splitEvalSentences(value: string) {
  return stripEvalMetadata(value)
    .replace(/#{1,6}\s*/gu, '')
    .replace(/\|/gu, '。')
    .split(/[。；;！？!?\n]/u)
    .map(sentence => normalizeEvalText(sentence))
    .filter(sentence => sentence.length >= 16 && sentence.length <= 90)
    .filter(sentence => !/资料类型|工作表：|COL\d+|---|第\d+页共\d+页|MIME|文件大小|customize-agent-cad/iu.test(sentence))
    .filter(sentence => /[\u4e00-\u9fa5]{4,}/u.test(sentence))
    .filter(isReadableEvalSentence);
}

function pickExpectedTerms(sentence: string) {
  const terms = sentence.match(/[\u4e00-\u9fa5A-Za-z0-9（）()【】《》-]{4,18}/gu) || [];
  return unique(terms)
    .filter(term => !/^(?:招标文件|投标文件|投标人|承包人|发包人|中标人|工程项目|施工单位|相关费用)$/u.test(term))
    .slice(0, 3);
}

function buildGenericQuery(sentence: string, sectionTitle?: string, titlePath?: string) {
  const titleTerms = normalizeEvalText(stripEvalMetadata(`${sectionTitle || ''}\n${titlePath || ''}`)).slice(0, 30);
  const terms = pickExpectedTerms(sentence).join(' ');
  return unique([titleTerms, terms]).join(' ');
}

function extensionOf(filePath: string) {
  return filePath.split('.').pop()?.toLowerCase() || '';
}

function filterAutoEvalFiles(files: string[], input: KbAutoEvalCaseOptions) {
  const include = unique(input.includeExtensions || []).map(value => value.replace(/^\./u, '').toLowerCase());
  const exclude = unique(input.excludeExtensions || []).map(value => value.replace(/^\./u, '').toLowerCase());
  return files.filter(filePath => {
    const ext = extensionOf(filePath);
    if (include.length > 0 && !include.includes(ext)) return false;
    if (exclude.includes(ext)) return false;
    if (input.fileLayer === 'cad') return ['dwg', 'dxf'].includes(ext);
    if (input.fileLayer === 'document') return !['dwg', 'dxf', 'png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
    return true;
  });
}

export async function buildAutoKbRetrievalEvalCases(input: KbAutoEvalCaseOptions): Promise<KbRetrievalEvalCase[]> {
  const limit = Math.max(1, Math.min(1000, Math.ceil(input.limit ?? 300)));
  const perFileLimit = Math.max(1, Math.min(300, Math.ceil(input.perFileLimit ?? 12)));
  const project = await getMultiProjectManager().getProject(input.projectRoot);
  const scopedFiles = await resolveScopedFilePaths(input);
  const baseFiles = scopedFiles.length > 0 ? scopedFiles : project.listFiles().map(file => file.relativePath);
  const files = filterAutoEvalFiles(baseFiles, input);
  const cases: KbRetrievalEvalCase[] = [];
  const seen = new Set<string>();

  for (const filePath of files) {
    if (cases.length >= limit) break;
    let fileCount = 0;
    const chunks = project.listChunks({ relativePath: filePath, limit: 1000 });
    for (const chunk of chunks) {
      if (cases.length >= limit || fileCount >= perFileLimit) break;
      const text = `${chunk.sectionTitle || ''}\n${chunk.titlePath || ''}\n${stripEvalMetadata(chunk.content)}`;
      if (text.length < 20 || /工作表：|COL\d+|^\s*[|:-]+\s*$/u.test(text)) continue;
      for (const pattern of FACT_PATTERNS) {
        if (cases.length >= limit || fileCount >= perFileLimit) break;
        pattern.regex.lastIndex = 0;
        for (const match of text.matchAll(pattern.regex)) {
          const value = cleanFactValue(match[1] || match[0] || '');
          if (!isUsefulFactValue(value)) continue;
          const key = `${pattern.label}:${value}`;
          if (seen.has(key)) continue;
          seen.add(key);
          cases.push({
            id: `auto-${cases.length + 1}`,
            query: pattern.query(value),
            expectedTerms: [value],
            relevantFiles: [filePath],
            filePaths: files.length > 0 ? files : undefined,
            topK: 20,
          });
          fileCount += 1;
          if (cases.length >= limit || fileCount >= perFileLimit) break;
        }
      }

      for (const sentence of splitEvalSentences(text)) {
        if (cases.length >= limit || fileCount >= perFileLimit) break;
        const expectedTerms = pickExpectedTerms(sentence);
        if (expectedTerms.length === 0) continue;
        const query = buildGenericQuery(sentence, chunk.sectionTitle, chunk.titlePath);
        if (query.length < 8) continue;
        const key = `sentence:${expectedTerms.join('|')}:${filePath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cases.push({
          id: `auto-${cases.length + 1}`,
          query,
          expectedTerms,
          relevantFiles: [filePath],
          filePaths: files.length > 0 ? files : undefined,
          topK: 20,
        });
        fileCount += 1;
      }
    }
  }
  return cases;
}

export async function evaluateKbRetrieval(input: KbRetrievalEvalOptions): Promise<KbRetrievalEvalReport> {
  const topK = Math.max(1, Math.min(100, Math.ceil(input.topK ?? 20)));
  const manager = getMultiProjectManager();
  const cases: KbRetrievalEvalCaseResult[] = [];
  const invalid: KbRetrievalEvalReport['invalid'] = [];

  for (const [index, evalCase] of input.cases.entries()) {
    const id = evalCase.id || `case-${index + 1}`;
    const query = evalCase.query.trim();
    const relevantFiles = unique(evalCase.relevantFiles || []);
    const relevantSnippets = unique(evalCase.relevantSnippets || []);
    const expectedTerms = unique(evalCase.expectedTerms || []);
    const caseTopK = Math.max(1, Math.min(100, Math.ceil(evalCase.topK ?? topK)));
    const totalUnits = relevantFiles.length + relevantSnippets.length + expectedTerms.length;
    const scopedFilePaths = await resolveScopedFilePaths(input, evalCase);

    if (!query || totalUnits === 0) {
      invalid.push({ id, query, reason: '评测用例必须包含 query，且至少提供 relevantFiles、relevantSnippets 或 expectedTerms 之一。' });
      continue;
    }
    if ((input.filePathPrefixes?.length || evalCase.filePathPrefixes?.length) && scopedFilePaths.length === 0) {
      invalid.push({ id, query, reason: 'filePathPrefixes 未匹配到任何已索引文件。' });
      continue;
    }

    const searchResult = await manager.search(input.projectRoot, query, {
      limit: caseTopK,
      weights: input.weights,
      generationMode: input.generationMode,
      disableReranker: input.disableReranker,
      filters: scopedFilePaths.length > 0 ? { filePaths: scopedFilePaths } : undefined,
    });
    const results = searchResult.results.slice(0, caseTopK);
    const aggregateText = results.map(item => `${item.filePath}\n${item.sectionTitle || ''}\n${item.content}`).join('\n');
    const matchedFiles = relevantFiles.filter(file => results.some(item => itemMatchesFile(item.filePath, [file])));
    const matchedSnippets = relevantSnippets.filter(snippet => normalizeText(aggregateText).includes(normalizeText(snippet)));
    const matchedTerms = expectedTerms.filter(term => normalizeText(aggregateText).includes(normalizeText(term)));
    const hitUnits = matchedFiles.length + matchedSnippets.length + matchedTerms.length;

    const ranked = results.map((item, resultIndex) => {
      const matchedBy: string[] = [];
      if (itemMatchesFile(item.filePath, relevantFiles)) matchedBy.push('file');
      if (itemMatchesSnippet(item.content, relevantSnippets).length > 0) matchedBy.push('snippet');
      if (itemMatchesTerm(`${item.sectionTitle || ''}\n${item.content}`, expectedTerms).length > 0) matchedBy.push('term');
      return {
        rank: resultIndex + 1,
        filePath: item.filePath,
        score: item.score,
        relevant: matchedBy.length > 0,
        matchedBy,
        preview: item.content.replace(/\s+/gu, ' ').slice(0, 180),
      };
    });
    const firstHitRank = ranked.find(item => item.relevant)?.rank;
    const relevance = ranked.map(item => item.relevant ? 1 : 0);
    const idealRelevance = [...relevance].sort((a, b) => b - a);
    const idealDcg = dcg(idealRelevance);

    const caseResult: KbRetrievalEvalCaseResult = {
      id,
      query,
      topK: caseTopK,
      returned: results.length,
      recall: roundMetric(hitUnits / totalUnits),
      precision: roundMetric(ranked.filter(item => item.relevant).length / Math.max(1, results.length)),
      mrr: firstHitRank ? roundMetric(1 / firstHitRank) : 0,
      ndcg: idealDcg > 0 ? roundMetric(dcg(relevance) / idealDcg) : 0,
      hitUnits,
      totalUnits,
      firstHitRank,
      matchedFiles,
      missingFiles: relevantFiles.filter(file => !matchedFiles.includes(file)),
      matchedSnippets,
      missingSnippets: relevantSnippets.filter(snippet => !matchedSnippets.includes(snippet)),
      matchedTerms,
      missingTerms: expectedTerms.filter(term => !matchedTerms.includes(term)),
      results: input.compact ? ranked.slice(0, 3) : ranked,
      debug: input.compact ? undefined : searchResult.debug,
    };
    cases.push(caseResult);
  }

  const validCases = cases.length;
  const average = (selector: (item: KbRetrievalEvalCaseResult) => number) => validCases > 0 ? cases.reduce((sum, item) => sum + selector(item), 0) / validCases : 0;
  const recallAtK = roundMetric(average(item => item.recall));
  const precisionAtK = roundMetric(average(item => item.precision));
  const mrr = roundMetric(average(item => item.mrr));
  const ndcgAtK = roundMetric(average(item => item.ndcg));

  return {
    totalCases: input.cases.length,
    validCases,
    invalidCases: invalid.length,
    topK,
    recallAtK,
    precisionAtK,
    mrr,
    ndcgAtK,
    pass95: validCases > 0 && recallAtK >= 0.95,
    cases,
    invalid,
  };
}
