import { once } from 'node:events';
import { constants } from 'node:fs';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';

import ZipStream, { type FileDataInput } from 'zip-stream';

import type { FileTreeDirectoryContext, FileTreeFileSystem } from '@/shared/types.js';

/** Builds the selected-directory download for the File Tree service with one open file at a time. */
export function createFolderArchive(
  fileSystem: FileTreeFileSystem,
  directoryContext: FileTreeDirectoryContext,
  requestSignal: AbortSignal,
): { filename: string; stream: Readable } {
  requestSignal.throwIfAborted();
  const { projectRoot, canonicalRoot, directoryPath, includeEntry } = directoryContext;
  const archive = new ZipStream();
  const stream = new PassThrough({ signal: requestSignal });
  archive.on('error', (error: Error) => stream.destroy(error));
  archive.pipe(stream);
  const closed = new AbortController();
  const signal = AbortSignal.any([requestSignal, closed.signal]);
  stream.once('close', () => {
    closed.abort();
    archive.destroy();
  });

  async function append(source: Readable | null, data: FileDataInput): Promise<void> {
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        archive.entry(source ?? Buffer.alloc(0), data, (error) => {
          signal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve();
        });
      });
      // Headers from a sequence of empty directories can also fill the output
      // buffer. Wait for their consumer before opening another input.
      if (archive.writableNeedDrain) await once(archive, 'drain', { signal });
    } finally {
      source?.destroy();
    }
  }

  async function writeArchive(): Promise<void> {
    const pending = [directoryPath];
    while (pending.length > 0) {
      signal.throwIfAborted();
      const directory = pending.pop()!;
      const canonicalDirectory = path.join(canonicalRoot, path.relative(projectRoot, directory));
      // A directory may have been replaced by a link since its parent was listed.
      if (await fileSystem.realpath(directory) !== canonicalDirectory) {
        throw new Error('Archive directory changed during download');
      }
      for await (const entry of fileSystem.openDirectory(canonicalDirectory)) {
        signal.throwIfAborted();
        const child = path.join(directory, entry.name);
        if (!includeEntry(child, entry.isDirectory())) continue;
        const canonicalPath = path.join(canonicalDirectory, entry.name);
        const stats = await fileSystem.lstat(canonicalPath);
        if (stats.isSymbolicLink()) continue;
        // ZIP readers interpret backslashes as separators even on POSIX. Fail
        // visibly if the portable archive name would differ from the real name.
        const name = path.relative(directoryPath, child).split(path.sep).join('/');
        if (name.includes('\\') || /^\w+:/.test(name)) {
          throw new Error(`Cannot represent the file name in a ZIP archive: ${name}`);
        }
        const data = { name, date: stats.mtime, mode: stats.mode };
        if (stats.isDirectory()) {
          if (!includeEntry(child, true)) continue;
          await append(null, { ...data, type: 'directory' });
          pending.push(child);
        } else if ((stats.mode & constants.S_IFMT) === constants.S_IFREG) {
          const source = await fileSystem.openArchiveFile(canonicalPath);
          await append(source, data);
        }
      }
    }
    signal.throwIfAborted();
    archive.finalize();
  }

  void writeArchive().catch((error: Error) => stream.destroy(error));
  return { filename: `${path.basename(directoryPath) || 'project'}.zip`, stream };
}
