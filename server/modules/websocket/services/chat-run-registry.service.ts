import { sessionsDb } from '@/modules/database/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { broadcastSessionUpserted } from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  ChatCodexOperation,
  ChatGoalStateEvent,
  ChatOperationStatusEvent,
  ChatSteerOutcome,
  CodexControlHooks,
  CodexControlResult,
  CodexGoal,
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

type ChatRunStatus = 'running' | 'completed';

type SteerReceipt = {
  outcome: ChatSteerOutcome;
};

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 */
type ChatRun = {
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  lastSeq: number;
  turnId: string | null;
  turnSettleConfirmed: boolean;
  steerReceipts: Map<string, SteerReceipt>;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();

// A chat view subscribed while idle also needs the next Codex turn's stream
// when the queue dispatcher starts the turn without a browser socket.
const codexSubscriptions = new Map<RealtimeClientConnection, Set<string>>();

type OperationReceipt = {
  event: ChatOperationStatusEvent;
  listeners: Set<RealtimeClientConnection>;
};

// Keep receipts for the lifetime of the server so retransmission cannot
// repeat a native write even after its run has left the replay cache.
const operationReceiptsBySession = new Map<string, Map<string, OperationReceipt>>();
const codexGoalStates = new Map<string, ChatGoalStateEvent>();
let goalRevision = Date.now();
const codexSendReceipts = new Map<string, { status: 'pending' | 'sent' | 'queued' }>();

function sendControlEvent(
  connection: RealtimeClientConnection,
  event: ChatOperationStatusEvent | ChatGoalStateEvent,
): void {
  if (connection.readyState !== WS_OPEN_STATE) return;
  try {
    connection.send(JSON.stringify(event));
  } catch (error) {
    // A disconnected audience cannot interrupt a native operation.
    console.error('[ChatRunRegistry] Failed to send Codex control event', { error });
  }
}

function publishOperationReceipt(
  receipt: OperationReceipt,
  outcome: CodexControlResult | { status: 'accepted' },
): void {
  receipt.event = { ...receipt.event, ...outcome, timestamp: new Date().toISOString() };
  for (const connection of receipt.listeners) sendControlEvent(connection, receipt.event);
  if (outcome.status !== 'accepted') receipt.listeners.clear();
}

function finishOperationSnapshot(
  appSessionId: string,
  initialRevision: number | undefined,
  goal: CodexGoal | null,
): number | undefined {
  const current = codexGoalStates.get(appSessionId);
  if (current?.revision !== initialRevision) return undefined;
  return chatRunRegistry.publishCodexGoal(appSessionId, goal);
}

// Receipts also survive the next turn replacing a run in the registry. The
// transcript provides delivery evidence after receipts expire or CloudCLI restarts.
const steerReceiptsBySession = new Map<string, Map<string, SteerReceipt>>();

function reserveSteer(sessionId: string, messageId: string): SteerReceipt {
  let receipts = steerReceiptsBySession.get(sessionId);
  if (!receipts) {
    receipts = new Map();
    steerReceiptsBySession.set(sessionId, receipts);
  }
  const receipt: SteerReceipt = { outcome: 'unknown' };
  receipts.set(messageId, receipt);
  return receipt;
}

function expireReceipt(sessionId: string, messageId: string, receipt: SteerReceipt): void {
  const timer = setTimeout(() => {
    const receipts = steerReceiptsBySession.get(sessionId);
    if (receipts?.get(messageId) !== receipt) return;
    receipts.delete(messageId);
    if (receipts.size === 0) steerReceiptsBySession.delete(sessionId);
  }, COMPLETED_RUN_RETENTION_MS);
  timer.unref?.();
}

function publishSteerOutcome(run: ChatRun, messageId: string, outcome: ChatSteerOutcome): void {
  run.writer.send(createNormalizedMessage({
    kind: 'chat_steer_status',
    provider: run.provider,
    messageId,
    outcome,
  }));
}

/**
 * Answers whether a completed run must stay registered a while longer. Set by
 * the composition root to the provider runtimes' background-work check: a
 * session whose turn ended but whose agents, workflows or commands are still
 * running keeps sending live events through this run's writer, and a tab that
 * subscribes meanwhile needs the run to attach to.
 */
let retainCompletedRun: (appSessionId: string) => boolean = () => false;

/**
 * Schedules one run's eviction. The timer is bound to the run it was armed
 * for: a later run can take the session's slot while this one's retention —
 * re-armed for as long as the guard holds — is still pending, and firing on
 * the slot alone would evict that newer run early.
 */
function evictRunLater(run: ChatRun): void {
  const timer = setTimeout(() => {
    if (runs.get(run.appSessionId) !== run || run.status !== 'completed') {
      return;
    }
    if (retainCompletedRun(run.appSessionId)) {
      evictRunLater(run);
      return;
    }
    runs.delete(run.appSessionId);
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }

  if (message.kind === 'turn_started' && message.turnId) {
    // The registry can outlive a socket, so subscriptions can recover the
    // native turn to steer even if they missed its start event.
    run.turnId = message.turnId;
  }

  if (message.kind === 'text' && message.role === 'user') {
    const receipt = run.steerReceipts.get(message.id);
    if (receipt) {
      if (receipt.outcome === 'delivered') return null;
      receipt.outcome = 'delivered';
    }
  }

  if (message.kind === 'complete') {
    run.turnSettleConfirmed = message.turnSettleConfirmed === true;
    for (const [messageId, receipt] of run.steerReceipts) {
      if (receipt.outcome === 'accepted') {
        receipt.outcome = run.turnSettleConfirmed ? 'unread' : 'unknown';
        publishSteerOutcome(run, messageId, receipt.outcome);
      }
      expireReceipt(run.appSessionId, messageId, receipt);
    }
    run.steerReceipts.clear();
  }

  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
    ...(run.turnId ? { turnId: run.turnId } : {}),
  };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    evictRunLater(run);
    notifyRunSettled(run.appSessionId);
  }

  run.events.push(outbound);
  if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
  }

  return outbound;
}

/**
 * Fired when a run reaches its terminal `complete` and the session goes idle.
 *
 * The queued-message dispatcher subscribes so a message the user queued during
 * a turn is sent as soon as that turn ends, instead of waiting for the next
 * poll. Listeners run on a microtask so a throwing subscriber cannot break the
 * event that settled the run.
 */
const settledListeners = new Set<(appSessionId: string) => void>();

export function onRunSettled(listener: (appSessionId: string) => void): () => void {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}

function notifyRunSettled(appSessionId: string): void {
  for (const listener of settledListeners) {
    queueMicrotask(() => {
      // Unsubscribed between the settle and this microtask: stay quiet.
      if (!settledListeners.has(listener)) {
        return;
      }
      try {
        listener(appSessionId);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ChatRunRegistry] run-settled listener failed', { error: message });
      }
    });
  }
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    persistProviderSessionId(run.appSessionId, providerSessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

function persistProviderSessionId(appSessionId: string, providerSessionId: string): void {
  sessionsDb.assignProviderSessionId(appSessionId, providerSessionId);
  announceProviderSessionMapping(appSessionId);
}

function announceProviderSessionMapping(appSessionId: string): void {
  void broadcastSessionUpserted(appSessionId).catch((error) => {
    console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
      appSessionId,
      error,
    });
  });
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /** Installs the check that keeps a completed run registered while its session still has background work. */
  setRetentionGuard(guard: (appSessionId: string) => boolean): void {
    retainCompletedRun = guard;
  },

  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    /**
     * The socket that asked for this run, or `null` for a detached turn
     * started by a queue or timer. Subscribed Codex viewers still receive
     * that turn, and later viewers can replay the writer's event buffer.
     */
    connection: RealtimeClientConnection | null;
    userId: string | number | null;
    /** Native identity is already available for an autonomous Codex turn. */
    turnId?: string;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running') {
      return null;
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      lastSeq: 0,
      turnId: input.turnId ?? null,
      turnSettleConfirmed: false,
      steerReceipts: new Map(),
      events: [],
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
    };

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
    });
    if (input.provider === 'codex') {
      for (const [connection, sessions] of codexSubscriptions) {
        if (sessions.has(input.appSessionId)) run.writer.updateWebSocket(connection);
      }
    }

    runs.set(input.appSessionId, run);
    return run;
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  /** Tracks the Codex sessions viewed by a socket across idle and active turns. */
  setCodexSubscriptions(connection: RealtimeClientConnection, sessions: Set<string>): void {
    if (sessions.size > 0) codexSubscriptions.set(connection, sessions);
    else codexSubscriptions.delete(connection);
  },

  /** Drops a closed socket from future Codex turns without affecting running tasks. */
  removeCodexSubscriptions(connection: RealtimeClientConnection): void {
    codexSubscriptions.delete(connection);
  },

  /** Sends the request's latest receipt to a socket reconnecting or retrying it. */
  sendCodexOperationStatus(
    appSessionId: string,
    requestId: string,
    connection: RealtimeClientConnection,
  ): boolean {
    const receipt = operationReceiptsBySession.get(appSessionId)?.get(requestId);
    if (!receipt) return false;
    if (receipt.event.status === 'pending' || receipt.event.status === 'accepted') {
      for (const listener of receipt.listeners) {
        if (listener.readyState !== WS_OPEN_STATE) receipt.listeners.delete(listener);
      }
      receipt.listeners.add(connection);
    }
    sendControlEvent(connection, receipt.event);
    return true;
  },

  /**
   * Reserves the request id before the first provider call. A duplicate
   * receives the current receipt and joins the original request's audience.
   */
  async runCodexOperation(input: {
    appSessionId: string;
    requestId: string;
    operation: ChatCodexOperation['kind'];
    connection: RealtimeClientConnection;
    execute: (onAccepted: () => void) => CodexControlResult | Promise<CodexControlResult>;
  }): Promise<void> {
    const { appSessionId, requestId, operation, connection } = input;
    if (this.sendCodexOperationStatus(appSessionId, requestId, connection)) return;

    let receipts = operationReceiptsBySession.get(appSessionId);
    if (!receipts) {
      receipts = new Map();
      operationReceiptsBySession.set(appSessionId, receipts);
    }
    const receipt: OperationReceipt = {
      event: {
        kind: 'chat_operation_status',
        sessionId: appSessionId,
        requestId,
        operation,
        status: 'pending',
        timestamp: new Date().toISOString(),
      },
      listeners: new Set([connection]),
    };
    receipts.set(requestId, receipt);

    let outcome: CodexControlResult;
    try {
      outcome = await input.execute(() => {
        if (receipt.event.status === 'pending') publishOperationReceipt(receipt, { status: 'accepted' });
      });
    } catch (error) {
      outcome = {
        status: 'failed',
        code: 'CODEX_NATIVE_ERROR',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    publishOperationReceipt(receipt, outcome);
  },

  /** Caches and broadcasts a goal notification independently of turn events. */
  publishCodexGoal(appSessionId: string, goal: CodexGoal | null): number {
    const event: ChatGoalStateEvent = {
      kind: 'chat_goal_state',
      sessionId: appSessionId,
      goal,
      revision: ++goalRevision,
      timestamp: new Date().toISOString(),
    };
    codexGoalStates.set(appSessionId, event);
    for (const [connection, sessions] of codexSubscriptions) {
      if (sessions.has(appSessionId)) sendControlEvent(connection, event);
    }
    return event.revision;
  },

  /** Replays the latest goal state to a subscriber and returns its revision. */
  sendCodexGoalState(appSessionId: string, connection: RealtimeClientConnection): number | undefined {
    const event = codexGoalStates.get(appSessionId);
    if (event) sendControlEvent(connection, event);
    return event?.revision;
  },

  /** Reads the snapshot cursor before an asynchronous native query. */
  getCodexGoalRevision(appSessionId: string): number | undefined {
    return codexGoalStates.get(appSessionId)?.revision;
  },

  /** Includes the requesting tab before a control can immediately start a native turn. */
  addCodexSubscription(connection: RealtimeClientConnection, appSessionId: string): void {
    const sessions = codexSubscriptions.get(connection) ?? new Set<string>();
    sessions.add(appSessionId);
    codexSubscriptions.set(connection, sessions);
    const run = runs.get(appSessionId);
    if (run?.provider === 'codex' && run.status === 'running') run.writer.updateWebSocket(connection);
  },

  /**
   * Deduplicates direct retries while native admission or queue fallback is
   * unsettled, and retains the outcome through the normal reconnect window.
   */
  reserveCodexSend(appSessionId: string, messageId: string): {
    prior?: 'pending' | 'sent' | 'queued';
    finish(status?: 'sent' | 'queued'): void;
  } {
    const key = JSON.stringify([appSessionId, messageId]);
    const prior = codexSendReceipts.get(key);
    if (prior) return { prior: prior.status, finish: () => {} };
    const receipt: { status: 'pending' | 'sent' | 'queued' } = { status: 'pending' };
    codexSendReceipts.set(key, receipt);
    return {
      finish(status) {
        if (receipt.status !== 'pending' || codexSendReceipts.get(key) !== receipt) return;
        if (!status) {
          codexSendReceipts.delete(key);
          return;
        }
        receipt.status = status;
        const timer = setTimeout(() => {
          if (codexSendReceipts.get(key) === receipt) codexSendReceipts.delete(key);
        }, COMPLETED_RUN_RETENTION_MS);
        timer.unref?.();
      },
    };
  },

  /** Rechecks persisted queued work after a provider operation leaves the session idle. */
  notifySessionMayBeIdle: notifyRunSettled,

  /** Publishes a native read or mutation result unless a live update already superseded it. */
  finishCodexGoalSnapshot: finishOperationSnapshot,

  /** Session-scoped bridge for ordinary turns, manual compaction and autonomous goal turns. */
  createCodexHooks(input: {
    appSessionId: string;
    userId: string | number | null;
    onAccepted?: () => void;
  }): CodexControlHooks {
    const { appSessionId } = input;
    return {
      bindThread(threadId) {
        if (sessionsDb.getSessionById(appSessionId)?.provider_session_id !== threadId) {
          persistProviderSessionId(appSessionId, threadId);
        }
      },
      discardUnmaterializedThread(threadId) {
        const session = sessionsDb.getSessionById(appSessionId);
        if (session?.provider_session_id !== threadId || session.jsonl_path) return;
        sessionsDb.detachProviderSession(appSessionId);
        announceProviderSessionMapping(appSessionId);
      },
      isTurnRunning: () => this.isProcessing(appSessionId),
      startTurn: (threadId, turnId) => {
        const current = runs.get(appSessionId);
        if (current?.status === 'running') {
          if (current.turnId === turnId) return current.writer;
          if (current.turnId) return null;
          // The app reserved a send, but a native turn started before Codex
          // accepted it. Its dispatch learns this through CODEX_TURN_BUSY.
          runs.delete(appSessionId);
        }
        return this.startRun({
          appSessionId,
          provider: 'codex',
          providerSessionId: threadId,
          turnId,
          connection: null,
          userId: input.userId,
        })?.writer ?? null;
      },
      publishGoal: (goal) => this.publishCodexGoal(appSessionId, goal),
      onAccepted: input.onAccepted ?? (() => {}),
      onIdle: () => notifyRunSettled(appSessionId),
    };
  },

  getSteerOutcome(appSessionId: string, messageId: string): ChatSteerOutcome | undefined {
    return steerReceiptsBySession.get(appSessionId)?.get(messageId)?.outcome;
  },

  /**
   * Reserves the id before invoking the provider to deduplicate concurrent
   * requests, and publishes its outcome to sockets attached during the RPC.
   * The gateway supplies a validated message id and the browser's target turn.
   */
  async steerCodex(input: {
    appSessionId: string;
    turnId: string;
    messageId: string;
    connection: RealtimeClientConnection;
    deliver: () => Promise<boolean>;
  }): Promise<ChatSteerOutcome | undefined> {
    const { appSessionId, turnId, messageId } = input;
    const existing = steerReceiptsBySession.get(appSessionId)?.get(messageId);
    if (existing) return existing.outcome;

    const receipt = reserveSteer(appSessionId, messageId);
    const run = runs.get(appSessionId);
    if (run?.status !== 'running' || run.provider !== 'codex' || run.turnId !== turnId) {
      receipt.outcome = 'refused';
      expireReceipt(appSessionId, messageId, receipt);
      return receipt.outcome;
    }

    run.steerReceipts.set(messageId, receipt);
    run.writer.updateWebSocket(input.connection);
    let outcome: ChatSteerOutcome;
    try {
      const accepted = await input.deliver();
      outcome = accepted ? 'accepted' : 'refused';
      if (accepted && run.completedAt !== null) {
        outcome = run.turnSettleConfirmed ? 'unread' : 'unknown';
      }
    } catch {
      // A transport failure could have happened after the provider queued it.
      outcome = 'unknown';
    }

    // The echo may have happened before the RPC response, including when the
    // response was lost. Never downgrade a delivered message.
    if (receipt.outcome !== 'delivered') {
      receipt.outcome = outcome;
      publishSteerOutcome(run, messageId, outcome);
    }
    return undefined;
  },

  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
      }));
  },

  /**
   * Adds a websocket connection to a run's live audience.
   *
   * This is the generic replacement for the Claude-only writer reconnect:
   * after a page refresh the new socket subscribes and immediately starts
   * receiving the still-running stream, for every provider.
   *
   * Subscribing does not take the stream away from sockets that were already
   * watching — a session open in two places stays live in both, and the
   * refreshed tab's abandoned socket is dropped when the next event finds it
   * closed. Replay stays per-connection because each client sends its own
   * `lastSeq` with `chat.subscribe`.
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }

    run.writer.updateWebSocket(connection);
    return true;
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Test-only escape hatch: clears every tracked run.
   */
  clearAll(): void {
    runs.clear();
    steerReceiptsBySession.clear();
    codexSubscriptions.clear();
    operationReceiptsBySession.clear();
    codexGoalStates.clear();
    codexSendReceipts.clear();
  },
};
