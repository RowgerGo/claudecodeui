import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';

import { openArchiveFile } from '@/modules/file-tree/file-tree-archive-filesystem.js';
import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeStats,
} from '@/shared/types.js';
import { AppError, resolveReadOnlyRootPath, validateWorkspacePath } from '@/shared/utils.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    openArchiveFile: unexpectedOperation,
    ...overrides,
  };
}

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async () => null,
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  };
}

test('listProjectFiles applies gitignore alongside hard directory exclusions', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const gitDirectory = path.join(projectRoot, '.git');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return '*.log';
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.git', true),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('README.md', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [createDirectoryEntry('build', true)];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('foo.md', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [createDirectoryEntry('index.ts', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === documentationDirectory
        || candidatePath === buildDocumentationDirectory
        || candidatePath === sourceDirectory
        || candidatePath === gitDirectory
        || candidatePath === nodeModulesDirectory,
      0o754,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'src', 'README.md']);
  const documentationEntry = tree[0];
  assert.deepEqual(documentationEntry?.children?.map((entry) => entry.name), ['build']);
  assert.deepEqual(documentationEntry?.children?.[0]?.children?.map((entry) => entry.name), ['foo.md']);
  const sourceEntry = tree[1];
  assert.ok(sourceEntry);
  assert.equal(sourceEntry.type, 'directory');
  assert.equal(sourceEntry.permissions, '754');
  assert.equal(sourceEntry.permissionsRwx, 'rwxr-xr--');
  assert.deepEqual(sourceEntry.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(gitDirectory), false);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
});

test('listProjectFiles excludes gitignored entries only when requested', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const cacheDirectory = path.join(projectRoot, 'cache');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return ['*.log', '!keep.log', 'cache/', 'src/generated.ts'].join('\n');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.gitignore', false),
          createDirectoryEntry('cache', true),
          createDirectoryEntry('ignored.log', false),
          createDirectoryEntry('keep.log', false),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === cacheDirectory) {
        return [createDirectoryEntry('cached.txt', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [
          createDirectoryEntry('generated.ts', false),
          createDirectoryEntry('index.ts', false),
        ];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === cacheDirectory || candidatePath === sourceDirectory,
      0o644,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['src', '.gitignore', 'keep.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(cacheDirectory), false);
});

test('listProjectFiles falls back to conventional directory names when no gitignore exists', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('debug.log', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('node_modules', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [
          createDirectoryEntry('build', true),
          createDirectoryEntry('guide.md', false),
        ];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('generated.md', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(candidatePath === documentationDirectory, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'debug.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['guide.md']);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
  assert.equal(readDirectories.includes(buildDocumentationDirectory), false);
});

test('listProjectFiles rejects a tree that exceeds the server entry limit', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? Array.from({ length: 10_001 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false))
      : []),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('listProjectFiles abandons a directory stream as soon as the entry limit is passed', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Endless on purpose: the walk has to stop consuming the stream itself
    // instead of waiting for the directory listing to be materialized.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; ; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
  // The budget plus the single entry that proves it was exceeded.
  assert.equal(streamedEntries, 10_001);
});

test('listProjectFiles shares the entry limit across nested directories', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const firstDirectory = path.join(projectRoot, 'first');
  const secondDirectory = path.join(projectRoot, 'second');
  const directoryPaths = new Set([firstDirectory, secondDirectory]);
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('first', true),
          createDirectoryEntry('second', true),
        ];
      }
      if (directoryPaths.has(directoryPath)) {
        return Array.from(
          { length: 5_000 },
          (_, index) => createDirectoryEntry(`${path.basename(directoryPath)}-${index}.txt`, false),
        );
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(directoryPaths.has(candidatePath), 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('directory listing pages a wide directory without walking children or statting off-page entries', async () => {
  const root = path.resolve('file-tree-test-project');
  const count = 10_017;
  const entries = Array.from({ length: count }, (_, i) =>
    createDirectoryEntry(`item-${String(count - i).padStart(5, '0')}`, false));
  entries.push(createDirectoryEntry('src', true));
  let statsRead = 0;
  const service = createFileTreeService(createDependencies(createFakeFileSystem({
    realpath: async (candidate) => candidate,
    stat: async () => createStats(true, 0o755),
    readTextFile: async () => '',
    openDirectory: createDirectoryReader((dir) => {
      assert.equal(dir, root);
      return entries;
    }),
    lstat: async () => {
      statsRead++;
      return createStats(false, 0o644);
    },
  }), root));

  const page = await service.listProjectDirectory('project', { path: '', childName: 'item-10017' });
  assert.equal(page.entries.length, 200);
  assert.equal(statsRead, 201);
  assert.equal(page.entries[0].name, 'src');
  assert.equal(page.entries[0].children, undefined);
  assert.equal(page.matchedEntry?.name, 'item-10017');
  assert.ok(page.nextCursor);
  // Remove an entry before the cursor and reorder the directory as a real
  // filesystem can between requests. The continuation still starts correctly.
  entries.splice(entries.findIndex((entry) => entry.name === 'item-00001'), 1);
  entries.reverse();
  const second = await service.listProjectDirectory('project', { path: root, cursor: page.nextCursor });
  assert.equal(second.entries[0].name, 'item-00200');
  assert.equal(second.entries.at(-1)?.name, 'item-00399');
  const last = await service.listProjectDirectory('project', { path: root, cursor: '1item-10000' });
  assert.equal(last.entries.length, 17);
  assert.equal(last.nextCursor, null);
});

test('search reaches unopened deep folders, applies ignores, limits results and matches partial paths', async () => {
  const root = path.resolve('file-tree-test-project');
  const segments = Array.from({ length: 12 }, (_, i) => `level-${i}`);
  const deep = path.join(root, ...segments);
  const listed = new Set<string>();
  const service = createFileTreeService(createDependencies(createFakeFileSystem({
    realpath: async (candidate) => candidate,
    stat: async () => createStats(true, 0o755),
    readTextFile: async () => 'generated/',
    lstat: async () => createStats(false, 0o644),
    openDirectory: createDirectoryReader((dir) => {
      listed.add(dir);
      if (dir === root) return [
        createDirectoryEntry('node_modules', true), createDirectoryEntry('generated', true),
        createDirectoryEntry('unreadable', true), createDirectoryEntry(segments[0], true),
      ];
      if (dir.endsWith('unreadable')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (dir === deep) return [
        createDirectoryEntry('target.ts', false), createDirectoryEntry('TARGET.ts.map', false),
      ];
      const depth = path.relative(root, dir).split(path.sep).length;
      return [createDirectoryEntry(segments[depth], true)];
    }),
  }), root));

  const results = await service.searchProjectFiles('project', { query: 'TARGET.TS', filesOnly: true, limit: 1 });
  assert.equal(results.truncated, true);
  assert.equal(results.entries[0].relativePath, [...segments, 'target.ts'].join('/'));
  assert.ok(results.entries[0].path.startsWith(root));
  const suffix = await service.searchProjectFiles('project', {
    query: 'level-11/target.ts', filesOnly: true, limit: 10, match: 'suffix',
  });
  assert.deepEqual(suffix.entries.map((entry) => entry.name), ['target.ts']);
  assert.equal(suffix.truncated, false);
  assert.ok(listed.has(path.join(root, 'unreadable')));
  assert.ok(!listed.has(path.join(root, 'generated')));
  assert.ok(!listed.has(path.join(root, 'node_modules')));
});

test('suffix lookup prefers the exact project-relative file over a nested copy', async () => {
  const root = path.resolve('file-tree-test-project');
  const service = createFileTreeService(createDependencies(createFakeFileSystem({
    realpath: async (candidate) => candidate,
    stat: async () => createStats(true, 0o755),
    lstat: async () => createStats(false, 0o644),
    readTextFile: async () => '',
    openDirectory: createDirectoryReader((dir) => {
      if (dir === root) return [createDirectoryEntry('src', true), createDirectoryEntry('nested', true)];
      if (dir === path.join(root, 'nested')) return [createDirectoryEntry('src', true)];
      return [createDirectoryEntry('main.ts', false)];
    }),
  }), root));
  const result = await service.searchProjectFiles('project', {
    query: 'src/main.ts', limit: 1, filesOnly: true, match: 'suffix',
  });
  assert.equal(result.entries[0].relativePath, 'src/main.ts');
  assert.equal(result.truncated, true);
});

test('direct directory requests reject outside, ignored and symlinked paths', async () => {
  const root = path.resolve('file-tree-test-project');
  const service = createFileTreeService(createDependencies(createFakeFileSystem({
    realpath: async (candidate) => candidate === path.join(root, 'link', 'child')
      ? path.resolve('outside', 'child') : candidate,
    stat: async () => createStats(true, 0o755),
    readTextFile: async () => 'generated/',
  }), root));
  for (const requested of ['../outside', 'node_modules/nested', 'generated/child', 'link/child']) {
    await assert.rejects(service.listProjectDirectory('project', { path: requested }), (error: unknown) =>
      error instanceof AppError && error.statusCode === 403);
  }
});

test('aborted searches close the directory iterator without examining the remaining entries', async () => {
  const root = path.resolve('file-tree-test-project');
  const controller = new AbortController();
  let closed = false;
  const service = createFileTreeService(createDependencies(createFakeFileSystem({
    realpath: async (candidate) => candidate,
    stat: async () => createStats(true, 0o755),
    readTextFile: async () => '',
    openDirectory: async function* () {
      try {
        yield createDirectoryEntry('first.ts', false);
        controller.abort();
        yield createDirectoryEntry('next.ts', false);
        assert.fail('search must stop reading');
      } finally {
        closed = true;
      }
    },
  }), root));
  await assert.rejects(service.searchProjectFiles('project', {
    query: 'unmatched', limit: 10, filesOnly: true, signal: controller.signal,
  }), { name: 'AbortError' });
  assert.equal(closed, true);
});

test('readTextFile rejects traversal before invoking the filesystem adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'should not be read';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', '../secret.txt'),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_PROJECT'
      && error.statusCode === 403,
  );
  assert.deepEqual(readPaths, []);
});

test('readTextFile reports a directory as a client error, not a 500', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    readTextFile: async () => {
      const error = new Error('EISDIR: illegal operation on a directory, read');
      (error as NodeJS.ErrnoException).code = 'EISDIR';
      throw error;
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'decisions'),
    (error: unknown) => error instanceof AppError
      && error.code === 'EISDIR'
      && error.statusCode === 400
      && error.message === 'Path is a directory, not a file',
  );
});

test('createEntry performs filesystem mutation only through the injected adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const targetPath = path.join(projectRoot, 'notes.txt');
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (candidatePath === targetPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    writeTextFile: async (filePath, content) => {
      writtenFiles.push({ filePath, content });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'notes.txt',
  });

  assert.equal(result.path, targetPath);
  assert.deepEqual(writtenFiles, [{ filePath: targetPath, content: '' }]);
});

/**
 * Builds the service against the real filesystem and the real workspace policy,
 * which is the only way to exercise the read-only roots: the whole guarantee
 * rests on `realpath` resolving symlinks before the comparison.
 */
function createRealFileSystemService(projectRoot: string, workspaceRoot = projectRoot): FileTreeServices {
  return createFileTreeService({
    fileSystem: {
      access: (candidatePath) => fsPromises.access(candidatePath),
      stat: (candidatePath) => fsPromises.stat(candidatePath),
      lstat: (candidatePath) => fsPromises.lstat(candidatePath),
      openDirectory: async function* (directoryPath) {
        yield* await fsPromises.opendir(directoryPath);
      },
      realpath: (candidatePath) => fsPromises.realpath(candidatePath),
      readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
      writeTextFile: (filePath, content) => fsPromises.writeFile(filePath, content, 'utf8'),
      async makeDirectory(directoryPath, recursive) {
        await fsPromises.mkdir(directoryPath, { recursive });
      },
      rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
      async removeDirectory(directoryPath) {
        await fsPromises.rm(directoryPath, { recursive: true, force: true });
      },
      unlink: (filePath) => fsPromises.unlink(filePath),
      copyFile: (source, destination) => fsPromises.copyFile(source, destination),
      createReadStream: (filePath) => createReadStream(filePath),
      openArchiveFile,
    },
    projects: { getProjectPathById: async () => projectRoot },
    workspace: {
      rootPath: workspaceRoot,
      validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
      resolveReadOnlyRootPath: (candidatePath) => resolveReadOnlyRootPath(candidatePath),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  });
}

test('folder archives include filtered unopened descendants, raw bytes and empty directories', async (t) => {
  const fixture = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-archive-'));
  t.after(() => fsPromises.rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'project');
  const folder = path.join(root, 'folder');
  await fsPromises.mkdir(path.join(folder, 'nested', 'empty'), { recursive: true });
  await fsPromises.mkdir(path.join(folder, 'node_modules'));
  await fsPromises.writeFile(path.join(root, '.gitignore'), '*.log');
  const bytes = Buffer.from([0, 127, 255, 195, 128]);
  await fsPromises.writeFile(path.join(folder, 'nested', '文件.bin'), bytes);
  await fsPromises.writeFile(path.join(folder, 'ignored.log'), 'excluded');
  await fsPromises.writeFile(path.join(fixture, 'outside.txt'), 'outside');
  await fsPromises.symlink(path.join(fixture, 'outside.txt'), path.join(folder, 'file-link'));
  await fsPromises.symlink(fixture, path.join(folder, 'dir-link'), 'dir');
  const service = createRealFileSystemService(root);
  const signal = new AbortController().signal;
  const archive = await service.openFolderArchive('project-1', 'folder', signal);
  assert.equal(archive.filename, 'folder.zip');
  const zip = await JSZip.loadAsync(await buffer(archive.stream), { checkCRC32: true });
  assert.deepEqual(Object.keys(zip.files).sort(), ['nested/', 'nested/empty/', 'nested/文件.bin']);
  assert.deepEqual(await zip.files['nested/文件.bin'].async('nodebuffer'), bytes);
  for (const forbidden of ['folder/node_modules', 'folder/dir-link', '..']) {
    await assert.rejects(service.openFolderArchive('project-1', forbidden, signal),
      (error: unknown) => error instanceof AppError && error.statusCode === 403);
  }
});

test('cancelling an archive closes its current source without processing another file', async () => {
  const root = path.resolve('file-tree-test-project');
  const source = new Readable({ read() {} });
  const sourceClosed = once(source, 'close');
  let filesOpened = 0;
  const fileSystem = createFakeFileSystem({
    realpath: async (candidate) => candidate,
    readTextFile: async () => '',
    stat: async () => createStats(true, 0o040755),
    lstat: async () => createStats(false, 0o100644),
    openDirectory: createDirectoryReader(() => [
      createDirectoryEntry('first.bin', false), createDirectoryEntry('second.bin', false),
    ]),
    openArchiveFile: async () => {
      filesOpened++;
      return source;
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, root));
  const controller = new AbortController();
  const { stream } = await service.openFolderArchive('project-1', '.', controller.signal);
  const completed = buffer(stream);
  await once(stream, 'data');
  controller.abort();
  await assert.rejects(completed, { name: 'AbortError' });
  await sourceClosed;
  assert.equal(filesOpened, 1);
});

test('the temp directory can be browsed and read, but never written to', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));

  try {
    // The shape a task notification quotes: an agent's output file written to
    // the system temp directory, outside every project.
    await fsPromises.mkdir(path.join(temporaryDirectory, 'tasks'));
    const outputPath = path.join(temporaryDirectory, 'tasks', 'agent.output');
    await fsPromises.writeFile(outputPath, 'what the agent found', 'utf8');

    const service = createRealFileSystemService(projectRoot);

    const browsed = await service.browseWorkspace(temporaryDirectory);
    assert.deepEqual(browsed.suggestions.map((entry) => entry.name), ['tasks']);

    const opened = await service.readTextFile('project-1', outputPath);
    assert.equal(opened.content, 'what the agent found');

    const streamed = await service.openFile('project-1', outputPath);
    streamed.stream.destroy();

    // Read-only means read-only: nothing may be created or changed there.
    await assert.rejects(
      service.saveTextFile('project-1', outputPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.createWorkspaceFolder(path.join(temporaryDirectory, 'new-folder')),
      (error: unknown) => (error as AppError).code === 'INVALID_WORKSPACE_PATH',
    );
    await assert.rejects(
      service.createEntry({
        projectId: 'project-1',
        parentPath: path.join(temporaryDirectory, 'tasks'),
        type: 'file',
        name: 'planted.txt',
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: outputPath, newName: 'renamed.output' }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    const uploadedTemporaryPath = path.join(projectRoot, 'upload.tmp');
    await fsPromises.writeFile(uploadedTemporaryPath, 'upload', 'utf8');
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: path.join(temporaryDirectory, 'tasks'),
        relativePaths: [],
        requestedFileCount: 1,
        files: [{ originalName: 'upload.txt', temporaryPath: uploadedTemporaryPath, size: 6, mimeType: 'text/plain' }],
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: outputPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.deepEqual(await fsPromises.readdir(path.join(temporaryDirectory, 'tasks')), ['agent.output']);
    assert.equal(await fsPromises.readFile(outputPath, 'utf8'), 'what the agent found');
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('reading through a symlink out of the temp directory is still refused', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  // The link target has to sit under no read-only root. Beside this file is
  // deterministic; a directory under `$HOME` lands under `/tmp` whenever a
  // test run isolates its home there, and the Claude projects directory is a
  // read-only root too.
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    assert.equal(await resolveReadOnlyRootPath(outsideDirectory), null);
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(temporaryDirectory, 'escape'));

    const service = createRealFileSystemService(projectRoot);
    await assert.rejects(
      service.readTextFile('project-1', path.join(temporaryDirectory, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('a file in another folder of the workspace can be read, but never written to', async () => {
  // Both sit beside this file, outside every read-only root, for the reason
  // given in the symlink test above.
  const workspaceRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-workspace-'));
  const projectRoot = path.join(workspaceRoot, 'project');
  const siblingDirectory = path.join(workspaceRoot, '.runs', 'run-1');
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    await fsPromises.mkdir(projectRoot);
    await fsPromises.mkdir(siblingDirectory, { recursive: true });
    const reportPath = path.join(siblingDirectory, 'report.md');
    await fsPromises.writeFile(reportPath, 'what the run found', 'utf8');
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(workspaceRoot, 'escape'));

    const service = createRealFileSystemService(projectRoot, workspaceRoot);

    const opened = await service.readTextFile('project-1', reportPath);
    assert.equal(opened.content, 'what the run found');
    const streamed = await service.openFile('project-1', reportPath);
    streamed.stream.destroy();

    await assert.rejects(
      service.saveTextFile('project-1', reportPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: reportPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.equal(await fsPromises.readFile(reportPath, 'utf8'), 'what the run found');

    // A link inside the workspace does not open what lies outside it.
    await assert.rejects(
      service.readTextFile('project-1', path.join(workspaceRoot, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});
