/**
 * 4.59 R-B5 表达质量三族**接线**用例矩阵（短语级套话 / 条款体复述 / 表格内容泄漏）。
 *
 * 背景：三族的检测判据早就在 tenderBidChecks §10 里（R9-a/b/d），但**只产出事实、零调用点**——
 * 既不进块质检、也不进写作期任务卡、也不进章成稿复核，等于"查了没人用"。本批按 P0 门声明的
 * 处置通道逐族接线（declared disposition ↔ 实际调用点一致），本文件锁住"接在哪、按什么阈值开火、
 * 不误伤什么"。
 *
 * 判据单源：三族判据实现均在 tenderBidChecks（`scanZeroInfoFillerPhrases` /
 * `scanClauseRecitationSentences` / `scanTableLeakParagraphs`），本文件只做接线与阈值断言，
 * 不复制判据；块级/章级包装（`scanBlockFillerPhrases` / `chapterTableLeakIssues`）必须与其同源。
 *
 * 用例文本逐字取自实测（4.59 交付物），不用抽象样例。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TenderBidChecksModule from '@/services/document-workflow/tenderBidChecks';

/** 判据模块的受控替身：默认走真实实现（实现取自 importOriginal，不能取自被 mock 的导入绑定，否则自递归），
 *  仅"扫描器抛错"用例替换为抛错（零静默降级断言）。 */
const mockState = vi.hoisted(() => ({ real: undefined as undefined | ((markdown: string) => string[]) }));
const scanTableLeakParagraphsMock = vi.hoisted(() => vi.fn());
vi.mock('@/services/document-workflow/tenderBidChecks', async (importOriginal) => {
  const actual = await importOriginal<typeof TenderBidChecksModule>();
  mockState.real = actual.scanTableLeakParagraphs;
  scanTableLeakParagraphsMock.mockImplementation(actual.scanTableLeakParagraphs);
  return { ...actual, scanTableLeakParagraphs: scanTableLeakParagraphsMock };
});

import { scanClauseRecitationSentences, scanTableLeakParagraphs, scanZeroInfoFillerPhrases, TABLE_LEAK_MIN_BOOK_CITATIONS } from '@/services/document-workflow/tenderBidChecks';
import { BLOCK_FILLER_PHRASE_LIMIT, fillerPhraseBlockingOf, scanBlockFillerPhrases } from '@/services/document-workflow/blockQualityExecutors';
import { chapterTableLeakIssues } from '@/services/document-workflow/chapterReview';
import { BLOCK_FAILURE_KIND_LABELS, blockFailureReasonText } from '@/services/document-workflow/chapterGeneration';
import { AUXILIARY_DETECTORS, DETECTOR_WRITING_TIME_DISPOSITIONS, assertRegistryConsistency, detectorEntry } from '@/services/document-workflow/detectorFixerRegistry';
import type { DocumentGenerationDiagnostics } from '@/services/document-workflow/types';

// ── 实测缺陷原文（逐字取自 4.59 交付物）──
/** 短语级套话（实测缺陷：句子确有实质内容，套话嵌在子句里——句级模板化门因此恒不开火） */
const MEASURED_FILLER_SENTENCE = '塘渣石垫层、水泥稳定碎（砾）石各分项施工质量验收统一以“精心组织施工”为总控目标，检验批验收逐级对照核验。';
const MEASURED_FILLER_SENTENCE_2 = '本工程质量标准为精心组织施工。';
/** 条款体复述（实测：整段来自招标文件条款、零本项目信息，未被任何一层拦住） */
const MEASURED_CLAUSE = '我方在任何时候都应采取各种合理的预防措施，防止其员工发生任何违法、违禁、暴力或妨碍治安的行为，并在施工过程中严格遵守国家和地方有关规定。';
/** 表格内容泄漏（实测：编制依据表条目被倒成书名号枚举散文段、无主谓） */
const MEASURED_LEAK = '《建筑桩基技术规范》（JGJ 94-2008）、《建筑机电工程抗震设计规范》（GB 50981-2014）、《混凝土结构工程施工质量验收规范》（GB 50204-2015）、《建筑施工组织设计规范》（GB/T 50502-2009）、《建筑地面工程施工质量验收规范》（GB 50209-2010）、《建设工程施工现场消防安全技术规范》（GB 50720-2011）、《建筑工程冬期施工规程》（JGJ/T 104）。';
/** 合法依据引用段（有主谓：真缺陷仍须报的反面——这类段不得被判泄漏） */
const LEGIT_BASIS_PARAGRAPH = '本工程执行《建筑桩基技术规范》（JGJ 94-2008）、《建筑机电工程抗震设计规范》（GB 50981-2014）、《混凝土结构工程施工质量验收规范》（GB 50204-2015）等标准组织施工，由项目技术负责人组织交底。';

function diagnosticsStub(): DocumentGenerationDiagnostics {
  return { llm: {} } as unknown as DocumentGenerationDiagnostics;
}

describe('R-B5 接线①：三族检测器声明与处置通道（声明表 ↔ 实际调用点一致）', () => {
  it('三族均已登记为 auxiliary 检测器，且处置通道与实现通道一致（self-check/constraint）', () => {
    const entries = Object.fromEntries(AUXILIARY_DETECTORS.map(entry => [entry.id, entry]));
    expect(entries['block-filler-phrase']).toMatchObject({ scope: 'chapter', category: 'style', deterministicSafe: true });
    expect(entries['clause-recitation']).toMatchObject({ scope: 'chapter', category: 'style', deterministicSafe: true });
    expect(entries['table-content-leak']).toMatchObject({ scope: 'chapter', category: 'table', deterministicSafe: true });
    // 处置通道 = 实际接线的通道：块成稿后自检 / 块任务卡约束 / 章成稿后自检
    expect(DETECTOR_WRITING_TIME_DISPOSITIONS['block-filler-phrase']).toEqual({ kind: 'self-check', stage: '块成稿后' });
    expect(DETECTOR_WRITING_TIME_DISPOSITIONS['clause-recitation']).toEqual({ kind: 'constraint', channel: '块任务卡' });
    expect(DETECTOR_WRITING_TIME_DISPOSITIONS['table-content-leak']).toEqual({ kind: 'self-check', stage: '章成稿后' });
    // 三族都不在"欠账"清单里（声明了处置就必须给出通道）
    expect(detectorEntry('block-filler-phrase')?.fixerDisposition).toBe('exempt');
    expect(detectorEntry('clause-recitation')?.fixerDisposition).toBe('exempt');
    expect(detectorEntry('table-content-leak')?.fixerDisposition).toBe('exempt');
  });

  it('注册表结构一致性检查通过（新增登记未破坏权威集合/锚定/覆盖规则）', () => {
    expect(() => assertRegistryConsistency()).not.toThrow();
  });

  it('不变：块失败类别复用既有 templating 键（人话原因映射不被新族撕裂）', () => {
    expect(BLOCK_FAILURE_KIND_LABELS.templating).toBe('模板化套话超标');
    expect('block-filler-phrase' in BLOCK_FAILURE_KIND_LABELS).toBe(false);
    expect(blockFailureReasonText(['templating', 'under-produce'])).toBe('模板化套话超标、篇幅欠产');
  });
});

describe('R-B5 接线①-a：块级短语级套话（scanBlockFillerPhrases → 首轮阻断）', () => {
  it('正向：实测套话句 → 命中 1 处，短语与所属整句同时给出（改写锚点 + 上下文）', () => {
    const verdict = scanBlockFillerPhrases(MEASURED_FILLER_SENTENCE);
    expect(verdict.count).toBe(1);
    expect(verdict.phrases).toEqual(['精心组织施工']);
    expect(verdict.sentences[0]).toContain('塘渣石垫层、水泥稳定碎（砾）石各分项施工质量验收统一');
    expect(verdict.totalSentences).toBe(1);
  });

  it('正向：两处套话句 → 命中 2 处（短语各异：子句短语 与 整句式短语）', () => {
    const verdict = scanBlockFillerPhrases(`${MEASURED_FILLER_SENTENCE}\n${MEASURED_FILLER_SENTENCE_2}`);
    expect(verdict.count).toBe(2);
    expect(verdict.phrases).toEqual(['精心组织施工', '本工程质量标准为精心组织施工']);
  });

  it('正向：与判据单源（tenderBidChecks.scanZeroInfoFillerPhrases）逐条一致，不另造口径', () => {
    const sourceHits = scanZeroInfoFillerPhrases(`${MEASURED_FILLER_SENTENCE}\n${MEASURED_FILLER_SENTENCE_2}`);
    const verdict = scanBlockFillerPhrases(`${MEASURED_FILLER_SENTENCE}\n${MEASURED_FILLER_SENTENCE_2}`);
    expect(verdict.count).toBe(sourceHits.length);
    expect(verdict.phrases).toEqual([...new Set(sourceHits.map(hit => hit.phrase))]);
    expect(sourceHits.every(hit => hit.channel === 'zero-info')).toBe(true);
  });

  it('反向（防误伤实质内容）：含数字/部位/频次的实质句 → 0 处（阈值下侧）', () => {
    const verdict = scanBlockFillerPhrases('塘渣石垫层厚度为 300mm，采用 20t 振动压路机碾压不少于 4 遍，压实度不低于 96%。');
    expect(verdict.count).toBe(0);
    expect(verdict.totalSentences).toBe(1);
  });

  it('反向（防误伤规范引用）：带修饰词的规范行文（按最高标准执行）→ 0 处', () => {
    expect(scanBlockFillerPhrases('标准之间要求不一致时按最高标准执行，由项目技术负责人组织复核后确定。').count).toBe(0);
  });

  it('反向（族边界）：条款体复述不归本族（由 R-B5 ② 写作期约束处置）→ 本族 0 处', () => {
    expect(scanBlockFillerPhrases(MEASURED_CLAUSE).count).toBe(0);
  });

  it('边界（阈值 ±1）：命中 0 处放行 / 命中 1 处即阻断（BLOCK_FILLER_PHRASE_LIMIT = 1）', () => {
    expect(BLOCK_FILLER_PHRASE_LIMIT).toBe(1);
    expect(fillerPhraseBlockingOf({ count: 0, phrases: [], sentences: [], totalSentences: 8 })).toBe(false);
    expect(fillerPhraseBlockingOf(scanBlockFillerPhrases(MEASURED_FILLER_SENTENCE))).toBe(true);
  });

  it('边界（载体行）：列表行/表格行内的同一短语不入句池 → 0 处（表格条目是正确载体，不判泄漏/套话）', () => {
    const listVerdict = scanBlockFillerPhrases('- 精心组织施工\n- 本工程质量标准为精心组织施工。');
    expect(listVerdict.count).toBe(0);
    expect(listVerdict.totalSentences).toBe(0);
    const tableVerdict = scanBlockFillerPhrases('| 1 | 精心组织施工 | 逐级核验 |');
    expect(tableVerdict.count).toBe(0);
    expect(tableVerdict.totalSentences).toBe(0);
  });

  it('边界（空输入）：空文本 → 0 处、0 句，不阻断', () => {
    const verdict = scanBlockFillerPhrases('');
    expect(verdict).toEqual({ count: 0, phrases: [], sentences: [], totalSentences: 0 });
    expect(fillerPhraseBlockingOf(verdict)).toBe(false);
  });
});

describe('R-B5 接线②：条款体复述（写作期约束的判据来源）', () => {
  it('正向：实测条款句 → 命中（块任务卡据此把约束升级为带计数的点名约束）', () => {
    expect(scanClauseRecitationSentences(MEASURED_CLAUSE)).toEqual([expect.stringContaining('我方在任何时候都应采取各种合理的预防措施')]);
  });

  it('反向（防误伤本项目实质句）：含强度等级/养护天数的规范应用句 → 0 命中', () => {
    expect(scanClauseRecitationSentences('给水排水构筑物底板砼强度等级应采用C30，浇筑完成后养护不少于7天。')).toEqual([]);
  });

  it('边界：空文本 → 0 命中（不因空输入把约束升级）', () => {
    expect(scanClauseRecitationSentences('')).toEqual([]);
  });
});

describe('R-B5 接线③：表格内容泄漏（章成稿后自检 chapterTableLeakIssues）', () => {
  beforeEach(() => {
    scanTableLeakParagraphsMock.mockReset();
    scanTableLeakParagraphsMock.mockImplementation(mockState.real!);
  });

  it('正向：实测泄漏段 → 报 1 条，消息含段首定位与字数，且不触发章失败口径', () => {
    const diagnostics = diagnosticsStub();
    const issues = chapterTableLeakIssues({ chapterTitle: '编制依据', content: `## 第一章 编制依据\n\n${MEASURED_LEAK}`, diagnostics });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('表格内容泄漏');
    // 定位片段按去空白口径给出（修复端复制段首即可全文检索到该段）
    expect(issues[0]).toContain('段首「《建筑桩基技术规范》（JGJ94-2008）');
    // chapterCompletionStatus 只认"章未产出"三类形态：措辞不得落进该正则，否则整章被重写
    expect(issues[0]).not.toMatch(/空小节|缺少规划小节/u);
    expect(diagnostics.llm.lastError).toBeUndefined();
  });

  it('反向（防误伤合法依据段）：有主谓的书名号引用段 → 0 条（真缺陷仍须报的反面）', () => {
    const issues = chapterTableLeakIssues({ chapterTitle: '编制依据', content: `## 第一章 编制依据\n\n${LEGIT_BASIS_PARAGRAPH}` });
    expect(issues).toEqual([]);
  });

  it('反向（防误伤结构载体）：表格行里的依据条目（同书名单、带 | 标记）→ 0 条', () => {
    const tableRows = [
      '| 序号 | 文件名称 | 编号 |',
      '| --- | --- | --- |',
      '| 1 | 《建筑桩基技术规范》 | JGJ 94-2008 |',
      '| 2 | 《建筑机电工程抗震设计规范》 | GB 50981-2014 |',
      '| 3 | 《混凝土结构工程施工质量验收规范》 | GB 50204-2015 |',
    ].join('\n');
    expect(chapterTableLeakIssues({ chapterTitle: '编制依据', content: `## 第一章 编制依据\n\n${tableRows}` })).toEqual([]);
  });

  it('边界（阈值 ±1）：书名号枚举 2 处不判 / 3 处（残留仅分隔符、无谓语）判泄漏', () => {
    expect(TABLE_LEAK_MIN_BOOK_CITATIONS).toBe(3);
    const below = '《建筑桩基技术规范》、《建筑机电工程抗震设计规范》。';
    const at = '《建筑桩基技术规范》、《建筑机电工程抗震设计规范》、《混凝土结构工程施工质量验收规范》、。';
    expect(scanTableLeakParagraphs(`## 第一章 编制依据\n\n${below}`)).toEqual([]);
    expect(scanTableLeakParagraphs(`## 第一章 编制依据\n\n${at}`)).toHaveLength(1);
  });

  it('边界（空输入）：空章正文/仅标题 → 0 条（空 = 该维度干净，不是"未执行"）', () => {
    expect(chapterTableLeakIssues({ chapterTitle: '编制依据', content: '' })).toEqual([]);
    expect(chapterTableLeakIssues({ chapterTitle: '编制依据', content: '## 第一章 编制依据\n\n（本章内容缺失）' })).toEqual([]);
  });

  it('零静默降级：扫描器抛错时不返回空，而是给出"本次未执行"的可复核问题 + 诊断留痕', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    scanTableLeakParagraphsMock.mockImplementationOnce(() => { throw new Error('本地模型不可用'); });
    const diagnostics = diagnosticsStub();
    const issues = chapterTableLeakIssues({ chapterTitle: '编制依据', content: `## 第一章 编制依据\n\n${MEASURED_LEAK}`, diagnostics });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('表格内容泄漏自检未完成');
    expect(issues[0]).toContain('本地模型不可用');
    expect(diagnostics.llm.lastError).toContain('章级表格内容泄漏自检未完成');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('不变：本族问题不进章失败口径（章已产出但有一处表达形态缺陷 → 待优化，不整章重写）', () => {
    const issues = chapterTableLeakIssues({ chapterTitle: '编制依据', content: `## 第一章 编制依据\n\n${MEASURED_LEAK}` });
    expect(issues.every(issue => !/^章未产出|生成失败/u.test(issue))).toBe(true);
  });
});
