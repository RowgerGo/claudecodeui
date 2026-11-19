import { memo, useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { ArrowLeft, FileCode2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ChatInterface } from '@/modules/chat';
import { usePlugins } from '@/modules/plugins';
import { useBrowserUseEnabled } from '@/modules/browser-use';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { useTaskMasterProjectSync, useTasksSettings } from '@/modules/task-master';
import type { AppTab, CodeEditorDiffInfo, DirectoryRevealRequest, Project, ProjectSession, SessionEstablishedContext, SessionNavigationOptions, SettingsMainTab, WorkspaceTool } from '@/shared/types';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { useFileOpenResolver } from '@/modules/project-workspace/hooks/useFileOpenResolver';
import { EditorSidebar, useEditorSidebar } from '@/modules/code-editor';
import WorkspaceHeader from '@/modules/project-workspace/WorkspaceHeader';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';
import WorkspaceErrorBoundary from '@/modules/project-workspace/WorkspaceErrorBoundary';
import WorkspaceToolPanel from '@/modules/project-workspace/WorkspaceToolPanel';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import WorkspaceTools from '@/modules/project-workspace/WorkspaceTools';

type WorkspaceMainProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  lastTool: WorkspaceTool;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings: (tab?: SettingsMainTab) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  /** Switches the app to another project — used by the git panel's Worktrees view. */
  onProjectSelect: (project: Project) => void;
  /** Silently re-syncs the sidebar project list after worktree projects change. */
  onProjectsRefresh: () => void;
  /** Persists a new title for a session; resolves false when the backend refuses it. Used by the header's inline rename. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
};

/** Rendered by ProjectMainRegion to keep the current conversation and its tool panel in a single workspace. */
function WorkspaceMain({
  selectedProject,
  selectedSession,
  activeTab,
  lastTool,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  onProjectSelect,
  onProjectsRefresh,
  onRenameSession,
}: WorkspaceMainProps) {
  const { t } = useTranslation();
  const preferences = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter, codexSteerByDefault } = preferences;

  const { tasksEnabled, isTaskMasterInstalled, isCheckingInstallation } = useTasksSettings();
  const browserEnabled = useBrowserUseEnabled();
  const { plugins, loading: loadingPlugins, pluginsError } = usePlugins();
  useTaskMasterProjectSync(selectedProject);
  // Directory links can be clicked repeatedly or in different projects.
  const [revealDirectory, setRevealDirectory] = useState<(DirectoryRevealRequest & { projectId: string }) | null>(null);
  // The editor takes the place of its originating tool until the user returns to that tool's list.
  const [editorOrigin, setEditorOrigin] = useState<'files' | 'git' | null>(null);
  const { editingFile, handleFileOpen, handleCloseEditor, handleUnsavedChangesChange } = useEditorSidebar({
    selectedProject, isMobile,
  });

  const selectedTool = activeTab === 'chat' ? lastTool : activeTab;
  const toolsOpen = activeTab !== 'chat';
  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const unavailable = (selectedTool === 'tasks' && (!tasksEnabled || (!isCheckingInstallation && !isTaskMasterInstalled)))
    || (selectedTool === 'browser' && browserEnabled === false)
    || (selectedTool.startsWith('plugin:') && !loadingPlugins && !pluginsError
      && !plugins.some(plugin => plugin.enabled && selectedTool === `plugin:${plugin.name}`));
  const tool = unavailable ? 'files' : selectedTool;

  useEffect(() => {
    if (toolsOpen && unavailable) setActiveTab('files');
  }, [toolsOpen, unavailable, setActiveTab]);

  const closeTools = useCallback(() => setActiveTab('chat'), [setActiveTab]);
  const showAllTasks = useCallback(() => setActiveTab('tasks'), [setActiveTab]);

  const showDocument = useCallback((
    origin: 'files' | 'git', path: string, diff?: CodeEditorDiffInfo | null, line?: number | null,
  ) => {
    if (!handleFileOpen(path, diff, line)) return;
    setEditorOrigin(origin);
    setActiveTab(origin);
  }, [handleFileOpen, setActiveTab]);
  const showFile = useCallback((path: string, diff?: CodeEditorDiffInfo | null, line?: number | null) => {
    showDocument('files', path, diff, line);
  }, [showDocument]);
  const { resolveFile, cancelLookup } = useFileOpenResolver(selectedProject, showFile);
  // A slow path lookup belongs to the tab and conversation that requested it.
  useEffect(() => cancelLookup, [activeTab, selectedSession?.id, newSessionTrigger, cancelLookup]);
  const openFile = useCallback((path: string, diff?: CodeEditorDiffInfo | null, line?: number | null) => {
    cancelLookup();
    showFile(path, diff, line);
  }, [cancelLookup, showFile]);
  const openGitFile = useCallback((path: string, diff?: CodeEditorDiffInfo) => {
    cancelLookup();
    showDocument('git', path, diff);
  }, [cancelLookup, showDocument]);

  const openFileInEditor = useCallback((path: string, line?: number | null) => {
    resolveFile(path, undefined, line);
  }, [resolveFile]);
  const projectId = selectedProject?.projectId;
  const openDirectory = useCallback((path: string) => {
    if (!projectId) return;
    cancelLookup();
    setEditorOrigin(null);
    setActiveTab('files');
    setRevealDirectory({ path, projectId });
  }, [cancelLookup, projectId, setActiveTab]);

  usePaletteOpsRegister({ openFile, openFileInEditor, openDirectory });

  if (isLoading) {
    return <WorkspaceStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <WorkspaceStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  const currentFile = editingFile?.projectId === projectId ? editingFile : null;
  const editorVisible = Boolean(currentFile && toolsOpen && tool === editorOrigin);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <WorkspaceHeader
        toolsOpen={toolsOpen}
        onToggleTools={() => setActiveTab(toolsOpen ? 'chat' : tool)}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onRenameSession={onRenameSession}
      />
      <WorkspaceToolPanel
        isOpen={toolsOpen}
        activeTab={tool}
        onClose={closeTools}
        navigation={(
          <WorkspaceTabs
            activeTab={tool}
            setActiveTab={setActiveTab}
            shouldShowTasksTab={shouldShowTasksTab}
            shouldShowBrowserTab={Boolean(browserEnabled)}
          />
        )}
        chat={visible => (
          <WorkspaceErrorBoundary showDetails>
            <ChatInterface
              isActive={visible}
              selectedProject={selectedProject}
              selectedSession={selectedSession}
              ws={ws}
              sendMessage={sendMessage}
              onFileOpen={openFile}
              onNavigateToSession={onNavigateToSession}
              onSessionEstablished={onSessionEstablished}
              onShowSettings={onShowSettings}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              sendByCtrlEnter={sendByCtrlEnter}
              codexSteerByDefault={codexSteerByDefault}
              externalMessageUpdate={externalMessageUpdate}
              newSessionTrigger={newSessionTrigger}
              onShowAllTasks={shouldShowTasksTab ? showAllTasks : null}
            />
          </WorkspaceErrorBoundary>
        )}
        tools={({ compact, visible }) => (
          <div className="flex h-full min-w-0 flex-col">
            {currentFile && (tool === 'files' || tool === 'git') && (
              <div className="flex shrink-0 border-b border-border/60 px-2 py-1">
                <button
                  type="button"
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => setEditorOrigin(editorVisible ? null : tool)}
                >
                  {editorVisible ? <ArrowLeft className="size-3.5 shrink-0" /> : <FileCode2 className="size-3.5 shrink-0" />}
                  <span className="truncate">{editorVisible ? t(tool === 'git' ? 'toolPanel.backToGit' : 'toolPanel.backToFiles') : currentFile.name}</span>
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              <WorkspaceTools
                key={selectedProject.projectId}
                activeTool={visible && !editorVisible ? tool : null}
                compact={isMobile || compact}
                project={selectedProject}
                session={selectedSession}
                revealDirectory={revealDirectory?.projectId === projectId ? revealDirectory : null}
                onFileOpen={openFile}
                onGitFileOpen={openGitFile}
                onProjectSelect={onProjectSelect}
                onProjectsRefresh={onProjectsRefresh}
                onShowSettings={onShowSettings}
                tasksEnabled={shouldShowTasksTab}
                browserEnabled={Boolean(browserEnabled)}
              />
              <EditorSidebar
                embedded
                visible={visible && editorVisible}
                editingFile={editingFile}
                onCloseEditor={handleCloseEditor}
                onUnsavedChangesChange={handleUnsavedChangesChange}
              />
            </div>
          </div>
        )}
      />
    </div>
  );
}

export default memo(WorkspaceMain);
