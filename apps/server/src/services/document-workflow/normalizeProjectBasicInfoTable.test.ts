import { describe, it, expect } from 'vitest';
import { normalizeProjectBasicInfoTable } from './documentGeneratorHelpers';
import type { DocumentFact } from './types';

function makeFact(key: string, value: string, sourceFile = '招标文件.docx'): DocumentFact {
  return {
    key,
    fieldId: key,
    fieldName: key,
    value,
    sourceFile,
    roleId: 'bidding',
    processingType: 'rule',
    confidence: 100,
    sourceRef: { filePath: sourceFile, roleId: 'bidding', processingType: 'rule', sectionTitle: '项目概况' },
  };
}

const PROJECT_FACTS: DocumentFact[] = [
  makeFact('project_name', '徽光阁项目施工'),
  makeFact('project_code', '2026AFLGZ50747'),
  makeFact('owner', '合肥城隍庙商业运营管理有限公司'),
  makeFact('project_location', '安徽省合肥市庐阳区安庆路城隍庙内'),
  makeFact('project_scale', '总建筑面积约4646m2'),
  makeFact('schedule_requirement', '45日历天'),
  makeFact('quality_standard', '合格'),
  makeFact('project_investment_estimate', '1498.41万元'),
];

/** 徽光阁缺陷现场：表格后无空行直接连正文，正文中的标题前也无空行（`。####`/`。###` 直接连排） */
const MARKDOWN_TABLE_GLUED_TO_PROSE = `## 第一章 工程重点难点及危大工程的保障体系

### 1.1 编制说明与工程概况

本施工组织设计针对徽光阁项目施工编制，项目编号2026AFLGZ50747，招标人为合肥城隍庙商业运营管理有限公司。编制范围为招标补疑及工程量清单明确的全部施工内容。项目基本信息如下表所示。
| 信息项 | 内容 |
| --- | --- |
| 项目名称 | 徽光阁项目施工 |
| 项目编号 | 2026AFLGZ50747 |
| 招标人 | 合肥城隍庙商业运营管理有限公司 |
| 建设地点 | 安徽省合肥市庐阳区安庆路城隍庙内 |
| 建设规模 | 总建筑面积约4646m2 |
| 计划工期 | 45日历天 |
| 质量标准 | 合格 |
针对45日历天的总工期，项目部将施工过程划分为四个阶段：第1～5日为施工准备阶段，完成现场围挡、临时水电接引、测量放线及拆除作业面准备。各阶段资源投入与进度管控详见后续章节。### 编制依据
#### 1.1.1 招标文件及补疑补遗
（1）工程量清单总说明及招标补疑中明确的招标范围修正内容。#### 危险源辨识与风险分级管控
本工程危险源辨识覆盖高处作业、临时用电、起重吊装等，共辨识危险源12项，其中重大危险源3项。#### 危大工程辨识范围与判定依据
依据住建部令第37号，本工程危大工程包括：模板工程及支撑体系、起重吊装及起重机械安装拆卸工程、脚手架工程。

## 第二章 确保工期与质量的保障体系与措施、确保安全生产的管理体系与措施

### 2.1 项目管理组织机构与职责

我公司针对本项目成立以项目经理为核心的项目管理组织机构。`;

describe('normalizeProjectBasicInfoTable 旧表删除边界回归', () => {
  it('表格后无空行直接连正文时，只删除旧表格，不吞并后续正文与章节标题行', () => {
    const result = normalizeProjectBasicInfoTable(MARKDOWN_TABLE_GLUED_TO_PROSE, PROJECT_FACTS);
    // 下一章 H2 标题行必须保留（历史缺陷：被旧表删除正则连坐吞掉，46 小节错位挂到上一章）
    expect(/^##\s+第二章\s+/mu.test(result)).toBe(true);
    // 表格后紧跟的正文段落必须保留（历史缺陷：`[\s\S]*?` 贪吞到小节末尾）
    expect(result).toContain('针对45日历天的总工期，项目部将施工过程划分为四个阶段');
    // 正文中的 H3/H4 标题与内容必须保留（历史缺陷：第一章 21632 字被吞至 866 字）
    expect(result).toContain('### 编制依据');
    expect(result).toContain('#### 危险源辨识与风险分级管控');
    expect(result).toContain('#### 危大工程辨识范围与判定依据');
    expect(result).toContain('起重吊装及起重机械安装拆卸工程');
    // 第二章内容保留
    expect(result).toContain('### 2.1 项目管理组织机构与职责');
    expect(result).toContain('我公司针对本项目成立以项目经理为核心的项目管理组织机构');
    // 新基本信息表已重建（含资料主表口径的合同估算价）
    expect(result).toContain('项目基本信息表');
    expect(result).toContain('1498.41万元');
  });

  it('表格后有空行分隔的正常场景：旧表格被替换，其余内容不受影响', () => {
    const markdown = MARKDOWN_TABLE_GLUED_TO_PROSE.replace(
      '| 质量标准 | 合格 |\n针对45日历天',
      '| 质量标准 | 合格 |\n\n针对45日历天',
    );
    const result = normalizeProjectBasicInfoTable(markdown, PROJECT_FACTS);
    expect(/^##\s+第二章\s+/mu.test(result)).toBe(true);
    expect(result).toContain('针对45日历天的总工期，项目部将施工过程划分为四个阶段');
    expect(result).toContain('#### 危大工程辨识范围与判定依据');
    expect(result).toContain('项目基本信息表');
  });

  it('工程概况小节无旧表时注入新表，不破坏后续小节结构', () => {
    const markdown = `## 第一章 工程重点难点及危大工程的保障体系

### 1.1 编制说明与工程概况

本施工组织设计针对徽光阁项目施工编制，编制深度满足指导现场施工的要求。#### 危险源辨识与风险分级管控
本工程危险源辨识覆盖高处作业、临时用电、起重吊装等，共辨识危险源12项。

## 第二章 确保工期与质量的保障体系与措施、确保安全生产的管理体系与措施

### 2.1 项目管理组织机构与职责

我公司针对本项目成立以项目经理为核心的项目管理组织机构。`;
    const result = normalizeProjectBasicInfoTable(markdown, PROJECT_FACTS);
    expect(/^##\s+第二章\s+/mu.test(result)).toBe(true);
    expect(result).toContain('#### 危险源辨识与风险分级管控');
    expect(result).toContain('项目基本信息表');
    expect(result).toContain('1498.41万元');
  });
});
