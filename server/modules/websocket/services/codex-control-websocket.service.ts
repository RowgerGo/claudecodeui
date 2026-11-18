import { sessionsDb } from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import type {
  AnyRecord,
  ChatCodexOperation,
  ChatOperationStatusEvent,
  CodexControlResult,
  CodexGoal,
  CodexGoalStatus,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

import { chatRunRegistry } from './chat-run-registry.service.js';
import type { ProviderRuntimeGateway } from './chat-websocket.service.js';
import { WS_OPEN_STATE } from './websocket-state.service.js';

const GOAL_STATUSES = new Set<CodexGoalStatus>(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
const MAX_GOAL_LENGTH = 100_000;
const MAX_PENDING_OPERATION_IDS = 100;
const snapshotReads = new Map<string, Promise<void>>();

function readRequestId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value
    ? value
    : null;
}

function readGoal(value: unknown): CodexGoal | null {
  const goal = readObjectRecord(value);
  if (
    !goal
    || typeof goal.threadId !== 'string' || !goal.threadId
    || typeof goal.objective !== 'string' || !goal.objective.trim() || goal.objective.length > MAX_GOAL_LENGTH
    || !GOAL_STATUSES.has(goal.status)
    || (goal.tokenBudget !== null && !Number.isSafeInteger(goal.tokenBudget))
    || !Number.isSafeInteger(goal.tokensUsed)
    || !Number.isSafeInteger(goal.timeUsedSeconds)
    || !Number.isSafeInteger(goal.createdAt)
    || !Number.isSafeInteger(goal.updatedAt)
  ) return null;

  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

function readOperation(data: AnyRecord, operation: ChatCodexOperation['kind']): ChatCodexOperation | null {
  const allowed = ['type', 'sessionId', 'requestId'];
  if (operation === 'goal') allowed.push('action', 'objective', 'expectedGoal', 'options');
  if (Object.keys(data).some((key) => !allowed.includes(key))) return null;
  if (operation === 'compact') return { kind: operation };

  const action = data.action;
  switch (action) {
    case 'get':
    case 'pause':
    case 'resume':
    case 'clear':
      return data.objective === undefined && data.expectedGoal === undefined
        ? { kind: 'goal', action }
        : null;
    case 'set':
    case 'edit':
    case 'replace': {
      const objective = data.objective;
      if (typeof objective !== 'string' || !objective.trim() || objective.length > MAX_GOAL_LENGTH) return null;
      if (action === 'set') {
        return data.expectedGoal === undefined ? { kind: 'goal', action, objective } : null;
      }
      const expectedGoal = readGoal(data.expectedGoal);
      if (action === 'replace') {
        return expectedGoal ? { kind: 'goal', action, objective, expectedGoal } : null;
      }
      return data.expectedGoal === undefined || expectedGoal
        ? { kind: 'goal', action, objective, expectedGoal: expectedGoal ?? undefined }
        : null;
    }
    default:
      return null;
  }
}

function sendStatus(connection: RealtimeClientConnection, event: ChatOperationStatusEvent): void {
  if (connection.readyState === WS_OPEN_STATE) connection.send(JSON.stringify(event));
}

function runtimeOptions(
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  options?: AnyRecord | null,
): AnyRecord {
  return {
    sessionId: session.session_id,
    cwd: session.project_path ?? undefined,
    projectPath: session.project_path ?? undefined,
    providerSessionId: session.provider_session_id,
    model: typeof options?.model === 'string' && options.model.trim() ? options.model : session.model ?? undefined,
    effort: typeof options?.effort === 'string' && options.effort.trim() ? options.effort : session.effort ?? undefined,
    permissionMode: typeof options?.permissionMode === 'string' ? options.permissionMode : undefined,
    sessionSummary: typeof options?.sessionSummary === 'string' ? options.sessionSummary : undefined,
  };
}

/**
 * Dispatches validated chat.compact/chat.goal frames from the chat gateway.
 * Refusals and provider results use the same request-scoped receipt.
 */
export async function handleCodexControl(
  connection: RealtimeClientConnection,
  userId: string | number | null,
  data: AnyRecord,
  runtime: ProviderRuntimeGateway,
  kind: ChatCodexOperation['kind'],
): Promise<void> {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  const requestId = readRequestId(data.requestId);
  if (!sessionId || !requestId) {
    sendStatus(connection, {
      kind: 'chat_operation_status',
      sessionId,
      requestId: requestId ?? '',
      operation: kind,
      status: 'rejected',
      code: 'INVALID_CONTROL_REQUEST',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  await chatRunRegistry.runCodexOperation({
    appSessionId: sessionId,
    requestId,
    operation: kind,
    connection,
    async execute(onAccepted): Promise<CodexControlResult & { goalRevision?: number }> {
      const operation = readOperation(data, kind);
      const clientOptions = readObjectRecord(data.options);
      if (!operation || (data.options !== undefined && !clientOptions)) {
        return { status: 'rejected', code: 'INVALID_CONTROL_REQUEST' };
      }
      const session = sessionsDb.getSessionById(sessionId);
      if (!session) return { status: 'rejected', code: 'SESSION_NOT_FOUND' };
      if (session.provider !== 'codex' || !runtime.hasRuntime('codex') || !runtime.controlCodex) {
        return { status: 'rejected', code: 'UNSUPPORTED_PROVIDER' };
      }

      const options = runtimeOptions(session, clientOptions);
      if (operation.kind === 'goal' && operation.action === 'set' && !session.provider_session_id) {
        if (options.model) providerModelsService.setSessionModel('codex', sessionId, options.model);
        if (options.effort) providerModelsService.setSessionEffort('codex', sessionId, options.effort);
      }

      chatRunRegistry.addCodexSubscription(connection, sessionId);
      const revision = chatRunRegistry.getCodexGoalRevision(sessionId);
      const hooks = chatRunRegistry.createCodexHooks({ appSessionId: sessionId, userId, onAccepted });
      const result = await runtime.controlCodex(sessionId, options, operation, hooks);
      if (result.goal === undefined) return result;
      const goalRevision = chatRunRegistry.finishCodexGoalSnapshot(sessionId, revision, result.goal);
      return { ...result, goalRevision };
    },
  });
}

/**
 * Reconciles a single chat.operation.status request or a subscribe receipt.
 * A missing receipt is reported as unknown and never executes a provider call.
 */
export function sendCodexOperationStatus(
  connection: RealtimeClientConnection,
  sessionId: unknown,
  requestId: unknown,
): void {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return;
  const id = readRequestId(requestId);
  if (!id || chatRunRegistry.sendCodexOperationStatus(sessionId.trim(), id, connection)) return;
  sendStatus(connection, {
    kind: 'chat_operation_status',
    sessionId: sessionId.trim(),
    requestId: id,
    status: 'unknown',
    timestamp: new Date().toISOString(),
  });
}

/** Returns requested operation receipts after the chat gateway acknowledges a subscription. */
export function replayCodexOperationStatuses(
  connection: RealtimeClientConnection,
  sessionId: string,
  pendingIds: unknown,
): void {
  if (!Array.isArray(pendingIds)) return;
  for (const id of new Set(pendingIds.slice(0, MAX_PENDING_OPERATION_IDS))) {
    sendCodexOperationStatus(connection, sessionId, id);
  }
}

/**
 * Recovers a subscription's goal snapshot on the chat gateway. A live update
 * received during the native read takes precedence over the read response.
 */
export function subscribeCodexGoal(
  connection: RealtimeClientConnection,
  sessionId: string,
  runtime: ProviderRuntimeGateway,
): void {
  const revision = chatRunRegistry.sendCodexGoalState(sessionId, connection);
  if (revision !== undefined || snapshotReads.has(sessionId) || !runtime.controlCodex) return;

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) return;
  const hooks = chatRunRegistry.createCodexHooks({ appSessionId: sessionId, userId: null });
  const { controlCodex } = runtime;
  const request = Promise.resolve()
    .then(() => controlCodex.call(runtime, sessionId, runtimeOptions(session), { kind: 'goal', action: 'get' }, hooks))
    .then((result) => {
      if (result.status === 'completed' && result.goal !== undefined) {
        chatRunRegistry.finishCodexGoalSnapshot(sessionId, revision, result.goal);
      }
    })
    .catch((error: unknown) => {
      console.error('[Chat] Failed to restore Codex goal', { sessionId, error });
    })
    .finally(() => {
      snapshotReads.delete(sessionId);
    });
  snapshotReads.set(sessionId, request);
}
