import { describe, it } from 'vitest';
import * as fs from 'node:fs';
import { generateDocumentDraft } from '../src/services/document-workflow/documentGenerator';

describe('real full generation', () => {
  it('generates real document with real template and project materials', async () => {
    const out: string[] = [];
    const log = (msg: string) => { out.push(msg); fs.writeFileSync('/tmp/real-gen-21-progress.log', out.join('\n')); };
    const start = Date.now();
    log('START ' + new Date().toISOString());
    const draft = await generateDocumentDraft({
      templateId: 'tpl-1785511985203',
      projectRoot: '/Users/pan/Desktop/codeing/customize-agent',
      requirement: '依据招标文件要求编制施工组织设计，覆盖工期、质量、安全、主要施工方案等全部章节。',
      onProgress: (stages, checkpoint) => {
        const running = stages.filter(s => s.status === 'running').slice(-2).map(s => `${s.status}:${s.message}`.slice(0, 100));
        const latest = stages.filter(s => s.status !== 'running').slice(-4).map(s => `${s.status}:${s.message}`.slice(0, 120));
        log(`PROGRESS ${Math.round((Date.now() - start) / 1000)}s | ${latest.join(' || ')}${running.length ? ` || RUNNING ${running.join(' // ')}` : ''}`);
        if (checkpoint?.chapters?.length) {
          fs.writeFileSync('/tmp/real-gen-21-checkpoint.json', JSON.stringify(checkpoint.chapters.map(c => ({ id: c.id, title: c.title, chars: c.content?.length || 0, content: c.content || '' })), null, 2));
        }
      },
    });
    const elapsed = Math.round((Date.now() - start) / 1000);
    log(`DONE elapsed=${elapsed}s chapters=${draft.chapters.length} markdownChars=${draft.markdown?.length || 0}`);
    const review = draft.reviewMetadata;
    log('REVIEW: ' + JSON.stringify({
      writingTaskBrief: review?.writingTaskBrief ? { docType: review.writingTaskBrief.documentType, chapters: review.writingTaskBrief.chapters.length, focus: review.writingTaskBrief.globalWritingFocus.length } : null,
      professionalScore: review?.professionalScore ? JSON.stringify(review.professionalScore).slice(0, 600) : null,
      stageCount: draft.executionStages?.length,
      failedStages: draft.executionStages?.filter(s => s.status === 'failed').length,
    }));
    fs.writeFileSync('/tmp/real-gen-21-output.md', draft.markdown || '');
    fs.writeFileSync('/tmp/real-gen-21-review.json', JSON.stringify({
      reviewMetadata: draft.reviewMetadata,
      executionStages: draft.executionStages,
      chapters: draft.chapters.map(c => ({ id: c.id, title: c.title, sections: c.sections?.length, chars: c.content?.length })),
      validationIssues: draft.validationIssues,
    }, null, 2));
    log('FILES WRITTEN');
    console.log('FINAL:', JSON.stringify({ elapsed, chapters: draft.chapters.length, markdownChars: draft.markdown?.length }));
  }, 7_200_000);
});
