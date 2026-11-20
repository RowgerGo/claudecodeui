import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('bootstrap makes the OpenCode installer directory available after existing PATH entries', { skip: process.platform === 'win32' }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-opencode-path-'));
  const serverDir = path.join(fixture, 'server');
  const installedDir = path.join(fixture, '.opencode', 'bin');
  const preferredDir = path.join(fixture, 'preferred');
  try {
    await Promise.all([mkdir(serverDir), mkdir(installedDir, { recursive: true }), mkdir(preferredDir)]);
    await copyFile(path.join(applicationRoot, 'server', 'load-env.ts'), path.join(serverDir, 'load-env.ts'));
    await writeFile(path.join(fixture, '.env'), '');
    await writeFile(path.join(fixture, 'probe.ts'), `
import './server/load-env.ts';
import { execFileSync } from 'node:child_process';
console.log(JSON.stringify({ path: process.env.PATH, result: execFileSync('/bin/sh', ['-c', 'opencode'], { encoding: 'utf8' }).trim() }));
`);
    const installedCommand = path.join(installedDir, 'opencode');
    const preferredCommand = path.join(preferredDir, 'opencode');
    await writeFile(installedCommand, '#!/bin/sh\nprintf installed');
    await chmod(installedCommand, 0o755);

    const run = (searchPath: string): { path: string; result: string } => JSON.parse(execFileSync(
      process.execPath,
      [path.join(applicationRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(fixture, 'probe.ts')],
      { env: { ...process.env, HOME: fixture, PATH: searchPath }, encoding: 'utf8' },
    ));

    const basePath = `${preferredDir}:/usr/bin:/bin`;
    assert.deepEqual(run(basePath), { path: `${basePath}:${installedDir}`, result: 'installed' });
    await writeFile(preferredCommand, '#!/bin/sh\nprintf preferred');
    await chmod(preferredCommand, 0o755);
    assert.deepEqual(run(basePath), { path: `${basePath}:${installedDir}`, result: 'preferred' });
    assert.deepEqual(run(`${installedDir}:${basePath}`), { path: `${installedDir}:${basePath}`, result: 'installed' });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
