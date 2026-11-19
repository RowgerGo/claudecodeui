import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { codexUsageService } from '@/modules/providers/services/codex-usage.service.js';
import { AppError } from '@/shared/index.js';

function mockAccountRequest(context: TestContext, response: unknown) {
  context.mock.method(codexAppServer, 'resolveLauncher', () => {
    throw new Error('Tests must never launch a real Codex account connection.');
  });
  return context.mock.method(codexAppServer, 'accountRequest', async () => response);
}

async function startProviderRoutes(context: TestContext) {
  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.sendStatus(error instanceof AppError ? error.statusCode : 500);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers/codex`;
}

test('summary and details read the same limit windows, with reset details fetched on demand', async (context) => {
  const rpc = mockAccountRequest(context, {
    rateLimitsByLimitId: {
      codex: {
        planType: 'plus',
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 33.5, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
      },
      review: { primary: { usedPercent: 101, windowDurationMins: 300 } },
    },
    rateLimitResetCredits: {
      availableCount: 5,
      credits: [
        { id: 'unused-credit', status: 'available', expiresAt: null },
        { id: 'no-expiry-reported', status: 'available' },
        { id: 'finite', status: 'available', expiresAt: 1_800_000_000 },
        { id: ' ' },
      ],
    },
  });
  const baseUrl = await startProviderRoutes(context);
  const summary = await fetch(`${baseUrl}/rate-limits?details=false`);
  const details = await fetch(`${baseUrl}/rate-limits`);
  type LimitsResponse = { data: Awaited<ReturnType<typeof codexUsageService.readLimits>> };
  const { data: header } = await summary.json() as LimitsResponse;
  const { data: panel } = await details.json() as LimitsResponse;
  assert.deepEqual(rpc.mock.calls.map((call) => call.arguments), [
    ['account/rateLimits/read', { excludeResetCreditDetails: true }],
    ['account/rateLimits/read', { excludeResetCreditDetails: false }],
  ]);
  assert.equal(summary.headers.get('cache-control'), 'no-store');
  assert.deepEqual(header.limits, panel.limits);
  assert.deepEqual(header.limits[0].windows[1], {
    kind: 'secondary', usedPercent: 33.5, windowDurationMins: 10_080, resetsAt: '2027-01-15T08:00:00.000Z',
  });
  assert.equal(header.limits[1].windows[0].usedPercent, 100);
  assert.equal(header.resetCredits, null);
  assert.equal(panel.resetCreditsAvailable, 5);
  assert.ok(panel.resetCredits);
  assert.equal(panel.resetCredits.length, 3);
  assert.equal(panel.resetCredits[0].expiresAt, null);
  assert.equal('expiresAt' in panel.resetCredits[1], false);
  assert.equal(panel.resetCredits[2].expiresAt, '2027-01-15T08:00:00.000Z');
});

test('legacy limits can contain the weekly window in the primary slot and only a reset count', async (context) => {
  mockAccountRequest(context, {
    rateLimits: { primary: { usedPercent: 0, windowDurationMins: 10_080 } },
    rateLimitResetCredits: { availableCount: 2 },
  });
  const result = await codexUsageService.readLimits(true);
  assert.equal(result.limits[0]?.id, 'codex');
  assert.equal(result.limits[0]?.windows[0]?.usedPercent, 0);
  assert.equal(result.resetCreditsAvailable, 2);
  assert.equal(result.resetCredits, null);
});

test('only a confirmed JSON POST with a selected credit and attempt key invokes the reset RPC', async (context) => {
  const rpc = mockAccountRequest(context, { outcome: 'alreadyRedeemed' });
  const baseUrl = await startProviderRoutes(context);
  const url = `${baseUrl}/reset-credits/consume`;
  const selected = { creditId: 'test-credit', idempotencyKey: 'test-attempt' };
  const post = (body: unknown, contentType = 'application/json') =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': contentType }, body: JSON.stringify(body) });

  assert.equal((await fetch(url)).status, 404);
  assert.equal((await post({ ...selected, confirmed: true }, 'text/plain')).status, 415);
  assert.equal((await post(selected)).status, 400);
  assert.equal((await post({ ...selected, confirmed: 'true' })).status, 400);
  assert.equal((await post({ ...selected, confirmed: true, creditId: ' ' })).status, 400);
  assert.equal((await post({ ...selected, confirmed: true, idempotencyKey: '' })).status, 400);
  assert.equal(rpc.mock.callCount(), 0);

  const confirmed = await post({ ...selected, confirmed: true });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), { success: true, data: { outcome: 'alreadyRedeemed' } });
  assert.deepEqual(rpc.mock.calls.map((call) => call.arguments), [
    ['account/rateLimitResetCredit/consume', selected],
  ]);
});

test('an unknown Codex outcome cannot be reported as a successful reset', async (context) => {
  mockAccountRequest(context, { outcome: 'futureProtocolValue' });
  await assert.rejects(codexUsageService.consumeCredit('test-credit', 'test-attempt'), {
    code: 'UNKNOWN_CODEX_RESET_OUTCOME',
  });
});
