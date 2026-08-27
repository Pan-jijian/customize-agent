import { describe, expect, it } from 'vitest';
import { internalTerminologyIssues } from '../src/services/document-workflow/qualityValidation';

/**
 * 内部术语泄漏保险丝（词面标记，不做替换）大规模测试：
 * 语义分层治理后，该保险丝只做确定性词面标记（flag）触发修复循环，术语改写是语义动作归 Repairer。
 * 覆盖：出现位置（标题/正文/表格/编号行）、多次出现、混入其他后台话术、正常正文、空输入、issue 契约。
 */
describe('internalTerminologyIssues 标记契约', () => {
  it('标记为 error/blocker 且 category=format owner=system（门禁与修复循环识别口径）', () => {
    const issues = internalTerminologyIssues('#### 拆除工程工作包\n正文。');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('error');
    expect(issues[0]!.severity).toBe('blocker');
    expect(issues[0]!.category).toBe('format');
    expect(issues[0]!.owner).toBe('system');
  });

  it('消息要求按上下文语义改写而非词面替换', () => {
    const issues = internalTerminologyIssues('以下按工作包逐项说明。');
    expect(issues[0]!.message).toContain('语义改写');
  });

  it('suggestion 携带语境改写示例（拆除工程工作包→拆除工程）', () => {
    const issues = internalTerminologyIssues('#### 1.3.1 拆除工程工作包\n\n正文。');
    expect(issues[0]!.suggestion).toContain('拆除工程工作包');
    expect(issues[0]!.suggestion).toContain('结合语境改写');
  });
});

describe('internalTerminologyIssues 出现位置覆盖', () => {
  it('标题尾缀出现时标记', () => {
    expect(internalTerminologyIssues('#### 1.3.1 拆除工程工作包')).toHaveLength(1);
  });

  it('正文叙述出现时标记', () => {
    expect(internalTerminologyIssues('以下按工作包逐项说明施工概况、施工流程、施工方法。')).toHaveLength(1);
  });

  it('表格行出现时标记', () => {
    expect(internalTerminologyIssues('| 拆除作业与保留商铺并存 | 拆除工作包、相邻商铺安全 |')).toHaveLength(1);
  });

  it('编号行出现时标记（1.3.1 拆除工程工作包）', () => {
    expect(internalTerminologyIssues('### 1.3.1 拆除工程工作包\n\n正文。')).toHaveLength(1);
  });

  it('多位置多次出现时仍只报一条 issue（合并去噪，修复循环只跑一次）', () => {
    const markdown = '#### 拆除工程工作包\n\n以下按工作包逐项说明。\n\n| 项 | 内容 |\n|---|---|\n| 1 | 拆除工作包 |';
    const issues = internalTerminologyIssues(markdown);
    expect(issues).toHaveLength(1);
  });
});

describe('internalTerminologyIssues 不误报覆盖', () => {
  it('正常正式术语正文不标记', () => {
    expect(internalTerminologyIssues('#### 1.3.1 拆除工程\n\n以下按专业工程逐项说明。')).toHaveLength(0);
  });

  it('空字符串不标记', () => {
    expect(internalTerminologyIssues('')).toHaveLength(0);
  });

  it('无换行的纯标题正文不标记', () => {
    expect(internalTerminologyIssues('拆除工程')).toHaveLength(0);
  });

  it('含相似但不相同的词（工作界面/作业包络）不标记——不做词表变体猜测', () => {
    expect(internalTerminologyIssues('施工工作界面划分清晰，作业包络合理。')).toHaveLength(0);
  });

  it('目录（TOC）中的工作包同样标记——目录也是交付内容', () => {
    expect(internalTerminologyIssues('## 目录\n\n- 1.3.1 拆除工程工作包')).toHaveLength(1);
  });
});

describe('internalTerminologyIssues 与治理链协同', () => {
  it('其他后台话术（知识库/待确认）不由此保险丝处理——职责单一', () => {
    const issues = internalTerminologyIssues('本工程知识库检索后待确认事项较多。');
    expect(issues).toHaveLength(0);
  });

  it('工作包与其他后台话术并存时只标记工作包', () => {
    const issues = internalTerminologyIssues('知识库中按工作包逐项说明，待确认事项待资料复核。');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('工作包');
  });
});
