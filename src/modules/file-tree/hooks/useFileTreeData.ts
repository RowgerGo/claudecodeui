import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { FileDirectoryPage, FileTreeNode } from '@/shared/types';

type DirectoryListing = {
  entries: FileTreeNode[];
  nextCursor: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  failedCursor?: string;
  // Entries revealed outside the loaded pages stay at the end until their sorted page arrives.
  extraPaths: Set<string>;
};

const EMPTY_DIRECTORY: DirectoryListing = {
  entries: [], nextCursor: null, loading: false, loaded: false, error: null, extraPaths: new Set(),
};

/** Used by the Files panel to cache independently paginated directory listings for its mounted project. */
export function useFileTreeData(projectId: string | undefined, projectRoot: string) {
  // Each directory owns its rows, cursor and request status, including when its parent is collapsed.
  const [directories, setDirectories] = useState<Map<string, DirectoryListing>>(() => new Map());
  // Async reveal walks need the latest listing between requests, before React's next render.
  const latest = useRef(directories);
  const requests = useRef(new Map<string, { controller: AbortController; done: Promise<void>; childName?: string }>());
  const active = useRef(false);

  const keyFor = useCallback((path: string) => {
    const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const root = normalize(projectRoot);
    const key = normalize(path);
    return key === root ? '' : key.startsWith(root + '/') ? key.slice(root.length + 1) : key;
  }, [projectRoot]);

  const publish = useCallback((path: string, listing: DirectoryListing) => {
    const next = new Map(latest.current);
    next.set(path, listing);
    latest.current = next;
    setDirectories(next);
  }, []);

  const load = useCallback(async function loadDirectory(
    path: string,
    options: { cursor?: string; childName?: string; refresh?: boolean } = {},
  ): Promise<DirectoryListing | undefined> {
    if (!projectId || !active.current) return;
    const key = keyFor(path);
    const { cursor, childName, refresh } = options;
    const pending = requests.current.get(key);
    if (pending) {
      if (refresh) {
        pending.controller.abort();
      } else {
        await pending.done;
        if (!active.current || pending.controller.signal.aborted) return;
        if (!childName || childName === pending.childName) return latest.current.get(key);
        // Serialize a targeted lookup behind any other request for its parent.
        return loadDirectory(path, options);
      }
    }

    const previous = latest.current.get(key) ?? EMPTY_DIRECTORY;
    const hasChild = !childName || previous.entries.some((entry) => entry.name === childName);
    if (!refresh && !cursor && previous.loaded && hasChild) return previous;

    const controller = new AbortController();
    publish(key, { ...previous, loading: true, error: null });
    const fetchPage = async () => {
      try {
        const response = await api.listFileDirectory(projectId, path, cursor, { signal: controller.signal }, childName);
        const page = await readApiJson<FileDirectoryPage>(response);
        if (controller.signal.aborted) return;
        // A targeted lookup can add a child beyond the current pages without moving their cursor.
        const lookup = !!childName && previous.loaded && !refresh;
        const entries = new Map<string, FileTreeNode>();
        const extras = new Map<string, FileTreeNode>();
        if (cursor || lookup) {
          for (const entry of previous.entries) {
            (previous.extraPaths.has(entry.path) ? extras : entries).set(entry.path, entry);
          }
        }
        if (!lookup) page.entries.forEach((entry) => {
          extras.delete(entry.path);
          entries.set(entry.path, entry);
        });
        if (page.matchedEntry && !entries.has(page.matchedEntry.path)) {
          extras.set(page.matchedEntry.path, page.matchedEntry);
        }
        publish(key, {
          entries: [...entries.values(), ...extras.values()], extraPaths: new Set(extras.keys()),
          nextCursor: lookup ? previous.nextCursor : page.nextCursor,
          loading: false, loaded: true, error: null,
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          publish(key, {
            ...previous, loading: false, error: error instanceof Error ? error.message : String(error),
            failedCursor: cursor,
          });
        }
      }
    };

    const done = fetchPage();
    requests.current.set(key, { controller, done, childName });
    await done;
    if (requests.current.get(key)?.controller === controller) requests.current.delete(key);
    if (!controller.signal.aborted) return latest.current.get(key);
  }, [keyFor, projectId, publish]);

  useEffect(() => {
    active.current = true;
    void load('');
    const pending = requests.current;
    return () => {
      active.current = false;
      for (const request of pending.values()) request.controller.abort();
      pending.clear();
    };
  }, [load]);

  // Evict deleted/renamed directory contents, so a later folder with the same name starts fresh.
  const invalidate = useCallback((path: string) => {
    const key = keyFor(path);
    const next = new Map(latest.current);
    for (const cachedKey of next.keys()) {
      if (cachedKey === key || cachedKey.startsWith(key + '/')) {
        requests.current.get(cachedKey)?.controller.abort();
        requests.current.delete(cachedKey);
        next.delete(cachedKey);
      }
    }
    latest.current = next;
    setDirectories(next);
  }, [keyFor]);

  const refreshDirectory = useCallback((path: string, removedPath?: string) => {
    if (!active.current) return;
    if (removedPath) invalidate(removedPath);
    if (latest.current.has(keyFor(path))) void load(path, { refresh: true });
  }, [invalidate, keyFor, load]);

  const refreshTree = (expanded: Set<string>) => {
    const visible = new Set(['', ...Array.from(expanded, keyFor)]);
    const next = new Map(latest.current);
    for (const key of next.keys()) {
      if (!visible.has(key)) {
        requests.current.get(key)?.controller.abort();
        requests.current.delete(key);
        next.delete(key);
      }
    }
    latest.current = next;
    setDirectories(next);
    // Explicit refresh also expires collapsed directories, which will reload on their next expansion.
    for (const key of visible) refreshDirectory(key);
  };

  const getDirectory = (path: string) => directories.get(keyFor(path)) ?? EMPTY_DIRECTORY;

  return { getDirectory, load, refreshDirectory, refreshTree };
}
