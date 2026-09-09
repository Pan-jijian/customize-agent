/**
 * 调优配置单入口（治理收敛 · 第 1 期 · C 类开关合并）：
 * 原 23 个并发/预算族 DOCUMENT_* 开关统一收敛为 tuningProfile，由 DOCUMENT_TUNING_PROFILE（JSON）单入口覆盖。
 * 未配置字段返回 undefined，调用方沿用原默认值表达式，行为完全保持。
 * 缓存按原始 env 字符串比较失效——测试中动态设置 DOCUMENT_TUNING_PROFILE 仍即时生效。
 */

export interface TuningProfile {
  // 并发族
  chapterConcurrency?: number;
  sectionConcurrency?: number;
  sectionGroupConcurrency?: number;
  sectionGroupSize?: number;
  sectionGroupTaskConcurrency?: number;
  plannedBlockConcurrency?: number;
  tableFixConcurrency?: number;
  llmMaxConcurrency?: number;
  writingTaskConcurrency?: number;
  projectGraphDomainConcurrency?: number;
  // 预算族
  writingTaskMaxWords?: number;
  blockEvidenceChars?: number;
  chapterPoolChars?: number;
  evidenceBudgetRatio?: number;
  evidenceBudgetCeiling?: number;
  evidenceCatalogMaxLines?: number;
  factCoverageCap?: number;
  factExtractionMaxChars?: number;
  factExtractionMaxItems?: number;
  outlineEvidenceChars?: number;
  persistEvidenceMaxItems?: number;
  persistEvidenceItemChars?: number;
  repairEvidenceChars?: number;
}

/** DOCUMENT_TUNING_PROFILE 可覆盖的全部字段（与 TuningProfile 键一一对应，防拼写错误静默失效） */
const TUNING_PROFILE_KEYS: readonly (keyof TuningProfile)[] = [
  'chapterConcurrency', 'sectionConcurrency', 'sectionGroupConcurrency', 'sectionGroupSize',
  'sectionGroupTaskConcurrency', 'plannedBlockConcurrency', 'tableFixConcurrency', 'llmMaxConcurrency',
  'writingTaskConcurrency', 'projectGraphDomainConcurrency', 'writingTaskMaxWords', 'blockEvidenceChars',
  'chapterPoolChars', 'evidenceBudgetRatio', 'evidenceBudgetCeiling', 'evidenceCatalogMaxLines',
  'factCoverageCap', 'factExtractionMaxChars', 'factExtractionMaxItems', 'outlineEvidenceChars',
  'persistEvidenceMaxItems', 'persistEvidenceItemChars', 'repairEvidenceChars',
];

let profileCache: { raw: string | undefined; parsed: TuningProfile } | undefined;

/** 读取调优配置（JSON 解析失败按全默认处理，仅告警一次） */
export function tuningProfile(): TuningProfile {
  const raw = process.env.DOCUMENT_TUNING_PROFILE;
  if (profileCache && profileCache.raw === raw) return profileCache.parsed;
  const parsed: TuningProfile = {};
  if (raw) {
    try {
      const json = JSON.parse(raw) as Record<string, unknown>;
      for (const key of TUNING_PROFILE_KEYS) {
        const value = json[key];
        if (typeof value === 'number') parsed[key] = value;
        else if (typeof value === 'string' && value.trim() !== '') {
          const numeric = Number(value);
          if (Number.isFinite(numeric)) parsed[key] = numeric;
        }
      }
    } catch (error) {
      console.warn(`[tuningProfile] DOCUMENT_TUNING_PROFILE 解析失败，按全默认处理：${String(error)}`);
    }
  }
  profileCache = { raw, parsed };
  return parsed;
}
