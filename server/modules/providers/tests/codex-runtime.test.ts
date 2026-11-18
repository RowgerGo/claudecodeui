import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { parseFilesInputTag } from '@/shared/image-attachments.js';
import type { AnyRecord, ChatCodexOperation, CodexControlHooks, CodexGoal, NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const context: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => 'test-model',
  getProviderModels: async () => ({
    OPTIONS: [{ value: 'test-model', label: 'Test model', effort: { values: [{ value: 'high', label: 'High' }] } }],
    DEFAULT: 'test-model',
  }),
  normalizeMessage: (message, sessionId) => new CodexSessionsProvider().normalizeMessage(message, sessionId),
  isProviderInstalled: async () => true,
};

// A child process exercises the same stdin/stdout framing, event ordering
// and lifecycle as the installed native App Server.
async function useFakeAppServer(t: TestContext, mode: 'steer' | 'crash' | 'fail' | 'interrupt' | 'complete') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-codex-turn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const launcher = path.join(dir, 'launcher.cjs');
  const logPath = path.join(dir, 'requests.jsonl');
  await writeFile(launcher, `
    const fs = require('node:fs');
    const readline = require('node:readline');
    const mode = ${JSON.stringify(mode)};
    const log = ${JSON.stringify(logPath)};
    const threadId = 'native-thread';
    const turnId = 'native-turn';
    const write = (message) => console.log(JSON.stringify(message));
    const notify = (method, params) => write({ method, params: { threadId, turnId, ...params } });
    const reply = (id, result) => write({ id, result });
    const item = (method, item) => notify(method, { item });
    const finish = (status, error) => notify('turn/completed', { turn: { id: turnId, status, error } });
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      fs.appendFileSync(log, line + '\\n');
      const { id, method, params } = message;
      if (method === 'initialize') return reply(id, {});
      if (method === 'thread/goal/get') return reply(id, { goal: null });
      if (method === 'thread/start' || method === 'thread/resume') return reply(id, { thread: { id: threadId } });
      if (method === 'turn/start') {
        // The real server can publish start before replying to the RPC.
        notify('turn/started', { turn: { id: turnId, status: 'inProgress' } });
        reply(id, { turn: { id: turnId, status: 'inProgress' } });
        if (mode === 'complete') {
          write({ method: 'item/commandExecution/requestApproval', id: 'approval-callback', params: { threadId, turnId } });
        }
        if (mode === 'fail') {
          notify('error', { willRetry: false, error: { message: 'model rejected the request' } });
          finish('failed', { message: 'model rejected the request' });
        }
        if (mode === 'crash') process.exitCode = 1, process.stdin.destroy();
      }
      if (id === 'approval-callback') finish('completed');
      if (method === 'turn/steer') {
        item('item/started', { id: 'native-user-item', clientId: params.clientUserMessageId, type: 'userMessage', content: params.input });
        reply(id, { turnId });
        item('item/completed', { id: 'native-user-item', clientId: params.clientUserMessageId, type: 'userMessage', content: params.input });
        const command = { id: 'tool-id', type: 'commandExecution', command: 'pwd', status: 'inProgress' };
        item('item/started', command);
        notify('item/commandExecution/outputDelta', { itemId: command.id, delta: '/repo' });
        item('item/completed', { ...command, status: 'completed', exitCode: 0, aggregatedOutput: '/repo' });
        notify('item/agentMessage/delta', { itemId: 'assistant-id', delta: 'Hel' });
        item('item/completed', { id: 'assistant-id', type: 'agentMessage', text: 'Hello' });
        notify('thread/tokenUsage/updated', { tokenUsage: { modelContextWindow: 100, total: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } } });
        finish('completed');
      }
      if (method === 'turn/interrupt') {
        reply(id, {});
        finish('interrupted');
      }
    });
  `);
  t.mock.method(codexAppServer, 'resolveLauncher', () => launcher);
  return async () => (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as AnyRecord);
}

function recordMessages() {
  let markStarted!: (id: string) => void;
  const started = new Promise<string>((resolve) => { markStarted = resolve; });
  const messages: NormalizedMessage[] = [];
  return {
    started,
    messages,
    writer: {
      isWebSocketWriter: true,
      send(message: unknown) {
        const event = message as NormalizedMessage;
        messages.push(event);
        if (event.kind === 'turn_started' && event.turnId) markStarted(event.turnId);
      },
    },
  };
}

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      const readRequests = await useFakeAppServer(t, 'complete');
      const { messages, writer } = recordMessages();

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        effort: 'high',
        cwd: process.cwd(),
      }, writer, { ...context, resolveProviderSessionId: () => resumed ? 'native-thread' : null });

      const requests = await readRequests();
      const opened = requests.find((request) => request.method === (resumed ? 'thread/resume' : 'thread/start'));
      assert.ok(opened);
      assert.equal(opened.params.threadId, resumed ? 'native-thread' : undefined);
      assert.equal(opened.params.model, 'test-model');
      assert.equal(opened.params.cwd, process.cwd());
      assert.equal(opened.params.sandbox, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(opened.params.approvalPolicy, permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request');
      assert.deepEqual(opened.params.config, { model_reasoning_effort: 'high' });
      assert.deepEqual(requests.find((request) => request.method === 'turn/start')?.params, {
        threadId: 'native-thread', input: [{ type: 'text', text: 'hey there' }], effort: 'high',
      });
      assert.deepEqual(requests.find((request) => request.id === 'approval-callback')?.result, { decision: 'decline' });
      assert.equal(messages.filter((message) => message.kind === 'session_created').length, resumed ? 0 : 1);
      assert.equal(messages.filter((message) => message.kind === 'turn_started').length, 1);
      assert.equal(messages.filter((message) => message.kind === 'complete' && message.exitCode === 0 && message.turnSettleConfirmed).length, 1);
      assert.ok(!messages.some((message) => message.kind === 'error'));
    });
  }
}

test('Codex supplies a prompt for an image-only turn', async (t) => {
  const readRequests = await useFakeAppServer(t, 'complete');
  const imagePath = path.join(process.cwd(), 'public', 'favicon.png');
  await codexRuntime.run('  \n\t', {
    cwd: process.cwd(),
    images: [{ path: imagePath, mimeType: 'image/png' }],
  }, { isWebSocketWriter: true, send: () => {} }, context);
  const requests = await readRequests();
  assert.deepEqual(requests.find((request) => request.method === 'turn/start')?.params.input, [
    { type: 'text', text: 'Please analyze the attached image(s).' },
    { type: 'localImage', path: imagePath },
  ]);
});

test('Codex carries non-image upload paths into the turn input', async (t) => {
  const readRequests = await useFakeAppServer(t, 'complete');
  const attachment = { path: '/workspace/uploads/report.txt', name: 'report.txt' };
  await codexRuntime.run('Summarize this file.', { files: [attachment] }, recordMessages().writer, context);
  const requests = await readRequests();
  const input = requests.find((request) => request.method === 'turn/start')?.params.input;
  assert.equal(input.length, 1);
  assert.deepEqual(parseFilesInputTag(input[0].text), {
    text: 'Summarize this file.',
    filePaths: [attachment.path],
    attachments: [attachment],
  });
});

test('steering uses the active App Server connection, with one stable user echo and live item updates', async (t) => {
  const readRequests = await useFakeAppServer(t, 'steer');
  const { started, messages, writer } = recordMessages();
  const run = codexRuntime.run('first prompt', { sessionId: 'active-app-session' }, writer, context);
  const expectedTurnId = await started;
  const messageId = '3530480f-4808-410b-a33d-50c17cdd2308';
  assert.equal(await codexRuntime.steer('active-app-session', 'stale', { expectedTurnId: 'old-turn', messageId }), false);
  assert.equal(await codexRuntime.steer('active-app-session', '只改前端', { expectedTurnId, messageId }), true);
  await run;

  const requests = await readRequests();
  assert.equal(requests.filter((request) => request.method === 'turn/start').length, 1);
  assert.deepEqual(requests.filter((request) => request.method === 'turn/steer').map((request) => request.params), [{
    threadId: 'native-thread', expectedTurnId, clientUserMessageId: messageId, input: [{ type: 'text', text: '只改前端' }],
  }]);
  assert.deepEqual(messages.filter((row) => row.id === messageId).map((row) => [row.role, row.content]), [['user', '只改前端']]);
  assert.deepEqual(messages.filter((row) => row.id === 'tool-id').map((row) => row.status), ['in_progress', 'in_progress', 'completed']);
  assert.deepEqual(messages.filter((row) => row.id === 'assistant-id').map((row) => row.content), ['Hel', 'Hello']);
  assert.deepEqual(messages.find((row) => row.text === 'token_budget')?.tokenBudget, {
    used: 7, total: 100, inputTokens: 4, outputTokens: 3, breakdown: { input: 4, output: 3 },
  });
});

test('stopping a running Codex turn waits for the targeted native interruption', async (t) => {
  const readRequests = await useFakeAppServer(t, 'interrupt');
  const { started, writer, messages } = recordMessages();
  const run = codexRuntime.run('stop me', { sessionId: 'interrupt-app-session' }, writer, context);
  const turnId = await started;
  assert.equal(await codexRuntime.abort('interrupt-app-session'), true);
  await run;
  const requests = await readRequests();
  assert.deepEqual(requests.find((request) => request.method === 'turn/interrupt')?.params, { threadId: 'native-thread', turnId });
  const terminal = messages.filter((row) => row.kind === 'complete');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].aborted, true);
  assert.equal(terminal[0].turnSettleConfirmed, true);
});

test('stopping one Codex session leaves another active session available for steering', async (t) => {
  await useFakeAppServer(t, 'steer');
  const first = recordMessages();
  const second = recordMessages();
  const runs = [
    codexRuntime.run('first', { sessionId: 'app-first' }, first.writer, context),
    codexRuntime.run('second', { sessionId: 'app-second' }, second.writer, context),
  ];
  try {
    const [, secondTurnId] = await Promise.all([first.started, second.started]);
    assert.equal(await codexRuntime.abort('app-first'), true);
    assert.equal(second.messages.some((message) => message.kind === 'complete'), false);
    assert.equal(await codexRuntime.steer('app-second', 'continue', {
      messageId: '32fa0788-e5c1-4bac-a80b-334271ea2050',
      expectedTurnId: secondTurnId,
    }), true);
    await Promise.all(runs);
    assert.equal(first.messages.find((message) => message.kind === 'complete')?.aborted, true);
    assert.equal(second.messages.find((message) => message.kind === 'complete')?.success, true);
  } finally {
    await Promise.all([codexRuntime.abort('app-first'), codexRuntime.abort('app-second')]);
  }
});

for (const mode of ['fail', 'crash'] as const) {
  test(`Codex settles an App Server ${mode} once`, async (t) => {
    await useFakeAppServer(t, mode);
    const { messages, writer } = recordMessages();
    await codexRuntime.run('fail me', { sessionId: `${mode}-app-session` }, writer, context);
    assert.equal(messages.filter((row) => row.kind === 'error').length, 1);
    const terminal = messages.filter((row) => row.kind === 'complete');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].exitCode, 1);
    assert.equal(Boolean(terminal[0].turnSettleConfirmed), mode === 'fail');
  });
}

function scriptedControlServer(t: TestContext, initialGoal: CodexGoal | null = null) {
  const threadId = 'native-control-thread';
  const calls: { method: string; params: AnyRecord }[] = [];
  const turns = new Map<string, ReturnType<typeof recordMessages>>();
  const goals: (CodexGoal | null)[] = [];
  let goal = initialGoal;
  let notify: (method: string, params: unknown) => void = () => {};
  let exit: (reason: string) => void = () => {};
  let acceptCount = 0;
  let connections = 0;
  let activeRun = false;
  let history = true;
  let threadMetadata: AnyRecord = {};
  let setFailure: Error | undefined;
  let boundThread: string | undefined;
  let discardedThread: string | undefined;
  let onCompactionStart: (() => void) | undefined;
  const hooks: CodexControlHooks = {
    bindThread: (id) => { boundThread = id; },
    discardUnmaterializedThread: (id) => { discardedThread = id; },
    isTurnRunning: () => activeRun,
    startTurn: (_id, turnId) => {
      const recorded = recordMessages();
      turns.set(turnId, recorded);
      return recorded.writer;
    },
    publishGoal: (state) => { goals.push(state); },
    onAccepted: () => { acceptCount++; },
    onIdle: () => {},
  };
  const send = (method: string, params: AnyRecord) => notify(method, { threadId, ...params });
  t.mock.method(codexAppServer, 'withChatConnection', async (run: Parameters<typeof codexAppServer.withChatConnection>[0]) => {
    connections++;
    return run({
      onNotification(handler) {
        notify = handler;
        return () => {};
      },
      onExit(handler) {
        exit = handler;
        return () => {};
      },
      async call(method, value) {
        const params = value as AnyRecord;
        calls.push({ method, params });
        switch (method) {
          case 'thread/start':
          case 'thread/resume':
            return { thread: { id: threadId } };
          case 'thread/read':
            return { thread: { id: threadId, ...threadMetadata } };
          case 'thread/goal/get':
            return { goal };
          case 'thread/goal/set':
            assert.equal(boundThread ?? initialGoal?.threadId, threadId);
            if (setFailure) {
              const error = setFailure;
              setFailure = undefined;
              throw error;
            }
            goal = {
              ...(goal ?? {
                threadId, status: 'active', objective: '', tokenBudget: null, tokensUsed: 0,
                timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
              }),
              ...(params.objective === undefined ? {} : { objective: params.objective }),
              ...(params.status === undefined ? {} : { status: params.status }),
            };
            return { goal };
          case 'thread/goal/clear': {
            const cleared = Boolean(goal);
            goal = null;
            send('thread/goal/cleared', {});
            return { cleared };
          }
          case 'thread/turns/list':
            return { data: history ? [{ id: 'prior-turn', status: 'completed' }] : [] };
          case 'thread/compact/start':
            onCompactionStart?.();
            return {};
          case 'turn/start': {
            const turn = { id: 'queued-turn', status: 'inProgress' };
            send('turn/started', { turn });
            send('turn/completed', { turn: { ...turn, status: 'completed' } });
            return { turn };
          }
          case 'turn/steer':
            return { turnId: params.expectedTurnId };
          case 'turn/interrupt':
            send('turn/completed', { turn: { id: params.turnId, status: 'interrupted' } });
            return {};
          default:
            throw new Error(`Unexpected request: ${method}`);
        }
      },
    });
  });

  const appSessionId = 'app-control-session';
  const existingContext = { ...context, resolveProviderSessionId: () => threadId };
  return {
    calls, hooks, turns, goals, send, appSessionId,
    compact: () => codexRuntime.controlCodex(appSessionId, {}, { kind: 'compact' }, hooks, existingContext),
    goal: (operation: Extract<ChatCodexOperation, { kind: 'goal' }>, exists = true) =>
      codexRuntime.controlCodex(appSessionId, {}, operation, hooks, exists ? existingContext : context),
    sendQueued: () => codexRuntime.run('Queued input', { sessionId: appSessionId, codexHooks: hooks }, recordMessages().writer, existingContext),
    turn: (id: string, status?: 'completed' | 'interrupted' | 'failed') => {
      send(status ? 'turn/completed' : 'turn/started', { turn: { id, status: status ?? 'inProgress' } });
    },
    compactionItem: (turn: string, finished: boolean) => {
      send(finished ? 'item/completed' : 'item/started', { turnId: turn, item: { id: 'compaction-item', type: 'contextCompaction' } });
    },
    failConnection: () => exit('test process exited'),
    setActiveRun: (active: boolean) => { activeRun = active; },
    setHistory: (hasHistory: boolean) => { history = hasHistory; },
    setThreadMetadata: (metadata: AnyRecord) => { threadMetadata = metadata; },
    failNextGoalSet: () => {
      setFailure = new AppError('native goal set failed', { code: 'CODEX_APP_SERVER_ERROR' });
    },
    beforeCompactionReply: (callback: () => void) => { onCompactionStart = callback; },
    get accepted() { return acceptCount; },
    get connections() { return connections; },
    get discardedThread() { return discardedThread; },
  };
}

async function waitForControl(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), 'the control operation did not reach the expected stage');
}

const pausedGoal: CodexGoal = {
  threadId: 'native-control-thread', status: 'paused', objective: 'Existing objective', tokenBudget: 900,
  tokensUsed: 120, timeUsedSeconds: 12, createdAt: 1, updatedAt: 10,
};

test('manual compaction reserves the session before its first await and tracks one native item', async (t) => {
  const server = scriptedControlServer(t, pausedGoal);
  server.beforeCompactionReply(() => {
    // Simulate both event-before-RPC and the item completion arriving first.
    server.compactionItem('compact-turn', true);
    server.compactionItem('compact-turn', false);
  });
  const compaction = server.compact();
  assert.deepEqual(await server.compact(), { status: 'rejected', code: 'COMPACT_BUSY' });
  assert.deepEqual(await server.goal({ kind: 'goal', action: 'resume' }), {
    status: 'rejected', code: 'GOAL_COMPACTION_IN_PROGRESS',
  });
  await waitForControl(() => server.accepted === 1);
  const messages = server.turns.get('compact-turn')?.messages;
  assert.ok(messages);
  assert.equal(codexRuntime.isCodexControlBlockingTurn(server.appSessionId), true);
  assert.deepEqual(messages.filter((row) => row.compact).map((row) => row.compact?.phase), ['running']);

  server.turn('unrelated-turn', 'completed');
  assert.equal(messages.some((row) => row.kind === 'complete'), false);
  server.turn('compact-turn', 'completed');
  assert.deepEqual(await compaction, { status: 'completed' });
  assert.equal(codexRuntime.isCodexControlBlockingTurn(server.appSessionId), false);
  const rows = messages.filter((row) => row.compact);
  assert.deepEqual(rows.map((row) => [row.id, row.compact?.phase]), [['compaction-item', 'running'], ['compaction-item', 'done']]);
  assert.deepEqual(rows[1].compact, {
    phase: 'done', trigger: 'manual', nativeItemId: 'compaction-item', nativeTurnId: 'compact-turn', boundaryIndex: 0,
  });
  assert.equal(messages.filter((row) => row.kind === 'complete').length, 1);
  assert.equal(server.calls.filter(({ method }) => method === 'thread/compact/start').length, 1);
  assert.equal(server.calls.find(({ method }) => method === 'thread/resume')?.params.approvalPolicy, undefined);
  assert.equal(server.calls.find(({ method }) => method === 'thread/resume')?.params.sandbox, undefined);
});

for (const outcome of ['failed', 'interrupted', 'crashed'] as const) {
  test(`manual compaction releases its position when it is ${outcome}`, async (t) => {
    const server = scriptedControlServer(t);
    const compaction = server.compact();
    await waitForControl(() => server.accepted === 1);
    server.turn('compact-turn');
    server.compactionItem('compact-turn', false);
    if (outcome === 'crashed') server.failConnection();
    else server.turn('compact-turn', outcome);

    const result = await compaction;
    assert.equal(result.status, 'failed');
    assert.equal(codexRuntime.isCodexControlBlockingTurn(server.appSessionId), false);
    const messages = server.turns.get('compact-turn')?.messages;
    assert.ok(messages);
    assert.deepEqual(messages.filter((row) => row.compact).map((row) => row.compact?.phase), ['running', 'failed']);
    assert.equal(messages.filter((row) => row.kind === 'complete').length, 1);
    assert.equal(messages.filter((row) => row.kind === 'error').length, 0);
  });
}

test('manual compaction skips blank, busy and goal-active threads without a mutation', async (t) => {
  const server = scriptedControlServer(t, { ...pausedGoal, status: 'active' });
  const noThread = await codexRuntime.controlCodex('blank', {}, { kind: 'compact' }, server.hooks, context);
  assert.deepEqual(noThread, { status: 'rejected', code: 'COMPACT_NO_HISTORY' });
  assert.equal(server.connections, 0);

  server.setActiveRun(true);
  assert.deepEqual(await server.compact(), { status: 'rejected', code: 'COMPACT_BUSY' });
  server.setActiveRun(false);
  assert.deepEqual(await server.compact(), { status: 'rejected', code: 'COMPACT_GOAL_ACTIVE' });
  assert.equal(server.calls.some(({ method }) => method === 'thread/compact/start'), false);
});

test('a persisted thread with no turns does not send a compaction RPC', async (t) => {
  const server = scriptedControlServer(t);
  server.setHistory(false);
  assert.deepEqual(await server.compact(), { status: 'rejected', code: 'COMPACT_NO_HISTORY' });
  assert.equal(server.calls.some(({ method }) => method === 'thread/resume' || method === 'thread/compact/start'), false);
});

test('reopening a thread for compaction restores the provider-owned rollout settings', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-codex-control-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = path.join(directory, 'rollout.jsonl');
  await writeFile(rollout, [
    { type: 'turn_context', payload: { sandbox_policy: 'read-only', approval_policy: 'on-request' } },
    {
      type: 'turn_context',
      payload: {
        sandbox_policy: { type: 'workspace-write', writable_roots: [directory], network_access: false },
        approval_policy: 'never',
      },
    },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const server = scriptedControlServer(t);
  server.setThreadMetadata({
    path: rollout, cwd: directory, model: 'persisted-model', reasoningEffort: 'medium',
  });
  server.beforeCompactionReply(() => {
    server.compactionItem('compact-turn', true);
    server.turn('compact-turn', 'completed');
  });
  assert.deepEqual(await server.compact(), { status: 'completed' });
  assert.deepEqual(server.calls.find(({ method }) => method === 'thread/resume')?.params, {
    threadId: pausedGoal.threadId,
    excludeTurns: true,
    cwd: directory,
    model: 'persisted-model',
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    config: {
      model_reasoning_effort: 'medium',
      sandbox_workspace_write: { writable_roots: [directory], network_access: false },
    },
  });
});

test('a goal-first session consumes two native turns on one connection and targets its new turn', async (t) => {
  const server = scriptedControlServer(t);
  assert.deepEqual(await server.goal({ kind: 'goal', action: 'get' }, false), { status: 'completed', goal: null });
  assert.equal(server.connections, 0);

  const result = await server.goal({ kind: 'goal', action: 'set', objective: 'First phase\nSecond phase' }, false);
  assert.equal(result.status, 'completed');
  assert.equal(server.calls.find(({ method }) => method === 'thread/start')?.params.ephemeral, false);
  assert.deepEqual(server.calls.find(({ method }) => method === 'thread/goal/set')?.params, {
    threadId: pausedGoal.threadId, objective: 'First phase\nSecond phase', status: 'active', origin: 'user',
  });

  server.turn('turn-a');
  server.turn('turn-a', 'completed');
  server.turn('turn-b');
  server.send('item/agentMessage/delta', { turnId: 'turn-b', itemId: 'message-b', delta: 'second turn' });
  const options = { expectedTurnId: 'turn-b', messageId: 'message-id' };
  assert.equal(await codexRuntime.steer(server.appSessionId, 'next step', options), true);
  assert.equal(await codexRuntime.abort(server.appSessionId, 'turn-a'), false);
  assert.deepEqual(await server.goal({ kind: 'goal', action: 'pause' }), {
    status: 'completed', goal: { ...result.goal, status: 'paused' },
  });
  assert.equal(await codexRuntime.abort(server.appSessionId, 'turn-b'), true);

  for (const id of ['turn-a', 'turn-b']) {
    assert.equal(server.turns.get(id)?.messages.filter((row) => row.kind === 'complete').length, 1);
  }
  assert.equal(server.turns.get('turn-b')?.messages.find((row) => row.id === 'message-b')?.content, 'second turn');
  assert.equal(server.calls.filter(({ method }) => method === 'turn/start').length, 0);
  assert.deepEqual(server.calls.filter(({ method }) => method === 'turn/interrupt').map(({ params }) => params.turnId), ['turn-b']);
  assert.deepEqual(server.calls.filter(({ method }) => method === 'turn/steer').map(({ params }) => params.expectedTurnId), ['turn-b']);
  assert.equal(server.connections, 1);
});

test('queued input cannot steer a native continuation that claims the thread between turns', async (t) => {
  const active = { ...pausedGoal, status: 'active' } as const;
  const server = scriptedControlServer(t, pausedGoal);
  assert.equal((await server.goal({ kind: 'goal', action: 'resume' })).status, 'completed');
  server.turn('turn-a');
  server.turn('turn-a', 'completed');
  server.send('thread/status/changed', { status: { type: 'idle' } });

  assert.equal(codexRuntime.isCodexControlBlockingTurn(server.appSessionId), true);
  await assert.rejects(server.sendQueued, { code: 'CODEX_TURN_BUSY' });
  assert.equal(server.calls.filter(({ method }) => method === 'turn/start').length, 0);

  server.send('thread/status/changed', { status: { type: 'active' } });
  server.turn('turn-b');
  server.send('thread/goal/updated', { turnId: 'turn-b', goal: { ...active, status: 'complete' } });
  await assert.rejects(server.sendQueued, { code: 'CODEX_TURN_BUSY' });
  server.turn('turn-b', 'completed');
  server.send('thread/status/changed', { status: { type: 'idle' } });
  // Update the persistent state too, since the settled connection can close.
  await server.goal({ kind: 'goal', action: 'clear' });
  assert.equal(codexRuntime.isCodexControlBlockingTurn(server.appSessionId), false);

  await server.sendQueued();
  assert.equal(server.calls.filter(({ method }) => method === 'turn/start').length, 1);
  assert.equal(server.calls.filter(({ method }) => method === 'turn/steer').length, 0);
});

test('goal edits preserve budget and pause state while failed confirmed replacement rereads the goal', async (t) => {
  const server = scriptedControlServer(t, pausedGoal);
  const query = await server.goal({ kind: 'goal', action: 'get' });
  assert.deepEqual(query, { status: 'completed', goal: pausedGoal });
  assert.deepEqual(server.calls.map(({ method }) => method), ['thread/goal/get']);
  assert.deepEqual(await server.goal({ kind: 'goal', action: 'set', objective: 'New goal' }), {
    status: 'rejected', code: 'GOAL_REPLACEMENT_REQUIRED', goal: pausedGoal,
  });
  const edited = { ...pausedGoal, objective: 'Edited goal' };
  assert.deepEqual(await server.goal({ kind: 'goal', action: 'edit', objective: edited.objective, expectedGoal: pausedGoal }), {
    status: 'completed', goal: edited,
  });
  assert.deepEqual(server.calls.find(({ method }) => method === 'thread/goal/set')?.params, {
    threadId: pausedGoal.threadId, objective: edited.objective, origin: 'user',
  });
  assert.deepEqual(await server.goal({ kind: 'goal', action: 'replace', objective: 'New goal', expectedGoal: pausedGoal }), {
    status: 'rejected', code: 'GOAL_CHANGED', goal: edited,
  });

  server.failNextGoalSet();
  assert.deepEqual(await server.goal({ kind: 'goal', action: 'replace', objective: 'New goal', expectedGoal: edited }), {
    status: 'failed', code: 'CODEX_NATIVE_ERROR', error: 'native goal set failed', goal: null,
  });
  assert.deepEqual(server.calls.slice(-3).map(({ method }) => method), ['thread/goal/clear', 'thread/goal/set', 'thread/goal/get']);
  assert.equal(server.calls.filter(({ method }) => method === 'turn/start').length, 0);
});

test('a definitively rejected first goal frees its unmaterialized thread mapping', async (t) => {
  const server = scriptedControlServer(t);
  server.failNextGoalSet();
  const result = await server.goal({ kind: 'goal', action: 'set', objective: 'New goal' }, false);
  assert.deepEqual(result, { status: 'failed', code: 'CODEX_NATIVE_ERROR', error: 'native goal set failed' });
  assert.equal(server.discardedThread, pausedGoal.threadId);
  assert.equal(codexRuntime.isCodexControlBlockingTurn(server.appSessionId), false);
  assert.equal((await server.goal({ kind: 'goal', action: 'set', objective: 'Second try' }, false)).status, 'completed');
  assert.equal((await server.goal({ kind: 'goal', action: 'clear' })).status, 'completed');
  assert.equal(server.calls.filter(({ method }) => method === 'thread/start').length, 2);
});
