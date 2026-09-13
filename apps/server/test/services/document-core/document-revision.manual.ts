/**
 * E5 文档修订闭环工具（manual：不进常规门禁）——修订唯一入口，一步完成全层同步 + 一致性复核：
 *  1) 修订应用：replacements 逐条精确计数（不匹配即中止=无据不写，绝不兜底）；
 *  2) 一步写链：导出源（editedMarkdown 优先，否则 markdown）→ assets md 文件（upsertGeneratedDocumentAsset）
 *     → saveGeneratedDocument（draft+meta+index+wordCount 同链落盘）→ revisionLog 审计留痕；
 *  3) 四层一致性复核（重新读盘）：doc.json 导出源 / assets md 文件字节一致、record.wordCount 与
 *     index.json wordCount 等于 documentTextLength 重算值；
 *  4) 导出链守恒复算（A2 合流）：prepareExportMarkdown 后 content-not-conserved 必须为空。
 *
 * 用法：
 *   npx vitest run --config vitest.manual.config.ts apps/server/test/services/document-core/document-revision.manual.ts
 *   spec 路径：环境变量 DOCUMENT_REVISION_SPEC（默认 <repo>/.dbg/document-revision.json）：
 *   { "projectRoot": "...", "documentId": "doc-...", "note": "...",
 *     "replacements": [{ "find": "...", "replace": "...", "expect": 1 }] }
 *   replacements 为空数组 = 纯一致性复核模式（不改内容，仅复核 + 留痕）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generatedRoot, getGeneratedDocument, saveGeneratedDocument, upsertGeneratedDocumentAsset } from '@/services/document-core/generatedDocumentService';
import { documentTextLength } from '@/services/document-workflow/budget';
import { __documentExportTest__ } from '@/pages/api/documents/export';

const ROOT = '/Users/pan/Desktop/codeing/customize-agent';
const SPEC_PATH = process.env.DOCUMENT_REVISION_SPEC || `${ROOT}/.dbg/document-revision.json`;

interface RevisionSpec {
  projectRoot?: string;
  documentId: string;
  note?: string;
  replacements: Array<{ find: string; replace: string; expect?: number }>;
}

describe('E5 修订闭环（一步同步 + 四层一致性复核 + 守恒复算）', () => {
  it('闭环全绿（spec 缺失时跳过——正常门禁不包含本文件）', () => {
    if (!fs.existsSync(SPEC_PATH)) {
      console.log(`[e5] 未找到 spec（${SPEC_PATH}），跳过`);
      return;
    }
    const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as RevisionSpec;
    const projectRoot = spec.projectRoot || ROOT;
    const record = getGeneratedDocument(spec.documentId, projectRoot);
    expect(record, `文档不存在：${spec.documentId}（projectRoot=${projectRoot}）`).toBeTruthy();
    if (!record) return;

    // 1) 修订应用（逐条精确计数：不匹配即中止）
    const activeField = record.editedMarkdown ? 'editedMarkdown' : 'markdown';
    const source = record.editedMarkdown || record.markdown || '';
    expect(source.trim().length, '导出源为空').toBeGreaterThan(0);
    let next = source;
    for (const item of spec.replacements) {
      const count = next.split(item.find).length - 1;
      const expectCount = item.expect ?? 1;
      expect(count, `修订项未命中预期次数：「${item.find.slice(0, 40)}」期望 ${expectCount} 实际 ${count}`).toBe(expectCount);
      next = next.split(item.find).join(item.replace);
    }

    // 2) 一步写链：assets md 文件（先写）→ 记录 + wordCount + revisionLog（同一 save 落盘 draft+meta+index）
    const beforeWordCount = documentTextLength(source);
    const nextWordCount = documentTextLength(next);
    const asset = upsertGeneratedDocumentAsset({ ...record, [activeField]: next }, projectRoot);
    const revisionEntry = {
      at: Date.now(),
      note: spec.note || `E5 修订 ${spec.replacements.length} 处`,
      replacements: spec.replacements.length,
      beforeChars: source.length,
      afterChars: next.length,
      beforeWordCount,
      afterWordCount: nextWordCount,
    };
    const saved = saveGeneratedDocument({
      ...record,
      [activeField]: next,
      wordCount: nextWordCount,
      revisionLog: [...(record.revisionLog || []), revisionEntry],
      ...(asset ? { assets: [asset, ...(record.assets || []).filter(item => item.id !== asset.id)] } : {}),
    }, projectRoot);

    // 3) 四层一致性复核（重新读盘）
    const reread = getGeneratedDocument(saved.id, projectRoot);
    expect(reread, '复核读盘失败').toBeTruthy();
    if (!reread) return;
    const rereadActive = reread.editedMarkdown || reread.markdown || '';
    expect(rereadActive === next, 'doc.json 导出源与修订文本不一致').toBe(true);
    expect(reread.wordCount, 'record.wordCount 与重算值不一致').toBe(nextWordCount);
    const assetEntry = (reread.assets || []).find(item => item.id === `document-${reread.id}` && item.path);
    expect(assetEntry, 'assets 登记缺失').toBeTruthy();
    const assetAbs = path.join(generatedRoot(projectRoot), (assetEntry?.path || '').replace(/^generatedDocuments\//u, ''));
    const assetText = fs.readFileSync(assetAbs, 'utf8');
    expect(assetText === next, 'assets md 文件与修订文本不一致').toBe(true);
    const index = JSON.parse(fs.readFileSync(path.join(generatedRoot(projectRoot), 'index.json'), 'utf8')) as Array<{ id: string; wordCount?: number }>;
    const indexItem = index.find(item => item.id === reread.id);
    expect(indexItem?.wordCount, 'index.json wordCount 与重算值不一致').toBe(nextWordCount);
    expect((reread.revisionLog || []).length, 'revisionLog 审计留痕缺失').toBeGreaterThanOrEqual(1);

    // 4) 导出链守恒复算（A2 合流）
    const prepared = __documentExportTest__.prepareExportMarkdown(next, reread.draft?.markdown || reread.markdown || '');
    const notConserved = prepared.audit.blockers.filter(item => item.code === 'content-not-conserved');
    if (notConserved.length > 0) console.log(`[e5] 守恒分歧：${notConserved.map(item => item.message).join(' | ')}`);
    expect(notConserved, '导出链守恒断言未通过（见上一行分歧上下文）').toHaveLength(0);
    console.log(`[e5] 闭环完成：${spec.documentId} chars ${source.length}→${next.length}，wordCount ${beforeWordCount}→${nextWordCount}，替换 ${spec.replacements.length} 处，assets=${assetEntry?.path}，守恒 ✓（audit ops=${JSON.stringify(prepared.audit.ops)}）`);
  });
});
