/**
 * 归一层（4.61）：结构化块 → `DesignFact` / `BidObligation`。
 *
 * ## 判据是「收件人」，不是「义务性」
 *
 * 图纸设计说明里全是「应」「不应」「不小于」——**义务性判据会把它们全判为要求**，
 * 而它们**确实是**要求，只是**收件人是施工方/工程实体**，不是投标人。
 * 所以在知道载体之后，用载体决定去向：
 *
 * | 载体 | 去向 |
 * |---|---|
 * | 图纸设计说明 / 标注 / 材料表 | `DesignFact`（权威层，要执行） |
 * | 清单项目特征 / 工程量 | `DesignFact`（权威层） |
 * | 招标正文 / 答疑 / 评标办法 | `BidObligation`（要求池，要响应） |
 * | DXF 结构 / 图层名 / 尺寸数字（无绑定） | 元数据，不进任何语义池 |
 *
 * ## 本层不做的事
 *
 * - **不做过滤**：不丢弃任何文本，只决定去向（旧实现"不预筛不剔除"的初衷是对的，
 *   错的是它把"不丢弃"等同于"不分流"）。
 * - **不拼接**：`body`/`value` 保留原样，渲染是消费层的事。
 * - **不猜绑定**：尺寸 → 对象 的绑定失败会被记账（`BindingFailure`），不静默。
 */
import type { AuthorityCarrier, BidObligation, DesignFact, FactDomain, FactRelation, SourceAnchor } from './types.js';
import type { CadEntity } from './cad-entities.js';
import type { ClauseBlock } from './clause-model.js';
import { parseFeatureCell, resolveTableColumnRoles, type TableBlock } from './table-model.js';

/** 绑定失败记账（不变式 6：失败必须可观测，不得作为规则例外静默吞掉） */
export interface BindingFailure {
  kind: 'dimension-without-subject' | 'row-without-role' | 'clause-without-number' | 'value-without-attribute';
  /** 失败对象的最小可读描述（供人工复核与解析器缺陷修复） */
  detail: string;
  anchor: SourceAnchor;
}

export interface NormalizeResult {
  facts: DesignFact[];
  obligations: BidObligation[];
  failures: BindingFailure[];
}

/** 归一裁决键：同域 + 同对象 + 同属性 才可比 */
export function factKey(domain: FactDomain, subject: string, attribute: string): string {
  const norm = (text: string) => text.replace(/\s+/gu, '').replace(/[（）()]/gu, '');
  return `${domain}\u0000${norm(subject)}\u0000${norm(attribute)}`;
}

/** 稳定 id（同源同值幂等；不用随机数，便于重放与对账） */
function factId(anchor: SourceAnchor, subject: string, attribute: string, value: string): string {
  return `${anchor.filePath}#${anchor.sheet ?? ''}#${anchor.layer ?? ''}#${anchor.position?.row ?? ''}#${subject}#${attribute}#${value}`;
}

// ─────────────────────────── 值形态解析（确定性，无词表） ───────────────────────────

/**
 * 中文约束句 → (属性, 关系, 值, 单位)。
 *
 * 判据是**形态**：`主体 + 模态词 + 数值 + 单位`。模态词到关系的映射是语法而非词表：
 * 不小于/不低于/不得小于/至少/≥ → `>=`；不大于/不超过/不得大于/至多/≤ → `<=`；
 * 为/应/取/采用/宜为/＝ → `=`；`N~M`/`N-M` → `range`。
 */
const RELATION_PATTERNS: ReadonlyArray<{ re: RegExp; relation: FactRelation }> = [
  { re: /不小于|不低于|不得小于|不得低于|至少|最少|≥|>=/u, relation: '>=' },
  { re: /不大于|不超过|不得大于|不得超(?:过|出)|至多|最多|≤|<=/u, relation: '<=' },
  { re: /(?:控制|范围|区间)在?|为\s*[-~～]/u, relation: 'range' },
  { re: /(?:为|应(?:取|为|采用)?|取|采用|使用|选定|宜为|按|等于|=|＝)/u, relation: '=' },
];

/** 数值+单位 token（单位表按长度降序，避免 m 抢 mm） */
const UNIT_ALTERNATION = '(?:mm|cm|dm|km|m2|m²|m3|m³|kg|kN|MPa|kPa|Pa|kV|V|A|kW|W|℃|°C|Ω|MΩ|h|min|s|d|t|L|%|‰|度|天|日|小时|分钟|年|月|周|个|根|套|台|座|处|樘|件|块|层|道|组|批|项|米|毫米|厘米|平方米|立方米|吨|公斤|千克|升)';
const VALUE_TOKEN_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_ALTERNATION})?`, 'u');
const RANGE_TOKEN_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:[-~～至]|\\s*到\\s*)\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT_ALTERNATION})?`, 'u');

/** 材料牌号/标准规格 token（C30、DN100、HRB400、Q235B、MU10、M7.5）——本身即完整值，不再拆数字 */
const GRADE_TOKEN_RE = /\b(?:C\d{2,3}|DN\d{1,4}|De\d{1,4}|HRB\d{3,4}|HPB\d{3,4}|Q\d{3}[A-Z]?|MU\d{1,3}|M\d{1,2}(?:\.\d)?|SN\d{1,2}|YJV?[-\d\w]*|BV\d?)\b/u;

export interface ParsedValue {
  attribute: string;
  value: string;
  unit?: string;
  relation: FactRelation;
}

/**
 * 从一条中文条款正文中解析出**所有**可绑定的事实（一条可能含多组）。
 *
 * 分割单位是**分句**（`。；;`）而不是整段：一句里通常只有一组主体-属性-值，
 * 跨句合并会把不同对象的值绑到同一个主体上（这正是"数值乱"的来源）。
 */
export function parseClauseFacts(text: string): ParsedValue[] {
  const results: ParsedValue[] = [];
  for (const sentence of text.split(/[。；;]/u).map(item => item.trim()).filter(Boolean)) {
    const grade = GRADE_TOKEN_RE.exec(sentence);
    if (grade) {
      const relation: FactRelation = RELATION_PATTERNS.find(pattern => pattern.re.test(sentence))?.relation ?? '=';
      // 牌号所在子句的主语：牌号前最后一个「的」之后、或句首到牌号之间
      const subject = sentence.slice(0, grade.index).replace(/^[，,、]|（|\(/gu, '').split(/[，,、]/u).pop()?.trim() || '';
      results.push({
        attribute: /DN|De/iu.test(grade[0]) ? '管径' : /^C\d|^M\d/iu.test(grade[0]) ? '强度等级' : '牌号',
        value: grade[0],
        relation,
        ...(subject ? {} : {}),
      });
      continue;
    }
    const range = RANGE_TOKEN_RE.exec(sentence);
    if (range) {
      const subject = subjectOf(sentence, range.index);
      results.push({
        attribute: attributeOf(sentence, subject),
        value: `${range[1]}~${range[2]}`,
        unit: range[3],
        relation: 'range',
      });
      continue;
    }
    const token = VALUE_TOKEN_RE.exec(sentence);
    if (!token) continue;
    const relation = RELATION_PATTERNS.find(pattern => pattern.re.test(sentence.slice(0, token.index + 1)))?.relation;
    if (!relation) continue; // 无模态词的裸数字不可绑定（统计数字、年份、序号都会落这里）
    const subject = subjectOf(sentence, token.index);
    results.push({ attribute: attributeOf(sentence, subject), value: token[1]!, unit: token[2], relation });
  }
  return results;
}

/** 主体：取数值前最近的一个名词短语（以标点/模态词为界） */
function subjectOf(sentence: string, valueIndex: number): string {
  const head = sentence.slice(0, valueIndex);
  const modalityIndex = Math.max(...RELATION_PATTERNS.map(pattern => {
    const match = pattern.re.exec(head);
    return match ? (match.index ?? -1) : -1;
  }));
  const cut = modalityIndex >= 0 ? head.slice(0, modalityIndex) : head;
  const parts = cut.split(/[，,、：:（）()]/u).map(item => item.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** 属性：主体短语里的中心词（厚度/宽度/高度/间距/标高/数量/……），无中心词时退化为「数值」 */
const ATTRIBUTE_HEADS: ReadonlyArray<[RegExp, string]> = [
  [/厚度|厚$/u, '厚度'],
  [/宽度|宽$/u, '宽度'],
  [/高度|高$/u, '高度'],
  [/间距|间隔/u, '间距'],
  [/埋深|深度|深$/u, '深度'],
  [/标高/u, '标高'],
  [/坡度|坡率/u, '坡度'],
  [/电阻/u, '电阻'],
  [/强度|等级/u, '强度等级'],
  [/压力/u, '压力'],
  [/温度/u, '温度'],
  [/含水率/u, '含水率'],
  [/压实度|压实系数/u, '压实度'],
  [/搭接|锚固/u, '搭接长度'],
  [/管径|口径/u, '管径'],
  [/数量|用量/u, '数量'],
  [/频率|转速/u, '频率'],
  [/养护|龄期/u, '养护期'],
  [/厚度偏差|偏差/u, '偏差'],
];

function attributeOf(sentence: string, subject: string): string {
  const window = `${subject}${sentence.slice(0, sentence.length)}`;
  for (const [pattern, label] of ATTRIBUTE_HEADS) if (pattern.test(subject) || pattern.test(window)) return label;
  return '数值';
}

// ─────────────────────────── 图纸实体 → DesignFact ───────────────────────────

/**
 * DIMENSION 实体 → 几何事实。
 *
 * **绑定**：尺寸值 ↔ 被标注两点（`origin1`/`origin2`）↔ 就近文字实体 ↔ 图层语义。
 * 对象名取「离尺寸线中点最近的同图层/同图框文字实体」——这是结构可判定的，
 * 因此**不需要猜**；取不到才算绑定失败并记账。
 */
/**
 * 尺寸值：**优先取显式测量值，缺失时由被标注两点距离导出**。
 *
 * 实测（全量重索引后的库）：504,002 个 CAD 实体里 60,704 个是 DIMENSION，其中
 * **60,676 个带着被标注两点、0 个带着组码 42**——DWG→DXF 转换不写 42（它本就是派生值）。
 * 于是"读不到测量值"看上去像数据缺失，其实是**我们把可以算的没算**。
 * DIMENSION 的语义就是两点间距离，几何就在实体里，导出是确定的、不需要猜。
 *
 * 导出值按图纸单位取整到 0.1（尺寸标注精度）；两点重合（`0`）视为无值。
 */
function dimensionValueOf(entity: CadEntity): number | undefined {
  const explicit = entity.dimension?.measurement;
  if (explicit !== undefined && Number.isFinite(explicit) && explicit !== 0) return explicit;
  const { origin1, origin2 } = entity.dimension ?? {};
  if (!origin1 || !origin2) return undefined;
  if (![origin1.x, origin1.y, origin2.x, origin2.y].every(value => typeof value === 'number' && Number.isFinite(value))) return undefined;
  const distance = Math.hypot(origin2.x! - origin1.x!, origin2.y! - origin1.y!);
  if (!(distance > 0)) return undefined;
  return Math.round(distance * 10) / 10;
}

export function dimensionFacts(input: {
  entities: CadEntity[];
  anchorOf: (entity: CadEntity) => SourceAnchor;
}): { facts: DesignFact[]; failures: BindingFailure[] } {
  const facts: DesignFact[] = [];
  const failures: BindingFailure[] = [];
  const namedEntities = input.entities.filter(entity => entity.entityType !== 'DIMENSION' && entity.text.trim().length > 0);
  for (const entity of input.entities) {
    if (entity.entityType !== 'DIMENSION') continue;
    const measurement = dimensionValueOf(entity);
    const value = entity.dimension?.textOverride?.trim() || (measurement !== undefined ? String(measurement) : '');
    const anchor = input.anchorOf(entity);
    if (!value) {
      /**
       * 无值尺寸（既无组码 42、又无被标注两点、也无显式文字）**必须记账**，不得静默跳过。
       *
       * 不变式 6：绑定失败是解析器缺陷的可观测信号——静默跳过会让「图纸里有 6 万个尺寸、
       * 只有 5 万个进了事实」这件事在任何报告里都看不见（真实语料矩阵实测抓到本处静默：
       * 37,137 个真实用例里有 30 条尺寸走了这条 continue，无任何留痕）。
       */
      failures.push({
        kind: 'dimension-without-subject',
        detail: `尺寸实体无可用值（无组码 42 / 无被标注两点 / 无显式文字），图层 ${anchor.layer ?? '无'}`,
        anchor,
      });
      continue;
    }
    const origin = entity.dimension?.origin1 ?? entity.dimension?.origin2;
    // 就近文字：同图框内、与该尺寸线位置距离最小者
    let nearest: CadEntity | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    if (Number.isFinite(entity.position.x) && Number.isFinite(entity.position.y)) {
      for (const candidate of namedEntities) {
        if (anchor.sheet && input.anchorOf(candidate).sheet !== anchor.sheet) continue;
        if (!Number.isFinite(candidate.position.x) || !Number.isFinite(candidate.position.y)) continue;
        const distance = Math.hypot(candidate.position.x! - entity.position.x!, candidate.position.y! - entity.position.y!);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = candidate;
        }
      }
    }
    if (!nearest) {
      failures.push({
        kind: 'dimension-without-subject',
        detail: `尺寸 ${value}（图层 ${anchor.layer ?? '无'}，图框 ${anchor.sheet ?? '无'}）找不到就近文字实体`,
        anchor,
      });
      continue;
    }
    const subject = nearest.text.replace(/\s+/gu, '').slice(0, 24);
    facts.push({
      id: factId(anchor, subject, '尺寸', value),
      subject,
      attribute: /标高/u.test(nearest.text + (anchor.layer ?? '')) ? '标高' : '尺寸',
      value,
      relation: '=',
      domain: /标高/u.test(nearest.text + (anchor.layer ?? '')) ? 'geometry' : 'geometry',
      carrier: 'drawing-annotation',
      anchor,
      key: factKey('geometry', subject, '尺寸'),
      ...(origin ? {} : {}),
    });
  }
  return { facts, failures };
}

/** 图纸标注文字 → 设计事实（主体即该文字自身所在语义单元；属性/值来自 parseClauseFacts） */
export function annotationFacts(input: {
  entities: CadEntity[];
  anchorOf: (entity: CadEntity) => SourceAnchor;
}): { facts: DesignFact[]; failures: BindingFailure[] } {
  const facts: DesignFact[] = [];
  const failures: BindingFailure[] = [];
  for (const entity of input.entities) {
    if (entity.entityType === 'DIMENSION') continue;
    if (!entity.text.trim()) continue;
    const anchor = input.anchorOf(entity);
    const carrier: AuthorityCarrier = anchor.layer && /说明|总说明|设计说明/u.test(anchor.layer) ? 'drawing-note' : 'drawing-annotation';
    const parsed = parseClauseFacts(entity.text);
    if (parsed.length === 0) continue; // 无值文本不产生事实（它是标题/图名/图例）
    for (const item of parsed) {
      const subject = (item.attribute === '数值' ? entity.text.trim().slice(0, 24) : subjectFromText(entity.text, item.value));
      if (!subject) {
        failures.push({ kind: 'value-without-attribute', detail: `标注「${entity.text.slice(0, 40)}」的 ${item.value} 找不到主体`, anchor });
        continue;
      }
      facts.push({
        id: factId(anchor, subject, item.attribute, item.value),
        subject,
        attribute: item.attribute,
        value: item.value,
        unit: item.unit,
        relation: item.relation,
        domain: inferDomain(carrier, item.attribute),
        carrier,
        anchor,
        key: factKey(inferDomain(carrier, item.attribute), subject, item.attribute),
      });
    }
  }
  return { facts, failures };
}

function subjectFromText(text: string, value: string): string {
  const index = text.indexOf(value);
  const head = index > 0 ? text.slice(0, index) : text;
  const parts = head.split(/[，,、：:（）()]/u).map(item => item.trim()).filter(Boolean);
  return (parts[parts.length - 1] ?? '').slice(0, 24);
}

/** 域推断：属性名 → 语义域（属性名是确定的，不需要猜） */
const ATTRIBUTE_DOMAIN: ReadonlyArray<[RegExp, FactDomain]> = [
  [/电阻|强度|压实度|耐火|照度|节能|传热|隔声/u, 'performance'],
  [/标高|坡度|间距|尺寸|埋深|深度|宽度|高度|位置|坐标/u, 'geometry'],
  [/管径|型号|规格|设备|流量|扬程|功率/u, 'equipment'],
  [/数量|工程量|面积|体积|长度|用量/u, 'quantity'],
  [/工期|地点|造价|金额|质量目标/u, 'caliber'],
];

function inferDomain(_carrier: AuthorityCarrier, attribute: string): FactDomain {
  for (const [pattern, domain] of ATTRIBUTE_DOMAIN) if (pattern.test(attribute)) return domain;
  // 属性名判定优先；只有「工程量」这一属性才落数量域。
  // 旧写法把清单载体的**所有**属性都归为 quantity，导致「土壤类别」这类项目特征
  // 事实被归入数量域 → 与工程量在同一个域里互比（跨域互比禁则被绕过）
  if (/工程量|数量|用量/u.test(attribute)) return 'quantity';
  return 'material';
}

// ─────────────────────────── 条款 → 义务 / 事实 ───────────────────────────

/** 义务载体（收件人是投标人的三种来源） */
const OBLIGATION_CARRIERS: ReadonlySet<AuthorityCarrier> = new Set(['tender-clause', 'clarification', 'evaluation-rule']);

/**
 * 条款块分流：**载体决定去向**。
 *
 * 这是「收件人判据」的落点——图纸设计说明的条款进 `DesignFact`，
 * 招标正文/答疑/评标办法的条款进 `BidObligation`。
 */
export function clauseToObjects(input: {
  clauses: ClauseBlock[];
  carrier: AuthorityCarrier;
  category?: string;
  anchorsOf?: (clause: ClauseBlock) => string[];
}): NormalizeResult {
  const facts: DesignFact[] = [];
  const obligations: BidObligation[] = [];
  const failures: BindingFailure[] = [];
  for (const clause of input.clauses) {
    // 不变式 5：无编号不产生条款对象（编号是切分层的产物，这里只做兜底记账）
    if (!clause.clauseNo) {
      failures.push({ kind: 'clause-without-number', detail: clause.body.slice(0, 60), anchor: clause.anchor });
      continue;
    }
    if (OBLIGATION_CARRIERS.has(input.carrier)) {
      obligations.push({
        id: `obl#${clause.anchor.filePath}#${clause.clauseNo}`,
        text: [clause.heading, clause.body].filter(Boolean).join(' ').replace(/\s*\n\s*/gu, ' ').trim(),
        clauseNo: clause.clauseNo,
        carrier: input.carrier as BidObligation['carrier'],
        category: input.category ?? '其他要求',
        anchors: input.anchorsOf?.(clause) ?? [],
        anchorSource: clause.anchor,
      });
      continue;
    }
    // 非义务载体（图纸设计说明等）：条款正文里的约束值 → 设计事实
    for (const item of parseClauseFacts(clause.body)) {
      const subject = subjectFromText(clause.body, item.value) || (clause.heading ?? '').slice(0, 24);
      if (!subject) {
        failures.push({ kind: 'value-without-attribute', detail: clause.body.slice(0, 60), anchor: clause.anchor });
        continue;
      }
      const domain = inferDomain(input.carrier, item.attribute);
      facts.push({
        id: factId(clause.anchor, subject, item.attribute, item.value),
        subject,
        attribute: item.attribute,
        value: item.value,
        unit: item.unit,
        relation: item.relation,
        domain,
        carrier: input.carrier,
        anchor: clause.anchor,
        key: factKey(domain, subject, item.attribute),
      });
    }
  }
  return { facts, obligations, failures };
}

// ─────────────────────────── 表格 → DesignFact ───────────────────────────

/**
 * 清单表 → 设计事实。
 *
 * 列角色由**表头语义**决定（`resolveTableColumnRoles`），不写死列序；
 * 「项目特征」单元格按 `1．… 2．…` 拆成属性键值对——这是清单里唯一的结构化事实来源，
 * 拍平成一行就再也取不出来（现行路径正是如此）。
 */
export function tableToFacts(input: { table: TableBlock; carrier: AuthorityCarrier; domain?: FactDomain }): NormalizeResult {
  const facts: DesignFact[] = [];
  const failures: BindingFailure[] = [];
  const roles = resolveTableColumnRoles(input.table.header);
  if (roles.name === undefined) {
    failures.push({ kind: 'row-without-role', detail: `表「${input.table.caption ?? input.table.sheet ?? '未命名'}」无「名称」列`, anchor: input.table.anchor });
    return { facts, obligations: [], failures };
  }
  input.table.rows.forEach((row, index) => {
    const subject = (row.cells[roles.name!] ?? '').trim();
    if (!subject) return;
    const anchor: SourceAnchor = { ...input.table.anchor, position: { ...input.table.anchor.position, row: row.rowNumber } };
    // ① 项目特征 → 逐条属性
    const feature = roles.feature !== undefined ? (row.cells[roles.feature] ?? '').trim() : '';
    for (const pair of feature ? parseFeatureCell(feature) : []) {
      const domain = inferDomain(input.carrier, pair.key);
      facts.push({
        id: factId(anchor, subject, pair.key, pair.value),
        subject,
        attribute: pair.key,
        value: pair.value,
        relation: 'text',
        domain,
        carrier: input.carrier,
        anchor,
        key: factKey(domain, subject, pair.key),
      });
    }
    // ② 工程量 → 数量事实
    if (roles.quantity !== undefined) {
      const raw = (row.cells[roles.quantity] ?? '').trim();
      const unit = roles.unit !== undefined ? (row.cells[roles.unit] ?? '').trim() : '';
      const numeric = /^([\d,]+(?:\.\d+)?)/u.exec(raw);
      if (numeric) {
        const value = numeric[1]!.replace(/,/gu, '');
        facts.push({
          id: factId(anchor, subject, '工程量', value),
          subject,
          attribute: '工程量',
          value,
          unit: unit || undefined,
          relation: '=',
          domain: 'quantity',
          carrier: input.carrier,
          anchor,
          key: factKey('quantity', subject, '工程量'),
        });
      }
    }
    if (facts.length === 0 && index === 0) {
      failures.push({ kind: 'row-without-role', detail: `表「${input.table.caption ?? ''}」行首条无法绑定列角色`, anchor });
    }
  });
  return { facts, obligations: [], failures };
}
