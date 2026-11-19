import { useEffect, useRef } from 'react';

/** Refresh an existing file or Git view on return and after an agent turn, preserving its local UI state. */
export function useVisibleToolRefresh(visible: boolean, revision: number, refresh: () => void) {
  // Both views already fetch on mount. Only later activations or worktree revisions need a refresh.
  const previous = useRef({ visible, revision });
  useEffect(() => {
    const needsRefresh = visible && (!previous.current.visible || previous.current.revision !== revision);
    previous.current = { visible, revision };
    if (needsRefresh) refresh();
  }, [visible, revision, refresh]);
}
