import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useGitPanelController } from '@/modules/git-panel/hooks/useGitPanelController';
import { api } from '@/shared/api';
import type { Project } from '@/shared/types';

const project: Project = { projectId: 'one', displayName: 'one', fullPath: '/one' };
const anotherProject: Project = { projectId: 'two', displayName: 'two', fullPath: '/two' };

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, finish: (data: unknown) => resolve(Response.json(data)) };
}

beforeEach(() => {
  vi.spyOn(api.git, 'status').mockImplementation(async () => Response.json({ branch: 'main' }));
  vi.spyOn(api.git, 'branches').mockImplementation(async () => Response.json({ branches: ['main'] }));
  vi.spyOn(api.git, 'remoteStatus').mockImplementation(async () => Response.json({}));
});

test('new status supersedes earlier status and file diffs even if their responses arrive last', async () => {
  const oldStatus = deferredResponse();
  const oldDiff = deferredResponse();
  vi.mocked(api.git.status).mockReturnValueOnce(oldStatus.promise)
    .mockResolvedValueOnce(Response.json({ branch: 'older', modified: ['shared'] }))
    .mockResolvedValueOnce(Response.json({ branch: 'latest', modified: ['shared'] }));
  vi.spyOn(api.git, 'diff').mockReturnValueOnce(oldDiff.promise)
    .mockResolvedValueOnce(Response.json({ diff: 'latest diff' }));
  const { result } = renderHook(() => useGitPanelController({
    selectedProject: project, activeView: 'changes', isVisible: true,
  }));
  act(() => result.current.refreshAll());
  await waitFor(() => expect(api.git.diff).toHaveBeenCalledTimes(1));
  act(() => result.current.refreshAll());
  await waitFor(() => expect(result.current.gitDiff.shared).toBe('latest diff'));
  await act(async () => {
    oldStatus.finish({ branch: 'stale', modified: ['different'] });
    oldDiff.finish({ diff: 'stale diff' });
  });
  expect(result.current.currentBranch).toBe('latest');
  expect(result.current.gitDiff).toEqual({ shared: 'latest diff' });
});

test('a diff opens only for the latest file click in the same visible repository', async () => {
  const onFileOpen = vi.fn();
  const load = vi.spyOn(api.git, 'fileWithDiff');
  const { result, rerender } = renderHook(({ selectedProject, isVisible }) => useGitPanelController({
    selectedProject, isVisible, activeView: 'changes', onFileOpen,
  }), { initialProps: { selectedProject: project, isVisible: true } });
  const pending = (file: string) => {
    const response = deferredResponse();
    load.mockReturnValueOnce(response.promise);
    const opened = result.current.openFile(file);
    return async () => {
      response.finish({ oldContent: 'A', currentContent: 'B' });
      await opened;
    };
  };
  const earlier = pending('a');
  const newer = pending('b');
  await act(newer);
  await act(earlier);
  const hidden = pending('c');
  rerender({ selectedProject: project, isVisible: false });
  rerender({ selectedProject: project, isVisible: true });
  await act(hidden);
  const fromOtherProject = pending('d');
  rerender({ selectedProject: anotherProject, isVisible: true });
  await act(fromOtherProject);
  expect(onFileOpen.mock.calls).toEqual([['b', { old_string: 'A', new_string: 'B' }]]);
});
