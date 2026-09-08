/**
 * t2-cq XX 组第一批（XX1）：chapterPostProcessing 纯函数族边界枚举。
 * 覆盖：sectionContentBody / currentSectionBlock（块定位）、mergeDuplicateWorkPackageSubsections
 * （工作包双口径重复合并）、dedupeQuantityFacts / filterConstructionSteps（清单条目去重与工序过滤）、
 * scopeEngineeringNames（招标范围工程名提取）、parseMajorConstructionPackages（工作包图谱解析）、
 * majorConstructionSkeletonNames（骨架名三通道兑底）。
 * 全部断言按源码实现逐条推导，真实行为锁定（不修改实现迎合用例）。
 */
import { describe, expect, it } from 'vitest';
import type { DocumentEvidence } from '@/services/document-workflow/types';
import {
  currentSectionBlock,
  dedupeQuantityFacts,
  filterConstructionSteps,
  majorConstructionSkeletonNames,
  mergeDuplicateWorkPackageSubsections,
  parseMajorConstructionPackages,
  scopeEngineeringNames,
  sectionContentBody,
} from '@/services/document-workflow/chapterPostProcessing';

const ev = (content: string): DocumentEvidence => ({ chapterId: 'c1', filePath: 'f1', score: 1, content });

describe('X1 sectionContentBody', () => {
  it('剥离 H3 标题行', () => {
    expect(sectionContentBody('### 施工部署\n部署正文')).toBe('部署正文');
  });

  it('剥离 H4 标题行（含空行）', () => {
    expect(sectionContentBody('#### 项目主要施工内容\n\n正文A\n')).toBe('正文A');
  });

  it('无标题 → 原样 trim', () => {
    expect(sectionContentBody(' 正文X  ')).toBe('正文X');
  });

  it('空串 → 空串', () => {
    expect(sectionContentBody('')).toBe('');
  });
});

describe('X2 currentSectionBlock', () => {
  it('H3 命中：返回含标题行块至下一 H3', () => {
    const md = ['### 施工部署', '部署正文', '### 下一节', 'X'].join('\n');
    const out = currentSectionBlock('施工部署', md);
    expect(out).toContain('### 施工部署');
    expect(out).toContain('部署正文');
    expect(out).not.toContain('下一节');
  });

  it('H4 命中：返回含标题行块', () => {
    const md = ['#### 项目主要施工内容', '内容正文', '### 下一节'].join('\n');
    const out = currentSectionBlock('项目主要施工内容', md);
    expect(out).toContain('#### 项目主要施工内容');
    expect(out).toContain('内容正文');
    expect(out).not.toContain('下一节');
  });

  it('编号前缀容忍：### 1.2 施工部署 按「施工部署」命中', () => {
    const md = ['### 1.2 施工部署', '正文Y', '### 1.3 其他'].join('\n');
    const out = currentSectionBlock('施工部署', md);
    expect(out).toContain('正文Y');
    expect(out).not.toContain('### 1.3 其他');
  });

  it('内部 H4 子标题不截断（H4 目标块工作包正文完整）', () => {
    const md = ['#### 项目主要施工内容', '#### 1 污水管网工程', '包正文', '### 下一节'].join('\n');
    const out = currentSectionBlock('项目主要施工内容', md);
    expect(out).toContain('包正文');
  });

  it('最后一节：正文到字符串末尾', () => {
    const md = ['### 最后一节', '尾部正文'].join('\n');
    const out = currentSectionBlock('最后一节', md);
    expect(out).toContain('尾部正文');
  });

  it('无匹配 → 原样返回 content', () => {
    const md = '### 施工部署\n正文';
    expect(currentSectionBlock('不存在的节', md)).toBe(md);
  });

  it('特殊字符标题转义', () => {
    const md = ['### 测试（一）', '括号正文'].join('\n');
    expect(currentSectionBlock('测试（一）', md)).toContain('括号正文');
  });

  it('## 章标题截断', () => {
    const md = ['### 施工部署', '正文', '## 第二章', '下一章'].join('\n');
    const out = currentSectionBlock('施工部署', md);
    expect(out).not.toContain('第二章');
  });
});

describe('X3 mergeDuplicateWorkPackageSubsections', () => {
  it('无「项目主要施工内容」节块 → 原样', () => {
    const md = '### 其他节\n正文';
    expect(mergeDuplicateWorkPackageSubsections(md)).toBe(md);
  });

  it('只有普通包无工作包 → 原样', () => {
    const md = ['### 1.1 项目主要施工内容', '#### 1.1.1 污水管网工程', '施工概况：HDPE双壁波纹管约800m'].join('\n');
    expect(mergeDuplicateWorkPackageSubsections(md)).toBe(md);
  });

  it('标题 bigram 重合 <2 → 不合并', () => {
    const md = [
      '### 1.1 项目主要施工内容',
      '#### 1.1.1 道路工程',
      '施工概况：水泥路面约800m',
      '施工流程：路基开挖→浇筑',
      '施工方法：养护',
      '#### 1.1.2 智能化工程工作包',
      '施工概况：综合布线约1200m',
      '施工流程：穿线→测试',
      '施工方法：调试',
    ].join('\n');
    expect(mergeDuplicateWorkPackageSubsections(md)).toBe(md);
  });

  it('同名工作包合并：工作包小节删除、独有量化句并入保留包', () => {
    const md = [
      '### 1.1 项目主要施工内容',
      '#### 1.1.1 污水管网工程',
      '施工概况：HDPE双壁波纹管 DN400 约800m',
      '施工流程：沟槽开挖→管道基础→铺设',
      '施工方法：闭水试验后分层回填',
      '#### 1.1.2 污水管网工程工作包',
      '施工概况：HDPE双壁波纹管 DN300 约1200m',
      '施工流程：测量放线→沟槽开挖→管道铺设',
      '施工方法：闭水试验合格后回填压实',
    ].join('\n');
    const out = mergeDuplicateWorkPackageSubsections(md);
    expect(out).not.toContain('工作包');
    expect(out).toContain('#### 1.1.1 污水管网工程');
    // 独有量化句（无参数 token 匹配）追加到保留包末尾
    expect(out).toContain('HDPE双壁波纹管 DN300 约1200m。');
  });

  it('参数 token 全部已在保留包 → 工作包仍删、无重复追加内容', () => {
    const md = [
      '### 1.1 项目主要施工内容',
      '#### 1.1.1 污水管网工程',
      '施工概况：检查井45座',
      '施工流程：沟槽开挖→管道铺设',
      '施工方法：闭水试验后回填',
      '#### 1.1.2 污水管网工程工作包',
      '施工概况：检查井45座复述',
      '施工流程：测量放线→沟槽开挖→管道铺设',
      '施工方法：闭水试验合格后回填压实',
    ].join('\n');
    const out = mergeDuplicateWorkPackageSubsections(md);
    expect(out).not.toContain('工作包');
    expect(out).not.toContain('检查井45座复述');
    expect(out).toContain('#### 1.1.1 污水管网工程');
  });

  it('无编号标题包合并后保留 cleanTitle', () => {
    const md = [
      '### 项目主要施工内容',
      '#### 污水管网工程',
      '施工概况：HDPE双壁波纹管 DN400 约800m',
      '施工流程：沟槽开挖→管道基础→铺设',
      '施工方法：闭水试验后分层回填',
      '#### 污水管网工程工作包',
      '施工概况：HDPE双壁波纹管 DN300 约1200m',
      '施工流程：测量放线→沟槽开挖→管道铺设',
      '施工方法：闭水试验合格后回填压实',
    ].join('\n');
    const out = mergeDuplicateWorkPackageSubsections(md);
    expect(out).not.toContain('工作包');
    expect(out).toContain('#### 污水管网工程\n');
  });
});

describe('X4 dedupeQuantityFacts', () => {
  it('子串包含合并：保留 token 更多者', () => {
    expect(dedupeQuantityFacts(['道路工程：4500平方米', '4500平方米'])).toEqual(['道路工程：4500平方米']);
  });

  it('型号共享子串合并：保留 token 更多者', () => {
    expect(dedupeQuantityFacts(['配电箱 2APZ 2台', '配电箱 2APZ'])).toEqual(['配电箱 2APZ 2台']);
  });

  it('无子串无型号共享 → 全部保留（混凝土C30/C35 不同规格）', () => {
    expect(dedupeQuantityFacts(['混凝土C30', '混凝土C35'])).toEqual(['混凝土C30', '混凝土C35']);
  });

  it('子串合并替换为信息更全的后到条目', () => {
    expect(dedupeQuantityFacts(['AP1 配电箱', 'AP1 配电箱 2台'])).toEqual(['AP1 配电箱 2台']);
  });

  it('顺序保持', () => {
    expect(dedupeQuantityFacts(['A：2台', 'B：3套', 'C：4个'])).toEqual(['A：2台', 'B：3套', 'C：4个']);
  });

  it('空数组 → 空数组', () => {
    expect(dedupeQuantityFacts([])).toEqual([]);
  });
});

describe('X5 filterConstructionSteps', () => {
  const quantityFacts = ['安装配电箱 2台', '混凝土C30浇筑 45m³'];

  it('数字+量词清单条目剔除', () => {
    expect(filterConstructionSteps(['配电箱 2台', '沟槽开挖'], quantityFacts)).toEqual(['沟槽开挖']);
  });

  it('设备型号+柜箱词条目剔除', () => {
    expect(filterConstructionSteps(['AP1总箱安装', '放线定位'], quantityFacts)).toEqual(['放线定位']);
  });

  it('短工序词即使出现在清单条目中也保留', () => {
    expect(filterConstructionSteps(['砌筑'], ['砌筑工程 45m³'])).toEqual(['砌筑']);
  });

  it('短残尾为清单条目子串时剔除', () => {
    expect(filterConstructionSteps(['配电箱'], quantityFacts)).toEqual([]);
  });

  it('正常工序步骤保留', () => {
    expect(filterConstructionSteps(['沟槽开挖', '放线定位'], quantityFacts)).toEqual(['沟槽开挖', '放线定位']);
  });

  it('短动作词（试验）保留', () => {
    expect(filterConstructionSteps(['试验'], quantityFacts)).toEqual(['试验']);
  });

  it('空输入 → 空输出', () => {
    expect(filterConstructionSteps([], quantityFacts)).toEqual([]);
  });
});

describe('X6 scopeEngineeringNames', () => {
  it('「包括但不限于」形态提取顿号分隔工程名', () => {
    const ctx = '项目名称：肥西县丰乐镇人居环境整治项目。招标范围包括但不限于：土方工程、室外工程（景观、铺装、综合管网、智能化）、道路工程、雨污水管网工程。';
    expect(scopeEngineeringNames(ctx, [])).toEqual(['土方工程', '室外工程', '道路工程', '雨污水管网工程']);
  });

  it('「等」列举尾巴清洗：标识及其他项目等景观工程 → 景观工程', () => {
    const ctx = '招标范围包括但不限于：标识及其他项目等景观工程、道路工程、给排水工程。';
    expect(scopeEngineeringNames(ctx, [])).toContain('景观工程');
  });

  it('谓词开头碎片过滤（包括村内道路硬化…）', () => {
    const ctx = '招标范围包括但不限于：包括村内道路硬化及亮化提升、土方工程、道路工程、给排水工程。';
    const out = scopeEngineeringNames(ctx, []);
    expect(out).not.toContain('包括村内道路硬化及亮化提升');
    expect(out).toContain('土方工程');
  });

  it('「及其他」叙述组合过滤', () => {
    const ctx = '招标范围包括但不限于：水沟及其他所有构筑物拆除、土方工程、道路工程、给排水工程。';
    const out = scopeEngineeringNames(ctx, []);
    expect(out).not.toContain('水沟及其他所有构筑物拆除');
  });

  it('「是否」答疑疑问句过滤', () => {
    const ctx = '招标范围包括但不限于：是否考虑现场道路、土方工程、道路工程、给排水工程。';
    const out = scopeEngineeringNames(ctx, []);
    expect(out).not.toContain('是否考虑现场道路');
  });

  it('工程量/约束类文本反例过滤', () => {
    const ctx = '招标范围包括但不限于：工程量清单详见补疑、土方工程、道路工程、给排水工程。';
    const out = scopeEngineeringNames(ctx, []);
    expect(out).not.toContain('工程量清单详见补疑');
  });

  it('提取不足 3 项 → 空数组', () => {
    const ctx = '招标范围包括但不限于：土方工程、道路工程。';
    expect(scopeEngineeringNames(ctx, [])).toEqual([]);
  });

  it('无「招标范围」关键词 → 空数组', () => {
    expect(scopeEngineeringNames('项目名称：某项目。', [])).toEqual([]);
  });

  it('无「包括但不限于」时剥离招标范围前缀', () => {
    const ctx = '招标范围：土方工程、道路工程、给排水工程。';
    expect(scopeEngineeringNames(ctx, [])).toEqual(['土方工程', '道路工程', '给排水工程']);
  });

  it('包含关系去重：土方工程开挖 被 土方工程 吸收', () => {
    const ctx = '招标范围包括但不限于：土方工程、土方工程开挖、道路工程、给排水工程。';
    const out = scopeEngineeringNames(ctx, []);
    expect(out).toEqual(['土方工程', '道路工程', '给排水工程']);
  });

  it('项目范围隔离：其他项目名句不参与提取', () => {
    const ctx = '项目名称：肥西县丰乐镇人居环境整治项目。招标范围包括但不限于：土方工程、道路工程、给排水工程。桃花镇某某项目工程范围另见资料。';
    expect(scopeEngineeringNames(ctx, [])).toEqual(['土方工程', '道路工程', '给排水工程']);
  });

  it('evidence 内容同样参与提取', () => {
    const evidence = ev('招标范围包括但不限于：土方工程、道路工程、给排水工程。');
    expect(scopeEngineeringNames('无招标范围的主上下文。', [evidence])).toEqual(['土方工程', '道路工程', '给排水工程']);
  });
});

describe('X7 parseMajorConstructionPackages', () => {
  it('结构化 JSON 通道：解析工作包五元组', () => {
    const ctx = '施工工作包结构化数据： [{"name":"污水管网工程","scope":"村内污水管网改造","quantities":["HDPE管1200米"],"process":["测量放线→沟槽开挖→管道铺设"],"acceptance":["闭水试验"]}]';
    const packages = parseMajorConstructionPackages(ctx, []);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      name: '污水管网工程',
      scope: '村内污水管网改造',
      process: ['测量放线', '沟槽开挖', '管道铺设'],
      acceptance: ['闭水试验'],
    });
  });

  it('项目名形态 name 过滤（XX建设项目）', () => {
    const ctx = '施工工作包结构化数据： [{"name":"某某建设项目","scope":"范围","quantities":[],"process":[],"acceptance":[]}]';
    expect(parseMajorConstructionPackages(ctx, [])).toEqual([]);
  });

  it('年度形态 name 过滤（2024年度维修改造）', () => {
    const ctx = '施工工作包结构化数据： [{"name":"2024年度维修改造项目","scope":"范围","quantities":[],"process":[],"acceptance":[]}]';
    expect(parseMajorConstructionPackages(ctx, [])).toEqual([]);
  });

  it('scope 污染标记「资料内容事实：」被清洗后残留文本（见附件）→ 包保留', () => {
    const ctx = '施工工作包结构化数据： [{"name":"污水管网工程","scope":"资料内容事实：见附件","quantities":[],"process":[],"acceptance":[]}]';
    const packages = parseMajorConstructionPackages(ctx, []);
    expect(packages).toHaveLength(1);
    expect(packages[0].scope).toBe('见附件');
  });

  it('图谱行通道：解析 ｜ 分隔五元组', () => {
    const ctx = '1. 污水管网工程｜范围：村内污水管网改造｜工程量/材料：HDPE管1200米｜流程：测量放线→沟槽开挖｜验收：闭水试验';
    const packages = parseMajorConstructionPackages(ctx, []);
    expect(packages).toHaveLength(1);
    expect(packages[0].name).toBe('污水管网工程');
    expect(packages[0].quantities).toEqual(['HDPE管1200米']);
  });

  it('图谱行项目名形态过滤', () => {
    const ctx = '1. 某某建设项目｜范围：范围描述｜工程量/材料：X｜流程：Y→Z｜验收：W';
    expect(parseMajorConstructionPackages(ctx, [])).toEqual([]);
  });

  it('无任何数据 → 空数组', () => {
    expect(parseMajorConstructionPackages('普通上下文', [])).toEqual([]);
  });

  it('结构化 JSON 非法 → 回退图谱行通道', () => {
    const ctx = ['施工工作包结构化数据： [{非法json}]', '1. 污水管网工程｜范围：村内污水管网改造｜工程量/材料：HDPE管1200米｜流程：测量放线→沟槽开挖｜验收：闭水试验'].join('\n');
    const packages = parseMajorConstructionPackages(ctx, []);
    expect(packages).toHaveLength(1);
    expect(packages[0].name).toBe('污水管网工程');
  });

  it('图谱行通道 cap 8', () => {
    const lines = Array.from({ length: 10 }, (_item, i) => `${i + 1}. 工程${i + 1}｜范围：范围${i + 1}｜工程量/材料：X｜流程：Y→Z｜验收：W`);
    const packages = parseMajorConstructionPackages(lines.join('\n'), []);
    expect(packages).toHaveLength(8);
  });
});

describe('X8 majorConstructionSkeletonNames', () => {
  it('图谱名直接入骨架', () => {
    const ctx = '施工工作包结构化数据： [{"name":"污水管网工程","scope":"村内污水管网改造","quantities":[],"process":[],"acceptance":[]},{"name":"道路工程","scope":"村内道路","quantities":[],"process":[],"acceptance":[]},{"name":"给排水工程","scope":"给排水","quantities":[],"process":[],"acceptance":[]}]';
    expect(majorConstructionSkeletonNames(ctx, [])).toEqual(['污水管网工程', '道路工程', '给排水工程']);
  });

  it('图纸名残片过滤（施工图）', () => {
    const ctx = '施工工作包结构化数据： [{"name":"终端施工图","scope":"范围A","quantities":[],"process":[],"acceptance":[]}]';
    expect(majorConstructionSkeletonNames(ctx, [])).toEqual([]);
  });

  it('谓词开头碎片过滤', () => {
    const ctx = '施工工作包结构化数据： [{"name":"包括村内道路","scope":"范围A","quantities":[],"process":[],"acceptance":[]}]';
    expect(majorConstructionSkeletonNames(ctx, [])).toEqual([]);
  });

  it('超 20 字骨架名过滤', () => {
    const ctx = '施工工作包结构化数据： [{"name":"这是一个超过二十个字符的超长工程名称测试项","scope":"范围A","quantities":[],"process":[],"acceptance":[]}]';
    expect(majorConstructionSkeletonNames(ctx, [])).toEqual([]);
  });

  it('包含关系去重（图谱内）', () => {
    const ctx = '施工工作包结构化数据： [{"name":"土方工程","scope":"范围A","quantities":[],"process":[],"acceptance":[]},{"name":"土方工程开挖","scope":"范围B","quantities":[],"process":[],"acceptance":[]}]';
    expect(majorConstructionSkeletonNames(ctx, [])).toEqual(['土方工程']);
  });

  it('招标范围名补位（图谱+范围并集）', () => {
    const ctx = ['施工工作包结构化数据： [{"name":"污水管网工程","scope":"村内污水管网改造","quantities":[],"process":[],"acceptance":[]},{"name":"道路工程","scope":"村内道路","quantities":[],"process":[],"acceptance":[]}]', '招标范围包括但不限于：土方工程、道路工程、给排水工程。'].join('\n');
    expect(majorConstructionSkeletonNames(ctx, [])).toEqual(['污水管网工程', '道路工程', '土方工程', '给排水工程']);
  });
});
