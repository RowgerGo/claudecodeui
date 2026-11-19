import { useTranslation } from 'react-i18next';

import { LLMProviderLogo } from '@/shared/ui';
import type { Project, ProjectSession } from '@/shared/types';
import { getSessionTitle } from '@/shared/utils';
import { useSessionTitleRename } from '@/modules/project-workspace/hooks/useSessionTitleRename';

type WorkspaceTitleProps = {
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  /** Persists a new title for a session; resolves false when the backend refuses it. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
};

/** Rendered by WorkspaceHeader to show and rename the session while using workspace tools. */
export default function WorkspaceTitle({
  selectedProject,
  selectedSession,
  onRenameSession,
}: WorkspaceTitleProps) {
  const { t } = useTranslation();
  const sessionTitle = selectedSession ? getSessionTitle(selectedSession) : '';

  const {
    isEditing: isRenaming,
    draft: renameDraft,
    isSaving: isSavingRename,
    inputRef: renameInputRef,
    startEditing: startRenaming,
    updateDraft: updateRenameDraft,
    cancelEditing: cancelRenaming,
    handleInputKeyDown: handleRenameKeyDown,
  } = useSessionTitleRename({
    sessionId: selectedSession?.id ?? null,
    currentTitle: sessionTitle,
    onRenameSession,
  });

  return (
    <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {selectedSession && (
        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <LLMProviderLogo provider={selectedSession.__provider} className="h-4 w-4" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {selectedSession ? (
          <div className="min-w-0">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                type="text"
                value={renameDraft}
                onChange={(event) => updateRenameDraft(event.target.value)}
                onKeyDown={handleRenameKeyDown}
                // Clicking anywhere else cancels, as the sidebar's rename does.
                onBlur={cancelRenaming}
                readOnly={isSavingRename}
                aria-busy={isSavingRename}
                aria-label={t('mainContent.renameSessionLabel')}
                // Blur cancels, so a touch keyboard needs a key that commits.
                enterKeyHint="done"
                className="w-full max-w-md rounded border border-border bg-background px-1.5 py-0.5 text-sm font-semibold leading-tight text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <h2
                title={t('mainContent.renameSessionHint', { title: sessionTitle })}
                onDoubleClick={startRenaming}
                className="cursor-text truncate text-sm font-semibold leading-tight text-foreground"
              >
                {sessionTitle}
              </h2>
            )}
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="truncate text-xs leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        )}
      </div>
    </div>
  );
}
