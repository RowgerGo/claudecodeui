import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import { handleChatConnection, type ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import type { AnyRecord, CodexControlResult } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

const SESSION_ID = 'app-codex-control';
const NATIVE_THREAD = 'native-codex-control';
const REQUEST_ID = 'control-request-1';

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
