import { describe, expect, it } from 'vitest';
import { normalizeTertiaryHeadings } from '../src/services/document-workflow/markdownComposer';

describe('normalizeTertiaryHeadings', () => {
  it('renumbers existing tertiary headings by current secondary section', () => {
    const markdown = [
      '## 第一章 工程概况',
      '',
      '### 1.1 编制说明',
      '',
      '#### 1.1.1 编制说明',
      '正文',
      '#### 1.1.1 项目基本信息',
      '正文',
      '',
      '### 1.2 项目概况',
      '',
      '#### 1.1.1 总体目标',
    ].join('\n');

    expect(normalizeTertiaryHeadings(markdown)).toContain('#### 1.1.1 编制说明');
    expect(normalizeTertiaryHeadings(markdown)).toContain('#### 1.1.2 项目基本信息');
    expect(normalizeTertiaryHeadings(markdown)).toContain('#### 1.2.1 总体目标');
  });

  it('downgrades fifth-level tertiary headings under a secondary section', () => {
    const markdown = [
      '## 第二章 施工部署',
      '',
      '### 2.1 总平面布置',
      '',
      '##### 1.1.1 综合布线与管线敷设施工',
    ].join('\n');

    expect(normalizeTertiaryHeadings(markdown)).toContain('#### 2.1.1 综合布线与管线敷设施工');
    expect(normalizeTertiaryHeadings(markdown)).not.toContain('#####');
  });
});
