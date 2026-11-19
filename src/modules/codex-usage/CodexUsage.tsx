import { ChevronDown, Gauge, RefreshCw, X } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useCodexUsage } from '@/modules/codex-usage/hooks/useCodexUsage';
import type { CodexRateLimits, CodexResetCredit } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/shared/ui';
import { cn } from '@/shared/utils';

const WEEK_MINUTES = 7 * 24 * 60;

function windowLength(minutes: number, language: string) {
  const units = [['week', WEEK_MINUTES], ['day', 1440], ['hour', 60], ['minute', 1]] as const;
  for (const [unit, size] of units) {
    if (minutes >= size && minutes % size === 0) {
      return new Intl.NumberFormat(language, { style: 'unit', unit, unitDisplay: 'long' }).format(minutes / size);
    }
  }
  return new Intl.NumberFormat(language, { style: 'unit', unit: 'minute', unitDisplay: 'long' }).format(minutes);
}

function formatTime(iso: string, language: string, compact = false) {
  return new Date(iso).toLocaleString(language, {
    month: compact ? 'numeric' : 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    ...(compact ? {} : { year: 'numeric', timeZoneName: 'short' }),
  });
}

function percentUsed(percent: number, language: string) {
  return new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(percent / 100);
}

function PlanLimits({ data }: { data: CodexRateLimits }) {
  const { t, i18n } = useTranslation();
  const plan = data.limits.find(limit => limit.planType)?.planType;
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{t('codexUsage.limits')}</h3>
        {plan && <span className="rounded border border-border px-1.5 text-xs capitalize text-muted-foreground">{plan}</span>}
      </div>
      {data.limits.length === 0 && <p className="text-sm text-muted-foreground">{t('codexUsage.noLimits')}</p>}
      {data.limits.flatMap(limit => limit.windows.map(window => {
        const name = limit.name ?? (limit.id === 'codex' ? 'Codex' : limit.id);
        const label = `${name} · ${windowLength(window.windowDurationMins, i18n.language)}`;
        return (
          <div key={`${limit.id}-${window.kind}`} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span>{label}</span>
              <span className="shrink-0 font-medium tabular-nums">{t('codexUsage.used', { value: percentUsed(window.usedPercent, i18n.language) })}</span>
            </div>
            <div role="progressbar" aria-label={label} aria-valuenow={window.usedPercent} aria-valuemin={0} aria-valuemax={100}
              className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={cn('h-full rounded-full', window.usedPercent >= 90 ? 'bg-rose-500' : window.usedPercent >= 70 ? 'bg-amber-500' : 'bg-emerald-500')}
                style={{ width: `${window.usedPercent}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {window.resetsAt ? t('codexUsage.resetsAt', { time: formatTime(window.resetsAt, i18n.language) }) : t('codexUsage.unknownReset')}
            </p>
          </div>
        );
      }))}
    </section>
  );
}

function eligible(credit: CodexResetCredit) {
  return credit.status === 'available' && (credit.expiresAt === null || Date.parse(credit.expiresAt ?? '') > Date.now());
}

function FreeResets({ data, busy, confirmCredit }: {
  data: CodexRateLimits;
  busy: boolean;
  confirmCredit: (creditId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const credits = data.resetCredits ?? [];
  const listed = credits.filter(credit => credit.status === 'available').length;
  return (
    <section className="space-y-2 border-t border-border pt-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('codexUsage.freeResets')}</h3>
        <span className="text-xs text-muted-foreground">{t('codexUsage.available', { count: data.resetCreditsAvailable })}</span>
      </div>
      {data.resetCreditsAvailable > listed && <p className="text-xs text-muted-foreground">{t('codexUsage.missingCredits')}</p>}
      {credits.map((credit, index) => {
        const name = credit.title ?? t('codexUsage.credit', { number: index + 1 });
        const expiry = credit.expiresAt ? t('codexUsage.expiresAt', { time: formatTime(credit.expiresAt, i18n.language) })
          : t(credit.expiresAt === null ? 'codexUsage.noExpiry' : 'codexUsage.unknownExpiry');
        const canUse = data.resetCreditsAvailable > 0 && eligible(credit);
        const requestReset = () => {
          if (!canUse || busy || !window.confirm(t('codexUsage.confirm', { name, expiry }))) return;
          if (eligible(credit)) confirmCredit(credit.id);
        };
        return (
          <div key={credit.id} className="flex items-start justify-between gap-3 rounded-lg border border-border/80 p-3">
            <div className="min-w-0 space-y-1 break-words">
              <p className="text-sm font-medium">{name}</p>
              {credit.description && <p className="text-xs text-muted-foreground">{credit.description}</p>}
              <p className="text-xs text-muted-foreground">{expiry}</p>
            </div>
            {canUse ? (
              <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" disabled={busy} onClick={requestReset}>
                {t('codexUsage.useReset')}
              </Button>
            ) : <span className="shrink-0 text-xs text-muted-foreground">{t('codexUsage.unavailable')}</span>}
          </div>
        );
      })}
    </section>
  );
}

/** Used by the project workspace header to show weekly Codex usage and open account limit details. */
export function CodexUsage() {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  // Opening the dialog requests the full plan and individual free reset credits.
  const [open, setOpen] = useState(false);
  const { snapshot, refresh, redeeming, outcome, consumeConfirmedCredit } = useCodexUsage(open);
  const { data, details, error, loading } = snapshot;
  // Prefer the general plan when Codex also returns independent model-specific windows.
  const weeklyPools = data?.limits.filter(limit => limit.windows.some(window => window.windowDurationMins === WEEK_MINUTES));
  const pool = weeklyPools?.find(limit => limit.id.toLowerCase() === 'codex') ?? weeklyPools?.[0];
  const weekly = pool?.windows.find(window => window.windowDurationMins === WEEK_MINUTES);
  const summary = pool && weekly ? t('codexUsage.weekly', {
    pool: pool.id.toLowerCase() === 'codex' ? 'Codex' : (pool.name ?? pool.id),
    value: percentUsed(weekly.usedPercent, i18n.language),
  }) : t('codexUsage.weeklyLabel');
  const resetTime = weekly?.resetsAt ? t('codexUsage.resetsAt', { time: formatTime(weekly.resetsAt, i18n.language, true) })
    : weekly ? t('codexUsage.unknownReset') : loading ? t('status.loading') : t('codexUsage.unavailable');
  const title = t('codexUsage.details');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-start text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        aria-haspopup="dialog" aria-expanded={open} aria-label={`${title} · ${summary} · ${resetTime}`} title={title}
      >
        <Gauge aria-hidden="true" className="hidden h-4 w-4 text-muted-foreground lg:block" />
        <span className="flex max-w-[45vw] flex-col whitespace-nowrap sm:max-w-64">
          <span className="truncate text-xs font-medium tabular-nums leading-tight">{summary}</span>
          <span className="text-[10px] tabular-nums leading-tight text-muted-foreground">{resetTime}</span>
        </span>
        <span className="ms-1 hidden text-xs text-muted-foreground lg:inline">{t('codexUsage.viewDetails')}</span>
        <ChevronDown aria-hidden="true" className="h-3 w-3 text-muted-foreground" />
      </DialogTrigger>
      <DialogContent aria-labelledby={titleId} className="max-h-[85dvh] w-[calc(100vw-1.5rem)] max-w-md overflow-y-auto p-4 sm:p-5">
        <div className="flex items-center gap-1">
          <DialogTitle id={titleId} className="not-sr-only me-auto text-base font-semibold">{title}</DialogTitle>
          <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label={t('buttons.refresh')} title={t('buttons.refresh')}
            disabled={loading || redeeming} onClick={refresh}><RefreshCw aria-hidden="true" className={cn(loading && 'animate-spin')} /></Button>
          <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label={t('buttons.close')} onClick={() => setOpen(false)}><X aria-hidden="true" /></Button>
        </div>
        <div className="mt-4 space-y-5">
          {error !== null && <p role="alert" className="text-sm text-destructive">{error || t('codexUsage.readError')}</p>}
          {data && <PlanLimits data={data} />}
          {data && details && <FreeResets data={data} busy={loading || redeeming} confirmCredit={consumeConfirmedCredit} />}
          {error === null && !details && <p role="status" className="text-sm text-muted-foreground">{t('status.loading')}</p>}
          {(redeeming || outcome) && <p role="status" className="text-sm">{t(redeeming ? 'codexUsage.applying' : `codexUsage.outcomes.${outcome}`)}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
