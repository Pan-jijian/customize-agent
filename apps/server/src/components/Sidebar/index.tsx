'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useAppTranslations } from '@/components/Layout';
import { LayoutDashboard, Database, Cpu, Settings, MessageSquare, ChevronDown, ChevronRight, FileText, FolderOpen, PanelLeftClose, PanelLeftOpen, Files, BookOpen, Bug, Moon, LibraryBig } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Tooltip } from 'antd';

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
    ],
  },
  { href: '/models', icon: Cpu, labelKey: 'nav.models' },
  { href: '/prompt', icon: MessageSquare, labelKey: 'nav.promptManagement' },
  { href: '/document-roles', icon: Settings, labelKey: 'nav.documentRoles' },
  { href: '/documents', icon: Files, labelKey: 'nav.documents' },
  { href: '/template-references', icon: LibraryBig, labelKey: 'nav.templateReferences' },
  { href: '/asset-library', icon: FolderOpen, labelKey: 'nav.assetLibrary' },
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
          <div className="w-8 h-8 rounded-lg bg-black dark:bg-white flex items-center justify-center shrink-0">
            <Moon className="text-white dark:text-black" size={20} />
          </div>
          <div className="sidebarLogoTitle">
            <span className="logoGradient">Customize Agent</span>
          </div>
        </div>
      </Link>

      <nav className="sidebarNav mt-2">
        {NAV_ITEMS.map((item) => {
          if (item.children) {
            const isOpen = expanded[item.labelKey] ?? defaultExpanded[item.labelKey] ?? false;
            const hasActiveChild = isChildActive(item.children);

            return (
              <div key={item.labelKey}>
                <Tooltip title={collapsed ? t(item.labelKey) : ''} placement="right">
                  <div
                    className={`sidebarItem sidebarParent${hasActiveChild && collapsed ? ' sidebarItemActive' : ''}`}
                    onClick={() => {
                      if (collapsed) {
                        setCollapsed(false);
                        setExpanded(prev => ({ ...prev, [item.labelKey]: true }));
                      } else {
                        toggleExpand(item.labelKey);
                      }
                    }}
                  >
                    <item.icon size={18} />
                    <span className="sidebarLabel">{t(item.labelKey)}</span>
                    <span className="sidebarChevron">
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>
                  </div>
                </Tooltip>
                {isOpen && !collapsed && (
                  <div className="sidebarSubmenu animateFadeIn">
                    {item.children.map((child) => {
                      const childActive = pathname === child.href || pathname.startsWith(child.href + '/');
                      return (
                        <Link key={child.href} href={child.href} prefetch={false}>
                          <div className={`sidebarItem sidebarSubItem${childActive ? ' sidebarItemActive' : ''}`}>
                            <child.icon size={16} />
                            <span className="sidebarLabel">{t(child.labelKey)}</span>
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
            <Tooltip key={item.href} title={collapsed ? t(item.labelKey) : ''} placement="right">
              <Link href={item.href!} prefetch={false}>
                <div className={`sidebarItem${active ? ' sidebarItemActive' : ''}`}>
                  <item.icon size={18} />
                  <span className="sidebarLabel">{t(item.labelKey)}</span>
                </div>
              </Link>
            </Tooltip>
          );
        })}
      </nav>

      <div className="sidebarCollapseWrapper">
        <button className="sidebarCollapseBtn" onClick={() => setCollapsed(v => !v)} aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}>
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>
    </aside>
  );
}
