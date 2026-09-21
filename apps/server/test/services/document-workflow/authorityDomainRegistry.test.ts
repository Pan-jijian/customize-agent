/**
 * G 线 P1-1 权威域注册表：单一事实来源同时驱动「注入」与「写后确定性对齐」两条通道。
 *
 * 缺陷背景：两条通道此前彼此不识——注入覆盖 11 个域（`AUTHORITY_DOMAIN_CHAPTER_ROUTES`），
 * 而写后对齐在 `alignChapterContentToBlueprint` 里**硬编码 2 个域** + 1 个特例分支，
 * 且两侧的章标题正则各写一份（改一处漏一处）。于是「注入了锚点」与「写后会把错值纠回来」
 * 成了两件事：域可以只注入、不对齐，写作层写错后没有任何确定性收口。
 */
import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_DOMAIN_CHAPTER_ROUTES,
  AUTHORITY_DOMAIN_REGISTRY,
  alignmentAnchorsForChapter,
  assertAuthorityDomainChannels,
  authorityDomainChannelReport,
} from '@/services/document-workflow/integratedBlueprint/render';

describe('G 线 P1-1 权威域注册表', () => {
  it('注册表自洽（域唯一、正则非全局——g 标志会让 test 因 lastIndex 抖动而路由不可复现）', () => {
    expect(() => assertAuthorityDomainChannels()).not.toThrow();
  });

  it('注入路由由注册表派生（行为与历史逐字一致：11 域）', () => {
    expect(AUTHORITY_DOMAIN_CHAPTER_ROUTES).toHaveLength(AUTHORITY_DOMAIN_REGISTRY.length);
    expect(AUTHORITY_DOMAIN_CHAPTER_ROUTES.map(route => route.domain)).toEqual(AUTHORITY_DOMAIN_REGISTRY.map(spec => spec.domain));
  });

  it('写后对齐锚点由注册表派生，且章标题路由与注入通道同源', () => {
    // 劳动力章：命中 labor 域 ⇒ 既有注入锚点也有写后对齐锚点
    expect(alignmentAnchorsForChapter('第四章 劳动力配置计划')).toContain('data.resources.labor.peak_value');
    // 养护期章：命中 redline 域 ⇒ 写后对齐
    expect(alignmentAnchorsForChapter('第八章 绿化养护与成品保护')).toContain('data.redline.greening_maintenance');
    // 工期章：命中 contract 域 ⇒ 写后对齐
    expect(alignmentAnchorsForChapter('第二章 施工总体部署与总工期安排')).toContain('data.contract.total_days');
    // 无写后对齐的域（如 equipment）即使命中注入域也不产生对齐锚点——差距是显式的
    expect(alignmentAnchorsForChapter('第五章 主要施工机械设备配置')).toEqual([]);
  });

  it('通道覆盖报告显式暴露差距（11 域中仅 3 域有写后对齐）', () => {
    const report = authorityDomainChannelReport();
    expect(report.total).toBe(11);
    expect(report.withAlignment.sort()).toEqual(['contract', 'labor', 'redline']);
    // 其余 8 域**显式登记为无写后对齐**，而不是留白——差距必须可被统计与被审查
    expect(report.withoutAlignment).toHaveLength(8);
    expect(report.withAlignment.length + report.withoutAlignment.length).toBe(report.total);
  });
});
