import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { __documentExportTest__ } from '../src/pages/api/documents/export';

describe('document export image paths', () => {
  it('inlines knowledge base image paths for html/pdf rendering', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-export-'));
    try {
      const imagePath = path.join(root, 'knowledgeBase', '图片素材', '示例.png');
      fs.mkdirSync(path.dirname(imagePath), { recursive: true });
      fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'));
      const html = __documentExportTest__.inlineLocalImages('<p><img src="%E5%9B%BE%E7%89%87%E7%B4%A0%E6%9D%90/%E7%A4%BA%E4%BE%8B.png" alt="示例"></p>', root);
      expect(html).toContain('src="data:image/png;base64,');
      expect(html).not.toContain('图片素材/示例.png');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not inline absolute or traversed local paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-export-'));
    try {
      const outside = path.join(root, '..', `outside-${Date.now()}.png`);
      fs.writeFileSync(outside, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'));
      const html = __documentExportTest__.inlineLocalImages(`<img src="${outside}"><img src="../${path.basename(outside)}">`, root);
      expect(html).not.toContain('data:image/png;base64');
      fs.rmSync(outside, { force: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
