import { describe, expect, it } from 'vitest';
import { extractExplicitOutlineFromSources, hasExplicitOutlineBlock } from '../src/services/document-workflow/outline';

const realPromptOutline = `<OUTLINE>
1、工程概况
2、主要施工方法
3、拟投入的主要物资计划
4、拟投入的主要施工机械、设备计划
5、劳动力安排计划
6、确保工程质量的技术组织措施
7、确保安全生产的技术组织措施
8、确保工期的技术组织措施
9、确保文明施工的技术组织措施
10、施工总平面布置图
</OUTLINE>`;

const tenChapterOutline = `<章节>
第一章 项目理解与总体思路
第二章 需求分析与服务范围
第三章 组织架构与人员配置
第四章 实施计划与进度安排
第五章 质量保障措施
第六章 安全管理措施
第七章 风险识别与应对
第八章 沟通协调机制
第九章 成果交付与验收
第十章 后续服务与持续改进
</章节>`;

describe('document explicit outline parsing', () => {
  it('reads all ten chapters from the real OUTLINE numbering style', () => {
    expect(hasExplicitOutlineBlock(realPromptOutline)).toBe(true);
    const chapters = extractExplicitOutlineFromSources([{ text: realPromptOutline, source: '施工组织设计总控提示词', strict: true }]);
    expect(chapters).toHaveLength(10);
    expect(chapters.map(chapter => chapter.title)).toEqual([
      '工程概况',
      '主要施工方法',
      '拟投入的主要物资计划',
      '拟投入的主要施工机械、设备计划',
      '劳动力安排计划',
      '确保工程质量的技术组织措施',
      '确保安全生产的技术组织措施',
      '确保工期的技术组织措施',
      '确保文明施工的技术组织措施',
      '施工总平面布置图',
    ]);
    expect(chapters.every(chapter => chapter.sections.length === 0)).toBe(true);
  });

  it('reads all ten chapters from Chinese outline tags', () => {
    expect(hasExplicitOutlineBlock(tenChapterOutline)).toBe(true);
    const chapters = extractExplicitOutlineFromSources([{ text: tenChapterOutline, source: '提示词角色', strict: true }]);
    expect(chapters).toHaveLength(10);
    expect(chapters.map(chapter => chapter.title)).toEqual([
      '项目理解与总体思路',
      '需求分析与服务范围',
      '组织架构与人员配置',
      '实施计划与进度安排',
      '质量保障措施',
      '安全管理措施',
      '风险识别与应对',
      '沟通协调机制',
      '成果交付与验收',
      '后续服务与持续改进',
    ]);
  });

  it('filters instruction-like conditional outline lines', () => {
    const outline = `<OUTLINE>
第一章 工程概况
第二章 特殊气候施工措施
- 判断是否涉及冬季施工
第三章 资源投入计划
</OUTLINE>`;
    const chapters = extractExplicitOutlineFromSources([{ text: outline, source: '提示词角色', strict: true }]);

    expect(chapters.map(chapter => chapter.title)).toEqual(['工程概况', '特殊气候施工措施', '资源投入计划']);
    expect(chapters.map(chapter => chapter.title).join('\n')).not.toContain('判断是否');
  });
});
