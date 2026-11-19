import { afterEach, expect, test, vi } from 'vitest';

import { downloadProjectFolder } from '@/shared/api';
import { downloadBlob } from '@/shared/utils';

vi.mock(import('@/shared/utils'), async (importOriginal) => ({
  ...await importOriginal(),
  downloadBlob: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.removeItem('auth-token');
});

test('pipes archive bytes directly to the selected file using an authenticated request', async () => {
  let written: Uint8Array | undefined;
  const writable = new WritableStream<Uint8Array>({ write: chunk => { written = chunk; } });
  const picker = vi.fn(async () => ({ createWritable: async () => writable }));
  vi.stubGlobal('showSaveFilePicker', picker);
  const fetch = vi.fn(async () => new Response(new Uint8Array([1, 0, 255])));
  vi.stubGlobal('fetch', fetch);
  localStorage.setItem('auth-token', 'test-token');

  await downloadProjectFolder('project', '/repo/文档');
  expect(picker).toHaveBeenCalledWith({ suggestedName: '文档.zip' });
  expect(fetch).toHaveBeenCalledWith('/api/file-tree/projects/project/archive?path=%2Frepo%2F%E6%96%87%E6%A1%A3', expect.objectContaining({
    headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
  }));
  expect(Array.from(written ?? [])).toEqual([1, 0, 255]);
  expect(downloadBlob).not.toHaveBeenCalled();
});

test('delivers the server archive through browser downloads when the picker is unavailable', async () => {
  vi.stubGlobal('showSaveFilePicker', undefined);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('archive')));
  await downloadProjectFolder('p', 'dir');
  expect(downloadBlob).toHaveBeenCalledWith(expect.objectContaining({ size: 7 }), 'dir.zip');
});

test('dismissing the picker cancels before generating an archive', async () => {
  vi.stubGlobal('showSaveFilePicker', vi.fn(async () => { throw new DOMException('Cancelled', 'AbortError'); }));
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(downloadProjectFolder('p', 'dir')).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).not.toHaveBeenCalled();
});
