import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CodexThreadGoal } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type GoalDialogProps = {
  goal: CodexThreadGoal;
  replacement?: string;
  isConnected: boolean;
  onCancel: () => void;
  onConfirm: (objective: string) => void;
};

/** Used by the chat goal controls to edit a goal or confirm its replacement. */
export function CodexGoalDialog({ goal, replacement, isConnected, onCancel, onConfirm }: GoalDialogProps) {
  const { t } = useTranslation('chat');
  // The edit starts from a queried goal, while other tabs can keep updating the thread.
  const [objective, setObjective] = useState(goal.objective);
  const isReplacement = replacement !== undefined;
  const title = t(isReplacement ? 'commands.replace' : 'commands.edit');
  const titleId = useId();

  useEffect(() => {
    const trigger = document.activeElement;
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent aria-labelledby={titleId} className="max-h-[85dvh] overflow-y-auto p-5">
        <DialogTitle id={titleId} className="not-sr-only text-base font-semibold">{title}</DialogTitle>
        {isReplacement ? (
          <div className="my-4 grid gap-3">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">{t('commands.currentObjective')}</p>
              <p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-sm">{goal.objective}</p>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">{t('commands.newObjective')}</p>
              <p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-sm">{replacement}</p>
            </div>
          </div>
        ) : (
          <textarea
            className="my-4 block min-h-28 w-full resize-y rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('commands.goalLabel')}
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>{t('commands.cancel')}</Button>
          <Button
            type="button"
            disabled={!isConnected || (!isReplacement && (!objective.trim() || objective === goal.objective))}
            onClick={() => onConfirm(replacement ?? objective)}
          >
            {t(isReplacement ? 'commands.replace' : 'commands.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
