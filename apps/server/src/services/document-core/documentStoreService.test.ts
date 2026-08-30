/**
 * documentStoreService 单测（homedir mock 到临时目录）：
 * 草稿保存（id 清洗/自动 id）/列表（时间排序/损坏文件跳过）/读取（清洗后查找）。
 * 绝不触碰真实 ~/.customize-agent/documents。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentFactsModel, GeneratedDocumentDraft } from '../document-workflow/types';
import { getDocumentDraft, listDocumentDrafts, saveDocumentDraft } from './documentStoreService';

let tempDir = '';

// Node ESM 命名空间不可配置，无法 spyOn；以模块级 mock 重定向 homedir 到临时目录
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tempDir };
});

// 测试只关心草稿的存储字段（title/id/updatedAt），factsModel 深层结构以空壳断言
const EMPTY_FACTS_MODEL = {
  project: [], schedule: [], quality: [], safety: [], resources: [],
  tables: [], drawings: [], bills: [], preciseFacts: [], rules: [], specifications: [],
  schemaFacts: {}, factIndex: {}, missing: [], conflicts: [],
} as unknown as DocumentFactsModel;

function makeDraft(partial: Partial<GeneratedDocumentDraft> = {}): GeneratedDocumentDraft {
  return {
    templateId: 'tpl-1',
    templateName: '施工组织设计模板',
    title: '施工组织设计',
    requirement: '',
    markdown: '正文',
    facts: {},
    structuredFacts: [],
    factsModel: EMPTY_FACTS_MODEL,
    chapters: [],
    sources: [],
    missingItems: [],
    validation: { passed: true, warnings: [], errors: [] },
    validationIssues: [],
    executionStages: [],
    exportGate: { passed: true, blockingIssues: [], checklist: [] },
    generatedAt: 0,
    ...partial,
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-store-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('saveDocumentDraft', () => {
  it('保存返回存储结构并落盘', () => {
    const stored = saveDocumentDraft(makeDraft(), 'draft-a');
    expect(stored.id).toBe('draft-a');
    expect(typeof stored.updatedAt).toBe('number');
    const file = path.join(tempDir, '.customize-agent', 'documents', 'draft-a.json');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('id 中非 [a-zA-Z0-9_-] 字符（含中文）清洗为连字符', () => {
    // '工程 草案/1（终）' → 工/程/空格/草/案/斜杠各 1 个连字符，1 保留，（）终各 1 个连字符
    const stored = saveDocumentDraft(makeDraft(), '工程 草案/1（终）');
    expect(stored.id).toBe('------1---');
  });

  it('未提供 id 时自动生成 draft-时间戳', () => {
    const stored = saveDocumentDraft(makeDraft());
    expect(stored.id).toMatch(/^draft-\d+$/u);
  });

  it('超长 id 截断至 80 字符', () => {
    const stored = saveDocumentDraft(makeDraft(), 'x'.repeat(200));
    expect(stored.id).toHaveLength(80);
  });

  it('同名 id 重复保存覆盖旧文件', () => {
    saveDocumentDraft(makeDraft({ title: '第一版' }), 'draft-a');
    saveDocumentDraft(makeDraft({ title: '第二版' }), 'draft-a');
    const loaded = getDocumentDraft('draft-a');
    expect(loaded?.title).toBe('第二版');
  });
});

describe('listDocumentDrafts', () => {
  it('按 updatedAt 降序排列', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(3000).mockReturnValueOnce(2000);
    saveDocumentDraft(makeDraft(), 'a');
    saveDocumentDraft(makeDraft(), 'b');
    saveDocumentDraft(makeDraft(), 'c');
    nowSpy.mockRestore();
    const list = listDocumentDrafts();
    expect(list.map(item => item.id)).toEqual(['b', 'c', 'a']);
  });

  it('损坏 JSON 文件跳过', () => {
    saveDocumentDraft(makeDraft(), 'good');
    fs.writeFileSync(path.join(tempDir, '.customize-agent', 'documents', 'broken.json'), '{ broken', 'utf-8');
    const list = listDocumentDrafts();
    expect(list.map(item => item.id)).toEqual(['good']);
  });

  it('非 json 文件跳过', () => {
    saveDocumentDraft(makeDraft(), 'good');
    fs.writeFileSync(path.join(tempDir, '.customize-agent', 'documents', 'note.txt'), '文本', 'utf-8');
    expect(listDocumentDrafts().map(item => item.id)).toEqual(['good']);
  });

  it('空目录返回空列表', () => {
    expect(listDocumentDrafts()).toEqual([]);
  });
});

describe('getDocumentDraft', () => {
  it('存在的草稿可读取', () => {
    saveDocumentDraft(makeDraft({ title: '目标草稿' }), 'draft-x');
    expect(getDocumentDraft('draft-x')?.title).toBe('目标草稿');
  });

  it('不存在的草稿返回 undefined', () => {
    expect(getDocumentDraft('missing')).toBeUndefined();
  });

  it('查询 id 先清洗再查找', () => {
    saveDocumentDraft(makeDraft(), '工程 草案/1（终）');
    expect(getDocumentDraft('工程 草案/1（终）')?.title).toBe('施工组织设计');
  });
});
