import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings } from '@/modules/task-master';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import PermissionContext from '@/modules/chat/context/PermissionContext';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
import { api } from '@/shared/api';
import type {
  ChatMessage,
  Project,
  ProjectSession,
  SessionEstablishedContext,
  SessionNavigationOptions,
} from '@/shared/types';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useCodexChatOperations } from '@/modules/chat/hooks/useCodexChatOperations';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useEscapeToAbortSession } from '@/modules/chat/hooks/useEscapeToAbortSession';
import {
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { CodexOperationFeedbackList } from '@/modules/chat/composer/CodexOperationFeedbackList';
import { CodexGoalControls } from '@/modules/chat/composer/CodexGoalControls';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';

type ChatInterfaceProps = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean | void;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  codexSteerByDefault?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
};

/**
 * Used by the project-workspace module (via the chat barrel) to render a
 * project session's chat tab; it owns the session, provider, realtime and
 * composer state that ChatMessagesPane and ChatComposer render.
 */
function ChatInterface({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  codexSteerByDefault = false,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe, isConnected } = useWebSocket();
  const { t } = useTranslation('chat');
  const { operations, goalStates, dispatchOperation, onOperationReceipt, onGoalState, resetGoalRevisions,
    getPendingOperationIds, dismissOperation, checkStatus } =
    useCodexChatOperations(sendMessage, isConnected);
  const processingSessions = useProcessingSessions();
  const {
    markSessionProcessing: onSessionProcessing,
    markSessionIdle: onSessionIdle,
    markSessionBackground: onSessionBackground,
    getSessionActivity,
  } = useSessionProtectionActions();

  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());
  // The sequence cursor is scoped to the last observed Codex turn, even
  // after that turn finishes and no longer accepts follow-up messages.
  const lastTurnIdRef = useRef(new Map<string, string>());
  // Active turn IDs drive the send menu and prevent a late send from being
  // steered into a newer turn.
  const [activeCodexTurns, setActiveCodexTurns] = useState(() => new Map<string, string>());
  const onCodexTurnChange = useCallback((sessionId: string, turnId: string | null) => {
    setActiveCodexTurns((current) => {
      if ((current.get(sessionId) ?? null) === turnId) return current;
      const next = new Map(current);
      if (turnId) next.set(sessionId, turnId);
      else next.delete(sessionId);
      return next;
    });
  }, []);
  // Session subscriptions are prepared before the composer hook runs.
  const getPendingSteerIdsRef = useRef<((sessionId: string) => string[]) | undefined>(undefined);
  const getSubscriptionOptions = useCallback((sessionId: string) => {
    const lastTurnId = lastTurnIdRef.current.get(sessionId);
    const pendingSteerIds = getPendingSteerIdsRef.current?.(sessionId) ?? [];
    const pendingOperationIds = getPendingOperationIds(sessionId);
    return {
      ...(lastTurnId ? { lastTurnId } : {}),
      ...(pendingSteerIds.length > 0 ? { pendingSteerIds } : {}),
      ...(pendingOperationIds.length > 0 ? { pendingOperationIds } : {}),
    };
  }, [getPendingOperationIds]);

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
  }, []);

  const {
    provider,
    setProvider,
    providerModels,
    setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
    supportsSideQuestions,
    supportsSteering,
    supportsContextClearing,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    revealMessage,
    loadAllMessages,
    loadFullTranscript,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
  } = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    getSubscriptionOptions,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  /**
   * Clears the open session's context: the conversation stays on screen, with
   * a divider where the clear happened, and the next message starts fresh.
   */
  const handleClearContext = useCallback(async () => {
    const sessionId = currentSessionId || selectedSession?.id;
    if (!supportsContextClearing) {
      addMessage({ type: 'assistant', content: t('misc.clearContextUnsupported'), timestamp: Date.now() });
      return;
    }
    // A chat that has not sent its first message has no context yet.
    if (!sessionId) {
      addMessage({ type: 'assistant', content: t('misc.clearContextEmpty'), timestamp: Date.now() });
      return;
    }

    try {
      const response = await api.clearSessionContext(sessionId);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
      }
      if (!payload?.data?.cleared) {
        addMessage({ type: 'assistant', content: t('misc.clearContextEmpty'), timestamp: Date.now() });
        return;
      }
      // The counter described the context that was just left behind.
      setTokenBudget(null);
      // Brings in the divider the server now ends the history with.
      await requestLatestMessages(sessionId, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addMessage({ type: 'error', content: t('misc.clearContextFailed', { message }), timestamp: Date.now() });
    }
  }, [addMessage, currentSessionId, requestLatestMessages, selectedSession?.id, setTokenBudget, supportsContextClearing, t]);

  // The button asks first: unlike a typed `/clear`, a click can be a slip.
  const handleClearContextClick = useCallback(() => {
    if (window.confirm(t('misc.clearContextConfirm'))) {
      void handleClearContext();
    }
  }, [handleClearContext, t]);

  const codexSessionId = provider === 'codex' ? selectedSession?.id || currentSessionId : null;
  const activeCodexTurnId = codexSessionId ? activeCodexTurns.get(codexSessionId) : undefined;
  const codexGoal = codexSessionId ? goalStates.get(codexSessionId)?.goal ?? null : null;
  const visibleCodexOperations = operations.filter((entry) => entry.sessionId === codexSessionId);
  const hasActiveCodexGoal = codexGoal?.status === 'active';
  const canSteerCurrentTurn = supportsSteering && (provider !== 'codex' || Boolean(activeCodexTurnId));
  const {
    input,
    isCodexControlInput,
    codexCommandNotice,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    handleSendMenuChoice,
    backgroundSendPrompt,
    resolveBackgroundSendPrompt,
    queuedDraft,
    handleCodexQueuedSend,
    editQueuedDraft,
    deleteQueuedDraft,
    pendingSteers,
    handleSteerOutcome,
    getPendingSteerIds,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    isLoading: isProcessing,
    processingSessions,
    canAbortSession,
    tokenBudget,
    sendMessage,
    isConnected,
    sendByCtrlEnter,
    supportsSteering,
    codexSteerByDefault,
    activeCodexTurnId,
    hasActiveCodexGoal,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onFileOpen,
    onShowSettings,
    onClearContext: handleClearContext,
    onCodexOperation: dispatchOperation,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
    supportsSideQuestions,
  });
  useLayoutEffect(() => {
    getPendingSteerIdsRef.current = getPendingSteerIds;
  }, [getPendingSteerIds]);

  // A reload can recover history even after the server's replay record expired.
  // Settle only exact user-message echoes; matching the text can retire a
  // different send of the same words.
  useEffect(() => {
    const sessionId = selectedSession?.id || currentSessionId;
    if (!sessionId || !pendingSteers?.some((steer) => steer.expectedTurnId)) return;
    for (const row of sessionStore.getMessages(sessionId)) {
      if (row.kind === 'text' && row.role === 'user') {
        handleSteerOutcome(sessionId, row.id, 'delivered');
      }
    }
  }, [chatMessages, currentSessionId, handleSteerOutcome, pendingSteers, selectedSession?.id, sessionStore]);

  // On WebSocket reconnect, request a bounded persisted-tail sync (deferred
  // while Chat is hidden), then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    resetGoalRevisions();
    if (!selectedProject || !selectedSession) return;
    await requestLatestMessages(selectedSession.id, isActive);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
        ...getSubscriptionOptions(selectedSession.id),
      }],
    });
  }, [getSubscriptionOptions, isActive, requestLatestMessages, resetGoalRevisions, selectedProject, selectedSession, sendMessage]);

  useChatRealtimeHandlers({
    isActive,
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    lastTurnIdRef,
    onCodexTurnChange,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onSessionBackground,
    getSessionActivity,
    onWebSocketReconnect: handleWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
    onSteerOutcome: handleSteerOutcome,
    onCodexOperationReceipt: onOperationReceipt,
    onCodexGoalState: onGoalState,
    onCodexQueuedSend: handleCodexQueuedSend,
  });

  // Lets other modules (the quick settings Commands tab) hand text to the
  // composer: append it after a separating space, then focus the textarea with
  // the caret at the end once React has rendered the new value.
  const insertComposerText = useCallback((text: string) => {
    setInput((previous) => {
      const separator = previous && !/\s$/.test(previous) ? ' ' : '';
      return `${previous}${separator}${text}`;
    });
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      const caretPosition = textarea.value.length;
      textarea.setSelectionRange(caretPosition, caretPosition);
    });
  }, [setInput, textareaRef]);

  usePaletteOpsRegister({ insertComposerText });

  useEscapeToAbortSession({
    canAbortSession,
    onAbortSession: handleAbortSession,
    composerRef: textareaRef,
  });

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  /**
   * Branches the conversation into a new session that ends at this message,
   * then opens it. The session being viewed is left exactly as it was.
   */
  const handleForkFromMessage = useCallback(async (message: ChatMessage) => {
    const anchorId = message.transcriptAnchorId;
    const sourceSessionId = selectedSession?.id;
    if (!anchorId || !sourceSessionId) return;

    try {
      const response = await api.forkSession(sourceSessionId, { upToAnchorId: anchorId });
      const payload = await response.json();
      const forkedSessionId = payload?.data?.sessionId;
      if (!response.ok || typeof forkedSessionId !== 'string') {
        throw new Error(payload?.message || `HTTP ${response.status}`);
      }
      onNavigateToSession?.(forkedSessionId);
    } catch (error) {
      console.error('Error forking session:', error);
    }
  }, [onNavigateToSession, selectedSession?.id]);

  const { scheduledMessages, schedule: scheduleMessage, cancel: cancelScheduledMessage } =
    useScheduledMessages(currentSessionId || selectedSession?.id || null, subscribe);

  /**
   * Hands the composer's current text to the server to send later, and clears
   * the box as a send would — the message has left the composer either way.
   */
  const handleScheduleMessage = useCallback(async (scheduledFor: Date) => {
    const content = input.trim();
    if (!content) return;

    const scheduled = await scheduleMessage({
      content,
      scheduledFor,
      options: { model: currentProviderModel, effort: currentProviderEffort, permissionMode },
    });
    if (scheduled) {
      setInput('');
    }
  }, [currentProviderEffort, currentProviderModel, input, permissionMode, scheduleMessage, setInput]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // Lets markdown image paths in the transcript resolve against this project.
  const markdownWorkspaceValue = useMemo(() => ({
    projectId: selectedProject?.projectId ?? null,
  }), [selectedProject?.projectId]);

  // Lets a workflow card fetch its agents' timelines for this session.
  const transcriptSessionValue = useMemo(() => ({ sessionId: currentSessionId }), [currentSessionId]);

  // A composer pick becomes the default for new chats and, when a session is
  // open, is recorded against that session so reopening it restores this model.
  const handleSelectComposerModel = useCallback(async (model: string) => {
    try {
      await selectProviderModel(provider, model, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [currentSessionId, provider, selectProviderModel, selectedSession?.id]);

  const handleSelectComposerEffort = useCallback(async (effort: string) => {
    try {
      await selectProviderEffort(provider, effort, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session reasoning effort:', error);
    }
  }, [currentSessionId, provider, selectProviderEffort, selectedSession?.id]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  const selectedProviderLabel =
    provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : t('messageTypes.claude');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }


  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <MarkdownWorkspaceContext.Provider value={markdownWorkspaceValue}>
          <TranscriptSessionContext.Provider value={transcriptSessionValue}>
            <ChatMessagesPane
              scrollContainerRef={scrollContainerRef}
              // Not redundant with the `scroll` listener. A first page is 20 rows,
              // tool results fold into their calls, and the "load earlier" link is
              // hidden while more pages exist — so a short transcript is often not
              // scrollable at all and never emits `scroll`. Wheel and touch are
              // then the only way to reach the top pager or the "load all" overlay.
              onWheel={handleScroll}
              onTouchMove={handleScroll}
              isLoadingSessionMessages={isLoadingSessionMessages}
              isProcessing={isProcessing}
              hasActivityIndicator={hasActivityIndicator}
              chatMessages={chatMessages}
              selectedSession={selectedSession}
              currentSessionId={currentSessionId}
              provider={provider}
              setProvider={setProvider}
              textareaRef={textareaRef}
              providerModels={providerModels}
              setProviderModel={setStoredProviderModel}
              providerModelCatalog={providerModelCatalog}
              providerModelActions={providerModelActions}
              providerModelsLoading={providerModelsLoading}
              tasksEnabled={tasksEnabled}
              isTaskMasterInstalled={isTaskMasterInstalled}
              onShowAllTasks={onShowAllTasks}
              setInput={setInput}
              isLoadingMoreMessages={isLoadingMoreMessages}
              hasMoreMessages={hasMoreMessages}
              totalMessages={totalMessages}
              sessionMessagesCount={chatMessages.length}
              visibleMessageCount={visibleMessageCount}
              visibleMessages={visibleMessages}
              loadEarlierMessages={loadEarlierMessages}
              revealMessage={revealMessage}
              backgroundTasks={sessionActivity?.tasks}
              sendMessage={sendMessage}
              loadAllMessages={loadAllMessages}
              allMessagesLoaded={allMessagesLoaded}
              isLoadingAllMessages={isLoadingAllMessages}
              loadAllJustFinished={loadAllJustFinished}
              showLoadAllOverlay={showLoadAllOverlay}
              createDiff={createDiff}
              onFileOpen={onFileOpen}
              onShowSettings={onShowSettings}
              onGrantToolPermission={handleGrantToolPermission}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              selectedProject={selectedProject}
              // Editing replaces the turn and everything after it, so it is only
              // offered when the session is idle — a half-truncated transcript with
              // a live stream writing into it is not recoverable.
              onEditMessage={supportsMessageEditing && !isProcessing ? beginEditMessage : undefined}
              onForkFromMessage={supportsSessionForking ? handleForkFromMessage : undefined}
              onLoadFullTranscript={loadFullTranscript}
            />
          </TranscriptSessionContext.Provider>
        </MarkdownWorkspaceContext.Provider>

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          sessionControls={provider === 'codex' && (
            <>
              {codexCommandNotice && (
                <div role="status" className={`mx-auto mb-2 max-w-[54.25rem] rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs ${codexCommandNotice.isError ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {codexCommandNotice.content}
                </div>
              )}
              {codexSessionId && <CodexGoalControls
                goal={codexGoal}
                operations={visibleCodexOperations}
                isConnected={isConnected}
                hasActiveTurn={Boolean(activeCodexTurnId)}
                showDialogs={isActive}
                onOperation={(operation, submittedDraft, editAfterQuery) => (
                  dispatchOperation(codexSessionId, operation, undefined, submittedDraft, editAfterQuery)
                )}
                onDismiss={dismissOperation}
              />}
              <CodexOperationFeedbackList
                operations={visibleCodexOperations}
                onDismiss={dismissOperation}
                onCheckStatus={checkStatus}
                isConnected={isConnected}
              />
            </>
          )}
          isLoading={isProcessing}
          isCodexControlInput={isCodexControlInput}
          hasActiveCodexGoal={hasActiveCodexGoal}
          onAbortSession={handleAbortSession}
          canAbortSession={canAbortSession}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          onSelectPermissionMode={selectPermissionMode}
          providerLabel={selectedProviderLabel}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={handleSelectComposerEffort}
          model={currentProviderModel}
          availableModelOptions={currentProviderModelOptions}
          onSelectModel={handleSelectComposerModel}
          modelsLoading={providerModelsLoading}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          onClearContext={supportsContextClearing && (currentSessionId || selectedSession?.id) ? handleClearContextClick : undefined}
          isEditingSentMessage={Boolean(editingAnchorId)}
          onCancelEditMessage={cancelEditMessage}
          scheduledMessages={scheduledMessages}
          onScheduleMessage={handleScheduleMessage}
          onCancelScheduledMessage={cancelScheduledMessage}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          backgroundSendPrompt={backgroundSendPrompt}
          onResolveBackgroundSendPrompt={resolveBackgroundSendPrompt}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          onSendMenuChoice={handleSendMenuChoice}
          supportsSteering={canSteerCurrentTurn}
          codexSteerByDefault={provider === 'codex' && codexSteerByDefault}
          isCodex={provider === 'codex'}
          pendingSteers={pendingSteers}
          attachedFiles={attachedFiles}
          onRemoveAttachment={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
          supportsSideQuestions={supportsSideQuestions}
        />
        </div>
      </div>

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelActions={providerModelActions}
        activeProvider={provider}
        activeProviderModel={currentProviderModel}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
