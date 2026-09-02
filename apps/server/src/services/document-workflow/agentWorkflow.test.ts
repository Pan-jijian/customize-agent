/**
 * agentWorkflow 单测：resolveAgentMaterialScope 的资料范围解析——
 * 需求唯一匹配、模板唯一绑定、多资料组歧义、不可用文件过滤，
 * 以及 4.17.3 多项目指纹阻断（同一资料组内 ≥2 个不同项目编号 → 阻断避免跨项目污染）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type KnowledgeFile = { relativePath: string; chunkCount?: number; indexedAt?: number; status?: string };
const listKnowledgeFilesMock = vi.hoisted(() => vi.fn<(projectRoot: string) => KnowledgeFile[]>());
vi.mock('../knowledge/kbService', () => ({ listKnowledgeFiles: listKnowledgeFilesMock }));

import { resolveAgentMaterialScope } from './agentWorkflow';
import type { DocumentTemplate } from './types';

const file = (relativePath: string, overrides: Partial<KnowledgeFile> = {}): KnowledgeFile => ({ relativePath, chunkCount: 10, indexedAt: 123, status: 'ready', ...overrides });

const template = (overrides: Partial<DocumentTemplate> = {}): DocumentTemplate => ({ id: 't-1', name: '房建施工组织设计', description: '', category: '施工组织设计', outputTitle: '施工组织设计', chapters: [], ...overrides });

beforeEach(() => {
  listKnowledgeFilesMock.mockReset();
});

describe('resolveAgentMaterialScope 多项目指纹阻断（4.17.3）', () => {
  it('需求唯一匹配的资料组内混放两份项目资料（两个项目编号）→ 阻断生成避免跨项目污染', () => {
    listKnowledgeFilesMock.mockReturnValue([
      file('庐江项目/2026ANNGZ50062招标文件.docx'),
      file('庐江项目/2026ANNGZ50062补疑.pdf'),
      file('庐江项目/2026ANNGZ50112工程量清单.xlsx'),
    ]);
    const scope = resolveAgentMaterialScope('/proj', template(), '庐江项目施工组织设计');
    expect(scope.ambiguous).toBe(true);
    expect(scope.locked).toBe(false);
    expect(scope.selectedFiles).toEqual([]);
    expect(scope.reason).toContain('已阻断生成避免跨项目污染');
    expect(scope.reason).toContain('2026ANNGZ50062');
    expect(scope.reason).toContain('2026ANNGZ50112');
  });

  it('模板绑定唯一资料组内混放两份项目资料 → 同样阻断', () => {
    listKnowledgeFilesMock.mockReturnValue([
      file('庐江项目/2026ANNGZ50062招标文件.docx'),
      file('庐江项目/2026ANNGZ50112工程量清单.xlsx'),
    ]);
    const scope = resolveAgentMaterialScope('/proj', template({ projectBindings: [{ materialRootPath: '庐江项目' }] }));
    expect(scope.ambiguous).toBe(true);
    expect(scope.locked).toBe(false);
    expect(scope.selectedFiles).toEqual([]);
    expect(scope.reason).toContain('已阻断生成避免跨项目污染');
  });

  it('同一项目编号跨多文件（招标+补疑+清单同号）→ Set 去重不误伤，正常锁定', () => {
    listKnowledgeFilesMock.mockReturnValue([
      file('庐江项目/2026ANNGZ50062招标文件.docx'),
      file('庐江项目/2026ANNGZ50062补疑.pdf'),
      file('庐江项目/2026ANNGZ50062工程量清单.xlsx'),
    ]);
    const scope = resolveAgentMaterialScope('/proj', template(), '庐江项目施工组织设计');
    expect(scope.ambiguous).toBe(false);
    expect(scope.locked).toBe(true);
    expect(scope.selectedFiles).toHaveLength(3);
  });

  it('文件名不含项目编号 → 不触发指纹阻断，保持原锁定行为', () => {
    listKnowledgeFilesMock.mockReturnValue([
      file('庐江项目/招标文件.docx'),
      file('庐江项目/工程量清单.xlsx'),
    ]);
    const scope = resolveAgentMaterialScope('/proj', template(), '庐江项目施工组织设计');
    expect(scope.ambiguous).toBe(false);
    expect(scope.locked).toBe(true);
    expect(scope.selectedFiles).toHaveLength(2);
  });
});
