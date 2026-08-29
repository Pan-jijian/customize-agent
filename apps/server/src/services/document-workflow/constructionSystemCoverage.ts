import type { DocumentDraftChapter, ValidationIssue } from './types';

/**
 * 招标范围工程系统零覆盖检测（C3）：章节大纲涉及的专业工程系统（电梯/幕墙/智能化等）在正文零覆盖
 * 属于评标失分级漏项（徽光阁实测：电梯工程零落位）。
 * 判定：L1 封闭集工程系统名称表（行业通用专业工程集合，外置参考库）从章节标题提取"应覆盖义务"，
 * 正文（章节内容，不含目录）词面零命中即报零覆盖；语义模型不参与判定（工程系统名是确定性名称，
 * 正文覆盖必然词面出现，词面判定即零误伤）。
 */

/** 招标范围工程系统封闭集（行业通用专业工程名称，仅从章节标题提取义务，不凭空制造义务） */
const CONSTRUCTION_SYSTEM_NAMES = [
  '电梯', '幕墙', '智能化', '消防', '暖通', '给排水', '电气', '燃气', '人防',
  '室外', '园林', '绿化', '景观', '钢结构', '防水', '保温', '门窗', '通风',
  '空调', '防雷', '接地', '动力', '照明', '拆除', '加固', '装修', '装饰',
] as const;

export function constructionSystemCoverageIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  // 义务来源：章节标题（大纲规划）含系统名 → 该章应覆盖该系统；无义务时静默跳过（不制造义务）
  const required = [...new Set(chapters.flatMap(chapter => CONSTRUCTION_SYSTEM_NAMES.filter(name => chapter.title.includes(name))))];
  if (required.length === 0) return [];
  // 覆盖判定：全部章节正文（不含标题/目录）词面命中系统名
  const bodies = chapters.map(chapter => chapter.content || '').join('\n');
  const uncovered = required.filter(name => !bodies.includes(name));
  if (uncovered.length === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'structure',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `章节大纲涉及的专业工程系统在正文零覆盖：${uncovered.join('、')}`,
    suggestion: '对应章节必须补写该专业工程的施工方案正文（施工概况/施工流程/施工方法，含可核实的工艺参数），不得整章零覆盖。',
  }];
}
