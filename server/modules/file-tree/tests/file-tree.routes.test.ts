import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import type { FileTreeServices } from '@/shared/types.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFolderArchive: unexpectedOperation,
    openFile: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectFiles: unexpectedOperation,
    listProjectDirectory: unexpectedOperation,
    searchProjectFiles: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
  ));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('project files route uses the File Tree API namespace and forwards the project id', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: false }]]);
});

test('project files route requests gitignore filtering when explicitly enabled', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true }]]);
});

test('directory and search routes parse queries and propagate cancellation signals', async () => {
  const services = createFakeServices({
    listProjectDirectory: async (id, options) => {
      assert.equal(id, 'project-1');
      assert.equal(options.path, 'many entries');
      assert.equal(options.cursor, '1file');
      assert.equal(options.childName, 'last.ts');
      assert.ok(options.signal instanceof AbortSignal);
      return { entries: [], nextCursor: null };
    },
    searchProjectFiles: async (id, options) => {
      assert.equal(id, 'project-1');
      assert.equal(options.query, 'src/util.ts');
      assert.equal(options.match, 'suffix');
      assert.equal(options.limit, 12);
      assert.equal(options.filesOnly, true);
      assert.ok(options.signal instanceof AbortSignal);
      return { entries: [], truncated: false };
    },
  });
  await withFileTreeServer(services, async (baseUrl) => {
    const base = `${baseUrl}/api/file-tree/projects/project-1`;
    const directory = await fetch(`${base}/directory?path=many%20entries&cursor=1file&childName=last.ts`);
    assert.deepEqual(await directory.json(), { entries: [], nextCursor: null });
    const search = await fetch(`${base}/search?q=src%2Futil.ts&match=suffix&limit=12&filesOnly=true`);
    assert.deepEqual(await search.json(), { entries: [], truncated: false });
    assert.equal((await fetch(`${base}/search?limit=501`)).status, 400);
    assert.equal((await fetch(`${base}/search?match=unknown`)).status, 400);
    assert.equal((await fetch(`${base}/directory?path=a&path=b`)).status, 400);
  });
});

test('archive route serves an attachment and validates its folder path', async () => {
  const bytes = Buffer.from([0x50, 0x4b, 0, 255]);
  const services = createFakeServices({
    openFolderArchive: async (projectId, folderPath, signal) => {
      assert.equal(projectId, 'project-1');
      assert.equal(folderPath, 'nested/directory');
      assert.equal(signal.aborted, false);
      return { filename: 'directory.zip', stream: Readable.from([bytes]) };
    },
  });
  await withFileTreeServer(services, async (url) => {
    const endpoint = `${url}/api/file-tree/projects/project-1/archive`;
    assert.equal((await fetch(endpoint)).status, 400);
    const response = await fetch(`${endpoint}?path=nested%2Fdirectory`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="directory.zip"/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  });
});

test('a failed archive stream terminates its HTTP download', async () => {
  const services = createFakeServices({
    openFolderArchive: async () => ({
      filename: 'incomplete.zip',
      stream: Readable.from((async function* () {
        yield Buffer.from('partial zip');
        throw new Error('File became unreadable');
      })()),
    }),
  });
  await withFileTreeServer(services, async (url) => {
    await assert.rejects(async () => {
      const response = await fetch(`${url}/api/file-tree/projects/project-1/archive?path=folder`);
      await response.arrayBuffer();
    });
  });
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});
