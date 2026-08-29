import type { ValidationIssue } from './types';

/**
 * 危大工程兜底适用性检测（C4）：危大清单此前只查"多处清单不一致"（dangerousListConsistencyIssues），
 * 不查"适用项遗漏"——正文已出现危大前提（基坑深度/脚手架高度/起重设备等）但辨识清单未列入即漏辨识。
 * 判定分层：L1 正则提取前提参数（确定性）→ L2 阈值比较（依据建办质〔2018〕31号常见门槛）→
 * L1 别名词面覆盖判定（辨识区 = 含"危大"关键词行前后 6 行的清单区段）。
 * 语义模型不参与判定（危大项名称是确定性封闭集，词面判定即零误伤）。
 */

const extractNumberNear = (body: string, pattern: RegExp): number | undefined => {
  const match = pattern.exec(body);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

/** 危大工程封闭集项：适用前提判定 + 辨识别名 */
const DANGEROUS_APPLICABLE_ITEMS = [
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
    applicable: (body: string) => /塔吊|塔式起重机|汽车吊|履带吊|吊车|起重机械|起重设备|起重机|卷扬机|物料提升机|提升机|电动葫芦|起重伤害|垂直运输|吊装/u.test(body),
  },
  {
    name: '吊篮作业工程',
    aliases: ['吊篮', '高处作业吊篮', '电动吊篮'],
    applicable: (body: string) => /吊篮/u.test(body),
  },
  {
    name: '拆除工程',
    aliases: ['拆除工程', '爆破拆除', '机械拆除'],
    applicable: (body: string) => /拆除工程|爆破拆除/u.test(body),
  },
] as const;

/** 危大辨识区：含"危大"关键词行前后各 6 行（清单式列举覆盖别名） */
function extractDangerZone(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  const zone: string[] = [];
  lines.forEach((line, index) => {
    if (/危大/u.test(line)) zone.push(...lines.slice(Math.max(0, index - 6), Math.min(lines.length, index + 7)));
  });
  return zone.join('\n');
}

export function dangerousApplicabilityIssues(markdown: string): ValidationIssue[] {
  // 适用性前提判定（确定性）：正文关键参数/设备词 → 危大项适用；无适用前提时静默跳过（不制造义务）
  const applicable = DANGEROUS_APPLICABLE_ITEMS.filter(item => item.applicable(markdown));
  if (applicable.length === 0) return [];
  // 辨识覆盖判定：危大辨识区内别名词面命中；正文从未出现"危大"字样 = 全部适用项漏辨识
  const dangerZone = extractDangerZone(markdown);
  if (!dangerZone) {
    return [{
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `正文出现危大工程适用前提（${applicable.map(item => item.name).join('、')}）但全文未编制危大工程辨识清单`,
      suggestion: '必须编制危大工程辨识清单：按建办质〔2018〕31号逐项辨识并标注分级，超过一定规模的专项施工方案需专家论证。',
    }];
  }
  const missing = applicable.filter(item => !item.aliases.some(alias => dangerZone.includes(alias)));
  if (missing.length === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `危大工程辨识清单遗漏适用项：${missing.map(item => item.name).join('、')}（正文已出现适用前提但辨识清单未列入）`,
    suggestion: '按建办质〔2018〕31号逐项辨识：将遗漏项补入危大工程辨识清单并标注分级，超过一定规模的专项施工方案需专家论证。',
  }];
}
