import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { api, downloadProjectFolder } from '@/shared/api';
import type { FileTreeNode, Project } from '@/shared/types';
import FileTree from '@/modules/file-tree/FileTree';

const ROOT = '/repo/personal';
const project: Project = { projectId: 'p1', displayName: 'personal', fullPath: ROOT, path: ROOT };
const folder: FileTreeNode = { type: 'directory', name: 'decisions', path: ROOT + '/decisions' };
const file: FileTreeNode = { type: 'file', name: 'first.md', path: folder.path + '/first.md' };

vi.mock(import('@/shared/api'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: { ...actual.api, listFileDirectory: vi.fn(), searchProjectFiles: vi.fn(), deleteFile: vi.fn() },
    downloadProjectFolder: vi.fn(),
  };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.listFileDirectory).mockImplementation(async (_id, path) =>
    Response.json({ entries: path ? [file] : [folder], nextCursor: null }));
});

test('a relative directory reference loads each ancestor and opens the folder', async () => {
  render(<FileTree selectedProject={project} revealDirectory={{ path: 'decisions/' }} />);
  await screen.findByText(file.name);
  assert.deepEqual(vi.mocked(api.listFileDirectory).mock.calls.map((call) => call[1]), ['', folder.path]);
});

test('closed folders stay unfetched and reopening a folder reuses the listing', async () => {
  render(<FileTree selectedProject={project} />);
  const row = await screen.findByText(folder.name);
  assert.equal(Boolean(screen.queryByText(file.name)), false);
  assert.equal(vi.mocked(api.listFileDirectory).mock.calls.length, 1);
  fireEvent.click(row);
  await screen.findByText(file.name);
  fireEvent.click(row);
  assert.equal(Boolean(screen.queryByText(file.name)), false);
  fireEvent.click(row);
  assert.ok(screen.getByText(file.name));
  assert.equal(vi.mocked(api.listFileDirectory).mock.calls.length, 2);
});

test('a nested page failure keeps other rows visible and retries the same cursor', async () => {
  let failPage = true;
  vi.mocked(api.listFileDirectory).mockImplementation(async (_project, path, cursor) => {
    if (!path) return Response.json({ entries: [folder], nextCursor: null });
    if (!cursor) return Response.json({ entries: [file], nextCursor: 'next' });
    if (failPage) return Response.json({ error: 'Temporarily unavailable' }, { status: 503 });
    return Response.json({ entries: [{ ...file, name: 'second.md', path: folder.path + '/second.md' }], nextCursor: null });
  });
  render(<FileTree selectedProject={project} />);
  fireEvent.click(await screen.findByText(folder.name));
  fireEvent.click(await screen.findByText('fileTree.loadMore'));
  await screen.findByText('Temporarily unavailable');
  assert.ok(screen.getByText(folder.name));
  assert.ok(screen.getByText(file.name));
  failPage = false;
  fireEvent.click(screen.getByText('common.retry'));
  await screen.findByText('second.md');
  assert.ok(screen.getByText(file.name));
  assert.equal(Boolean(screen.queryByText('fileTree.loadMore')), false);
  assert.deepEqual(vi.mocked(api.listFileDirectory).mock.calls.map((call) => call[2]), [undefined, undefined, 'next', 'next']);
});

test('a search selects a file in an unopened folder beyond the loaded root page', async () => {
  const sibling = { type: 'directory', name: 'archives', path: ROOT + '/archives' };
  vi.mocked(api.listFileDirectory).mockImplementation(async (_id, path, _cursor, _options, childName) => {
    if (!path) return Response.json({
      entries: [sibling], nextCursor: 'more', matchedEntry: childName === folder.name ? folder : undefined,
    });
    return Response.json({ entries: [file], nextCursor: null });
  });
  vi.mocked(api.searchProjectFiles).mockResolvedValue(Response.json({
    entries: [{ ...file, relativePath: 'decisions/first.md' }], truncated: false,
  }));

  const open = vi.fn();
  render(<FileTree selectedProject={project} onFileOpen={open} />);
  await screen.findByText('archives');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first' } });
  fireEvent.click(await screen.findByText('decisions/first.md'));
  await screen.findByText(file.name);
  assert.ok(screen.getByText(folder.name));
  assert.deepEqual(open.mock.calls, [[file.path]]);
  assert.deepEqual(vi.mocked(api.listFileDirectory).mock.calls.map((call) => [call[1], call[4]]),
    [['', undefined], ['', folder.name], [folder.path, file.name]]);
});

test('ZIP for a collapsed folder uses its archive endpoint without fetching its children', async () => {
  render(<FileTree selectedProject={project} />);
  fireEvent.contextMenu(await screen.findByText(folder.name));
  fireEvent.click(screen.getByText('fileTree.context.download'));
  await waitFor(() => assert.deepEqual(vi.mocked(downloadProjectFolder).mock.calls, [['p1', folder.path]]));
  assert.deepEqual(vi.mocked(api.listFileDirectory).mock.calls.map((call) => call[1]), ['']);
});

test('deleting a nested file refreshes only its containing directory', async () => {
  let deleted = false;
  vi.mocked(api.deleteFile).mockImplementation(async () => { deleted = true; return Response.json({ success: true }); });
  vi.mocked(api.listFileDirectory).mockImplementation(async (_id, path) =>
    Response.json({ entries: path ? (deleted ? [] : [file]) : [folder], nextCursor: null }));
  render(<FileTree selectedProject={project} />);
  fireEvent.click(await screen.findByText(folder.name));
  fireEvent.contextMenu(await screen.findByText(file.name));
  fireEvent.click(screen.getByText('fileTree.context.delete'));
  fireEvent.click(screen.getByText('fileTree.delete.confirm'));
  await waitFor(() => assert.equal(Boolean(screen.queryByText(file.name)), false));
  assert.deepEqual(vi.mocked(api.listFileDirectory).mock.calls.map((call) => call[1]), ['', folder.path, folder.path]);
});

test('switching projects cancels old directory requests before their late response arrives', async () => {
  let settle: (response: Response) => void = () => {};
  const previous = new Promise<Response>((resolve) => { settle = resolve; });
  const otherFile = { ...file, name: 'other.md', path: '/other/other.md' };
  vi.mocked(api.listFileDirectory).mockImplementation(async (id) => id === project.projectId
    ? previous : Response.json({ entries: [otherFile], nextCursor: null }));
  const view = render(<FileTree selectedProject={project} />);
  const signal = vi.mocked(api.listFileDirectory).mock.calls[0][3]?.signal;
  view.rerender(<FileTree selectedProject={{ projectId: 'p2', displayName: 'other', fullPath: '/other' }} />);
  await screen.findByText(otherFile.name);
  assert.equal(signal?.aborted, true);
  await act(async () => settle(Response.json({ entries: [folder], nextCursor: null })));
  assert.equal(Boolean(screen.queryByText(folder.name)), false);
  assert.ok(screen.getByText(otherFile.name));
});
