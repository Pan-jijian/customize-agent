import type { BoqRowTrace, DocumentFact, DocumentFactTrace, DocumentFactsModel, ValidationIssue } from './types';
import { stringifyFactValue } from './utils';

function normalize(value: string) {
  return value.replace(/[\s,，.。:：;；|｜（）()《》<>【】"“”'‘’]/gu, '').toLowerCase();
}

/** 事实值清洗：去除表格行尾巴（| | | |）、条款尾巴（“4．未尽事宜详见……”）、残留分隔标点等抽取噪音 */
export function cleanFactValue(value: string) {
  let cleaned = value
    // 表格行尾巴：`室外道排工程 | | | | |` → `室外道排工程`
    .replace(/[|｜]\s*(?:[|｜]\s*)+$/gu, '')
    // 条款尾巴：`胶圈接口 4．未尽事宜详见施工图纸、补遗…` → `胶圈接口`
    .replace(/(?:[。；;]|\d+\s*[．.、])\s*(?:未尽事宜|其余(?:未尽)?事宜|其他(?:未尽)?事宜|注\s*[：:]).*$/u, '')
    .trim();
  // 残留分隔标点：`本项目维修改造包含室内装饰工程、门窗维修、屋面维修、` → 去掉尾部顿号
  cleaned = cleaned.replace(/[、，,;；]+\s*$/u, '').trim();
  // 表格行内残留的孤立管道（值中间混入 | 但非结尾时取首段）
  if (/[|｜]/u.test(cleaned)) cleaned = cleaned.split(/[|｜]/u)[0]?.trim() || cleaned;
  return cleaned;
}

function trustedFacts(factsModel: DocumentFactsModel): DocumentFact[] {
  return [
    ...factsModel.project,
    ...factsModel.schedule,
    ...factsModel.quality,
    ...factsModel.safety,
    ...factsModel.resources,
    ...factsModel.preciseFacts,
    ...factsModel.bills,
    ...factsModel.drawings,
    ...factsModel.rules,
    ...factsModel.specifications,
  ];
}

function appears(markdown: string, value: string) {
  const normalizedMarkdown = normalize(markdown);
  const normalizedValue = normalize(value);
  if (!normalizedValue || normalizedValue.length < 2) return true;
  if (normalizedMarkdown.includes(normalizedValue)) return true;
  // 全值匹配失败时按片段匹配：条款列表（“1、……；2、……”）或顿号列举中任一核心片段落位即视为已使用；
  // 仅当拆分出至少两个片段时才启用，避免长单句的部分子串误命中
  {
    const fragments = value
      .split(/[；;。\n]|、|，|,/u)
      .map(fragment => normalize(fragment.replace(/^\s*\d+\s*[、.．]\s*/u, '')))
      .filter(fragment => fragment.length >= 4);
    if (fragments.length >= 2 && fragments.some(fragment => normalizedMarkdown.includes(fragment))) return true;
  }
  // 核心词匹配：对象名类短值在正文以组成词出现时视为落位（如“室外道排工程”→“室外道排”、“外墙、屋面工程”→“外墙”+“屋面”）；
  // 单片段要求 ≥3 字符、多片段要求 ≥2 字符，避免二字通用词单点命中造成虚假落位
  {
    const coreFragments = value
      .replace(/[、，,;；|｜\s]+/gu, '、')
      .split('、')
      .map(fragment => normalize(fragment.replace(/(?:工程|项目|改造|维修|安装|施工|内容|资料|要求|标准)+$/u, '')))
      .filter(fragment => fragment.length >= 2);
    if (coreFragments.length >= 1 && (coreFragments.length >= 2 || (coreFragments[0]?.length ?? 0) >= 3) && coreFragments.every(fragment => normalizedMarkdown.includes(fragment))) return true;
  }
  const numericParts = value.match(/\d+(?:\.\d+)?\s*(?:日历天|天|个月|月|年|万元|元|平方米|㎡|m²|立方米|m³|米|m|mm|cm|台|套|人|项|%|MPa|kPa|个|栋|层|标段|批|处|座|组|道|根|樘|扇)?/giu) || [];
  return numericParts.some(part => normalize(part).length >= 2 && normalizedMarkdown.includes(normalize(part)));
}

/** 值级可执行性判断：指向值（见XXX）、标题行、标题+正文混合残留、纯文档引用名等不具备落位意义的事实值，与 isActionableTraceFact 共用同一口径 */
export function isActionableFactValue(value: string) {
  if (/^(?:见|详见|按|执行|参见|依据).{0,16}(?:前附表|招标公告|招标文件|合同|协议书|通用条款|专用条款|图纸|清单|附件|资料)$/u.test(value)) return false;
  // “质量标准：见招标公告”类标签+指向混合行（标签后紧跟指向短语，无实际数值）
  if (/(?:^|[:：]\s*)(?:见|详见|按|执行|参见|依据)[^。；;]{0,18}(?:前附表|招标公告|招标文件|合同|协议书|通用条款|专用条款|图纸|清单|附件|资料|补疑|答疑)[^。；;]{0,6}$/u.test(value)) return false;
  // “见XXX招标范围/补疑/答疑”类指向短语（如“见本项目招标补疑中的招标范围”）不具备落位意义
  if (/^见.{0,24}(?:招标范围|招标补疑|补疑|前附表|答疑)/u.test(value)) return false;
  if (/^(?:合同协议书|通用条款|专用条款|招标文件|招标公告|投标人须知前附表|附件|资料)$/u.test(value.replace(/[（）()\d一二三四五六七八九十、.．\s]/gu, ''))) return false;
  // 表格尾巴清洗后只剩标签名（如“工程名称 | | |” → “工程名称”）无实际值，不构成事实
  if (/^(?:工程名称|项目名称|建设地点|建设规模|计划工期|质量标准|招标范围|合同估算价|工程概况|项目概况|项目内容)$/u.test(value)) return false;
  // 竖线分隔符残留是表格行抽取噪音（如“| 金额(元) |”、“室外道排工程 | | | | |”），正文无法字面落位，
  // 不进入落位评分池，否则永久拉低方案针对性 usedRate（真实生成缺陷：项目名称=| 金额(元) | 被计入落位义务）
  if (/\|/u.test(value)) return false;
  // 值本身是标题行、编号引用或指向性短语的事实不具备可执行落位意义，不进入修复清单
  if (/^#+\s*/u.test(value)) return false;
  // 标题+正文混合残留（如“一、工程概况：本项目分为1个标段”）是抽取噪音而非单条事实
  if (/^[一二三四五六七八九十]+[、.．]\s*\S{2,}[：:]/u.test(value)) return false;
  if (/^[（(]\s*\d+[)）]/u.test(value) && /具备|证书|考核|资格|人员/u.test(value)) return false;
  if (value.length < 4 && !/\d/u.test(value)) return false;
  return true;
}

export function isActionableTraceFact(trace: DocumentFactTrace) {
  const value = String(trace.value || '').trim();
  const labelValue = `${trace.label}${value}`;
  if (!/项目|工程|编号|地点|规模|范围|工期|质量|安全|资源|材料|设备|验收|\d/u.test(labelValue)) return false;
  if (!isActionableFactValue(value)) return false;
  // “技术参数/精确参数”是正文可写参数池（清单编码、孤立尺寸等），用于提示词注入而非逐条落位义务，不参与落位评分
  if (/^(?:技术参数|精确参数)$/u.test(trace.label)) return false;
  return true;
}

export function buildDocumentFactTraces(markdown: string, factsModel: DocumentFactsModel): DocumentFactTrace[] {
  const seen = new Set<string>();
  const traces: DocumentFactTrace[] = [];
  for (const fact of trustedFacts(factsModel)) {
    const value = cleanFactValue(stringifyFactValue(fact.value).replace(/\s+/gu, ' ').trim());
    const label = fact.fieldName || fact.key || fact.fieldId || '资料事实';
    const key = `${label}:${value}`;
    if (!value || seen.has(key)) continue;
    seen.add(key);
    traces.push({
      label,
      value,
      sourceFile: fact.sourceFile,
      status: appears(markdown, value) ? 'used' : 'unplaced',
      confidence: fact.confidence,
    });
  }
  return traces;
}

export function factTraceIssues(traces: DocumentFactTrace[], options: { maxIssues?: number } = {}): ValidationIssue[] {
  const unplaced = traces.filter(trace => trace.status === 'unplaced' && isActionableTraceFact(trace));
  const limit = options.maxIssues && options.maxIssues > 0 ? options.maxIssues : unplaced.length;
  return unplaced
    .slice(0, limit)
    .map(trace => ({
      level: 'warning' as const,
      message: `已确认知识库事实未落位：${trace.label}=${trace.value}`,
      suggestion: `请将该事实落位到对应章节，并保持来源 ${trace.sourceFile || '结构化事实主表'} 的原始口径。${unplaced.length > limit ? `（共${unplaced.length}个未落位事实，此处显示前${limit}个）` : ''}`,
    }));
}

/** 构建 BOQ 行级落位追踪 */
export function buildBoqRowTraces(markdown: string, factsModel: DocumentFactsModel): BoqRowTrace[] {
  const tables = factsModel.tables || [];
  const traces: BoqRowTrace[] = [];
  const normalizedMarkdown = normalize(markdown);

  for (const table of tables) {
    const headers = table.headers.map(h => h.replace(/\s+/gu, '').toLowerCase());
    const nameCol = headers.findIndex(h => /项目名称|名称|清单项|分部分项|项目特征|工程内容|材料名称|设备名称/u.test(h));
    const codeCol = headers.findIndex(h => /编码|编号|序号|项目编码/u.test(h));
    const qtyCol = headers.findIndex(h => /数量|工程量/u.test(h));
    const unitCol = headers.findIndex(h => /单位/u.test(h));

    for (const row of table.rows) {
      const itemName = nameCol >= 0 ? (row[nameCol] || '') : '';
      const itemCode = codeCol >= 0 ? (row[codeCol] || '') : '';
      const quantity = qtyCol >= 0 ? (row[qtyCol] || '') : '';
      const unit = unitCol >= 0 ? (row[unitCol] || '') : '';

      if (!itemName && !itemCode) continue;

      const normalizedName = normalize(itemName);
      const normalizedCode = normalize(itemCode);
      const placed = (normalizedName.length >= 3 && normalizedMarkdown.includes(normalizedName.slice(0, 12)))
        || (normalizedCode.length >= 3 && normalizedMarkdown.includes(normalizedCode.slice(0, 8)));

      traces.push({
        itemCode: itemCode.slice(0, 50),
        itemName: itemName.slice(0, 200),
        quantity: quantity.slice(0, 50),
        unit: unit.slice(0, 20),
        sourceFile: table.sourceFile || '',
        placed,
      });
    }
  }

  // 按已在正文中标记已落位，按未落位排序到前面
  return traces.sort((a, b) => (a.placed === b.placed ? 0 : a.placed ? 1 : -1));
}

/** BOQ 行级落位问题（从 trace 生成） */
export function boqRowTraceIssues(traces: BoqRowTrace[], options: { maxIssues?: number } = {}): ValidationIssue[] {
  const unplaced = traces.filter(t => !t.placed);
  if (unplaced.length === 0) return [];
  const total = traces.length;
  const rate = (total - unplaced.length) / total;

  const issues: ValidationIssue[] = [];
  if (rate < 0.3) {
    issues.push({
      level: 'warning',
      message: `BOQ 清单行级落位严重不足：${total - unplaced.length}/${total} 行（${Math.round(rate * 100)}%）`,
      suggestion: `清单明细数量较大，建议优先补充主要分部分项、关键规格和大额工程量。未落位清单项示例：${unplaced.slice(0, 5).map(t => `${t.itemName} ${t.quantity}${t.unit}`).join('；')}`,
    });
  } else if (rate < 0.6) {
    issues.push({
      level: 'warning',
      message: `BOQ 清单行级落位不足：${total - unplaced.length}/${total} 行（${Math.round(rate * 100)}%）`,
      suggestion: `建议补充落位：${unplaced.slice(0, 5).map(t => t.itemName).join('、')}`,
    });
  }

  return issues;
}
