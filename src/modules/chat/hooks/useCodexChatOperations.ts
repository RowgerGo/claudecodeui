import { useCallback, useEffect, useRef, useState } from 'react';

import { readDraftText, writeDraftText } from '@/shared/chatDrafts';
import { createChatRequestId } from '@/shared/utils';
import type {
  CodexChatOperation,
  CodexChatOperationRequest,
  CodexGoalStateEvent,
  CodexOperationFeedback,
  CodexOperationReceipt,
  QueuedSendOptions,
} from '@/shared/types';

const STORAGE_KEY = 'chat.codex.pendingOperations';
const CHECK_INTERVAL_MS = 4_000;

const isUnresolved = ({ status }: CodexOperationFeedback) => (
  status === 'pending' || status === 'accepted' || status === 'unknown'
);

function restorePendingOperations(): CodexOperationFeedback[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]') as CodexOperationFeedback[];
    return Array.isArray(saved) ? saved.filter((entry) => entry?.requestId && entry.sessionId && entry.request).map((entry) => ({
      ...entry,
      status: 'unknown',
    })) : [];
  } catch {
    return [];
  }
}

function savePendingOperations(operations: CodexOperationFeedback[]) {
  try {
    const pending = operations.filter(isUnresolved);
    if (pending.length) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // In-memory receipts still work if sessionStorage is full or disabled.
  }
}

const sameOperation = (previous: CodexChatOperation, next: CodexChatOperation) => {
  if (previous.type === 'chat.compact') return next.type === 'chat.compact';
  return next.type === 'chat.goal' && previous.action === next.action
    && ('objective' in previous ? previous.objective : undefined) === ('objective' in next ? next.objective : undefined);
};

/** Used by ChatInterface to reconcile operation receipts independently of chat runs. */
export function useCodexChatOperations(sendMessage: (message: unknown) => boolean | void, isConnected: boolean) {
  // Receipts render independently of the transcript, including across session switches.
  const [operations, setOperations] = useState(restorePendingOperations);
  // WebSocket callbacks can arrive back-to-back before React commits their state.
  const operationsRef = useRef(operations);
  // Goal snapshots remain visible during reconnect until fresh state arrives.
  const [goalStates, setGoalStates] = useState(() => new Map<string, CodexGoalStateEvent>());
  // Revisions only order events from the current WebSocket connection.
  const goalRevisionsRef = useRef(new Map<string, number>());

  const updateOperations = useCallback((next: CodexOperationFeedback[]) => {
    operationsRef.current = next;
    savePendingOperations(next);
    setOperations(next);
  }, []);

  const checkStatus = useCallback((sessionId: string, requestId: string) => {
    const message: CodexChatOperationRequest = { type: 'chat.operation.status', sessionId, requestId };
    sendMessage(message);
  }, [sendMessage]);

  const dispatchOperation = useCallback((
    sessionId: string,
    request: CodexChatOperation,
    options?: QueuedSendOptions,
    submittedDraft?: string,
    editAfterQuery?: boolean,
  ) => {
    const duplicate = operationsRef.current.find((entry) => entry.sessionId === sessionId && isUnresolved(entry)
      && sameOperation(entry.request, request) && Boolean(entry.editAfterQuery) === Boolean(editAfterQuery));
    if (duplicate) {
      if (isConnected) checkStatus(sessionId, duplicate.requestId);
      return;
    }

    const requestId = createChatRequestId();
    const operation = request.type === 'chat.compact' ? 'compact' : 'goal';
    const entry: CodexOperationFeedback = { sessionId, requestId, request, operation, status: 'pending', submittedDraft, editAfterQuery };
    updateOperations([...operationsRef.current, entry]);
    const requestOptions = request.type === 'chat.goal' && request.action === 'set' ? options : undefined;
    const message: CodexChatOperationRequest = { ...request, sessionId, requestId, ...(requestOptions ? { options: requestOptions } : {}) };
    if (!isConnected || sendMessage(message) === false) {
      updateOperations(operationsRef.current.map((item) => item.requestId === requestId
        ? { ...item, status: 'rejected', code: 'DISCONNECTED' } : item));
    }
  }, [checkStatus, isConnected, sendMessage, updateOperations]);

  const onOperationReceipt = useCallback((receipt: CodexOperationReceipt) => {
    const previous = operationsRef.current.find((entry) => entry.sessionId === receipt.sessionId && entry.requestId === receipt.requestId);
    if (!previous || !isUnresolved(previous) || (receipt.operation && receipt.operation !== previous.operation)) return;
    if (receipt.status === 'pending' && previous.status === 'accepted') return;
    const { status, code, error, goal, cleared, goalRevision } = receipt;
    if (status === 'completed' && previous.submittedDraft && readDraftText(receipt.sessionId) === previous.submittedDraft) {
      writeDraftText(receipt.sessionId, '', { preserveUntilSaved: true });
    }
    updateOperations(operationsRef.current.map((entry) => entry === previous
      ? { ...entry, status, code, error, goal, cleared, goalRevision } : entry));
  }, [updateOperations]);

  const getPendingOperationIds = useCallback((sessionId: string) => operationsRef.current
    .filter((operation) => operation.sessionId === sessionId && isUnresolved(operation))
    .map((operation) => operation.requestId), []);

  const dismissOperation = useCallback((sessionId: string, requestId: string) => {
    updateOperations(operationsRef.current.filter((entry) => entry.sessionId !== sessionId || entry.requestId !== requestId));
  }, [updateOperations]);

  const onGoalState = useCallback((event: CodexGoalStateEvent) => {
    const previousRevision = goalRevisionsRef.current.get(event.sessionId);
    if (previousRevision !== undefined && previousRevision >= event.revision) return;
    goalRevisionsRef.current.set(event.sessionId, event.revision);
    setGoalStates((current) => {
      const next = new Map(current);
      next.set(event.sessionId, event);
      return next;
    });
  }, []);

  const resetGoalRevisions = useCallback(() => {
    goalRevisionsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!isConnected) {
      if (operationsRef.current.some(({ status }) => status === 'pending' || status === 'accepted')) {
        updateOperations(operationsRef.current.map((entry) => isUnresolved(entry) ? { ...entry, status: 'unknown' } : entry));
      }
      return;
    }
    // Missing receipts are checked by original id, without repeating the write.
    const timer = window.setInterval(() => {
      for (const { sessionId, requestId, status } of operationsRef.current) {
        if (status === 'pending' || status === 'accepted') checkStatus(sessionId, requestId);
      }
    }, CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [checkStatus, isConnected, updateOperations]);

  return { operations, goalStates, dispatchOperation, onOperationReceipt, onGoalState, resetGoalRevisions, getPendingOperationIds, dismissOperation, checkStatus };
}
