import { XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { CodexOperationFeedback } from '@/shared/types';

type Props = {
  operations: CodexOperationFeedback[];
  isConnected: boolean;
  onDismiss: (sessionId: string, requestId: string) => void;
  onCheckStatus: (sessionId: string, requestId: string) => void;
};

/** Used by ChatInterface to show Codex command receipts beside the composer. */
export function CodexOperationFeedbackList({ operations, isConnected, onDismiss, onCheckStatus }: Props) {
  const { t } = useTranslation('chat');
  const visible = operations.filter((entry) => !(entry.operation === 'compact' && entry.status === 'completed')).slice(-3);
  if (!visible.length) return null;

  return (
    <div className="mx-auto mb-2 max-w-[54.25rem] space-y-1" aria-live="polite">
      {visible.map(({ operation, sessionId, requestId, status, code, error, cleared, goal }) => {
        const failed = status === 'failed' || status === 'rejected';
        const inProgress = status === 'pending' || status === 'accepted';
        const message = failed
          ? code === 'DISCONNECTED'
            ? t('commands.disconnected')
            : t(`commands.errors.${code || 'CODEX_NATIVE_ERROR'}`, {
                message: error || '',
                defaultValue: t('commands.errors.CODEX_NATIVE_ERROR', { message: error || '' }),
              })
          : status === 'completed' && cleared
            ? t('commands.cleared')
            : status === 'completed' && goal === null
              ? t('commands.errors.GOAL_NO_GOAL')
              : t(`commands.${status}`);

        return (
          <div key={requestId} className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs">
            <span className="shrink-0 font-medium">{t(operation === 'compact' ? 'commands.compactLabel' : 'commands.goalLabel')}</span>
            <span className={`min-w-0 flex-1 break-words ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>{message}</span>
            {status === 'unknown' && (
              <button
                type="button"
                disabled={!isConnected}
                className="shrink-0 underline underline-offset-2 disabled:opacity-50"
                onClick={() => onCheckStatus(sessionId, requestId)}
              >
                {t('commands.checkStatus')}
              </button>
            )}
            {!inProgress && (
              <button
                type="button"
                aria-label={t('commands.dismiss')}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => onDismiss(sessionId, requestId)}
              >
                <XIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
