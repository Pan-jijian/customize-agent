/**
 * 修复轮次结果三档口径（4.55.27，用户实测归因）。
 *
 * ## 问题（实测：交付记录里"很多修复节点第一次就异常"）
 *
 * 原判定是二值的：`残留 === 0 ? 'success' : 'failed'`。于是把三件性质完全不同的事
 * 都标成同一个 `failed`：
 *
 * | 实测轨迹 | 实质 | 原状态 | 应有状态 |
 * |---|---|---|---|
 * | `17→0`、`6→0` | 一轮清零 | success | success |
 * | `105→54→42` | **净降 60%，收敛中**（有效工作，只是轮次用尽） | failed | **partial** |
 * | `63→62→62`、`1→1`、`2→2` | **零净下降**（模型未产生有效修改 → 真异常） | failed | failed |
 * | `篇幅压缩已回滚` | 保护性回滚（压缩后字数未下降/信息守恒未过） | failed | failed（附回滚原因） |
 *
 * 后果有两面：① 观感上满屏红点，把"收敛中"读成"修复坏了"；② **真正的零进展被淹没**，
 * 无从发现该修的引擎缺陷。故改为三档，并把"零净下降"的原因显性写进消息。
 */

export type RepairOutcomeStatus = 'success' | 'partial' | 'failed';

export interface RepairOutcomeInput {
  /** 首轮残留计数（无轨迹数据时省略） */
  before?: number;
  /** 末轮残留计数 */
  after: number;
  /** 本轮是否真的改动过正文（LLM 是否产出有效修改） */
  repaired?: boolean;
  /** 是否发生保护性回滚（改动被丢弃） */
  rolledBack?: boolean;
}

/** 修复轮次结果判定（单源）：清零=success；有净下降或确有改动=partial；零进展/回滚=failed */
export function repairOutcomeStatus(input: RepairOutcomeInput): RepairOutcomeStatus {
  if (input.after <= 0) return 'success';
  if (input.rolledBack) return 'failed';
  if (typeof input.before === 'number' && Number.isFinite(input.before)) {
    if (input.after < input.before) return 'partial';
    // 零净下降：模型这一轮没有产生有效修改 → 真异常（不是"收敛中"）
    return 'failed';
  }
  if (input.repaired) return 'partial';
  return 'failed';
}

/** 零进展/回滚时的原因短句（供消息尾部显性化，便于定位引擎缺陷） */
export function repairOutcomeReason(input: RepairOutcomeInput): string {
  if (input.after <= 0) return '';
  if (input.rolledBack) return '（已回滚：改动未通过守恒校验，保留修复前正文）';
  if (typeof input.before === 'number' && Number.isFinite(input.before) && input.after >= input.before) {
    return '（零净下降：本轮模型未产生有效修改——属引擎/定位问题，需排查）';
  }
  if (!input.repaired) return '（未产生有效修改，需排查）';
  return '';
}

/**
 * 4.55.30 章级显式降级（块失守、章照常成稿）的状态三档口径：复用修复轮同一套词汇，
 * 不再新增状态枚举——屏幕与交付记录里「降级」与「修复」是同一类语义（有损失但非零进展）。
 *
 * `plannedBlocks` 块里有 `droppedBlocks` 块失守（无正文）：
 * - 0 块失守 → success（全部成稿）；
 * - 0 < 失守 < 规划 → **partial**（黄灯：有净损失但章已产出，收敛性由后续补写/复核消费）；
 * - 失守 = 规划（无一块成稿）→ failed——该分支实际不可达（全失败在章生成层已章阻断，
 *   见 assessChapterBlockDegradation），保留定义只为「状态与事实一致」：真出现即红，
 *   不会把「无正文成章」伪装成黄灯。
 */
export function blockDeliveryOutcomeStatus(input: { plannedBlocks: number; droppedBlocks: number }): RepairOutcomeStatus {
  return repairOutcomeStatus({ before: input.plannedBlocks, after: input.droppedBlocks });
}
