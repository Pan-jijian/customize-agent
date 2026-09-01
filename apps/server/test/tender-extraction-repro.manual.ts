/**
 * 评分项要求提取漏提根因复现（manual，不入 vitest 常规集）：
 * 还原合肥师范项目招标直读切片（kb.db 154 条），按真实预筛三条件（义务词形/程序词形/兜底保留）
 * 确定性复现 153 条预筛输入 → 真实 LLM 主提取；窄通道按词形命中子集（27 条，真实召回的子集）
 * → 真实 LLM 窄通道提取 → merge → 必提字段判定。真实 LLM 调用（需本地配置可用）。
 * 运行：npx vitest run --config /tmp/vitest-manual.config.ts
 */
import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  extractRequirementFieldGaps,
  extractTenderRequirements,
  mergeTenderRequirements,
  missingMandatoryFields,
  requirementFieldGaps,
} from '../src/services/document-workflow/tenderRequirements';
import type { DocumentEvidence } from '../src/services/document-workflow/types';

const DB_PATH = '/Users/pan/.customize-agent/projects/3c3f04667c69/kb.db';

// 与 tenderRequirements.ts 保持一致的词形正则
const OBLIGATION_LEXICAL_HINTS = /确保|争创|创优|优质工程奖|获得.{0,10}[杯奖]|鲁班奖|绿色建筑|星级|智慧工地|装配率|装配式|六个百分百|四节一环保|达到.{0,6}(合格|优良)|质量标准|验收标准|特殊要求|按最高标准执行|按计划|违约金|工期延误|计划工期|日历天|安全文明|文明施工|扬尘|实名制|劳资专管|承插型盘扣|钢板防护网|商品砼|预拌砂浆|见证取样|送样|项目经理|技术负责人|分包|转包|履约担保|质保金|缺陷责任期|施工组织方案|施工进度计划|专项施工方案|施工工艺|须达到|必须达到|不低于|不少于|不得超过|不得超出/u;
const PROGRAM_PROCEDURE_HINTS = /盖单位章|签字或盖章|年月日|投标总价|汇总表|计日工表|综合单价分析|单价小计|未计价材料费|开标时间|开标地点|递交截止|投标截止|解密|电子交易系统|保证金账户|开户银行|投标保证金|异议|投诉|技术热线|评标委员会由.{0,10}人|评标委员会组成|资格审查|四库一平台|保函|担保机构|受益人|开立人|签字盖章|密封|正本.{0,4}副本|联合体|清标/u;
const MANDATORY_CLAUSE_LEXICAL_HINTS = /确保|争创|创优|获得.{0,10}[杯奖]|优质工程奖|绿色建筑|星级|智慧工地|装配率|装配式|六个百分百|四节一环保/u;

function loadTenderEvidence(): DocumentEvidence[] {
  const db = new BetterSqlite3(DB_PATH, { readonly: true });
  const rows = db
    .prepare(
      `SELECT relative_path, section_title, content FROM kb_chunks
       WHERE relative_path LIKE '%招标%' OR relative_path LIKE '%补疑%' OR relative_path LIKE '%答疑%' OR relative_path LIKE '%澄清%'
       ORDER BY relative_path, chunk_index`,
    )
    .all() as Array<{ relative_path: string; section_title: string | null; content: string }>;
  db.close();
  return rows.map(row => ({
    chapterId: 'tender-requirements',
    filePath: row.relative_path,
    score: 1,
    content: row.content || '',
    sectionTitle: row.section_title || undefined,
    source: 'pinned-evidence',
  }));
}

/** 与真实预筛三条件等价的确定性复现（语义召回影响极小：真实结果 154→153 已由词形+兜底决定） */
function preselectLexical(evidence: DocumentEvidence[]): DocumentEvidence[] {
  return evidence.filter(item => {
    const text = `${item.sectionTitle || ''}\n${item.content || ''}`;
    if (OBLIGATION_LEXICAL_HINTS.test(text)) return true;
    if (PROGRAM_PROCEDURE_HINTS.test(text)) return false;
    return true;
  });
}

function mandatoryStatus(label: string, model: Awaited<ReturnType<typeof extractTenderRequirements>>) {
  console.log(`--- ${label} ---`);
  console.log('  awardObjectives:', model.awardObjectives.length, model.awardObjectives.map(i => i.text.slice(0, 50)).join(' | ') || '(空)');
  console.log('  awardClauses:', model.awardClauses.length, model.awardClauses.map(i => i.text.slice(0, 50)).join(' | ') || '(空)');
  console.log('  greenBuildingGrade:', model.greenBuildingGrade ? model.greenBuildingGrade.text.slice(0, 60) : '(空)');
  console.log('  smartSiteGrade:', model.smartSiteGrade ? model.smartSiteGrade.text.slice(0, 60) : '(空)');
  console.log('  assemblyRate:', model.assemblyRate ? model.assemblyRate.text.slice(0, 60) : '(空)');
  console.log('  systematicBenchmarks:', model.systematicBenchmarks.length, model.systematicBenchmarks.map(i => i.text.slice(0, 50)).join(' | ') || '(空)');
  console.log('  specialQualityStandards:', model.specialQualityStandards.length, model.specialQualityStandards.map(i => i.text.slice(0, 50)).join(' | ') || '(空)');
  console.log('  frontScheduleClauses:', model.frontScheduleClauses.length, model.frontScheduleClauses.map(i => i.text.slice(0, 50)).join(' | ') || '(空)');
  console.log('  dateFabricationProhibited:', model.dateFabricationProhibited);
  console.log('  prohibitionNotes:', model.prohibitionNotes.length, model.prohibitionNotes.map(i => i.text.slice(0, 50)).join(' | ') || '(空)');
  console.log('  missingMandatoryFields =', missingMandatoryFields(model));
  console.log('  requirementFieldGaps =', requirementFieldGaps(model).join('、') || '(无)');
}

describe('合肥师范评分项要求提取漏提根因复现（词形确定性复现 + 真实 LLM）', () => {
  it('预筛→主提取→窄通道→合并 全链路', { timeout: 900000 }, async () => {
    const all = loadTenderEvidence();
    console.log(`[0] 招标直读切片 ${all.length} 条，${all.reduce((s, i) => s + i.content.length, 0)} 字符`);

    const preselect = preselectLexical(all);
    console.log(`[1] 预筛后 ${preselect.length} 条，${preselect.reduce((s, i) => s + i.content.length, 0)} 字符`);
    for (const d of all.filter(i => !preselect.includes(i))) {
      console.log(`    剔除: ${d.filePath.split('/').pop()} | ${(d.sectionTitle || '').slice(0, 30)} | ${d.content.slice(0, 60).replace(/\n/g, ' ')}`);
    }

    const main = await extractTenderRequirements(preselect);
    mandatoryStatus('[2] 主提取（153 条全量分片）', main);

    const narrowEvidence = all.filter(item => MANDATORY_CLAUSE_LEXICAL_HINTS.test(`${item.sectionTitle || ''}\n${item.content || ''}`));
    console.log(`[3] 窄通道词形召回 ${narrowEvidence.length} 条（真实召回 = 词形 ∪ bge 语义命中，此为子集）`);
    const joined = narrowEvidence.map(i => `${i.sectionTitle || ''}\n${i.content}`).join('');
    console.log(`    含「黄山杯」=${/黄山杯/u.test(joined)} 「装配率」=${/装配率|装配式/u.test(joined)} 「智慧工地」=${/智慧工地/u.test(joined)} 「绿色建筑」=${/绿色建筑/u.test(joined)} 「星级」=${/星级/u.test(joined)}`);
    const hsc = narrowEvidence.find(i => /黄山杯/u.test(`${i.sectionTitle || ''}\n${i.content}`));
    if (hsc) console.log(`    黄山杯切片示例: ${hsc.content.replace(/\n/g, ' ').slice(0, 220)}`);

    const narrow = await extractTenderRequirements(narrowEvidence);
    mandatoryStatus('[4] 窄通道提取（词形召回子集）', narrow);

    const merged = mergeTenderRequirements(main, narrow);
    mandatoryStatus('[5] 合并后（主优先）', merged);

    // round-26 字段级定向补提闭环：真实修复链路的第三层（句级窗口聚焦提取，最多 2 轮，
    // 覆盖全部评分项要求字段——必提 6 + 常规 4；评标办法/篇幅要求不提取）
    const gapsBefore = requirementFieldGaps(merged);
    console.log(`[6] 字段级缺口（补提前，全字段）: ${gapsBefore.join('、') || '(无)'}`);
    if (gapsBefore.length > 0) {
      const gapResult = await extractRequirementFieldGaps(merged, all, {});
      mandatoryStatus('[7] 定向补提后（窗口聚焦，最多 2 轮）', gapResult.model);
      console.log(`    stillGaps = [${gapResult.stillGaps.join('、')}]  noEvidenceGaps = [${gapResult.noEvidenceGaps.join('、')}]`);
      expect(gapResult.stillGaps.length).toBe(0);
    }
    expect(true).toBe(true);
  });
});
