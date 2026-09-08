import type { DocumentEvidence } from './types';
import { cleanEvidenceText } from './evidence';
import { containsForeignProject, extractBillItemFacts, extractStructuredTables, projectPlaceName } from './factsModel';
import { documentTextLength } from './budget';
import { displayChapterTitle } from './outline';
import { hasProcessSequenceExpression, normalizeSubsectionTitleForDedup, workPackageContentElementsComplete } from './utils';
import { criticalSectionBlockerMinChars as criticalSectionBlockerMinCharsFromSpec, DIVISION_SECTION_RE, isCriticalDeepSectionTitle } from './writingSpec';

export function sectionContentBody(content: string) {
  return content.replace(/^#{3,4}\s+.*\n+/u, '').trim();
}

export function currentSectionBlock(sectionTitle: string, content: string) {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // 定位支持 H3/H4 双层级（H4 关键小节实测：模板中“项目主要施工内容/主要分部分项工程施工方案”常为 H4）；
  // 块边界保持“下一个 H3/H2”：H4 目标块的内部工作包子标题（####）不会被截断，兄弟 H4 小节混入不干扰缺失判定
  // 注意：m 标志下 $ 匹配每个行尾，若本节是文档最后一节会导致块在首个 #### 行被截断；
  // 用 (?! [\s\S]) 表示真正的字符串末尾，
  const match = content.match(new RegExp(`^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^###\\s+|^##\\s+|(?![\\s\\S]))`, 'mu'));
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
  // 注意：m 标志下 $ 匹配每个行尾，结尾边界必须用 (?!(\s|\S)) 表示真正的字符串末尾，否则块在首行就被截断
  // H3/H4 双层级定位（H4 关键小节实测）
  const sectionBlock = content.match(/^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?(?:项目主要施工\s*内容|主要施工\s*内容)\s*\n([\s\S]*?)(?=^###\s+|^##\s+|(?!(\s|\S)))/mu);
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
      // 对应要素段至少两段语义重合（每段共享非停用 bigram ≥4）才判定同一工作包；低重叠多为跨工作包同名泛词（室内/改造/安装）。
      // 无标签自然成文块最多作为单段参与比较，不会触发“两段重合”误判合并
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
  // 4.17.9 内容要素检查（呈现形式不限）：三要素判定统一走 utils.workPackageContentElementsComplete，
  // 不再要求“施工概况/施工流程/施工方法”标签字面齐全（与写作提示词、专项验收器同口径）
  return packageCount >= 3 && workPackageContentElementsComplete(body);
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
        // B7 项目名形态过滤（丰乐镇第七轮章失败实测）：图谱首行可能是项目级信息行
        // （“1. 项目名｜范围：…｜工程量/材料：…｜流程：…｜验收：…”），name 为纯项目名
        // 时被当工作包名 → 块质检“缺工作包 vs 清单外”矛盾信号死循环 → 章失败
        if (!name || /项目施工$|项目$|^\d{4}年度/u.test(name)) continue;
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
    // B7 项目名形态过滤：图谱行 name 为纯项目名（“XX建设项目”）时不进工作包清单
    if (!name || /项目施工$|项目$|^\d{4}年度/u.test(name)) continue;
    if (!scope || /资料内容事实|#{2,6}/u.test(scope)) continue;
    packages.push({ name, scope, quantities, process, acceptance });
  }
  return packages.slice(0, 8);
}

// ═══════ 工作包骨架锁定（稳定版）：关键小节内部结构由系统确定性下发，LLM 只填内容不编结构 ═══════
// 历史根因：主题块管线/整章管线对关键小节只做“标题缺失/重复/越界 + 字数”质检，不查内容要素，
// LLM 自由发挥时「项目主要施工内容」小节两版波动（11:36 有 6 个专业工程小节，12:29 被重难点表占位）；
// 骨架锁定后小节内部 #### 标题由系统从资料识别的工作包清单锁定，波动源被确定性消除。

/** 列举尾巴清洗（三期验收实测）：清单/范围名「标识及其他项目等景观工程」「生态处理等污水工程」
 * 含“等”列举残留（“等”后才是真正工程名），LLM 面对带尾巴的标题无从写“作业对象与工程量”概况段 → 三要素丢两要素；
 * “等”后仍有 ≥3 字时取“等”后部分；“等”后尾巴太短（“生态池等工程”类总称）且“等”前 ≥3 字时取“等”前部分；
 * 否则原样；“等电/等级”类术语（“等”前为电、“等”后为级）不是列举残留，不清洗。
 * 必须位于 WHITE 过滤之后（“生态池等工程”依赖“工程”过白名单）且「及其他」碎片过滤之前（清洗后碎片随之消失） */
function stripEnumTail(name: string): string {
  const match = /^(.{1,18}?)(等)([\s\S]{2,})$/u.exec(name);
  if (!match || match[1] === undefined || match[3] === undefined) return name;
  if (/电$/u.test(match[1]) || /^级/u.test(match[3])) return name;
  if (match[3].length >= 3) return match[3];
  return match[1].length >= 3 ? match[1] : name;
}

/**
 * 招标范围确定性提取专业工程名（骨架锁定兑底通道）：PDF 清单类项目（如合肥师范）没有 Excel 目录结构，
 * 工作包图谱为空，但招标文件「招标范围」条款列明专业工程清单（顿号分隔），是权威的骨架来源；
 * 与图谱通道同源清洗（去括号注释/去噪声条目/去包含关系重复），提取不到足够工程名时返回空（骨架锁定不触发）
 */
export function scopeEngineeringNames(projectContext: string, evidence: DocumentEvidence[]): string[] {
  const texts = [projectContext, ...evidence.map(item => item.content)].filter(Boolean);
  const WHITE = /工程|安装|系统|通风|空调|智能化|装修|幕墙|屋面|土方|基坑|地基|基础|结构|电气|给排水|消防|防水|设备|管网|道路|景观|绿化|公厕|厕所|过路涵|涵|清淤|沟塘|塘|小菜园|菜园|排水沟|水沟|花池|树池|挡墙|护栏/u;
  // P3.2 项目范围隔离：上下文/证据混入其他项目资料目录时（knowledgeBase 多项目目录实测），
  // 「招标范围」窗口按句切分只保留当前项目段——窗口内含其他项目名短语（地名+项目形态）的句不参与工程名提取
  const currentPlace = (() => {
    for (const text of texts) {
      const match = /(?:项目名称|工程名称)[：:\s为是]+([^\n。；;]{4,120})/u.exec(text);
      if (!match) continue;
      const place = projectPlaceName(match[1]);
      if (place) return place;
    }
    return undefined;
  })();
  for (const text of texts) {
    const idx = text.indexOf('招标范围');
    if (idx < 0) continue;
    let window = text.slice(idx, idx + 600);
    if (currentPlace) {
      const sentences = window.split(/[。；;\n]/u).map(sentence => sentence.trim()).filter(Boolean);
      const kept = sentences.filter(sentence => !containsForeignProject(sentence, currentPlace));
      if (kept.length > 0) window = kept.join('。');
    }
    // 剥离“招标范围为建设规模内的全部内容，具体内容详见图纸及清单。招标内容包括但不限于”类前导语；
    // 无“包括但不限于”时退化为剥离“招标范围：”前缀；再剥“……等图纸及清单范围内所有工程”类尾部噪声
    let listText = window;
    const incIdx = listText.indexOf('包括但不限于');
    // 剥离后清理前导冒号/逗号等标点：真实模板常写作「包括但不限于：土方工程、…」，
    // 不清理会残留「：土方工程」半截条目
    if (incIdx >= 0) listText = listText.slice(incIdx + '包括但不限于'.length).replace(/^[：:、，,；;\s]+/u, '');
    else listText = listText.replace(/^[^、，,；;。]{0,60}?招标范围[：:]?\s*/u, '');
    listText = listText.replace(/(?:等)?图纸[、及]?清单范围内所有工程[。.]*/u, '');
    // 先整体去括号注释再按顿号切分：括号内可能含顿号（室外工程（景观、铺装、综合管网、智能化）），
    // 逐项去括号会残留“室外工程（景观”类半截条目
    const items = listText.replace(/（[^）]*）/gu, '').split(/[、，,；;。]/u)
      .map(item => cleanMajorConstructionFact(item).replace(/["“”']/gu, ''))
      .filter(item => item.length >= 3 && item.length <= 20)
      .filter(item => WHITE.test(item))
      // 列举尾巴清洗：WHITE 之后（依赖原文含“工程/景观”类词过白名单）、反例之前
      // （「标识及其他项目等景观工程」→「景观工程」后才不命中「及其他」碎片过滤）
      .map(item => stripEnumTail(item))
      .filter(item => item.length >= 3 && item.length <= 20)
      // 反例过滤（轮4 实测）：招标范围窗口内的写作约束文本（工程量/系统约束——仅指导写作/不得编造等）
      // 含「工程/系统」等白名单词会被误提为工作包名，块质检强制模型输出垃圾标题 → 章失败；
      // 约束性文本与专业工程名词汇特征互斥（约束/不得/仅指导/集中交代/参数/数字/矛盾/工程量）
      .filter(item => !/招标范围|图纸|清单|补疑|答疑|具体内容|包括但不限于|投标|专用合同|未尽事宜|工程量|约束|不得|仅指导|集中交代|矛盾|参数|数字/u.test(item))
      // B7 句子碎片过滤（丰乐镇第七轮章失败实测）：「重点实施以下配套基础」
      // 「包括村内道路硬化及亮化提升」「涵盖雨污水管网铺设」等叙述性文本碎片含 WHITE 词
      // 被误提为工作包名 → 块质检强制模型输出垃圾标题 → “缺工作包 vs 清单外”死循环章失败；
      // 谓词开头的碎片不是工程名，含“以下/以上/如下”的叙述残留一并过滤
      .filter(item => !/^(?:包括|涵盖|重点实施|实施|建设范围覆盖|本项目建设|主要包含|主要实施|具体包括|分别为|共计|包含|涉及)/u.test(item))
      .filter(item => !/以下|以上|如下|详见|具体内容/u.test(item))
      // 三期验收实测：「是否考虑现场道路」等招标答疑疑问句碎片（“是否”开头）含「道路」白名单词
      // 被误提为工作包名 → 模型面对疑问句标题无从写“作业对象与工程量”概况段 → 三要素丢两要素；
      // 「水沟及其他所有构筑物拆除」类含“及其他”的叙述组合不是独立工程名
      .filter(item => !/^是否/u.test(item))
      .filter(item => !/及其他|以及其他/u.test(item));
    const result: string[] = [];
    for (const item of items) {
      const compact = item.replace(/\s+/gu, '');
      if (result.some(existing => existing.replace(/\s+/gu, '').includes(compact) || compact.includes(existing.replace(/\s+/gu, '')))) continue;
      result.push(item);
    }
    if (result.length >= 3) return result.slice(0, 12);
  }
  return [];
}

// F10 清单条目聚合第三来源：工作包图谱与招标范围提取均无果时，从工程量清单表格聚合条目名兑底。
// 历史缺陷：清单中同物多规格（混凝土 C15/C30/C35 按分部分项区分）在骨架层无专属工作包字段，
// 主要施工内容小节只能凭空搭骨架，多规格分部分项无从落地；行级条目名直接作为工作包标题候选，
// 保证「不同分部分项不同规格」在骨架层就有独立锚点。
function billItemSkeletonNames(evidence: DocumentEvidence[]): string[] {
  const tables = extractStructuredTables(evidence);
  const facts = extractBillItemFacts(tables);
  const names: string[] = [];
  const seen = new Set<string>();
  // 非实体条目噪声（计价类行）不进骨架候选
  const BILL_ENTITY_NOISE = /计价|费用|税金|规费|暂列|暂估|合计|汇总|小计|措施项目|其他项目|税金项目/u;
  for (const fact of facts) {
    const name = fact.key.replace(/^清单条目：/u, '').trim();
    if (!name || name.length < 2 || name.length > 24) continue;
    if (BILL_ENTITY_NOISE.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.slice(0, 12);
}

/** 从项目上下文/证据确定性识别工作包名清单（供骨架锁定与骨架质检共用）：工作包图谱与招标范围提取
 * 并集兑底（P2/P4 修复：原三通道短路——图谱名>0 即独占返回，使清单独有分项静默丢失；
 * 图谱与招标范围以通用系统为主，乡村人居环境类分项（公厕/过路涵/污水管网/排水沟/沟塘清淤/小菜园）
 * 只存在于清单条目）；图谱/范围已主导时仅补乡村/市政特征分项（防通用土方/混凝土清单行拼入骨架噪声），
 * 图谱/范围均不足 3 个时保留 F10 原兑底路径（清单条目全额兑底，特征分项优先排序） */
export function majorConstructionSkeletonNames(projectContext: string, evidence: DocumentEvidence[]): string[] {
  const graphNames = parseMajorConstructionPackages(projectContext, evidence).map(pkg => pkg.name).filter(Boolean);
  const scopeNames = scopeEngineeringNames(projectContext, evidence);
  const billNames = billItemSkeletonNames(evidence);
  const merged: string[] = [];
  const push = (rawName: string): boolean => {
    const name = stripEnumTail(rawName.trim());
    const compact = name.replace(/\s+/gu, '');
    if (!compact) return false;
    // B7 统一工作包名合法性过滤（丰乐镇第七轮章失败实测）：图谱/范围/清单三来源均可能
    // 混入句子碎片与项目名，push 前统一拦截谓词开头碎片、含“以下/以上”的叙述残留、
    // 纯项目名形态（“XX建设项目”），保证骨架锁定与块质检清单不含垃圾标题；
    // 骨架名被全部过滤时 workPackageSkeletonTitles 返回空，骨架锁定自动回退软约束（安全兜底）
    if (/^(?:包括|涵盖|重点实施|实施以下|建设范围覆盖|本项目建设|主要包含|主要实施|具体包括|分别为|共计|包含|涉及|是否)/u.test(compact)) return false;
    if (/以下|以上|如下|详见|具体内容|及其他|以及其他/u.test(compact)) return false;
    if (/^\d{4}年度/u.test(compact)) return false;
    // P2.7 图纸名残片过滤（P0 验收实测）：图签 OCR「工程名称终端--白水塘、双塘设计阶段
    // 施工图」被图谱误认为工作包名 → 所有 division 块被强加「设计阶段施工图」骨架 → 章失败；
    // 工作包名不可能含图纸名形态（施工图/平面图/图集等），含者必为图纸残片或叙述残留
    if (/施工图|设计图|详图|平面图|剖面图|立面图|大样图|图集/u.test(compact)) return false;
    if (compact.length > 20) return false;
    if (merged.some(existing => {
      const existingCompact = existing.replace(/\s+/gu, '');
      return existingCompact.includes(compact) || compact.includes(existingCompact);
    })) return false;
    merged.push(name);
    return true;
  };
  for (const name of graphNames) push(name);
  // P2/P4 截断修复：图谱+招标范围至多占 12 个骨架位（图谱≤8），在 16 cap 下给乡村/市政特征分项
  // 保留至少 4 个补位名额——原实现 scope 全额入池会把 cap 占满，特征分项（公厕/污水管网等）全被截掉
  for (const name of scopeNames) {
    if (merged.length >= 12) break;
    push(name);
  }
  // 乡村/市政人居环境特征分项词表（评分报告 P4 缺失分项：过路涵/污水管网/排水沟/沟塘清淤/小菜园，P2 公厕）
  const RURAL_MUNICIPAL_RE = /公厕|厕所|过路涵|涵洞|涵管|污水|排水沟|水沟|清淤|沟塘|塘|小菜园|菜园|菜地|花池|树池|挡墙|护栏|路灯|检查井|化粪池|泵站|生态池|生态塘|护坡|驳岸|栈道|步道/u;
  const byFeatureFirst = (a: string, b: string) => Number(RURAL_MUNICIPAL_RE.test(b)) - Number(RURAL_MUNICIPAL_RE.test(a));
  if (merged.length < 3) {
    // F10 原兑底路径：图谱/范围均不足时清单条目全额兑底（特征分项优先排序）
    for (const name of [...billNames].sort(byFeatureFirst)) {
      if (merged.length >= 12) break;
      push(name);
    }
  } else {
    // P2/P4 补位路径：图谱/范围已主导时仅补乡村/市政特征分项——通用土方/混凝土类清单行
    // 与图谱/范围名大量重叠且属工作包内部工序粒度，不再拼入（防骨架噪声与既有行为漂移）
    for (const name of billNames) {
      if (merged.length >= 16) break;
      if (!RURAL_MUNICIPAL_RE.test(name)) continue;
      push(name);
    }
  }
  return merged;
}

/**
 * 关键小节骨架锁定提示词：识别到足够工作包时（默认 ≥3），把小节内部 #### 标题结构锁死为系统清单，
 * LLM 必须逐项展开且标题一字不差；识别不足时不注入（回退既有专项规则软约束）。
 * 三要素硬结构（4.18.6）：锁标题之上锁“施工概况/施工流程/施工方法”三段标签默认写法——
 * 历史缺陷（轮7 实测）：软性“三要素形式不限”导致 Writer 输出形态混乱（有的包只有作业对象一段、
 * 有的包丢标题裸奔、两套标签形态混用、季节施工/组织机构混入工作包列表）；
 * 默认写法由系统提示词给出（用户提示词可覆盖形式），三要素齐全为硬门槛，
 * 示例数值仅示意写法，必须标注不得照抄（历史缺陷：示例数值跨项目串染）。
 * 同时附带否定性约束：禁止 Markdown 表格、禁止重难点表/节点计划表串入本小节。
 */
export function workPackageSkeletonPrompt(projectContext: string, evidence: DocumentEvidence[], minCount = 3, namesOverride?: string[]): string {
  const names = namesOverride ?? majorConstructionSkeletonNames(projectContext, evidence);
  if (names.length < minCount) return '';
  const skeleton = names.map((name, index) => `#### ${index + 1} ${name}`).join('\n');
  return [
    `【小节骨架锁定】本节内部结构已由系统锁定，必须且只能按以下 ${names.length} 个工作包小节标题逐项展开（标题一字不差，不得增删改、合并或调序）：`,
    skeleton,
    '每个工作包小节必须覆盖三方面要素：作业对象与工程量、工序顺序、施工方法（三要素缺一不可）。默认按“施工概况/施工流程/施工方法”三段标签逐段写出；若用户提示词对写法形式另有要求，以用户提示词为准，但三要素内容必须齐全。',
    '三段标签默认写法：\n施工概况：作业对象与部位、工程量或规模、材料设备规格型号（数量类数值优先取工程量清单数据）；\n施工流程：工序先后顺序清晰（顺序词/箭头链/编号步骤任一形式）；\n施工方法：工艺做法、工艺参数（数值+单位）、验收检测与记录闭环。',
    '写法示例（仅为形式示意，示例中的数值必须替换为本项目绑定资料中的真实数值，不得照抄示例数值）：\n施工概况：本工程室外道排范围覆盖园区内雨水、污水管网及检查井，主要工程量 HDPE 双壁波纹管 DN300 约 1200m、检查井 45 座，管材环刚度 SN8。\n施工流程：测量放线→沟槽开挖→管道基础→管道铺设→闭水试验→分层回填→压实度检测→验收。\n施工方法：沟槽机械开挖配合人工清底，槽底标高偏差控制在±20mm以内；接口采用承插式橡胶圈连接；回填每层虚铺厚度不超过300mm，压实度不低于95%，检测合格后形成记录归档闭环。',
    '数值来源优先级：工程量、材料规格、设备型号等数量类数值优先取工程量清单数据；清单未覆盖的参数（标高、坡率、构造做法等）才取图纸数据；禁止“按设计图纸执行”“详见设计图纸”“按设计文件确定”式概括话术——必须落到具体数值或具体规范条文。',
    '本节禁止出现 Markdown 表格；禁止写入重难点识别表、关键施工节点控制计划表等属于其他小节的内容；禁止只写综合概述而不展开工作包。',
  ].join('\n');
}

/** 关键小节内应锁定的工作包标题清单（与 workPackageSkeletonPrompt 同源，供写作后骨架质检） */
export function workPackageSkeletonTitles(projectContext: string, evidence: DocumentEvidence[], minCount = 3): string[] {
  const names = majorConstructionSkeletonNames(projectContext, evidence);
  return names.length >= minCount ? names : [];
}

/**
 * P2.7 块级骨架名过滤（单要点分部块修复，P0 验收实测）：只保留与块要点标题互相包含的骨架名。
 * 「主要施工方法」章分部块（subPoints 仅同名 1 个，如「小菜园」）原逻辑全量保留章级工作包骨架名
 * （终端--白水塘、景观工程等）→ 每个分部块被要求写全章级工作包 → 与 coverageList「同名要点由
 * H3 外壳承担」矛盾 → 两轮重试全灭 → 章失败。统一过滤后：单要点分部块匹配不到章级工作包名 →
 * 空 → divisionPrompt 三段式接管；容器块 subPoints 已骨架展开（同源）→ 全量保留。
 * 过滤后不足 minCount 视为无骨架可锁（与 workPackageSkeletonTitles 同口径）。
 */
export function matchBlockSkeletonNames(rawNames: string[], subPointTitles: string[], minCount = 3): string[] {
  const matched = rawNames.filter(name => subPointTitles.some(title => {
    const titleNorm = normalizeSubsectionTitleForDedup(title);
    const nameNorm = normalizeSubsectionTitleForDedup(name);
    return titleNorm.includes(nameNorm) || nameNorm.includes(titleNorm);
  }));
  return matched.length >= minCount ? matched : [];
}

/** 确定性剥离 Markdown 表格块（关键小节禁止表格承载正文）：删除整张表格行；表格前后独立空行同步清理 */
export function stripMarkdownTableBlocks(content: string): string {
  const lines = content.split(/\r?\n/u);
  const out: string[] = [];
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|.+\|\s*$/u.test(trimmed)) { inTable = true; continue; }
    if (inTable) {
      if (trimmed === '') continue;
      inTable = false;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** 关键小节内容串位检测：重难点表/节点计划表等表头形态出现在「项目主要施工内容/分部分项」小节正文中即串位 */
export function workPackageCrossSectionIssue(content: string): string {
  if (/^\s*\|\s*重难点\s*\|/mu.test(content)) return '重难点识别表串入本小节（应属于重点难点分析小节）';
  if (/^\s*\|\s*关键节点\s*\|/mu.test(content)) return '关键施工节点控制计划表串入本小节（应属于进度计划小节）';
  if (/^\s*\|\s*危险源\s*\|/mu.test(content)) return '危险源辨识清单表串入本小节（应属于安全管理小节）';
  return '';
}

/** 小节级表格确定性剥离：只剥指定小节块内的表格，其他小节的合法表格不动（供修复链稳定版兑底）；
 * skeletonNames 传入骨架工作包清单时可精确区分 H4 目标小节的工作包与兄弟小节（工作包内表格属污染照剥，兄弟小节表格保留）；
 * 不传时对 H4 目标保守截断（目标标题行到第一个 H4 行之间），避免无清单时误剥兄弟小节表格 */
export function stripTablesInSection(content: string, sectionTitle: string, skeletonNames: string[] = []): string {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const titleRe = new RegExp(`^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*$`, 'u');
  const lines = content.split('\n');
  const start = lines.findIndex(line => titleRe.test(line.trim()));
  if (start < 0) return content;
  const isH4Target = /^####\s+/u.test(lines[start].trim());
  const skeletonNorms = skeletonNames.map(normalizeSubsectionTitleForDedup);
  const blockLines: string[] = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^#{2,3}\s+/u.test(trimmed)) break;
    if (/^####\s+/u.test(trimmed) && isH4Target) {
      // H4 目标：骨架清单内的 H4 行是工作包子标题（继续收集，内部表格属污染照剥），其余 H4 行是兄弟小节边界（截断，合法表格不误剥）
      const title = trimmed.replace(/^####\s+(?:\d+(?:\.\d+)*\s+)?/u, '');
      const norm = normalizeSubsectionTitleForDedup(title);
      const isWorkPackage = skeletonNorms.some(name => norm.includes(name) || name.includes(norm));
      if (!isWorkPackage) break;
    }
    blockLines.push(lines[index]);
  }
  const block = blockLines.join('\n');
  const stripped = stripMarkdownTableBlocks(block);
  return stripped === block ? content : content.replace(block, stripped);
}

/** 骨架齐全性复核：返回小节块内缺失的工作包标题（标题归一化后包含匹配即视为已覆盖；小节不存在时返回空数组不误报） */
export function missingWorkPackageSkeletonTitles(content: string, sectionTitle: string, skeletonNames: string[]): string[] {
  const block = currentSectionBlock(sectionTitle, content);
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (!new RegExp(`^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*$`, 'u').test(block.split('\n')[0]?.trim() || '')) return [];
  const headingLines = (block.match(/^#{3,4}\s+(.+)$/gmu) || []).map(line => line.replace(/^#{3,4}\s+/u, ''));
  return skeletonNames.filter(name => !headingLines.some(line => normalizeSubsectionTitleForDedup(line).includes(normalizeSubsectionTitleForDedup(name))));
}

/** 稳定版：关键小节内空正文工作包确定性剥离（零 LLM）——骨架标题存在但正文不足 80 字的包
 * （轮3 实测 12 个骨架包中 4 个正文为空，而补写判定只看标题缺失 → 空包永远漏补），
 * 把空包整块删除后，补写轮按“标题缺失”口径锚点直连补写（标题一字不差由系统下发），
 * 复用现有补写链路，避免新增锚点语义与重复标题风险 */
export function stripEmptyWorkPackageHeadings(content: string, sectionTitle: string, skeletonNames: string[]): string {
  const block = currentSectionBlock(sectionTitle, content);
  // 小节存在性判定与 missingWorkPackageSkeletonTitles 同口径（首行标题匹配）——不能用 block === content 判定：
  // 章内仅此一节时 currentSectionBlock 的 match[0] 就是整个章内容（块边界为正则 lookahead 的整串），
  // 会被误判“小节未找到”导致空包剥离全部失效
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (!new RegExp(`^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*$`, 'u').test(block.split('\n')[0]?.trim() || '')) return content;
  const parts = block.split(/^####\s+/gmu);
  const head = parts.shift() || '';
  const kept: string[] = [];
  for (const pkg of parts) {
    const lines = pkg.split('\n');
    const title = (lines[0] || '').trim();
    const normalized = normalizeSubsectionTitleForDedup(title);
    const bodyText = lines.slice(1).join('\n').replace(/^#{1,6}\s+.+$/gmu, '').trim();
    const isSkeletonPackage = skeletonNames.some(name => normalized.includes(normalizeSubsectionTitleForDedup(name)));
    if (isSkeletonPackage && bodyText.length < 80) continue;
    kept.push(pkg);
  }
  const rebuilt = `${head}${kept.length > 0 ? '#### ' : ''}${kept.join('#### ')}`;
  return rebuilt === block ? content : content.replace(block, rebuilt);
}

/** “项目主要施工内容”脏事实/标题污染检查（供结构门禁与降级验收复用）：
 * 针对去掉节标题后的正文；非法标题层级（## 二级、### 三级、##### 五级等）必须行首锚定，
 * #### 四级标题是本节合法的工作包标题，不得误判 */
export function majorContentPollutionIssue(blockBody: string) {
  return /资料内容事实|(?:^#{2,3}|^#{5,6})\s+|\*\*[^*]+\*\*|未尽事宜|专业施工内容统筹|招标范围还包含|具备有效的.*资质|安全生产考核合格证书|注册建造师|联合体投标|项目经理要求|投标人资格|投标人资质|营业执照|安全生产许可证|资格审查|资格后审|中标通知书|签订合同|电子交易系统|投标保证金|评标办法|踏勘现场|投标预备会/mu.test(blockBody);
}

/** 确定性补全“项目主要施工内容”小节内工作包的要素标签（4.17.9 兼容处理，标签非强制）：
 * 内容要素不全的块被结构门禁拒绝后，本函数把块内无标签文本按顺序归入标签（流程优先取含“→”的行），
 * 不生成新内容、不重排已有标签行，修复后由调用方复查结构门禁决定是否采用；
 * 无标签但要素齐全的块不会触发结构门禁，本函数不会被调用 */
export function repairMajorContentWorkPackageLabels(content: string) {
  if (!/项目主要施工内容/u.test(content)) return content;
  const lines = content.split(/\r?\n/u);
  const result: string[] = [];
  let inMainSection = false;
  let block: string[] | null = null;
  const flushBlock = () => {
    if (!block) return;
    const heading = block[0];
    const bodyLines = block.slice(1);
    const hasOverview = bodyLines.some(line => /^施工概况[:：]?/u.test(line.trim()));
    const hasFlow = bodyLines.some(line => /^施工流程[:：]?/u.test(line.trim()));
    const hasMethod = bodyLines.some(line => /^施工方法[:：]?/u.test(line.trim()));
    if (hasOverview && hasFlow && hasMethod) {
      result.push(...block);
      block = null;
      return;
    }
    const fixed: string[] = [heading];
    const unlabeled: string[] = [];
    for (const line of bodyLines) {
      if (/^(施工概况|施工流程|施工方法)[:：]/u.test(line.trim())) fixed.push(line);
      else if (line.trim()) unlabeled.push(line);
    }
    if (unlabeled.length === 0) {
      result.push(...block);
      block = null;
      return;
    }
    // 缺哪个标签补哪个：概况取首条无标签行，流程优先取含“→”的行（无法确定性造箭头时不硬补），方法取剩余行合并
    const remaining = [...unlabeled];
    if (!hasOverview && remaining.length) {
      const line = remaining.shift();
      if (line !== undefined && line.trim()) fixed.push(`施工概况：${line.trim()}`);
    }
    if (!hasFlow && remaining.length) {
      // 4.19 流程行匹配扩展：不仅含“→”箭头，顺序词叙述/编号步骤等工序顺序表达行同样可归入流程标签
      const flowIndex = remaining.findIndex(line => line.includes('→') || hasProcessSequenceExpression(line));
      if (flowIndex >= 0) {
        const [flow] = remaining.splice(flowIndex, 1);
        fixed.push(`施工流程：${flow.trim()}`);
      }
    }
    if (!hasMethod && remaining.length) {
      const methodText = remaining.map(line => line.trim()).filter(Boolean).join('');
      if (methodText) fixed.push(`施工方法：${methodText}`);
    }
    // 已有多余标签但仍有未归类行（如已有流程/方法标签而概况补完后剩余的正文）：原样保留在块尾，避免丢内容
    fixed.push(...remaining.filter(line => line.trim()));
    result.push(...fixed);
    block = null;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+/u.test(trimmed)) {
      flushBlock();
      block = null;
      inMainSection = false;
      result.push(line);
      continue;
    }
    if (/^###\s+/u.test(trimmed)) {
      flushBlock();
      block = null;
      inMainSection = /项目主要施工内容/u.test(trimmed);
      result.push(line);
      continue;
    }
    // H4 形态关键小节（模板实测“#### 项目主要施工内容”）：小节标题行本身不是工作包块，只翻转小节范围标记；
    // 必须放在 !inMainSection 检查之前，否则 H4 形态下 inMainSection 恒 false 导致标签补全整体哑火
    if (/^####\s+/u.test(trimmed) && /项目主要施工内容/u.test(trimmed)) {
      flushBlock();
      block = null;
      inMainSection = true;
      result.push(line);
      continue;
    }
    if (!inMainSection) {
      result.push(line);
      continue;
    }
    if (/^####\s+/u.test(trimmed)) {
      flushBlock();
      block = [line];
      continue;
    }
    if (/^#{1,6}\s+/u.test(trimmed)) {
      flushBlock();
      block = null;
      result.push(line);
      continue;
    }
    if (block) block.push(line);
    else result.push(line);
  }
  flushBlock();
  return result.join('\n');
}

export function sectionStructureIssue(sectionTitle: string, content: string) {
  if (/项目主要施工内容/u.test(sectionTitle)) {
    const block = currentSectionBlock(sectionTitle, content);
    if (!hasTertiarySubsections(content, sectionTitle)) return `${sectionTitle} 缺少施工工作包三级小节`;
    if (!hasMajorConstructionContentStructure(block)) return `${sectionTitle} 未按施工工作包展开`;
    const packageBlocks = block.split(/^####\s+/gmu).slice(1).map(item => item.trim()).filter(Boolean);
    // 4.17.9 内容要素检查（呈现形式不限）：每个工作包块必须覆盖作业对象与工程量/工序顺序/施工方法三方面要素，
    // 不再按“施工概况/施工流程/施工方法”标签字面判定——无标签但写法正确的块不应被拒（写作提示词与验收器同口径）
    if (packageBlocks.some(item => !workPackageContentElementsComplete(item))) return `${sectionTitle} 存在工作包内容要素不全`;
    // 脏事实/标题污染：针对去掉节标题后的正文检查；非法标题层级（## 二级、### 三级、##### 五级等）必须行首锚定，
    // #### 四级标题是本节合法的工作包标题，不得误判（否则本节永远回退兜底）
    const blockBody = sectionContentBody(block);
    if (majorContentPollutionIssue(blockBody)) return `${sectionTitle} 存在脏事实或标题污染`;
    if (packageBlocks.some(item => /施工流程[:：][\s\S]*?(未尽事宜|本项目为|总建筑面积|保留现状|专业施工内容统筹|招标文件列明|招标范围|安全生产考核合格证书|联合体投标|注册建造师)/u.test(item))) return `${sectionTitle} 存在工作包流程污染`;
    // 工序顺序表达硬门：工作包方法段/流程段必须有工序顺序表达（箭头链/编号步骤/有序无序列表/顺序词/连接线任一），
    // 不再强制“→”箭头形式；缺失则判定 Writer 未按工序顺序展开，本轮被拒并把原因反馈给后续重写
    if (!hasProcessSequenceExpression(block) || packageBlocks.some(item => {
      const method = item.match(/施工方法[:：]([\s\S]*?)(?=\n施工|$)/u)?.[1] || '';
      const flow = item.match(/(?:施工流程|工艺流程)[:：]([\s\S]*?)(?=\n施工|$)/u)?.[1] || '';
      return (method.trim().length > 0 || flow.trim().length > 0) && !hasProcessSequenceExpression(method + flow);
    })) return `${sectionTitle} 存在工作包工序顺序表达缺失`;
    if (packageBlocks.some(item => {
      const method = item.match(/施工方法[:：]([\s\S]*?)(?=\n施工|$)/u)?.[1] || '';
      // 4.17.9 无标签形态（自然成文）：方法要素强弱由上方内容要素检查（hasMethod）把关，
      // 本检查只针对“施工方法：”标签形态的方法段，避免空提取把无标签块恒判“过弱”
      if (!/施工方法[:：]/u.test(item)) return false;
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
  // 4.19 三要素硬门扩围（合肥师范实测：主要施工方法节 5 个工作包 4 个不全——人防只有流程、
  // 机电缺概况、主体缺方法）：主要分部分项工程施工方案/主要施工方法节同样逐包校验
  // 作业对象与工程量/工序顺序/施工方法三要素与工序顺序表达，不再只覆盖“项目主要施工内容”节
  if (DIVISION_SECTION_RE.test(sectionTitle)) {
    const block = currentSectionBlock(sectionTitle, content);
    if (!hasTertiarySubsections(content, sectionTitle)) return `${sectionTitle} 缺少分项工程方案三级小节`;
    const packageBlocks = block.split(/^####\s+/gmu).slice(1).map(item => item.trim()).filter(Boolean);
    if (packageBlocks.length === 0) return `${sectionTitle} 未按分项工程方案展开`;
    if (packageBlocks.some(item => !workPackageContentElementsComplete(item))) return `${sectionTitle} 存在分项方案内容要素不全`;
    if (!hasProcessSequenceExpression(block) || packageBlocks.some(item => {
      const method = item.match(/施工方法[:：]([\s\S]*?)(?=\n施工|$)/u)?.[1] || '';
      const flow = item.match(/(?:施工流程|工艺流程)[:：]([\s\S]*?)(?=\n施工|$)/u)?.[1] || '';
      return (method.trim().length > 0 || flow.trim().length > 0) && !hasProcessSequenceExpression(method + flow);
    })) return `${sectionTitle} 存在分项方案工序顺序表达缺失`;
  }
  return '';
}

export function ensureTertiarySectionShell(sectionTitle: string, content: string) {
  if (hasTertiarySubsections(content)) return content;
  const body = sectionContentBody(content);
  if (!body) return content;
  // 彻底修复同名结构：只补 H3 外壳，不再补与 H3 同名的 H4（历史缺陷：H3/H4 同名诱发模型重复展开 → 重复质检卡死 → 章阻断）
  return `### ${sectionTitle}\n\n${body}`;
}

export function ensureGroupTertiaryShell(groupSections: string[], content: string) {
  let normalized = content;
  for (const section of groupSections) {
    if (/项目主要施工内容/u.test(section)) continue;
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    normalized = normalized.replace(new RegExp(`(^###\\s+(?:\\d+\\.\\d+\\s+)?${escaped}\\s*\\n)([\\s\\S]*?)(?=^###\\s+|^##\\s+|$)`, 'gmu'), (_match, heading: string, body: string) => {
      if (/^####\s+\S+/mu.test(body)) return `${heading}${body}`;
      // 修复注记：原实现为正则字面量双重转义（/^####\\s+\\S+/mu 匹配字面反斜杠+s），
      // H4 检测恒 false，已有 H4 的组节块被误走同名分支空行归一；修正为单转义后
      // 已有 H4 的组节块原样保留（与注释意图一致，避免成稿空行漂移）
      // 彻底修复同名结构：H3 标题已与组标题同名时，H3 即承担该小节标题，不再补同名 H4
      //（历史缺陷：补出「### X → #### X」同名外壳，诱发模型重复展开同名 H4 → 重复质检卡死 → 章阻断）
      const headingTitle = heading.replace(/^#{1,6}[\s]*/, '').replace(/^\d+(?:\.\d+)*[\s]*/, '').trim();
      if (normalizeSubsectionTitleForDedup(headingTitle) === normalizeSubsectionTitleForDedup(section)) return `${heading}\n${body.trim()}\n`;
      return `${heading}\n#### ${section}\n\n${body.trim()}\n`;
    });
  }
  return normalized;
}

export function groupHasMajorConstructionSection(groupSections: string[]) {
  return groupSections.some(section => /项目主要施工内容/u.test(section));
}

export function isCriticalDeepSection(sectionTitle: string) {
  // 单点转发：深度关键小节判别统一由 writingSpec 收口，新增类型只改 writingSpec 一处
  return isCriticalDeepSectionTitle(sectionTitle);
}

export function isGeneralManagementSection(sectionTitle: string) {
  return /项目管理组织|组织架构|岗位职责|施工部署|施工流水|交通组织|人车分流/u.test(sectionTitle);
}

export function keySectionWritingRequirement(sectionTitle: string) {
  if (/项目特点.*重点.*难点|重点.*难点.*分析/u.test(sectionTitle)) return [
    '关键小节结构要求：必须分为“项目特点分析、施工重点识别、施工难点及应对措施、重点难点与施工内容对应关系”。',
    '必须落位项目具体数据：项目名称、建设地点、建筑面积、层数、结构形式、装配式范围、计划工期、质量标准、施工专业范围、现场场地约束、既有管网接驳等已确认事实。',
    '必须用正式表格或分项清单表达：重点/难点、形成原因、影响范围、对应施工内容、控制措施、责任岗位、验收节点。',
    '每个重点/难点条目必须在正文中写明成因归因句（说明该难点的形成原因与风险来源）与量化控制目标（数值+单位，如“控制在5mm以内”“不大于30分钟”，数值来自绑定资料或行业规范）；对策必须回应归因并给出可核查的量化验收标准；无归因、无量化控制目标、无针对性对策的条目视为不合格必须重写。',
  ].join('\n');
  if (/项目主要施工内容/u.test(sectionTitle)) return [
    '关键小节结构要求：必须参照优秀施工组织设计的“主要施工内容”写法，按当前项目资料识别专业工程/分部分项工作包，不得只写综合概述。',
    '每个工作包必须覆盖作业对象与工程量、工序顺序、施工方法三方面要素（三要素缺一不可）；默认按“施工概况/施工流程/施工方法”三段标签逐段写出（若用户提示词对形式另有要求，以用户提示词为准，但三要素内容必须齐全）；不得使用 Markdown 表格，避免导出时产生表格分隔线残留。',
    '施工概况写对象范围、工程量或规模、材料设备规格、施工部位；施工流程必须有明确的工序顺序表达（顺序词叙述、编号步骤、有序/无序列表或箭头链均可）；施工方法写工艺做法、穿插组织、工艺参数、质量验收、检测复试、资料闭环。',
    '数值来源优先级：工程量、材料规格、设备型号等数量类数值优先取工程量清单数据；清单未覆盖的参数（标高、坡率、构造做法等）才取图纸数据；禁止“按设计图纸执行”“详见设计图纸”“按设计文件确定”式概括话术——必须落到具体数值或具体规范条文。',
    '工作包类别必须从资料事实中识别，可覆盖但不限于结构加固、消防、装饰、水电、通风空调、弱电智能化、室外道排、屋面、立面、附属工程。',
  ].join('\n');
  if (/主要分部分项工程施工方案|主要施工方法/u.test(sectionTitle)) return [
    '关键小节结构要求：必须按专业工程和关键工序展开，不得只写概述流程。',
    '必须覆盖资料明确的专业工程范围。',
    '必须逐项响应“项目特点、重点、难点分析”中的控制对象，写明施工范围、施工方法、工艺流程、关键控制点、检查验收和资料闭环。',
    '每个分项工程方案必须覆盖作业对象与工程量、工序顺序、施工方法三方面要素（三要素缺一不可）；默认按“施工概况/工艺流程/施工方法”三段标签逐段写出（若用户提示词对形式另有要求，以用户提示词为准，但三要素内容必须齐全）；数值来源优先级同主要施工内容：数量类数值优先取工程量清单，清单未覆盖才取图纸数据，禁止“按设计图纸执行”式概括话术。',
  ].join('\n');
  return '';
}

export function criticalSectionBlockerMinChars(sectionTitle: string) {
  // 单点转发：生成侧深度门槛统一由 writingSpec 收口
  return criticalSectionBlockerMinCharsFromSpec(sectionTitle);
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
