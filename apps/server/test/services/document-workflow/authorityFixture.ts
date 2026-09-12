/**
 * V5 P4 测试 fixture：按权威域语义构造 AuthorityIndex（与 deriveRepairAuthorities 派生规则对齐）。
 * 修复器统一改为消费 authorityIndex 后，旧测试的外部权威注入
 * （machineAuthorities / villageCountAuthority / slackDaysAuthority / codeAuthorities / quantityAuthorities /
 * nodeAuthorities）语义等价迁移为本 fixture 的域条目注入：
 * - equipment/quantity 域条目按 CROSS_SECTION_ANCHOR_ENTITY_RE 实体词自动对接跨节锚点 key；
 * - schedule 域「机动工期」/「里程碑:节点名」、redline 域「自然村数量」走 directByDomain 直取；
 * - spec 域条目 anchor 即 codeAuthorities 键（如 cushion→垫层 C 标号）。
 */
import type { AuthorityDomain, AuthorityEntry, AuthorityIndex } from '@/services/document-workflow/authorityIndex';

let entrySeq = 0;

function fixtureEntry(domain: AuthorityDomain, label: string, value: number | string, unit: string, anchors?: string[]): AuthorityEntry {
  entrySeq += 1;
  return {
    id: `${domain}:${label}#${entrySeq}`,
    kind: 'fact',
    domain,
    label,
    anchors: anchors ?? [label],
    value,
    unit,
    source: 'test-fixture',
    paths: [],
  };
}

export function fixtureIndex(input: {
  /** 设备条目（equipment 域）：label 用实体名（如「塔式起重机」「潜水泵」「干粉灭火器」），自动对接锚点 key */
  equipment?: Array<{ label: string; value: number }>;
  /** 清单数量条目（quantity 域）：值 ≥10 且名称 ≥3 汉字入工程量权威 */
  quantity?: Array<{ label: string; value: number; unit?: string }>;
  /** 里程碑节点（schedule 域）：value 为完成天数，派生 offset=「第N日」 */
  milestones?: Array<{ label: string; value: number }>;
  /** 机动工期（schedule 域「机动工期」条目） */
  slackDays?: number;
  /** 总工期（contract 域「总工期」条目） */
  scheduleDays?: number;
  /** 自然村数量（redline 域「自然村数量」条目） */
  villageCount?: number;
  /** 规格权威（spec 域）：anchor 为锚点 key（如 cushion），value 为规格文本 */
  specs?: Array<{ anchor: string; value: string }>;
}): AuthorityIndex {
  const entries: AuthorityEntry[] = [];
  for (const item of input.equipment ?? []) entries.push(fixtureEntry('equipment', item.label, item.value, '台'));
  for (const item of input.quantity ?? []) entries.push(fixtureEntry('quantity', item.label, item.value, item.unit ?? ''));
  for (const item of input.milestones ?? []) entries.push(fixtureEntry('schedule', `里程碑:${item.label}`, item.value, '天'));
  if (input.slackDays !== undefined) entries.push(fixtureEntry('schedule', '机动工期', input.slackDays, '天'));
  if (input.scheduleDays !== undefined) entries.push(fixtureEntry('contract', '总工期', input.scheduleDays, '日历天'));
  if (input.villageCount !== undefined) entries.push(fixtureEntry('redline', '自然村数量', input.villageCount, '个'));
  for (const item of input.specs ?? []) entries.push(fixtureEntry('spec', `规格:${item.anchor}`, item.value, '', [item.anchor]));
  const byDomain = new Map<AuthorityDomain, AuthorityEntry[]>();
  for (const item of entries) {
    const group = byDomain.get(item.domain);
    if (group) group.push(item);
    else byDomain.set(item.domain, [item]);
  }
  return { entries, byDomain };
}
