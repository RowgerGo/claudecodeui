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
import type { AnyRecord, NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

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
