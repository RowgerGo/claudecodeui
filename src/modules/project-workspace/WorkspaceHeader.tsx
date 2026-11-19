import { PanelRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Project, ProjectSession } from '@/shared/types';
import { cn } from '@/shared/utils';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import WorkspaceConnectionStatus from '@/modules/project-workspace/WorkspaceConnectionStatus';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';

type WorkspaceHeaderProps = {
  toolsOpen: boolean;
  onToggleTools: () => void;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  isMobile: boolean;
  onMenuClick: () => void;
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
};

/** Rendered by WorkspaceMain to identify the chat and toggle its companion tools. */
export default function WorkspaceHeader({
  toolsOpen,
  onToggleTools,
  selectedProject,
  selectedSession,
  isMobile,
  onMenuClick,
  onRenameSession,
}: WorkspaceHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className="pwa-header-safe flex shrink-0 items-center gap-2 border-b border-border/60 bg-background/95 px-3 py-1.5 sm:gap-3 sm:px-4 sm:py-2">
      {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
      <WorkspaceTitle
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        onRenameSession={onRenameSession}
      />
      <WorkspaceConnectionStatus />
      <button
        type="button"
        aria-expanded={toolsOpen}
        aria-controls="workspace-tools"
        onClick={onToggleTools}
        className={cn(
          'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/60',
          toolsOpen
            ? 'border-border bg-muted text-foreground'
            : 'border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <PanelRight aria-hidden="true" className="h-4 w-4" />
        {t('toolPanel.name')}
      </button>
    </header>
  );
}
