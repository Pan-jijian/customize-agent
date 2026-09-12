import { DEFAULT_DOCUMENT_DOMAIN_PROFILE, factFieldForLabel, isDiagnosticFactValue, isForbiddenFactValue, type DocumentDomainProfile } from '../document-core/documentDomainProfileService';
import type { DocumentFact, ValidationIssue } from '../document-workflow/types';
import type { ProjectMaterialSummary } from '../document-core/projectMaterialService';

// V5 P6 破折号族归一（run1 实测）：全角破折号（——）/半角连字符（--）/波浪线等字形不同
// 但语义相同，「…（一标）——公共广场空间改造等…」与「…（一标）--公共广场空间改造等…」
// 曾被归一为两个 key 误报「项目名称多值冲突」。
function normalize(value: string) {
  return value.replace(/[（(]\d+[）)]/gu, '').replace(/副本|最终版|扫描件|定稿/gu, '').replace(/\s+/gu, '').replace(/[，。,.;；：:《》“”‘’()（）_\-—–―─－〜～·•]/gu, '').toLowerCase();
}

function comparableValue(value: string, profile: DocumentDomainProfile, label?: string) {
  const trimmed = value.trim();
  if (isDiagnosticFactValue(profile, trimmed) || isForbiddenFactValue(profile, trimmed)) return '';
  if (/签章|盖章|联系人|联系电话|电话|邮箱|解密|开标|评标|保证金|交易系统|空白|填写|上传|下载|递交|投标文件制作|电子服务系统|交易平台/u.test(trimmed)) return '';
  if (/\|/u.test(trimmed) || /^#+\s*/u.test(trimmed)) return '';
  if (/见(?:招标公告|投标人须知|前附表|本项目|补疑)|资料参数行摘要|公共资源交易监督管理|开评标程序|监管部门|招标代理机构|监督管理部门|行政监督部门/u.test(trimmed)) return '';
  if (/是否|符合|采购范围|规定的投标截止时间|电子交易系统|投标人须知|招标文件正文/u.test(trimmed) && /\d{3,}/u.test(trimmed)) return '';
  if (/项目名称|工程名称/u.test(trimmed) && /项目编号|工程概况|建筑面积|本项目分为|现状建筑物|改造工程|标段/u.test(trimmed)) return '';
  if (/项目编号[:：]|工程概况[:：]|本项目分为|现状建筑物|总建筑面积|本次改造工程|清单编制说明/u.test(trimmed)) return '';
  // V5 P6 label 感知过滤（run1 实测）：
  // ① 机构类字段（招标人/建设单位/发包人）值必须含机构后缀——「在会议期间澄清」
  //   「承包人：为了进一步贯彻…」等句子片段抽取垃圾值曾被报为招标人多值冲突；
  // ② 项目名称类字段排除位置提示语（「项目所在地」）与清单条目名（「抱杆机箱」「检查井」类）。
  if (label && /招标人|建设单位|发包人|采购人|招标单位/u.test(label)) {
    if (!/局|公司|中心|政府|管委会|委员会|集团|院|大学|学校|街道|办事处|指挥部|项目部|办公室|厅|署|银行|医院/u.test(trimmed)) return '';
  }
  if (label && /项目名称|工程名称/u.test(label)) {
    if (/所在地|地址|详见|见前附表|见招标/u.test(trimmed)) return '';
    if (/检查井|化粪池|机箱|碎石|路灯|井盖|监控系统|吊顶|抹灰|楼面|顶棚/u.test(trimmed)) return '';
  }
  const duration = /\d+(?:\.\d+)?\s*(?:日历天|天|个月|月)/u.exec(trimmed)?.[0];
  // V5 P6 label 感知工期归一（run1 实测）：「计划工期=360日历天；2.9」的 value 本身不含
  // 「工期」二字，旧口径只看 value 导致整串归一，与「360日历天」被误报多值冲突——
  // 工期类 label 下总是优先提取 duration 片段参与比较。
  const normalized = normalize(duration && /工期|总工期|合同工期|计划工期|施工周期|质保期|有效期|养护期/u.test(`${label || ''} ${trimmed}`) ? duration : trimmed);
  if (!normalized || normalized.length > 80) return '';
  return normalized;
}

function shouldCheckStrictConflict(label: string, profile: DocumentDomainProfile) {
  const field = factFieldForLabel(profile, label);
  if (field) return field.cardinality === 'single' && field.conflictPolicy !== 'allow_multiple' && field.conflictPolicy !== 'ignore';
  return /项目名称|工程名称|招标人|建设地点|建筑面积|结构形式|层数|工期|质量标准|合同价格形式|绿色建筑等级|投标有效期|质保期/u.test(label);
}

function looksLikePathBundleName(value: string) {
  return /--|延期到|资料|附件|扫描|目录|汇总|打包|备份|招标工程量清单封面|招标工程量清单扉页|工程量清单表|清单封面|清单扉页|\d{1,2}\.\d{1,2}/u.test(value);
}

export function validateFactConsistency(input: { markdown: string; facts: DocumentFact[]; summary: ProjectMaterialSummary; profile?: DocumentDomainProfile }): ValidationIssue[] {
  const profile = input.profile || DEFAULT_DOCUMENT_DOMAIN_PROFILE;
  const issues: ValidationIssue[] = [];
  const factsByName = new Map<string, Array<{ value: string; source: string }>>();
  for (const fact of input.facts) {
    const label = fact.fieldName || fact.key;
    if (!label || !shouldCheckStrictConflict(label, profile)) continue;
    const value = comparableValue(String(fact.value), profile);
    if (!value) continue;
    factsByName.set(label, [...(factsByName.get(label) || []), { value: String(fact.value), source: fact.sourceFile }]);
  }
  for (const [label, values] of factsByName) {
    const grouped = new Map<string, Array<{ value: string; source: string }>>();
    for (const item of values) {
      const key = comparableValue(item.value, profile, label);
      if (!key) continue;
      grouped.set(key, [...(grouped.get(key) || []), item]);
    }
    if (grouped.size > 1) {
      // V5 P6 截断等价折叠（run1 实测）：同一实体名在不同材料中一头一尾截断
      //（「…公共广场空间改造等」vs「…公共广场空间改造等提升工程」、「…有限责任公」vs
      //「…有限责任公司」）被判多值冲突——互为前缀且长差小（≤3 字，或以「等」结尾 ≤6 字）
      //视为同一取值截断，短的并入长的组。
      const ascending = [...grouped.keys()].sort((a, b) => a.length - b.length);
      const absorbed = new Set<string>();
      for (let i = 0; i < ascending.length; i += 1) {
        const short = ascending[i]!;
        if (absorbed.has(short)) continue;
        for (let j = i + 1; j < ascending.length; j += 1) {
          const long = ascending[j]!;
          const diff = long.length - short.length;
          if ((diff <= 3 || (short.endsWith('等') && diff <= 6)) && long.startsWith(short)) {
            grouped.set(long, [...(grouped.get(long) || []), ...(grouped.get(short) || [])]);
            absorbed.add(short);
            break;
          }
        }
      }
      for (const key of absorbed) grouped.delete(key);
    }
    if (grouped.size > 1) {
      const detail = [...grouped.values()].map(group => `${group[0]!.value}（${group.map(item => item.source).filter(Boolean).join('、') || '未知来源'}）`).join(' vs ');
      issues.push({ level: 'error', message: `事实一致性冲突：${label} 存在多个值：${detail}`, suggestion: '请确认当前绑定材料组，或在模板绑定中只绑定当前文档所需材料。' });
    }
  }
  const projectName = input.summary.facts.projectName;
  if (projectName && projectName !== '当前知识库项目' && !looksLikePathBundleName(projectName)) {
    const normalizedMarkdown = normalize(input.markdown);
    const candidateNames = [projectName, ...input.summary.fingerprint.projectNames]
      .flatMap(name => [name, name.replace(/^\d+(?:\.\d+)?[^\u4e00-\u9fa5]*/u, ''), name.replace(/\([^)]*\)|（[^）]*）/gu, '')])
      .map(name => normalize(name))
      .filter(name => name.length >= 4);
    // 短项目名（4-7 字符，如“徽光阁项目施工”）只做精确包含匹配：短名泛化截断误伤风险高，
    // 精确匹配是可靠的；此前按 8 字符过滤会得到空候选集，导致短名项目必报“未包含对象名称”误报
    const longNames = candidateNames.filter(name => name.length >= 8);
    const shortNames = candidateNames.filter(name => name.length < 8);
    const longMatched = longNames.some(name => normalizedMarkdown.includes(name) || (name.length >= 12 && normalizedMarkdown.includes(name.slice(0, Math.max(8, Math.floor(name.length * 0.72))))));
    const shortMatched = shortNames.some(name => normalizedMarkdown.includes(name));
    const matched = longNames.length > 0 ? longMatched : shortNames.length > 0 ? shortMatched : true;
    if (!matched) {
      issues.push({ level: 'warning', message: `正文未包含当前对象名称：${projectName}`, suggestion: '请确认标题、概况或背景信息是否已体现当前对象名称。' });
    }
  }
  return issues;
}
