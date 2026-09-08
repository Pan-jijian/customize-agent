/**
 * t4-pr PR2 组：workflowRules 配置锁定 + 加载/合并/哈希矩阵（生成器产出，真实行为锁定）。
 * 覆盖：DEFAULT_WORKFLOW_RULES 全字段 / loadWorkflowRules（默认/覆盖/嵌套合并/损坏回退/缓存）/
 * workflowRulesHash（稳定哈希/覆盖变化/跨 root 一致）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_WORKFLOW_RULES, loadWorkflowRules, workflowRulesHash } from '@/services/document-workflow/workflowRules';

describe('DEFAULT_WORKFLOW_RULES', () => {
  it('thresholdComparison 词表', () => {
    expect(DEFAULT_WORKFLOW_RULES.factGovernance.thresholdComparison).toEqual("不低于|不少于|不高于|不超过|不得少于|不得高于|不得小于|不小于|不大于|大于等于|小于等于|≥|≤|≧|≦|以上|及以上|以内|之内");
  });
  it('amendmentContext 词表', () => {
    expect(DEFAULT_WORKFLOW_RULES.factGovernance.amendmentContext).toEqual("修正|调整|变更|更改|更正|改为|澄清|更新|修订");
  });
  it('aspirationalPrefix 词表', () => {
    expect(DEFAULT_WORKFLOW_RULES.factGovernance.aspirationalPrefix).toEqual("拟|规划|目标|力争|预计|期望|远期|未来|设想|建议|预期|争取|拟建|规划建设");
  });
  it('addendumSource 词表', () => {
    expect(DEFAULT_WORKFLOW_RULES.factGovernance.addendumSource).toEqual("补疑|答疑|澄清|补充|更正|修改");
  });
  it('weakAnchorGapThreshold', () => {
    expect(DEFAULT_WORKFLOW_RULES.factGovernance.weakAnchorGapThreshold).toEqual(9);
  });
  it('criticalSectionAnchors', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.criticalSectionAnchors).toEqual(["主要施工内容","工程概况","项目概况","重点难点","危大工程","应急预案","施工部署","总平面","主要分部分项工程施工方案","主要分部分项施工方案","主要施工方法"]);
  });
  it('majorContentSection 正则源', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.majorContentSection).toEqual("项目主要施工\\s*内容|主要施工\\s*内容");
  });
  it('divisionSection 正则源', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.divisionSection).toEqual("主要分部分项工程施工方案|主要分部分项施工方案|主要施工方法");
  });
  it('divisionProcessLabel', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.divisionProcessLabel).toEqual("工艺流程|施工流程");
  });
  it('criticalDeepSections', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.criticalDeepSections).toEqual(["项目特点.*重点.*难点|重点.*难点.*分析","项目主要施工\\s*内容|主要施工\\s*内容","主要分部分项工程施工方案|主要施工方法","危大工程专项施工方案审批流程","原材料进场复试|见证取样"]);
  });
  it('blockerMinChars', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.blockerMinChars).toEqual({"emergency":650,"majorContent":1800,"division":1200,"focus":1500});
  });
  it('divisionQuality', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.divisionQuality).toEqual({"blockerMinPackages":3,"minPackages":5,"minParamsPerPackage":4,"minPackageChars":150,"balanceRatio":0.3333333333333333});
  });
  it('writeRules.majorContent 长度', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.writeRules.majorContent.length).toEqual(1137);
  });
  it('writeRules.majorContent 含清单禁词', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.writeRules.majorContent.includes("分部小计") && DEFAULT_WORKFLOW_RULES.writingSpec.writeRules.majorContent.includes("综合单价")).toEqual(true);
  });
  it('writeRules.division 长度', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.writeRules.division.length).toEqual(718);
  });
  it('writeRules.division 含平衡要求', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.writeRules.division.includes("分项间深度必须均衡")).toEqual(true);
  });
  it('criticalSectionAnchors 含变体', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.criticalSectionAnchors.includes("主要分部分项施工方案")).toEqual(true);
  });
  it('blockerMinChars.emergency', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.blockerMinChars.emergency).toEqual(650);
  });
  it('blockerMinChars.majorContent', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.blockerMinChars.majorContent).toEqual(1800);
  });
  it('blockerMinChars.division', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.blockerMinChars.division).toEqual(1200);
  });
  it('blockerMinChars.focus', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.blockerMinChars.focus).toEqual(1500);
  });
  it('divisionQuality.blockerMinPackages', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.divisionQuality.blockerMinPackages).toEqual(3);
  });
  it('divisionQuality.minPackages', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.divisionQuality.minPackages).toEqual(5);
  });
  it('divisionQuality.minParamsPerPackage', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.divisionQuality.minParamsPerPackage).toEqual(4);
  });
  it('divisionQuality.minPackageChars', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.divisionQuality.minPackageChars).toEqual(150);
  });
  it('divisionQuality.balanceRatio', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.divisionQuality.balanceRatio).toEqual(0.3333333333333333);
  });
  it('thresholdComparison 含 ≥≤', () => {
    expect(DEFAULT_WORKFLOW_RULES.factGovernance.thresholdComparison.includes("≥") && DEFAULT_WORKFLOW_RULES.factGovernance.thresholdComparison.includes("≤")).toEqual(true);
  });
  it('aspirationalPrefix 含 拟建', () => {
    expect(DEFAULT_WORKFLOW_RULES.factGovernance.aspirationalPrefix.includes("拟建")).toEqual(true);
  });
});
describe('loadWorkflowRules', () => {
  it('无 projectRoot 返回默认', () => {
    const root = '/tmp/pr2-boundary-n1-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    const r = loadWorkflowRules(root);
    const r2 = loadWorkflowRules(undefined as any);
    expect(r2.factGovernance.weakAnchorGapThreshold).toEqual(9);
    expect(r2.writingSpec.blockerMinChars.emergency).toEqual(650);
    expect(r.factGovernance.weakAnchorGapThreshold).toEqual(9);
    expect(r.writingSpec.blockerMinChars.emergency).toEqual(650);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('无覆盖文件返回默认', () => {
    const root = '/tmp/pr2-boundary-n2-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    const r = loadWorkflowRules(root);
    expect(r === DEFAULT_WORKFLOW_RULES).toEqual(true);
    expect(r.factGovernance.thresholdComparison).toEqual("不低于|不少于|不高于|不超过|不得少于|不得高于|不得小于|不小于|不大于|大于等于|小于等于|≥|≤|≧|≦|以上|及以上|以内|之内");
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('空对象覆盖等于默认', () => {
    const root = '/tmp/pr2-boundary-n3-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.customize-agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), "{}");
    const r = loadWorkflowRules(root);
    expect(JSON.stringify(r.factGovernance)).toEqual("{\"thresholdComparison\":\"不低于|不少于|不高于|不超过|不得少于|不得高于|不得小于|不小于|不大于|大于等于|小于等于|≥|≤|≧|≦|以上|及以上|以内|之内\",\"amendmentContext\":\"修正|调整|变更|更改|更正|改为|澄清|更新|修订\",\"aspirationalPrefix\":\"拟|规划|目标|力争|预计|期望|远期|未来|设想|建议|预期|争取|拟建|规划建设\",\"addendumSource\":\"补疑|答疑|澄清|补充|更正|修改\",\"weakAnchorGapThreshold\":9}");
    expect(JSON.stringify(r.writingSpec.blockerMinChars)).toEqual("{\"emergency\":650,\"majorContent\":1800,\"division\":1200,\"focus\":1500}");
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('部分覆盖弱锚定阈值', () => {
    const root = '/tmp/pr2-boundary-n4-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.customize-agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), "{\"factGovernance\":{\"weakAnchorGapThreshold\":12}}");
    const r = loadWorkflowRules(root);
    expect(r.factGovernance.weakAnchorGapThreshold).toEqual(12);
    expect(r.factGovernance.thresholdComparison).toEqual("不低于|不少于|不高于|不超过|不得少于|不得高于|不得小于|不小于|不大于|大于等于|小于等于|≥|≤|≧|≦|以上|及以上|以内|之内");
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('覆盖正则源', () => {
    const root = '/tmp/pr2-boundary-n5-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.customize-agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), "{\"factGovernance\":{\"thresholdComparison\":\"自定义|模式\"}}");
    const r = loadWorkflowRules(root);
    expect(r.factGovernance.thresholdComparison).toEqual("自定义|模式");
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('嵌套覆盖 blockerMinChars 单项', () => {
    const root = '/tmp/pr2-boundary-n6-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.customize-agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), "{\"writingSpec\":{\"blockerMinChars\":{\"emergency\":999}}}");
    const r = loadWorkflowRules(root);
    expect(r.writingSpec.blockerMinChars.emergency).toEqual(999);
    expect(r.writingSpec.blockerMinChars.majorContent).toEqual(1800);
    expect(r.writingSpec.blockerMinChars.division).toEqual(1200);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('嵌套覆盖 divisionQuality 多项', () => {
    const root = '/tmp/pr2-boundary-n7-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.customize-agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), "{\"writingSpec\":{\"divisionQuality\":{\"minPackages\":9,\"balanceRatio\":0.5}}}");
    const r = loadWorkflowRules(root);
    expect(r.writingSpec.divisionQuality.minPackages).toEqual(9);
    expect(r.writingSpec.divisionQuality.balanceRatio).toEqual(0.5);
    expect(r.writingSpec.divisionQuality.minParamsPerPackage).toEqual(4);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('覆盖 writeRules 单项', () => {
    const root = '/tmp/pr2-boundary-n8-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.customize-agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), "{\"writingSpec\":{\"writeRules\":{\"majorContent\":\"自定义规则\"}}}");
    const r = loadWorkflowRules(root);
    expect(r.writingSpec.writeRules.majorContent).toEqual("自定义规则");
    expect(r.writingSpec.writeRules.division).toEqual("【主要分部分项工程施工方案专项要求】每个“#### 分项工程方案”三级小节内容需覆盖三方面要素：①作业对象与工程量（本项目作业对象、部位、工程量）、②工序安排（先后顺序清晰）、③施工方法（工具机具、材料规格、工艺参数、验收标准）。呈现形式不限：可分段用“施工概况/工艺流程/施工方法”标签组织，也可按内容自然成文，三方面要素齐全、写法正确即可。严禁用“**分项名**”粗体行代替“#### 分项名”小节标题，也不得把多个分项合并写在一个段落里。工程量数值必须与工程量清单汇总值一致（只写项目总量，禁止写分部小计、单村分表量或估算值），严禁出现工程量清单计价表内部口径词：分部小计、本页小计、合计、小计、按实、暂估、综合单价、措施项目费、规费、税金。工序要素必须有明确的工序顺序表达，形式由模型根据内容自然选择、不做统一要求——顺序词叙述、编号步骤、有序/无序列表或箭头链（如“基层清理→放线定位→分层摊铺→碾压→压实度检测→验收”）均可，每个分项方案至少 1 处不少于 4 个环节的工序顺序表达，不得只把工序顺序局限在一处标签段；每个分项方案正文必须落位至少 4 个工艺参数（mm、MPa、间距、偏差、坡度、养护天数、试验压力、搭接长度等），参数来自绑定材料或行业通用规范值，不得编造；纯设备配置型小节必须写型号、规格、容量、数量参数；不得写“按规范施工”“结合实际执行”式空话。分项间深度必须均衡：门窗维修、立面修补、设备安装等小分项同样要写足作业对象、工序与工艺参数（每个分项不少于 150 字），不得一句话带过；严禁写“其他专业工序引用相应章节内容”“详见相关章节”等自我消解语，工序安排只能在本分项方案内展开，不得另行拆节复述。");
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('覆盖 criticalSectionAnchors 数组', () => {
    const root = '/tmp/pr2-boundary-n9-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.customize-agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), "{\"writingSpec\":{\"criticalSectionAnchors\":[\"自定义锚点\"]}}");
    const r = loadWorkflowRules(root);
    expect(r.writingSpec.criticalSectionAnchors).toEqual(["自定义锚点"]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('损坏 JSON 回退默认', () => {
    const root = '/tmp/pr2-boundary-n10-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.customize-agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), "{invalid json");
    const r = loadWorkflowRules(root);
    expect(r.factGovernance.weakAnchorGapThreshold).toEqual(9);
    expect(r.writingSpec.blockerMinChars.emergency).toEqual(650);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('非对象 JSON 回退默认', () => {
    const root = '/tmp/pr2-boundary-n11-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.customize-agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), "[1,2,3]");
    const r = loadWorkflowRules(root);
    expect(r.factGovernance.weakAnchorGapThreshold).toEqual(9);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('全字段覆盖', () => {
    const root = '/tmp/pr2-boundary-n12-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.customize-agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), "{\"factGovernance\":{\"thresholdComparison\":\"X\",\"amendmentContext\":\"Y\",\"aspirationalPrefix\":\"Z\",\"addendumSource\":\"W\",\"weakAnchorGapThreshold\":99}}");
    const r = loadWorkflowRules(root);
    expect(r.factGovernance.thresholdComparison).toEqual("X");
    expect(r.factGovernance.weakAnchorGapThreshold).toEqual(99);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('覆盖后进程内缓存：改文件不热更新', () => {
    const root = '/tmp/pr2-boundary-n13-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.customize-agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), "{\"factGovernance\":{\"weakAnchorGapThreshold\":21}}");
    const r = loadWorkflowRules(root);
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), '{"factGovernance":{"weakAnchorGapThreshold":31}}');
    const second = loadWorkflowRules(root);
    expect(r.factGovernance.weakAnchorGapThreshold).toEqual(21);
    expect(second.factGovernance.weakAnchorGapThreshold).toEqual(21);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
describe('workflowRulesHash', () => {
  it('默认配置哈希锁定', () => {
    expect(workflowRulesHash()).toEqual("bbdcd5c87c4d78e70b504794fe75c42edcaa5823");
  });
  it('覆盖后哈希变化', () => {
    const root = '/tmp/pr2-boundary-hash-' + process.pid;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.customize-agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), '{"factGovernance":{"weakAnchorGapThreshold":21}}');
    const h = workflowRulesHash(root);
    expect(h).toEqual("006e1eaf9585579c0fd1a39302379be28b553eca");
    expect(h === "bbdcd5c87c4d78e70b504794fe75c42edcaa5823").toEqual(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('同配置不同 root 哈希一致', () => {
    const rootA = '/tmp/pr2-boundary-ha-' + process.pid;
    const rootB = '/tmp/pr2-boundary-hb-' + process.pid;
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
    fs.mkdirSync(path.join(rootA, '.customize-agent'), { recursive: true });
    fs.mkdirSync(path.join(rootB, '.customize-agent'), { recursive: true });
    fs.writeFileSync(path.join(rootA, '.customize-agent', 'workflow-rules.json'), '{"factGovernance":{"weakAnchorGapThreshold":21}}');
    fs.writeFileSync(path.join(rootB, '.customize-agent', 'workflow-rules.json'), '{"factGovernance":{"weakAnchorGapThreshold":21}}');
    expect(workflowRulesHash(rootA)).toEqual(workflowRulesHash(rootB));
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });
});
