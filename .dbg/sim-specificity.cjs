// 模拟 specificityScore：量化脏事实过滤（竖线残留）对方案针对性评分的影响
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('/tmp/round4-doc.json', 'utf8'));
const doc = d.document || d;
const md = doc.markdown || '';
const chapters = doc.checkpointChapters || [];
const traces = (doc.reviewMetadata || {}).factTraces || [];

function isActionableFactValue(value) {
  if (/^(?:见|详见|按|执行|参见|依据).{0,16}(?:前附表|招标公告|招标文件|合同|协议书|通用条款|专用条款|图纸|清单|附件|资料)$/u.test(value)) return false;
  if (/(?:^|[:：]\s*)(?:见|详见|按|执行|参见|依据)[^。；;]{0,18}(?:前附表|招标公告|招标文件|合同|协议书|通用条款|专用条款|图纸|清单|附件|资料|补疑|答疑)[^。；;]{0,6}$/u.test(value)) return false;
  if (/^见.{0,24}(?:招标范围|招标补疑|补疑|前附表|答疑)/u.test(value)) return false;
  if (/^(?:合同协议书|通用条款|专用条款|招标文件|招标公告|投标人须知前附表|附件|资料)$/u.test(value.replace(/[（）()\d一二三四五六七八九十、.．\s]/gu, ''))) return false;
  if (/^(?:工程名称|项目名称|建设地点|建设规模|计划工期|质量标准|招标范围|合同估算价|工程概况|项目概况|项目内容)$/u.test(value)) return false;
  if (/^#+\s*/u.test(value)) return false;
  if (/^[一二三四五六七八九十]+[、.．]\s*\S{2,}[：:]/u.test(value)) return false;
  if (/^[（(]\s*\d+[)）]/u.test(value) && /具备|证书|考核|资格|人员/u.test(value)) return false;
  if (value.length < 4 && !/\d/u.test(value)) return false;
  return true;
}
function isActionableTraceFact(trace, extraPipeFilter) {
  const value = String(trace.value || '').trim();
  const labelValue = `${trace.label}${value}`;
  if (!/项目|工程|编号|地点|规模|范围|工期|质量|安全|资源|材料|设备|验收|\d/u.test(labelValue)) return false;
  if (!isActionableFactValue(value)) return false;
  if (/^(?:技术参数|精确参数)$/u.test(trace.label)) return false;
  if (extraPipeFilter && /\|/u.test(value)) return false;
  return true;
}
function specificity(extraPipeFilter) {
  const scoredTraces = traces.filter(t => isActionableTraceFact(t, extraPipeFilter));
  const usedTraces = scoredTraces.filter(t => t.status === 'used');
  const usedRate = scoredTraces.length ? usedTraces.length / scoredTraces.length : 1;
  const usedValues = usedTraces.map(t => String(t.value || '').replace(/\s+/gu, ' ').trim()).filter(v => v.length >= 4 && v.length <= 60);
  const normalizedBodies = chapters.map(c => (c.content || '').replace(/\s+/gu, ' '));
  const distributedCount = usedValues.filter(v => normalizedBodies.filter(b => b.includes(v)).length >= 2).length;
  const distribution = usedValues.length ? distributedCount / usedValues.length : 1;
  return {
    scored: scoredTraces.length,
    used: usedTraces.length,
    usedRate: Math.round(usedRate * 100),
    usedValues: usedValues.length,
    distributedCount,
    distribution: Math.round(distribution * 100),
    score: Math.round((usedRate * 0.55 + distribution * 0.45) * 100),
  };
}
console.log('== 当前口径 ==', JSON.stringify(specificity(false)));
console.log('== 加竖线残留过滤 ==', JSON.stringify(specificity(true)));
console.log('--- 被竖线过滤的 trace 示例 ---');
traces.filter(t => /\|/u.test(String(t.value || ''))).slice(0, 8).forEach(t => console.log('  ', t.label, '=', JSON.stringify(t.value).slice(0, 50), t.status));
