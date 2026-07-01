'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LayoutDashboard, Database, Cpu, Settings, Sparkles, Brain, MessageSquare, ChevronDown, ChevronRight, FileText, FolderOpen } from 'lucide-react';
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
    ],
  },
  {
    icon: Brain,
    labelKey: 'nav.contextEngineering',
    children: [
      { href: '/context/long-term', icon: Database, labelKey: 'nav.longTermContext' },
      { href: '/context/short-term', icon: Database, labelKey: 'nav.shortTermContext' },
    ],
  },
  { href: '/models', icon: Cpu, labelKey: 'nav.models' },
  { href: '/prompt', icon: MessageSquare, labelKey: 'nav.promptManagement' },
  { href: '/settings', icon: Settings, labelKey: 'nav.settings' },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const t = useTranslations();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleExpand = (key: string) => {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // 初始化：如果子菜单中有一个是当前路径，则自动展开
  const ensureExpanded = (key: string, children?: SubMenuItem[]) => {
    if (expanded[key] !== undefined) return;
    if (children?.some(c => pathname === c.href || pathname.startsWith(c.href + '/'))) {
      setExpanded(prev => ({ ...prev, [key]: true }));
    }
  };

  const isChildActive = (children?: SubMenuItem[]) =>
    children?.some(c => pathname === c.href || pathname.startsWith(c.href + '/'));

  return (
    <aside className="sidebar">
      <Link href="/overview">
        <div className="sidebarLogo">
          <div className="sidebarLogoIcon">
            <Sparkles size={20} color="#fff" />
          </div>
          <div>
            <div className="sidebarLogoTitle">{t('app.title')}</div>
            <div className="sidebarLogoSub">{t('app.subtitle')}</div>
          </div>
        </div>
      </Link>

      <nav className="sidebarNav">
        {NAV_ITEMS.map((item) => {
          if (item.children) {
            ensureExpanded(item.labelKey, item.children);
            const active = isChildActive(item.children);
            const isOpen = expanded[item.labelKey] ?? false;

            return (
              <div key={item.labelKey}>
                <div
                  className={`sidebarItem${active ? ' sidebarItemActive' : ''} sidebarParent`}
                  onClick={() => toggleExpand(item.labelKey)}
                >
                  <item.icon size={18} />
                  <span>{t(item.labelKey)}</span>
                  <span className="sidebarChevron">
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>
                </div>
                {isOpen && (
                  <div className="sidebarSubmenu">
                    {item.children.map((child) => {
                      const childActive = pathname === child.href || pathname.startsWith(child.href + '/');
                      return (
                        <Link key={child.href} href={child.href}>
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
            <Link key={item.href} href={item.href!}>
              <div className={`sidebarItem${active ? ' sidebarItemActive' : ''}`}>
                <item.icon size={18} />
                <span>{t(item.labelKey)}</span>
              </div>
            </Link>
          );
        })}
      </nav>

      <div className="sidebarFooter">v0.1.0</div>
    </aside>
  );
}
