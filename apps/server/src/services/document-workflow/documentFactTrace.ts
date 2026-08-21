import type { BoqRowTrace, DocumentFact, DocumentFactTrace, DocumentFactsModel, ValidationIssue } from './types';
import { stringifyFactValue } from './utils';

function normalize(value: string) {
  return value.replace(/[\s,，.。:：;；|｜（）()《》<>【】"“”'‘’]/gu, '').toLowerCase();
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
  const numericParts = value.match(/\d+(?:\.\d+)?\s*(?:日历天|天|个月|月|年|万元|元|平方米|㎡|m²|立方米|m³|米|m|mm|cm|台|套|人|项|%|MPa|kPa)?/giu) || [];
  return numericParts.some(part => normalize(part).length >= 2 && normalizedMarkdown.includes(normalize(part)));
}

function isActionableTraceFact(trace: DocumentFactTrace) {
  const value = String(trace.value || '').trim();
  const labelValue = `${trace.label}${value}`;
  if (!/项目|工程|编号|地点|规模|范围|工期|质量|安全|资源|材料|设备|验收|\d/u.test(labelValue)) return false;
  if (/^(?:见|详见|按|执行|参见|依据).{0,16}(?:前附表|招标公告|招标文件|合同|协议书|通用条款|专用条款|图纸|清单|附件|资料)$/u.test(value)) return false;
  if (/^(?:合同协议书|通用条款|专用条款|招标文件|招标公告|投标人须知前附表|附件|资料)$/u.test(value.replace(/[（）()\d一二三四五六七八九十、.．\s]/gu, ''))) return false;
  if (value.length < 4 && !/\d/u.test(value)) return false;
  return true;
}

export function buildDocumentFactTraces(markdown: string, factsModel: DocumentFactsModel): DocumentFactTrace[] {
  const seen = new Set<string>();
  const traces: DocumentFactTrace[] = [];
  for (const fact of trustedFacts(factsModel)) {
    const value = stringifyFactValue(fact.value).replace(/\s+/gu, ' ').trim();
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
