import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord } from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

const SESSION_ID = 'steer-session';
const MESSAGE_ID = '0b5c3f8e-6d1a-4c2b-9e7f-1a2b3c4d5e6f';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

type SteerCall = { provider: string; sessionId: string; command: string; options: AnyRecord };

/**
 * A gateway whose runtime accepts or refuses every steer as `accepts` says.
 * `running` decides whether the session has a chat run in progress.
 */
async function withGateway(
  { accepts, running, provider = 'claude' }: {
    accepts: boolean | (() => Promise<boolean>);
    running: boolean;
    provider?: 'claude' | 'codex';
  },
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    steers: SteerCall[];
    connect: () => ReturnType<typeof createFakeSocket>;
    startRun: (turnId: string) => NonNullable<ReturnType<typeof chatRunRegistry.startRun>>;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-steer-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const steers: SteerCall[] = [];

  try {
    sessionsDb.createAppSession(SESSION_ID, provider, tempDirectory);
    const connect = () => {
      const socket = createFakeSocket();
      handleChatConnection(
        socket as never,
        { user: { id: 1 } } as never,
        {
          runtime: {
            hasRuntime: () => true,
            hasBackgroundWork: () => false,
            getPendingApprovalsForSession: () => [],
            steer: async (provider: string, sessionId: string, command: string, options: AnyRecord) => {
              steers.push({ provider, sessionId, command, options });
              return typeof accepts === 'function' ? accepts() : accepts;
            },
          } as never,
        },
      );
      return socket;
    };
    const socket = connect();
    const startRun = (turnId: string) => {
      const run = chatRunRegistry.startRun({
        appSessionId: SESSION_ID,
        provider,
        providerSessionId: null,
        connection: null,
        userId: 1,
      });
      assert.ok(run);
      if (provider === 'codex') {
        run.writer.send(createNormalizedMessage({ kind: 'turn_started', provider, turnId }));
      }
      return run;
    };
    if (running) {
      startRun('turn-a');
    }

    await runTest({ socket, steers, connect, startRun });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('chat.steer hands the message to the session\'s provider runtime', async () => {
  await withGateway({ accepts: true, running: true }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.steer',
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      content: 'change course',
    }));
    await settle();

    assert.equal(steers.length, 1);
    // The provider comes from the session row, never from the frame.
    assert.equal(steers[0].provider, 'claude');
    assert.equal(steers[0].sessionId, SESSION_ID);
    assert.equal(steers[0].command, 'change course');
    assert.equal(steers[0].options.messageId, MESSAGE_ID);
    assert.deepEqual(steers[0].options.images, []);
    assert.deepEqual(steers[0].options.files, []);
    // The sender learns it was taken; the echo comes later on the run stream.
    assert.equal(socket.frames.length, 1);
    assert.equal(socket.frames[0].kind, 'chat_steer_accepted');
    assert.equal(socket.frames[0].messageId, MESSAGE_ID);
    assert.equal(socket.frames[0].sessionId, SESSION_ID);
  });
});

test('a steer with no running turn is refused with STEER_UNAVAILABLE, naming the message', async () => {
  await withGateway({ accepts: true, running: false }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'hi' }));
    await settle();

    assert.equal(steers.length, 0, 'never reaches the runtime');
    assert.equal(socket.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
    assert.equal(socket.frames.at(-1)?.messageId, MESSAGE_ID);
    assert.equal(socket.frames.at(-1)?.sessionId, SESSION_ID);
  });
});

test('a steer the runtime refuses (the turn just ended) is reported the same way', async () => {
  await withGateway({ accepts: false, running: true }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: 'hi' }));
    await settle();

    assert.equal(steers.length, 1);
    assert.equal(socket.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
    assert.equal(socket.frames.at(-1)?.messageId, MESSAGE_ID);
  });
});

test('a message id that is not a UUID is replaced, since it becomes the transcript uuid', async () => {
  await withGateway({ accepts: true, running: true }, async ({ steers, socket }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: '../etc', content: 'hi' }));
    await settle();

    assert.equal(steers.length, 1);
    assert.match(String(steers[0].options.messageId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

test('an empty steer is refused before it reaches the runtime', async () => {
  await withGateway({ accepts: true, running: true }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: MESSAGE_ID, content: '   ' }));
    await settle();

    assert.equal(steers.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'MESSAGE_REQUIRED');
  });
});

function sendCodexSteer(socket: ReturnType<typeof createFakeSocket>, expectedTurnId = 'turn-a') {
  socket.emit('message', JSON.stringify({
    type: 'chat.steer',
    sessionId: SESSION_ID,
    messageId: MESSAGE_ID,
    expectedTurnId,
    content: 'change course',
  }));
}

function resumeCodexTurn(socket: ReturnType<typeof createFakeSocket>, lastTurnId: string, lastSeq: number) {
  socket.emit('message', JSON.stringify({
    type: 'chat.subscribe',
    sessions: [{ sessionId: SESSION_ID, lastTurnId, lastSeq, pendingSteerIds: [MESSAGE_ID] }],
  }));
}

test('a Codex steer is scoped to the observed turn and deduplicated through disconnect and replay', async () => {
  let resolveSteer!: (value: boolean) => void;
  const accepts = () => new Promise<boolean>((resolve) => { resolveSteer = resolve; });
  await withGateway({ accepts, running: true, provider: 'codex' }, async ({ socket, steers, connect, startRun }) => {
    sendCodexSteer(socket);
    sendCodexSteer(socket);
    assert.equal(steers.length, 1);
    assert.equal(steers[0].options.expectedTurnId, 'turn-a');

    socket.readyState = 3;
    socket.emit('close');
    const reconnect = connect();
    resumeCodexTurn(reconnect, 'turn-a', 1);
    assert.equal(reconnect.frames[0].turnId, 'turn-a');
    assert.deepEqual(reconnect.frames[0].steerOutcomes, [{ messageId: MESSAGE_ID, outcome: 'unknown' }]);

    const run = chatRunRegistry.getRun(SESSION_ID);
    assert.ok(run);
    const echo = createNormalizedMessage({ id: MESSAGE_ID, kind: 'text', provider: 'codex', role: 'user', content: 'change course' });
    run.writer.send(echo);
    run.writer.send(echo);
    resolveSteer(true);
    await settle();
    assert.equal(reconnect.frames.filter((frame) => frame.kind === 'text' && frame.id === MESSAGE_ID).length, 1);
    assert.equal(reconnect.frames.some((frame) => frame.outcome === 'accepted'), false);

    run.writer.send(createCompleteMessage({ provider: 'codex', exitCode: 0, turnSettleConfirmed: true }));
    startRun('turn-b');
    const next = connect();
    resumeCodexTurn(next, 'turn-a', 100);
    assert.deepEqual(next.frames[0].steerOutcomes, [{ messageId: MESSAGE_ID, outcome: 'delivered' }]);
    assert.equal(next.frames[1].kind, 'turn_started', 'cursor from the old turn does not skip replay for the new turn');
    assert.equal(next.frames[1].turnId, 'turn-b');
  });
});

test('late steering for an earlier Codex turn is refused without calling the runtime', async () => {
  await withGateway({ accepts: true, running: false, provider: 'codex' }, async ({ socket, steers, startRun }) => {
    startRun('turn-b');
    sendCodexSteer(socket, 'turn-a');
    await settle();
    assert.equal(steers.length, 0);
    assert.equal(socket.frames.at(-1)?.outcome, 'refused');
  });
});

test('an idle Codex subscriber can steer the next turn started by the queue', async () => {
  await withGateway({ accepts: true, running: false, provider: 'codex' }, async ({ socket, steers, startRun }) => {
    resumeCodexTurn(socket, 'turn-a', 1);
    assert.equal(socket.frames.at(-1)?.isProcessing, false);

    const run = startRun('turn-b');
    assert.equal(socket.frames.at(-1)?.kind, 'turn_started');
    assert.equal(socket.frames.at(-1)?.turnId, 'turn-b');
    sendCodexSteer(socket, 'turn-b');
    await settle();
    assert.equal(steers.length, 1);
    assert.equal(socket.frames.at(-1)?.outcome, 'accepted');

    socket.emit('close');
    run.writer.send(createCompleteMessage({ provider: 'codex', exitCode: 0, turnSettleConfirmed: true }));
    const received = socket.frames.length;
    startRun('turn-c');
    assert.equal(socket.frames.length, received);
  });
});

function verifyAcceptedSteerSettle(turnSettleConfirmed: boolean, expectedOutcome: 'unread' | 'unknown') {
  return withGateway({ accepts: true, running: true, provider: 'codex' }, async ({ socket, connect }) => {
    sendCodexSteer(socket);
    await settle();
    assert.equal(socket.frames.at(-1)?.outcome, 'accepted');
    const run = chatRunRegistry.getRun(SESSION_ID);
    assert.ok(run);
    run.writer.send(createCompleteMessage({
      provider: 'codex',
      exitCode: turnSettleConfirmed ? 0 : 1,
      aborted: turnSettleConfirmed,
      turnSettleConfirmed,
    }));
    assert.equal(socket.frames.at(-2)?.outcome, expectedOutcome);
    assert.equal(socket.frames.at(-1)?.kind, 'complete');
    const reconnect = connect();
    resumeCodexTurn(reconnect, 'turn-a', 1);
    assert.deepEqual(reconnect.frames[0].steerOutcomes, [{ messageId: MESSAGE_ID, outcome: expectedOutcome }]);
  });
}

test('provider-confirmed completion without a Codex echo restores the unread steer', () => verifyAcceptedSteerSettle(true, 'unread'));
test('an App Server crash leaves an accepted but unconfirmed steer unknown', () => verifyAcceptedSteerSettle(false, 'unknown'));

test('an ambiguous Codex RPC failure remains unknown and a duplicate does not retry it', async () => {
  const accepts = async () => { throw new Error('RPC timed out'); };
  await withGateway({ accepts, running: true, provider: 'codex' }, async ({ socket, steers }) => {
    sendCodexSteer(socket);
    await settle();
    sendCodexSteer(socket);
    await settle();
    assert.equal(steers.length, 1);
    assert.equal(socket.frames.at(-1)?.outcome, 'unknown');
  });
});
