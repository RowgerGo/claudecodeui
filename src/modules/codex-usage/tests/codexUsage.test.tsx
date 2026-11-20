import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { CodexUsage } from '@/modules/codex-usage';
import '@/modules/i18n';
import type { CodexRateLimits } from '@/shared/types';

const RATE_LIMITS_URL = '/api/providers/codex/rate-limits';
const CONSUME_CREDIT_URL = '/api/providers/codex/reset-credits/consume';
const TEN_MINUTES = 10 * 60 * 1000;

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

function weeklyUsage(usedPercent: number) {
  const plan = data.limits[1];
  return json({
    ...data,
    limits: [data.limits[0], { ...plan, windows: [plan.windows[0], { ...plan.windows[1], usedPercent }] }],
  });
}

function mockAccount(consume?: () => Response | Promise<Response>, snapshot = data) {
  // Every request terminates in this stub, including explicit simulated redemptions.
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    if (url === RATE_LIMITS_URL) return json(snapshot);
    if (url === CONSUME_CREDIT_URL && options.method === 'POST' && consume) return consume();
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('loads weekly usage on mount and every ten minutes with details closed, until unmount', async () => {
  vi.useFakeTimers();
  const fetch = mockAccount();
  const { unmount } = render(<CodexUsage />, { reactStrictMode: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const trigger = screen.getByRole('button', { name: /Codex weekly · 34.5% used/ });
  expect(screen.queryByRole('dialog')).toBeNull();

  fetch.mockResolvedValueOnce(weeklyUsage(55));
  await act(async () => { await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1); });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(trigger.textContent).toContain('Codex weekly · 55% used');

  fetch.mockResolvedValueOnce(weeklyUsage(68));
  await act(async () => { await vi.advanceTimersByTimeAsync(TEN_MINUTES); });
  expect(trigger.textContent).toContain('Codex weekly · 68% used');
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(TEN_MINUTES); });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([RATE_LIMITS_URL, RATE_LIMITS_URL, RATE_LIMITS_URL]);
  expect(fetch.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true);
});

test('the header refresh retries a failed read and shares updated limits with the details dialog', async () => {
  const fetch = mockAccount().mockRejectedValueOnce(new Error('temporarily unavailable'));
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<CodexUsage />);
  const trigger = await screen.findByRole('button', { name: /Codex weekly usage · Unavailable/ });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Codex usage' }));
  await screen.findByRole('button', { name: /Codex weekly · 34.5% used/ });
  expect(screen.queryByRole('dialog')).toBeNull();
  const time = new Date('2030-04-05T21:00:00Z').toLocaleString('en', {
    month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  expect(trigger.textContent).toContain(time);

  fireEvent.click(trigger);
  const dialog = within(screen.getByRole('dialog', { name: 'Codex usage details' }));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(dialog.getAllByRole('progressbar')).toHaveLength(3);
  expect(dialog.getByRole('progressbar', { name: 'Codex · 1 week' }).getAttribute('aria-valuenow')).toBe('34.5');
  expect(dialog.getByText('3 available')).toBeTruthy();
  expect(dialog.getAllByRole('button', { name: 'Use reset…' })).toHaveLength(1);
  fireEvent.click(dialog.getByRole('button', { name: 'Use reset…' }));
  expect(confirm.mock.calls[0][0]).toContain('Monthly reset');

  fetch.mockResolvedValueOnce(weeklyUsage(55));
  fireEvent.click(dialog.getByRole('button', { name: 'Refresh' }));
  await dialog.findByText('55% used');
  fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
  expect(trigger.textContent).toContain('Codex weekly · 55% used');
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([RATE_LIMITS_URL, RATE_LIMITS_URL, RATE_LIMITS_URL]);
});

test('a pending refresh is shared by the header, details and scheduled poll', async () => {
  vi.useFakeTimers();
  let complete!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { complete = resolve; });
  const fetch = mockAccount().mockReturnValueOnce(pending);
  render(<CodexUsage />);
  const headerRefresh = screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh Codex usage' });
  expect(headerRefresh.disabled).toBe(true);
  fireEvent.click(headerRefresh);
  fireEvent.click(screen.getByRole('button', { name: /Codex usage details/ }));
  const dialog = within(screen.getByRole('dialog'));
  const dialogRefresh = dialog.getByRole<HTMLButtonElement>('button', { name: 'Refresh' });
  expect(dialogRefresh.disabled).toBe(true);
  fireEvent.click(dialogRefresh);
  await act(async () => { await vi.advanceTimersByTimeAsync(TEN_MINUTES); });
  expect(fetch).toHaveBeenCalledTimes(1);

  await act(async () => complete(json(data)));
  expect(dialog.getByText('34.5% used')).toBeTruthy();
  expect(dialogRefresh.disabled).toBe(false);
  expect(headerRefresh.disabled).toBe(false);
});

test('an ambiguous reset requires fresh limits and another confirmation to retry with its original key', async () => {
  const consume = vi.fn().mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce(json({ outcome: 'alreadyRedeemed' }));
  const fetch = mockAccount(consume);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<CodexUsage />);
  fireEvent.click(await screen.findByRole('button', { name: /Codex weekly · 34.5% used/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use reset…' }));
  await screen.findByText('Could not confirm the reset. Check the updated limits before trying again.');
  expect(screen.queryByRole('button', { name: 'Use reset…' })).toBeNull();
  expect(screen.getByText('Click Refresh to load the latest limits.')).toBeTruthy();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([RATE_LIMITS_URL, CONSUME_CREDIT_URL]);
  expect(consume).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use reset…' }));
  await screen.findByText('This reset was already used.');
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([RATE_LIMITS_URL, CONSUME_CREDIT_URL, RATE_LIMITS_URL, CONSUME_CREDIT_URL]);
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
  expect(screen.queryByRole('button', { name: /Codex weekly usage · Unavailable/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Use reset…' })).toBeNull();
});
