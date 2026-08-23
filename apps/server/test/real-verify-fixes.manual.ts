import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sanitizeFormalMarkdown } from '../src/services/document-workflow/markdownComposer';
import { collectSectionContentGaps, sectionContentIntegrityIssues } from '../src/services/document-workflow/qualityValidation';
import { processParameterDensityIssues } from '../src/services/document-workflow/constructionOrgAudit';
import type { DocumentDraftChapter } from '../src/services/document-workflow/types';

function loadCheckpoint(): DocumentDraftChapter[] {
  const raw = JSON.parse(readFileSync('/tmp/real-gen-4-checkpoint.json', 'utf-8')) as Array<{ id: string; title: string; content: string }>;
  return raw as unknown as DocumentDraftChapter[];
}

describe('real-checkpoint fix verification', () => {
  it('FALLBACK_SECTION_BOILERPLATE_RE 删除套话兜底小节且保留实质小节', () => {
    const chapters = loadCheckpoint();
    const chapter = chapters.find(item => item.title.includes('工期与质量'));
    expect(chapter).toBeTruthy();
    const before = chapter!.content;
    expect(before).toContain('#### 当前项目分部分项对象');
    expect(before).toContain('#### 主要工艺流程与施工顺序');
    expect(before).toContain('#### 材料设备与参数控制');
    const cleaned = sanitizeFormalMarkdown(before);
    expect(cleaned).not.toContain('当前项目分部分项对象');
    expect(cleaned).not.toContain('主要工艺流程与施工顺序');
    expect(cleaned).not.toContain('材料设备与参数控制');
    expect(cleaned).not.toContain('依据本项目已确认资料中的项目边界');
    expect(cleaned).not.toContain('作业条件确认→技术交底→过程实施');
    // 实质小节保留
    expect(cleaned).toContain('安装工程施工方案');
    expect(cleaned).toContain('屋面工程施工方案');
    expect(cleaned).toContain('总体施工顺序');
    expect(cleaned).toContain('拆除清运—结构加固—设备管线—装饰面层');
  }, 30000);

  it('表格清单小节不再误报“只有标题或表格无正文”', () => {
    const chapters = loadCheckpoint();
    const issues = sectionContentIntegrityIssues('', chapters);
    const messages = issues.map(issue => issue.message);
    expect(messages.some(message => /危大工程控制清单/.test(message) && /只有标题或表格无正文/.test(message))).toBe(false);
    expect(messages.some(message => /主要周转材料配置/.test(message) && /只有标题或表格无正文/.test(message))).toBe(false);
    // 消息带章名前缀
    for (const message of messages) {
      if (/只有标题或表格无正文/.test(message)) {
        expect(message.startsWith('小节')).toBe(false);
      }
    }
  }, 30000);

  it('安装工程施工方案设备清单不按无工艺参数阻断', () => {
    const chapters = loadCheckpoint();
    const issues = processParameterDensityIssues(chapters);
    const hardErrors = issues.filter(issue => issue.level === 'error');
    expect(hardErrors.some(issue => /安装工程施工方案/.test(issue.message))).toBe(false);
    const deviceWarnings = issues.filter(issue => /设备配置参数为主/.test(issue.message));
    expect(deviceWarnings.length).toBeGreaterThan(0);
  }, 30000);

  it('collectSectionContentGaps 对真实 checkpoint 不再产生 error 级空小节误报', () => {
    const chapters = loadCheckpoint();
    const gaps = collectSectionContentGaps('', chapters);
    const emptyGaps = gaps.filter(gap => gap.reason === 'empty');
    for (const gap of emptyGaps) {
      expect(/清单|配置/.test(gap.sectionTitle)).toBe(false);
    }
  }, 30000);
});
