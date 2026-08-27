import { describe, expect, it } from 'vitest';
import { isRepairedSectionIssue, parseFinalGateRepairCandidate, replaceMarkdownSection } from '../src/services/document-workflow/documentPipeline';
import { constructionOrgMajorContentIssues } from '../src/services/document-workflow/constructionOrgQualityRules';
import type { DocumentDraftChapter } from '../src/services/document-workflow/types';

function draft(title: string, content: string, sections: string[] = []): DocumentDraftChapter {
  return { id: title, title, content, sections, evidence: [], missingFacts: [] };
}

function workPackage(name: string): string {
  return `#### ${name}\n施工概况：本工程${name}作业范围为三层框架结构，工程量约500㎡，材料为碳纤维布与配套浸渍胶。\n施工流程：定位放线→基层处理→实施→检查验收\n施工方法：基层清理→放线定位→涂刷底胶→分层粘贴→养护→隐蔽验收，碳纤维布搭接长度200mm，胶层厚度控制在6mm以内，常温养护不少于7日历天，隐蔽验收合格后方可进入下道工序。`;
}

function majorContentChapter(content: string): DocumentDraftChapter {
  return draft('工程重点难点及危大工程的保障体系', content, ['工程概况与主要施工内容', '工程特点与重难点分析']);
}

describe('Final Gate 修复定位（解析候选 + 可比标题定位 + 聚合块保护）', () => {
  describe('parseFinalGateRepairCandidate', () => {
    it('解析锚点小节缺失消息并映射回标准锚点标题', () => {
      const parsed = parseFinalGateRepairCandidate({ level: 'error', severity: 'blocker', message: '工程重点难点及危大工程的保障体系 主要施工内容小节缺失或标题结构异常' });
      expect(parsed).toEqual({ issue: { level: 'error', severity: 'blocker', message: '工程重点难点及危大工程的保障体系 主要施工内容小节缺失或标题结构异常' }, chapterTitle: '工程重点难点及危大工程的保障体系', sectionTitle: '项目主要施工内容', critical: true });
    });

    it('解析分部分项锚点缺失消息并映射回标准锚点标题', () => {
      const parsed = parseFinalGateRepairCandidate({ level: 'error', severity: 'blocker', message: '确保工期与质量的保障体系与措施 分部分项工程施工方案小节缺失或标题结构异常' });
      expect(parsed?.chapterTitle).toBe('确保工期与质量的保障体系与措施');
      expect(parsed?.sectionTitle).toBe('主要分部分项工程施工方案');
      expect(parsed?.critical).toBe(true);
    });

    it('解析深度不足消息并识别关键小节优先级', () => {
      const parsed = parseFinalGateRepairCandidate({ level: 'error', severity: 'blocker', message: '工程重点难点及危大工程的保障体系 项目特点、重点、难点分析 正文不足：当前 831 字，要求不少于 1440 字' });
      expect(parsed?.chapterTitle).toBe('工程重点难点及危大工程的保障体系');
      expect(parsed?.sectionTitle).toBe('项目特点、重点、难点分析');
      expect(parsed?.critical).toBe(true);
    });

    it('解析缺少"XXX"小节消息', () => {
      const parsed = parseFinalGateRepairCandidate({ level: 'error', severity: 'blocker', message: '施工组织设计缺少"项目主要施工内容"小节' });
      expect(parsed?.sectionTitle).toBe('项目主要施工内容');
      expect(parsed?.critical).toBe(true);
    });

    it('非结构类 error 不进修复循环', () => {
      expect(parseFinalGateRepairCandidate({ level: 'error', severity: 'blocker', message: '已确认事实未在正文中落位：招标人' })).toBeUndefined();
    });
  });

  describe('replaceMarkdownSection 可比标题定位', () => {
    it('规划标题与成稿标题语义重写时按可比归一化定位替换（重点难点分析）', () => {
      const content = '### 1.2 工程特点与重难点分析\n\n#### 1.2.10 项目重点难点分析\n\n旧正文 831 字。\n';
      const next = replaceMarkdownSection(content, '项目特点、重点、难点分析', '### 项目特点、重点、难点分析\n\n新正文补写至 1500 字以上。');
      expect(next).toContain('#### 1.2.10 项目重点难点分析');
      expect(next).toContain('新正文补写至 1500 字以上。');
      expect(next).not.toContain('旧正文 831 字。');
      expect(next).not.toContain('### 项目特点、重点、难点分析');
    });

    it('聚合主题块（H3 下含 H4 子小节，含空行间隔）不被单小节替换', () => {
      const merged = '### 1.1 工程概况与主要施工内容\n\n#### 1.1.1 项目基本信息表\n| 项目名称 | 徽光阁 |\n\n#### 1.1.2 工程概况及编制说明\n概况正文。\n';
      expect(replaceMarkdownSection(merged, '项目主要施工内容', '#### 拆除工程\n新正文')).toBe(merged);
    });

    it('无 H4 子小节的合并标题 H3 可按可比标题定位替换', () => {
      const content = '### 1.1 工程概况与主要施工内容\n\n概况与内容混合正文。\n';
      const next = replaceMarkdownSection(content, '项目主要施工内容', '#### 拆除工程\n补写工作包正文。');
      expect(next).toContain('### 1.1 工程概况与主要施工内容');
      expect(next).toContain('补写工作包正文。');
      expect(next).not.toContain('概况与内容混合正文。');
    });

    it('精确标题命中仍按工作包边界整体替换（回归）', () => {
      const content = '## 第一章\n### 项目主要施工内容\n\n#### 拆除工程\n旧工作包\n\n### 后续小节\n后续内容。';
      const next = replaceMarkdownSection(content, '项目主要施工内容', '### 项目主要施工内容\n\n#### 拆除工程\n新工作包一\n#### 加固工程\n新工作包二');
      expect(next).not.toContain('旧工作包');
      expect(next).toContain('新工作包二');
      expect(next).toContain('### 后续小节');
    });
  });

  describe('isRepairedSectionIssue 旧快照过滤', () => {
    it('锚点缺失旧 blocker 按缩写锚点命中过滤（去"项目"前缀）', () => {
      expect(isRepairedSectionIssue('工程重点难点及危大工程的保障体系 主要施工内容小节缺失或标题结构异常', '工程重点难点及危大工程的保障体系', '项目主要施工内容')).toBe(true);
    });

    it('深度不足旧 blocker 按完整小节标题命中过滤', () => {
      expect(isRepairedSectionIssue('工程重点难点及危大工程的保障体系 项目特点、重点、难点分析 正文不足：当前 831 字，要求不少于 1440 字', '工程重点难点及危大工程的保障体系', '项目特点、重点、难点分析')).toBe(true);
    });

    it('非结构类消息不过滤', () => {
      expect(isRepairedSectionIssue('已确认事实未在正文中落位：招标人', '工程重点难点及危大工程的保障体系', '项目主要施工内容')).toBe(false);
    });
  });

  describe('constructionOrgMajorContentIssues 合并标题 fallback', () => {
    it('合并标题且块内 5 个三段式工作包齐全时不误报缺失', () => {
      const chapter = majorContentChapter(`### 1.1 工程概况与主要施工内容\n\n${['拆除工程', '结构加固工程', '室内装饰工程', '给排水安装工程', '屋面维修工程'].map(workPackage).join('\n\n')}`);
      const issues = constructionOrgMajorContentIssues([chapter]);
      expect(issues.some(issue => issue.message.includes('小节缺失或标题结构异常'))).toBe(false);
    });

    it('合并标题但块内是概况型子小节（无工作包）时判小节缺失（可修复语义）', () => {
      const chapter = majorContentChapter('### 1.1 工程概况与主要施工内容\n\n#### 1.1.1 项目基本信息表\n| 信息项 | 内容 |\n\n#### 1.1.2 工程概况及编制说明\n概况正文。\n');
      const issues = constructionOrgMajorContentIssues([chapter]);
      expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('主要施工内容小节缺失或标题结构异常'))).toBe(true);
    });

    it('标准标题 + 5 个三段式工作包不产生阻断（回归）', () => {
      const chapter = majorContentChapter(`### 项目主要施工内容\n\n${['拆除工程', '结构加固工程', '室内装饰工程', '给排水安装工程', '屋面维修工程'].map(workPackage).join('\n\n')}`);
      expect(constructionOrgMajorContentIssues([chapter]).filter(issue => issue.level === 'error')).toEqual([]);
    });
  });
});
