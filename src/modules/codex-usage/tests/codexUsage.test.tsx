import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { CodexUsage } from '@/modules/codex-usage';
import '@/modules/i18n';
import type { CodexRateLimits } from '@/shared/types';

const data: CodexRateLimits = {
  limits: [
    { id: 'review', name: 'Review', planType: 'pro', windows: [
      { kind: 'primary', windowDurationMins: 10_080, usedPercent: 91, resetsAt: null },
    ] },
    { id: 'codex', name: null, planType: 'pro', windows: [
      { kind: 'primary', windowDurationMins: 300, usedPercent: 13, resetsAt: '2030-04-03T17:00:00Z' },
      { kind: 'secondary', windowDurationMins: 10_080, usedPercent: 34.5, resetsAt: '2030-04-05T21:00:00Z' },
    ] },
  ],
  resetCreditsAvailable: 3,
  resetCredits: [
    { id: 'coupon', title: 'Monthly reset', status: 'available', description: null, expiresAt: null },
    { id: 'expired', title: 'Expired reset', status: 'available', description: null, expiresAt: '2001-01-01T00:00:00Z' },
    { id: 'unknown', title: 'Unknown expiration', status: 'available', description: null },
  ],
};

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }));

function mockAccount(consume?: () => Response | Promise<Response>, snapshot = data) {
  // Every request terminates in this stub, including explicit simulated redemptions.
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    if (url === '/api/providers/codex/rate-limits?details=false') return json({ ...snapshot, resetCredits: null });
    if (url === '/api/providers/codex/rate-limits') return json(snapshot);
    if (url === '/api/providers/codex/reset-credits/consume' && options.method === 'POST' && consume) return consume();
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

test('summary reads only the main weekly window and opens all limits and credits on demand', async () => {
  const fetch = mockAccount();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<CodexUsage />);
  const trigger = await screen.findByRole('button', { name: /Codex weekly · 34.5% used/ });
  const time = new Date('2030-04-05T21:00:00Z').toLocaleString('en', {
    month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  expect(trigger.textContent).toContain(time);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/providers/codex/rate-limits?details=false']);

  fireEvent.click(trigger);
  const dialog = within(await screen.findByRole('dialog', { name: 'Codex usage details' }));
  const reset = await dialog.findByRole('button', { name: 'Use reset…' });
  expect(dialog.getAllByRole('progressbar')).toHaveLength(3);
  expect(dialog.getByText('3 available')).toBeTruthy();
  expect(dialog.getAllByRole('button', { name: 'Use reset…' })).toHaveLength(1);
  fireEvent.click(reset);
  expect(confirm.mock.calls[0][0]).toContain('Monthly reset');
  fireEvent.click(dialog.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(fetch.mock.calls).toHaveLength(3));
  fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
  expect(fetch.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true);
});

test('an ambiguous confirmed reset only retries after another confirmation and reuses its idempotency key', async () => {
  const consume = vi.fn().mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce(json({ outcome: 'alreadyRedeemed' }));
  const fetch = mockAccount(consume);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<CodexUsage />);
  fireEvent.click(await screen.findByRole('button', { name: /34.5% used/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use reset…' }));
  await screen.findByText('Could not confirm the reset. Check the updated limits before trying again.');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Use reset…' }) as HTMLButtonElement).disabled).toBe(false));
  expect(consume).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Use reset…' }));
  await screen.findByText('This reset was already used.');
  const posts = fetch.mock.calls.filter(([, options]) => options.method === 'POST')
    .map(([, options]) => JSON.parse(String(options.body)));
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual({ confirmed: true, creditId: 'coupon', idempotencyKey: expect.any(String) });
  expect(posts[1]).toEqual(posts[0]);
  expect(confirm).toHaveBeenCalledTimes(2);
});

test('absence of a weekly window does not turn shorter limits into a weekly percentage', async () => {
  mockAccount(undefined, {
    limits: [{ ...data.limits[1], windows: [data.limits[1].windows[0]] }],
    resetCreditsAvailable: 1, resetCredits: null,
  });
  render(<CodexUsage />);
  fireEvent.click(await screen.findByRole('button', { name: /Codex weekly usage · Unavailable/ }));
  await screen.findByText('Details are unavailable for some free resets.');
  expect(screen.queryByRole('button', { name: 'Use reset…' })).toBeNull();
});
