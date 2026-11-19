import { Terminal, Folder, GitBranch, ClipboardCheck, MonitorPlay } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Fragment, useEffect, useRef } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip, PillBar, Pill } from '@/shared/ui';
import type { AppTab } from '@/shared/types';
import { usePlugins, PluginIcon } from '@/modules/plugins';

type WorkspaceTabsProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

type PluginTab = {
  kind: 'plugin';
  id: AppTab;
  label: string;
  pluginName: string;
  iconFile: string;
};

type TabDefinition = BuiltInTab | PluginTab;

const BASE_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git',   labelKey: 'tabs.git',   icon: GitBranch },
];

const BROWSER_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'browser',
  labelKey: 'tabs.browser',
  icon: MonitorPlay,
};

const TASKS_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

/** Used by the workspace tools panel to switch between built-in tools and enabled plugins. */
export default function WorkspaceTabs({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const strip = scrollRef.current;
    const tab = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !tab) return;
    const bounds = strip.getBoundingClientRect();
    const activeBounds = tab.getBoundingClientRect();
    if (activeBounds.left < bounds.left) strip.scrollLeft += activeBounds.left - bounds.left;
    else if (activeBounds.right > bounds.right) strip.scrollLeft += activeBounds.right - bounds.right;
  }, [activeTab, plugins, shouldShowBrowserTab, shouldShowTasksTab]);

  const builtInTabs: BuiltInTab[] = [
    ...BASE_TABS,
    ...(shouldShowBrowserTab ? [BROWSER_TAB] : []),
    ...(shouldShowTasksTab ? [TASKS_TAB] : []),
  ];

  const pluginTabs: PluginTab[] = plugins
    .filter((p) => p.enabled)
    .map((p) => ({
      kind: 'plugin',
      id: `plugin:${p.name}` as AppTab,
      label: p.displayName,
      pluginName: p.name,
      iconFile: p.icon,
    }));

  const tabs: TabDefinition[] = [...builtInTabs, ...pluginTabs];

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabList = event.currentTarget.closest('[role="tablist"]');
    if (!tabList) return;

    const tabButtons = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabButtons.indexOf(event.currentTarget);
    let nextIndex: number;

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabButtons.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabButtons.length - 1;
    else return;

    event.preventDefault();
    tabButtons[nextIndex]?.focus();
    tabButtons[nextIndex]?.click();
  };

  return (
    <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain">
      <PillBar
        role="tablist"
        aria-label={t('toolPanel.name')}
        className="min-w-max border border-border/40 bg-muted/50 shadow-inner shadow-black/[0.025] dark:shadow-black/10"
      >
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTab;
          const displayLabel = tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;

          return (
            <Fragment key={tab.id}>
              {index === builtInTabs.length && pluginTabs.length > 0 && (
                <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
              )}
              <Tooltip content={displayLabel} position="bottom">
                <Pill
                  role="tab"
                  aria-label={displayLabel}
                  id={`workspace-tool-tab-${tab.id}`}
                  aria-controls="workspace-tool-content"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  isActive={isActive}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={handleTabKeyDown}
                  className="h-8 max-w-44 px-2.5 py-[5px]"
                >
                  {tab.kind === 'builtin' ? (
                    <tab.icon className="h-3.5 w-3.5 shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
                  ) : (
                    <PluginIcon
                      pluginName={tab.pluginName}
                      iconFile={tab.iconFile}
                      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
                    />
                  )}
                  <span className={`${isActive ? 'inline max-w-28' : 'hidden'} truncate`}>
                    {displayLabel}
                  </span>
                </Pill>
              </Tooltip>
            </Fragment>
          );
        })}
      </PillBar>
    </div>
  );
}
