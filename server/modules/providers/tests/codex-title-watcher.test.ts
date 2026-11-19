import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

test('the watcher announces title-only changes in a custom Codex home without a rollout write', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-title-watcher-'));
  const codexHome = path.join(directory, 'custom-codex');
  const environment = {
    DATABASE_PATH: path.join(directory, 'db.sqlite'), CODEX_HOME: codexHome,
    XDG_DATA_HOME: path.join(directory, 'data'), CHOKIDAR_USEPOLLING: 'true', CHOKIDAR_INTERVAL: '50',
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.mock.method(os, 'homedir', () => directory);
  t.after(async () => {
    closeConnection();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });

  await mkdir(codexHome);
  const { initializeSessionsWatcher, closeSessionsWatcher } = await import('@/modules/providers/services/sessions-watcher.service.js');
  const { connectedClients } = await import('@/modules/websocket/index.js');
  await initializeDatabase();
  sessionsDb.createAppSession('app', 'codex', directory, 'Provisional');
  sessionsDb.assignProviderSessionId('app', 'thread');
  await initializeSessionsWatcher();
  const frames: Array<{ sessionId: string; titleOnly?: boolean; session: { summary: string } }> = [];
  const client = { readyState: 1, send: (data: string) => frames.push(JSON.parse(data)) };
  connectedClients.add(client as never);
  try {
    const index = path.join(codexHome, 'session_index.jsonl');
    const deadline = Date.now() + 12_000;
    // Chokidar initializes asynchronously. The index is created after startup
    // and the transcript directory is never touched during this conversation.
    while (!frames.length && Date.now() < deadline) {
      await appendFile(index, '{"id":"thread","thread_name":"Native title"}\n');
      await delay(150);
    }
    assert.deepEqual(frames.map(({ sessionId, titleOnly, session }) => [sessionId, titleOnly, session.summary]), [
      ['app', true, 'Native title'],
    ]);
  } finally {
    connectedClients.delete(client as never);
    await closeSessionsWatcher();
  }
});
