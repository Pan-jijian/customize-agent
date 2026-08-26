import { describe, expect, it } from 'vitest';
import { buildDocumentFactTraces, isActionableTraceFact } from '../src/services/document-workflow/documentFactTrace';
import type { DocumentFactsModel } from '../src/services/document-workflow/types';

function model(project: Array<Record<string, unknown>>): DocumentFactsModel {
  const toFacts = (items: Array<Record<string, unknown>>) => items.map(item => ({
    key: String(item.key ?? item.fieldName ?? '事实'),
    value: String(item.value),
    sourceFile: String(item.sourceFile ?? '结构化事实主表'),
    roleId: 'extractor',
    confidence: 0.9,
    fieldName: typeof item.fieldName === 'string' ? item.fieldName : undefined,
  }));
  return {
    project: toFacts(project),
    schedule: [],
    quality: [],
    safety: [],
    resources: [],
    tables: [],
    drawings: [],
    bills: [],
    preciseFacts: [],
    rules: [],
    specifications: [],
  } as unknown as DocumentFactsModel;
}

describe('buildDocumentFactTraces 脏事实清洗与片段匹配', () => {
  it('表格行尾巴被清洗：工程名称=室外道排工程 | | | | | 在正文落位后计入 used', () => {
    const facts = model([{ fieldName: '工程名称', value: '室外道排工程 | | | | |' }]);
    const traces = buildDocumentFactTraces('本工程名称为室外道排工程，包含雨污水管网及道路。', facts);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ label: '工程名称', value: '室外道排工程', status: 'used' });
  });

  it('条款尾巴被清洗：材料=胶圈接口 4．未尽事宜详见施工图纸… 清洗后按核心值匹配', () => {
    const facts = model([{ fieldName: '材料', value: '胶圈接口 4．未尽事宜详见施工图纸、补遗、招标文件、政府相关文件、规范等其他资料' }]);
    const traces = buildDocumentFactTraces('雨污水管道采用胶圈接口，接口处按规范施工。', facts);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ value: '胶圈接口', status: 'used' });
  });

  it('长列举值按核心片段匹配：招标范围=本项目维修改造包含室内装饰工程、门窗维修、屋面维修', () => {
    const facts = model([{ fieldName: '招标范围', value: '本项目维修改造包含室内装饰工程、门窗维修、屋面维修、' }]);
    const traces = buildDocumentFactTraces('本次改造包含室内装饰、门窗维修、屋面维修等施工内容。', facts);
    expect(traces[0]?.status).toBe('used');
  });

  it('数字+量词兜底匹配：本项目分为1个标段 在“共划分 1 个标段”表述下计入 used', () => {
    const facts = model([{ fieldName: '招标范围', value: '本项目分为1个标段' }]);
    const traces = buildDocumentFactTraces('本工程共划分 1 个标段，采用公开招标方式。', facts);
    expect(traces[0]?.status).toBe('used');
  });

  it('指向短语不作为可执行事实：见本项目招标补疑中的招标范围', () => {
    const facts = model([{ fieldName: '招标范围', value: '见本项目招标补疑中的招标范围' }]);
    const traces = buildDocumentFactTraces('招标范围详见补疑文件。', facts);
    expect(isActionableTraceFact(traces[0])).toBe(false);
  });

  it('标题+正文混合残留不作为可执行事实：项目编号=一、工程概况：本项目分为1个标段', () => {
    const facts = model([{ fieldName: '项目编号', value: '一、工程概况：本项目分为1个标段' }]);
    const traces = buildDocumentFactTraces('本工程共划分 1 个标段。', facts);
    expect(isActionableTraceFact(traces[0])).toBe(false);
  });
});
