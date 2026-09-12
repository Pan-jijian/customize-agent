/**
 * WS1/WS3/WS4/WS6 模板化治理单源模块边界枚举：结构标签判定与确定性修复、工序表达形式轮换、
 * 句式骨架指纹、标题完整性——检测口径（终检注册）与修复口径（SURFACE_FIX_STEPS / 修复目标）
 * 逐条锁定（断言按源码实现推导，真实行为锁定，不修改实现迎合用例）。
 */
import { describe, expect, it } from 'vitest';
import {
  SKELETON_FINGERPRINTS,
  classifyFlowForms,
  coreTitleName,
  countSkeletonFingerprint,
  fixFlowFormRepetition,
  fixSkeletonFingerprintRepetition,
  fixTemplatedLabels,
  fixTruncatedTitleCompletion,
  flowFormForBlockIndex,
  flowFormRepeatIssues,
  flowFormRepairTargets,
  flowRotationDirective,
  isStructuralLabelTitle,
  nextFlowForm,
  primaryFlowForm,
  skeletonFingerprintIssues,
  skeletonFingerprintRepairTargets,
  templatedLabelIssues,
  titleIntegrityIssues,
  titleRepairTargets,
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

  it('单指纹全文 >2 处 → error（上限 2 处），2 处不报', () => {
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

  it('skeletonFingerprintRepairTargets 按章聚合超量句（跳过全文前 2 处）', () => {
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
    expect(targets[0].totalCount).toBe(4);
    expect(targets[0].chapterTitle).toBe('乙章');
    expect(targets[0].sentences).toHaveLength(2);
  });

  it('fixSkeletonFingerprintRepetition 保留全文前 2 处、其余轮换变体（重叠指纹对清零）', () => {
    const md = [
      '## 甲章',
      '验收合格后方可进入下道工序。',
      '验收合格后方可组织隐蔽验收。',
      '验收合格后方可进行回填。',
      '验收合格后方可移交资料。',
    ].join('\n');
    const result = fixSkeletonFingerprintRepetition(md);
    expect(result.fixedCount).toBe(4);
    expect(skeletonFingerprintIssues(result.markdown)).toEqual([]);
    expect(result.markdown.match(/验收合格后方可/gu)).toHaveLength(2);
  });

  it('变体池不变式：任一变体不命中任一指纹（替换后不复发）', () => {
    for (const fingerprint of SKELETON_FINGERPRINTS) {
      for (const variant of fingerprint.variants) {
        for (const other of SKELETON_FINGERPRINTS) {
          const probe = new RegExp(other.pattern.source, other.pattern.flags);
          expect(probe.test(variant), `变体「${variant}」命中指纹「${other.text}」`).toBe(false);
        }
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

  it('残缺标题（<4 汉字）与悬挂连接词结尾 → error', () => {
    const md = ['## 第6章 危大工程管控', '### 6.5 危大', '正文内容。', '### 现场准备及', '正文内容。'].join('\n');
    const issues = titleIntegrityIssues(md);
    expect(issues).toHaveLength(2);
    expect(issues[0].message).toContain('危大');
    expect(issues[0].message).toContain('不足 4 字');
    expect(issues[1].message).toContain('悬挂连接词');
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
      { chapterTitle: '甲章', title: '2.1 危大', reason: '标题核心名不足 4 字（残缺标题）' },
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
