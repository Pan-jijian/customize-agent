/**
 * s1-slim 探针：单块输入 ≤4 万字符实测与超标定位（方案 2.3 验收项）。
 *
 * 实测口径（双数据源，均为真实数据）：
 * 1. 运行遥测：真实草稿 executionStages 中的 writer-block 调用输入明细
 *    （`writer-block:章 17次/186.6万字（L3 3.8万字）` → 平均每调用输入字符 = 判断单块输入是否超标）；
 * 2. 资产渲染：真实蓝图资产（assets/blueprint.json）经写作层真实渲染器
 *    renderBlueprintMustCiteValues 输出的字符量，以及 s1-slim 块级聚焦渲染 renderBlueprintDataTextForBlock /
 *    renderBlueprintBlockSlice 的块内最大值（逐块注入 prompt 的实际量）。
 *
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/slim-block-input.manual.ts
 * env：PROJECT_ROOT（默认本仓库根）；DOC_ID（指定遥测草稿，默认自动取最近含 writer-block 遥测的一篇）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBlueprintChapter, loadBlueprintAsset, renderBlueprintBlockSlice, renderBlueprintDataTextForBlock, renderBlueprintMustCiteValues } from '@/services/document-workflow/integratedBlueprint';
import type { IntegratedBlueprint } from '@/services/document-workflow/integratedBlueprint';
import { buildAuthorityIndex, renderAuthorityDomains } from '@/services/document-workflow/authorityIndex';
import type { AuthorityDomain } from '@/services/document-workflow/authorityIndex';
import { FORMAL_WRITING_RULES, SECTION_GENERATION_SAFETY_RULES, writerSystemPrefix } from '@/services/document-workflow/markdownComposer';
import { tuningProfile } from '@/services/document-workflow/tuningProfile';
import { generatedRoot } from '@/services/document-core/generatedDocumentService';

const PROJECT_ROOT = process.env.PROJECT_ROOT ?? '/Users/pan/Desktop/codeing/customize-agent';
const ACCEPT_LIMIT = 40000;

/** s1-slim 块级聚焦实测（改造后新口径）：生产块 ≈ 蓝图小节（subSection）+ 其工作包要点，
 * 块 tokens = 小节标题 + 全部工作包名；全章节遍历取块内最大值（参数桶按块筛选、切片只展开块相关工作包） */
function blockLevelMaxChars(blueprint: IntegratedBlueprint): { data: number; slice: number; blocks: number; top: Array<{ chapter: string; section: string; data: number; slice: number }> } {
  let data = 0;
  let slice = 0;
  let blocks = 0;
  const top: Array<{ chapter: string; section: string; data: number; slice: number }> = [];
  for (const chapter of blueprint.outline?.chapters ?? []) {
    const chapterSlice = findBlueprintChapter(blueprint, chapter.title);
    if (!chapterSlice) continue;
    for (const subSection of chapterSlice.subSections) {
      const workPackageNames = subSection.workPackages.map(workPackage => workPackage.name);
      const blockTokens = [subSection.title, ...workPackageNames].filter(Boolean);
      const dataChars = renderBlueprintDataTextForBlock(blueprint.data, { blockTokens }).length;
      const sliceChars = renderBlueprintBlockSlice(chapterSlice, blueprint.data, { blockTitle: subSection.title, subPointTitles: workPackageNames }).length;
      data = Math.max(data, dataChars);
      slice = Math.max(slice, sliceChars);
      blocks += 1;
      top.push({ chapter: chapter.title, section: subSection.title, data: dataChars, slice: sliceChars });
    }
  }
  return { data, slice, blocks, top };
}

/** 最近一篇含 writer-block 遥测的草稿（executionStages 持久化了调用输入分量） */
function latestTelemetryDraft(draftsDir: string): { id: string; text: string } | undefined {
  const files = fs.readdirSync(draftsDir)
    .filter(file => file.endsWith('.json') && !file.endsWith('.meta.json'))
    .map(file => ({ file, mtime: fs.statSync(path.join(draftsDir, file)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, 12);
  for (const { file } of files) {
    const text = fs.readFileSync(path.join(draftsDir, file), 'utf8');
    if (text.includes('writer-block')) return { id: file.replace(/\.json$/u, ''), text };
  }
  return undefined;
}

/** 提示词库主控提示词参考量（promptTexts 的主要来源；取最长一条 custom 提示词） */
function promptLibraryMaxChars(): number {
  try {
    const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.customize-agent', 'prompts.json'), 'utf8')) as { customPrompts?: Array<{ content?: string }> };
    return Math.max(0, ...(store.customPrompts ?? []).map(item => (item.content ?? '').length));
  } catch {
    return 0;
  }
}

describe('s1-slim 单块输入探针（实测与超标定位）', () => {
  it('1) 真实运行遥测：writer-block 每调用输入字符（超标判定面）', () => {
    const draftsDir = path.join(generatedRoot(PROJECT_ROOT), 'drafts');
    const target = process.env.DOC_ID
      ? { id: process.env.DOC_ID, text: fs.readFileSync(path.join(draftsDir, `${process.env.DOC_ID}.json`), 'utf8') }
      : latestTelemetryDraft(draftsDir);
    expect(target, '未找到含 writer-block 遥测的草稿（可用 DOC_ID 指定）').toBeDefined();
    console.log(`\n[遥测] 草稿：${target!.id}`);
    const draft = JSON.parse(target!.text) as {
      executionStages?: Array<{ message?: string; details?: string[] }>;
      draft?: { executionStages?: Array<{ message?: string; details?: string[] }> };
    };
    const stages = [...(draft.executionStages ?? []), ...(draft.draft?.executionStages ?? [])];
    for (const stage of stages) {
      const lines = [stage.message ?? '', ...(stage.details ?? [])];
      for (const line of lines) {
        if (/调用输入Top5|LLM 上下文输入|上下文分层|证据分层|writer-block.*次.*万字/u.test(line)) {
          console.log('   ', line.slice(0, 240));
        }
      }
    }
    // writer-block 每调用均值（超标定位：L3 封顶后剩余量即 L0+L1+L2 共享段）
    const re = /writer-block:([^：\s]+)：(\d+) 次，输入 ([\d.]+) 万字（L3 ([\d.]+) 万字）/gu;
    const perCall: Array<{ chapter: string; chars: number; l3: number }> = [];
    for (const stage of stages) {
      for (const line of stage.details ?? []) {
        for (const match of line.matchAll(re)) {
          const calls = Number(match[2]);
          const total = Number(match[3]) * 10000;
          const l3 = Number(match[4]) * 10000;
          perCall.push({ chapter: match[1], chars: calls > 0 ? Math.round(total / calls) : 0, l3: calls > 0 ? Math.round(l3 / calls) : 0 });
        }
      }
    }
    if (perCall.length > 0) {
      console.log('[遥测] writer-block 每调用输入（字符）：');
      for (const item of perCall.sort((left, right) => right.chars - left.chars)) {
        const share = item.chars > 0 ? Math.round((item.l3 / item.chars) * 100) : 0;
        console.log(`    ${item.chapter}: 每调用 ${item.chars} 字符（L3 ${item.l3}，L3 占比 ${share}%；${item.chars > ACCEPT_LIMIT ? '超 4 万验收线' : '达标'}）`);
      }
      const avg = Math.round(perCall.reduce((sum, item) => sum + item.chars, 0) / perCall.length);
      console.log(`[遥测] writer-block 每调用均值：${avg} 字符（验收线 ${ACCEPT_LIMIT}）`);
    }
  });

  it('2) 真实蓝图渲染段尺寸（逐块注入 prompt 的恒定量主体）', () => {
    const blueprint = loadBlueprintAsset(PROJECT_ROOT);
    expect(blueprint, '未找到蓝图资产（generatedRoot/assets/blueprint.json）').toBeDefined();
    console.log(`\n[蓝图] validation.passed=${Boolean(blueprint!.validation?.passed)}`);
    const rows = (blueprint!.outline?.chapters ?? []).map(chapter => {
      const slice = findBlueprintChapter(blueprint!, chapter.title);
      const mustCite = slice ? renderBlueprintMustCiteValues(slice, blueprint!.data) : '';
      return { title: chapter.title, mustCite: mustCite.length };
    }).sort((left, right) => right.mustCite - left.mustCite);
    console.log(`[蓝图] mustCite 清单（块质检反馈段）：${rows.length} 章`);
    for (const row of rows.slice(0, 12)) console.log(`    ${row.title}: mustCite=${row.mustCite}`);
    const maxMustCite = Math.max(0, ...rows.map(row => row.mustCite));
    console.log(`[蓝图] 最大 mustCite：${maxMustCite}`);
    // domain 分解：参数桶 36413 字符的主体定位（瘦身改造靶点）
    const index = buildAuthorityIndex(blueprint!.data);
    console.log('[蓝图] 参数桶 domain 分解：');
    const domains: AuthorityDomain[] = ['contract', 'schedule', 'labor', 'equipment', 'material', 'quantity', 'spec', 'earthwork', 'test', 'redline'];
    for (const domain of domains) {
      const rows = renderAuthorityDomains(index, [domain]);
      const chars = rows.join('\n').length;
      if (chars > 0) console.log(`    ${domain}: ${chars} 字符 / ${index.byDomain.get(domain)?.length ?? 0} 条目`);
    }
    // s1-slim 块级聚焦实测（改造后口径）：以蓝图小节为块代理，遍历全部章节取块内最大值
    const blockMax = blockLevelMaxChars(blueprint!);
    console.log(`[蓝图] 块级聚焦实测（${blockMax.blocks} 个块代理：参数桶域筛选 + 切片只展开块相关工作包）最大值：参数桶 ${blockMax.data}、切片 ${blockMax.slice}`);
    for (const stat of [...blockMax.top].sort((left, right) => (right.data + right.slice) - (left.data + left.slice)).slice(0, 5)) {
      console.log(`    ${stat.chapter} / ${stat.section}: 参数桶 ${stat.data}、切片 ${stat.slice}`);
    }
  });

  it('3) 固定指令段与封顶参数（L0/L1 常量 + 预算单源）', () => {
    const l0 = writerSystemPrefix();
    const profile = tuningProfile();
    console.log(`\n[固定段] L0 writerSystemPrefix：${l0.length} 字符`);
    console.log(`[固定段] SECTION_GENERATION_SAFETY_RULES：${SECTION_GENERATION_SAFETY_RULES.length} 字符`);
    console.log(`[预算] factCoverageCap=${profile.factCoverageCap ?? 6000}（默认 6000，0=关闭封顶）`);
    console.log(`[预算] chapterPoolChars=${profile.chapterPoolChars ?? 5000}（章级共享事实层封顶）`);
    console.log(`[预算] blockEvidenceChars=${profile.blockEvidenceChars ?? 1000}（块级证据封顶）`);
    console.log(`[预算] outlineEvidenceChars=${profile.outlineEvidenceChars ?? 2500}`);
    console.log(`[预算] blueprintBlockQuantityCap=${profile.blueprintBlockQuantityCap ?? 9000}（块级 quantity 域字符封顶）`);
    console.log(`[预算] blueprintBlockMaterialCap=${profile.blueprintBlockMaterialCap ?? 7000}（块级 material 域字符封顶）`);
    console.log(`[预算] blueprintBlockSliceCap=${profile.blueprintBlockSliceCap ?? 6000}（块级切片字符封顶）`);
    console.log(`[预算] plannedBlockConcurrency=${profile.plannedBlockConcurrency ?? '（未配置=块数）'}`);
    console.log(`[预算] DOCUMENT_TUNING_PROFILE=${process.env.DOCUMENT_TUNING_PROFILE ?? '(未设置)'}`);
  });

  it('4) 单块输入账目（达标判定：合计上界 vs 4 万验收线）', () => {
    const blueprint = loadBlueprintAsset(PROJECT_ROOT);
    const pass = Boolean(blueprint?.validation?.passed);
    const profile = tuningProfile();
    // s1-slim 改造后口径：参数桶/切片均为块级聚焦渲染（全章节遍历取块内最大，近似生产块 tokens）
    const blockMax = pass && blueprint ? blockLevelMaxChars(blueprint) : { data: 0, slice: 0, blocks: 0, top: [] };
    const segments: Array<{ name: string; chars: number; note: string }> = [
      { name: 'L0 system 恒定段', chars: writerSystemPrefix().length + SECTION_GENERATION_SAFETY_RULES.length, note: '固定' },
      { name: 'L1 promptTexts（主控提示词）', chars: promptLibraryMaxChars(), note: '提示词库参考量' },
      { name: 'L1 固定生成要求', chars: 1200, note: '约' },
      { name: 'L2 sharedFactLayerText', chars: Math.floor(profile.chapterPoolChars ?? 5000), note: '封顶值（默认 5000）' },
      { name: 'L2 factCoverageContext', chars: Math.floor(profile.factCoverageCap ?? 6000), note: '封顶值（默认 6000）' },
      { name: 'L2 compactProjectContext', chars: 0, note: '运行时构建，本次不可测' },
      { name: 'L2 chapterLevelContext/roleContext', chars: 0, note: '运行时构建，本次不可测' },
      { name: 'L3 块级参数桶（块筛后最大）', chars: blockMax.data, note: `实测渲染（${blockMax.blocks} 个块代理）` },
      { name: 'L3 块级切片（块筛后最大）', chars: blockMax.slice, note: '实测渲染' },
      { name: 'L3 块级 evidenceText', chars: Math.floor(profile.blockEvidenceChars ?? 1000), note: '封顶值' },
      { name: 'L3 块级指令+roleContext', chars: 3500, note: '约（含 factsHint）' },
    ];
    console.log('\n[账目] 单块输入分项（字符）：');
    let total = 0;
    for (const segment of segments) {
      total += segment.chars;
      console.log(`    ${segment.name}: ${segment.chars}（${segment.note}）`);
    }
    console.log(`[账目] 确定性分项合计：${total} 字符（未含 compactProjectContext/roleContext 运行时构建段）`);
    console.log(`[账目] 验收线：${ACCEPT_LIMIT}；确定性分项${total <= ACCEPT_LIMIT ? '已达标，仅剩运行时段待实测确认' : '已超线，超标段=' + segments.filter(segment => segment.chars > 8000).map(segment => segment.name).join('、')}`);
  });
});
