/**
 * 提取型权威改写的统一前置闸门（4.55.26）。
 *
 * ## 为什么需要（系统性归因，不是逐例打补丁）
 *
 * 全仓会改写正文数值/规格的路径按**权威来源**只有两类：
 *
 * | 类别 | 权威来源 | 例（实测） | 判定 |
 * |---|---|---|---|
 * | **A 显式声明** | 招标/答疑句式声明、法规文号错字、结构类去重 | `22303.66万元→157166591.34元`、`365→330`、`第279订→第279号` | 可自证，安全 |
 * | **B 提取推断** | 清单条目规格、资料层厚、表格唯一值、蓝图推导 | `垫层 180mm→100mm`、`铝合金幕墙窗 26mm→2.2mm` | **错一次就把对的全改错** |
 *
 * B 类的共同缺口是**对象限定缺失**——用裸部位词（「垫层」「地面」「幕墙窗」）去匹配权威，
 * 而裸部位词**不能证明正文那一处说的就是权威所属的那个对象**：
 * · 清单「垫层」权威 100mm（基础垫层），正文的 180/150/120mm 属**其它对象**的垫层 → 被统一成 100mm；
 * · 清单「铝合金幕墙窗」条目的规格集里含「暖边隔热条 2.2mm 宽」（子项特征）→ 正文 26mm（窗的规格）
 *   被改成 2.2mm（隔热条宽度）——**把子项参数当成了主规格**。
 *
 * ## 闸门（B 类四条路径共用，单点实现）
 *
 * ① **对象限定**：权威所属条目名必须出现在正文命中处（裸部位词不足以成立）；
 * ② **同量级**：数值型差异比值 ≤5（跨量级说明不是同一量，如 26mm vs 2.2mm 差 11.8 倍）；
 * ③ **异义语境**：命中处邻近出现「隔热条/缝/间距/偏差/范围」等**其它属性词**时不做替换
 *    （该处讨论的不是本规格）；
 * ④ **形态合法**：强度等级须落在 C15~C80、字母紧邻的 token（`PHC400`）不算独立规格。
 *
 * 不通过的处置：**保留检测/报告，但不改写正文**——机器不得在多套口径里盲选一套写入
 *（与 fixers.ts 既有原则一致：「宁缺毋假」）。这样既不制造错值，也不掩盖真实冲突。
 */
import { isLegalConcreteGradeToken } from './factsModel';

/** 数值差异的量级上限：比值超过它即认为"不是同一个量"，不改写 */
export const AUTHORITY_REWRITE_MAX_MAGNITUDE_RATIO = 5;

/** 异义属性词：命中处邻近出现时，该数值属**别的属性**（宽度/间距/偏差…），不是本规格 */
const FOREIGN_ATTRIBUTE_NEAR_RE = /(?:隔热条|胶条|缝|间距|中心距|净距|排距|偏差|误差|不超过|不大于|不小于|范围|工作面|余量|搭接)/u;

/** 通用部位词（自身不构成对象标识；必须带限定语才能定位，如「基础垫层」「地坪垫层」） */
const GENERIC_BODY_PART_RE = /^(?:垫层|地面|楼面|地面|墙面|屋面|顶棚|天棚|基础|基层|面层|找平层|防水层|保温层|梁|板|柱|墙|门|窗|管道|检查井|路面|道路|散水|台阶|栏杆|扶手)$/u;

function numericPart(value: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)/u.exec(String(value || ''));
  if (!match) return undefined;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

export interface AuthorityRewriteContext {
  /** 权威所属条目名/部位名（清单条目名，如「基础垫层」；缺省表示权威无对象限定 → 直接不许改写） */
  authorityOwner?: string;
  /** 正文命中处的部位词（如「垫层」） */
  bodyLocation: string;
  /** 正文命中处的上下文窗口（部位词 ± 命中值附近） */
  bodyWindow: string;
  /** 正文现有值 */
  found: string;
  /** 权威值 */
  authority: string;
}

export interface AuthorityRewriteVerdict {
  allowed: boolean;
  reason?: string;
}

/** B 类改写统一闸门：返回是否允许改写（不通过时保留检测、不改正文） */
export function authorityRewriteVerdict(ctx: AuthorityRewriteContext): AuthorityRewriteVerdict {
  const owner = String(ctx.authorityOwner || '').trim();
  const location = String(ctx.bodyLocation || '').trim();
  const window = String(ctx.bodyWindow || '');
  // ④ 形态合法（强度等级等）：非法权威值不得改写
  if (!isLegalConcreteGradeToken(ctx.authority)) return { allowed: false, reason: '权威值形态非法（非独立规格 token 或超值域）' };
  if (!isLegalConcreteGradeToken(ctx.found)) return { allowed: false, reason: '正文值形态非法（如桩型号内字母紧邻的伪 token）' };
  // ① 对象限定：权威所属条目名必须出现在正文命中处；无 owner 时用 bodyLocation 兜底比对
  const ownerLabel = owner || location;
  if (ownerLabel && ownerLabel !== location && !window.includes(ownerLabel)) {
    return { allowed: false, reason: `正文命中处未出现权威条目名「${ownerLabel}」（裸部位词「${location}」不足以证明同一对象）` };
  }
  // ③ 异义语境：邻近出现别的属性词 → 该数值不是本规格
  if (FOREIGN_ATTRIBUTE_NEAR_RE.test(window)) {
    return { allowed: false, reason: '命中处邻近出现其它属性词（宽度/间距/偏差/隔热条…），该数值不属本规格' };
  }
  // ⑤ 权威标识充分性：通用部位词（垫层/地面/墙面…）本身无法定位具体对象——
  // 实测：清单条目名「垫层」权威 100mm（基础垫层），正文里地坪/管道处写的 180/150/120mm 被统一成 100mm。
  if (GENERIC_BODY_PART_RE.test(ownerLabel.replace(/[（(].*$/u, '').trim())) {
    return { allowed: false, reason: `权威标识「${ownerLabel}」为通用部位词，不足以定位具体对象，不做机器改写（保留检测）` };
  }
  // ② 同量级
  const foundNumber = numericPart(ctx.found);
  const authorityNumber = numericPart(ctx.authority);
  if (foundNumber !== undefined && authorityNumber !== undefined) {
    const ratio = Math.max(foundNumber, authorityNumber) / Math.min(foundNumber, authorityNumber);
    if (ratio > AUTHORITY_REWRITE_MAX_MAGNITUDE_RATIO) {
      return { allowed: false, reason: `跨量级差异（${ctx.found} vs ${ctx.authority}，${ratio.toFixed(1)} 倍）不是同一量，不做机器改写` };
    }
  }
  return { allowed: true };
}
