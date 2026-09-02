import type { DocumentGenerationDiagnostics } from './types';
import type { CanonicalFactModel } from './types';
import { callDocumentLlmJson, type DocumentJsonSchema } from './llmClient';
import { docSystemPrefix } from './markdownComposer';

/**
 * 计划数据槽位主表（方案 B）：劳动力峰值/分阶段人数/机械台班/材料批次/检验批划分/进度节点等
 * "计划编制类字段"是资料中不存在、由各章 LLM 独立推导的数值——各章各自推导是"每版必现数据一致性
 * 矛盾"的源头（L3.5 事后审查采样 200 句 + 最多 6 条矛盾，追不上全文任意位置的自由推导空间）。
 * 根治：章节写作前一次 LLM 调用生成全文唯一计划数据主表 → 注入 L1 任务级恒定段（全项目共享一次，
 * 同时成为 prefix cache 可命中前缀）→ 写作规则改为"计划类数值只能引用主表槽位，禁止自推"→
 * 生成后确定性对齐（强锚定槽位数值按主表回填）。
 * env DOCUMENT_PLAN_DATA_MASTER=0 整体回退（生成失败也自动回退原"各章自推"路径，不阻断生成）。
 */

/** 计划数据主表（LLM 结构化输出） */
export interface PlanDataMaster {
  /** 劳动力峰值（高峰期总人数，全文唯一口径） */
  laborPeak: { count: number; phase: string };
  /** 分阶段劳动力（各阶段人数不同属正常配置，只注入不做数值对齐） */
  laborByPhase: Array<{ phase: string; count: number }>;
  /** 主要机械（名称 + 规格 + 数量；数量为强锚定槽位，正文出现不同台数按主表回填） */
  machines: Array<{ name: string; spec: string; count: number }>;
  /** 材料进场批次（批次描述，注入不做数值对齐） */
  materialBatches: Array<{ name: string; batchDesc: string }>;
  /** 检验批划分（范围 + 划分方案描述） */
  inspectionBatches: Array<{ scope: string; planDesc: string }>;
  /** 进度节点（节点名 + 相对工期表达，如"开工令下发后第 7 日"） */
  scheduleNodes: Array<{ node: string; offset: string }>;
}

const PLAN_DATA_JSON_SCHEMA: DocumentJsonSchema = {
  type: 'object',
  // 仅劳动力峰值为硬门槛（buildPlanDataMaster L157 同口径）；其余数组/子字段缺失由归一化兜底为
  // 空数组/默认值——历史缺陷：全部必填 → 模型漏 1 个数组即整次调用失败（6 次校验失败回退），
  // 且缺失字段类失败不触发 maxTokens 放大（llmClient 已补），宽松 schema 与提示词显式键名双保险
  required: ['laborPeak'],
  properties: {
    laborPeak: {
      type: 'object',
      required: true,
      properties: {
        count: { type: 'number', required: true },
        phase: { type: 'string' },
      },
    },
    laborByPhase: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          phase: { type: 'string' },
          count: { type: 'number' },
        },
      },
    },
    machines: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          spec: { type: 'string' },
          count: { type: 'number' },
        },
      },
    },
    materialBatches: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          batchDesc: { type: 'string' },
        },
      },
    },
    inspectionBatches: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          scope: { type: 'string' },
          planDesc: { type: 'string' },
        },
      },
    },
    scheduleNodes: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        properties: {
          node: { type: 'string' },
          offset: { type: 'string' },
        },
      },
    },
  },
};

/** 主表生成输入：项目基本事实 + 章节目录（供按章推导分阶段配置） */
export interface PlanDataMasterInput {
  /** 项目基本事实（建设规模/总工期/质量标准等，来自 factsModel） */
  basicFacts: string;
  /** 章节标题列表（让分阶段配置与章节目录口径一致） */
  chapterTitles: string[];
  signal?: AbortSignal;
  diagnostics?: DocumentGenerationDiagnostics;
  /** 失败原因回传（调用方写入进度诊断，便于真实生成中定位主表回退原因） */
  lastFailure?: string;
}

/** 一次 LLM 调用生成计划数据主表；失败返回 undefined（调用方回退原路径，不阻断生成） */
export async function buildPlanDataMaster(input: PlanDataMasterInput): Promise<PlanDataMaster | undefined> {
  if (process.env.DOCUMENT_PLAN_DATA_MASTER === '0') return undefined;
  if (!input.basicFacts.trim() && input.chapterTitles.length === 0) return undefined;
  const outFailure: { value?: string } = {};
  const raw = await callDocumentLlmJson<Partial<PlanDataMaster>>(
    docSystemPrefix('你是施工组织设计计划数据规划器。'),
    [
      '基于项目基本事实与章节目录，推导全项目统一的计划编制类数据（这些数据资料中没有，必须由你基于工程量、总工期、工序流水与定额工效推导，且全文唯一口径）：',
      '- 劳动力峰值：高峰期总人数（人），并标注所处阶段；',
      '- 分阶段劳动力：按施工阶段给出各阶段人数（各阶段人数不同是正常配置）；',
      '- 主要机械：名称、规格、台数（塔吊/汽车吊/挖掘机/混凝土泵等，按工程量与工期配足）；',
      '- 材料进场批次：主要材料（钢材/混凝土/砌体/装饰材料等）的分批进场安排；',
      '- 检验批划分：按楼层/施工段/系统划分检验批的规则（面积阈值、划分边界）；',
      '- 进度节点：关键节点名称与相对工期（一律用"开工令下发后第 N 日"形式，不得编造绝对日期）；',
      '推导要求：数值必须与总工期、建设规模自洽；劳动力峰值 ≥ 各阶段人数；机械台班与劳动力峰值配套；同一定额口径全文统一。',
      // 输出键名必须逐字一致（schema 只做校验不注入提示词，历史缺陷：模型自造键名 → 6 次校验失败回退）：
      '输出 JSON 的键名必须逐字如下（不得改名、不得遗漏，数组元素为对象）：',
      '{ "laborPeak": { "count": 0, "phase": "" }, "laborByPhase": [ { "phase": "", "count": 0 } ], "machines": [ { "name": "", "spec": "", "count": 0 } ], "materialBatches": [ { "name": "", "batchDesc": "" } ], "inspectionBatches": [ { "scope": "", "planDesc": "" } ], "scheduleNodes": [ { "node": "", "offset": "" } ] }',
      '只输出 JSON，不得输出其他内容。',
      '',
      `项目基本事实：\n${input.basicFacts.trim() || '（无）'}`,
      `章节目录：\n${input.chapterTitles.map(title => `- ${title}`).join('\n')}`,
    ].join('\n'),
    {
      maxTokens: 6000,
      temperature: 0,
      signal: input.signal,
      diagnostics: input.diagnostics,
      schema: PLAN_DATA_JSON_SCHEMA,
      taskKind: 'structuredGeneration',
      prefixKey: 'plan-data-master',
      outFailure,
    },
  );
  if (!raw?.laborPeak || !Number.isFinite(asNumber(raw.laborPeak.count)) || asNumber(raw.laborPeak.count) <= 0) {
    input.lastFailure = outFailure.value || (raw ? `主表缺劳动力峰值口径（laborPeak=${JSON.stringify(raw.laborPeak).slice(0, 80)}）` : 'LLM 调用未返回有效 JSON');
    return undefined;
  }
  return {
    laborPeak: { count: Math.floor(asNumber(raw.laborPeak.count)), phase: String(raw.laborPeak.phase || '主体施工阶段') },
    laborByPhase: (raw.laborByPhase || []).filter(item => item && Number.isFinite(asNumber(item.count)) && asNumber(item.count) > 0).map(item => ({ phase: String(item.phase).trim(), count: Math.floor(asNumber(item.count)) })),
    machines: (raw.machines || []).filter(item => item && item.name && Number.isFinite(asNumber(item.count)) && asNumber(item.count) > 0).map(item => ({ name: String(item.name).trim(), spec: String(item.spec || '').trim(), count: Math.floor(asNumber(item.count)) })),
    materialBatches: (raw.materialBatches || []).filter(item => item && item.name).map(item => ({ name: String(item.name).trim(), batchDesc: String(item.batchDesc || '').trim() })),
    inspectionBatches: (raw.inspectionBatches || []).filter(item => item && item.scope).map(item => ({ scope: String(item.scope).trim(), planDesc: String(item.planDesc || '').trim() })),
    scheduleNodes: (raw.scheduleNodes || []).filter(item => item && item.node).map(item => ({ node: String(item.node).trim(), offset: String(item.offset || '').trim() })),
  };
}

/** 数字归一化：LLM 输出数字字符串（"320"）与 number 混合形态时统一转 number，非数值返回 NaN */
function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed !== '') return Number(trimmed);
  }
  return Number.NaN;
}

/** 渲染 canonical 基本事实为紧凑文本（主表生成输入：建设规模/总工期/质量标准等口径来源） */
export function renderBasicFactsForMaster(canonical: CanonicalFactModel): string {
  const entries = Object.values(canonical.byKey || {})
    .filter(fact => Boolean(fact && fact.label && fact.value))
    .sort((left, right) => (right.priority || 0) - (left.priority || 0));
  if (entries.length === 0) return '';
  return entries.slice(0, 60).map(fact => `- ${fact.label}：${fact.value}`).join('\n');
}

/** 渲染主表为注入 L1 的文本（全项目共享一次 → prefix cache 可命中前缀组成部分） */
export function renderPlanDataMaster(master: PlanDataMaster): string {
  const lines: string[] = ['【计划数据主表——全项目计划类数值唯一数据源，正文引用必须与此表完全一致，不得自行推导不同数值；主表未覆盖的计划数据可按主表口径推导，全文档统一】'];
  lines.push(`- 劳动力峰值：高峰期总人数 ${master.laborPeak.count} 人（${master.laborPeak.phase}）`);
  if (master.laborByPhase.length) {
    lines.push(`- 分阶段劳动力：${master.laborByPhase.map(item => `${item.phase} ${item.count} 人`).join('、')}`);
  }
  if (master.machines.length) {
    lines.push(`- 主要机械：${master.machines.map(item => `${item.name}${item.spec ? `（${item.spec}）` : ''} ${item.count} 台`).join('、')}`);
  }
  if (master.materialBatches.length) {
    lines.push(`- 材料进场批次：${master.materialBatches.map(item => `${item.name}——${item.batchDesc}`).join('；')}`);
  }
  if (master.inspectionBatches.length) {
    lines.push(`- 检验批划分：${master.inspectionBatches.map(item => `${item.scope}：${item.planDesc}`).join('；')}`);
  }
  if (master.scheduleNodes.length) {
    lines.push(`- 进度节点：${master.scheduleNodes.map(item => `${item.node}（${item.offset}）`).join('、')}`);
  }
  return lines.join('\n');
}

/** 转义正则特殊字符（机械名/锚定词可能含括号等） */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * B3 确定性对齐：正文中强锚定槽位的数值与主表不一致时按主表回填（只替换数字本身，不动句式）。
 * 强锚定槽位（同一值多处出现必须一致的语义）：
 * ① 劳动力峰值——锚定词「高峰(期)(总)人数/劳动力峰值/高峰投入/高峰用工」附近的人数；
 * ② 机械台数——锚定词「<机器名>」附近 20 字符内的「N 台」；
 * 分阶段人数/材料批次/检验批/进度节点不做数值对齐（各阶段/各批次数值不同属正常配置，矛盾风险低，
 * 由 L3.5 数据一致性审查兜底）。只处理正文行与表格行，跳过标题行；数字为 0 或行含「不超过/以内」
 * 的约束句式只对齐行内第一个数字。
 */
export function alignPlanDataToMaster(markdown: string, master: PlanDataMaster): { markdown: string; fixed: Array<{ anchor: string; from: string; to: string }> } {
  const fixed: Array<{ anchor: string; from: string; to: string }> = [];
  let result = markdown;
  // ① 劳动力峰值对齐：锚定词 + 人数模式
  const peakAnchors = [/高峰(?:期)?(?:总)?(?:人数|劳动力|用工|投入)(?:为|约|控制在|不超过|达)?\s*(\d+)\s*人/u, /劳动力(?:峰值|高峰)(?:为|约|控制在|不超过|达)?\s*(\d+)\s*人/u, /高峰(?:投入|用工)(?:为|约|控制在|不超过|达)?\s*(\d+)\s*人/u];
  for (const anchor of peakAnchors) {
    result = result.replace(anchor, (line, rawCount: string) => {
      const count = Number(rawCount);
      if (count === master.laborPeak.count || count <= 0) return line;
      fixed.push({ anchor: '劳动力峰值', from: `${count}人`, to: `${master.laborPeak.count}人` });
      return line.replace(rawCount, String(master.laborPeak.count));
    });
  }
  // ② 机械台数对齐：机器名后 20 字符内的「N 台」
  for (const machine of master.machines) {
    const name = machine.name.trim();
    if (name.length < 2) continue;
    const machineRe = new RegExp(`${escapeRegex(name)}[^\\n。；;]{0,20}?(\\d+)\\s*台`, 'gu');
    result = result.replace(machineRe, (line, rawCount: string) => {
      const count = Number(rawCount);
      if (count === machine.count || count <= 0) return line;
      fixed.push({ anchor: machine.name, from: `${count}台`, to: `${machine.count}台` });
      return line.replace(rawCount, String(machine.count));
    });
  }
  return { markdown: result, fixed };
}
