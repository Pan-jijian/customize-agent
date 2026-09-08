/**
 * 边界测试矩阵框架（P1）
 * 目标：把 document-workflow 规则密集函数的边界空间系统枚举为独立用例。
 * 原则：
 *  - 每条用例必须有独立断言意义（维度值不同 → 断言期望不同），不做同断言重复跑；
 *  - 用例由数据表 + 工厂函数在运行时展开（vitest it.each 计数为独立测试）；
 *  - 属性测试用确定性 PRNG（同种子可复现），不引入新依赖。
 */
import type { DocumentFact, DocumentFactsModel, ValidationIssue } from '@/services/document-workflow/types';

// ── 确定性 PRNG（mulberry32）：属性/采样测试可复现 ──
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成 seed 固定的 N 个样本（每条样本对应一条独立用例） */
export function seededSamples<T>(seed: number, count: number, gen: (rand: () => number) => T): T[] {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, () => gen(rand));
}

/** 笛卡尔积展开：[[a,b],[1,2]] → [[a,1],[a,2],[b,1],[b,2]] */
export function product<T>(...dims: T[][]): T[][] {
  return dims.reduce<T[][]>(
    (acc, dim) => acc.flatMap(prefix => dim.map(value => [...prefix, value])),
    [[]],
  );
}

// ── 维度值表（各检测器共用）──

/** 数值字符串格式变体（工程文档中真实出现的写法谱系） */
export const NUMERIC_FORMATS = [
  '1', '1.0', '1.00', '0.5', '0.05', '10', '99', '999', '1000', '1,000',
  '10,000', '10000.5', '1234.567', '0001', '010', '1e3', '3.0', '12,345,678',
] as const;

/** 单位组：同一物理口径的不同写法 */
export const UNIT_GROUPS: Record<string, string[]> = {
  area: ['m²', '㎡', 'm2', 'M2'],
  volume: ['m³', 'm3', 'M3'],
  weight: ['t', '吨', 'T'],
  length: ['m', 'M'],
  count: ['座', '套', '台', '个', '项', '处', '樘', '株', '系统'],
};

/** 括号三态：半角/全角/缺省（工程清单名称与正文写法互配） */
export function parenStates(name: string): string[] {
  if (!name.includes('(')) return [name];
  const full = name.replace(/[(]/u, '（').replace(/[)]/u, '）');
  const none = name.replace(/\(.*?\)/u, '');
  return [...new Set([name, full, none])];
}

/** 否定/豁免引导词（检测器普遍需要跳过否定声明句） */
export const NEGATION_PREFIXES = ['无', '未', '不', '非', '免', '禁止', '不得', '无需'] as const;

/** 村名/分村语境特征词（分村分表量豁免）——D2 收紧后窗口词表：
 * 剔除「组/集/村/段/栋/楼/分/区」宽泛单字（「本分项工程量为…」的「分」误伤总口径真实冲突），
 * 新增「井」覆盖公厕分部语境（砌筑检查井2座、塑料管铺设7.8m 分村分表合法量） */
export const VILLAGE_WORDS = ['郢', '庄', '岗', '塘', '圩', '坝', '池', '井'] as const;

/** D2 收紧剔除的宽泛单字（12 字窗口内不再豁免，反向矩阵验证确定性修复） */
export const VILLAGE_WORDS_REMOVED = ['组', '集', '村', '段', '栋', '楼', '分', '区'] as const;

/** 规格限定词（分规格量豁免） */
export const SPEC_WORDS = ['直径450', '直径630', 'DN200', 'DN110', 'Φ16', 'φ10'] as const;

/** 列举分隔符（条目序列边界） */
export const LIST_SEPARATORS = ['、', '，', '；', '\n'] as const;

// ── Markdown 语境模板（同一内容在不同语境下的宿主形态）──

/** 把「名称+数值+单位」片段嵌入不同 Markdown 语境 */
export function contextTemplates(name: string, value: string, unit: string): Record<string, string> {
  return {
    prose: `${name}${value}${unit}。`,
    proseList: `主要工程量包括${name}${value}${unit}、其他条目10m。`,
    proseListPrev: `主要工程量包括其他条目10m、${name}${value}${unit}。`,
    tableRow: `| 分部 | ${name} | ${unit} | ${value} | 备注 |`,
    tableRowPrevUnit: `| 分部 | ${name} | ${unit} | ${value} |`,
    headingH4: `#### ${name}\n${name}${value}${unit}。`,
    headingH3: `### 2.1 ${name}\n${name}${value}${unit}。`,
    boldLead: `**${name}**：${value}${unit}。`,
    village: `马老郢村${name}${value}${unit}。`,
    specPrefix: `直径450${name}${value}${unit}。`,
    specSuffix: `${name}DN200铺设${value}${unit}。`,
    negation: `本项目${name}无${value}${unit}。`,
  } as const;
}

// ── 用例工厂与断言辅助 ──

export interface CaseRow {
  /** 用例名（会拼入维度标签） */
  label: string;
  [key: string]: unknown;
}

/** 把数据行转为 vitest it.each 需要的 [名称, ...args] 形式 */
export function toEachTable<I extends CaseRow>(rows: I[]): Array<[string, I]> {
  return rows.map(row => [row.label, row]);
}

/** 命名：维度键值拼入用例名，保证失败时可直接定位组合 */
export function caseName(prefix: string, dims: Record<string, string>): string {
  const tail = Object.entries(dims).map(([k, v]) => `${k}=${v}`).join(' ');
  return `${prefix} ${tail}`;
}

/** 断言辅助：issues 中存在满足全部谓词的条目 */
export function expectIssue(issues: ValidationIssue[], pred: { message?: RegExp; suggestion?: RegExp; severity?: string }): boolean {
  return issues.some(issue =>
    (pred.message === undefined || pred.message.test(issue.message)) &&
    (pred.suggestion === undefined || pred.suggestion.test(issue.suggestion ?? '')) &&
    (pred.severity === undefined || issue.severity === pred.severity));
}

/** 全半角互转（标点谱系枚举用） */
export function halfWidth(s: string): string {
  return s.replace(/，/gu, ',').replace(/、/gu, '、').replace(/；/gu, ';').replace(/：/gu, ':').replace(/（/gu, '(').replace(/）/gu, ')');
}

// ── 事实模型工厂（factsModel 驱动检测器共用）──

/** 构造完整 DocumentFact（补齐非关键字段） */
export function factOf(f: { key?: string; fieldName?: string; value: string }): DocumentFact {
  return { key: '', fieldName: '', sourceFile: '', roleId: '', confidence: 0, ...f };
}

/** 裁剪版 factsModel 快速构造：必填数组补空默认（类型契约全数组必填，缺数组展开会崩），
 *  仅覆盖用例涉及的槽位，不编造任何业务数据 */
export function factsOf(partial: Partial<DocumentFactsModel>): DocumentFactsModel {
  return {
    project: [], schedule: [], quality: [], safety: [], resources: [],
    tables: [], drawings: [], bills: [], preciseFacts: [], rules: [],
    specifications: [], schemaFacts: {}, factIndex: {} as DocumentFactsModel['factIndex'],
    missing: [], conflicts: [],
    ...partial,
  };
}
