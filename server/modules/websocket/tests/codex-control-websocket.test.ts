import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { closeScheduledMessageDispatcher, initializeScheduledMessageDispatcher } from '@/modules/scheduled-messages/index.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import { handleChatConnection, type ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import type { AnyRecord, CodexControlHooks, CodexControlResult, CodexGoal } from '@/shared/types.js';
import { AppError, createNormalizedMessage } from '@/shared/utils.js';

const SESSION_ID = 'app-codex-control';
const NATIVE_THREAD = 'native-codex-control';
const REQUEST_ID = 'control-request-1';
const MESSAGE_ID = '02b7a35c-920b-4765-aca3-ddb95aa95295';

class ChatSocket extends EventEmitter {
  readyState = 1;
  frames: AnyRecord[] = [];

  send(payload: string): void {
    this.frames.push(JSON.parse(payload));
  }

  frame(payload: AnyRecord): void {
    this.emit('message', JSON.stringify(payload));
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  receipts(): AnyRecord[] {
    return this.frames.filter((frame) => frame.kind === 'chat_operation_status');
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function createRuntime(overrides: Partial<ProviderRuntimeGateway>): ProviderRuntimeGateway {
  return {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    getPendingApprovalsForSession: () => [],
    run: async () => {},
    abort: async () => false,
    stopBackgroundTask: async () => false,
    steer: async () => false,
    resolveToolApproval: () => {},
    askSideQuestion: async () => ({ status: 'error', error: 'Unsupported in this fixture.', answer: '' }),
    ...overrides,
  };
}

async function withGateway(run: (context: {
  userId: number;
  workingDirectory: string;
  connect(overrides?: Partial<ProviderRuntimeGateway>): ChatSocket;
}) => Promise<void>): Promise<void> {
  const previousPath = process.env.DATABASE_PATH;
  const workingDirectory = await mkdtemp(path.join(tmpdir(), 'codex-control-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(workingDirectory, 'auth.db');

  try {
    await initializeDatabase();
    const { id: userId } = userDb.createUser('a-user', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'codex', workingDirectory);
    sessionsDb.createAppSession('other-provider', 'claude', workingDirectory);
    const connect = (overrides: Partial<ProviderRuntimeGateway> = {}) => {
      const socket = new ChatSocket();
      handleChatConnection(socket as never, { user: { id: userId } } as never, { runtime: createRuntime(overrides) });
      return socket;
    };
    await run({ userId: Number(userId), workingDirectory, connect });
  } finally {
    closeScheduledMessageDispatcher();
    chatRunRegistry.clearAll();
    connectedClients.clear();
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

test('compaction retries replay pending, accepted and completed receipts without a second native call', async () => {
  await withGateway(async ({ connect }) => {
    let accept!: () => void;
    let resolve!: (result: CodexControlResult) => void;
    let nativeCalls = 0;
    const runtime: Partial<ProviderRuntimeGateway> = {
      controlCodex: (_sessionId, _options, operation, hooks) => {
        assert.deepEqual(operation, { kind: 'compact' });
        nativeCalls += 1;
        accept = hooks.onAccepted;
        return new Promise((done) => { resolve = done; });
      },
    };
    const initialTab = connect(runtime);
    const command = { type: 'chat.compact', sessionId: SESSION_ID, requestId: REQUEST_ID };
    initialTab.frame(command);
    initialTab.frame(command);
    assert.deepEqual(initialTab.receipts().map((receipt) => receipt.status), ['pending']);

    initialTab.close();
    accept();
    const reconnect = connect(runtime);
    reconnect.frame(command);
    assert.equal(reconnect.receipts().at(-1)?.status, 'accepted');
    resolve({ status: 'completed' });
    await settle();
    assert.equal(reconnect.receipts().at(-1)?.status, 'completed');
    reconnect.frame(command);
    assert.equal(reconnect.receipts().at(-1)?.status, 'completed');
    assert.equal(nativeCalls, 1);

    chatRunRegistry.clearAll();
    reconnect.frame({ type: 'chat.operation.status', sessionId: SESSION_ID, requestId: REQUEST_ID });
    assert.equal(reconnect.receipts().at(-1)?.status, 'unknown');
    assert.equal(nativeCalls, 1, 'operation status after restart is a lookup only');
  });
});

test('invalid control parameters and provider are rejected without interrupting the current run', async () => {
  await withGateway(async ({ connect }) => {
    const tab = connect({
      controlCodex: async () => assert.fail('invalid operation reached Codex'),
    });
    const run = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'codex',
      providerSessionId: NATIVE_THREAD,
      turnId: 'a',
      connection: tab,
      userId: 1,
    });
    assert.ok(run);

    tab.frame({ type: 'chat.compact', sessionId: SESSION_ID, requestId: 'args', objective: 'extra' });
    tab.frame({ type: 'chat.goal', sessionId: SESSION_ID, requestId: 'action', action: 'unknown' });
    tab.frame({ type: 'chat.goal', sessionId: SESSION_ID, requestId: 'blank', action: 'set', objective: ' \n ' });
    tab.frame({ type: 'chat.goal', sessionId: 'other-provider', requestId: 'provider', action: 'pause' });
    await settle();
    assert.deepEqual(tab.receipts().map(({ code }) => code), [
      'INVALID_CONTROL_REQUEST', 'INVALID_CONTROL_REQUEST', 'INVALID_CONTROL_REQUEST', 'UNSUPPORTED_PROVIDER',
    ]);
    assert.ok(tab.frames.every(({ kind }) => kind !== 'protocol_error' && kind !== 'complete'));

    run.writer.send(createNormalizedMessage({ kind: 'text', provider: 'codex', content: 'still running' }));
    assert.equal(tab.frames.at(-1)?.content, 'still running');
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);
  });
});

test('goal-first creation forwards raw objectives, binds the native thread and broadcasts turns and state', async () => {
  await withGateway(async ({ connect, workingDirectory }) => {
    const objective = 'First step\n\n  Second step  ';
    const goal: CodexGoal = {
      threadId: NATIVE_THREAD, objective, status: 'active', tokenBudget: null,
      tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
    };
    let calls = 0;
    const tab = connect({
      run: async () => assert.fail('goal creation must not start an application turn'),
      controlCodex: async (id, options, operation, hooks) => {
        calls += 1;
        assert.equal(id, SESSION_ID);
        assert.deepEqual(operation, { kind: 'goal', action: 'set', objective });
        assert.equal(options.cwd, workingDirectory);
        assert.equal(options.providerSessionId, null);
        assert.equal(options.model, 'gpt-6.2-sol');
        assert.equal(options.effort, 'high');
        assert.equal(options.permissionMode, 'acceptEdits');
        hooks.bindThread(NATIVE_THREAD);
        assert.equal(sessionsDb.getSessionById(SESSION_ID)?.provider_session_id, NATIVE_THREAD);
        hooks.onAccepted();
        hooks.publishGoal(goal);
        const writer = hooks.startTurn(NATIVE_THREAD, 'a');
        assert.ok(writer);
        writer.send(createNormalizedMessage({ kind: 'turn_started', provider: 'codex', turnId: 'a' }));
        writer.send(createNormalizedMessage({ kind: 'text', provider: 'codex', content: 'goal is underway' }));
        return { status: 'completed', goal };
      },
    });
    tab.frame({
      type: 'chat.goal', sessionId: SESSION_ID, requestId: REQUEST_ID, action: 'set', objective,
      options: { cwd: '/wrong-directory', model: 'gpt-6.2-sol', effort: 'high', permissionMode: 'acceptEdits' },
    });
    await settle();
    assert.equal(calls, 1);
    assert.deepEqual(tab.receipts().map(({ status }) => status), ['accepted', 'completed']);
    assert.ok(tab.frames.some(({ kind, goal: state }) => kind === 'chat_goal_state' && state.objective === objective));
    assert.ok(tab.frames.some(({ kind, turnId, content }) => kind === 'text' && turnId === 'a' && content === 'goal is underway'));
  });
});

test('a late goal snapshot cannot overwrite a newer live goal across tabs', async () => {
  await withGateway(async ({ connect }) => {
    const activeGoal: CodexGoal = {
      threadId: NATIVE_THREAD, objective: 'work', status: 'active', tokenBudget: 100,
      tokensUsed: 10, timeUsedSeconds: 1, createdAt: 1, updatedAt: 1,
    };
    const pausedGoal = { ...activeGoal, status: 'paused' as const, updatedAt: 2 };
    let finishRead!: (result: CodexControlResult) => void;
    const runtime: Partial<ProviderRuntimeGateway> = {
      controlCodex: async (_sessionId, _options, operation, hooks) => {
        assert.equal(operation.kind, 'goal');
        if (operation.action === 'get') return new Promise((done) => { finishRead = done; });
        assert.equal(operation.action, 'pause');
        hooks.publishGoal(pausedGoal);
        return { status: 'completed', goal: pausedGoal };
      },
    };
    const first = connect(runtime);
    const second = connect(runtime);
    for (const tab of [first, second]) {
      tab.frame({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID }] });
      assert.equal(tab.frames[0].kind, 'chat_subscribed');
    }
    await settle();
    first.frame({ type: 'chat.goal', sessionId: SESSION_ID, requestId: REQUEST_ID, action: 'pause' });
    await settle();
    finishRead({ status: 'completed', goal: activeGoal });
    await settle();
    for (const tab of [first, second]) {
      const goals = tab.frames.filter(({ kind }) => kind === 'chat_goal_state');
      assert.deepEqual(goals.map(({ goal }) => goal.status), ['paused']);
    }
  });
});

test('a direct send that loses to a native turn is queued once and sent after it settles', async () => {
  await withGateway(async ({ connect, userId }) => {
    const commands: string[] = [];
    const runtime = createRuntime({
      run: async (_provider, command) => { commands.push(command); },
    });
    const tab = connect(runtime);
    const run = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'codex',
      providerSessionId: NATIVE_THREAD,
      turnId: 'native-continuation',
      connection: null,
      userId,
    });
    assert.ok(run);
    initializeScheduledMessageDispatcher(runtime);

    const command = { type: 'chat.send', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'send after B' };
    tab.frame(command);
    tab.frame(command);
    await settle();
    assert.deepEqual(commands, []);
    const [candidate] = sessionDraftsDb.listQueuedMessages(SESSION_ID);
    assert.equal((candidate?.queuedMessage as AnyRecord | undefined)?.content, 'send after B');
    assert.ok(tab.frames.some(({ kind, messageId }) => kind === 'chat_send_queued' && messageId === MESSAGE_ID));

    tab.frame(command);
    chatRunRegistry.completeRun(SESSION_ID, { exitCode: 0 });
    await settle();
    tab.frame(command);
    await settle();
    assert.deepEqual(commands, ['send after B']);
    assert.deepEqual(sessionDraftsDb.listQueuedMessages(SESSION_ID), []);
  });
});

test('a native turn that starts during send admission keeps the claimed user input queued', async () => {
  await withGateway(async ({ connect, userId }) => {
    const nativeSends: string[] = [];
    let admissionAttempts = 0;
    const runtime = createRuntime({
      run: async (_provider, command, options) => {
        admissionAttempts += 1;
        if (admissionAttempts === 1) {
          const hooks = options.codexHooks as CodexControlHooks;
          const writer = hooks.startTurn(NATIVE_THREAD, 'native-while-admitting');
          assert.ok(writer);
          writer.send(createNormalizedMessage({
            kind: 'turn_started', provider: 'codex', turnId: 'native-while-admitting',
          }));
          throw new AppError('A native turn started first.', { code: 'CODEX_TURN_BUSY' });
        }
        nativeSends.push(command);
      },
    });
    const tab = connect(runtime);
    initializeScheduledMessageDispatcher(runtime);
    const command = { type: 'chat.send', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'wait for native turn' };
    tab.frame(command);
    tab.frame(command);
    await settle();
    assert.equal(admissionAttempts, 1);
    assert.deepEqual(nativeSends, []);
    assert.ok(sessionDraftsDb.listQueuedMessages(SESSION_ID).some((candidate) => candidate.userId === userId));
    const result = tab.frames.find(({ kind }) => kind === 'chat_send_queued');
    assert.equal(result?.turnId, 'native-while-admitting');
    assert.equal(tab.frames.filter(({ kind }) => kind === 'complete').length, 0);

    chatRunRegistry.completeRun(SESSION_ID, { exitCode: 0 });
    await settle();
    assert.equal(admissionAttempts, 2);
    assert.deepEqual(nativeSends, ['wait for native turn']);
    assert.deepEqual(sessionDraftsDb.listQueuedMessages(SESSION_ID), []);
  });
});

test('an abort for a completed Codex turn cannot interrupt its native continuation', async () => {
  await withGateway(async ({ connect, userId }) => {
    const interrupts: (string | undefined)[] = [];
    const tab = connect({
      abort: async (_provider, _sessionId, expectedTurnId) => {
        interrupts.push(expectedTurnId);
        return true;
      },
    });
    const hooks = chatRunRegistry.createCodexHooks({ appSessionId: SESSION_ID, userId });
    assert.ok(hooks.startTurn(NATIVE_THREAD, 'a'));
    chatRunRegistry.completeRun(SESSION_ID, { exitCode: 0 });
    assert.ok(hooks.startTurn(NATIVE_THREAD, 'b'));

    tab.frame({ type: 'chat.abort', sessionId: SESSION_ID, expectedTurnId: 'a' });
    await settle();
    assert.deepEqual(interrupts, []);
    assert.equal(tab.frames.at(-1)?.code, 'STALE_TURN');
    assert.equal(chatRunRegistry.getRun(SESSION_ID)?.turnId, 'b');

    tab.frame({ type: 'chat.abort', sessionId: SESSION_ID, expectedTurnId: 'b' });
    await settle();
    assert.deepEqual(interrupts, ['b']);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  });
});
