import assert from 'node:assert/strict';

import { test } from 'vitest';

import { directoryRevealSegments } from '@/modules/file-tree/utils/revealDirectory';

test('relative chat references and absolute search results identify the same ancestor sequence', () => {
  const root = '/home/workspace/project';
  for (const ref of ['./src/modules/', 'src/modules', root + '/src/modules/']) {
    assert.deepEqual(directoryRevealSegments(root, ref), ['src', 'modules']);
  }
  assert.deepEqual(directoryRevealSegments('C:\\Users\\project', 'C:\\Users\\project\\src'), ['src']);
});

test('reveal ignores roots, sibling projects with a common prefix and upward traversal', () => {
  const root = '/home/workspace/project';
  for (const ref of [root, '/etc/ssl', root + '-backup/src', '../sibling/file']) {
    assert.deepEqual(directoryRevealSegments(root, ref), []);
  }
});
