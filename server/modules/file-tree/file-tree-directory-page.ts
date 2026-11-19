import type { FileTreeDirectoryEntry } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const DIRECTORY_PAGE_SIZE = 200;
const nameOrder = new Intl.Collator();

function entryKey(entry: FileTreeDirectoryEntry): string {
  return (entry.isDirectory() ? '0' : '1') + entry.name;
}

function compareKeys(left: string, right: string): number {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  const byName = nameOrder.compare(left.slice(1), right.slice(1));
  // Distinct filenames (e.g. two Unicode normalizations) can collate equally.
  return byName || (left < right ? -1 : left > right ? 1 : 0);
}

/** Used by the File Tree service to page an unordered directory stream in stable folders-first order. */
export async function readDirectoryPage(
  source: AsyncIterable<FileTreeDirectoryEntry>,
  cursor?: string,
  childName?: string,
) {
  if (cursor !== undefined && !/^[01][\s\S]+$/.test(cursor)) {
    throw new AppError('Invalid directory cursor', { code: 'INVALID_DIRECTORY_CURSOR', statusCode: 400 });
  }

  const candidates: Array<{ key: string; entry: FileTreeDirectoryEntry }> = [];
  let largestKey: string | undefined;
  let matchedEntry: FileTreeDirectoryEntry | undefined;

  // Keep only the smallest page after the cursor. A wide directory costs one
  // scan of its names per page, with bounded memory and no per-entry stat.
  function keepSmallest() {
    candidates.sort((left, right) => compareKeys(left.key, right.key));
    if (candidates.length > DIRECTORY_PAGE_SIZE) {
      candidates.length = DIRECTORY_PAGE_SIZE + 1;
      largestKey = candidates[DIRECTORY_PAGE_SIZE].key;
    }
  }

  for await (const entry of source) {
    if (entry.name === childName) matchedEntry = entry;
    const key = entryKey(entry);
    if (cursor !== undefined && compareKeys(key, cursor) <= 0) continue;
    if (largestKey !== undefined && compareKeys(key, largestKey) >= 0) continue;
    candidates.push({ key, entry });
    if (candidates.length === (DIRECTORY_PAGE_SIZE + 1) * 2) keepSmallest();
  }

  keepSmallest();
  const hasMore = candidates.length > DIRECTORY_PAGE_SIZE;
  if (hasMore) candidates.pop();
  return {
    entries: candidates.map(({ entry }) => entry),
    nextCursor: hasMore ? candidates[candidates.length - 1].key : null,
    matchedEntry,
  };
}
