import type { DocumentEvidence } from './types';
import { cleanEvidenceText } from './evidence';
import { documentTextLength } from './budget';
import { displayChapterTitle } from './outline';

export function sectionContentBody(content: string) {
  return content.replace(/^#{3,4}\s+.*\n+/u, '').trim();
}

function currentSectionBlock(sectionTitle: string, content: string) {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // 注意：m 标志下 $ 匹配每个行尾，若本节是文档最后一节会导致块在首个 #### 行被截断；
  // 用 (?![\s\S]) 表示真正的字符串末尾
  const match = content.match(new RegExp(`^###\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^###\\s+|^##\\s+|(?![\\s\\S]))`, 'mu'));
  return match ? match[0] : content;
}

/** 中文 bigram 关键词集合：把连续中文字符串按相邻两字切分，用于标题/段落相似度匹配 */
function chineseBigramSet(text: string): Set<string> {
  const grams = new Set<string>();
  for (const run of text.match(/[\u4e00-\u9fa5]{2,}/gu) || []) {
    if (run.length === 2) { grams.add(run); continue; }
    for (let index = 0; index <= run.length - 2; index += 1) grams.add(run.slice(index, index + 2));
  }
  return grams;
}

function sharedGramCount(first: Set<string>, second: Set<string>): number {
  let count = 0;
  for (const gram of first) if (second.has(gram)) count += 1;
  return count;
}

/** 施工叙述中的高频通用动词/名词 bigram，对段落语义重合判定无区分度，需过滤 */
const STOP_BIGRAMS = new Set([
  '采用', '安装', '控制', '检测', '检查', '验收', '记录', '施工', '要求', '完成', '进行', '实测', '形成', '复核', '处理', '保护', '清理', '准备', '组织', '安全', '质量', '部位', '范围', '内容', '工作', '项目', '工程', '材料', '设备', '分别', '规范', '图纸', '设计', '依据', '确认', '资料', '技术', '文件', '标准', '合格', '偏差', '允许', '符合', '确保', '防止', '严禁', '不得', '统一', '配备', '设置', '使用', '作业', '过程', '移交', '闭环', '整改', '问题', '发现', '及时', '后续', '工序', '环节', '位置', '高度', '间距', '严格', '必须', '所有', '相关', '执行', '落实', '到位', '同步', '相应', '重点', '加强', '管理', '隐蔽', '报告', '签字', '填写', '留置', '保养', '维修',
]);

/** 过滤通用施工动词后的段落 bigram 交集数，用于判定两小节是否同一工作包 */
function sharedMeaningfulGramCount(first: Set<string>, second: Set<string>): number {
  let count = 0;
  for (const gram of first) {
    if (STOP_BIGRAMS.has(gram)) continue;
    if (second.has(gram)) count += 1;
  }
  return count;
}

/**
 * “项目主要施工内容”节 LLM 成稿可能把同一个工作包按“X工程”“X工作包”两种口径重复展开两遍：
 * 确定性合并：把“X工作包”小节中独有的量化参数句并入匹配的“X工程”小节施工方法段，删除重复小节并重排编号。
 */
export function mergeDuplicateWorkPackageSubsections(content: string): string {
  // 注意：m 标志下 $ 匹配每个行尾，结尾边界必须用 (?!(\\s|\\S)) 表示真正的字符串末尾，否则块在首行就被截断
  const sectionBlock = content.match(/^###\s+(?:\d+\.\d+\s+)?项目主要施工内容\s*\n([\s\S]*?)(?=^###\s+|^##\s+|(?!(\s|\S)))/mu);
  if (!sectionBlock) return content;
  const block = sectionBlock[0];
  const headingEnd = block.indexOf('\n');
  const body = block.slice(headingEnd + 1);
  const parts = body.split(/^(?=####\s+)/mu);
  type PackageBlock = { title: string; cleanTitle: string; body: string; isWorkPackage: boolean; titleGrams: Set<string>; segGrams: Set<string>[] };
  const packages: PackageBlock[] = [];
  for (const part of parts) {
    const match = part.match(/^####\s+(.+?)\s*\n([\s\S]*)$/u);
    if (!match) continue;
    const title = match[1].trim();
    const cleanTitle = title.replace(/^\d+\.\d+\.\d+\s*/u, '');
    const segments = match[2]
      .split(/(?=施工概况|施工流程|施工方法)/u)
      .filter(Boolean)
      .map(segment => chineseBigramSet(segment.replace(/^施工(?:概况|流程|方法)[:：]?/u, '')));
    packages.push({ title, cleanTitle, body: match[2], isWorkPackage: /工作包\s*$/u.test(cleanTitle), titleGrams: chineseBigramSet(cleanTitle), segGrams: segments });
  }
  const workPackages = packages.filter(item => item.isWorkPackage);
  const namedPackages = packages.filter(item => !item.isWorkPackage);
  if (workPackages.length === 0 || namedPackages.length === 0) return content;
  const deleted = new Set<PackageBlock>();
  for (const workPackage of workPackages) {
    let best: PackageBlock | undefined;
    let bestScore = 0;
    for (const named of namedPackages) {
      if (deleted.has(named)) continue;
      const titleShared = sharedGramCount(workPackage.titleGrams, named.titleGrams);
      if (titleShared < 2) continue;
      // 三段式对应段至少两段语义重合（每段共享非停用 bigram ≥4）才判定同一工作包；低重叠多为跨工作包同名泛词（室内/改造/安装）
      const segmentOverlaps = Math.min(workPackage.segGrams.length, named.segGrams.length);
      const overlapping = Array.from({ length: segmentOverlaps }, (_item, index) => sharedMeaningfulGramCount(workPackage.segGrams[index], named.segGrams[index])).filter(count => count >= 4).length;
      if (overlapping < 2) continue;
      const score = titleShared + overlapping * 2;
      if (score > bestScore) { bestScore = score; best = named; }
    }
    if (!best) continue;
    // 合并：把“工作包”小节中独有的量化参数句追加到保留小节的施工方法段末尾；单位先归一化避免“1596.99m2/1596.99平方米”双写
    const target = best;
    const normalizeUnits = (value: string) => value
      .replace(/平方米/gu, 'm2').replace(/m²|㎡/gu, 'm2')
      .replace(/立方米/gu, 'm3').replace(/m³/gu, 'm3')
      .replace(/毫米/gu, 'mm')
      .replace(/\s+/gu, '');
    const normalizedTarget = normalizeUnits(target.body);
    // 句子带单位的参数 token；句子的全部参数 token 已在保留小节中出现则不追加，避免同数字不同写法双写
    const PARAM_TOKEN = /\d+(?:\.\d+)?(?:平方米|立方米|毫米|m2|m3|mm|㎡|m²|m³|米|台|套|个|座|根|扇|樘|块|件|组|吨|kg|t|%)/gu;
    const allParamsAlreadyInTarget = (sentence: string) => {
      const tokens = sentence.match(PARAM_TOKEN);
      if (!tokens || tokens.length === 0) return false;
      return tokens.every(token => normalizedTarget.includes(normalizeUnits(token)));
    };
    const additions: string[] = [];
    for (const sentence of workPackage.body.split(/[。；，,\n]/u).map(item => item.trim()).filter(Boolean)) {
      if (!/\d/u.test(sentence)) continue;
      const stripped = sentence.replace(/^施工(?:概况|流程|方法)[:：]?/u, '').trim();
      if (!stripped) continue;
      if (allParamsAlreadyInTarget(stripped)) continue;
      additions.push(stripped);
    }
    if (additions.length > 0) target.body = `${target.body.trimEnd()}${additions.join('。')}。\n`;
    deleted.add(workPackage);
  }
  const remaining = packages.filter(item => !deleted.has(item));
  if (remaining.length === packages.length) return content;
  const numbered = remaining.every(item => /^\d+\.\d+\.\d+\s+/u.test(item.title));
  const rebuilt = remaining.map((item, index) => {
    const title = numbered ? `#### ${item.title.replace(/^\d+\.\d+\.\d+\s*/u, `${sectionBlock[0].split('\n')[0].match(/\d+\.\d+/u)?.[0] || '1.1'}.${index + 1} `)}` : `#### ${item.cleanTitle}`;
    return `${title}\n${item.body.trimEnd()}`;
  });
  const headingLine = block.slice(0, headingEnd + 1);
  return content.replace(block, `${headingLine}${rebuilt.join('\n')}\n`);
}


function hasTertiarySubsections(content: string, sectionTitle?: string) {
  const target = sectionTitle ? currentSectionBlock(sectionTitle, content) : content;
  return /^####\s+\S+/mu.test(target);
}

function hasMajorConstructionContentStructure(content: string) {
  const body = sectionContentBody(content);
  const packageCount = (body.match(/^####\s+(?:\d+\.\d+\.\d+\s+)?[一二三四五六七八九十\d]*[、.．]?\s*\S+/gmu) || []).length
    || (body.match(/^[一二三四五六七八九十]+、\S+/gmu) || []).length;
  const conceptCount = ['施工概况', '施工流程', '施工方法'].filter(keyword => body.includes(keyword)).length;
  return packageCount >= 3 && conceptCount === 3 && /→|->|测量|放线|验收|复试|检测|闭环/u.test(body);
}

type MajorConstructionPackage = { name: string; scope: string; quantities: string[]; process: string[]; acceptance: string[] };

function cleanMajorConstructionFact(text: string) {
  return cleanEvidenceText(text)
    .replace(/#{2,6}\s*[^；;。\n]+/gu, '')
    .replace(/资料内容事实[；;：:]?/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isUsableMajorConstructionFact(text: string) {
  const value = cleanMajorConstructionFact(text);
  if (!value || value.length < 4 || value.length > 120) return false;
  if (/资料内容事实|#{2,6}|未尽事宜|项目编号\s*[:：]?\s*[一二三四五六七八九十]?$/u.test(value)) return false;
  if (/本项目为|总建筑面积|保留现状|专业施工内容统筹|招标文件列明|招标范围还包含|具备有效的.*资质/u.test(value)) return false;
  // 清单原文备注式半截条目（“（土壤类别未注明）”“挖土深度未注明”等）不是可叙述工程量，过滤
  if (/未注明|以图纸为准|按设计要求确定/u.test(value) && !/\d/u.test(value)) return false;
  if ((value.match(/工程|维修|改造|安装|设备/gu) || []).length >= 4 && !/\d|㎡|m2|m²|mm|厚|验收|检测|调试|试验|复试/u.test(value)) return false;
  return /\d|㎡|m2|m²|mm|厚|工程|材料|设备|系统|范围|改造|维修|加固|消防|水电|智能化|管网|屋面|门窗|验收|检测|调试/u.test(value);
}

function splitFactItems(text: string) {
  return text.split(/[；;、，,]/u).map(item => cleanMajorConstructionFact(item)).filter(isUsableMajorConstructionFact);
}

function splitConstructionSteps(text: string) {
  return text.split(/→|；|;|、|，|,/u)
    .map(item => cleanMajorConstructionFact(item))
    .filter(item => item && item.length >= 2 && item.length <= 40)
    .filter(item => !/^按?施工准备$|^实施$|^检查$|^验收组织?$|^按规范和资料闭环$/u.test(item))
    .filter(item => !/本项目为|总建筑面积|保留现状|专业施工内容统筹|招标文件列明|招标范围|未尽事宜|具备有效/u.test(item));
}

/** 清单条目式去重：同一对象以“名称：数量”“名称 参数 数量”“名称｜规格”等格式重复出现时，
 * 先按归一化标点后的子串关系合并；子串不成立但共享设备型号/数量标识且首词相同或词集合存在包含关系的，保留信息更全的条目 */
export function dedupeQuantityFacts(items: string[]) {
  const result: Array<{ text: string; norm: string; tokens: Set<string>; models: Set<string> }> = [];
  for (const item of items) {
    const norm = item.replace(/[：:，,、；;｜|（）()]/gu, ' ').replace(/\s+/gu, ' ').trim();
    const tokens = new Set(norm.split(' ').filter(token => token.length >= 2));
    const models = new Set([
      ...(norm.match(/\d+[A-Z]{2,}[A-Za-z0-9]*/gu) || []),
      ...(norm.match(/\d+(?:\.\d+)?\s*(?:台|套|个|座|㎡|m2|m²|m³|m3|kg|t|根|扇|樘|块|件|组|mm)/gu) || []),
    ]);
    const firstToken = norm.split(' ')[0] || '';
    const existingIndex = result.findIndex(entry => {
      if (entry.norm.includes(norm) || norm.includes(entry.norm)) return true;
      // 同一对象的多格式条目：共享设备型号/数量标识，且首词相同或词集合存在包含关系
      const shareModel = [...models].some(model => entry.models.has(model)) || [...entry.models].some(model => models.has(model));
      if (!shareModel) return false;
      const subsetOf = (a: Set<string>, b: Set<string>) => [...a].every(token => b.has(token));
      return subsetOf(tokens, entry.tokens) || subsetOf(entry.tokens, tokens) || firstToken === entry.norm.split(' ')[0];
    });
    if (existingIndex >= 0) {
      const prev = result[existingIndex];
      // 词集合更全者优先；同规模时保留更简洁（含“名称：数量”格式）的条目
      if (tokens.size > prev.tokens.size || (tokens.size === prev.tokens.size && item.length < prev.text.length)) result[existingIndex] = { text: item, norm, tokens, models };
    } else {
      result.push({ text: item, norm, tokens, models });
    }
  }
  return result.map(entry => entry.text);
}

/** 流程步骤过滤：结构化数据常把工程量清单条目混入 process（如“XX总箱 2台 非标箱 挂墙安装”），
 * 这类条目不是工序动作，按“数字+量词”“设备型号串”与“是清单条目的子串”三重特征剔除 */
export function filterConstructionSteps(steps: string[], quantityFacts: string[]) {
  const quantityNorms = quantityFacts.map(item => item.replace(/[：:，,、；;｜|（）()]/gu, ' ').replace(/\s+/gu, ' ').trim());
  const actionWord = /安装|敷设|浇筑|砌筑|抹灰|回填|拆除|吊装|固定|连接|试验|调试|养护|压实|铺设|焊接|绑扎|涂刷|灌浆|开挖|预制|穿线|放线|找平|清底|防水|密封/u;
  return steps.filter(step => {
    if (/\d+(?:\.\d+)?\s*(?:台|套|个|座|㎡|m2|m²|m³|m3|kg|t|根|扇|樘|块|件|组)/u.test(step)) return false;
    // 设备条目式步骤（“安装XX总箱1APEza、XX风机配电箱3APpy等”）不是工序动作，剔除
    if (/[A-Z]+\d+/u.test(step) && /箱|柜|泵|机组|风机|面板/u.test(step)) return false;
    const norm = step.replace(/[：:，,、；;｜|（）()]/gu, ' ').replace(/\s+/gu, ' ').trim();
    // 短工序词（砌筑/抹灰/挂墙安装）即使出现在清单条目中也要保留
    if (norm.length <= 6 && actionWord.test(norm)) return true;
    // 短残尾仅当不是清单条目子串时保留（剔除“配电箱”式残尾）
    if (norm.length < 4) return !quantityNorms.some(quantity => quantity.includes(norm));
    return !quantityNorms.some(quantity => quantity.includes(norm));
  });
}

function isWorkPackageListFact(text: string) {
  const value = cleanMajorConstructionFact(text);
  if (!value) return true;
  const packageLikeCount = (value.match(/工程|维修|改造|安装|设备|系统|管网|屋面|门窗|消防|智能化/gu) || []).length;
  return packageLikeCount >= 5 && !/\d|㎡|m2|m²|mm|厚|验收|检测|调试|试验|复试|记录|报告|材料|设备|规格|标准|检验批/u.test(value);
}

export function parseMajorConstructionPackages(projectContext: string, evidence: DocumentEvidence[]): MajorConstructionPackage[] {
  const packages: MajorConstructionPackage[] = [];
  const structuredMatch = projectContext.match(/施工工作包结构化数据：\s*(\[[^\n]*\])/u);
  if (structuredMatch) {
    try {
      const items = JSON.parse(structuredMatch[1]) as Array<{ name?: string; scope?: string; quantities?: string[]; materials?: string[]; process?: string[]; methods?: string[]; acceptance?: string[] }>;
      for (const item of items) {
        const name = cleanMajorConstructionFact(item.name || '');
        const scope = cleanMajorConstructionFact(item.scope || '');
        const quantities = dedupeQuantityFacts([...(item.quantities || []), ...(item.materials || []), ...(item.methods || [])].map(cleanMajorConstructionFact).filter(isUsableMajorConstructionFact).filter(item => !isWorkPackageListFact(item)));
        const process = filterConstructionSteps((item.process || []).flatMap(splitConstructionSteps), quantities);
        const acceptance = (item.acceptance || []).map(cleanMajorConstructionFact).filter(item => item && !isWorkPackageListFact(item));
        if (!name || /^\d*徽光阁项目施工$/u.test(name) || name === '徽光阁项目施工') continue;
        if (!scope || /资料内容事实|#{2,6}/u.test(scope)) continue;
        packages.push({ name, scope, quantities, process, acceptance });
      }
      if (packages.length > 0) return packages.slice(0, 16);
    } catch {
      packages.length = 0;
    }
  }
  const graphLines = projectContext.split(/\r?\n/u).filter(line => /^\d+\.\s+.+?｜范围：/u.test(line));
  for (const line of graphLines) {
    const match = line.match(/^\d+\.\s+(.+?)｜范围：(.+?)｜工程量\/材料：(.+?)｜流程：(.+?)｜验收：(.+)$/u);
    if (!match) continue;
    const name = cleanMajorConstructionFact(match[1]);
    const scope = cleanMajorConstructionFact(match[2]);
    const quantities = dedupeQuantityFacts(splitFactItems(match[3]).filter(item => item !== '按证据展开'));
    const process = filterConstructionSteps(splitConstructionSteps(match[4]), quantities);
    const acceptance = match[5].split(/[；;、，,]/u)
      .map(item => cleanMajorConstructionFact(item))
      .filter(item => item && item !== '按规范和资料闭环')
      .filter(item => !isWorkPackageListFact(item));
    if (!name || /^\d*徽光阁项目施工$/u.test(name) || name === '徽光阁项目施工') continue;
    if (!scope || /资料内容事实|#{2,6}/u.test(scope)) continue;
    packages.push({ name, scope, quantities, process, acceptance });
  }
  return packages.slice(0, 8);
}

export function sectionStructureIssue(sectionTitle: string, content: string) {
  if (/项目主要施工内容/u.test(sectionTitle)) {
    const block = currentSectionBlock(sectionTitle, content);
    if (!hasTertiarySubsections(content, sectionTitle)) return `${sectionTitle} 缺少施工工作包三级小节`;
    if (!hasMajorConstructionContentStructure(block)) return `${sectionTitle} 未按施工工作包展开`;
    const packageBlocks = block.split(/^####\s+/gmu).slice(1).map(item => item.trim()).filter(Boolean);
    if (packageBlocks.some(item => !item.includes('施工概况') || !item.includes('施工流程') || !item.includes('施工方法'))) return `${sectionTitle} 存在工作包结构不完整`;
    // 脏事实/标题污染：针对去掉节标题后的正文检查；非法标题层级（## 二级、### 三级、##### 五级等）必须行首锚定，
    // #### 四级标题是本节合法的工作包标题，不得误判（否则本节永远回退兜底）
    const blockBody = sectionContentBody(block);
    if (/资料内容事实|(?:^#{2,3}|^#{5,6})\s+|\*\*[^*]+\*\*|未尽事宜|专业施工内容统筹|招标范围还包含|具备有效的.*资质|安全生产考核合格证书|注册建造师|联合体投标|项目经理要求|投标人资格|投标人资质|营业执照|安全生产许可证|资格审查|资格后审|中标通知书|签订合同|电子交易系统|投标保证金|评标办法|踏勘现场|投标预备会/mu.test(blockBody)) return `${sectionTitle} 存在脏事实或标题污染`;
    if (packageBlocks.some(item => /施工流程[:：][\s\S]*?(未尽事宜|本项目为|总建筑面积|保留现状|专业施工内容统筹|招标文件列明|招标范围|安全生产考核合格证书|联合体投标|注册建造师)/u.test(item))) return `${sectionTitle} 存在工作包流程污染`;
    // 工序链箭头硬门：方法段正文至少 1 条箭头工序链且全节箭头数充足，否则判定 Writer 未按“→”串联工序，本轮被拒并把原因反馈给后续重写
    const arrowChains = (block.match(/→/gu) || []).length;
    if (arrowChains < Math.max(5, packageBlocks.length) || packageBlocks.some(item => {
      const method = item.match(/施工方法[:：]([\s\S]*?)(?=\n施工|$)/u)?.[1] || '';
      return method.trim().length > 0 && !method.includes('→');
    })) return `${sectionTitle} 存在工作包方法段工序链箭头缺失`;
    if (packageBlocks.some(item => {
      const method = item.match(/施工方法[:：]([\s\S]*?)(?=\n施工|$)/u)?.[1] || '';
      if (/安全生产考核合格证书|联合体投标|注册建造师|投标人资格|资质要求|营业执照|安全生产许可证/u.test(method)) return true;
      if (method.length < 30) return true;
      // 方法段必须是“怎么做”的叙述：含施工动作/机具/检测动作词；
      // 纯参数罗列（有数字但无任何做法）一律判弱，回退到工艺知识卡兜底叙述。
      // “安装/固定/挂墙/机具”等弱词会出现在清单条目名里（如“配电箱 非标箱 挂墙安装 2台”），
      // 不足以证明是叙述；仅当同时存在多处“条目：数量”式冒号数字标记时才作为强证据判弱
      const strongAction = /→|采用|组织|浇筑|铺设|焊接|绑扎|砌筑|抹灰|涂刷|敷设|压实|养护|试验|调试|测量|放线|验收|检测|复试|记录|报告|吊装|灌注|埋设|嵌缝/u;
      const weakAction = /安装|固定|挂墙|机具/u;
      const listingMarkers = (method.match(/[:：]\s*\d/gu) || []).length;
      const bareParams = /\d/u.test(method) && !strongAction.test(method) && (listingMarkers >= 2 || !weakAction.test(method));
      return bareParams || ((method.match(/工程|维修|改造|安装|设备/gu) || []).length >= 4 && !/\d|㎡|m2|m²|mm|厚|验收|检测|调试|试验|复试|记录|报告/u.test(method));
    })) return `${sectionTitle} 存在工作包施工方法过弱`;
    const body = sectionContentBody(block);
    if (/^\s*\|.+\|\s*$/mu.test(body)) return `${sectionTitle} 不应使用 Markdown 表格替代工作包正文`;
  }
  return '';
}

export function ensureTertiarySectionShell(sectionTitle: string, content: string) {
  if (hasTertiarySubsections(content)) return content;
  const body = sectionContentBody(content);
  if (!body) return content;
  return `### ${sectionTitle}\n\n#### ${sectionTitle}\n\n${body}`;
}

export function ensureGroupTertiaryShell(groupSections: string[], content: string) {
  let normalized = content;
  for (const section of groupSections) {
    if (/项目主要施工内容/u.test(section)) continue;
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    normalized = normalized.replace(new RegExp(`(^###\\s+(?:\\d+\\.\\d+\\s+)?${escaped}\\s*\\n)([\\s\\S]*?)(?=^###\\s+|^##\\s+|$)`, 'gmu'), (_match, heading: string, body: string) => {
      return /^####\\s+\\S+/mu.test(body) ? `${heading}${body}` : `${heading}\n#### ${section}\n\n${body.trim()}\n`;
    });
  }
  return normalized;
}

export function groupHasMajorConstructionSection(groupSections: string[]) {
  return groupSections.some(section => /项目主要施工内容/u.test(section));
}

export function isCriticalDeepSection(sectionTitle: string) {
  return /项目特点.*重点.*难点|重点.*难点.*分析|项目主要施工内容|主要分部分项工程施工方案|主要施工方法|危大工程专项施工方案审批流程|原材料进场复试|见证取样/u.test(sectionTitle);
}

export function isGeneralManagementSection(sectionTitle: string) {
  return /项目管理组织|组织架构|岗位职责|施工部署|施工流水|交通组织|人车分流/u.test(sectionTitle);
}

export function keySectionWritingRequirement(sectionTitle: string) {
  if (/项目特点.*重点.*难点|重点.*难点.*分析/u.test(sectionTitle)) return [
    '关键小节结构要求：必须分为“项目特点分析、施工重点识别、施工难点及应对措施、重点难点与施工内容对应关系”。',
    '必须落位项目具体数据：项目名称、建设地点、建筑面积、层数、结构形式、装配式范围、计划工期、质量标准、施工专业范围、现场场地约束、既有管网接驳等已确认事实。',
    '必须用正式表格或分项清单表达：重点/难点、形成原因、影响范围、对应施工内容、控制措施、责任岗位、验收节点。',
  ].join('\n');
  if (/项目主要施工内容/u.test(sectionTitle)) return [
    '关键小节结构要求：必须参照优秀施工组织设计的“主要施工内容”写法，按当前项目资料识别专业工程/分部分项工作包，不得只写综合概述。',
    '每个工作包固定采用段落式三段：施工概况、施工流程、施工方法；不得使用 Markdown 表格，避免导出时产生表格分隔线残留。',
    '施工概况必须写清对象范围、工程量或规模、材料设备规格、施工部位；施工流程必须用箭头串联工序；施工方法必须写工艺做法、穿插组织、质量验收、检测复试、资料闭环。',
    '工作包类别必须从资料事实中识别，可覆盖但不限于结构加固、消防、装饰、水电、通风空调、弱电智能化、室外道排、屋面、立面、附属工程。',
  ].join('\n');
  if (/主要分部分项工程施工方案|主要施工方法/u.test(sectionTitle)) return [
    '关键小节结构要求：必须按专业工程和关键工序展开，不得只写概述流程。',
    '必须覆盖资料明确的专业工程范围。',
    '必须逐项响应“项目特点、重点、难点分析”中的控制对象，写明施工范围、施工方法、工艺流程、关键控制点、检查验收和资料闭环。',
  ].join('\n');
  return '';
}

export function criticalSectionBlockerMinChars(sectionTitle: string) {
  if (/危大工程专项施工方案审批流程|原材料进场复试|见证取样/u.test(sectionTitle)) return 650;
  if (/项目主要施工内容/u.test(sectionTitle)) return 1800;
  // “主要分部分项工程施工方案/主要施工方法”的全局门槛收敛到 1200：1800 字超过单次 LLM 稳定产出上限，
  // 导致 Writer/Repairer/Final Gate 补写永远被拒（真实生成中 1489 字也被判不足），空小节无法自愈。
  if (/主要分部分项工程施工方案|主要施工方法/u.test(sectionTitle)) return 1200;
  if (/项目特点.*重点.*难点|重点.*难点.*分析/u.test(sectionTitle)) return 1500;
  return 0;
}

export function outputTokensForChapter(minWords: number, targetWords?: number) {
  const words = targetWords || minWords;
  return Math.min(24000, Math.max(5000, Math.ceil(words * 1.45)));
}


export function expansionRoundsForDeficit(deficitChars: number) {
  if (deficitChars <= 0) return 0;
  return Math.max(1, Math.ceil(deficitChars / 4000));
}

export function acceptExpandedChapter(previous: string, next: string, chapterTitle: string, targetChars: number, maxChars = Math.ceil(targetChars * 1.12)) {
  const beforeLength = documentTextLength(previous);
  const afterLength = documentTextLength(next);
  const normalizedTitle = displayChapterTitle(chapterTitle);
  const remaining = Math.max(0, targetChars - beforeLength);
  const minimumGrowth = Math.min(300, Math.max(80, Math.floor(remaining * 0.2)));
  if (afterLength > maxChars) return false;
  if (remaining > 0 && afterLength < beforeLength + minimumGrowth) return false;
  if (afterLength < beforeLength * 0.98) return false;
  if (normalizedTitle && !next.includes(normalizedTitle)) return false;
  return true;
}
