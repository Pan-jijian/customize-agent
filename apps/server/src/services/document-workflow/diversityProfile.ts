/**
 * 文档级多样性画像（6 组织视角 × 5 命名风格）：
 * seed 由 documentId 等稳定输入派生；同一模板连续生成时按历史轮换去重，
 * 让每份文档从规划源头带上不同的组织主线与命名气质（多文档反雷同的顶层开关）。
 * 提示词注入由 diversityProfilePrompt 生成，用于规划轮与定名轮。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stableHash } from './utils';

/** 规划与定名轮温度：0 会固化措辞（多文档趋同），0.85 在保真与多样之间取衡 */
export const DIVERSITY_PLANNING_TEMPERATURE = 0.85;

export const ORGANIZATION_PERSPECTIVES = [
  { name: '工序主线', prompt: '以施工先后工序为主线组织内容，小节按施工流程推进顺序展开' },
  { name: '专业系统', prompt: '以专业系统构成为主线，按各专业分系统独立成节' },
  { name: '空间区段', prompt: '以施工区段、单体与平面分区为主线，按空间单元组织小节' },
  { name: '资源要素', prompt: '以人材机等生产要素配置为主线，按资源要素组织小节' },
  { name: '目标管控', prompt: '以质量、安全、工期等管控目标为主线，按目标维度组织小节' },
  { name: '接口协同', prompt: '以专业接口与协同配合为主线，按接口关系与穿插顺序组织小节' },
] as const;

export const NAMING_STYLES = [
  { name: '直述事务', prompt: '小节标题采用惯例事务名词直述（如「编制说明与工程概况」）' },
  { name: '目标牵引', prompt: '小节标题以目标与结果词收尾（如「工期目标与进度保障」）' },
  { name: '流程管控', prompt: '小节标题突出流程与衔接（如「施工流程与工序衔接」）' },
  { name: '要素配置', prompt: '小节标题突出要素与资源配置（如「劳动力配置与组织」）' },
  { name: '系统专业', prompt: '小节标题突出系统构成与专业对象（如「测量控制网建立」）' },
] as const;

export interface DiversityProfile {
  /** 轮换去重键：`${perspectiveIndex}-${styleIndex}` */
  id: string;
  perspective: string;
  style: string;
  /** 提示词注入文本（规划轮与定名轮系统前缀） */
  prompt: string;
}

function profileIdFor(index: number) {
  return `${Math.floor(index / NAMING_STYLES.length)}-${index % NAMING_STYLES.length}`;
}

/** 派生多样性画像：seed 文本（如 documentId）确定性散列定起点；同模板历史组合按轮换去重跳过 */
export function deriveDiversityProfile(seedText: string, recentProfileIds: string[] = []): DiversityProfile {
  const total = ORGANIZATION_PERSPECTIVES.length * NAMING_STYLES.length;
  const hash = stableHash(String(seedText || 'default-document'));
  const start = Number.parseInt(hash.slice(0, 8), 16) % total;
  const recent = new Set(recentProfileIds.filter(Boolean));
  let chosen = start;
  for (let step = 0; step < total; step += 1) {
    const index = (start + step) % total;
    if (!recent.has(profileIdFor(index))) {
      chosen = index;
      break;
    }
  }
  const perspective = ORGANIZATION_PERSPECTIVES[Math.floor(chosen / NAMING_STYLES.length)]!;
  const style = NAMING_STYLES[chosen % NAMING_STYLES.length]!;
  return {
    id: profileIdFor(chosen),
    perspective: perspective.name,
    style: style.name,
    prompt: `本次文档系统性差异化设定（全文一以贯之，除非与模板锁定小节冲突）：\n- 组织主线：${perspective.prompt}。\n- 命名风格：${style.prompt}。\n同一文档内不得混用多种命名风格。`,
  };
}

const MAX_HISTORY_PER_TEMPLATE = 12;

function diversityHistoryPath() {
  const base = process.env.CUSTOMIZE_AGENT_HOME
    ? path.join(process.env.CUSTOMIZE_AGENT_HOME, '.customize-agent')
    : path.join(os.homedir(), '.customize-agent');
  return path.join(base, 'diversity-history.json');
}

interface DiversityHistoryFile {
  version: 1;
  /** templateId → 最近使用的 profile id 列表（新在前） */
  history: Record<string, string[]>;
}

/** 读取模板维度的多样性历史（容错：文件缺失/损坏回退空历史，不阻断生成） */
export function loadDiversityHistory(templateId: string): string[] {
  try {
    const file = diversityHistoryPath();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DiversityHistoryFile>;
    const list = parsed?.history?.[templateId];
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 记录一次画像使用（读-合并-滚动裁剪-写；失败静默，不阻断生成） */
export function recordDiversityUsage(templateId: string, profileId: string): void {
  try {
    const file = diversityHistoryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let data: DiversityHistoryFile = { version: 1, history: {} };
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DiversityHistoryFile>;
        if (parsed && typeof parsed === 'object' && parsed.history && typeof parsed.history === 'object') {
          data = { version: 1, history: parsed.history };
        }
      } catch {
        // 损坏文件直接重建
      }
    }
    const previous = (data.history[templateId] || []).filter(item => item !== profileId);
    data.history[templateId] = [profileId, ...previous].slice(0, MAX_HISTORY_PER_TEMPLATE);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error(`[diversity] 画像历史写入失败（不阻断生成）：${error instanceof Error ? error.message : String(error)}`);
  }
}
