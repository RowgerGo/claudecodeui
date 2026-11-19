import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-mapping-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('disk-discovered sessions are keyed by the provider id for both columns', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('provider-abc', 'claude', '/workspace/demo', 'From Disk');

    const row = sessionsDb.getSessionById('provider-abc');
    assert.equal(row?.session_id, 'provider-abc');
    assert.equal(row?.provider_session_id, 'provider-abc');

    const byProviderId = sessionsDb.getSessionByProviderSessionId('provider-abc');
    assert.equal(byProviderId?.session_id, 'provider-abc');
  });
});

test('app sessions get the provider id assigned without creating a duplicate row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-1', 'claude', '/workspace/demo', 'Initial CloudCLI message');
    sessionsDb.assignProviderSessionId('app-id-1', 'provider-xyz');

    // A later synchronizer pass that discovers the transcript on disk must
    // update the app row in place instead of inserting a provider-keyed row.
    const returnedId = sessionsDb.createSession(
      'provider-xyz',
      'claude',
      '/workspace/demo',
      'Synced Name',
      undefined,
      undefined,
      '/fake/path/provider-xyz.jsonl',
    );

    assert.equal(returnedId, 'app-id-1');
    assert.equal(sessionsDb.getAllSessions().length, 1);

    const row = sessionsDb.getSessionById('app-id-1');
    assert.equal(row?.provider_session_id, 'provider-xyz');
    assert.equal(row?.jsonl_path, '/fake/path/provider-xyz.jsonl');
    assert.equal(row?.custom_name, 'Initial CloudCLI message');
  });
});

test('assignProviderSessionId merges a watcher-created duplicate into the app row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-2', 'codex', '/workspace/demo');

    // Simulate the race: the filesystem watcher indexed the provider
    // transcript before the runtime announced its session id to the gateway.
    sessionsDb.createSession(
      'provider-race',
      'codex',
      '/workspace/demo',
      'Watcher Name',
      undefined,
      undefined,
      '/fake/provider-race.jsonl',
    );
    assert.equal(sessionsDb.getAllSessions().length, 2);

    sessionsDb.assignProviderSessionId('app-id-2', 'provider-race');

    const rows = sessionsDb.getAllSessions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.session_id, 'app-id-2');
    assert.equal(rows[0]?.provider_session_id, 'provider-race');
    // Transcript path and name from the duplicate are adopted.
    assert.equal(rows[0]?.jsonl_path, '/fake/provider-race.jsonl');
    assert.equal(rows[0]?.custom_name, 'Watcher Name');
  });
});

test('legacy provider-keyed rows stay resolvable through both lookups', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('legacy-1', 'opencode', '/workspace/demo');

    assert.equal(sessionsDb.getSessionById('legacy-1')?.provider, 'opencode');
    assert.equal(sessionsDb.getSessionByProviderSessionId('legacy-1')?.session_id, 'legacy-1');
  });
});

test('a native Codex title replaces a provisional name without moving or restoring the conversation', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app', 'codex', '/workspace/demo', 'First four words');
    sessionsDb.assignProviderSessionId('app', 'thread');
    sessionsDb.updateSessionIsArchived('app', true);
    const previous = sessionsDb.getSessionById('app');

    assert.equal(sessionsDb.applyCodexThreadName('thread', 'Native title'), 'app');
    const named = sessionsDb.getSessionById('app');
    assert.equal(named?.custom_name, 'Native title');
    assert.equal(named?.name_source, 'provider');
    assert.equal(named?.updated_at, previous?.updated_at);
    assert.equal(named?.isArchived, 1);
    assert.equal(sessionsDb.applyCodexThreadName('thread', 'Native title'), null);
    assert.equal(sessionsDb.applyCodexThreadName('thread', 'Updated native title'), 'app');

    sessionsDb.updateSessionCustomName('app', 'Chosen by user');
    assert.equal(sessionsDb.applyCodexThreadName('thread', 'Late title', 'Chosen by user'), null);
    sessionsDb.createSession('thread', 'codex', '/workspace/demo', 'Stale fallback');
    assert.equal(sessionsDb.getSessionById('app')?.custom_name, 'Chosen by user');

    sessionsDb.createSession('disk', 'codex', '/workspace/demo', 'Old fallback');
    sessionsDb.updateSessionCustomName('disk', 'Manually named CLI session');
    sessionsDb.createSession('disk', 'codex', '/workspace/demo', 'Stale fallback');
    assert.equal(sessionsDb.getSessionById('disk')?.custom_name, 'Manually named CLI session');

    sessionsDb.createSession('other', 'claude', '/workspace/demo', 'Claude title');
    assert.equal(sessionsDb.applyCodexThreadName('other', 'Codex title'), null);
  });
});

test('mapping a Codex watcher duplicate preserves a native name and gives the app manual rename priority', async () => {
  await withIsolatedDatabase(() => {
    for (const id of ['early-name', 'manual-app']) {
      sessionsDb.createAppSession(id, 'codex', '/workspace/demo', 'Opening prompt');
      sessionsDb.createSession(`thread-${id}`, 'codex', '/workspace/demo', 'Untitled Codex Session');
      sessionsDb.applyCodexThreadName(`thread-${id}`, 'Native name');
    }
    sessionsDb.updateSessionCustomName('manual-app', 'My title');

    sessionsDb.assignProviderSessionId('early-name', 'thread-early-name');
    assert.equal(sessionsDb.getSessionById('early-name')?.custom_name, 'Native name');
    assert.equal(sessionsDb.getSessionById('early-name')?.name_source, 'provider');

    sessionsDb.assignProviderSessionId('manual-app', 'thread-manual-app');
    assert.equal(sessionsDb.getSessionById('manual-app')?.custom_name, 'My title');
    assert.equal(sessionsDb.getSessionById('manual-app')?.name_source, 'manual');
  });
});

test('a generated title applies to its original provisional conversation once, until a native title or rename arrives', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app', 'codex', '/workspace/demo', 'Opening message');
    sessionsDb.assignProviderSessionId('app', 'thread');
    assert.equal(sessionsDb.applyGeneratedCodexTitle('app', 'previous-thread', 'Outdated title'), false);
    assert.equal(sessionsDb.applyGeneratedCodexTitle('app', 'thread', 'Generated title'), true);
    assert.equal(sessionsDb.getSessionById('app')?.name_source, 'generated');
    sessionsDb.createSession('thread', 'codex', '/workspace/demo', 'Stale fallback');
    assert.equal(sessionsDb.getSessionById('app')?.custom_name, 'Generated title');
    assert.equal(sessionsDb.applyGeneratedCodexTitle('app', 'thread', 'Duplicate result'), false);
    assert.equal(sessionsDb.applyCodexThreadName('thread', 'Native title'), 'app');
    assert.equal(sessionsDb.applyGeneratedCodexTitle('app', 'thread', 'Late result'), false);
    sessionsDb.updateSessionCustomName('app', 'Manual title');
    assert.equal(sessionsDb.applyGeneratedCodexTitle('app', 'thread', 'Late result'), false);
  });
});

test('after migration Codex titles replace verified legacy fallbacks and preserve user and fork names', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('legacy', 'codex', '/workspace/demo', 'First four words');
    sessionsDb.createSession('unnamed', 'codex', '/workspace/demo', 'Untitled Codex Session');
    sessionsDb.createForkedSession({
      sessionId: 'fork', provider: 'codex', projectPath: '/workspace/demo', customName: 'Fork title',
      providerSessionId: 'fork-thread', jsonlPath: 'fork.jsonl', forkedFromSessionId: 'legacy',
      model: null, effort: null,
    });
    const db = getConnection();
    db.exec('ALTER TABLE sessions DROP COLUMN name_source');
    runMigrations(db);

    assert.equal(sessionsDb.getSessionById('legacy')?.name_source, 'legacy');
    assert.equal(sessionsDb.applyCodexThreadName('legacy', 'Native title'), null);
    assert.equal(sessionsDb.applyCodexThreadName('legacy', 'Native title', 'Other text'), null);
    assert.equal(sessionsDb.applyCodexThreadName('legacy', 'Native title', 'First four words'), 'legacy');
    assert.equal(sessionsDb.applyCodexThreadName('unnamed', 'Native title'), 'unnamed');
    assert.equal(sessionsDb.applyCodexThreadName('fork-thread', 'Inherited title', 'Fork title'), null);
    sessionsDb.updateSessionCustomName('unnamed', 'Untitled Session');
    runMigrations(db);
    assert.equal(sessionsDb.getSessionById('unnamed')?.name_source, 'manual');
  });
});
