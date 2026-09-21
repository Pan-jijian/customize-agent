/**
 * C8 全通道接线锁定（c8-6 防复发固化）：源文本静态断言——六通道（S1 链尾插入质量闸 / S2 结构
 * 动作保护 / S3 句模链尾重放与阈值密度化 / S4 口径校准批量 / S5 uniqueness 单源与句级坍塌轮 /
 * S6 数据源同步）的判定函数、单源消费与链尾接线被重构静默删除时即红。
 * 行为语义由各通道专项用例覆盖（requirementTailClosure / slim-block-input / sentencePattern /
 * 各口径单测 / duplicateSentenceCollapse / templatingTailReplay 等）；轮序与注册表快照由
 * repairRounds.order / repairRounds.snapshot / detectorFixerRegistry 三处覆盖；本文件只锁
 * 「降采样后仍必须存在」的字面接线与零静默降级出口（C7 plannedBlockRetry 源文本锁定同模式）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');
const read = (relative: string) => readFileSync(path.join(SRC_DIR, relative), 'utf8');

const pipelineSrc = read('documentPipeline.ts');
const registrySrc = read('detectorFixerRegistry.ts');
const governanceSrc = read('templatingGovernance.ts');
const scoringSrc = read('tenderBidScoring.ts');
const requirementsSrc = read('tenderRequirements.ts');
const validationSrc = read('qualityValidation.ts');

/** S1 链尾插入质量闸（E 通道：三连重复 / 绕失去重 / 死锁重插的判定加固与形态闸） */
describe('C8 S1 插入质量闸接线锁定', () => {
  const repairSrc = read('finalize/repairRounds/requirementResponseRepair.ts');

  it('质量闸三要素导出不缺失：8 字符下限 / 归一化签名 / 插入物形态闸', () => {
    expect(repairSrc).toContain('const INSERTION_SIGNATURE_MIN_CHARS = 8;');
    expect(repairSrc).toContain('export function insertionSignature(text: string): string {');
    expect(repairSrc).toContain('export function insertionMaterialRejection(material: string): string | null {');
  });

  it('插入前消费：签名查重 + 形态闸 + 跨轮幂等集合', () => {
    expect(repairSrc).toContain('if (signature.length >= INSERTION_SIGNATURE_MIN_CHARS && markdownSignature.includes(signature)) {');
    expect(repairSrc).toContain('const rejection = insertionMaterialRejection(material);');
    expect(repairSrc).toContain('attemptedSignatures?: Set<string>;');
  });

  it('零静默降级守护：形态闸拒插必须显性记录（rejectedDetails 出口不消失）', () => {
    expect(repairSrc).toContain('rejectedDetails.push(');
  });

  it('短条款死锁兜底：total=0 时以整体文本为唯一分句（clauseSatisfied 不再恒假）', () => {
    expect(requirementsSrc).toContain('if (segments.length === 0) {');
    expect(requirementsSrc).toContain('return { total: 1, missing: wholeHit ? [] : [whole] };');
  });
});

/** S2 结构动作保护（A 通道：切分劈括号 + 规模数值盲替换） */
describe('C8 S2 结构动作保护接线锁定', () => {
  const cleanupSrc = read('helpers/markdownCleanup.ts');

  it('括号深度感知切分：栈跟踪四类括号 + 深度 0 切分 + 两级切分均接入', () => {
    expect(cleanupSrc).toContain("const openToClose: Record<string, string> = { '（': '）', '(': ')', '【': '】', '「': '」' };");
    expect(cleanupSrc).toContain('if (separators.includes(ch) && stack.length === 0) {');
    expect(cleanupSrc).toContain("splitOutsideBrackets(line, '。；')");
    expect(cleanupSrc).toContain("splitOutsideBrackets(sentence, '，,')");
  });

  it('长窗实体隔离门：实体词表 + 48 字符窗 + 检测/修复双侧接入（单源同门）', () => {
    expect(validationSrc).toContain('const SCALE_ENTITY_WINDOW_CHARS = 48;');
    expect(validationSrc).toContain('const SCALE_ENTITY_WORDS_RE = /门卫|门房|岗亭|值班室|传达室|警卫室|公厕|车棚|雨棚|配电房|配电室|泵房|水泵房|锅炉房|样板房|售楼处|构筑物|用房|配套设施|\\d{1,3}[栋座处]/u;');
    // 定义 1 + 检测侧（scopedNumericEntries）+ 修复侧（collectScopeSpans）三处消费
    expect(validationSrc.match(/SCALE_ENTITY_WORDS_RE/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('零静默降级守护：跳过项经「规模口径复核」warning 显性交 LLM', () => {
    expect(validationSrc).toContain('if (scaleSkipped.length > 0) {');
    expect(validationSrc).toContain('规模口径复核：');
  });
});

/** S3 句模链尾重放 + 命中线密度化（F/C 通道） */
describe('C8 S3 句模链尾重放与阈值密度化接线锁定', () => {
  const sweepSrc = read('finalize/repairRounds/sentencePatternSweep.ts');

  it('密度化单源：底线常量 + 阈值函数（max(6, 正文字数/5000)）', () => {
    expect(governanceSrc).toContain('export const SENTENCE_PATTERN_MIN_REPEATS = 6;');
    expect(governanceSrc).toContain('return Math.max(SENTENCE_PATTERN_MIN_REPEATS, Math.ceil(documentTextLength(markdown) / 5000));');
  });

  it('多端单源消费：检测（sentencePatternRepeatIssues）/ 修复目标（sentencePatternRepairTargets）/ 评分', () => {
    expect(governanceSrc).toContain('export function sentencePatternRepeatIssues(markdown: string): ValidationIssue[] {');
    expect(governanceSrc).toContain('export function sentencePatternRepairTargets(markdown: string): SentencePatternRepairTarget[] {');
    expect(scoringSrc).toContain('const sentencePatternLine = sentencePatternThreshold(markdown);');
    expect(governanceSrc.match(/sentencePatternThreshold\(markdown\)/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('链尾重放：剥离器（form-announcement 族单源）+ 修复轮消费 + pipeline 调用 + 注册表 id', () => {
    expect(governanceSrc).toContain('export function stripSentencePatternAnnouncements(markdown: string): {');
    expect(governanceSrc).toContain("const family = SENTENCE_PATTERN_FAMILIES.find(item => item.id === 'form-announcement')!;");
    expect(sweepSrc).toContain('const stripped = stripSentencePatternAnnouncements(session.finalMarkdown);');
    expect(pipelineSrc).toContain('await stageSentencePatternSweep(session);');
    expect(registrySrc).toContain("'sentence-pattern-sweep',");
  });
});

/** S4 口径校准批量（B/D 通道五修复点） */
describe('C8 S4 口径校准批量接线锁定', () => {
  const paramSrc = read('parameterConceptConflicts.ts');
  const utilsSrc = read('utils.ts');
  const gatesSrc = read('globalQualityGates.ts');
  const factSrc = read('factReconciliation.ts');

  it('①a 层数直比豁免：量词表登记层数 + 词面直比前置消解', () => {
    expect(paramSrc).toContain("'尺寸', '层数', '次数', '跨度', '半径', '总长', '全长',");
    expect(paramSrc).toContain('if (GENERIC_MEASURE_WORDS.some(word => concept === word || normalizeConcept(concept) === word)) continue;');
  });

  it('①b 调度声明豁免：声明词与分组词同权 + grouped 双分支（warning 提示 / 无声明维持 blocker）', () => {
    expect(validationSrc).toContain('const grouped = /组|村/u.test(context) || SCHEDULE_DECLARATION_RE.test(context);');
    expect(validationSrc).toContain('设备分组口径提示：');
    expect(validationSrc).toContain('配置台数出现互相矛盾的取值');
  });

  it('② 修饰词插入放行 + 规划数组并发去重', () => {
    expect(utilsSrc).toContain('function subclassModifierMatch(small: string, large: string): boolean {');
    expect(utilsSrc).toContain('!subclassModifierMatch(left, right) && !subclassModifierMatch(right, left)');
    expect(gatesSrc).toContain('const lineCollision = new Map<number, typeof located>();');
    expect(gatesSrc).toContain('chapter.sections = rawSections.filter((_, index) => !droppedIndexes.includes(index));');
  });

  it('③ 业务语义列「无」豁免（豁免限于「无」形态，其余占位词任何列不豁免）', () => {
    expect(validationSrc).toContain('存在问题|整改措施|整改情况|复查结果|处理情况|检查情况|落实情况|验收结论|备注|说明');
    expect(validationSrc).toContain('/^无+$/u.test(cell)) return false;');
  });

  it('④ 枚举换项豁免 + 设备配置豁免扩「套」', () => {
    expect(factSrc).toContain('if (/[、,，]/u.test(bindingGap)) {');
    expect(factSrc).toContain('bindingGap.split(/[、,，]/u).pop()');
    expect(factSrc).toContain("if (valueMatch[3] === '台' || valueMatch[3] === '套') {");
  });

  it('⑤ 锚点变体归一：整体与分句两分支均接变体通道（同族归一单源）', () => {
    expect(requirementsSrc).toContain('function anchorVariantHit(text: string, variantMarkdown: string): boolean {');
    expect(requirementsSrc).toContain('anchorVariantHit(whole, variantMarkdown)');
    expect(requirementsSrc).toContain('anchorVariantHit(segment, variantMarkdown)');
  });
});

/** S5/S6 链尾收口轮（U 通道单源 + A' 数据源同步） */
describe('C8 S5/S6 链尾收口轮接线锁定', () => {
  const collapseSrc = read('finalize/repairRounds/duplicateSentenceCollapse.ts');
  const replaySrc = read('finalize/repairRounds/templatingTailReplay.ts');

  it('S5 单源：duplicateSentenceOccurrences 明细拆分导出 + 泛句帧常量 + 坍塌轮双单源消费', () => {
    expect(scoringSrc).toContain('export function duplicateSentenceOccurrences(markdown: string)');
    expect(governanceSrc).toContain('export const GENERALIZED_CLOSURE_SENTENCE_RE = /^(?:上述|相关|有关)(?:要求|做法|措施|内容|安排|控制要点|控制项|控制内容|作业要求)/u;');
    expect(collapseSrc).toContain("import { GENERALIZED_CLOSURE_SENTENCE_RE } from '../../templatingGovernance';");
    expect(collapseSrc).toContain("import { duplicateSentenceOccurrences } from '../../tenderBidScoring';");
  });

  it('S5/S6 新轮三重接线：导出 + pipeline 调用 + 注册表 id 不缺失', () => {
    expect(collapseSrc).toContain('export async function stageDuplicateSentenceCollapse(session: FinalizeSession): Promise<void> {');
    expect(replaySrc).toContain('export async function stageTemplatingTailReplay(session: FinalizeSession): Promise<void> {');
    expect(pipelineSrc).toContain('await stageDuplicateSentenceCollapse(session);');
    expect(pipelineSrc).toContain('await stageTemplatingTailReplay(session);');
    expect(registrySrc).toContain("'duplicate-sentence-collapse',");
    expect(registrySrc).toContain("'templating-tail-replay',");
  });

  it('链尾顺序锁定：句模重放 → 句级坍塌 → templating 重放 → 标点兜底 → 终门禁（位置递增）', () => {
    const order = [
      'await stageSentencePatternSweep(session);',
      'await stageDuplicateSentenceCollapse(session);',
      'await stageTemplatingTailReplay(session);',
      'await replaySurfacePunctuationClosure(session);',
      'await stageFinalGate(session);',
    ].map(needle => pipelineSrc.indexOf(needle));
    expect(order.every(index => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });
});

/** 评分口径版本（C8 递增，全出口常量派生由 c8-5 出口表覆盖） */
describe('C8 评分口径版本锁定', () => {
  const calibrationSrc = read('scoringCalibration.ts');

  it('常量递增 c8.0 + C8 批次注释与变更点显性记录（防口径漂移归因误判）', () => {
    expect(calibrationSrc).toContain("export const SCORING_CALIBRATION_VERSION = 'quality-caliber-c8.0';");
    expect(calibrationSrc).toContain('C8 批次 = quality-caliber-c8.0');
    expect(calibrationSrc).toContain('评分口径变更点：');
  });

  it('全出口常量派生（主尺/从属/专业分均引用 SCORING_CALIBRATION_VERSION）', () => {
    expect(calibrationSrc.match(/version: SCORING_CALIBRATION_VERSION,/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
