import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { BrowserUsePanel } from '@/modules/browser-use';
import { FileTree } from '@/modules/file-tree';
import { GitPanel } from '@/modules/git-panel';
import { PluginTabContent } from '@/modules/plugins';
import { StandaloneShell } from '@/modules/standalone-shell';
import { TaskMasterPanel } from '@/modules/task-master';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { DirectoryRevealRequest, FileOpenHandler, Project, ProjectSession, SettingsMainTab, WorkspaceTool } from '@/shared/types';

type WorkspaceToolsProps = {
  activeTool: WorkspaceTool | null;
  compact: boolean;
  project: Project;
  session: ProjectSession | null;
  revealDirectory: DirectoryRevealRequest | null;
  onFileOpen: FileOpenHandler;
  onGitFileOpen: FileOpenHandler;
  onProjectSelect: (project: Project) => void;
  onProjectsRefresh: () => void;
  onShowSettings: (tab?: SettingsMainTab) => void;
  tasksEnabled: boolean;
  browserEnabled: boolean;
};

function RetainedTool({ visible, children }: { visible: boolean; children: ReactNode }) {
  // Open expensive tools on demand, then preserve their controls, scroll position and connections.
  const [visited, setVisited] = useState(visible);
  if (visible && !visited) setVisited(true);
  if (!visible && !visited) return null;
  return <div hidden={!visible} className="h-full min-h-0 min-w-0 overflow-hidden">{children}</div>;
}

/** WorkspaceMain mounts this once per project to host tools alongside the shared file editor. */
export default function WorkspaceTools({
  activeTool, compact, project, session, revealDirectory, onFileOpen, onGitFileOpen,
  onProjectSelect, onProjectsRefresh, onShowSettings, tasksEnabled, browserEnabled,
}: WorkspaceToolsProps) {
  const { subscribe } = useWebSocket();
  // The selected agent can change the worktree while the file tree or Git status is on screen.
  const [revision, setRevision] = useState(0);
  const sessionId = session?.id;
  useEffect(() => {
    if (!sessionId) return;
    return subscribe(event => {
      if (event.kind === 'complete' && event.sessionId === sessionId) setRevision(previous => previous + 1);
    });
  }, [sessionId, subscribe]);

  const filesVisible = activeTool === 'files';
  const shellVisible = activeTool === 'shell';
  const gitVisible = activeTool === 'git';
  return (
    <>
      <RetainedTool visible={filesVisible}>
        <FileTree
          selectedProject={project}
          onFileOpen={onFileOpen}
          revealDirectory={revealDirectory}
          isVisible={filesVisible}
          refreshRevision={revision}
        />
      </RetainedTool>
      <RetainedTool key={sessionId ?? ''} visible={shellVisible}>
        <StandaloneShell
          project={project}
          session={session}
          showHeader={false}
          isActive={shellVisible}
          autoConnect={shellVisible}
          autoFocus={false}
        />
      </RetainedTool>
      <RetainedTool visible={gitVisible}>
        <GitPanel
          selectedProject={project}
          isMobile={compact}
          onFileOpen={onGitFileOpen}
          onProjectSelect={onProjectSelect}
          onProjectsRefresh={onProjectsRefresh}
          isVisible={gitVisible}
          refreshRevision={revision}
        />
      </RetainedTool>
      {browserEnabled && (
        <RetainedTool visible={activeTool === 'browser'}>
          <BrowserUsePanel isVisible={activeTool === 'browser'} onShowSettings={onShowSettings} />
        </RetainedTool>
      )}
      {tasksEnabled && (
        <RetainedTool visible={activeTool === 'tasks'}>
          <TaskMasterPanel isVisible={activeTool === 'tasks'} />
        </RetainedTool>
      )}
      {activeTool?.startsWith('plugin:') && (
        <PluginTabContent pluginName={activeTool.slice('plugin:'.length)} selectedProject={project} selectedSession={session} />
      )}
    </>
  );
}
