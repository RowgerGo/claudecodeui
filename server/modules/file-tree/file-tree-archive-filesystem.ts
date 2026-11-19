import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { Readable } from 'node:stream';

/** Used by the File Tree filesystem adapter to read only the verified file into a ZIP. */
export async function openArchiveFile(canonicalPath: string): Promise<Readable> {
  // Nonblocking open also lets us safely reject a file replaced with a FIFO.
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    const named = await lstat(canonicalPath);
    if (!opened.isFile() || named.dev !== opened.dev || named.ino !== opened.ino
        || await realpath(canonicalPath) !== canonicalPath) {
      throw new Error('Archive file changed during download');
    }
    return handle.createReadStream();
  } catch (error) {
    await handle.close();
    throw error;
  }
}
