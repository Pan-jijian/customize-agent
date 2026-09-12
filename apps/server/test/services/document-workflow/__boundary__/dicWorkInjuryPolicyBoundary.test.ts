/**
 * supplementRequiredTexts 工伤保险政策合规兜底（舒城第二轮实测）
 *
 * 背景：正文有劳务/农民工/工资管理内容但全篇未提工伤保险 → 终检「工伤保险表述缺失」blocker
 * （localAdaptationKeywordIssues）；requirementCalibration P3.3 补挂依赖评分项摘要提及保险，
 * 舒城摘要未提及未触发。修复：finalize 写入侧确定性兜底——劳资内容存在且未提保险时，
 * 在劳资/工资小节标题下注入合规句（退「劳动力」章标题，再退文末）。
 *
 * 口径：条件判定只用原始输入且先剥离书名号法规引用（避免编制依据类别块《保障农民工工资支付
 * 条例》引用被误当劳资内容而误注入）；注入目标为补写后文本；已有保险表述（工伤/意外伤害/
 * 社会保险）不注入。原则：每条用例独立断言意义；真实实现行为一律锁定。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentTemplate } from '@/services/document-workflow/types';

vi.mock('@/services/document-workflow/qualityValidation', async importOriginal => {
  const actual = await importOriginal<typeof import('@/services/document-workflow/qualityValidation')>();
  return { ...actual, autoSpecGateRequiredTexts: vi.fn() };
});

import { supplementRequiredTexts } from '@/services/document-workflow/finalize/rebuildAndRecompute';
import { autoSpecGateRequiredTexts } from '@/services/document-workflow/qualityValidation';

const mockedRequiredTexts = vi.mocked(autoSpecGateRequiredTexts);
const TEMPLATE = { name: '施工组织设计', category: '房建', outputTitle: '', description: '' } as unknown as DocumentTemplate;

beforeEach(() => {
  mockedRequiredTexts.mockReset();
  mockedRequiredTexts.mockReturnValue([]);
});

describe('supplementRequiredTexts 工伤保险政策合规兜底', () => {
  it('劳资小节+无保险：合规句注入劳资小节标题下，原文顺延其后', () => {
    const markdown = '### 5.3 劳动力工资支付与稳定措施\n建立劳务用工实名制，工资按月足额发放。';
    const result = supplementRequiredTexts(markdown, TEMPLATE);
    expect(result).toContain('本项目按规定为全体作业人员办理工伤保险');
    expect(result.indexOf('办理工伤保险')).toBeGreaterThan(result.indexOf('### 5.3 劳动力工资支付与稳定措施'));
    expect(result.indexOf('办理工伤保险')).toBeLessThan(result.indexOf('建立劳务用工实名制'));
  });

  it('已提工伤保险：原样返回', () => {
    const markdown = '### 5.3 劳动力工资支付与稳定措施\n已按规定为作业人员办理工伤保险，工资按月足额发放。';
    expect(supplementRequiredTexts(markdown, TEMPLATE)).toBe(markdown);
  });

  it('已提意外伤害保险（替代口径）：不重复注入', () => {
    const markdown = '劳务人员均已参加意外伤害保险，工资按月足额发放。';
    expect(supplementRequiredTexts(markdown, TEMPLATE)).toBe(markdown);
  });

  it('无劳资内容：原样返回', () => {
    expect(supplementRequiredTexts('质量目标：确保工程合格。', TEMPLATE)).toBe('质量目标：确保工程合格。');
  });

  it('劳资词仅在书名号法规引用内：不触发注入', () => {
    const markdown = '施工管理执行《保障农民工工资支付条例》（国务院令第724号）有关规定。';
    expect(supplementRequiredTexts(markdown, TEMPLATE)).toBe(markdown);
  });

  it('保险词仅在书名号法规引用内：判定为未覆盖，仍注入合规句', () => {
    const markdown = '### 劳务人员管理\n依据《工伤保险条例》落实作业人员权益保障。';
    const result = supplementRequiredTexts(markdown, TEMPLATE);
    expect(result).toContain('本项目按规定为全体作业人员办理工伤保险');
    expect(result.indexOf('办理工伤保险')).toBeGreaterThan(result.indexOf('### 劳务人员管理'));
  });

  it('有劳资正文但无劳资标题：合规句追加文末', () => {
    const markdown = '本工程建立劳务用工管理制度，工资按月足额发放。';
    const result = supplementRequiredTexts(markdown, TEMPLATE);
    expect(result.trimEnd().endsWith('务工人员工伤保险权益依法受到保障。')).toBe(true);
    expect(result.indexOf('办理工伤保险')).toBeGreaterThan(result.indexOf('本工程建立劳务用工管理制度'));
  });

  it('编制依据块注入《保障农民工工资支付条例》引用：不误触发（判定用原始输入）', () => {
    mockedRequiredTexts.mockReturnValue(['编制依据']);
    const result = supplementRequiredTexts('正文内容。', TEMPLATE);
    expect(result).toContain('农民工工资');
    expect(result).not.toContain('办理工伤保险');
    expect(result.trimEnd().endsWith('企业施工工艺标准。')).toBe(true);
  });
});
