import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { CodexUsage } from '@/modules/codex-usage';
import '@/modules/i18n';
import type { CodexRateLimits } from '@/shared/types';

const RATE_LIMITS_URL = '/api/providers/codex/rate-limits';
const CONSUME_CREDIT_URL = '/api/providers/codex/reset-credits/consume';

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

test('clicking Refresh loads the latest weekly summary, plan limits and reset credits', async () => {
  vi.useFakeTimers();
  const fetch = mockAccount();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<CodexUsage />);
  const trigger = screen.getByRole('button', { name: /Codex weekly usage · Awaiting refresh/ });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();

  fireEvent.click(trigger);
  const dialog = within(screen.getByRole('dialog', { name: 'Codex usage details' }));
  expect(dialog.getByText('Click Refresh to load the latest limits.')).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();

  const refresh = dialog.getByRole('button', { name: 'Refresh' });
  await act(async () => {
    fireEvent.click(refresh);
    fireEvent.click(refresh);
  });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([RATE_LIMITS_URL]);
  const time = new Date('2030-04-05T21:00:00Z').toLocaleString('en', {
    month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  expect(trigger.textContent).toContain('Codex weekly · 34.5% used');
  expect(trigger.textContent).toContain(time);
  const reset = dialog.getByRole('button', { name: 'Use reset…' });
  expect(dialog.getAllByRole('progressbar')).toHaveLength(3);
  expect(dialog.getByText('3 available')).toBeTruthy();
  expect(dialog.getAllByRole('button', { name: 'Use reset…' })).toHaveLength(1);
  fireEvent.click(reset);
  expect(confirm.mock.calls[0][0]).toContain('Monthly reset');

  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
    document.dispatchEvent(new Event('visibilitychange'));
  });
  fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
  fireEvent.click(trigger);
  expect(fetch).toHaveBeenCalledTimes(1);

  const plan = data.limits[1];
  fetch.mockResolvedValueOnce(json({
    ...data,
    limits: [{ ...plan, windows: [{ ...plan.windows[1], usedPercent: 55 }] }],
  }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([RATE_LIMITS_URL, RATE_LIMITS_URL]);
  expect(trigger.textContent).toContain('Codex weekly · 55% used');
  expect(fetch.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true);
});

test('an ambiguous reset requires a manual refresh and another confirmation to retry with its original key', async () => {
  const consume = vi.fn().mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce(json({ outcome: 'alreadyRedeemed' }));
  const fetch = mockAccount(consume);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<CodexUsage />);
  fireEvent.click(screen.getByRole('button', { name: /Awaiting refresh/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
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
  fireEvent.click(screen.getByRole('button', { name: /Awaiting refresh/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('Details are unavailable for some free resets.');
  expect(screen.queryByRole('button', { name: /Codex weekly usage · Unavailable/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Use reset…' })).toBeNull();
});
