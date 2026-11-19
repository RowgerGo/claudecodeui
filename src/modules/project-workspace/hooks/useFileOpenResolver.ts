import { useCallback, useEffect, useRef } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { CodeEditorDiffInfo, Project, ProjectFileSearchResult } from '@/shared/types';

type OnFileOpen = (filePath: string, diffInfo?: CodeEditorDiffInfo | null, line?: number | null) => void;

const normalize = (value: string): string => value.replace(/\\/g, '/');

// Backslashes are already normalized above, so a Windows path arrives as
// `C:/…`; counting it as absolute lets a Windows server resolve it as-is and a
// POSIX one answer an honest 404 instead of opening some other file.
const isAbsoluteRef = (value: string): boolean => /^(\/|[A-Za-z]:\/)/.test(value);

/** Resolves relative links in chat and the workspace by path suffix, then by exact filename. */
export function useFileOpenResolver(
  selectedProject: Project | null | undefined,
  onFileOpen: OnFileOpen,
) {
  const projectId = selectedProject?.projectId;
  const pending = useRef<AbortController | null>(null);
  const cancelLookup = useCallback(() => pending.current?.abort(), []);
  useEffect(() => cancelLookup, [projectId, cancelLookup]);

  const resolveFile = useCallback<OnFileOpen>((filePath, diffInfo, line) => {
    pending.current?.abort();
    const ref = normalize(filePath).trim();
    if (!projectId || !ref || isAbsoluteRef(ref)) {
      onFileOpen(ref, diffInfo, line);
      return;
    }
    const controller = new AbortController();
    pending.current = controller;

    async function resolveReference() {
      const suffix = ref.replace(/^\.\//, '');
      const basename = suffix.split('/').pop();
      // Try the full suffix first so a same-named file elsewhere cannot mask a more precise reference.
      const candidates = basename && basename !== suffix ? [suffix, basename] : [suffix];
      for (const query of candidates) {
        const response = await api.searchProjectFiles(projectId!, query, {
          filesOnly: true, limit: 1, match: 'suffix', signal: controller.signal,
        });
        const { entries } = await readApiJson<ProjectFileSearchResult>(response);
        if (entries.length) return entries[0].path;
        if (controller.signal.aborted) break;
      }
      return ref;
    }

    void resolveReference().catch(() => ref).then(path => {
      if (!controller.signal.aborted) onFileOpen(path, diffInfo, line);
    });
  }, [projectId, onFileOpen]);

  return { resolveFile, cancelLookup };
}
