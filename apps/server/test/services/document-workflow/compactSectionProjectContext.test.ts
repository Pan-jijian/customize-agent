import { describe, expect, it } from 'vitest';
import { compactScopedProjectContext, compactSectionProjectContext } from '@/services/document-workflow/chapterGeneration';

/**
 * 评分项要求段置顶保护回归（4.12.x 正文丢「确保黄山杯」根因之一）：
 * projectContext 组装顺序为 [baseProjectContext, documentBlueprintContext, tenderRequirementsWritingRules]，
 * 评分项要求段位于末尾——旧实现 slice(0, maxChars) 切尾部即丢创优目标，写作上下文无要求可响应 → 零响应。
 */
describe('compactSectionProjectContext（评分项要求段置顶保护）', () => {
  const longPrefix = Array.from({ length: 120 }, (_, index) => `- 项目概况事实行${index}：本工程位于合肥市，总建筑面积约28570平方米，结构形式为框架结构。`).join('\n');
  const requirements = '【招标文件评分项要求（系统从绑定资料提取，必须逐条响应，零响应即评标失分）】\n1. 本项目创优目标（必须全文显性响应）：创优目标：确保黄山杯。\n2. 绿色建筑等级要求：达到国标二星级。';

  it('评分项要求段位于末尾且前缀超长时，要求段整段置顶保留', () => {
    const context = `${longPrefix}\n${requirements}`;
    const result = compactSectionProjectContext(context, 2000);
    // 要求段整段保留且置顶
    expect(result.startsWith('【招标文件评分项要求')).toBe(true);
    expect(result).toContain('确保黄山杯');
    expect(result).toContain('国标二星级');
    // 其余上下文被截断（超预算）
    expect(result).toContain('（上下文已截断，完整信息见绑定材料与证据）');
  });

  it('评分项要求段位于中间时同样被拆出置顶', () => {
    const context = `${longPrefix.slice(0, 500)}\n${requirements}\n${longPrefix.slice(0, 500)}`;
    const result = compactSectionProjectContext(context, 800);
    expect(result.startsWith('【招标文件评分项要求')).toBe(true);
    expect(result).toContain('确保黄山杯');
  });

  it('无评分项要求段时保持原截断行为', () => {
    const result = compactSectionProjectContext(longPrefix, 800);
    expect(result).not.toContain('【招标文件评分项要求');
    expect(result.length).toBeLessThanOrEqual(800 + 40);
    expect(result).toContain('（上下文已截断，完整信息见绑定材料与证据）');
  });

  it('无评分项要求段且不超预算时原样返回（无截断提示）', () => {
    const short = '上下文：本工程位于合肥市。\n- 项目概况事实行：总建筑面积约28570平方米。';
    expect(compactSectionProjectContext(short, 2000)).toBe(short);
  });

  it('要求段自身超预算也不截断要求段（宁超预算不丢要求）', () => {
    const hugeRequirements = `【招标文件评分项要求（系统从绑定资料提取，必须逐条响应，零响应即评标失分）】\n${Array.from({ length: 60 }, (_, index) => `${index + 1}. 前附表响应条款：本项目第${index}条实质要求内容为专项技术措施，必须逐条落位响应。`).join('\n')}`;
    const result = compactSectionProjectContext(`${longPrefix}\n${hugeRequirements}`, 800);
    expect(result.startsWith('【招标文件评分项要求')).toBe(true);
    // 要求段第 60 条（尾部）完整保留——不允许被截断
    expect(result).toContain('第59条实质要求');
  });

  it('A2 双保护：可信基础事实主表段整段保留（不丢本章精确事实）', () => {
    const factsBlock = '可信基础事实主表（本章相关）：\n- 建设地点：合肥市瑶海区，总建筑面积28570平方米\n- 计划工期：365日历天\n- 合同估算价：3000万元';
    const context = `${longPrefix}\n${factsBlock}\n关键事实证据追踪清单（本章相关）：\n1. 建设地点｜合肥市瑶海区｜来源：招标文件.pdf`;
    const result = compactSectionProjectContext(context, 800);
    expect(result.startsWith('可信基础事实主表')).toBe(true);
    // 事实行整段保留（含最后一条）
    expect(result).toContain('合同估算价：3000万元');
    expect(result).toContain('计划工期：365日历天');
  });

  it('A2 双保护：要求段与事实主表同时存在时双双置顶保留', () => {
    const factsBlock = '可信基础事实主表（本章相关）：\n- 计划工期：365日历天\n- 合同估算价：3000万元';
    const context = `${longPrefix}\n${factsBlock}\n${requirements}`;
    const result = compactSectionProjectContext(context, 600);
    expect(result).toContain('确保黄山杯'); // 要求段保留
    expect(result).toContain('合同估算价：3000万元'); // 事实主表保留
    // 要求段与事实段均在输出中
    expect(result.indexOf('【招标文件评分项要求')).toBeGreaterThanOrEqual(0);
    expect(result.indexOf('可信基础事实主表')).toBeGreaterThanOrEqual(0);
  });
});

/**
 * 3.5 scoped 专用紧凑化回归：章级 scoped 上下文含「章节专业任务卡」「章节实施方案」章级专用段
 * （内容行为 `- ` 缩进行，不匹配 structured 行特征），通用紧凑化会截丢；专用函数必须整段保留，
 * 矩阵段/全局段等其他 body 部分按预算截断。
 */
describe('compactScopedProjectContext（3.5 scoped 专用紧凑化）', () => {
  const globalBlock = '【全局文档蓝图与一致性约束】\n文档类型画像：施工组织设计；评分重点：技术方案、进度\n文档目标：合肥某工程施工组织设计';
  const factsBlock = '可信基础事实主表（本章相关）：\n- 建设地点：合肥市瑶海区\n- 计划工期：365日历天\n- 合同估算价：3000万元';
  const matrixBlock = '事实覆盖矩阵：\n1. 工程概况：全部覆盖\n2. 施工进度计划：部分覆盖\n知识库确认覆盖矩阵：\n1. 工程概况：全部/正文\n2. 施工进度计划：部分/正文';
  const taskCardBlock = '章节专业任务卡：\n章节任务卡：施工进度计划\n- 必须覆盖事实域：工期、进度、资源\n- 围绕总工期和关键线路组织';
  const executionPlanBlock = '章节实施方案：\n章节实施方案：施工进度计划\n- 写作模式：正文；资料支撑度：部分\n- 章节目标：说明资源保障、穿插施工、纠偏机制';
  const scopedContext = [globalBlock, factsBlock, matrixBlock, taskCardBlock, executionPlanBlock].join('\n');

  it('任务卡段与实施方案段整段保留（通用紧凑化会截丢的内容）', () => {
    const result = compactScopedProjectContext(scopedContext, 800);
    expect(result).toContain('章节专业任务卡：');
    expect(result).toContain('章节任务卡：施工进度计划');
    expect(result).toContain('围绕总工期和关键线路组织');
    expect(result).toContain('章节实施方案：');
    expect(result).toContain('写作模式：正文');
  });

  it('事实主表段整段保留（含最后一条事实）', () => {
    const result = compactScopedProjectContext(scopedContext, 800);
    expect(result).toContain('可信基础事实主表（本章相关）');
    expect(result).toContain('合同估算价：3000万元');
  });

  it('矩阵段/全局段按预算截断（保留段优先占用预算）', () => {
    // body 需超过 max(400, maxChars - 保护段) 预算下限才触发截断：构造长矩阵段 + 收紧预算
    const longMatrix = `事实覆盖矩阵：\n${Array.from({ length: 30 }, (_, index) => `${index + 1}. 章节${index}：部分覆盖`).join('\n')}`;
    const result = compactScopedProjectContext(`${globalBlock}\n${factsBlock}\n${longMatrix}\n${taskCardBlock}\n${executionPlanBlock}`, 600);
    // 保护段（事实主表+任务卡+实施方案）优先占用预算，body（矩阵/全局）被截断
    expect(result).toContain('（上下文已截断，完整信息见绑定材料与证据）');
    // 任务卡内容完整保留（宁超预算不丢专业展开方向）
    expect(result).toContain('围绕总工期和关键线路组织');
    expect(result).toContain('章节实施方案：');
  });

  it('评分项要求段与 scoped 段共存时全部置顶保留', () => {
    const requirements = '【招标文件评分项要求（系统从绑定资料提取，必须逐条响应，零响应即评标失分）】\n1. 创优目标：确保黄山杯。';
    const result = compactScopedProjectContext(`${scopedContext}\n${requirements}`, 900);
    expect(result).toContain('确保黄山杯');
    expect(result).toContain('章节专业任务卡：');
    expect(result).toContain('合同估算价：3000万元');
  });

  it('无 scoped 专用段时退化为事实主表+要求保护（与通用紧凑化同口径）', () => {
    const result = compactScopedProjectContext(`${globalBlock}\n${factsBlock}`, 600);
    expect(result).toContain('可信基础事实主表（本章相关）');
    expect(result).not.toContain('章节专业任务卡：');
  });
});
