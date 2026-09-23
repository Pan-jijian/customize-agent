/**
 * R9 表达质量族真实文档复测（manual：不进常规门禁）——三项判据在真实文档上的命中清单复核。
 *
 * 数据源（真实）：doc-1790168542563-ea526b1b（巢湖施工组织设计，68113 字）markdown 全文。
 * 目的：把「判据在真实文档上到底命中多少、命中的是不是真缺陷」固定成可复跑的证据——
 * 注释里的"实测 X/878"来自本脚本的可复跑输出，不是推断。
 *
 * 语义通道不在此跑（vitest 环境无法执行本地模型动态导入：provider 用 new Function('return import()')
 * 完成 @huggingface/transformers 的加载）。本脚本用**零向量 stub 嵌入**把语义通道压成"全不命中"，
 * 单独验证确定性通道（零信息短语 / 条款复述 / 表格泄漏）——语义通道的子句粒度校准数值
 * 记录在 tenderBidChecks.ts 对应判据注释内。
 *
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/services/document-workflow/r9-expression-family-replay.manual.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFillerSentencePool,
  isClauseRecitationSentence,
  judgeFillerPhrases,
  scanClauseRecitationSentences,
  scanTableLeakParagraphs,
} from '@/services/document-workflow/tenderBidChecks';

const DOC_PATH = path.join(
  os.homedir(),
  '.customize-agent/projects/3c3f04667c69/generatedDocuments/assets/巢湖施工组织设计-doc-1790168542563-ea526b1b.md',
);

/** 零向量 stub：语义通道恒 0 分（dot=0），只留确定性通道开火 */
const zeroEmbed = async (texts: string[]) => texts.map(() => [0, 0]);

describe('R9 表达质量族 · 真实文档复测', () => {
  const markdown = fs.readFileSync(DOC_PATH, 'utf8');
  const sentences = buildFillerSentencePool(markdown);

  it('R9-a 短语级套话：确定性通道命中清单（实测缺陷短语在内）', async () => {
    const hits = await judgeFillerPhrases(sentences, zeroEmbed);
    const zeroInfo = hits.filter(hit => hit.channel === 'zero-info');
    console.log(`[R9-a] 子句候选=${sentences.flatMap(buildPhraseList).length} 命中=${hits.length}（zero-info=${zeroInfo.length}）`);
    for (const hit of hits) console.log(`  · [${hit.channel}] ${hit.phrase} ←「${hit.sentence.slice(0, 56)}…」`);
    // 实测缺陷短语（行90「统一以“精心组织施工”为总控目标」）必须命中，且改写锚点是短语本身而非整段框架词
    expect(zeroInfo.map(hit => hit.phrase)).toContain('精心组织施工');
    expect(hits.length).toBeLessThanOrEqual(5);
  });

  it('R9-b 条款复述：全文命中清单（零项目信息的义务复述）', () => {
    const hits = scanClauseRecitationSentences(markdown);
    console.log(`[R9-b] 命中=${hits.length}/${sentences.length}`);
    for (const sentence of hits) console.log(`  · ${sentence.slice(0, 96)}`);
    expect(hits.some(sentence => sentence.includes('我方在任何时候都应采取各种合理的预防措施'))).toBe(true);
    expect(hits.length).toBeLessThanOrEqual(8);
  });

  it('R9-d 表格内容泄漏：全文命中清单', () => {
    const hits = scanTableLeakParagraphs(markdown);
    console.log(`[R9-d] 命中=${hits.length}`);
    for (const paragraph of hits) console.log(`  · ${paragraph.slice(0, 110)}`);
    expect(hits.some(paragraph => paragraph.includes('《建筑桩基技术规范》（JGJ 94-2008）'))).toBe(true);
  });

  it('防过度：合法技术句/承诺句/结构载体零命中', () => {
    const falsePositiveCandidates = [
      '我方承担整个工程的安全保卫等的费用',
      '承包人必须按批准的施工总进度计划组织施工，每周五17时前报送周进度报表',
      '本工程2#门卫、3#门卫为框架结构，抗震设防烈度7度',
      '混凝土浇筑完成后应及时覆盖并浇水养护',
      '室外埋地敷设的电力线缆、控制线缆和智能化线缆采用护套线、电缆或光缆，并采取相应的保护措施',
      '应急物资按现场消防与卫生设施布置配置，包括急救箱、灭火器、应急照明、担架等',
      '本设计中未考虑冬季、雨季的施工措施，施工单位应根据有关施工验收规范采取相应措施',
      '给水排水构筑物底板砼强度等级应采用C30',
      '标准之间要求不一致时按最高标准执行',
    ];
    for (const sentence of falsePositiveCandidates) {
      expect(isClauseRecitationSentence(sentence), sentence).toBe(false);
    }
  });

  it('判据常量与句池规模是真实量级（防脚本空转）', () => {
    expect(sentences.length).toBeGreaterThan(500);
    expect(markdown.length).toBeGreaterThan(50000);
  });
});

/** 与 splitFillerPhrases 同口径的子句计数（仅用于日志规模量级） */
function buildPhraseList(sentence: string): string[] {
  const quoted: string[] = [];
  const rest = sentence.replace(/["“”'']([^"“”'']{2,40})["“”'']/gu, (_all, inner: string) => {
    quoted.push(inner);
    return '，';
  });
  return [...rest.split(/[，,、]/u).map(part => part.trim()), ...quoted].filter(phrase => phrase.length >= 6);
}
