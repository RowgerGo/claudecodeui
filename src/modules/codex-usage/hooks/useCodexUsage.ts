import { useEffect, useRef, useState } from 'react';

import { ApiRequestError, api, readApiJson } from '@/shared/api';
import type { CodexRateLimits } from '@/shared/types';
import { createChatRequestId } from '@/shared/utils';

type Snapshot = {
  data: CodexRateLimits | null;
  creditsCurrent: boolean;
  loading: boolean;
  error: string | null;
};

const RESET_OUTCOMES = ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'] as const;
type ResetOutcome = typeof RESET_OUTCOMES[number];

/** Reads plan limits and reset credits when the user clicks Refresh in the details dialog. */
export function useCodexUsage() {
  // Keep the last limits visible while fetching and require a fresh read after using a reset credit.
  const [snapshot, setSnapshot] = useState<Snapshot>({ data: null, creditsCurrent: false, loading: false, error: null });
  // Disables all redemption actions while a confirmed request is in flight.
  const [redeeming, setRedeeming] = useState(false);
  // Reports the most recent user-initiated redemption to the open dialog.
  const [outcome, setOutcome] = useState<ResetOutcome | 'unknown' | null>(null);
  const refreshController = useRef<AbortController | null>(null);
  const redemptionInFlight = useRef(false);
  const attempts = useRef(new Map<string, string>());

  useEffect(() => () => refreshController.current?.abort(), []);

  async function refresh() {
    if (refreshController.current || redemptionInFlight.current) return;
    const controller = new AbortController();
    refreshController.current = controller;
    setSnapshot(previous => ({ ...previous, loading: true, error: null }));
    try {
      const response = await api.providers.codexRateLimits(true, controller.signal);
      const { data } = await readApiJson<{ data: CodexRateLimits }>(response);
      if (!controller.signal.aborted) setSnapshot({ data, creditsCurrent: true, loading: false, error: null });
    } catch (error) {
      if (!controller.signal.aborted) {
        setSnapshot({
          data: null,
          creditsCurrent: false,
          loading: false,
          error: error instanceof ApiRequestError ? error.message : '',
        });
      }
    } finally {
      refreshController.current = null;
    }
  }

  // Called exclusively by the dialog after the user confirms a specific eligible credit.
  async function consumeConfirmedCredit(creditId: string) {
    if (redemptionInFlight.current || refreshController.current || !snapshot.creditsCurrent) return;
    redemptionInFlight.current = true;
    setRedeeming(true);
    setOutcome(null);
    // Invalidate the old credit list before applying a reset that may change it.
    setSnapshot(previous => ({ ...previous, creditsCurrent: false }));
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
    }
  }
  return { snapshot, refresh, redeeming, outcome, consumeConfirmedCredit };
}
