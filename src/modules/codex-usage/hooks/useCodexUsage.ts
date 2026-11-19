import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiRequestError, api, readApiJson } from '@/shared/api';
import type { CodexRateLimits } from '@/shared/types';
import { createChatRequestId } from '@/shared/utils';

const POLL_MS = 60_000;

type Snapshot = {
  data: CodexRateLimits | null;
  details: boolean;
  loading: boolean;
  error: string | null;
};

const RESET_OUTCOMES = ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'] as const;
type ResetOutcome = typeof RESET_OUTCOMES[number];

/** Keeps the header current and requests credit details only while the dialog is open. */
export function useCodexUsage(details: boolean) {
  // Keep the last read available while its replacement is loading.
  const [snapshot, setSnapshot] = useState<Snapshot>({ data: null, details: false, loading: true, error: null });
  // Manual refreshes and completed mutations both require a new read in the current scope.
  const [revision, setRevision] = useState(0);
  // Disables all redemption actions while a confirmed request is in flight.
  const [redeeming, setRedeeming] = useState(false);
  // Reports the most recent user-initiated redemption to the open dialog.
  const [outcome, setOutcome] = useState<ResetOutcome | 'unknown' | null>(null);
  const redemptionInFlight = useRef(false);
  const attempts = useRef(new Map<string, string>());
  const refresh = useCallback(() => setRevision(previous => previous + 1), []);

  useEffect(() => {
    let active: AbortController | null = null;
    const read = async () => {
      if (document.hidden || active || redemptionInFlight.current) return;
      const controller = new AbortController();
      active = controller;
      setSnapshot(previous => ({ ...previous, loading: true, error: null }));
      try {
        const response = await api.providers.codexRateLimits(details, controller.signal);
        const { data } = await readApiJson<{ data: CodexRateLimits }>(response);
        if (!controller.signal.aborted) setSnapshot({ data, details, loading: false, error: null });
      } catch (error) {
        if (!controller.signal.aborted) {
          setSnapshot({ data: null, details: false, loading: false, error: error instanceof ApiRequestError ? error.message : '' });
        }
      } finally {
        active = null;
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    document.addEventListener('visibilitychange', read);
    return () => {
      active?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [details, revision]);

  // Called exclusively by the dialog after the user confirms a specific eligible credit.
  async function consumeConfirmedCredit(creditId: string) {
    if (redemptionInFlight.current) return;
    redemptionInFlight.current = true;
    setRedeeming(true);
    setOutcome(null);
    try {
      // A lost response can conceal a successful reset. Reuse its key on an explicit retry.
      const key = attempts.current.get(creditId) ?? createChatRequestId();
      attempts.current.set(creditId, key);
      const response = await api.providers.consumeCodexResetCredit(creditId, key);
      const { data } = await readApiJson<{ data: { outcome: ResetOutcome } }>(response);
      if (!RESET_OUTCOMES.includes(data.outcome)) throw new Error('Unknown reset outcome');
      attempts.current.delete(creditId);
      setOutcome(data.outcome);
    } catch {
      setOutcome('unknown');
    } finally {
      redemptionInFlight.current = false;
      setRedeeming(false);
      // The old credit list can no longer authorize a second click while we refresh.
      setSnapshot(previous => ({ ...previous, details: false, loading: true }));
      refresh();
    }
  }
  return { snapshot, refresh, redeeming, outcome, consumeConfirmedCredit };
}
