import { describe, expect, it } from 'vitest';
import { buildFinalGateRepairQualityFeedback } from '../src/services/document-workflow/documentPipeline';
import { finalizeChapterContentQuality } from '../src/services/document-workflow/documentGeneratorHelpers';
import type { DocumentTemplateChapter } from '../src/services/document-workflow/types';

// 八度实测缺陷复现：Final Gate 补写“主要分部分项工程施工方案”通篇无“施工概况/施工流程/施工方法”标签，
// 分部分项专项验收器判定 9 个分项缺三段式+缺箭头工序链，3 轮补写全部不达标，导出门禁 2 个 blocker 残留导致生成失败。
// 修复：①补写 prompt 注入三段式硬性要求；②ensureWorkPackageOverviewLabels 扩展到全部工作包型小节（首行“施工概况：”前缀兜底）。

const divisionChapter: Pick<DocumentTemplateChapter, 'title' | 'sections'> = {
  title: '确保工期与质量的保障体系与措施、确保安全生产的管理体系与措施',
  sections: ['主要分部分项工程施工方案'],
};

describe('buildFinalGateRepairQualityFeedback（Final Gate 补写三段式要求注入）', () => {
  it('分部分项小节补写注入三段式标签硬性要求', () => {
    const feedback = buildFinalGateRepairQualityFeedback('主要分部分项工程施工方案');
    expect(feedback).toContain('施工概况');
    expect(feedback).toContain('施工流程');
    expect(feedback).toContain('施工方法');
    expect(feedback).toContain('不少于 4 个环节的“→”工序链');
    expect(feedback).toContain('Final Gate 发现');
  });

  it('项目主要施工内容补写同样注入三段式要求', () => {
    const feedback = buildFinalGateRepairQualityFeedback('项目主要施工内容');
    expect(feedback).toContain('施工概况');
    expect(feedback).toContain('施工流程');
    expect(feedback).toContain('施工方法');
  });

  it('非工作包型小节不注入三段式要求', () => {
    const feedback = buildFinalGateRepairQualityFeedback('编制说明');
    expect(feedback).not.toContain('每个 #### 分项方案');
    expect(feedback).toContain('Final Gate 发现');
  });

  it('lastFailure 注入此前被拒原因', () => {
    const feedback = buildFinalGateRepairQualityFeedback('编制说明', '输出包含占位表达');
    expect(feedback).toContain('此前生成被拒原因：输出包含占位表达');
  });
});

describe('ensureWorkPackageOverviewLabels 扩展到分部分项小节（首行标签兜底）', () => {
  it('分部分项小节无标签首行自动补“施工概况：”前缀', () => {
    const content = [
      '### 主要分部分项工程施工方案',
      '',
      '#### 结构加固改造工程施工方案',
      '本分项针对现状三层框架结构开裂构件及墙体进行加固补强，作业部位分布于各楼层梁、板、柱及承重墙体。',
      '',
    ].join('\n');
    const finalized = finalizeChapterContentQuality(content, divisionChapter);
    expect(finalized).toContain('施工概况：本分项针对现状三层框架结构');
  });

  it('已有“施工概况：”标签首行不重复加前缀', () => {
    const content = [
      '### 主要分部分项工程施工方案',
      '',
      '#### 结构加固改造工程施工方案',
      '施工概况：本分项针对现状三层框架结构开裂构件及墙体进行加固补强。',
      '',
    ].join('\n');
    const finalized = finalizeChapterContentQuality(content, divisionChapter);
    expect(finalized.split('施工概况：').length - 1).toBe(1);
  });

  it('已有“施工流程：”标签首行也不加前缀', () => {
    const content = [
      '### 主要分部分项工程施工方案',
      '',
      '#### 结构加固改造工程施工方案',
      '施工流程：定位放线→基层处理→实施→检查验收',
      '',
    ].join('\n');
    const finalized = finalizeChapterContentQuality(content, divisionChapter);
    expect(finalized).toContain('施工流程：定位放线→基层处理→实施→检查验收');
    expect(finalized).not.toContain('施工概况：施工流程');
  });

  it('非工作包型小节首行不补前缀（行为不扩散）', () => {
    const content = [
      '### 编制依据',
      '',
      '#### 招标及合同文件',
      '徽光阁项目施工招标文件及补疑。',
      '',
    ].join('\n');
    const finalized = finalizeChapterContentQuality(content, { title: '工程重点难点及危大工程的保障体系', sections: ['编制依据'] });
    expect(finalized).toContain('#### 招标及合同文件\n徽光阁项目施工招标文件及补疑');
  });
});
