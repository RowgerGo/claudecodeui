import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';

// Exercise the normal transport, including notifications racing the turn/start reply.
async function generateWithFake(
  options: { response?: string; provider?: string; sandbox?: string; failedTurn?: boolean },
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-title-'));
  const launcher = path.join(dir, 'app-server.cjs');
  const log = path.join(dir, 'requests.jsonl');
  const original = codexAppServer.resolveLauncher;
  try {
    await writeFile(launcher, `
      const readline = require('node:readline');
      const fs = require('node:fs');
      const options = ${JSON.stringify(options)};
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      const thread = { id: 'title-only', ephemeral: true };
      readline.createInterface({ input: process.stdin }).on('line', line => {
        fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
        const { id, method } = JSON.parse(line);
        if (!id) return;
        let result = {};
        if (method === 'config/read') result = { config: {
          model_provider: options.provider || 'openai', mcp_servers: { projectMcp: { command: 'unused' } },
        } };
        if (method === 'account/read') result = { account: { type: 'chatgpt' } };
        if (method === 'model/list') result = { data: [{ model: 'gpt-5.6-luna' }] };
        if (method === 'thread/start') result = { thread, sandbox: { type: options.sandbox || 'readOnly' } };
        if (method === 'turn/start') {
          const item = { type: 'agentMessage', text: options.response || '{"title":"修复侧栏标题"}' };
          send({ method: 'item/completed', params: { threadId: thread.id, item } });
          send({ method: 'item/completed', params: { threadId: 'other', item: { ...item, text: '{"title":"wrong"}' } } });
          send({ method: 'turn/completed', params: { threadId: thread.id, turn: { id: 'turn', status: options.failedTurn ? 'failed' : 'completed' } } });
          result = { turn: { id: 'turn' } };
        }
        send({ id, result });
      });
    `);
    codexAppServer.resolveLauncher = () => launcher;
    const title = await codexAppServer.generateThreadTitle({
      cwd: dir, prompt: '请修复侧栏📌'.repeat(200), model: 'chat-model',
    });
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    return { title, dir, requests };
  } finally {
    codexAppServer.resolveLauncher = original;
    await rm(dir, { recursive: true, force: true });
  }
}

test('Codex titles use a bounded first message and a private, read-only structured turn', async () => {
  const { title, requests, dir } = await generateWithFake({});
  assert.equal(title, '修复侧栏标题');
  const params = (method: string) => requests.find((request) => request.method === method)?.params;
  assert.equal(params('config/read').cwd, dir);
  const start = params('thread/start');
  assert.equal(start.model, 'gpt-5.6-luna');
  assert.equal(start.ephemeral, true);
  assert.equal(start.permissions, ':read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.deepEqual(start.environments, []);
  assert.deepEqual(start.runtimeWorkspaceRoots, []);
  assert.deepEqual(start.config.mcp_servers, { projectMcp: { enabled: false } });
  for (const feature of ['plugins', 'apps', 'shell_tool', 'hooks', 'unified_exec']) {
    assert.equal(start.config.features[feature], false);
  }
  const turn = params('turn/start');
  assert.equal(turn.threadId, 'title-only');
  assert.equal(turn.effort, 'low');
  assert.deepEqual(turn.outputSchema.required, ['title']);
  assert.ok(Buffer.byteLength(turn.input[0].text) <= 960);
  assert.ok('请修复侧栏📌'.repeat(200).startsWith(turn.input[0].text));
  assert.ok(turn.input[0].text.isWellFormed());
});

test('Codex titles keep custom providers on the selected model and normalize model output', async () => {
  const { title, requests } = await generateWithFake({
    provider: 'local', response: JSON.stringify({ title: '  “Fix\n  session names!”  ' }),
  });
  assert.equal(title, 'Fix session names');
  assert.equal(requests.find((request) => request.method === 'thread/start').params.model, 'chat-model');
  assert.equal(requests.some((request) => request.method === 'account/read' || request.method === 'model/list'), false);
});

test('malformed, failed or unexpectedly writable Codex title turns leave the fallback available', async () => {
  assert.equal((await generateWithFake({ response: 'plain text' })).title, null);
  assert.equal((await generateWithFake({ failedTurn: true })).title, null);
  const writable = await generateWithFake({ sandbox: 'workspaceWrite' });
  assert.equal(writable.title, null);
  assert.equal(writable.requests.some((request) => request.method === 'turn/start'), false);
});
