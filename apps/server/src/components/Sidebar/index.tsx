'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useAppTranslations } from '@/components/Layout';
import { LayoutDashboard, Database, Cpu, Settings, Brain, MessageSquare, ChevronDown, ChevronRight, FileText, FolderOpen, PanelLeftClose, PanelLeftOpen, Search, Files, BookOpen, Bug } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface SubMenuItem {
  href: string;
  icon: LucideIcon;
  labelKey: string;
}

interface NavItem {
  href?: string;
  icon: LucideIcon;
  labelKey: string;
  children?: SubMenuItem[];
}

const NAV_ITEMS: NavItem[] = [
  { href: '/overview', icon: LayoutDashboard, labelKey: 'nav.overview' },
  {
    icon: Database,
    labelKey: 'nav.knowledge',
    children: [
      { href: '/knowledge/manage', icon: FolderOpen, labelKey: 'nav.knowledgeManage' },
      { href: '/knowledge/files', icon: FileText, labelKey: 'nav.fileManagement' },
      { href: '/knowledge/search', icon: Search, labelKey: 'nav.knowledgeSearch' },
    ],
  },
  { href: '/models', icon: Cpu, labelKey: 'nav.models' },
  { href: '/prompt', icon: MessageSquare, labelKey: 'nav.promptManagement' },
  { href: '/document-roles', icon: Settings, labelKey: 'nav.documentRoles' },
  { href: '/document-specs', icon: FileText, labelKey: 'nav.documentSpecs' },
  { href: '/documents', icon: Files, labelKey: 'nav.documents' },
  { href: '/asset-library', icon: FolderOpen, labelKey: 'nav.assetLibrary' },
  {
    icon: Brain,
    labelKey: 'nav.contextEngineering',
    children: [
      { href: '/context/long-term', icon: Database, labelKey: 'nav.longTermContext' },
      { href: '/context/short-term', icon: Database, labelKey: 'nav.shortTermContext' },
    ],
  },
  { href: '/system/logs', icon: Bug, labelKey: 'nav.systemLogs' },
  { href: '/guide', icon: BookOpen, labelKey: 'nav.guide' },
  { href: '/settings', icon: Settings, labelKey: 'nav.settings' },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const t = useAppTranslations();
  /** 根据当前路径确定默认展开的导航分组，确保激活的子菜单可见 */
  const defaultExpanded = useMemo(() => {
    const next: Record<string, boolean> = {};
    for (const item of NAV_ITEMS) {
      if (item.children?.some(c => pathname === c.href || pathname.startsWith(c.href + '/'))) {
        next[item.labelKey] = true;
      }
    }
    return next;
  }, [pathname]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle('sidebarCollapsed', collapsed);
    return () => document.documentElement.classList.remove('sidebarCollapsed');
  }, [collapsed]);

  const toggleExpand = (key: string) => {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  };

  /** 判断导航项的子菜单中是否有处于激活状态的项 */
  const isChildActive = (children?: SubMenuItem[]) =>
    children?.some(c => pathname === c.href || pathname.startsWith(c.href + '/'));

  return (
    <aside className={`sidebar${collapsed ? ' sidebarCollapsedSelf' : ''}`}>
      <Link href="/overview" prefetch={false}>
        <div className="sidebarLogo">
          <div className="sidebarLogoTitle" style={{ fontSize: 20, fontWeight: 800, letterSpacing: '0.5px' }}>
            <span className="logoGradient">{t('app.title')}</span>
          </div>
        </div>
      </Link>

      <button className="sidebarCollapseBtn" onClick={() => setCollapsed(v => !v)} aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}>
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>

      <nav className="sidebarNav">
        {NAV_ITEMS.map((item) => {
          if (item.children) {
            const isOpen = expanded[item.labelKey] ?? defaultExpanded[item.labelKey] ?? false;

            return (
              <div key={item.labelKey}>
                <div
                  className="sidebarItem sidebarParent"
                  onClick={() => toggleExpand(item.labelKey)}
                >
                  <item.icon size={18} />
                  <span>{t(item.labelKey)}</span>
                  <span className="sidebarChevron">
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>
                </div>
                {isOpen && !collapsed && (
                  <div className="sidebarSubmenu">
                    {item.children.map((child) => {
                      const childActive = pathname === child.href || pathname.startsWith(child.href + '/');
                      return (
                        <Link key={child.href} href={child.href} prefetch={false}>
                          <div className={`sidebarItem sidebarSubItem${childActive ? ' sidebarItemActive' : ''}`}>
                            <child.icon size={16} />
                            <span>{t(child.labelKey)}</span>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link key={item.href} href={item.href!} prefetch={false}>
              <div className={`sidebarItem${active ? ' sidebarItemActive' : ''}`}>
                <item.icon size={18} />
                <span>{t(item.labelKey)}</span>
              </div>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
