import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent, RefObject } from 'react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard for #1367: a file added after the composer loaded the
 * project's file list (an upload, an agent edit, a terminal command) must be
 * offered by the `@` dropdown the next time the user types `@`, without a page
 * reload or a project switch.
 */

const searchFiles = vi.fn();

vi.mock(import('@/shared/api'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, api: { ...actual.api, searchProjectFiles: (...args) => searchFiles(...args) } };
});

const { useFileMentions } = await import('@/modules/chat/hooks/useFileMentions');

const ROOT = '/home/user/project';
const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT };

const searchResponse = (paths: string[]) => ({
  ok: true,
  json: async () => ({
    entries: paths.map(relativePath => ({
      type: 'file', name: relativePath.split('/').pop(), relativePath, path: `${ROOT}/${relativePath}`,
    })),
    truncated: false,
  }),
});

const deferredResponse = () => {
  let resolve!: (value: ReturnType<typeof searchResponse>) => void;
  const promise = new Promise<ReturnType<typeof searchResponse>>(done => { resolve = done; });
  return { promise, resolve };
};

const keyEvent = (key: string) =>
  ({ key, preventDefault: () => {} }) as unknown as KeyboardEvent<HTMLTextAreaElement>;

const renderMentions = () => {
  const textareaRef: RefObject<HTMLTextAreaElement> = { current: null };
  const hook = renderHook(
    ({ input }: { input: string }) =>
      useFileMentions({ selectedProject: project, input, setInput: vi.fn(), textareaRef }),
    { initialProps: { input: '' } },
  );

  // Mirrors the composer: the input changes and the caret follows it.
  const type = (input: string) => {
    hook.rerender({ input });
    act(() => {
      hook.result.current.setCursorPosition(input.length);
    });
  };

  const shownNames = () => hook.result.current.filteredFiles.map((file) => file.name);

  return { ...hook, type, shownNames };
};

test('searches only while a mention is active, and finds a new file in an unopened directory on reopen', async () => {
  searchFiles.mockReset().mockResolvedValueOnce(searchResponse([]))
    .mockResolvedValueOnce(searchResponse(['deep/new/uploaded.txt']));
  const { type, shownNames, result } = renderMentions();
  assert.equal(searchFiles.mock.calls.length, 0);
  type('@upl');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  type('@upl ');
  type('@upl @upl');
  await waitFor(() => assert.deepEqual(shownNames(), ['uploaded.txt']));
  assert.equal(searchFiles.mock.calls[1][1], 'upl');
  assert.equal(searchFiles.mock.calls[1][2].limit, 10);
  assert.equal(result.current.filteredFiles[0].path, 'deep/new/uploaded.txt');
});

test('rapid keystrokes are combined into a single bounded search', async () => {
  searchFiles.mockReset().mockResolvedValue(searchResponse(['a.txt']));
  const { type, shownNames } = renderMentions();
  type('@');
  type('@a');
  type('@a.');
  type('@a.t');
  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));
  assert.equal(searchFiles.mock.calls.length, 1);
  assert.equal(searchFiles.mock.calls[0][1], 'a.t');
});

test('an older query cannot replace results after a newer one completes', async () => {
  const older = deferredResponse();
  searchFiles.mockReset().mockReturnValueOnce(older.promise).mockResolvedValueOnce(searchResponse(['new.txt']));
  const { type, shownNames } = renderMentions();
  type('@old');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  type('@new');
  await waitFor(() => assert.deepEqual(shownNames(), ['new.txt']));
  assert.equal(searchFiles.mock.calls[0][2].signal.aborted, true);
  await act(async () => older.resolve(searchResponse(['old.txt'])));
  assert.deepEqual(shownNames(), ['new.txt']);
});

test('reopening an identical query retains its previous results while refreshing them', async () => {
  const refresh = deferredResponse();
  searchFiles.mockReset().mockResolvedValueOnce(searchResponse(['a.txt'])).mockReturnValueOnce(refresh.promise);
  const { type, shownNames } = renderMentions();
  type('@');
  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));
  type('@ ');
  type('@ @');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));
  assert.deepEqual(shownNames(), ['a.txt']);
  await act(async () => refresh.resolve(searchResponse(['a.txt', 'new.txt'])));
  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt', 'new.txt']));
});

test('Escape cancels an in-flight query, leaves Enter for the composer and allows the next edit', async () => {
  const pending = deferredResponse();
  searchFiles.mockReset().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(searchResponse(['new.txt']));
  const { type, result, shownNames } = renderMentions();
  type('mail foo@');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  act(() => { result.current.handleFileMentionsKeyDown(keyEvent('Escape')); });
  await act(async () => pending.resolve(searchResponse(['old.txt'])));
  assert.equal(result.current.showFileDropdown, false);
  assert.equal(result.current.handleFileMentionsKeyDown(keyEvent('Enter')), false);
  type('mail foo@ne');
  await waitFor(() => assert.deepEqual(shownNames(), ['new.txt']));
});
