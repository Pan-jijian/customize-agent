/**
 * 单一权威模型（4.61）：把散落的载体判定与优先级收敛到一处。
 *
 * ## 现状（勘查实测）
 *
 * 同一概念「载体优先级」在本仓有**三份互不相容的实现**：
 *
 * | # | 实现 | 判据 | 答疑 | 招标 | 图纸 | 兜底 |
 * |---|---|---|---|---|---|---|
 * | 1 | `authoritativeValues.sourcePriority(string)` | 来源字符串正则 | 96 | 90 | 75 | 70 |
 * | 2 | `factGovernance.factPriority(枚举)` | 来源类型枚举 | 96 | 85 | 70 | 10 |
 * | 3 | `factGovernance.sourceFilePriority(string, roleId)` | 另一组字符串正则 | 95 | 85 | 75 | 50 |
 *
 * 同一条资料在三个实现里档位不同 ⇒ **同一份数据在不同链路得到不同裁决**。
 * 本模块给出单一定义，三处改为委托（`legacyPriorityOf` 保留旧数值仅为迁移期对账）。
 *
 * ## 为什么按「域」而不是按「文件」
 *
 * 权威的单位是**事实的载体角色**，不是文件：同一份图纸里「设计说明」与「图签」权威不同；
 * 同一份清单里「工程量」与「项目特征」权威不同。「图纸大还是清单大」只有在给定语义域后才有答案。
 * 现行的**全局梯**（答疑 > 招标正文 > 清单 > 图纸）正是「套管 DN100 正文 55 个 vs 蓝图 18 个」
 * 这类跨域互比的成因：55 是清单工程量、18 是图纸规格，本就不该比。
 */
import type { AuthorityCarrier, FactDomain } from './types.js';
import { AUTHORITY_LATTICE, authorityRank } from './types.js';

/** 资料类型枚举（与 `MaterialKind` 同名同义；此处不 import 以保持 knowledge 包不依赖 apps/server） */
export type MaterialKindLike =
  | 'tender_document'
  | 'bill_of_quantities'
  | 'drawing'
  | 'addendum'
  | 'contract'
  | 'technical_specification'
  | 'schedule_document'
  | 'quality_safety_document'
  | 'other';

/**
 * 载体判定：**输入是资料类型（枚举）与文件内位置**，不是路径子串。
 *
 * 现行 `stageUnderstanding.ts:367` 用路径子串 `/招标|补疑|答疑|评标/` 选文件，于是
 * 「抗震支架电答疑修改0722/」这个**图纸目录**（名字里带"答疑"）下的整批 CAD 文本
 * 被当成答疑条款进了要求池——这是合工大 1076 条要求里大量不可响应条目的直接来源之一。
 * 类型枚举本来就在同一个对象上（`inferMaterialKind` 已算好），只是没被使用。
 */
export function resolveCarrier(input: {
  kind: MaterialKindLike | string;
  /** 文件内位置提示：图层名（DWG）、工作表名（XLS）、章节标题（PDF） */
  section?: string;
  /** 表头（XLS）：出现清单列名即为清单类载体 */
  header?: readonly string[];
}): AuthorityCarrier {
  const kind = String(input.kind || 'other');
  const section = input.section ?? '';
  const headerText = (input.header ?? []).join(' ');
  switch (kind) {
    case 'addendum':
      return 'clarification';
    case 'tender_document':
      return 'tender-clause';
    case 'bill_of_quantities':
      // 清单内部再分：工程量列存在 → 工程量载体；否则为项目特征载体
      return /工程量|数量/u.test(headerText) ? 'boq-quantity' : 'boq-feature';
    case 'drawing':
      // 图纸内部再分：设计说明图层/小节 → 设计说明；材料表 → 图纸材料表；其余为标注
      if (/说明|总说明|设计说明/u.test(section)) return 'drawing-note';
      if (/材料表|门窗表|设备表|表/u.test(section) && /表/u.test(section)) return 'drawing-schedule';
      return 'drawing-annotation';
    case 'technical_specification':
      return 'code';
    case 'schedule_document':
      return 'tender-clause';
    case 'quality_safety_document':
      return 'tender-clause';
    case 'contract':
      return 'tender-clause';
    default:
      // 未识别类型：按正文条款处理（保守——宁可多判为义务，也不把义务静默降级为事实）
      return 'tender-clause';
  }
}

/** 评标办法类载体的判定（评标办法是评分依据，载体角色与招标正文不同） */
export function refineEvaluationCarrier(carrier: AuthorityCarrier, section: string, text: string): AuthorityCarrier {
  if (carrier !== 'tender-clause') return carrier;
  if (/评标办法|评分办法|评分标准|评审因素|评标细则/u.test(`${section}${text.slice(0, 80)}`)) return 'evaluation-rule';
  return carrier;
}

/**
 * 来源**字符串** → 载体角色（仅用于只有路径/文件名的旧调用点）。
 *
 * 优先使用 `resolveCarrier`（有资料类型枚举时）：本函数是路径指纹回退，
 * 判据与旧 `sourcePriority` 的档位正则同源，但**只产出载体、不产出档位**——
 * 档位由 `carrierStrength(domain, carrier)` 按语义域给出。
 */
export function carrierOfSource(source: string, section = ''): AuthorityCarrier {
  const text = `${String(source || '')} ${section}`;
  if (/补遗|补疑|答疑|澄清|question/iu.test(text)) return 'clarification';
  if (/评标办法|评分办法|评分标准|评审因素|评标细则/u.test(text)) return 'evaluation-rule';
  if (/清单|bill|boq|xls|工程量/iu.test(text)) return /特征|描述/u.test(text) ? 'boq-feature' : 'boq-quantity';
  if (/图纸|dwg|dxf|施工图|cad/iu.test(text)) return /说明|总说明|设计说明/u.test(text) ? 'drawing-note' : 'drawing-annotation';
  if (/招标|投标须知|招标公告|合同/u.test(text)) return 'tender-clause';
  // 未识别：保守判为招标正文（与 resolveCarrier 的默认同向）
  return 'tender-clause';
}

/**
 * 事实的权威强度：**域内**排名（越小越权威），跨域不可比。
 *
 * `comparable = false` 表示两份事实不同域，**禁止互相裁决**（不变式 4）。
 */
export function compareAuthority(
  left: { domain: FactDomain; carrier: AuthorityCarrier },
  right: { domain: FactDomain; carrier: AuthorityCarrier },
): { comparable: boolean; winner?: 'left' | 'right' | 'tie'; leftRank: number; rightRank: number } {
  const leftRank = authorityRank(left.domain, left.carrier);
  const rightRank = authorityRank(right.domain, right.carrier);
  if (left.domain !== right.domain) return { comparable: false, leftRank, rightRank };
  if (!Number.isFinite(leftRank) || !Number.isFinite(rightRank)) return { comparable: false, leftRank, rightRank };
  if (leftRank === rightRank) return { comparable: true, winner: 'tie', leftRank, rightRank };
  return { comparable: true, winner: leftRank < rightRank ? 'left' : 'right', leftRank, rightRank };
}

/**
 * 单一载体优先级（**取代旧三套实现**）。
 *
 * ## 三套 → 一套
 *
 * | 旧实现 | 位置 | 答疑 | 招标 | 图纸 | 兜底 |
 * |---|---|---|---|---|---|
 * | `sourcePriority(string)` | 本包外 authoritativeValues | 96 | 90 | 75 | 70 |
 * | `factPriority(枚举)` | 本包外 factGovernance | 96 | 85 | 70 | 10 |
 * | `sourceFilePriority(file, roleId)` | 本包外 factGovernance | 95 | 85 | 75 | 50 |
 *
 * 三者对同一份资料给出不同档位 ⇒ 同一数据在不同链路得到不同裁决。现统一委托本函数。
 *
 * ## 域是必填（但有兼容默认）
 *
 * 脱离语义域，「谁更权威」没有正确答案：答疑在口径域压倒一切，图纸在设计参数域压倒一切。
 * 未传 `attribute` 的旧调用点默认按**契约口径域**（它们绝大多数在裁决工期/地点/质量目标这类
 * 口径值），因此**旧序（答疑 > 招标 > 清单 > 图纸）被完整保留**，行为不发生非预期漂移；
 * 传入 `attribute` 的调用点则得到域正确的裁决（如规格类属性下图纸 > 清单）。
 *
 * 返回值量纲与旧档位不同（本函数为 100 起、逐档 -10），**阈值型调用点（如 `>= 80` 判 locked）
 * 必须一并改用 `carrierStrength` 的语义重标定**，不得直接沿用旧阈值。
 */
/** 企业经验类来源（管理手册/公司文件）：**不是权威来源**（业务要求整体移除该档位），
 * 命中即给最低强度，不再作为独立权威等级与图纸/清单同台比较 */
const ENTERPRISE_SOURCE_RE = /企业|公司|管理手册/u;

export function sourcePriorityOf(source: string, attribute?: string, section = ''): number {
  if (ENTERPRISE_SOURCE_RE.test(String(source || ''))) return 0;
  const carrier = carrierOfSource(source, section);
  const domain = attribute ? domainOfAttribute(attribute) : 'caliber';
  const strength = carrierStrength(domain, carrier);
  // 域内必含全部载体（权威格是全域排列），故不会走到兜底；保留防御分支
  return strength >= 0 ? strength : 70;
}

/** 迁移期对账：旧档位数值（答疑 96 / 招标 90 / 清单 80 / 图纸 75 / 其他 70）。
 * 只用于**回归对照**（验证改写前后裁决顺序一致），新链路一律走 `sourcePriorityOf` / `compareAuthority`。 */
export function legacyPriorityOf(source: string): number {
  const text = String(source || '');
  if (/补遗|补疑|答疑|澄清|question/iu.test(text)) return 96;
  if (/招标|投标须知|招标公告/u.test(text)) return 90;
  if (/清单|bill|boq|xls/iu.test(text)) return 80;
  if (/图纸|dwg|施工图|设计说明/iu.test(text)) return 75;
  return 70;
}

/** 域的权威序可读渲染（报告与诊断用；顺序即权威强度递减） */
export function describeLattice(domain: FactDomain): string {
  return AUTHORITY_LATTICE[domain].join(' > ');
}

// ─────────────────────────── 属性 → 域（合并旧三套优先级的钥匙） ───────────────────────────

/**
 * 属性名 → 语义域。
 *
 * **为什么合并三套优先级必须先有这个**：脱离语义域，「谁更权威」没有正确答案——
 * 答疑在口径域压倒一切，图纸在设计参数域压倒一切，清单在工程量域压倒一切。
 * 旧的三套实现各自用来源字符串/枚举直接给一个数字，**等于把「域」这个必要参数硬编码掉了**，
 * 于是同一份资料在不同链路得到不同裁决（答疑 96/96/95、招标 90/85/85、图纸 75/70/75）。
 *
 * 本函数把域从属性名恢复出来（属性名是确定的，不需要猜），三套实现据此委托同一个权威格。
 */
const ATTRIBUTE_DOMAIN_PATTERNS: ReadonlyArray<[RegExp, FactDomain]> = [
  // 契约口径：工期/地点/质量目标/计价规则/责任划分
  [/工期|日历天|开工|竣工|节点|地点|地址|质量标准|质量目标|造价|金额|限价|报价|结算|付款|保证金|投标报价/u, 'caliber'],
  // 工程量
  [/工程量|数量|面积|体积|长度|用量|台数|人数|根数|套数|座数/u, 'quantity'],
  // 性能指标
  [/强度|等级|电阻|耐火|照度|节能|传热|隔声|压实度|承载力|抗渗|坍落度|含水率|坡度|压力|扬程|流量|功率/u, 'performance'],
  // 几何空间
  [/标高|埋深|深度|厚度|宽度|高度|间距|尺寸|位置|坐标|轴线|偏差|长度/u, 'geometry'],
  // 设备与系统
  [/型号|规格|管径|口径|参数|设备|系统|容量|配置/u, 'equipment'],
];

/** 属性缺失时的默认域：**契约口径**——兼容默认，与旧全局梯同序（答疑 > 招标 > 清单 > 图纸），
 * 使未改造的旧调用点不发生非预期漂移。新调用点应尽量传属性。 */
export function domainForAttribute(attribute?: string): FactDomain {
  return attribute ? domainOfAttribute(attribute) : 'caliber';
}

export function domainOfAttribute(attribute: string): FactDomain {
  const text = String(attribute || '');
  for (const [pattern, domain] of ATTRIBUTE_DOMAIN_PATTERNS) if (pattern.test(text)) return domain;
  return 'material';
}

/**
 * 载体强度（**必须带域**；值越大越权威）。
 *
 * 单一权威强度入口——旧三套 `sourcePriority` / `factPriority` / `sourceFilePriority`
 * 一律改为委托本函数（各自补齐域参数），从此同一份资料在任何链路得到同一裁决。
 *
 * 未登记在该域序列中的载体返回 -1（不参与该域裁决），与 `authorityRank` 的 Infinity 同义。
 */
export function carrierStrength(domain: FactDomain, carrier: AuthorityCarrier): number {
  const rank = authorityRank(domain, carrier);
  if (!Number.isFinite(rank)) return -1;
  // 序内位置 → 强度：首位 100，逐位递减 10（留出稳定的比较间隔，便于跨域无关的阈值判断）
  return 100 - rank * 10;
}

/** 域内两载体的强弱比较（`>0` 左强，`<0` 右强，`0` 同档，`null` 不可比） */
export function compareCarrierStrength(domain: FactDomain, left: AuthorityCarrier, right: AuthorityCarrier): number | null {
  const leftStrength = carrierStrength(domain, left);
  const rightStrength = carrierStrength(domain, right);
  if (leftStrength < 0 || rightStrength < 0) return null;
  return leftStrength - rightStrength;
}
