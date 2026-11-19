import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { AppError, readObjectRecord, readOptionalString } from '@/shared/index.js';

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function unixTimeToIso(value: unknown): string | null {
  const seconds = nonNegativeNumber(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function readLimit(id: string, value: unknown) {
  const limit = readObjectRecord(value);
  if (!limit) return null;

  const windows = (['primary', 'secondary'] as const).flatMap((kind) => {
    const window = readObjectRecord(limit[kind]);
    const usedPercent = nonNegativeNumber(window?.usedPercent);
    const windowDurationMins = nonNegativeNumber(window?.windowDurationMins);
    if (usedPercent === null || windowDurationMins === null) return [];
    return [{
      kind,
      usedPercent: Math.min(100, usedPercent),
      windowDurationMins,
      resetsAt: unixTimeToIso(window?.resetsAt),
    }];
  });
  if (!windows.length) return null;

  const credits = readObjectRecord(limit.credits);
  return {
    id: readOptionalString(limit.limitId) ?? id,
    name: readOptionalString(limit.limitName) ?? null,
    planType: readOptionalString(limit.planType) ?? null,
    reachedType: readOptionalString(limit.rateLimitReachedType) ?? null,
    credits: credits && {
      balance: readOptionalString(credits.balance) ?? null,
      unlimited: credits.unlimited === true,
      hasCredits: credits.hasCredits === true,
    },
    windows,
  };
}

function readResetCredit(value: unknown) {
  const row = readObjectRecord(value);
  if (typeof row?.id !== 'string' || !row.id.trim()) return null;
  // Only an explicit null means the credit never expires. Missing or invalid
  // dates remain unknown so the client cannot offer an unverified reset.
  const expiresAt = row.expiresAt === null ? null : unixTimeToIso(row.expiresAt) ?? undefined;
  return {
    id: row.id,
    title: readOptionalString(row.title) ?? null,
    description: readOptionalString(row.description) ?? null,
    status: readOptionalString(row.status) ?? 'unknown',
    grantedAt: unixTimeToIso(row.grantedAt),
    expiresAt,
  };
}

/** Used by the authenticated provider routes to read account quotas and redeem a selected credit. */
export const codexUsageService = {
  async readLimits(includeDetails: boolean) {
    const raw = await codexAppServer.accountRequest('account/rateLimits/read', {
      excludeResetCreditDetails: !includeDetails,
    });
    const result = readObjectRecord(raw);
    const byId = readObjectRecord(result?.rateLimitsByLimitId);
    const limits = Object.entries(byId ?? {}).map(([id, limit]) => readLimit(id, limit))
      .filter((limit) => limit !== null);
    if (limits.length === 0) {
      const legacyLimit = readLimit('codex', result?.rateLimits);
      if (legacyLimit) limits.push(legacyLimit);
    }

    const resets = readObjectRecord(result?.rateLimitResetCredits);
    return {
      limits,
      resetCreditsAvailable: nonNegativeNumber(resets?.availableCount) ?? 0,
      resetCredits: includeDetails && Array.isArray(resets?.credits)
        ? resets.credits.map(readResetCredit).filter((credit) => credit !== null)
        : null,
    };
  },

  async consumeCredit(creditId: string, idempotencyKey: string) {
    const raw = await codexAppServer.accountRequest('account/rateLimitResetCredit/consume', { creditId, idempotencyKey });
    const outcome: unknown = readObjectRecord(raw)?.outcome;
    switch (outcome) {
      case 'reset':
      case 'alreadyRedeemed':
      case 'nothingToReset':
      case 'noCredit':
        return { outcome };
      default:
        throw new AppError('Codex returned an unknown reset outcome.', {
          code: 'UNKNOWN_CODEX_RESET_OUTCOME',
          statusCode: 502,
        });
    }
  },
};
