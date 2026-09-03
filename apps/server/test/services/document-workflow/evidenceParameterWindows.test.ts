import { describe, expect, it } from 'vitest';
import { extractKeyParameterWindows, selectEvidenceByBudget } from '@/services/document-workflow/evidence';
import type { DocumentEvidence } from '@/services/document-workflow/types';

/** 模拟 CAD 父块全文：文件头元数据 + 大量图纸节点噪声 + 尾部关键参数标注 */
function buildCadFullText(noiseNodes: number, tailParams: string): string {
  const head = '资料类型: cad/autocad\nMIME: application/x-customize-agent-cad\n文件大小: 13521058 bytes\nCAD 语义图纸节点:\n';
  const nodes: string[] = [];
  for (let i = 0; i < noiseNodes; i += 1) {
    nodes.push(`图纸节点: 某基坑支护设计.dwg | 图层: JK_Text | 块: TG_D | 实体类型: | 坐标: (39555${i}72.48, 3498925431.82)\n└── 标注文本: ${i}F | 关联对象: 邻近标注 A${i} | 状态: 普通标注`);
  }
  return `${head}${nodes.join('\n')}\n${tailParams}`;
}

describe('extractKeyParameterWindows 超长证据参数窗口提取', () => {
  it('短文本原样返回（不截断）', () => {
    const short = '基坑底标高 15.65，坡率 1:1.0';
    expect(extractKeyParameterWindows(short, 1000)).toBe(short);
  });

  it('尾部关键参数被提取进窗口（头部盲截会丢失的场景）', () => {
    const full = buildCadFullText(2000, '图纸节点: 某基坑支护设计.dwg | 图层: YQ_ELEV | 块: CD_粗线 | 坐标: (39555, 34990)\n└── 标注文本: 15.65(基坑底标高) | 关联对象: 邻近标注 坡率 1:1.0 | 状态: 普通标注\n└── 标注文本: 22.00(整平标高) | 关联对象: 邻近标注 坡率 1:1.0 | 状态: 普通标注');
    expect(full.length).toBeGreaterThan(50000);
    const extracted = extractKeyParameterWindows(full, 1200);
    expect(extracted).toContain('基坑底标高');
    expect(extracted).toContain('15.65');
    expect(extracted).toContain('坡率');
    expect(extracted).toContain('整平标高');
  });

  it('返回长度不超过预算', () => {
    const full = buildCadFullText(2000, '└── 标注文本: 15.65(基坑底标高) | 关联对象: 邻近标注 坡率 1:1.0 | 状态: 普通标注');
    for (const budget of [800, 1200, 5000]) {
      const extracted = extractKeyParameterWindows(full, budget);
      expect(extracted.length).toBeLessThanOrEqual(budget);
    }
  });

  it('无参数命中时回退到头部截断', () => {
    const full = buildCadFullText(1500, '图纸节点: 某图纸.dwg | 图层: Road | 块: 路名 | 坐标: (39, 34)');
    const extracted = extractKeyParameterWindows(full, 1000);
    expect(extracted.length).toBeLessThanOrEqual(1000);
    expect(extracted).toContain('资料类型: cad/autocad');
  });
});

describe('selectEvidenceByBudget 超长证据入池压缩', () => {
  const cadEvidence: DocumentEvidence = {
    chapterId: 'c1',
    filePath: '图纸/基坑支护/基坑支护设计20260710_X7.dwg',
    score: 230,
    content: buildCadFullText(2000, '└── 标注文本: 15.65(基坑底标高) | 关联对象: 邻近标注 坡率 1:1.0 | 状态: 普通标注'),
    processingType: 'drawing',
    sectionTitle: '资料类型: cad/autocad',
    source: 'deep-retrieval',
  };
  const normalEvidence: DocumentEvidence = {
    chapterId: 'c1',
    filePath: '招标文件.pdf',
    score: 100,
    content: '危险性较大的分部分项工程清单：深基坑（开挖深度超过3m）。',
    processingType: 'document',
    sectionTitle: '危大工程清单',
    source: 'deep-retrieval',
  };

  it('超长 CAD 证据压缩后不占满预算，其他文件证据仍能入池', () => {
    const selected = selectEvidenceByBudget([cadEvidence, normalEvidence], { maxChars: 15000, preservePinned: true });
    expect(selected.length).toBe(2);
    const cad = selected.find(item => item.filePath.includes('.dwg'))!;
    const pdf = selected.find(item => item.filePath === '招标文件.pdf')!;
    expect(cad.content).toContain('基坑底标高');
    expect(cad.content.length).toBeLessThanOrEqual(12000);
    expect(pdf.content).toContain('深基坑');
  });

  it('无预算上限时不做压缩（全量保留）', () => {
    const selected = selectEvidenceByBudget([cadEvidence], { preservePinned: true });
    expect(selected.length).toBe(1);
    expect(selected[0].content.length).toBeGreaterThan(50000);
  });
});
