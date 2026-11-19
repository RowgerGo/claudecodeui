import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { ProjectFileSearchResult } from '@/shared/types';

const EMPTY_RESULTS: ProjectFileSearchResult = { entries: [], truncated: false };

/** Searches project paths for the file panel, command palette and chat mentions. A null query closes the search. */
export function useProjectFileSearch(
  projectId: string | undefined,
  query: string | null,
  { limit, filesOnly = false }: { limit?: number; filesOnly?: boolean } = {},
) {
  // A retry starts a new request even when the user keeps the same query.
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const request = useMemo(
    () => projectId && query !== null ? { projectId, query, limit, filesOnly, revision } : null,
    [projectId, query, limit, filesOnly, revision],
  );
  // Associate completed matches with the originating request so a project switch or late response cannot show stale paths.
  const [completed, setCompleted] = useState<{
    request: NonNullable<typeof request>;
    result: ProjectFileSearchResult;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.searchProjectFiles(request.projectId, request.query, {
          signal: controller.signal, limit: request.limit, filesOnly: request.filesOnly,
        });
        const result = await readApiJson<ProjectFileSearchResult>(response);
        if (!controller.signal.aborted) setCompleted({ request, result, error: null });
      } catch (error) {
        if (!controller.signal.aborted) {
          setCompleted({ request, result: EMPTY_RESULTS, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [request]);

  // Reopening the same query can show its previous matches while fetching changes made by other tools.
  const sameQuery = request && completed && request.projectId === completed.request.projectId
    && request.query === completed.request.query && request.filesOnly === completed.request.filesOnly
    && request.limit === completed.request.limit;
  return {
    ...(sameQuery ? completed.result : EMPTY_RESULTS),
    loading: !!request && completed?.request !== request,
    error: request && completed?.request === request ? completed.error : null,
    refresh,
  };
}
