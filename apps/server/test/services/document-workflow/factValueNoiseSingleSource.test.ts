/**
 * 4.56.3「事实值噪声判据单源」的**可执行契约**。
 *
 * 背景（实测代价）：同一件事——「一个事实值是否可参与对账比较」——在仓库里有两份实现：
 * `factsModel.conflictComparableFactValue`（完整）与
 * `document-validation/factConsistencyService.comparableValue`（缺全部噪声判据）。
 * 两份判定对同一批数据给**相反结论**（真值层按变更连接语取 330，对账侧取首个匹配 365），
 * 于是产出 6 条「事实一致性冲突」blocker → 冲突数 ≥5 → `factIntegrity` 的 60% 分量归零 →
 * 事实维度 40 分、综合分被压到 85（`doc-1790156773687-0c18ca14`）。
 *
 * 本测试把「单源」从注释变成 CI 可拦住的约束：噪声判据只许有一份实现，
 * 且两个消费方都必须从 `factValueNoise` / `authoritativeValues` 取用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { foldHomoglyphVariants, isComplianceCitationValue, isTableScrapeFragment, valueAfterChangeConnector } from '@/services/document-workflow/factValueNoise';

const SRC_DIR = path.resolve(__dirname, '../../../src/services');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [full];
  });
}

describe('4.56.3 事实值噪声判据单源', () => {
  it('变更叙述取值：连接语之后才是生效值（判据与真值层同源）', () => {
    expect(valueAfterChangeConnector('365日历天，现变更修改为:330日历天')).toBe('330日历天');
    expect(valueAfterChangeConnector('330日历天')).toBe('330日历天');
    expect(valueAfterChangeConnector('计划工期 400日历天')).toBe('计划工期 400日历天');
  });

  it('表格抓取残片：表头词连排即判残片（不可能是某个事实的取值）', () => {
    expect(isTableScrapeFragment('现澄清为如下：条款号条款号条款名称条款名称编列内容编列内容1.3.2计划工期')).toBe(true);
    expect(isTableScrapeFragment('评标办法前附表')).toBe(true);
    expect(isTableScrapeFragment('330日历天')).toBe(false);
    expect(isTableScrapeFragment('巢湖市居巢经开区义成路与南外环路交口北侧')).toBe(false);
  });

  it('同形变体折叠：破折号族与夹在汉字间的「一」一并删除', () => {
    expect(foldHomoglyphVariants('巢湖市光电新能源产业园项目—东区标准化厂房二标段施工'))
      .toBe(foldHomoglyphVariants('巢湖市光电新能源产业园项目一东区标准化厂房二标段施工'));
    // 真差异不被吞并：一标段 / 二标段 折叠后仍不相等
    expect(foldHomoglyphVariants('一标段')).not.toBe(foldHomoglyphVariants('二标段'));
  });

  it('4.58 ① 合规引用句判据：合规动词 + 条款编号 + 规定/要求收尾 三连才算引用', () => {
    // 实测 `doc-1790168542563-ea526b1b`：`计划工期` 的值之一是这句引用，被判成与真值并列的口径
    expect(isComplianceCitationValue('符合第二章“投标人须知”第1.3.2项规定')).toBe(true);
    expect(isComplianceCitationValue('满足招标文件第五章“工期要求”第2.1条要求')).toBe(true);
    // 反向：缺条款编号的合规句是**真实取值**（形态判据不误伤），一律不以引用滤掉
    expect(isComplianceCitationValue('符合国家现行验收规范合格标准')).toBe(false);
    expect(isComplianceCitationValue('满足GB50204-2015要求')).toBe(false);
    // 反向：时间/对象类真实取值三形态均不受影响
    expect(isComplianceCitationValue('330日历天')).toBe(false);
    expect(isComplianceCitationValue('2026年10月10日')).toBe(false);
    expect(isComplianceCitationValue('框架结构')).toBe(false);
  });

  it('**反重复（硬约束）**：噪声判据只许有一份实现', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const relative = path.relative(SRC_DIR, file);
      if (relative === 'document-workflow/factValueNoise.ts') continue;
      const text = fs.readFileSync(file, 'utf8');
      // 函数体级重复定义（不是 import、不是调用）
      if (/function\s+hasCorruptTextMarkers\s*\(/u.test(text)) offenders.push(`${relative}：重复定义 hasCorruptTextMarkers`);
      if (/function\s+valueAfterChangeConnector\s*\(/u.test(text)) offenders.push(`${relative}：重复定义 valueAfterChangeConnector`);
      if (/function\s+temporalValueKind\s*\(/u.test(text)) offenders.push(`${relative}：重复定义 temporalValueKind`);
      if (/function\s+stripFactLabelPrefix\s*\(/u.test(text) || /function\s+stripFactLabelPrefix\s*\(value\s*:\s*string\)/u.test(text)) offenders.push(`${relative}：重复定义 stripFactLabelPrefix`);
      if (/function\s+stripTrailingFormAnnotation\s*\(/u.test(text)) offenders.push(`${relative}：重复定义 stripTrailingFormAnnotation`);
      if (/function\s+foldAdminNameAbbreviation\s*\(/u.test(text)) offenders.push(`${relative}：重复定义 foldAdminNameAbbreviation`);
      if (/function\s+isComplianceCitationValue\s*\(/u.test(text)) offenders.push(`${relative}：重复定义 isComplianceCitationValue`);
      // 对象名窗口收拢/残片判定（4.58 R5 ③）：写在 parameterConceptConflicts 里会同时被检测端与裁决端各写一份
      if (/function\s+(?:collapseObjectWindowStart|collapseObjectWindowEnd|hasTruncatedBracketFragment|findTruncationSource)\s*\(/u.test(text)) offenders.push(`${relative}：重复定义对象名窗口收拢/残片判据`);
      // 手抄连接语正则（应 import valueAfterChangeConnector）
      if (/CHANGE_CONNECTORS\s*\}\s*\|\|/u.test(text) && /exec\(raw\)/u.test(text)) offenders.push(`${relative}：手抄变更连接语取值逻辑`);
    }
    expect(offenders, `事实值噪声判据必须单源：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('**接线（硬约束）**：两个消费方都必须从单源模块取用', () => {
    const factsModel = fs.readFileSync(path.join(SRC_DIR, 'document-workflow', 'factsModel.ts'), 'utf8');
    const consistency = fs.readFileSync(path.join(SRC_DIR, 'document-validation', 'factConsistencyService.ts'), 'utf8');
    // 同一目录用 './factValueNoise'，跨层（document-validation）用 '../document-workflow/factValueNoise'
    expect(factsModel, 'factsModel 未从 factValueNoise 取用噪声判据').toContain("from './factValueNoise'");
    expect(consistency, 'factConsistencyService 未从 factValueNoise 取用噪声判据').toContain("from '../document-workflow/factValueNoise'");
    // 对账侧此前缺的三项判据必须都在场（漏一项即回到误报族）
    expect(consistency).toContain('rejectValueNoise(');
    expect(consistency).toContain('hasCorruptTextMarkers(');
    expect(consistency).toContain('isTableScrapeFragment(');
    expect(consistency).toContain('valueAfterChangeConnector(');
    expect(consistency).toContain('foldHomoglyphVariants(');
    expect(consistency).toContain('temporalValueKind(');
    expect(consistency).toContain('stripFactLabelPrefix(');
    expect(consistency).toContain('stripTrailingFormAnnotation(');
    // 4.58 ①：合规引用句判据同样只许从单源模块取用
    expect(consistency).toContain('isComplianceCitationValue(');
  });
});
