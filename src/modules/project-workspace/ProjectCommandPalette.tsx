import { memo } from 'react';

import { useProjectCommandState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { CommandPalette } from '@/modules/command-palette';

/** Rendered by ProjectWorkspaceShell to bind this module's project state to the command-palette module. */
function ProjectCommandPalette() {
  const {
    selectedProject,
    handleNewSession,
    openSessionChat,
    openSettings,
    setActiveTab,
  } = useProjectCommandState();

  return (
    <CommandPalette
      selectedProject={selectedProject}
      onStartNewChat={handleNewSession}
      onOpenSession={openSessionChat}
      onOpenSettings={openSettings}
      onShowTab={setActiveTab}
    />
  );
}

export default memo(ProjectCommandPalette);
