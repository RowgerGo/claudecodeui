import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { CodexGoalControls } from '@/modules/chat/composer/CodexGoalControls';
import { useCodexChatOperations } from '@/modules/chat/hooks/useCodexChatOperations';
import { readDraftText, resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type { CodexGoalStateEvent, CodexOperationFeedback, CodexThreadGoal } from '@/shared/types';

const SESSION_ID = 'session-codex';
const TIMESTAMP = '2026-11-18T10:00:00Z';
const GOAL: CodexThreadGoal = {
  threadId: 'native-codex',
  objective: 'Complete the objective',
  status: 'active',
  tokenBudget: 1000,
  tokensUsed: 100,
  timeUsedSeconds: 10,
  createdAt: 1,
  updatedAt: 2,
};

describe('Codex chat command receipts', () => {
  beforeEach(() => {
    resetChatDrafts();
    sessionStorage.clear();
  });

  afterEach(() => {
    resetChatDrafts();
    sessionStorage.clear();
  });

  it('checks a repeated command by its original id and keeps the pending receipt through refresh', () => {
    const send = vi.fn(() => true);
    const beforeReload = renderHook(() => useCodexChatOperations(send, true));
    act(() => beforeReload.result.current.dispatchOperation(SESSION_ID, { type: 'chat.compact' }));
    const requestId = beforeReload.result.current.getPendingOperationIds(SESSION_ID)[0];
    act(() => beforeReload.result.current.dispatchOperation(SESSION_ID, { type: 'chat.compact' }));
    expect(send.mock.calls).toEqual([
      [{ type: 'chat.compact', sessionId: SESSION_ID, requestId }],
      [{ type: 'chat.operation.status', sessionId: SESSION_ID, requestId }],
    ]);
    beforeReload.unmount();

    const { result } = renderHook(() => useCodexChatOperations(send, true));
    expect(result.current.operations[0].status).toBe('unknown');
    expect(result.current.getPendingOperationIds(SESSION_ID)).toEqual([requestId]);
    act(() => result.current.onOperationReceipt({ kind: 'chat_operation_status', sessionId: SESSION_ID, requestId, status: 'unknown' }));
    expect(result.current.operations[0].status).toBe('unknown');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('separates receipt admission and results, and leaves the submitted draft when a write fails', () => {
    const send = vi.fn(() => true);
    const { result } = renderHook(() => useCodexChatOperations(send, true));
    const entered = '/goal Finish\n  this objective';
    writeDraftText(SESSION_ID, entered);
    act(() => result.current.dispatchOperation(SESSION_ID, { type: 'chat.goal', action: 'set', objective: 'Finish\n  this objective' }, {}, entered));
    const requestId = result.current.getPendingOperationIds(SESSION_ID)[0];
    const receipt = { kind: 'chat_operation_status', sessionId: SESSION_ID, requestId, operation: 'goal' } as const;

    act(() => result.current.onOperationReceipt({ ...receipt, sessionId: 'other', status: 'failed' }));
    expect(result.current.operations[0].status).toBe('pending');
    act(() => result.current.onOperationReceipt({ ...receipt, status: 'accepted' }));
    act(() => result.current.onOperationReceipt({ ...receipt, status: 'pending' }));
    expect(result.current.operations[0].status).toBe('accepted');
    expect(readDraftText(SESSION_ID)).toBe(entered);
    act(() => result.current.onOperationReceipt({ ...receipt, status: 'failed' }));
    expect(result.current.operations[0].status).toBe('failed');
    expect(readDraftText(SESSION_ID)).toBe(entered);
  });

  it('scopes revisions to the session and accepts a new server snapshot on reconnect', () => {
    const { result } = renderHook(() => useCodexChatOperations(() => true, true));
    const update = (sessionId: string, revision: number, goal: CodexThreadGoal | null) => {
      const event: CodexGoalStateEvent = { kind: 'chat_goal_state', sessionId, goal, revision, timestamp: TIMESTAMP };
      act(() => result.current.onGoalState(event));
    };

    update(SESSION_ID, 5, GOAL);
    update('other', 2, { ...GOAL, status: 'paused' });
    update(SESSION_ID, 6, null);
    update(SESSION_ID, 4, GOAL);
    expect(result.current.goalStates.get(SESSION_ID)?.goal).toBeNull();
    expect(result.current.goalStates.get('other')?.goal?.status).toBe('paused');

    act(() => result.current.resetGoalRevisions());
    update(SESSION_ID, 1, { ...GOAL, status: 'paused' });
    expect(result.current.goalStates.get(SESSION_ID)?.goal?.status).toBe('paused');
  });
});

describe('Codex goal dialogs', () => {
  it('shows both objectives and makes cancellation independent of replacement', () => {
    const operation = {
      sessionId: SESSION_ID,
      requestId: 'replace-1',
      operation: 'goal',
      request: { type: 'chat.goal', action: 'set', objective: 'New objective' },
      submittedDraft: '/goal New objective',
      goal: GOAL,
      status: 'rejected',
      code: 'GOAL_REPLACEMENT_REQUIRED',
    } satisfies CodexOperationFeedback;
    const onOperation = vi.fn();
    const onDismiss = vi.fn();
    render(<CodexGoalControls
      goal={GOAL}
      operations={[operation]}
      hasActiveTurn
      isConnected
      showDialogs
      onOperation={onOperation}
      onDismiss={onDismiss}
    />);
    const dialog = within(screen.getByRole('dialog', { name: 'Replace goal' }));
    expect(dialog.getByText(GOAL.objective)).toBeTruthy();
    expect(dialog.getByText('New objective')).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(onOperation).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledWith(SESSION_ID, 'replace-1');
    fireEvent.click(dialog.getByRole('button', { name: 'Replace goal' }));
    expect(onOperation).toHaveBeenCalledWith({ type: 'chat.goal', action: 'replace', objective: 'New objective', expectedGoal: GOAL }, '/goal New objective');
  });

  it('opens the edit box with the fetched objective and saves an edit with the original snapshot', () => {
    const pausedGoal = { ...GOAL, status: 'paused' } as const;
    const onOperation = vi.fn();
    render(<CodexGoalControls
      goal={pausedGoal}
      operations={[{
        sessionId: SESSION_ID,
        requestId: 'edit-1',
        operation: 'goal',
        request: { type: 'chat.goal', action: 'get' },
        editAfterQuery: true,
        status: 'completed',
        goal: pausedGoal,
      }]}
      hasActiveTurn={false}
      isConnected
      showDialogs
      onOperation={onOperation}
      onDismiss={vi.fn()}
    />);
    const dialog = within(screen.getByRole('dialog', { name: 'Edit goal' }));
    const input = dialog.getByRole('textbox', { name: 'Goal' }) as HTMLTextAreaElement;
    expect(input.value).toBe(pausedGoal.objective);
    fireEvent.change(input, { target: { value: 'Edited first line\n  second line' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save goal' }));
    expect(onOperation).toHaveBeenCalledWith({
      type: 'chat.goal', action: 'edit', objective: 'Edited first line\n  second line', expectedGoal: pausedGoal,
    }, undefined);
  });
});
