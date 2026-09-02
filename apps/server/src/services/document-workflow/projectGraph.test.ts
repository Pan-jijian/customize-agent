/**
 * projectGraph 单测：LLM 分域图谱构建（六域并发/归一化/合并/校验/重试/缓存/中止）、
 * 图谱提示词渲染。缓存目录落在 HOME/.customize-agent/cache/document-workflow/<hash(projectRoot)>，
 * 使用临时 projectRoot 隔离并在 afterAll 清理。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const llmJsonMock = vi.hoisted(() => vi.fn<(system: string, prompt: string, options?: unknown) => Promise<unknown>>());
vi.mock('./llmClient', () => ({
  callDocumentLlmJson: llmJsonMock,
}));

import { buildProjectGraph, projectGraphPrompt } from './projectGraph';
import { stableHash } from './utils';
import type { DocumentEvidence } from './types';

const evidence = (overrides: Partial<DocumentEvidence> = {}): DocumentEvidence => ({
  chapterId: 'c-1',
  filePath: '/data/招标文件.docx',
  score: 10,
  content: '本工程招标范围为土建及安装工程施工，计划工期420日历天，质量要求一次性验收合格，主要材料按清单供应。',
  ...overrides,
});

/** 每个用例独立临时 projectRoot：缓存 key 由 projectRoot 哈希派生，隔离用例间缓存复用 */
let tempRoot = '';

/**
 * 从 system 中提取分域标记「当前只抽取分域：{title}」的 title（projectGraph.ts callDomain 拼接）。
 * 3.1 system 前缀统一后 FORMAL_WRITING_RULES 全文进入 system（含「项目基本信息表」等词），
 * 直接 system.includes 路由会被前缀文本污染，改按分域标记路由与调用点同源、不受前缀变化影响。
 */
function domainTitleOf(system: string): string {
  return /当前只抽取分域：(.+?)。/u.exec(system)?.[1] || '';
}

/** 六域各返回一类节点（含来源文件），满足 validation 全部要求 */
function mockFullDomains() {
  llmJsonMock.mockImplementation(async (system: string) => {
    const domainTitle = domainTitleOf(system);
    if (domainTitle.includes('项目基本信息')) return { works: [{ name: '土方开挖', scope: '基坑土方开挖与运输', sourceFiles: ['/data/招标文件.docx'], relatedItems: [] }] };
    if (domainTitle.includes('关键施工方法')) return { methods: [{ name: '分层开挖法', steps: ['定位', '开挖'], applicableWorks: ['土方开挖'], sourceFiles: ['/data/招标文件.docx'] }] };
    if (domainTitle.includes('材料、设备')) return { resources: [{ name: '水泥', type: 'material', spec: 'P.O42.5', quantity: '100', unit: '吨', sourceFiles: ['/data/招标文件.docx'] }] };
    if (domainTitle.includes('工期节点')) return { schedule: [{ milestone: '开工', duration: '420日历天', startDate: '2026-01-01', endDate: '2026-12-31', sourceFiles: ['/data/招标文件.docx'] }], standards: [{ code: 'GB50300', description: '质量验收标准', sourceFiles: ['/data/招标文件.docx'] }] };
    if (domainTitle.includes('现场条件')) return { risks: [{ risk: '地下管线复杂', level: 'high', mitigation: '先探后挖', sourceFiles: ['/data/招标文件.docx'] }] };
    if (domainTitle.includes('招标管理要求')) return { requirements: [{ category: '评标办法', detail: '技术评分合理价格法', sourceFiles: ['/data/招标文件.docx'] }] };
    return undefined;
  });
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-graph-test-'));
  llmJsonMock.mockReset();
  mockFullDomains();
});

afterEach(() => {
  fs.rmSync(path.join(os.homedir(), '.customize-agent', 'cache', 'document-workflow', stableHash(tempRoot)), { recursive: true, force: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('buildProjectGraph', () => {
  it('无证据 → 失败阶段（不发起 LLM 调用）', async () => {
    const result = await buildProjectGraph({ evidence: [], projectRoot: tempRoot });
    expect(result.graph).toBeUndefined();
    expect(result.stage.status).toBe('failed');
    expect(result.stage.message).toContain('未检索到项目证据');
    expect(llmJsonMock).not.toHaveBeenCalled();
  });

  it('六域分域抽取合并：图谱节点与成功阶段摘要', async () => {
    const result = await buildProjectGraph({ evidence: [evidence()], projectRoot: tempRoot });
    expect(result.graph?.works).toHaveLength(1);
    expect(result.graph?.methods).toHaveLength(1);
    expect(result.graph?.resources).toHaveLength(1);
    expect(result.graph?.schedule).toHaveLength(1);
    expect(result.graph?.standards).toHaveLength(1);
    expect(result.graph?.risks).toHaveLength(1);
    expect(result.graph?.requirements).toHaveLength(1);
    expect(llmJsonMock).toHaveBeenCalledTimes(6);
    expect(result.stage.status).toBe('success');
    expect(result.stage.roleId).toBe('project-graph');
    expect(result.stage.message).toContain('1工程 1工法 1资源 1节点 1标准 1风险 1要求');
    expect(result.stage.subtitle).toBe('项目图谱分析');
  });

  it('归一化：非法条目过滤、超长截断、来源文件按路径或 basename 校验、枚举回退', async () => {
    llmJsonMock.mockImplementation(async (system: string) => {
      if (domainTitleOf(system).includes('项目基本信息')) {
        return {
          works: [
            { name: 'x'.repeat(300), scope: '范围描述', sourceFiles: ['/data/招标文件.docx', '/data/不存在.pdf', '/elsewhere/招标文件.docx'], relatedItems: [] },
            { name: 123, scope: '非法条目', sourceFiles: [], relatedItems: [] },
          ],
          resources: [{ name: '水泥', type: 'invalid', spec: '', quantity: '', unit: '', sourceFiles: [] }],
          risks: [{ risk: '地下管线复杂', level: 'invalid', mitigation: '', sourceFiles: [] }],
        };
      }
      return undefined;
    });
    const result = await buildProjectGraph({ evidence: [evidence()], projectRoot: tempRoot });
    expect(result.graph?.works).toHaveLength(1);
    expect(result.graph?.works[0]?.name).toHaveLength(200);
    expect(result.graph?.works[0]?.sourceFiles).toEqual(['/data/招标文件.docx', '/elsewhere/招标文件.docx']);
    expect(result.graph?.resources[0]?.type).toBe('material');
    expect(result.graph?.risks[0]?.level).toBe('medium');
  });

  it('分域多图去重合并：重复节点只保留一份', async () => {
    llmJsonMock.mockImplementation(async () => ({ works: [{ name: '土方开挖', scope: '相同范围', sourceFiles: ['/data/招标文件.docx'], relatedItems: [] }] }));
    const result = await buildProjectGraph({ evidence: [evidence()], projectRoot: tempRoot });
    expect(result.graph?.works).toHaveLength(1);
  });

  it('首轮全空 → 校验失败带原因 → 定向修复重试成功（共 12 次调用）', async () => {
    let calls = 0;
    llmJsonMock.mockImplementation(async () => {
      calls += 1;
      if (calls <= 6) return undefined;
      return {
        works: [{ name: '土方开挖', scope: '基坑土方开挖与运输', sourceFiles: ['/data/招标文件.docx'], relatedItems: [] }],
        schedule: [{ milestone: '开工', duration: '420日历天', startDate: '', endDate: '', sourceFiles: ['/data/招标文件.docx'] }],
        standards: [{ code: 'GB50300', description: '质量验收标准', sourceFiles: ['/data/招标文件.docx'] }],
        resources: [{ name: '水泥', type: 'material', spec: '', quantity: '', unit: '', sourceFiles: ['/data/招标文件.docx'] }],
      };
    });
    const result = await buildProjectGraph({ evidence: [evidence()], projectRoot: tempRoot });
    expect(llmJsonMock).toHaveBeenCalledTimes(12);
    expect(result.graph?.works).toHaveLength(1);
    expect(result.stage.status).toBe('success');
  });

  it('首轮重试均失败 → 失败阶段含校验与域失败原因', async () => {
    llmJsonMock.mockImplementation(async () => undefined);
    const result = await buildProjectGraph({ evidence: [evidence()], projectRoot: tempRoot });
    expect(result.graph).toBeUndefined();
    expect(result.stage.status).toBe('failed');
    expect(result.stage.details?.some(item => item.includes('未抽取到有效节点'))).toBe(true);
  });

  it('缓存复用：相同证据第二次构建命中缓存且不再调用 LLM', async () => {
    const first = await buildProjectGraph({ evidence: [evidence()], projectRoot: tempRoot });
    expect(first.stage.message).not.toContain('复用缓存');
    llmJsonMock.mockClear();
    const second = await buildProjectGraph({ evidence: [evidence()], projectRoot: tempRoot });
    expect(second.stage.message).toContain('复用缓存');
    expect(llmJsonMock).not.toHaveBeenCalled();
    expect(second.graph?.works).toHaveLength(1);
  });

  it('单域 LLM 抛错（非中止）→ 记录域失败原因，其余域成功仍产出图谱', async () => {
    llmJsonMock.mockImplementation(async (system: string) => {
      if (domainTitleOf(system).includes('现场条件')) throw new Error('domain boom');
      return { works: [{ name: '土方开挖', scope: '基坑土方开挖与运输', sourceFiles: ['/data/招标文件.docx'], relatedItems: [] }], schedule: [{ milestone: '开工', duration: '420日历天', startDate: '', endDate: '', sourceFiles: ['/data/招标文件.docx'] }], standards: [{ code: 'GB50300', description: '质量验收标准', sourceFiles: ['/data/招标文件.docx'] }], resources: [{ name: '水泥', type: 'material', spec: '', quantity: '', unit: '', sourceFiles: ['/data/招标文件.docx'] }] };
    });
    const result = await buildProjectGraph({ evidence: [evidence()], projectRoot: tempRoot });
    expect(result.graph?.works).toHaveLength(1);
    expect(result.stage.status).toBe('success');
  });

  it('中止信号 → 抛错（含调用过程中的中止检查）', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(buildProjectGraph({ evidence: [evidence()], signal: controller.signal, projectRoot: tempRoot })).rejects.toThrow();
    expect(llmJsonMock).not.toHaveBeenCalled();
  });
});

describe('projectGraphPrompt', () => {
  it('空图谱 → 仅输出标题头', () => {
    const prompt = projectGraphPrompt({ works: [], methods: [], resources: [], schedule: [], standards: [], risks: [], requirements: [], siteConditions: [], addendumChanges: [], gaps: [], generatedAt: 0 });
    expect(prompt).toBe('## 项目资料图谱分析结果\n');
  });

  it('各分节渲染：工程/工法/资源/节点/标准/风险/要求/条件/修正/缺口', () => {
    const prompt = projectGraphPrompt({
      works: [{ name: '土方开挖', scope: '基坑土方开挖与运输', sourceFiles: [], relatedItems: [] }],
      methods: [{ name: '分层开挖法', steps: ['定位', '开挖', '验收'], applicableWorks: [], sourceFiles: [] }],
      resources: [
        { name: '水泥', type: 'material', spec: 'P.O42.5', quantity: '100', unit: '吨', sourceFiles: [] },
        { name: '挖机', type: 'equipment', spec: 'PC200', quantity: '2', unit: '台', sourceFiles: [] },
        { name: '普工', type: 'labor', spec: '', quantity: '20', unit: '人', sourceFiles: [] },
      ],
      schedule: [{ milestone: '开工', duration: '420日历天', startDate: '2026-01-01', endDate: '2026-12-31', sourceFiles: [] }],
      standards: [{ code: 'GB50300', description: '质量验收标准', sourceFiles: [] }],
      risks: [{ risk: '地下管线复杂', level: 'high', mitigation: '先探后挖', sourceFiles: [] }],
      requirements: [{ category: '评标办法', detail: '技术评分合理价格法', sourceFiles: [] }],
      siteConditions: [{ condition: '场地狭小', impact: '布置受限', sourceFiles: [] }],
      addendumChanges: [{ originalPath: '/data/补疑.pdf', original: '原工期400天', revised: '改为420天', sourceFile: '/data/补疑.pdf' }],
      gaps: ['缺少地质勘察报告'],
      generatedAt: 0,
    });
    expect(prompt).toContain('### 主要工程内容');
    expect(prompt).toContain('- **土方开挖**：基坑土方开挖与运输');
    expect(prompt).toContain('### 关键施工方法与工艺');
    expect(prompt).toContain('- **分层开挖法**：定位 → 开挖 → 验收');
    expect(prompt).toContain('### 资源需求');
    expect(prompt).toContain('- [材料] 水泥（P.O42.5） 100吨');
    expect(prompt).toContain('- [设备] 挖机（PC200） 2台');
    expect(prompt).toContain('- [劳动力] 普工 20人');
    expect(prompt).toContain('### 工期与关键节点');
    expect(prompt).toContain('- 开工：420日历天（2026-01-01 ~ 2026-12-31）');
    expect(prompt).toContain('### 技术标准与验收要求');
    expect(prompt).toContain('- **GB50300**：质量验收标准');
    expect(prompt).toContain('### 重点难点与风险');
    expect(prompt).toContain('- **[high] 地下管线复杂**：先探后挖');
    expect(prompt).toContain('### 特定要求');
    expect(prompt).toContain('- [评标办法] 技术评分合理价格法');
    expect(prompt).toContain('### 现场条件与约束');
    expect(prompt).toContain('- 场地狭小：布置受限');
    expect(prompt).toContain('### 补疑修正');
    expect(prompt).toContain('"原工期400天" → "改为420天"');
    expect(prompt).toContain('### 资料缺口');
    expect(prompt).toContain('- 缺少地质勘察报告');
  });
});
