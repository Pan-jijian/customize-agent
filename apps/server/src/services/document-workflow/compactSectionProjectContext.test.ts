import { describe, expect, it } from 'vitest';
import { compactSectionProjectContext } from './chapterGeneration';

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
});
