import { describe, expect, it } from 'vitest';
import { cleanExtractedText } from '../src/cleaning/text-cleaner.js';
import { layoutCadAnnotations, type CadAnnotation } from '../src/extraction/content-extractor.js';

/** 生成 n 行通用条款正文（规模证据用） */
function generalClauseLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `第${i + 1}条 发包人与承包人按照本合同的约定履行各自义务，未尽事宜按国家法律法规及行业惯例执行。`);
}

/** 通用条款章节正例文本：编号标题触发 + 专用条款边界闭合 + 前文正文保证删除后剩余 >30% */
function buildContractChapterSample(generalCount: number, prefixCount = 100): string {
  return [
    ...Array.from({ length: prefixCount }, (_, i) => `协议书正文第 ${i + 1} 段：本工程总建筑面积 50000 平方米，合同价 1.2 亿元，工期目标 365 日历天。`),
    '第二部分 通用合同条款',
    ...generalClauseLines(generalCount),
    '第三部分 专用合同条款',
    '专用条款第 1 条：本项目工期目标为 365 日历天，质量目标为合格，安全目标为零事故。',
    ...Array.from({ length: 14 }, (_, i) => `专用条款第 ${i + 2} 条：本项目专项数据 ${i + 2}。`),
  ].join('\n');
}

describe('K2 合同通用条款清洗——结构锚定（丰乐镇事故回归）', () => {
  it('编号标题形态触发 + 专用条款边界闭合 → 删除通用条款，保留专用条款', () => {
    const text = buildContractChapterSample(60);
    const result = cleanExtractedText({ text, fileName: '某某项目施工合同.pdf', category: 'document', format: 'pdf' });
    expect(result.text).not.toContain('通用条款内容');
    expect(result.text).toContain('专用合同条款');
    expect(result.text).toContain('专用条款第 1 条');
    expect(result.stats.contractGeneralClauseLines).toBeGreaterThanOrEqual(60);
  });

  it('解析器 ## 标题形态触发（纯标题词行带 markdown 前缀）', () => {
    const text = [
      ...Array.from({ length: 100 }, (_, i) => `协议书正文第 ${i + 1} 段。`),
      '## 通用合同条款',
      ...generalClauseLines(60),
      '## 专用合同条款',
      '专用条款第 1 条：本项目工期目标为 365 日历天。',
    ].join('\n');
    const result = cleanExtractedText({ text, category: 'document', format: 'pdf' });
    expect(result.text).not.toContain('未尽事宜按国家法律法规');
    expect(result.text).toContain('专用条款第 1 条');
  });

  it('PDF 拆行标题形态触发：编号行 + 独立标题词行', () => {
    const text = [
      ...Array.from({ length: 100 }, (_, i) => `协议书正文第 ${i + 1} 段。`),
      '第二节',
      '通用合同条款',
      ...generalClauseLines(60),
      '第三节',
      '专用合同条款',
      '专用条款第 1 条：本项目工期目标为 365 日历天。',
    ].join('\n');
    const result = cleanExtractedText({ text, category: 'document', format: 'pdf' });
    expect(result.text).not.toContain('未尽事宜按国家法律法规');
    expect(result.text).toContain('专用条款第 1 条');
  });

  it('触发后无闭合边界 → 放弃删除（宁多勿丢）', () => {
    const text = [
      ...Array.from({ length: 100 }, (_, i) => `正文第 ${i + 1} 段。`),
      '第二部分 通用合同条款',
      ...generalClauseLines(60),
      '本工程采用商品砼，本项目采用预拌砂浆。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '某某项目招标文件.pdf', category: 'document', format: 'pdf' });
    expect(result.text).toContain('通用合同条款');
    expect(result.text).toContain('商品砼');
    expect(result.stats.contractGeneralClauseLines).toBe(0);
  });

  it('事故句 1：正文句含标题词（协议书词语含义句）不触发', () => {
    const text = [
      '本协议书中词语含义与第二部分通用合同条款中赋予的含义相同。',
      ...generalClauseLines(60),
      '第七章 技术标准和要求',
      '本工程采用商品砼，本项目采用预拌砂浆。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '丰乐镇招标文件.pdf', category: 'document', format: 'pdf' });
    expect(result.text).toContain('本协议书中词语含义');
    expect(result.text).toContain('第七章 技术标准和要求');
    expect(result.text).toContain('商品砼');
    expect(result.stats.contractGeneralClauseLines).toBe(0);
  });

  it('事故句 2：括号分号碎片行不触发', () => {
    const text = [
      '）通用合同条款；（',
      ...generalClauseLines(60),
      '本工程采用商品砼，本项目采用预拌砂浆。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '丰乐镇招标文件.pdf', category: 'document', format: 'pdf' });
    expect(result.text).toContain('通用合同条款；（');
    expect(result.text).toContain('商品砼');
    expect(result.stats.contractGeneralClauseLines).toBe(0);
  });

  it('事故句 3：PDF 折行半句（句中词开头）不触发', () => {
    const text = [
      '……编制执行合同通用合同条款',
      ...generalClauseLines(60),
      '本工程采用商品砼，本项目采用预拌砂浆。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '丰乐镇招标文件.pdf', category: 'document', format: 'pdf' });
    expect(result.text).toContain('编制执行合同通用合同条款');
    expect(result.text).toContain('商品砼');
    expect(result.stats.contractGeneralClauseLines).toBe(0);
  });

  it('事故句 4：正文句折行半句（"除…之外"开头）不触发', () => {
    const text = [
      '除通用合同条款约定的不可抗力事件之外，本项目仍按',
      ...generalClauseLines(60),
      '本工程采用商品砼，本项目采用预拌砂浆。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '丰乐镇招标文件.pdf', category: 'document', format: 'pdf' });
    expect(result.text).toContain('除通用合同条款约定的不可抗力事件之外');
    expect(result.text).toContain('商品砼');
    expect(result.stats.contractGeneralClauseLines).toBe(0);
  });

  it('事故句 5：折行半句（章节内容一起阅读句）不触发', () => {
    const text = [
      '通用合同条款、专用合同条款、技术标准和要求以及图纸等章节内容一起阅',
      ...generalClauseLines(60),
      '本工程采用商品砼，本项目采用预拌砂浆。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '丰乐镇招标文件.pdf', category: 'document', format: 'pdf' });
    expect(result.text).toContain('一起阅');
    expect(result.text).toContain('商品砼');
    expect(result.stats.contractGeneralClauseLines).toBe(0);
  });

  it('目录条目形态的标题词行不触发（点线行上下文）', () => {
    const text = [
      '目 录',
      '通用合同条款..............45',
      ...generalClauseLines(60),
      '本工程采用商品砼。',
    ].join('\n');
    const result = cleanExtractedText({ text, category: 'document', format: 'pdf' });
    // 目录区段本身被 TOC 规则删除；此处断言正文内容保留且 K2 未误触发
    expect(result.text).toContain('商品砼');
    expect(result.stats.contractGeneralClauseLines).toBe(0);
  });

  it('K2 删除占比过大（剩余 <30%）→ 整体回退保护', () => {
    const text = [
      '第二部分 通用合同条款',
      ...generalClauseLines(300),
      '第三部分 专用合同条款',
      '专用条款第 1 条：本项目工期目标为 365 日历天。',
      ...Array.from({ length: 4 }, (_, i) => `专用条款第 ${i + 2} 条：本项目专项数据。`),
    ].join('\n');
    const result = cleanExtractedText({ text, category: 'document', format: 'pdf' });
    expect(result.text).toContain('未尽事宜按国家法律法规');
    expect(result.removedLines).toBe(0);
  });
});

describe('图纸 PDF 内容性质分流（ContentProfile）', () => {
  /** 模拟 CAD 导出的施工图 PDF 文本：页面标记 + 大量坐标行 + 少量标注行（标注行加长使坐标字符占比 <70%，不触发 30% 回退） */
  function buildDrawingPdfText(coordinateCountPerPage: number, pageCount = 3): string {
    const pages: string[] = [];
    for (let p = 1; p <= pageCount; p += 1) {
      pages.push([
        `## PDF 第 ${p} 页`,
        '总平面布置图',
        ...Array.from({ length: coordinateCountPerPage }, (_, i) => `${11 + i}.1, ${22 + i}.2, ${33 + i}.3, ${44 + i}.4`),
        `标注行 A${p}：DN300 钢筋混凝土排水管，管道坡度为 0.003。`,
        `标注行 B${p}：检查井 J${p} 深度 2.5m，井盖采用重型铸铁井盖。`,
        `标注行 C${p}：道路结构层为沥青混凝土面层加水泥稳定碎石基层。`,
      ].join('\n'));
    }
    return pages.join('\n');
  }

  it('坐标行占比高的 document/pdf → 坐标行清洗生效，标注行保留', () => {
    const text = buildDrawingPdfText(6);
    const result = cleanExtractedText({ text, fileName: '施工图08.17.pdf', category: 'document', format: 'pdf' });
    expect(result.text).not.toContain('11.1, 22.2');
    expect(result.text).toContain('DN300 钢筋混凝土排水管');
    expect(result.text).toContain('检查井');
    expect(result.stats.cadNoiseLines).toBeGreaterThanOrEqual(18);
  });

  it('正常文档坐标行占比低 → 坐标行保留（防误删）', () => {
    const text = [
      ...Array.from({ length: 30 }, (_, i) => `正文段落 ${i + 1}：本段为模拟正文内容，用于撑起文档行数。`),
      '测量成果坐标 367144.29, 3642129.71',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '招标文件.pdf', category: 'document', format: 'pdf' });
    expect(result.text).toContain('367144');
  });

  it('图纸 PDF 高重复标注行不按页眉页脚删除', () => {
    const pages: string[] = [];
    for (let p = 1; p <= 3; p += 1) {
      pages.push([
        `## PDF 第 ${p} 页`,
        ...Array.from({ length: 3 }, (_, i) => `${11 + p + i}.1, ${22 + p + i}.2, ${33 + p + i}.3, ${44 + p + i}.4`),
        ...Array.from({ length: 2 }, () => 'FM1524'),
        '门窗表说明：所有外窗均采用断桥铝合金门窗。',
      ].join('\n'));
    }
    const text = `${pages.join('\n')}\nC35 混凝土垫层`;
    const result = cleanExtractedText({ text, fileName: '门窗表.pdf', category: 'document', format: 'pdf' });
    expect(result.text).toContain('FM1524');
    expect(result.stats.headerFooterLines).toBe(0);
    expect(result.stats.cadNoiseLines).toBeGreaterThanOrEqual(9);
  });

  it('标高碎片行占比高 → 图纸分流生效，标高/井编号/管径数据保留且不误删', () => {
    // 真实施工图 PDF 碎片形态：无逗号坐标对，而是检查井标高/井编号/管径离散短行
    // （修复前该形态判为普通 document，高重复标高行 4952 行被页眉页脚规则误删）
    const pages: string[] = [];
    for (let p = 1; p <= 3; p += 1) {
      pages.push([
        `## PDF 第 ${p} 页`,
        '20.52', // 检查井标高（每页重复，普通文档形态下会按页眉页脚误删）
        '17.82 18.97 W-4 C 19.86 19.45', // 井编号+标高
        'DN200 -20.3-0.3', // 管径+埋深
        'DN300 -18.5-0.3',
        '20.52',
        `标注行 A${p}：DN300 钢筋混凝土排水管，管道坡度为 0.003。`,
      ].join('\n'));
    }
    const text = pages.join('\n');
    const result = cleanExtractedText({ text, fileName: '施工图08.17.pdf', category: 'document', format: 'pdf' });
    // 短碎片行占比 15/21 ≈ 71% ≥ 15% → 判为图纸内容：页眉页脚规则豁免，标高数据不再误删
    expect(result.stats.headerFooterLines).toBe(0);
    expect(result.text).toContain('20.52');
    expect(result.text).toContain('W-4');
    expect(result.text).toContain('DN200');
    expect(result.text).toContain('钢筋混凝土排水管');
  });

  it('正常文档短碎片行占比低 → 不判图纸，表格短行保留', () => {
    const lines: string[] = [];
    for (let p = 1; p <= 5; p += 1) {
      lines.push(`## PDF 第 ${p} 页`);
      lines.push(...Array.from({ length: 8 }, (_, i) => `正文段落 ${p}-${i}：本段为模拟招标文件正文内容，用于撑起文档行数与短行占比计算。`));
      lines.push('1 王五 男 35'); // 表格数据短行（汉字 2 个，短碎片形态）
    }
    const text = lines.join('\n');
    const result = cleanExtractedText({ text, fileName: '招标文件.pdf', category: 'document', format: 'pdf' });
    // 短碎片行 5/55 ≈ 9% < 15% → 不判图纸（实测招标文件全文 8.1%）：表格数据短行保留
    expect(result.text).toContain('王五');
  });
});

describe('CAD 标注布局重建（layoutCadAnnotations）', () => {
  it('同行多个 TEXT 实体按 x 拼接为一行，连续行合并为段落', () => {
    const annotations: CadAnnotation[] = [
      { text: '1. 本工程为', x: 10, y: 100, entityType: 'TEXT' },
      { text: '框架结构', x: 60, y: 100, entityType: 'TEXT' },
      { text: '2. 总建筑面积', x: 10, y: 95, entityType: 'TEXT' },
      { text: '50000 平方米。', x: 60, y: 95, entityType: 'TEXT' },
    ];
    expect(layoutCadAnnotations(annotations)).toEqual([
      '1. 本工程为 框架结构\n2. 总建筑面积 50000 平方米。',
    ]);
  });

  it('行距超过段落阈值的标注分开成独立段落', () => {
    const annotations: CadAnnotation[] = [
      // 第一组：紧凑两行（标题区）
      { text: '总平面布置图', x: 10, y: 100, entityType: 'TEXT' },
      { text: '1:100', x: 10, y: 95, entityType: 'TEXT' },
      // 大间距后的第二组（标注区）
      { text: 'C35 混凝土垫层', x: 10, y: 50, entityType: 'TEXT' },
      { text: 'DN300 排水管', x: 10, y: 45, entityType: 'TEXT' },
    ];
    const result = layoutCadAnnotations(annotations);
    expect(result).toEqual(['总平面布置图\n1:100', 'C35 混凝土垫层\nDN300 排水管']);
  });

  it('无坐标实体（ATTRIB 等）保持原顺序独立输出', () => {
    const annotations: CadAnnotation[] = [
      { text: '型号 M1021', entityType: 'ATTRIB' },
      { text: '高度 2100', entityType: 'ATTRIB' },
      { text: '平面图', x: 10, y: 100, entityType: 'TEXT' },
    ];
    expect(layoutCadAnnotations(annotations)).toEqual(['平面图', '型号 M1021', '高度 2100']);
  });

  it('空标注列表返回空数组', () => {
    expect(layoutCadAnnotations([])).toEqual([]);
  });
});
