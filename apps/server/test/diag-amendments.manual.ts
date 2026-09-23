/** 答疑修正抽取核查（4.55.36 批次 2 验收）：真实补疑文件 → 抽取结果全量列出。 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { extractClarificationAmendmentLedger } from '@/services/document-workflow/clarificationAmendments';

describe('答疑修正抽取', () => {
  it('真实补疑文件', async () => {
    const file = path.join(process.env.HOME!, '.customize-agent', 'projects', '3c3f04667c69', 'knowledgeBase',
      '巢湖市光电新能源产业园项目一东区标准化厂房二标段施工（二次挂网 9.3）', '答疑文件',
      '巢湖市光电新能源产业园项目一东区标准化厂房二标段施工招标工程量清单、最高投标限价编制补疑2026.9.1.docx');
    const mammoth = await import('mammoth');
    const text = (await mammoth.default.extractRawText({ path: file })).value;
    const result = extractClarificationAmendmentLedger({ texts: [{ text, source: file }] });
    const lines: string[] = [`正文 ${text.length} 字；修正 ${result.amendments.length} 条`];
    result.amendments.forEach((a: { action: string; object: string; after: string; before?: Array<{ text: string; strength: string }>; chapterTitle?: string }, i: number) => {
      const before = (a.before || []).map(b => `${b.text}(${b.strength})`).join('／');
      lines.push(`${String(i + 1).padStart(3)}. [${a.action}] ${a.object}｜${String(a.after).slice(0, 56)}${before ? `　←修正前：${before.slice(0, 50)}` : ''}｜章：${a.chapterTitle || '全文'}`);
    });
    lines.push(`\n未解析答句 ${result.unparsedAnswers?.length ?? 0}；未覆盖平铺陈述 ${result.uncoveredStatements?.count ?? 0}（量值形态 ${result.uncoveredStatements?.measureShaped ?? 0}）`);
    fs.writeFileSync('/tmp/diag-amendments.txt', lines.join('\n'), 'utf8');
  }, 300_000);
});
