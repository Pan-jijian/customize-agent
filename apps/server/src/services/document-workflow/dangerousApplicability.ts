import type { ValidationIssue } from './types';

/**
 * 危大工程兜底适用性检测（C4）：危大清单此前只查"多处清单不一致"（dangerousListConsistencyIssues），
 * 不查"适用项遗漏"——正文已出现危大前提（基坑深度/脚手架高度/起重设备等）但辨识清单未列入即漏辨识。
 * 判定分层：L1 正则提取前提参数（确定性）→ L2 阈值比较（依据建办质〔2018〕31号常见门槛）→
 * L1 别名词面覆盖判定（辨识区 = 含"危大"关键词行前后 6 行的清单区段）。
 * 语义模型不参与判定（危大项名称是确定性封闭集，词面判定即零误伤）。
 * r28j：gaps 结构与 uncoveredDangerousItems 导出供修复轮 stageDangerousApplicabilityRepair 同源复用
 *（检测定位=修复定位；s28i 连续两轮「拆除工程」漏列直坠门禁为修复轮落位归因）。
 */

const extractNumberNear = (body: string, pattern: RegExp): number | undefined => {
  const match = pattern.exec(body);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

/** 负向危大宣称判定（r11 丰乐镇门禁 #7 归因）：正文以判定标准为依据宣称「不涉及危大工程」时，
 * 作业形态弱词（吊装/起重伤害/垂直运输）不构成适用前提——否则「化粪池吊装就位」「管材吊装打击」
 * 等常规吊运描述会与排除声明并存，判出清单遗漏。硬设备名（塔吊/汽车吊/履带吊/卷扬机等非常规起重
 * 设备）不受本豁免约束——设备在册即真实适用前提，与 hazard-exclusion-contradiction 检测器互补。 */
function declaresNoDangerousWork(body: string): boolean {
  // eslint-disable-next-line no-control-regex -- [^\u000A] 与原始 [^\n] 语义等价（编辑工具会破坏字面换行转义，改用 unicode 转义）
  return /(?:不涉及|不存在|不属于|未涉及)[^。；\u000A]{0,16}危大|(?:不涉及|不存在|不属于|未涉及)[^。；\u000A]{0,16}危险性较大|(?:参数|高度|深度)[^。；\u000A]{0,12}未达[^。；\u000A]{0,60}危大/u.test(body);
}

/** 危大工程封闭集项：适用前提判定 + 辨识别名（检测器 dangerousApplicabilityIssues 与修复轮
 * stageDangerousApplicabilityRepair 同源消费；4.41 确定性补写器删除后由 LLM 修复轮定向补列） */
export const DANGEROUS_APPLICABLE_ITEMS = [
  {
    name: '基坑支护与降水工程',
    aliases: ['基坑支护', '基坑工程', '降排水', '降水井'],
    applicable: (body: string) => {
      const depth = extractNumberNear(body, /(?:基坑)?开挖深度[约为达至]{0,3}(\d+(?:\.\d+)?)\s*m/u);
      return depth !== undefined && depth >= 3;
    },
  },
  {
    name: '高大模板支撑工程',
    aliases: ['高大模板', '高支模', '模板支撑体系', '模板支撑'],
    applicable: (body: string) => {
      const height = extractNumberNear(body, /(?:模板)?支撑(?:体系)?(?:搭设)?高度[约为达至]{0,3}(\d+(?:\.\d+)?)\s*m/u);
      const load = extractNumberNear(body, /(?:施工(?:总)?荷载|集中线荷载)[约为达至]{0,3}(\d+(?:\.\d+)?)\s*kN/u);
      return (height !== undefined && height >= 8) || (load !== undefined && load >= 10) || /高支模|高大模板/u.test(body);
    },
  },
  {
    name: '脚手架工程',
    aliases: ['脚手架', '落地式钢管脚手架', '悬挑式脚手架', '悬挑脚手架'],
    applicable: (body: string) => {
      const height = extractNumberNear(body, /(?:落地式|悬挑式)?(?:钢管)?脚手架(?:搭设)?高度[约为达至]{0,3}(\d+(?:\.\d+)?)\s*m/u);
      return (height !== undefined && height >= 15) || /悬挑(?:式)?脚手架/u.test(body);
    },
  },
  {
    name: '起重吊装及安装拆卸工程',
    // 适用前提词与辨识别名必须覆盖封闭集全貌：真实生成缺陷（徽光阁）正文写“材料垂直运输涉及的起重伤害”
    // 而旧词表只收设备名（塔吊/塔式起重机/汽车吊/履带吊/吊车/起重机械），“起重伤害/垂直运输/提升机”
    // 等作业形态词面永不命中 → 适用项漏辨识不被检出。补全为设备名+作业形态词双覆盖。
    aliases: ['起重吊装', '塔吊', '塔式起重机', '汽车吊', '履带吊', '起重机械安拆', '物料提升机', '提升机', '起重机械', '吊装'],
    // r11 豁免分层（丰乐镇门禁 #7 归因）：作业形态词（起重伤害/垂直运输/吊装）是普通工序描述的常用词——
    // 「化粪池吊装就位」「管材吊装打击」「人工配合机械下管」等常规吊运不构成非常规起重设备适用前提；
    // 正文明确宣称「不涉及危大工程/参数未达判定标准」时弱词不再判适用（硬设备名保留——见 declaresNoDangerousWork）
    // r24 B7 收窄（实机归因）：「垂直运输/吊装」仍为普通工序高频词（实测 4 处均为化粪池/灯杆常规吊运，
    // 零硬设备词）误触发适用前提——词表删去裸「垂直运输/吊装」，改为「起重伤害 | 非常规起重 | 起吊重量 |
    // 吊装重量 | 吊装荷载」有向前提：伤害形态名与非常规起重量纲词才是真实适用证据，普通吊运静默
    applicable: (body: string) => {
      if (/塔吊|塔式起重机|汽车吊|履带吊|吊车|起重机械|起重设备|起重机|卷扬机|物料提升机|提升机|电动葫芦/u.test(body)) return true;
      return /起重伤害|非常规起重|起吊重量|吊装重量|吊装荷载/u.test(body) && !declaresNoDangerousWork(body);
    },
  },
  {
    name: '吊篮作业工程',
    aliases: ['吊篮', '高处作业吊篮', '电动吊篮'],
    applicable: (body: string) => /吊篮/u.test(body),
  },
  {
    name: '拆除工程',
    aliases: ['拆除工程', '爆破拆除', '机械拆除'],
    // r11 修正（丰乐镇门禁 #7 归因）：「拆除工程量按现场实测范围控制」中「拆除工程」四字与量词
    // 粘连误命中——加负向断言 (?![量])，工程量口径描述不再判「拆除工程」适用
    applicable: (body: string) => /拆除工程(?![量])|爆破拆除/u.test(body),
  },
] as const;

/** 危大辨识区：含"危大"关键词行前后各 6 行（清单式列举覆盖别名；导出供修复器同源复用） */
export function extractDangerZone(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  const zone: string[] = [];
  lines.forEach((line, index) => {
    if (/危大/u.test(line)) zone.push(...lines.slice(Math.max(0, index - 6), Math.min(lines.length, index + 7)));
  });
  return zone.join('\n');
}

/** 危大适用性缺口（r28j 检测器与修复轮同源单源）：applicableNames=全文适用前提命中项名；
 * zonePresent=全文是否存在危大辨识区（含「危大」行）；missingNames=辨识区未覆盖别名的项名。
 * 修复轮 stageDangerousApplicabilityRepair 消费本结构与 uncoveredDangerousItems（检测定位=修复定位）。 */
export interface DangerousApplicabilityGaps {
  applicableNames: string[];
  zonePresent: boolean;
  missingNames: string[];
}

export function dangerousApplicabilityGaps(markdown: string): DangerousApplicabilityGaps {
  const applicable = DANGEROUS_APPLICABLE_ITEMS.filter(item => item.applicable(markdown));
  const dangerZone = extractDangerZone(markdown);
  return {
    applicableNames: applicable.map(item => item.name),
    zonePresent: dangerZone !== '',
    missingNames: dangerZone === ''
      ? applicable.map(item => item.name)
      : applicable.filter(item => !item.aliases.some(alias => dangerZone.includes(alias))).map(item => item.name),
  };
}

/** 指定项名集合在文本危大辨识区中未覆盖的项（修复轮复检单源：补列条目必须落回 extractDangerZone 覆盖范围） */
export function uncoveredDangerousItems(markdown: string, names: readonly string[]): string[] {
  const dangerZone = extractDangerZone(markdown);
  return names.filter(name => {
    const item = DANGEROUS_APPLICABLE_ITEMS.find(entry => entry.name === name);
    return !!item && !item.aliases.some(alias => dangerZone.includes(alias));
  });
}

export function dangerousApplicabilityIssues(markdown: string): ValidationIssue[] {
  // 适用性前提判定（确定性）：正文关键参数/设备词 → 危大项适用；无适用前提时静默跳过（不制造义务）
  const gaps = dangerousApplicabilityGaps(markdown);
  if (gaps.applicableNames.length === 0) return [];
  // 辨识覆盖判定：危大辨识区内别名词面命中；正文从未出现"危大"字样 = 全部适用项漏辨识
  if (!gaps.zonePresent) {
    return [{
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `正文出现危大工程适用前提（${gaps.applicableNames.join('、')}）但全文未编制危大工程辨识清单`,
      suggestion: '必须编制危大工程辨识清单：按建办质〔2018〕31号逐项辨识并标注分级，超过一定规模的专项施工方案需专家论证。',
    }];
  }
  if (gaps.missingNames.length === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `危大工程辨识清单遗漏适用项：${gaps.missingNames.join('、')}（正文已出现适用前提但辨识清单未列入）`,
    suggestion: '按建办质〔2018〕31号逐项辨识：将遗漏项补入危大工程辨识清单并标注分级，超过一定规模的专项施工方案需专家论证。',
  }];
}
