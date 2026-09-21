/**
 * WS1/WS3/WS4/WS6 模板化治理单源模块边界枚举：结构标签判定与确定性修复、工序表达形式轮换、
 * 句式骨架指纹、标题完整性——检测口径（终检注册）与修复口径（SURFACE_FIX_STEPS / 修复目标）
 * 逐条锁定（断言按源码实现推导，真实行为锁定，不修改实现迎合用例）。
 */
import { describe, expect, it } from 'vitest';
import {
  SENTENCE_PATTERN_FAMILIES,
  SENTENCE_PATTERN_MIN_REPEATS,
  SKELETON_FINGERPRINTS,
  classifyFlowForms,
  coreTitleName,
  countSentencePatternHits,
  countSkeletonFingerprint,
  fixFlowFormRepetition,
  fixSentenceLikeHeadingSplit,
  fixSkeletonFingerprintRepetition,
  fixTemplatedLabels,
  fixTruncatedTitleCompletion,
  flowFormForBlockIndex,
  flowFormRepeatIssues,
  flowFormRepairTargets,
  flowRotationDirective,
  isStructuralLabelTitle,
  nextFlowForm,
  plannedTitleMatchKey,
  primaryFlowForm,
  sentencePatternRepeatIssues,
  sentencePatternRepairTargets,
  sentencePatternThreshold,
  skeletonFingerprintIssues,
  skeletonFingerprintRepairTargets,
  splitSentenceLikeHeading,
  stripSentencePatternAnnouncements,
  templatedLabelIssues,
  titleIntegrityIssues,
  titleRepairTargets,
  uncoveredHeadingRemainder,
} from '@/services/document-workflow/templatingGovernance';

describe('isStructuralLabelTitle（结构标签独立成题判定）', () => {
  it('裸标签标题命中（含「工艺流程」）', () => {
    expect(isStructuralLabelTitle('施工概况')).toBe(true);
    expect(isStructuralLabelTitle('施工流程')).toBe(true);
    expect(isStructuralLabelTitle('施工方法')).toBe(true);
    expect(isStructuralLabelTitle('工艺流程')).toBe(true);
    expect(isStructuralLabelTitle('施工工艺')).toBe(true);
    expect(isStructuralLabelTitle('施工步骤')).toBe(true);
    expect(isStructuralLabelTitle('概况')).toBe(true);
    expect(isStructuralLabelTitle('流程概述')).toBe(true);
    expect(isStructuralLabelTitle('施工工艺流程')).toBe(true);
  });

  it('带编号/括号前缀归一化后同样命中', () => {
    expect(isStructuralLabelTitle('1.2 施工流程')).toBe(true);
    expect(isStructuralLabelTitle('（三）施工方法')).toBe(true);
    expect(isStructuralLabelTitle('2.3.1 工艺流程')).toBe(true);
  });

  it('合法正式标题不命中（锚定小节豁免与含限定词标题）', () => {
    expect(isStructuralLabelTitle('主要施工方法')).toBe(false);
    expect(isStructuralLabelTitle('主要施工内容')).toBe(false);
    expect(isStructuralLabelTitle('项目主要施工内容')).toBe(false);
    expect(isStructuralLabelTitle('工程概况')).toBe(false);
    expect(isStructuralLabelTitle('施工部署')).toBe(false);
    expect(isStructuralLabelTitle('施工准备')).toBe(false);
    expect(isStructuralLabelTitle('施工组织设计')).toBe(false);
    expect(isStructuralLabelTitle('质量控制')).toBe(false);
    expect(isStructuralLabelTitle('主要工艺流程与施工顺序')).toBe(false);
  });

  it('空标题安全', () => {
    expect(isStructuralLabelTitle('')).toBe(false);
    expect(isStructuralLabelTitle('   ')).toBe(false);
  });
});

describe('templatedLabelIssues（标签标题 / 段首前缀检测）', () => {
  it('H4 标签标题报 error（含样例与确定性修复指引）', () => {
    const md = ['### 项目主要施工内容', '#### 施工概况', '本包范围覆盖雨水管网。'].join('\n');
    const issues = templatedLabelIssues(md);
    const headingIssue = issues.find(issue => issue.message.includes('充当小节标题'));
    expect(headingIssue).toBeDefined();
    expect(headingIssue!.level).toBe('error');
    expect(headingIssue!.repairability).toBe('local_deterministic');
    expect(headingIssue!.message).toContain('1 处');
    expect(headingIssue!.message).toContain('#### 施工概况');
  });

  it('段首标签前缀报 error（含加粗形态）', () => {
    const md = '施工概况：本项目位于合肥。\n**施工流程**：先开挖再回填。';
    const issues = templatedLabelIssues(md);
    const prefixIssue = issues.find(issue => issue.message.includes('段首结构标签前缀'));
    expect(prefixIssue).toBeDefined();
    expect(prefixIssue!.message).toContain('2 处');
    expect(prefixIssue!.repairability).toBe('local_deterministic');
  });

  it('正常叙述正文不报（无标签标题与段首前缀）', () => {
    const md = [
      '### 项目主要施工内容',
      '本项目室外道排范围覆盖园区雨水管网，主要工程量 DN300 约 1200m。',
      '施工按测量放线、沟槽开挖、管道铺设的顺序组织，沟槽机械开挖配合人工清底。',
    ].join('\n');
    expect(templatedLabelIssues(md)).toEqual([]);
  });

  it('锚定小节标题豁免不报（主要施工方法）', () => {
    const md = ['#### 主要施工方法', '正文内容。'].join('\n');
    expect(templatedLabelIssues(md)).toEqual([]);
  });
});

describe('fixTemplatedLabels（确定性修复：删标题行保正文 / 剥前缀）', () => {
  it('H4 标签标题行删除（正文保留）+ 吞后继空行', () => {
    const md = [
      '### 1 室外道排工程',
      '',
      '#### 施工概况',
      '',
      '本包覆盖雨水管网。',
      '#### 施工方法',
      '采用机械开挖。',
    ].join('\n');
    const result = fixTemplatedLabels(md);
    expect(result.markdown).toBe(['### 1 室外道排工程', '', '本包覆盖雨水管网。', '采用机械开挖。'].join('\n'));
    expect(result.fixedCount).toBe(2);
    expect(result.details).toEqual(['结构标签标题删除 2 行（正文保留）']);
  });

  it('段首前缀剥离（保正文；加粗与列表符形态；剥离后空行删除）', () => {
    const md = ['施工概况：本项目位于合肥市。', '**施工流程**：先开挖，再回填。', '- 施工方法：机械开挖。', '施工要点：'].join('\n');
    const result = fixTemplatedLabels(md);
    expect(result.markdown).toBe(['本项目位于合肥市。', '先开挖，再回填。', '机械开挖。'].join('\n'));
    expect(result.fixedCount).toBe(4);
    expect(result.details).toEqual(['段首标签前缀剥离 4 处']);
  });

  it('H3 标签标题不删（交 LLM 重命名，防结构损毁）', () => {
    const md = '### 施工流程\n正文内容。';
    const result = fixTemplatedLabels(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });

  it('无标签文本 → 原样返回', () => {
    const md = '### 1 包A\n施工按测量放线、开挖、回填组织。';
    const result = fixTemplatedLabels(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
    expect(result.details).toEqual([]);
  });

  it('正文孤立小节标题行删除（舒城 4.28.x 实测：小节名被当正文输出）', () => {
    const md = [
      '#### 2.7.1 路基处理',
      '本段路基处理作业对象为车行道路基与人行道路基，核心工程量为素土回填与级配碎石。',
      '路基处理',
      '1. 进行清表与土方开挖；',
      '2. 实施素土分层回填；',
    ].join('\n');
    const result = fixTemplatedLabels(md);
    expect(result.markdown).toBe([
      '#### 2.7.1 路基处理',
      '本段路基处理作业对象为车行道路基与人行道路基，核心工程量为素土回填与级配碎石。',
      '1. 进行清表与土方开挖；',
      '2. 实施素土分层回填；',
    ].join('\n'));
    expect(result.fixedCount).toBe(1);
    expect(result.details).toEqual(['正文孤立小节标题行删除 1 行']);
  });

  it('孤立标题行零误伤：标题后现/含标点/带列表符/无同名标题均不删', () => {
    const md = [
      '路基处理',
      '#### 2.7.1 路基处理',
      '路基处理。',
      '- 路基处理',
      '素土回填',
    ].join('\n');
    const result = fixTemplatedLabels(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });

  it('孤立标题行前后均空行时吞尾随空行（防双空行残留）', () => {
    const md = ['#### 2.7.1 路基处理', '', '正文段落。', '', '路基处理', '', '1. 进行清表。'].join('\n');
    const result = fixTemplatedLabels(md);
    expect(result.markdown).toBe(['#### 2.7.1 路基处理', '', '正文段落。', '', '1. 进行清表。'].join('\n'));
    expect(result.markdown).not.toContain('\n\n\n');
  });
});

describe('flowFormForBlockIndex / nextFlowForm / flowRotationDirective（形式轮换）', () => {
  it('index%4 轮换（负数安全）', () => {
    expect(flowFormForBlockIndex(0)).toBe('顺序词叙述');
    expect(flowFormForBlockIndex(1)).toBe('编号步骤');
    expect(flowFormForBlockIndex(2)).toBe('有序列表');
    expect(flowFormForBlockIndex(3)).toBe('箭头链');
    expect(flowFormForBlockIndex(4)).toBe('顺序词叙述');
    expect(flowFormForBlockIndex(-1)).toBe('箭头链');
  });

  it('nextFlowForm 环内后移（末尾回环）', () => {
    expect(nextFlowForm('顺序词叙述')).toBe('编号步骤');
    expect(nextFlowForm('箭头链')).toBe('顺序词叙述');
  });

  it('flowRotationDirective 注入指定形式与禁用标签文案', () => {
    const directive = flowRotationDirective(1);
    expect(directive).toContain('编号步骤');
    expect(directive).toContain('禁止通篇使用同一形式');
    expect(directive).toContain('不得用“施工流程：”等结构标签引导');
  });
});

describe('classifyFlowForms / primaryFlowForm（四形式分类与主导判定）', () => {
  it('四形式并行计数', () => {
    const counts = classifyFlowForms('先开挖，再回填。\n1. 放线\n2. 铺设\n- 检测\n- 验收\nA→B→C');
    expect(counts).toEqual({ 箭头链: 2, 编号步骤: 2, 有序列表: 2, 顺序词叙述: 1 });
  });

  it('箭头链主导', () => {
    expect(primaryFlowForm('施工按基层清理→放线定位→分层摊铺→碾压→验收组织。')).toBe('箭头链');
  });

  it('逗号分隔的“先……，再……”句式归顺序词叙述', () => {
    expect(primaryFlowForm('先测量放线，再沟槽开挖，随后管道铺设，最后回填验收。')).toBe('顺序词叙述');
  });

  it('无逗号“先……后……”句式同样归顺序词叙述', () => {
    expect(primaryFlowForm('先支撑后开挖组织施工。')).toBe('顺序词叙述');
  });

  it('编号步骤主导（≥2 行编号）', () => {
    expect(primaryFlowForm('施工工序：\n1. 测量放线\n2. 沟槽开挖\n3. 管道铺设')).toBe('编号步骤');
  });

  it('有序列表主导（≥2 行列表符）', () => {
    expect(primaryFlowForm('- 基层清理\n- 放线定位\n- 分层摊铺')).toBe('有序列表');
  });

  it('混合文本按计数取最高者', () => {
    expect(primaryFlowForm('先开挖，再回填。沟槽开挖→管道铺设→回填。')).toBe('箭头链');
  });

  it('无任何工序顺序表达 → undefined', () => {
    expect(primaryFlowForm('本包范围覆盖雨水管网，管材 HDPE。')).toBeUndefined();
    expect(primaryFlowForm('')).toBeUndefined();
  });
});

describe('flowFormRepeatIssues / flowFormRepairTargets（相邻块同形式）', () => {
  it('分部分项章相邻块同形式 → error（含章节块名与轮换建议）', () => {
    const md = [
      '## 主要分部分项工程施工方案',
      '### 1 室外道排工程',
      '施工按基层清理→放线定位→分层摊铺→碾压组织。',
      '### 2 围墙工程',
      '施工按基础开挖→垫层浇筑→砌筑→抹面组织。',
    ].join('\n');
    const issues = flowFormRepeatIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].owner).toBe('llm');
    expect(issues[0].message).toContain('相邻小节');
    expect(issues[0].message).toContain('室外道排工程');
    expect(issues[0].message).toContain('围墙工程');
    expect(issues[0].message).toContain('箭头链');
    expect(issues[0].suggestion).toContain('顺序词叙述');
  });

  it('相邻块不同形式不报', () => {
    const md = [
      '## 主要分部分项工程施工方案',
      '### 1 室外道排工程',
      '施工按基层清理→放线定位→分层摊铺→碾压组织。',
      '### 2 围墙工程',
      '先基础开挖，再垫层浇筑，随后砌筑抹面。',
    ].join('\n');
    expect(flowFormRepeatIssues(md)).toEqual([]);
  });

  it('非工作包章不报（施工部署章两块同形式）', () => {
    const md = ['## 施工部署', '### 组织架构', '施工按 A→B→C 组织。', '### 进度安排', '施工按 D→E→F 组织。'].join('\n');
    expect(flowFormRepeatIssues(md)).toEqual([]);
  });

  it('单块章不报（<2 块跳过）', () => {
    const md = ['## 项目主要施工内容', '### 1 包A', '施工按 A→B→C 组织。'].join('\n');
    expect(flowFormRepeatIssues(md)).toEqual([]);
  });

  it('flowFormRepairTargets 指向同形式对中的后块与目标形式', () => {
    const md = [
      '## 主要分部分项工程施工方案',
      '### 1 室外道排工程',
      '施工按基层清理→放线定位→分层摊铺组织。',
      '### 2 围墙工程',
      '施工按基础开挖→垫层浇筑→砌筑组织。',
    ].join('\n');
    expect(flowFormRepairTargets(md)).toEqual([
      { chapterTitle: '主要分部分项工程施工方案', blockTitle: '2 围墙工程', currentForm: '箭头链', targetForm: '顺序词叙述' },
    ]);
  });
});

describe('skeletonFingerprintIssues / skeletonFingerprintRepairTargets / fixSkeletonFingerprintRepetition（骨架指纹）', () => {
  const fingerprintByText = (text: string) => {
    const found = SKELETON_FINGERPRINTS.find(item => item.text === text);
    if (!found) throw new Error(`未找到指纹 ${text}`);
    return found;
  };

  it('基准字形全文 >2 处 → error（上限 2 处），建议不附同义示例；2 处不报', () => {
    const md = [
      '## 甲章',
      '由技术负责人组织测量放线。',
      '由技术负责人组织钢筋验收。',
      '由技术负责人组织模板检查。',
    ].join('\n');
    const issues = skeletonFingerprintIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('由技术负责人组织');
    expect(issues[0].message).toContain('3 处');
    expect(issues[0].suggestion).toContain('前 2 处');
    // 4.40 d5e：示例即模板化源头——建议不暴露具体同义变体（历史缺陷：LLM 抄写示例变体 37 处）
    expect(issues[0].suggestion).not.toContain('牵头');
    expect(issues[0].suggestion).not.toContain('再行');
    expect(skeletonFingerprintIssues(['## 甲章', '由技术负责人组织测量放线。', '由技术负责人组织钢筋验收。'].join('\n'))).toEqual([]);
  });

  it('“验收合格后方可”重叠段两指纹各计 1 处（验收表独立计数口径）', () => {
    const md = ['## 甲章', '验收合格后方可进入下道工序。'].join('\n');
    expect(countSkeletonFingerprint(md, fingerprintByText('合格后方可'))).toBe(1);
    expect(countSkeletonFingerprint(md, fingerprintByText('验收合格后'))).toBe(1);
    expect(countSkeletonFingerprint(md, fingerprintByText('由技术负责人组织'))).toBe(0);
  });

  it('弹性空白容错计数（“由 技术负责人 组织”仍命中）', () => {
    const md = ['## 甲章', '由 技术负责人 组织复测。'].join('\n');
    expect(countSkeletonFingerprint(md, fingerprintByText('由技术负责人组织'))).toBe(1);
  });

  it('变体形态全篇 >8 处 → error（前缀「由/项目部/裸」归一同形态）；建议不附具体替换示例', () => {
    const md = [
      '## 甲章',
      '由技术负责人牵头组织测量放线。',
      '项目部技术负责人牵头组织钢筋验收。',
      '技术负责人牵头组织模板检查。',
      '由技术负责人牵头组织隐蔽验收。',
      '项目部技术负责人牵头组织混凝土浇筑。',
      '技术负责人牵头组织砌体检查。',
      '由技术负责人牵头组织防水验收。',
      '项目部技术负责人牵头组织回填检查。',
      '技术负责人牵头组织资料移交。',
    ].join('\n');
    const issues = skeletonFingerprintIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('句式变体复读');
    expect(issues[0].message).toContain('技术负责人牵头组织');
    expect(issues[0].message).toContain('9 处');
    expect(issues[0].suggestion).toContain('前 8 处');
    expect(issues[0].suggestion).not.toContain('负责组织');
    expect(issues[0].suggestion).not.toContain('统筹组织');
    const eight = ['## 甲章', ...Array.from({ length: 8 }, (_, index) => `由技术负责人牵头组织第 ${index + 1} 项检查。`)].join('\n');
    expect(skeletonFingerprintIssues(eight)).toEqual([]);
  });

  it('skeletonFingerprintRepairTargets 按章聚合超量句（跳过全文前 2 处；cap 标注保留额度）', () => {
    const md = [
      '## 甲章',
      '由技术负责人组织测量放线。',
      '由技术负责人组织钢筋验收。',
      '## 乙章',
      '由技术负责人组织模板检查。',
      '由技术负责人组织隐蔽验收。',
    ].join('\n');
    const targets = skeletonFingerprintRepairTargets(md);
    expect(targets).toHaveLength(1);
    expect(targets[0].fingerprintLabel).toBe('由技术负责人组织');
    expect(targets[0].cap).toBe(2);
    expect(targets[0].totalCount).toBe(4);
    expect(targets[0].chapterTitle).toBe('乙章');
    expect(targets[0].sentences).toHaveLength(2);
  });

  it('skeletonFingerprintRepairTargets 覆盖变体形态（超 8 处仅保留额度外的句子进入修复目标）', () => {
    const md = [
      '## 甲章',
      ...Array.from({ length: 9 }, (_, index) => `由技术负责人牵头组织第 ${index + 1} 项检查。`),
    ].join('\n');
    const targets = skeletonFingerprintRepairTargets(md);
    expect(targets).toHaveLength(1);
    expect(targets[0].fingerprintLabel).toBe('技术负责人牵头组织');
    expect(targets[0].cap).toBe(8);
    expect(targets[0].totalCount).toBe(9);
    expect(targets[0].sentences).toHaveLength(1);
    expect(targets[0].sentences[0]).toContain('第 9 项检查');
  });

  it('fixSkeletonFingerprintRepetition 保留全文前 2 处基准、其余按形态池均衡改写（重叠指纹对清零）', () => {
    const md = [
      '## 甲章',
      '验收合格后方可进入下道工序。',
      '验收合格后方可组织隐蔽验收。',
      '验收合格后方可进行回填。',
      '验收合格后方可移交资料。',
    ].join('\n');
    const result = fixSkeletonFingerprintRepetition(md);
    expect(result.fixedCount).toBe(4);
    expect(result.details).toEqual([
      { id: 'post-qualified', replaced: 2 },
      { id: 'after-acceptance', replaced: 2 },
    ]);
    expect(skeletonFingerprintIssues(result.markdown)).toEqual([]);
    expect(result.markdown.match(/验收合格后方可/gu)).toHaveLength(2);
    // 负载均衡：超量句改入不同形态（不集中复用同一替换）
    expect(result.markdown).toContain('验收通过后再行进行回填');
    expect(result.markdown).toContain('通过验收后方能移交资料');
  });

  it('fixSkeletonFingerprintRepetition 收敛变体复读（12 处牵头组织 → 保留 8 处、其余均衡改入形态池）', () => {
    const md = [
      '## 甲章',
      ...Array.from({ length: 12 }, (_, index) => `由技术负责人牵头组织第 ${index + 1} 项检查。`),
    ].join('\n');
    const result = fixSkeletonFingerprintRepetition(md);
    expect(result.fixedCount).toBe(4);
    expect(result.details).toEqual([{ id: 'by-tech-lead-org', replaced: 4 }]);
    expect(skeletonFingerprintIssues(result.markdown)).toEqual([]);
    expect(result.markdown.match(/技术负责人牵头组织/gu)).toHaveLength(8);
    expect(result.markdown.match(/技术负责人负责组织/gu)).toHaveLength(1);
    expect(result.markdown.match(/技术负责人统筹组织/gu)).toHaveLength(1);
    expect(result.markdown.match(/技术负责人统一组织/gu)).toHaveLength(1);
  });

  it('变体改写语法安全：仅替换动词短语位，宾语与事实完整保留', () => {
    const md = [
      '## 甲章',
      ...Array.from({ length: 9 }, (_, index) => `由技术负责人牵头组织开展第 ${index + 1} 项班前安全交底。`),
    ].join('\n');
    const result = fixSkeletonFingerprintRepetition(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('由技术负责人负责组织开展第 9 项班前安全交底。');
    expect(result.markdown.match(/由技术负责人牵头组织开展/gu)).toHaveLength(8);
  });

  it('修复器幂等：收敛后再运行零改动', () => {
    const md = [
      '## 甲章',
      ...Array.from({ length: 12 }, (_, index) => `由技术负责人牵头组织第 ${index + 1} 项检查。`),
    ].join('\n');
    const once = fixSkeletonFingerprintRepetition(md);
    const twice = fixSkeletonFingerprintRepetition(once.markdown);
    expect(twice.fixedCount).toBe(0);
    expect(twice.markdown).toBe(once.markdown);
  });

  it('形态池不变式：形态字形命中自身 pattern；基准改写为任一变体字形后不再命中基准', () => {
    for (const fingerprint of SKELETON_FINGERPRINTS) {
      for (const form of [fingerprint, ...fingerprint.variantForms]) {
        const probe = new RegExp(form.pattern.source, form.pattern.flags);
        expect(probe.test(form.text), `形态「${form.text}」未命中自身 pattern`).toBe(true);
      }
      for (const variant of fingerprint.variantForms) {
        const probe = new RegExp(fingerprint.pattern.source, fingerprint.pattern.flags);
        expect(probe.test(variant.text), `变体「${variant.text}」命中基准「${fingerprint.text}」`).toBe(false);
      }
    }
  });

  it('2 处不产生修复目标', () => {
    const md = ['## 甲章', '由技术负责人组织巡查。', '由技术负责人组织复测。'].join('\n');
    expect(skeletonFingerprintRepairTargets(md)).toEqual([]);
  });
});

describe('coreTitleName / titleIntegrityIssues / titleRepairTargets（标题完整性）', () => {
  it('coreTitleName 剥「第X章」与数字编号', () => {
    expect(coreTitleName('第3章 施工部署')).toBe('施工部署');
    expect(coreTitleName('3.2.1 基坑支护')).toBe('基坑支护');
    expect(coreTitleName('第三节 危大工程')).toBe('危大工程');
    expect(coreTitleName('一、总体安排')).toBe('一、总体安排');
  });

  it('残缺标题（<3 汉字）与悬挂连接词结尾 → error', () => {
    const md = ['## 第6章 危大工程管控', '### 6.5 危大', '正文内容。', '### 现场准备及', '正文内容。'].join('\n');
    const issues = titleIntegrityIssues(md);
    expect(issues).toHaveLength(2);
    expect(issues[0].message).toContain('危大');
    expect(issues[0].message).toContain('不足 3 字');
    expect(issues[1].message).toContain('悬挂连接词');
  });

  it('3 字完整专业词标题不判残缺（4.44 #3 根治：小菜园）', () => {
    const md = ['## 第2章 施工部署', '### 2.1.4 小菜园', '正文内容。', '### 沟塘清淤', '正文内容。'].join('\n');
    expect(titleIntegrityIssues(md)).toEqual([]);
    // 确定性补全同样不动 3 字完整词（检测与补全同源）
    expect(fixTruncatedTitleCompletion(md).fixedCount).toBe(0);
  });

  it('句化标题（含逗号）→ error', () => {
    const md = ['## 甲章', '### 混凝土浇筑应连续进行，不得中断', '正文内容。'].join('\n');
    const issues = titleIntegrityIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('含逗号');
  });

  it('合法标题与豁免字词不报（含字母短标题）', () => {
    const md = ['## 甲章', '### 危大工程辨识与管控', '### 主要施工方法', '### BIM应用', '### 目录', '正文内容。'].join('\n');
    expect(titleIntegrityIssues(md)).toEqual([]);
  });

  it('同核心名去重（不同编号同一残缺名只报一次）', () => {
    const md = ['## 甲章', '### 2.1 危大', '### 2.4 危大', '正文内容。'].join('\n');
    expect(titleIntegrityIssues(md)).toHaveLength(1);
  });

  it('titleRepairTargets 携带标题原文与缺陷原因', () => {
    const md = ['## 甲章', '### 2.1 危大', '正文内容。'].join('\n');
    expect(titleRepairTargets(md)).toEqual([
      { chapterTitle: '甲章', title: '2.1 危大', reason: '标题核心名不足 3 字（残缺标题）' },
    ]);
  });
});

describe('fixFlowFormRepetition（工序形式确定性轮换修复）', () => {
  it('顺序词叙述链：后块联动转换 + 前块回溯补转（相邻同形式清零，内容与数值保真）', () => {
    const md = [
      '## 主要分部分项工程施工方案',
      '### 2.16 白鸥观澜公厕-土建装饰装修工程',
      '零星装饰工程覆盖四栋单体。施工顺序为：先安装金属扶手与栏杆，再安装成品隔断、洗漱台和无障碍设施，随后安装镜面玻璃、接水板与金属装饰条，然后进行塑料装饰线收口和空调洞、过水洞开孔，最后固定建筑永久铭牌。扶手安装后水平段直线度偏差不大于4mm。',
      '### 2.19 门卫-土建结构与基础工程',
      '门卫工程为配套附属单体，施工顺序按先地下后地上、先结构后围护的原则组织。',
      '### 2.22 综合配套用房-安装工程',
      '先进行配管预埋与桥架安装，再穿线敷设电缆，随后安装配电箱与末端灯具，最后进行送配电系统调试与接地电阻测试。',
    ].join('\n');
    expect(flowFormRepeatIssues(md)).toHaveLength(2);
    const result = fixFlowFormRepetition(md);
    expect(result.fixedCount).toBe(2);
    expect(flowFormRepeatIssues(result.markdown)).toEqual([]);
    expect(result.markdown).toContain('1. 安装金属扶手与栏杆；');
    expect(result.markdown).toContain('5. 固定建筑永久铭牌。');
    expect(result.markdown).toContain('1. 进行配管预埋与桥架安装；');
    // 无可拆序列句的弱工序块（2.19）内容原样保留
    expect(result.markdown).toContain('施工顺序按先地下后地上、先结构后围护的原则组织。');
    // 事实与数值逐字保留
    expect(result.markdown).toContain('直线度偏差不大于4mm');
    expect(result.markdown).toContain('成品隔断、洗漱台和无障碍设施');
  });

  it('箭头链链：中块转顺序词叙述，首尾块保留（链元素逐字保真）', () => {
    const md = [
      '## 主要分部分项工程施工方案',
      '### 2.28 排水管道及井室施工方法',
      '管道安装按“下管→对口→稳管→接口→养护”五步组织，施工遵循“先深后浅、先干管后支管”的顺序。',
      '### 2.29 道路结构层拆除与恢复方法',
      '沥青面层施工按“透层→封层→粘层→下面层→粘层→上面层”顺序组织，人行道恢复按“路床整形碾压→级配碎石底基层→混凝土垫层→面层铺装”四步组织。',
      '### 2.30 配电箱及电气安装方法',
      '配电箱安装按“基础制作→箱体就位→母线连接→回路接线→绝缘测试→通电调试”六步组织。',
    ].join('\n');
    expect(flowFormRepeatIssues(md)).toHaveLength(2);
    const result = fixFlowFormRepetition(md);
    expect(result.fixedCount).toBe(1);
    expect(flowFormRepeatIssues(result.markdown)).toEqual([]);
    expect(result.markdown).toContain('先透层，再封层，随后粘层，然后下面层，接着粘层，最后上面层');
    expect(result.markdown).toContain('先路床整形碾压，再级配碎石底基层，随后混凝土垫层，最后面层铺装');
    // 首尾块原箭头链保留（仅转换同形式对）
    expect(result.markdown).toContain('下管→对口→稳管→接口→养护');
    expect(result.markdown).toContain('基础制作→箱体就位→母线连接→回路接线→绝缘测试→通电调试');
  });

  it('编号步骤链：后块标记换为有序列表（行结构与内容不动）', () => {
    const md = [
      '## 主要分部分项工程施工方案',
      '### 1 甲工程',
      '施工工序：\n1. 测量放线\n2. 沟槽开挖',
      '### 2 乙工程',
      '施工工序：\n1. 基层清理\n2. 管道铺设\n3. 回填验收',
    ].join('\n');
    const result = fixFlowFormRepetition(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('- 基层清理');
    expect(result.markdown).toContain('- 管道铺设');
    expect(flowFormRepeatIssues(result.markdown)).toEqual([]);
  });

  it('相邻块形式已不同时零动作（原文原样返回）', () => {
    const md = [
      '## 主要分部分项工程施工方案',
      '### 1 室外道排工程',
      '施工按基层清理→放线定位→分层摊铺组织。',
      '### 2 围墙工程',
      '先基础开挖，再垫层浇筑，随后砌筑抹面。',
    ].join('\n');
    const result = fixFlowFormRepetition(md);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(md);
    expect(result.details).toEqual([]);
  });

  it('非工作包章不动作（章范围外同形式无视）', () => {
    const md = ['## 施工部署', '### 组织架构', '施工按 A→B→C 组织。', '### 进度安排', '施工按 D→E→F 组织。'].join('\n');
    const result = fixFlowFormRepetition(md);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(md);
  });

  // 4.39 实机截断根因（“……水舌3个。施工先……，最后……。”转换后「施工」遗留为无标点悬空行尾，
  // 终检误判「句尾截断」）：序列帧前缀非空（嵌在句中）一律放弃转换；冒号引导前缀（合法引导语）保持可转换
  it('悬空前缀保护：句中前缀的序列句放弃转换（不产生无标点悬空行尾），回溯转前块归零相邻同形式', () => {
    const md = [
      '## 主要分部分项工程施工方案',
      '### 2.22 综合配套用房-安装工程',
      '先进行配管预埋与桥架安装，再穿线敷设电缆，随后安装配电箱与末端灯具，最后进行送配电系统调试与接地电阻测试。',
      '### 2.20 室外附属-装饰工程',
      '零星装饰工程覆盖四栋单体。水舌3个。施工先进行基层清理与定位放线，再按设计位置开孔、安装预埋件，随后安装装饰线条与配件，最后进行缝隙封堵与表面清理。',
    ].join('\n');
    const result = fixFlowFormRepetition(md);
    expect(result.fixedCount).toBe(1);
    // 悬空前缀句放弃转换（原样保留），无「施工⏎1. 」式无标点行尾产物
    expect(result.markdown).not.toContain('施工\n1. ');
    expect(result.markdown).toContain('施工先进行基层清理与定位放线，再按设计位置开孔、安装预埋件，随后安装装饰线条与配件，最后进行缝隙封堵与表面清理。');
    // 回溯转前块（前块可转换）：相邻同形式归零
    expect(result.markdown).toContain('1. 进行配管预埋与桥架安装；');
    expect(flowFormRepeatIssues(result.markdown)).toEqual([]);
  });

  it('冒号引导前缀保持可转换（“施工顺序：先……最后……”正常编号化）', () => {
    const md = [
      '## 主要分部分项工程施工方案',
      '### 1 甲工程',
      '先基础开挖，再垫层浇筑，随后砌筑抹面。',
      '### 2 乙工程',
      '施工顺序：先进行基层清理，再放线定位，最后组织验收。',
    ].join('\n');
    const result = fixFlowFormRepetition(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('施工顺序：\n1. 进行基层清理；');
    expect(result.markdown).toContain('3. 组织验收。');
  });
});

describe('fixTruncatedTitleCompletion（残缺标题确定性补全）', () => {
  it('正文取证补全：电气 → 电气系统 / 通风 → 通风系统（正文与数值不动）', () => {
    const md = [
      '## 甲章',
      '### 2.22 综合配套用房-安装工程',
      '#### 2.22.1 电气',
      '',
      '电气系统施工对象包括配电箱42台、配管2326.87m；先进行配管预埋与桥架安装，再穿线敷设电缆。',
      '#### 2.22.3 通风',
      '',
      '通风系统施工对象包括通风机6台、碳钢通风管道13.23m2。',
    ].join('\n');
    expect(titleIntegrityIssues(md)).toHaveLength(2);
    const result = fixTruncatedTitleCompletion(md);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toContain('#### 2.22.1 电气系统');
    expect(result.markdown).toContain('#### 2.22.3 通风系统');
    expect(result.markdown).toContain('电气系统施工对象包括配电箱42台、配管2326.87m');
    expect(titleIntegrityIssues(result.markdown)).toEqual([]);
  });

  it('H3 残缺名同样补全（危大 → 危大工程）', () => {
    const md = [
      '## 甲章',
      '### 6.5 危大',
      '',
      '危大工程辨识与管控按专项方案执行，含危大工程施工监测。',
    ].join('\n');
    const result = fixTruncatedTitleCompletion(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('### 6.5 危大工程');
  });

  it('取证失败不补（正文无 core+工程后缀实锤）+ 合法标题不动', () => {
    const md = [
      '## 甲章',
      '### 2.1 危大',
      '',
      '本节内容按要求执行。',
      '### 2.2 模板与脚手架工程',
      '',
      '模板与脚手架工程包括模板配置与支撑体系搭设。',
    ].join('\n');
    const result = fixTruncatedTitleCompletion(md);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(md);
  });
});

// ── 句化标题切分（4.27.2 标题合并治理：规划标题与正文首句并写还原） ──

describe('plannedTitleMatchKey（规划标题匹配键归一化）', () => {
  it('剥编号/标记与全部空白标点', () => {
    expect(plannedTitleMatchKey('2.11 公厕机电安装工程')).toBe('公厕机电安装工程');
    expect(plannedTitleMatchKey('第2节 质量保证措施')).toBe('质量保证措施');
    expect(plannedTitleMatchKey('**村庄道路工程**')).toBe('村庄道路工程');
    expect(plannedTitleMatchKey('公厕、机电 安装工程')).toBe('公厕机电安装工程');
  });
});

describe('splitSentenceLikeHeading（句化标题切分识别）', () => {
  it('规划标题前缀 + 长续写句 → 命中并返回余部（丰乐镇实测形态）', () => {
    const split = splitSentenceLikeHeading(
      '公厕机电安装工程集中在马老郢、马小郢等自然村的公厕进行给排水、电气及通风工程改造，施工前完成现场交接与首件样板验收',
      ['公厕机电安装工程', '村庄道路基层与面层作业'],
    );
    expect(split?.plannedTitle).toBe('公厕机电安装工程');
    expect(split?.remainder).toContain('集中在马老郢');
  });

  it('余部不足 10 字（正常标题修饰）不切分', () => {
    expect(splitSentenceLikeHeading('公厕机电安装工程', ['公厕机电安装工程'])).toBeUndefined();
    expect(splitSentenceLikeHeading('公厕机电安装工程改造', ['公厕机电安装工程'])).toBeUndefined();
  });

  it('最长前缀优先（村庄道路 vs 村庄道路基层与面层作业）', () => {
    const split = splitSentenceLikeHeading(
      '村庄道路基层与面层作业覆盖9个自然村进行混凝土浇筑施工',
      ['村庄道路', '村庄道路基层与面层作业'],
    );
    expect(split?.plannedTitle).toBe('村庄道路基层与面层作业');
  });
});

describe('uncoveredHeadingRemainder（续写句覆盖判定：零丢失防线）', () => {
  it('后继正文已包含续写句（容忍软换行空格差异）→ 全部覆盖返回空串', () => {
    expect(uncoveredHeadingRemainder('集中在马圩 自然村组进行施工。', '前置内容。集中在马圩自然村组进行施工。后续内容。')).toBe('');
  });

  it('部分覆盖 → 仅返回未覆盖整句拼接', () => {
    expect(uncoveredHeadingRemainder('本项目严格落实扬尘防治措施。施工期间每日洒水。', '本项目严格落实扬尘防治措施。其他内容。')).toBe('施工期间每日洒水。');
  });

  it('无后继正文 → 全部返回（转正文插入）', () => {
    expect(uncoveredHeadingRemainder('覆盖9个自然村的道路施工。', '')).toBe('覆盖9个自然村的道路施工。');
  });
});

describe('fixSentenceLikeHeadingSplit（句化标题切分确定性修复）', () => {
  const PLANNED = ['公厕机电安装工程', '村庄道路基层与面层作业'];

  it('实测形态：### 2.11 规划标题+长句并写 → 标题还原，续写句未覆盖转正文段', () => {
    const md = [
      '## 第十一章 机电安装工程',
      '### 2.11 公厕机电安装工程集中在马老郢、马小郢等自然村进行给排水与电气改造，施工前完成现场交接与样板验收。',
      '后续正文。',
    ].join('\n');
    const result = fixSentenceLikeHeadingSplit(md, PLANNED);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('### 2.11 公厕机电安装工程\n\n集中在马老郢');
    expect(result.markdown).not.toContain('### 2.11 公厕机电安装工程集中');
  });

  it('续写句已被后继正文覆盖 → 仅还原标题丢弃余部（不重复写入）', () => {
    const md = [
      '### 2.12 村庄道路基层与面层作业覆盖9个自然村的道路进行混凝土浇筑施工。',
      '覆盖9个自然村的道路进行混凝土浇筑施工。',
    ].join('\n');
    const result = fixSentenceLikeHeadingSplit(md, PLANNED);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('### 2.12 村庄道路基层与面层作业');
    expect(result.markdown.split('覆盖9个自然村的道路进行混凝土浇筑施工。').length - 1).toBe(1);
  });

  it('未注入规划标题 / 正常标题 / H2 标题 → 静默跳过（零误伤）', () => {
    const md = ['## 第二章 质量保证措施', '### 2.1 模板与脚手架工程', '正文。'].join('\n');
    expect(fixSentenceLikeHeadingSplit(md).fixedCount).toBe(0);
    expect(fixSentenceLikeHeadingSplit(md, []).fixedCount).toBe(0);
    expect(fixSentenceLikeHeadingSplit(md, ['模板与脚手架工程']).fixedCount).toBe(0);
  });

  it('H4 形态与编号保留（#### 2.11.3 前缀原样）', () => {
    const md = '#### 2.11.3 公厕机电安装工程集中在马老郢等自然村进行改造施工。';
    const result = fixSentenceLikeHeadingSplit(md, PLANNED);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('#### 2.11.3 公厕机电安装工程\n\n集中在马老郢等自然村进行改造施工。');
  });
});

describe('sentencePattern*（句模聚类复读：C4 D3 检测/修复目标同源）', () => {
  /** 完整链样本：先…再…随后…最后（≥3 连接词——探针 F1e 同口径；2 连接词短链不计数防误伤） */
  const chain = (i: number) => `第${i}段砌筑渠道施工先开挖基槽并夯实槽底，再浇筑C15混凝土垫层，随后砌筑渠身并抹面，最后回填两侧土方并压实。`;

  it('正样本：完整顺序链 6 句 → blocker 命中（sequence-chain）', () => {
    const markdown = Array.from({ length: 6 }, (_, i) => chain(i + 1)).join('\n');
    const issues = sentencePatternRepeatIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'error', severity: 'blocker', category: 'style' });
    expect(issues[0].message).toContain('多段顺序词链');
    expect(issues[0].message).toContain('6 处');
    expect(issues[0].suggestion).toContain('保留全文前 5 处');
  });

  it('反样本：仅 2 连接词的短链（先…再…最后）不计数——防误伤', () => {
    const short = (i: number) => `第${i}段先清理基层浮土，再铺筑垫层拌合料，最后验收移交。`;
    const markdown = Array.from({ length: 6 }, (_, i) => short(i + 1)).join('\n');
    expect(sentencePatternRepeatIssues(markdown)).toEqual([]);
  });

  it('正样本：完成即转入 / 验收衔接 / 资料闭环 三族各自命中', () => {
    const afterCompletion = Array.from({ length: 6 }, (_, i) => `第${i + 1}段管道安装完成后进行水压试验，试验压力为0.6MPa。`);
    const acceptance = Array.from({ length: 6 }, (_, i) => `第${i + 1}分项验收合格后方可进入下道工序施工。`);
    const closedLoop = Array.from({ length: 6 }, (_, i) => `第${i + 1}道工序检测合格后报监理复验并形成记录闭环。`);
    expect(sentencePatternRepeatIssues(afterCompletion.join('\n'))[0].message).toContain('完成即转入式');
    expect(sentencePatternRepeatIssues(acceptance.join('\n'))[0].message).toContain('验收衔接式');
    expect(sentencePatternRepeatIssues(closedLoop.join('\n'))[0].message).toContain('资料闭环式');
  });

  it('正样本：形式宣告式（施工按以下顺序组织：/ 工序按编号步骤组织：）→ blocker 命中', () => {
    const markdown = Array.from({ length: 6 }, (_, i) => `第${i + 1}工作包施工按以下顺序组织：`).join('\n');
    const issues = sentencePatternRepeatIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('形式宣告式');
    const numbered = Array.from({ length: 6 }, (_, i) => `第${i + 1}工作包工序按编号步骤组织：`).join('\n');
    expect(sentencePatternRepeatIssues(numbered)[0].message).toContain('形式宣告式');
  });

  it('阈值：5 句不命中、第 6 句起命中（SENTENCE_PATTERN_MIN_REPEATS 单源）', () => {
    const family = SENTENCE_PATTERN_FAMILIES.find(item => item.id === 'sequence-chain')!;
    const five = Array.from({ length: 5 }, (_, i) => chain(i + 1)).join('\n');
    expect(countSentencePatternHits(five, family)).toBe(5);
    expect(sentencePatternRepeatIssues(five)).toEqual([]);
    const six = [...five.split('\n'), chain(6)].join('\n');
    expect(sentencePatternRepeatIssues(six)).toHaveLength(1);
    expect(SENTENCE_PATTERN_MIN_REPEATS).toBe(6);
  });

  it('防误伤：标题行/表格行/短碎片/单点多样表达 → 零命中', () => {
    const markdown = [
      '#### 3.1 先开挖基槽再浇筑垫层随后砌筑最后回填的施工顺序安排',
      '| 先开挖 | 再浇筑 | 随后砌筑 | 然后养护 | 最后回填 |',
      '先挖。再填。随后整。',
      '管道安装完成后进行水压试验，试验压力0.6MPa。',
      '防水层验收合格后方可进入保护层施工。',
      '隐蔽工程验收后形成验收记录归档。',
    ].join('\n');
    expect(sentencePatternRepeatIssues(markdown)).toEqual([]);
  });

  it('修复目标：保留额度 5 处按章序消耗、每章至多 4 句、跨族去重归首族', () => {
    const chapter1 = ['## 第一章 主体结构', '', ...Array.from({ length: 4 }, (_, i) => chain(i + 1))].join('\n');
    const chapter2 = ['## 第二章 装饰装修', '', ...Array.from({ length: 4 }, (_, i) => chain(i + 5))].join('\n');
    const targets = sentencePatternRepairTargets([chapter1, chapter2].join('\n'));
    expect(targets).toHaveLength(1);
    expect(targets[0].chapterTitle).toContain('第二章');
    expect(targets[0]).toMatchObject({ patternId: 'sequence-chain', totalCount: 8, cap: 5 });
    expect(targets[0].sentences).toHaveLength(3);
    // 跨族去重：同句双命中（顺序链 + 形式宣告）检测双族命中，修复目标只归首族
    const dual = (i: number) => `第${i}工作包施工作业按以下顺序组织实施：先开挖基槽，再浇筑垫层，随后砌筑渠身，然后养护，最后回填。`;
    const dualMarkdown = ['## 第一章 施工方案', '', ...Array.from({ length: 6 }, (_, i) => dual(i + 1))].join('\n');
    expect(sentencePatternRepeatIssues(dualMarkdown)).toHaveLength(2);
    expect(sentencePatternRepairTargets(dualMarkdown).map(target => target.patternId)).toEqual(['sequence-chain']);
  });

  it('三端同源：检测 message 计数 = 单族计数 = 修复目标 totalCount', () => {
    const family = SENTENCE_PATTERN_FAMILIES.find(item => item.id === 'sequence-chain')!;
    const markdown = ['## 第一章 施工方案', '', ...Array.from({ length: 7 }, (_, i) => chain(i + 1))].join('\n');
    expect(countSentencePatternHits(markdown, family)).toBe(7);
    expect(sentencePatternRepeatIssues(markdown)[0].message).toContain('7 处');
    expect(sentencePatternRepairTargets(markdown)[0].totalCount).toBe(7);
  });
});

/**
 * C8 S3（F/C 通道）：①句模宣告引导句确定性剥离（链尾 markdown-only 收口，检测定位=修复定位）；
 * ②命中线密度归一（max(6, ceil(正文字数/5000)) = 2.0 处/万字）——绝对计数 6 于长文误伤自然语式
 * （r28m' 6.5 万字 8 处判误报 vs s28m' 21 万字 46 处判真复读），修复后 s28m' 残留 38 处（1.82/万）通过。
 */
describe('C8 S3 句模链尾收口（stripSentencePatternAnnouncements + 阈值密度化）', () => {
  it('sentencePatternThreshold：底线 6 + 每 5000 字上浮 1（校准锚点 r28m’/s28m’ 处/万字）', () => {
    expect(sentencePatternThreshold('')).toBe(6);
    expect(sentencePatternThreshold('甲'.repeat(30000))).toBe(6);
    expect(sentencePatternThreshold('甲'.repeat(30001))).toBe(7);
    // r28m’ 6.5 万字：阈值 13；自然语式 1.23 处/万字（8 处）通过
    const r28mPrime = sentencePatternThreshold('甲'.repeat(65000));
    expect(r28mPrime).toBe(13);
    expect(8).toBeLessThan(r28mPrime);
    // s28m’ 21 万字：阈值 42；修复前 2.20 处/万字（46 处）命中、S3① 剥离后 1.82 处/万字（38 处）通过
    const s28mPrime = sentencePatternThreshold('甲'.repeat(210000));
    expect(s28mPrime).toBe(42);
    expect(46).toBeGreaterThanOrEqual(s28mPrime);
    expect(38).toBeLessThan(s28mPrime);
  });

  it('密度归一端到端：同一 7 处复读，短文档命中、加长后（阈值 8）通过', () => {
    const chain = (i: number) => `第${i}段砌筑渠道施工先开挖基槽并夯实槽底，再浇筑C15混凝土垫层，随后砌筑渠身并抹面，最后回填两侧土方并压实。`;
    const markdown = Array.from({ length: 7 }, (_, i) => chain(i + 1)).join('\n');
    expect(sentencePatternThreshold(markdown)).toBe(6);
    expect(sentencePatternRepeatIssues(markdown)).toHaveLength(1);
    // 同 7 处复读 + 长文填充（总字数 >35000 → 阈值 8）：密度不足判误报 → 零命中
    const padded = [markdown, '', '甲'.repeat(35000)].join('\n');
    expect(sentencePatternThreshold(padded)).toBe(8);
    expect(sentencePatternRepeatIssues(padded)).toEqual([]);
  });

  it('剥离：整行仅宣告句 → 删行 + 紧邻空行压缩（列表自承载全部信息，删除无损）', () => {
    const markdown = ['## 第一章 施工方案', '', '施工按以下顺序组织：', '', '- 场地平整与测量放线', '- 基础工程施工'].join('\n');
    const result = stripSentencePatternAnnouncements(markdown);
    expect(result.removedCount).toBe(1);
    expect(result.removedSentences[0]).toBe('施工按以下顺序组织：');
    // 删行后紧邻空行一并压缩：标题与列表间保留单一空行
    expect(result.markdown).toBe(['## 第一章 施工方案', '', '- 场地平整与测量放线', '- 基础工程施工'].join('\n'));
  });

  it('剥离：行内末句宣告 → 仅剥末句、前文保留（前驱句以「。」结尾，不做标点修补）', () => {
    const markdown = ['测量放线已完成并经复核。施工按以下编号步骤组织：', '', '- 步骤一：复核基准点'].join('\n');
    const result = stripSentencePatternAnnouncements(markdown);
    expect(result.removedCount).toBe(1);
    expect(result.markdown).toContain('测量放线已完成并经复核。\n');
    expect(result.markdown).not.toContain('施工按以下编号步骤组织');
  });

  it('族词形变体（作业×下列 / 工序×以下）同样剥离；剥离后重放零变更', () => {
    const markdown = ['## 第一章 施工组织', '', '作业按下列步骤展开：', '', '工序按以下次序排列：', '', '- 内容项'].join('\n');
    const result = stripSentencePatternAnnouncements(markdown);
    expect(result.removedCount).toBe(2);
    expect(result.markdown).toBe(['## 第一章 施工组织', '', '- 内容项'].join('\n'));
    const again = stripSentencePatternAnnouncements(result.markdown);
    expect(again.removedCount).toBe(0);
    expect(again.markdown).toBe(result.markdown);
  });

  it('防误伤：自承载表述（句后有实际内容）/标题行/表格行 → 零剥离且原样返回', () => {
    const markdown = [
      '施工按以下顺序组织：先搭设围挡，再布设排水，最后硬化场地。',
      '',
      '施工按以下顺序组织：详见附表一。',
      '',
      '| 施工按以下顺序组织： |',
      '',
      '# 施工按以下顺序组织：',
    ].join('\n');
    const result = stripSentencePatternAnnouncements(markdown);
    expect(result.removedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });
});
