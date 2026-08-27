// 一次性修复：constructionOrgDivisionSectionIssues 增强
// 1) 兼容粗体伪标题一段式分块（无 #### 小节时按“行首 **分项名**”切块）
// 2) 每分项正文深度下限（minPackageChars，blocker）
// 3) 分项深度均衡检测（balanceRatio，warning）
// 用 node 脚本而非 SearchReplace：新增代码含 \*\* 等反斜杠转义，避免工具破坏正则
const fs = require('fs');
const file = '/Users/pan/Desktop/codeing/customize-agent/apps/server/src/services/document-workflow/constructionOrgQualityRules.ts';
const src = fs.readFileSync(file, 'utf8');

const oldBlock = `  const validateContent = (label: string, content: string) => {
    // 分项工程方案 = #### 小节（与 majorContent 工作包口径一致）
    const packageBlocks = content.split(/^####\\s+/gmu).slice(1).map(block => block.trim()).filter(Boolean);
    const packageCount = packageBlocks.length;`;

const newBlock = `  const validateContent = (label: string, content: string) => {
    // 分项工程方案 = #### 小节（与 majorContent 工作包口径一致）；
    // 兼容粗体伪标题一段式：无 #### 小节时按“行首 **分项名**”切块（真实生成缺陷：LLM 用粗体行替代小节标题，
    // 历史验收器按 #### 切出 0 块只能报“分项不足”，无法定位各分项缺什么，粗体形态由此穿透门禁交付）
    let packageBlocks = content.split(/^####\\s+/gmu).slice(1).map(block => block.trim()).filter(Boolean);
    if (packageBlocks.length === 0) {
      packageBlocks = [...content.matchAll(/^\\*\\*[^*]+\\*\\*[\\s\\S]*?(?=^\\*\\*[^*]+\\*\\*|\\s*$)/gmu)].map(match => match[0].trim()).filter(Boolean);
    }
    const packageCount = packageBlocks.length;`;

const oldTail = `    if (weakParamPackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: \`\${label} 分部分项工程施工方案存在 \${weakParamPackages.length} 个分项方案工艺参数不足（少于 \${DIVISION_SECTION_QUALITY.minParamsPerPackage} 个）\`, suggestion: '每个分项方案必须落位至少 4 个具体工艺参数（mm、MPa、间距、偏差、坡度、养护天数、试验压力、搭接长度等），参数来自绑定材料或行业通用规范值，不得编造。' });
  };`;

const newTail = `    if (weakParamPackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: \`\${label} 分部分项工程施工方案存在 \${weakParamPackages.length} 个分项方案工艺参数不足（少于 \${DIVISION_SECTION_QUALITY.minParamsPerPackage} 个）\`, suggestion: '每个分项方案必须落位至少 4 个具体工艺参数（mm、MPa、间距、偏差、坡度、养护天数、试验压力、搭接长度等），参数来自绑定材料或行业通用规范值，不得编造。' });
    // 分项深度下限：门窗维修、立面修补等小分项常被一句话带过（真实生成缺陷：12 个分项中 2~3 个仅 40~80 字），
    // 每分项必须写足三段式正文，过短按结构缺陷进入修复循环补写
    const shallowPackages = packageBlocks.filter(block => block.replace(/\\s/gu, '').length < DIVISION_SECTION_QUALITY.minPackageChars);
    if (shallowPackages.length > 0) issues.push({ level: 'error', severity: 'blocker', message: \`\${label} 分部分项工程施工方案存在 \${shallowPackages.length} 个分项方案正文过短（少于 \${DIVISION_SECTION_QUALITY.minPackageChars} 字）\`, suggestion: '每个分项方案都要写足“施工概况+工艺流程+施工方法”三段式，门窗维修、立面修补等小分项同样需要逐段展开，不得一句话带过。' });
    // 分项深度均衡：最短分项不足最长分项 balanceRatio 时给扩充建议（warning 不阻断，由质量报告引导后续优化）
    const packageLengths = packageBlocks.map(block => block.replace(/\\s/gu, '').length);
    const imbalanced = packageLengths.length > 1 && Math.min(...packageLengths) > 0 && Math.min(...packageLengths) < Math.max(...packageLengths) * DIVISION_SECTION_QUALITY.balanceRatio;
    if (imbalanced) issues.push({ level: 'warning', message: \`\${label} 分部分项工程施工方案分项深度失衡：最短分项不足最长分项三分之一\`, suggestion: '参照最长分项（如拆除、结构加固）的展开深度，为偏短分项补足机具、材料规格、工艺参数与验收标准。' });
  };`;

let count = 0;
let out = src;
for (const [oldText, newText] of [[oldBlock, newBlock], [oldTail, newTail]]) {
  const hits = out.split(oldText).length - 1;
  if (hits !== 1) { console.error(`期望 1 处命中，实际 ${hits} 处：${oldText.slice(0, 60)}...`); process.exit(1); }
  out = out.replace(oldText, newText);
  count += 1;
}
// 校验：原正则转义形态完好
for (const probe of ['split(/^####\\s+/gmu)', 'match(/施工方法[:：]([\\s\\S]*?)(?=\\n施工|$)/u)', 'matchAll(/^\\*\\*[^*]+\\*\\*[\\s\\S]*?(?=^\\*\\*[^*]+\\*\\*|\\s*$)/gmu)']) {
  if (!out.includes(probe)) { console.error(`转义校验失败，缺失：${probe}`); process.exit(1); }
}
fs.writeFileSync(file, out);
console.log(`完成：${count} 处替换，转义校验通过`);
