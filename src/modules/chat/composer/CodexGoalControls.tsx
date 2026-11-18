import { useTranslation } from 'react-i18next';

import type { CodexChatOperation, CodexOperationFeedback, CodexThreadGoal } from '@/shared/types';
import { Button } from '@/shared/ui';
import { CodexGoalDialog } from '@/modules/chat/modals/CodexGoalDialog';

type GoalControlsProps = {
  goal: CodexThreadGoal | null;
  operations: CodexOperationFeedback[];
  isConnected: boolean;
  hasActiveTurn: boolean;
  showDialogs: boolean;
  onOperation: (operation: CodexChatOperation, submittedDraft?: string, editAfterQuery?: boolean) => void;
  onDismiss: (sessionId: string, requestId: string) => void;
};

/** Used by ChatInterface to show the current Codex goal and run its scoped controls. */
export function CodexGoalControls({ goal, operations, isConnected, hasActiveTurn, showDialogs, onOperation, onDismiss }: GoalControlsProps) {
  const { t, i18n } = useTranslation('chat');
  const dialog = showDialogs ? [...operations].reverse().find((item) => item.goal && (item.code === 'GOAL_REPLACEMENT_REQUIRED'
    || (item.editAfterQuery && item.status === 'completed'))) : undefined;
  const replacement = dialog?.request.type === 'chat.goal' && dialog.request.action === 'set' ? dialog.request.objective : undefined;
  const dismissDialog = () => { if (dialog) onDismiss(dialog.sessionId, dialog.requestId); };

  return (
    <>
      {goal && (
        <section aria-label={t('commands.goalLabel')} className="mx-auto mb-2 max-w-[54.25rem] rounded-xl border border-border/70 bg-card/70 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
            <h2 className="font-semibold">{t('commands.goalLabel')}</h2>
            <span className={`rounded-full px-2 py-0.5 ${goal.status === 'active' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
              {t(`commands.statuses.${goal.status}`)}
            </span>
            <span className="text-muted-foreground">
              {t(goal.tokenBudget === null ? 'commands.tokensUsed' : 'commands.tokenBudget', {
                used: goal.tokensUsed.toLocaleString(i18n.resolvedLanguage),
                budget: goal.tokenBudget?.toLocaleString(i18n.resolvedLanguage),
              })}
            </span>
          </div>
          <p className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-sm">{goal.objective}</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={!isConnected} onClick={() => onOperation({ type: 'chat.goal', action: 'get' }, undefined, true)}>
              {t('commands.edit')}
            </Button>
            {goal.status === 'active' && (
              <Button type="button" variant="ghost" size="sm" disabled={!isConnected} onClick={() => onOperation({ type: 'chat.goal', action: 'pause' })}>
                {t('commands.pause')}
              </Button>
            )}
            {goal.status !== 'complete' && (goal.status !== 'active' || !hasActiveTurn) && (
              <Button type="button" variant="ghost" size="sm" disabled={!isConnected} onClick={() => onOperation({ type: 'chat.goal', action: 'resume' })}>
                {t('commands.resume')}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" disabled={!isConnected} onClick={() => onOperation({ type: 'chat.goal', action: 'clear' })}>
              {t('commands.clear')}
            </Button>
          </div>
        </section>
      )}
      {dialog?.goal && (
        <CodexGoalDialog
          key={dialog.requestId}
          goal={dialog.goal}
          replacement={replacement}
          isConnected={isConnected}
          onCancel={dismissDialog}
          onConfirm={(objective) => {
            if (!dialog.goal) return;
            onOperation({ type: 'chat.goal', action: replacement === undefined ? 'edit' : 'replace', objective, expectedGoal: dialog.goal }, dialog.submittedDraft);
            dismissDialog();
          }}
        />
      )}
    </>
  );
}
