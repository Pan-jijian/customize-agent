/**
 * drawingFactLock 单测（B-T3 图纸引用链）：图纸类证据识别/分组 + 事实行提取 + token 判定锚点
 * （规格/配比/图集编号，短通用 token 不参与）+ 渲染（相关性排序/每图纸保底/预算）+ 落位判定 +
 * drawingReferenceIssues 验收口径（消费锁的确定性 token，不再以文件名/路径匹配正文）。
 */
import { describe, expect, it } from 'vitest';
import { buildDrawingFactLock, drawingFactPlacement, extractDrawingFactTokens, renderDrawingFactLockText, type DrawingFactLock } from '@/services/document-workflow/drawingFactLock';
import { drawingReferenceIssues } from '@/services/document-workflow/qualityValidation';
import type { DocumentEvidence } from '@/services/document-workflow/types';

function evidence(filePath: string, content: string, extra: Partial<DocumentEvidence> = {}): DocumentEvidence {
  return { chapterId: 'ch-1', filePath, score: 1, content, ...extra };
}

const ROAD_CONTENT = [
  '设计说明：本项目道路等级为四级公路，路面结构层做法如下。',
  '路面结构：4cm 细粒式沥青混凝土 AC-13 + 6cm 中粒式沥青混凝土 AC-20。',
  '路缘石采用 C30 混凝土，M7.5 水泥砂浆砌筑 MU10 砖。',
  '人行道铺装做法参 02S515 页 96，1:2 防水水泥砂浆勾缝。',
].join('\n');
const DRAIN_CONTENT = '排水工程：检查井盖板采用 C25 混凝土，做法参 02S515 页 96；管沟开挖深度 4m，放坡系数 1:1。';

function lockFixture(groups: DrawingFactLock['groups']): DrawingFactLock {
  return { groups, usableDrawings: groups.length, unusableDrawings: 0, totalFacts: groups.reduce((sum, group) => sum + group.factLines.length, 0) };
}

describe('buildDrawingFactLock 图纸事实锁构建（B-T3）', () => {
  it('无图纸类证据时返回 undefined（不注入不验收）', () => {
    const lock = buildDrawingFactLock({ evidence: [evidence('招标文件.pdf', '本项目路面采用沥青混凝土，做法参 02S515。')] });
    expect(lock).toBeUndefined();
  });

  it('图纸识别（文件名/处理类型两通道）并按来源文件分组', () => {
    const lock = buildDrawingFactLock({
      evidence: [
        evidence('资料/施工图08.17.pdf', ROAD_CONTENT),
        evidence('资料/drain.pdf', DRAIN_CONTENT, { processingType: 'drawing' }),
        evidence('招标文件.pdf', '本项目 C30 混凝土要求。'),
      ],
    });
    expect(lock).toBeDefined();
    expect(lock!.groups.map(group => group.sourceFile)).toEqual(['资料/施工图08.17.pdf', '资料/drain.pdf']);
    expect(lock!.usableDrawings).toBe(2);
  });

  it('事实行提取与 token 判定锚点（规格/配比/图集编号）', () => {
    const lock = buildDrawingFactLock({ evidence: [evidence('资料/施工图08.17.pdf', ROAD_CONTENT)] })!;
    const group = lock.groups[0]!;
    expect(group.factLines.some(line => line.includes('M7.5 水泥砂浆'))).toBe(true);
    expect(group.tokens).toEqual(expect.arrayContaining(['c30', 'm7.5', 'mu10', '02s515', '1:2', 'ac-13']));
  });

  it('无可用 token 的图纸计入 unusableDrawings（不纳入验收分母）', () => {
    const lock = buildDrawingFactLock({
      evidence: [
        evidence('资料/a图纸.pdf', '开挖深度 4m。'),
        evidence('资料/b图纸.pdf', '本图为总体示意图。'),
      ],
    })!;
    expect(lock.groups).toHaveLength(0);
    expect(lock.usableDrawings).toBe(0);
    expect(lock.unusableDrawings).toBe(2);
  });

  it('标注碎片行（坐标表/标高串）不入锁，语义行与数值规格叙述行保留', () => {
    const content = [
      '1 W-1 515722.0263498423.042 20.284 0.81 630 08SS523 i=0.3DN200 31 W-31 515601.3503498352.956 19.724 0.82',
      '## 设计管内底标高14.098 14.055 13.93513.922 13.901 16.270 15.991 15.673 18.000 17.933 16.973 16.805',
      '检查井盖板采用 C25 混凝土，做法参 02S515 页 96。',
      '出水水质（二级标准）：pH值6～9，CODcr≤100mg/L，SS≤30mg/L，NH3-N≤15mg/L，TP≤3mg/L。',
    ].join('\n');
    const lock = buildDrawingFactLock({ evidence: [evidence('资料/排水施工图.pdf', content)] })!;
    const lines = lock.groups[0]!.factLines;
    expect(lines).toHaveLength(2);
    expect(lines.some(line => line.includes('检查井盖板'))).toBe(true);
    expect(lines.some(line => line.includes('出水水质'))).toBe(true);
  });
});

describe('extractDrawingFactTokens token 提取口径', () => {
  it('规格/强度等级/配比/图集编号保留，短通用 token（4m）排除', () => {
    const tokens = extractDrawingFactTokens('沟槽开挖深度 4m，放坡系数 1:1，路缘石 C30 混凝土，做法参 02S515 页 96，砂浆强度 M7.5。');
    expect(tokens).toEqual(expect.arrayContaining(['1:1', 'c30', '02s515', 'm7.5']));
    expect(tokens).not.toContain('4m');
  });

  it('全角冒号配比与半角归一同口径', () => {
    expect(extractDrawingFactTokens('配合比 1：2 水泥砂浆')).toContain('1:2');
  });

  it('坡度/尺寸标注中段不误配图集编号（前置边界）', () => {
    const tokens = extractDrawingFactTokens('管道坡度 i=1.83 D258x16.5，做法参 02S515。');
    expect(tokens).not.toContain('83d258');
    expect(tokens).toContain('02s515');
  });
});

describe('renderDrawingFactLockText 图纸行直读渲染', () => {
  const roadLock = buildDrawingFactLock({ evidence: [evidence('资料/道路施工图.pdf', ROAD_CONTENT)] })!;

  it('渲染含锁头、来源标注与事实行', () => {
    const text = renderDrawingFactLockText(roadLock, '道路工程', { sections: ['路面结构层施工'] });
    expect(text).toContain('【图纸事实锁');
    expect(text).toContain('道路施工图.pdf');
    expect(text).toContain('AC-13');
  });

  it('每份图纸保底行进入渲染窗口（引用率 ≥1 处/份的前提）', () => {
    const bothLock = buildDrawingFactLock({
      evidence: [evidence('资料/道路施工图.pdf', ROAD_CONTENT), evidence('资料/排水施工图.pdf', DRAIN_CONTENT)],
    })!;
    const text = renderDrawingFactLockText(bothLock, '道路工程');
    expect(text).toContain('道路施工图.pdf｜');
    expect(text).toContain('排水施工图.pdf｜');
  });

  it('预算上限约束事实行数量，锁头保留', () => {
    const full = renderDrawingFactLockText(roadLock, '道路工程');
    const capped = renderDrawingFactLockText(roadLock, '道路工程', { maxChars: 60 });
    expect(capped.length).toBeLessThan(full.length);
    expect(capped).toContain('【图纸事实锁');
  });

  it('空锁渲染为空串', () => {
    expect(renderDrawingFactLockText(lockFixture([]), '道路工程')).toBe('');
  });
});

describe('drawingFactPlacement 落位判定', () => {
  const roadLock = buildDrawingFactLock({ evidence: [evidence('资料/道路施工图.pdf', ROAD_CONTENT)] })!;

  it('正文命中任一 token 即该图纸已引用', () => {
    const hit = drawingFactPlacement(roadLock, '路面施工采用 4cm 沥青混凝土 AC-13，路缘石 C30。');
    expect(hit.referenced).toHaveLength(1);
    expect(hit.rate).toBe(1);
    const miss = drawingFactPlacement(roadLock, '本章与图纸内容无关。');
    expect(miss.unreferenced).toHaveLength(1);
    expect(miss.rate).toBe(0);
  });

  it('全角冒号来源与半角正文归一同口径命中', () => {
    const lock = lockFixture([{ sourceFile: '资料/做法图.pdf', factLines: ['配合比 1：2 水泥砂浆'], tokens: ['1:2'] }]);
    expect(drawingFactPlacement(lock, '采用配合比 1:2 水泥砂浆勾缝。').rate).toBe(1);
  });
});

describe('drawingReferenceIssues 引用率验收（B-T3）', () => {
  const roadLock = buildDrawingFactLock({ evidence: [evidence('资料/道路施工图.pdf', ROAD_CONTENT)] })!;
  const bothLock = buildDrawingFactLock({
    evidence: [evidence('资料/道路施工图.pdf', ROAD_CONTENT), evidence('资料/排水施工图.pdf', DRAIN_CONTENT)],
  })!;

  it('全部落位无 issue；半数落位仅告警', () => {
    expect(drawingReferenceIssues('路面采用 AC-13，C30 混凝土。', roadLock)).toEqual([]);
    const half = drawingReferenceIssues('路面采用 AC-13 施工。', bothLock);
    expect(half).toHaveLength(1);
    expect(half[0]!.level).toBe('warning');
    expect(half[0]!.message).toContain('1/2');
  });

  it('全未落位且分母 ≥2 份出 error（含未落位明细与事实行样例）', () => {
    const issues = drawingReferenceIssues('无关正文。', bothLock);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('error');
    expect(issues[0]!.message).toContain('图纸事实落位不足');
    expect(issues[0]!.message).toContain('0/2');
    expect(issues[0]!.suggestion).toContain('道路施工图.pdf');
  });

  it('单份图纸未落位仅告警（不升 error）', () => {
    const issues = drawingReferenceIssues('无关正文。', roadLock);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('warning');
  });

  it('无图纸锁时静默（不误报）', () => {
    expect(drawingReferenceIssues('正文', undefined)).toEqual([]);
    expect(drawingReferenceIssues('正文', lockFixture([]))).toEqual([]);
  });
});
