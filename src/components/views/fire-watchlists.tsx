'use client';

import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError, type WatchEvaluateResponse, type WatchlistRow, type WatchConfidence, type WatchlistInput, type SchedulerRunEntry } from '@/lib/api-client';
import { waitForJob } from '@/lib/jobs/client';
import { usePushChannel } from '@/components/state/push-store';
import { minBacktestEndIso, windowFor, yesterdayIso } from '@/lib/fires/watchlist-engine';
import { REEVALUATE_LABELS, type ReevaluateIntervalMin } from '@/lib/schedule-core';
import { logEvent } from '@/components/state/log-store';
import { useSession } from '@/components/state/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { HudPanel, StatusPill, CoordReadout } from '@/components/ui-mc/kit';
import { EmptyState } from '@/components/system/query-state';
import { SweepLoader } from '@/components/system/skeletons';
import { Bell, BellRing, CalendarClock, ClipboardList, Clock, Loader2, Plus, RadioTower, Trash2, Pencil, MapPin, ShieldAlert, CheckCircle2, History, Timer } from 'lucide-react';
import { cn } from '@/lib/utils';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const RADIUS_OPTIONS = [5, 10, 15, 20, 25];
const LOOKBACK_OPTIONS = [3, 7, 14, 30];

const STATUS_TONE: Record<string, string> = {
  alert: 'border-crit/50 text-crit',
  watch: 'border-caution/50 text-caution',
  clear: 'border-signal/40 text-signal',
  unverified: 'border-edge text-faint',
};

const STATUS_TONE_BG: Record<string, string> = {
  alert: 'border-crit/40 bg-crit/5',
  watch: 'border-caution/30 bg-caution/5',
  clear: '',
  unverified: '',
};

const CONF_LABEL: Record<WatchConfidence, string> = {
  low: 'any confidence',
  nominal: 'nominal + high',
  high: 'high only',
};

/** Compact UTC minute stamp for panel rows, e.g. "2026-11-14 08:05Z". */
function utcMin(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/** One scheduler-ledger entry in the per-watchlist run-history panel. */
function RunEntryRow({ r }: { r: SchedulerRunEntry }) {
  return (
    <div className="border-b border-edge/60 py-1.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="telemetry text-[10px] text-dim">{utcMin(r.at)}</span>
        <span
          className={cn(
            'border px-1 py-px font-mono text-[9px] uppercase tracking-wide-mc',
            r.kind === 'fail' ? 'border-crit/50 text-crit' : 'border-signal/50 text-signal',
          )}
        >
          {r.kind === 'fail' ? 'fail' : 'run'}
        </span>
        {r.kind === 'run' ? (
          <span className="telemetry text-[10px] text-dim">
            {r.status ?? 'unknown status'} · {r.detectionCount !== null ? `${r.detectionCount} qualifying` : 'count not recorded'}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[10px] text-crit" title={r.error ?? undefined}>
            {r.error ?? 'unknown error'}
          </span>
        )}
        {r.claimedNextAt && (
          <span className="telemetry ml-auto text-[9px] text-faint">next claimed {utcMin(r.claimedNextAt)}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3">
        <span className="telemetry text-[9px] text-faint">corr {r.correlationId ?? '—'}</span>
        {r.evaluation && (
          <span className="telemetry text-[9px] text-faint">
            window {r.evaluation.windowStart} → {r.evaluation.windowEnd} · {r.evaluation.daysChecked} day(s) checked
            {r.evaluation.daysNoData > 0 ? ` · ${r.evaluation.daysNoData} no-data` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="font-mono text-[9px] uppercase tracking-wide-mc text-faint">{label}</span>
      {children}
    </div>
  );
}

/** Compact per-day detection bars (real counts from the last evaluation). */
function DayBars({ perDay }: { perDay: { date: string; total: number; qualifying: number }[] }) {
  const max = Math.max(1, ...perDay.map((d) => d.total));
  return (
    <div className="flex flex-wrap items-end gap-1" role="list" aria-label="Detections per day in the evaluation window">
      {perDay.map((d) => {
        const h = Math.max(2, Math.round((d.total / max) * 28));
        const qh = Math.max(0, Math.round((d.qualifying / max) * 28));
        return (
          <div key={d.date} role="listitem" aria-label={`${d.date}: ${d.total} detections, ${d.qualifying} qualifying`} className="flex flex-col items-center gap-1" title={`${d.date}: ${d.total} detection(s), ${d.qualifying} qualifying`}>
            <div
              className="relative w-4 overflow-hidden rounded-sm border border-edge bg-panel-2/60"
              style={{ height: 30 }}
              aria-hidden
            >
              <div className="absolute bottom-0 w-full bg-dim/40" style={{ height: h }} />
              <div className="absolute bottom-0 w-full bg-caution" style={{ height: Math.min(qh, h) }} />
            </div>
            <span className="telemetry text-[8px] text-faint">{d.date.slice(8)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function FireWatchlistsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { location, setLocation, setView } = useSession();
  const regions = useQuery({ queryKey: ['regions'], queryFn: api.regions, staleTime: 300_000, retry: 1 });
  const watchlists = useQuery({
    queryKey: ['fire-watchlists'],
    queryFn: api.watchlists,
    refetchInterval: 120_000,
    retry: 1,
  });

  // Push channel state — the console-wide EventSource (app shell) writes it;
  // the chip proves digests arrive without this view ever asking for them.
  const pushState = usePushChannel((s) => s.channelState);
  const pushEvents = usePushChannel((s) => s.eventsReceived);
  const pushLastAt = usePushChannel((s) => s.lastEventAt);
  const pushReconnects = usePushChannel((s) => s.reconnects);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<WatchlistInput>(() => ({
    name: '',
    label: location.label,
    lat: Number(location.lat.toFixed(4)),
    lon: Number(location.lon.toFixed(4)),
    radiusKm: 15,
    minConfidence: 'nominal',
    lookbackDays: 7,
    detectionThreshold: 5,
    notes: '',
    reevaluateIntervalMin: null,
  }));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<WatchlistInput>>({});
  const [pending, setPending] = useState<Record<string, { kind: 'live' | 'backtest' }>>({});
  const [evaluationProgress, setEvaluationProgress] = useState<Record<string, string | null>>({});

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['fire-watchlists'] });

  const create = useMutation({
    mutationFn: () => api.createWatchlist(form),
    onSuccess: (res) => {
      toast({ title: 'Watchlist created', description: `“${res.watchlist.name}” is unverified — run “Evaluate” to query the real GIBS VIIRS record for its window.` });
      logEvent({
        severity: 'success',
        category: 'FIRE',
        title: `Fire watchlist created — ${res.watchlist.name}`,
        detail: `${res.watchlist.radiusKm.toFixed(0)} km radius · ${CONF_LABEL[res.watchlist.minConfidence]} · alert at ≥ ${res.watchlist.detectionThreshold} detection(s) within ${res.watchlist.lookbackDays} day(s). ${res.note}`,
        view: 'fire',
      });
      setCreating(false);
      void invalidate();
    },
    onError: (err) => {
      toast({ title: 'Watchlist creation failed', description: err instanceof ApiRequestError ? err.message : 'unexpected error', variant: 'destructive' });
      logEvent({
        severity: 'crit',
        category: 'FIRE',
        title: 'Fire watchlist creation failed',
        detail: err instanceof ApiRequestError ? `${err.code} — ${err.message}` : 'Unexpected error.',
        correlationId: err instanceof ApiRequestError ? err.correlationId : undefined,
        view: 'fire',
      });
    },
  });

  const evaluate = useMutation({
    mutationFn: async ({ id, end }: { id: string; end?: string }) => {
      setPending((current) => ({ ...current, [id]: { kind: end ? 'backtest' : 'live' } }));
      const accepted = await api.evaluateWatchlist(id, end);
      return waitForJob<WatchEvaluateResponse>(accepted, {
        timeoutMs: 20 * 60_000,
        onProgress: ({ progressNote }) => setEvaluationProgress((current) => ({ ...current, [id]: progressNote })),
      });
    },
    onSettled: (_data, _error, vars) => {
      setPending((current) => {
        const next = { ...current };
        delete next[vars.id];
        return next;
      });
      setEvaluationProgress((current) => {
        const next = { ...current };
        delete next[vars.id];
        return next;
      });
    },
    onSuccess: (res) => {
      const w = res.watchlist;
      const ev = res.evaluation;
      const backtest = res.mode === 'backtest';
      toast({
        title: `${w.name} — ${backtest ? 'BACKTEST ' : ''}${ev.status.toUpperCase()}`,
        description: `${ev.detectionCount} qualifying detection(s) ${ev.windowStart} → ${ev.windowEnd}${backtest ? ' (historical window)' : ''}${ev.daysFetchedFromGibs ? ` · ${ev.daysFetchedFromGibs} day(s) fetched live from GIBS` : ''}${ev.daysNoData.length ? ` · ${ev.daysNoData.length} archive-gap day(s) reported` : ''}.`,
        variant: ev.status === 'alert' ? 'destructive' : undefined,
      });
      logEvent({
        severity: ev.status === 'alert' ? 'crit' : ev.status === 'watch' ? 'warn' : 'success',
        category: 'FIRE',
        title: `Watchlist ${backtest ? 'backtest' : 'evaluated'} — ${w.name}: ${ev.status.toUpperCase()}`,
        detail: `${backtest ? `BACKTEST of the rule against the historical window ${ev.windowStart} → ${ev.windowEnd} — ` : ''}${ev.rationale}${ev.daysFetchedFromGibs ? ` ${ev.daysFetchedFromGibs} day(s) of the window were fetched live from the real GIBS VIIRS stream; ${ev.rowsWritten} new row(s) stored.` : ' All days were already covered by stored archive checks.'}${backtest ? ' Stored as a normal evaluation event flagged trigger=backtest.' : ''}`,
        view: 'fire',
      });
      void invalidate();
    },
    onError: (err) => {
      toast({ title: 'Evaluation failed', description: err instanceof ApiRequestError ? err.message : 'unexpected error; no status fabricated', variant: 'destructive' });
      logEvent({
        severity: 'crit',
        category: 'FIRE',
        title: 'Watchlist evaluation failed',
        detail: err instanceof ApiRequestError ? `${err.code} — ${err.message}` : 'Unexpected error; no status written.',
        correlationId: err instanceof ApiRequestError ? err.correlationId : undefined,
        view: 'fire',
      });
    },
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<WatchlistInput> }) => api.updateWatchlist(id, body),
    onSuccess: (res, vars) => {
      const scheduleChanged = vars.body.reevaluateIntervalMin !== undefined;
      const interval = res.watchlist.reevaluateIntervalMin;
      toast({
        title: 'Watchlist updated',
        description: `“${res.watchlist.name}” saved.${scheduleChanged ? interval ? ` Scheduled re-evaluation ${REEVALUATE_LABELS[interval as ReevaluateIntervalMin]} — next run ${res.watchlist.nextReevaluateAt ? res.watchlist.nextReevaluateAt.slice(0, 16).replace('T', ' ') : 'pending'}Z.` : ' Scheduled re-evaluation switched off.' : ''}${vars.body.minConfidence !== undefined || vars.body.lookbackDays !== undefined || vars.body.detectionThreshold !== undefined ? ' Rule parameters changed → status reset to unverified until the next evaluation.' : ''}`,
      });
      logEvent({
        severity: 'info',
        category: 'FIRE',
        title: `Fire watchlist updated — ${res.watchlist.name}`,
        detail: `Radius ${res.watchlist.radiusKm.toFixed(0)} km · ${CONF_LABEL[res.watchlist.minConfidence]} · alert at ≥ ${res.watchlist.detectionThreshold} detection(s) within ${res.watchlist.lookbackDays} day(s).`,
        view: 'fire',
      });
      setEditingId(null);
      setEditForm({});
      void invalidate();
    },
    onError: (err) => {
      toast({ title: 'Update failed', description: err instanceof ApiRequestError ? err.message : 'unexpected error', variant: 'destructive' });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWatchlist(id),
    onSuccess: (res) => {
      toast({ title: 'Watchlist deleted', description: `“${res.deleted.name}” removed with its evaluation history.` });
      logEvent({
        severity: 'info',
        category: 'FIRE',
        title: `Fire watchlist deleted — ${res.deleted.name}`,
        detail: 'The watchlist and its event history were removed. Stored fire detections remain (they are shared real observations).',
        view: 'fire',
      });
      void invalidate();
    },
    onError: (err) => {
      toast({ title: 'Delete failed', description: err instanceof ApiRequestError ? err.message : 'unexpected error', variant: 'destructive' });
    },
  });

  const applyPreset = (key: string) => {
    if (key === 'current') {
      setForm((f) => ({ ...f, lat: Number(location.lat.toFixed(4)), lon: Number(location.lon.toFixed(4)), label: location.label, name: f.name || `${location.country ?? 'Region'} — fire watch` }));
      return;
    }
    const r = regions.data?.regions.find((x) => x.key === key);
    if (r) setForm((f) => ({ ...f, lat: r.lat, lon: r.lon, label: r.name, name: f.name || `${r.country} — fire watch` }));
  };

  const rows = watchlists.data?.watchlists ?? [];
  const summary = watchlists.data?.summary;
  const busy = Object.keys(pending).length > 0;
  const firstPendingId = Object.keys(pending)[0] ?? null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-24px' }}
      transition={{ duration: 0.35, ease: EASE }}
      aria-label="Regional fire watchlists"
    >
      <HudPanel className="flex flex-col gap-4" data-tour="fire-watchlists">
        {/* Section header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="kicker">Watchlists · regional fire-alert rules</p>
            <h3 className="mt-1.5 flex items-center gap-2 font-display text-sm font-bold uppercase tracking-wide-mc text-ink">
              <RadioTower className="h-4 w-4 text-caution" aria-hidden /> Fire watchlists
            </h3>
            <p className="mt-1.5 max-w-3xl text-[11px] leading-relaxed text-dim">
              Define a geography, radius and threshold rule; <span className="text-ink">Evaluate</span> ensures every day of the
              lookback window is checked against the real GIBS VIIRS 375 m stream, then reports clear / watch / alert from
              stored detections only. Days the archive simply does not have are reported as no-data — never zero-filled.
              <span className="text-ink"> Backtest</span> replays the same rule against any historical window via the date
              picker; watchlists with a cadence set are re-evaluated automatically by the database-leased scheduler, and every
              completed evaluation or scheduler failure is <span className="text-ink">pushed live</span> to the console as a
              cadence-aware digest over the digest-stream channel.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <span
              className={cn(
                'telemetry inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-[10px] uppercase tracking-wide-mc',
                pushState === 'open'
                  ? 'border-signal/40 bg-signal/5 text-signal'
                  : pushState === 'disabled'
                    ? 'border-edge text-faint'
                    : 'border-caution/40 text-caution',
              )}
              title={
                pushState === 'open'
                  ? `Digest push channel live — ${pushEvents} digest(s) pushed to this console${pushLastAt ? `; last at ${utcMin(pushLastAt)}Z` : ''}${pushReconnects > 0 ? `; ${pushReconnects} reconnect(s)` : ''}`
                  : pushState === 'disabled'
                    ? 'Digest push channel disabled by DIGEST_PUSH_OFF=1 — digests remain available on demand'
                    : pushState === 'reconnecting'
                      ? 'Channel connection lost — the browser is auto-reconnecting; missed digests remain available on demand'
                      : 'Opening the digest push channel'
              }
              data-tour="push-channel-chip"
            >
              <RadioTower className={cn('h-3 w-3', pushState === 'open' && 'anim-pulse-soft')} aria-hidden />
              push {pushState === 'open' ? `live · ${pushEvents}` : pushState === 'reconnecting' ? 'reconnecting' : pushState === 'disabled' ? 'off' : 'connecting'}
            </span>
            {summary && rows.length > 0 && (
              <span className="telemetry rounded-sm border border-edge bg-panel-2/60 px-2.5 py-1 text-[10px] uppercase tracking-wide-mc text-dim">
                {summary.total} list · {summary.alerting} alert · {summary.watch} watch · {summary.clear} clear · {summary.unverified} unverified
              </span>
            )}
            <Button
              size="sm"
              className="h-8 font-mono text-[11px] uppercase tracking-wide-mc"
              onClick={() => {
                if (!creating) {
                  setForm((current) => ({
                    ...current,
                    label: location.label,
                    lat: Number(location.lat.toFixed(4)),
                    lon: Number(location.lon.toFixed(4)),
                    name: current.name || `${location.country ?? 'Region'} — fire watch`,
                  }));
                }
                setCreating((v) => !v);
              }}
              aria-expanded={creating}
              aria-controls="watchlist-create-form"
            >
              {creating ? <>Close form</> : <><Plus className="h-3.5 w-3.5" aria-hidden /> New watchlist</>}
            </Button>
          </div>
        </div>

        {/* Alert summary strip */}
        {summary && summary.alerting > 0 && (
          <div className="hud border-crit/40 bg-crit/5 p-3" role="alert">
            <div className="flex items-start gap-2.5 text-[11px] leading-relaxed text-crit">
              <BellRing className="mt-0.5 h-4 w-4 shrink-0 anim-blink" aria-hidden />
              <div>
                <p className="font-mono uppercase tracking-wide-mc">{summary.alerting} watchlist{summary.alerting > 1 ? 's' : ''} in ALERT</p>
                <p className="mt-0.5 text-dim">
                  {rows.filter((r) => r.lastStatus === 'alert').map((r) => `${r.name} (${r.lastDetectionCount ?? 0} qualifying detection(s))`).join(' · ')} —
                  evaluate again to refresh, or inspect the detections ledger above.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Create form */}
        {creating && (
          <form
            id="watchlist-create-form"
            className="grid gap-3 rounded-sm border border-edge bg-panel-2/40 p-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!form.name.trim()) {
                toast({ title: 'Name required', description: 'Give the watchlist a short name (≤ 60 characters).', variant: 'destructive' });
                return;
              }
              create.mutate();
            }}
          >
            <div className="flex flex-wrap items-end gap-2.5">
              <Field label="Region preset" className="w-64">
                <Select onValueChange={(v) => applyPreset(v)}>
                  <SelectTrigger className="h-9 border-edge bg-panel text-xs text-dim" aria-label="Region preset">
                    <SelectValue placeholder="Current console location" />
                  </SelectTrigger>
                  <SelectContent className="border-edge bg-popover text-dim">
                    <SelectItem value="current" className="text-xs">Current console location</SelectItem>
                    {(regions.data?.regions ?? []).map((r) => (
                      <SelectItem key={r.key} value={r.key} className="text-xs">{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Name" className="min-w-48 flex-1">
                <Input
                  value={form.name}
                  maxLength={60}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Nakuru — dry-season fire watch"
                  className="h-9 border-edge bg-panel text-xs text-ink"
                  aria-label="Watchlist name"
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-end gap-2.5">
              <Field label="Center latitude">
                <Input
                  type="number" step="0.0001" min={-90} max={90}
                  value={form.lat}
                  onChange={(e) => setForm({ ...form, lat: Number(e.target.value) })}
                  className="telemetry h-9 w-28 border-edge bg-panel text-xs text-dim"
                  aria-label="Watchlist center latitude"
                />
              </Field>
              <Field label="Center longitude">
                <Input
                  type="number" step="0.0001" min={-180} max={180}
                  value={form.lon}
                  onChange={(e) => setForm({ ...form, lon: Number(e.target.value) })}
                  className="telemetry h-9 w-28 border-edge bg-panel text-xs text-dim"
                  aria-label="Watchlist center longitude"
                />
              </Field>
              <Field label="Watch radius">
                <Select value={String(form.radiusKm)} onValueChange={(v) => setForm({ ...form, radiusKm: Number(v) })}>
                  <SelectTrigger className="h-9 w-24 border-edge bg-panel text-xs text-dim" aria-label="Watch radius in kilometres">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-edge bg-popover text-dim">
                    {RADIUS_OPTIONS.map((r) => <SelectItem key={r} value={String(r)} className="text-xs">{r} km</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Confidence floor">
                <Select value={form.minConfidence} onValueChange={(v) => setForm({ ...form, minConfidence: v as WatchConfidence })}>
                  <SelectTrigger className="h-9 w-36 border-edge bg-panel text-xs text-dim" aria-label="Minimum confidence class counted">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-edge bg-popover text-dim">
                    <SelectItem value="low" className="text-xs">any confidence</SelectItem>
                    <SelectItem value="nominal" className="text-xs">nominal + high</SelectItem>
                    <SelectItem value="high" className="text-xs">high only</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Lookback window">
                <Select value={String(form.lookbackDays)} onValueChange={(v) => setForm({ ...form, lookbackDays: Number(v) })}>
                  <SelectTrigger className="h-9 w-24 border-edge bg-panel text-xs text-dim" aria-label="Lookback window in days">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-edge bg-popover text-dim">
                    {LOOKBACK_OPTIONS.map((d) => <SelectItem key={d} value={String(d)} className="text-xs">{d} days</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Alert threshold">
                <Input
                  type="number" min={1} max={500}
                  value={form.detectionThreshold}
                  onChange={(e) => setForm({ ...form, detectionThreshold: Math.max(1, Number(e.target.value) || 1) })}
                  className="telemetry h-9 w-20 border-edge bg-panel text-xs text-dim"
                  aria-label="Alert threshold in qualifying detections"
                />
              </Field>
              <Field label="Auto re-evaluate">
                <Select
                  value={String(form.reevaluateIntervalMin ?? 0)}
                  onValueChange={(v) => setForm({ ...form, reevaluateIntervalMin: v === '0' ? null : Number(v) })}
                >
                  <SelectTrigger className="h-9 w-32 border-edge bg-panel text-xs text-dim" aria-label="Scheduled re-evaluation cadence">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-edge bg-popover text-dim">
                    <SelectItem value="0" className="text-xs">off (manual)</SelectItem>
                    <SelectItem value="360" className="text-xs">every 6 h</SelectItem>
                    <SelectItem value="720" className="text-xs">every 12 h</SelectItem>
                    <SelectItem value="1440" className="text-xs">every 24 h</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field label="Notes (optional)">
              <Textarea
                value={form.notes ?? ''}
                maxLength={300}
                rows={2}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Why this region is watched — e.g. miombo woodland adjacent to maize fields, burns Jul–Oct."
                className="border-edge bg-panel text-xs text-ink"
                aria-label="Watchlist notes"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={create.isPending} className="h-9 font-mono text-xs uppercase tracking-wide-mc">
                {create.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> Creating…</>
                ) : (
                  <><Plus className="h-3.5 w-3.5" aria-hidden /> Create watchlist</>
                )}
              </Button>
              <p className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">
                alert at ≥ {form.detectionThreshold} {CONF_LABEL[form.minConfidence ?? 'nominal']} detection(s) within {form.lookbackDays} day(s) · watch at ≥ {Math.max(1, Math.ceil((form.detectionThreshold ?? 5) / 2))}
                {form.reevaluateIntervalMin ? ` · auto re-eval ${REEVALUATE_LABELS[form.reevaluateIntervalMin as ReevaluateIntervalMin]}` : ' · manual evaluation only'}
              </p>
            </div>
            {create.isError && (
              <p className="font-mono text-[10px] uppercase tracking-wide-mc text-crit" role="alert">
                {create.error instanceof ApiRequestError ? `${create.error.code} — ${create.error.message}` : 'creation failed'}
              </p>
            )}
          </form>
        )}

        {/* Evaluate/backtest-in-flight banner */}
        {busy && (
          <div className="flex flex-col gap-2" role="status" aria-live="polite">
            <SweepLoader label={firstPendingId && pending[firstPendingId]?.kind === 'backtest' ? 'Backtesting watchlist — durable job replaying the real VIIRS archive' : `Evaluating ${Object.keys(pending).length} watchlist(s) — durable jobs decoding uncovered VIIRS days`} />
            <p className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">
              {(firstPendingId ? evaluationProgress[firstPendingId] : null) ?? 'queued · archive gaps reported as no-data, never zero-filled'}
            </p>
          </div>
        )}

        {/* Watchlist cards */}
        {watchlists.isLoading && (
          <div className="telemetry px-1 text-[11px] text-faint" role="status">reading watchlists…</div>
        )}
        {watchlists.isError && (
          <div className="hud border-crit/40 p-3 text-[11px] text-crit" role="alert">
            Watchlist read failed — {watchlists.error instanceof ApiRequestError ? `${watchlists.error.code}: ${watchlists.error.message}` : 'unexpected error'}.
            <Button variant="outline" size="sm" className="ml-3 h-7 font-mono text-[10px] uppercase tracking-wide-mc" onClick={() => watchlists.refetch()}>
              retry
            </Button>
          </div>
        )}
        {!watchlists.isLoading && rows.length === 0 && (
          <EmptyState
            label="No watchlists yet"
            hint="Create one to turn stored VIIRS detections into standing regional alerts: pick a preset (the Zambia Central dry-season preset shows real alerts Jul–Oct), set a radius and threshold, then Evaluate."
          />
        )}
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((w) => (
            <WatchlistCard
              key={w.id}
              w={w}
              evaluating={pending[w.id] !== undefined}
              pendingKind={pending[w.id]?.kind ?? null}
              onEvaluate={() => evaluate.mutate({ id: w.id })}
              onBacktest={(end) => evaluate.mutate({ id: w.id, end })}
              editing={editingId === w.id}
              editForm={editForm}
              onEditOpen={() => {
                setEditingId(editingId === w.id ? null : w.id);
                setEditForm(editingId === w.id ? {} : {
                  name: w.name,
                  label: w.label ?? w.name,
                  lat: w.lat,
                  lon: w.lon,
                  radiusKm: w.radiusKm,
                  minConfidence: w.minConfidence,
                  lookbackDays: w.lookbackDays,
                  detectionThreshold: w.detectionThreshold,
                  notes: w.notes ?? '',
                  reevaluateIntervalMin: w.reevaluateIntervalMin,
                });
              }}
              onEditChange={(patch) => setEditForm((f) => ({ ...f, ...patch }))}
              onEditSubmit={() => update.mutate({ id: w.id, body: editForm })}
              editPending={update.isPending && editingId === w.id}
              onDelete={() => remove.mutate(w.id)}
              deletePending={remove.isPending && remove.variables === w.id}
              onFocus={() => {
                setLocation({ lat: w.lat, lon: w.lon, label: w.label ?? w.name, country: undefined, context: w.notes ?? undefined });
                toast({ title: 'Console geography set', description: `Targeting ${w.label ?? w.name} — ingest the window above to inspect its detections ledger.` });
                logEvent({
                  severity: 'info',
                  category: 'FIRE',
                  title: `Console geography set — ${w.label ?? w.name}`,
                  detail: `Targeted from fire watchlist “${w.name}” (${w.lat.toFixed(2)}°, ${w.lon.toFixed(2)}°, radius ${w.radiusKm.toFixed(0)} km).`,
                  view: 'fire',
                });
              }}
              onShowLedger={() => {
                setLocation({ lat: w.lat, lon: w.lon, label: w.label ?? w.name });
                setView('explorer');
              }}
            />
          ))}
        </div>

        <p className="text-[10px] leading-relaxed text-faint">
          Watchlist states describe the last recorded evaluation only. A header alert chip appears console-wide while any
          watchlist is in ALERT. Evaluations share the stored detection pool with the detections ledger — every row is a real
          VIIRS observation with provenance in Evidence &amp; Provenance. Backtests and scheduled runs take the identical
          pipeline and are flagged in the event ledger (trigger=backtest / scheduled); the scheduler&apos;s live state is reported
          in System Health, and each card&apos;s <span className="text-dim">Runs</span> panel reads the scheduler&apos;s audit ledger
          (successes joined to their evaluation event, failures listed with their errors) while
          <span className="text-dim"> Digest</span> summarizes the latest cadence window against the previous one — pulled
          on demand here, and pushed live over the digest stream whenever a new evaluation or scheduled failure lands.
        </p>
      </HudPanel>
    </motion.section>
  );
}

function WatchlistCard({
  w, evaluating, pendingKind, onEvaluate, onBacktest, editing, editForm, onEditOpen, onEditChange, onEditSubmit, editPending, onDelete, deletePending, onFocus, onShowLedger,
}: {
  w: WatchlistRow;
  evaluating: boolean;
  pendingKind: 'live' | 'backtest' | null;
  onEvaluate: () => void;
  onBacktest: (end: string) => void;
  editing: boolean;
  editForm: Partial<WatchlistInput>;
  onEditOpen: () => void;
  onEditChange: (patch: Partial<WatchlistInput>) => void;
  onEditSubmit: () => void;
  editPending: boolean;
  onDelete: () => void;
  deletePending: boolean;
  onFocus: () => void;
  onShowLedger: () => void;
}) {
  const last = w.lastEvent;
  const statusIcon =
    w.lastStatus === 'alert' ? <BellRing className="h-3.5 w-3.5" aria-hidden />
    : w.lastStatus === 'watch' ? <Bell className="h-3.5 w-3.5" aria-hidden />
    : w.lastStatus === 'clear' ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
    : <History className="h-3.5 w-3.5" aria-hidden />;

  // Backtest date-picker state: bounded by the VIIRS archive start (the full
  // lookback window must fit) and today. Defaults to the latest fully
  // observed day; the live window is what "Evaluate now" uses.
  const [btEnd, setBtEnd] = useState<string>(() => yesterdayIso());
  const today = new Date().toISOString().slice(0, 10);
  const btMin = minBacktestEndIso(w.lookbackDays);
  const btValid = btEnd >= btMin && btEnd <= today;
  const btWindow = btValid ? windowFor(btEnd, w.lookbackDays) : null;

  // Scheduler-run history panel: reads the scheduler&apos;s audit ledger + matched
  // evaluations on demand (open), then refreshes every 2 min while open.
  const [runsOpen, setRunsOpen] = useState(false);
  const runs = useQuery({
    queryKey: ['watchlist-runs', w.id],
    queryFn: () => api.watchlistRuns(w.id),
    enabled: runsOpen,
    staleTime: 30_000,
    refetchInterval: runsOpen ? 120_000 : false,
    retry: 1,
  });
  // Failed scheduler runs write no status anywhere else — surface them in the
  // mission log once per card when the operator pulls the ledger.
  const failureLogged = useRef(false);
  useEffect(() => {
    if (runsOpen && runs.data && runs.data.counts.failed > 0 && !failureLogged.current) {
      failureLogged.current = true;
      logEvent({
        severity: 'warn',
        category: 'FIRE',
        title: `Scheduler failures on “${w.name}” — ${runs.data.counts.failed} failed run(s) on record`,
        detail: 'Failed scheduled runs write no status; the scheduler retries at the next claimed slot. Inspect the Scheduler-runs panel for the error messages.',
        view: 'fire',
      });
    }
  }, [runsOpen, runs.data, w.name]);

  // Cadence-aware alert digest: window derives from the watchlist cadence
  // (null → API default 24 h); overridable from the popover chips. The data
  // also arrives PUSHED — the console-wide stream writes the same cache key
  // the moment an evaluation or scheduler failure lands.
  const [digestOpen, setDigestOpen] = useState(false);
  const [digestHours, setDigestHours] = useState<number | null>(null);
  const lastPush = usePushChannel((s) => s.lastDigests[w.id]);
  const digest = useQuery({
    queryKey: ['watchlist-digest', w.id, digestHours ?? 'cadence'],
    queryFn: () => api.watchlistDigest(w.id, digestHours ?? undefined),
    enabled: digestOpen,
    staleTime: 60_000,
    retry: 1,
  });
  const digestWindowOptions: { hours: number | null; label: string }[] = [
    { hours: null, label: w.reevaluateIntervalMin !== null ? `${w.reevaluateIntervalMin / 60} h · cadence` : '24 h · default' },
    { hours: 6, label: '6 h' },
    { hours: 12, label: '12 h' },
    { hours: 24, label: '24 h' },
    { hours: 72, label: '72 h' },
  ];

  return (
    <div className={cn('flex flex-col gap-2.5 rounded-sm border p-3.5', STATUS_TONE_BG[w.lastStatus] || 'border-edge bg-panel-2/40')}>
      {/* Card header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-display text-[13px] font-bold uppercase tracking-wide-mc text-ink">{w.name}</p>
          <p className="telemetry mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-faint">
            <CoordReadout lat={w.lat} lon={w.lon} />
            <span>· {w.radiusKm.toFixed(0)} km</span>
            {w.label && <span className="truncate">· {w.label}</span>}
          </p>
        </div>
        <StatusPill status={w.lastStatus} pulse={w.lastStatus === 'alert'} className={STATUS_TONE[w.lastStatus]} />
      </div>

      {/* Rule line */}
      <p className="telemetry text-[10px] uppercase tracking-wide-mc text-dim">
        rule — alert at ≥ {w.detectionThreshold} · {CONF_LABEL[w.minConfidence]} · within {w.lookbackDays} d
        <span className="text-faint"> (watch at ≥ {w.watchThreshold})</span>
      </p>
      {w.reevaluateIntervalMin !== null && (
        <p className="telemetry flex items-center gap-1.5 text-[10px] uppercase tracking-wide-mc text-signal">
          <Clock className="h-3 w-3" aria-hidden />
          auto re-eval {REEVALUATE_LABELS[w.reevaluateIntervalMin as ReevaluateIntervalMin]}
          {w.nextReevaluateAt ? ` · next ${w.nextReevaluateAt.slice(0, 16).replace('T', ' ')}Z` : ' · armed'}
        </p>
      )}
      {w.notes && <p className="text-[11px] leading-relaxed text-faint">{w.notes}</p>}

      {/* Last evaluation */}
      {last ? (
        <div className="flex flex-col gap-2 rounded-sm border border-edge/70 bg-void/40 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="telemetry text-[10px] uppercase tracking-wide-mc text-faint">
              last eval {new Date(last.evaluatedAt).toISOString().slice(0, 16).replace('T', ' ')}Z · {last.windowStart} → {last.windowEnd}
              {last.trigger !== 'manual' && (
                <span className={cn('ml-1.5 border px-1 py-px', last.trigger === 'backtest' ? 'border-caution/50 text-caution' : 'border-signal/50 text-signal')}>
                  {last.trigger}
                </span>
              )}
            </span>
            <span className="telemetry text-[10px] text-dim">
              {last.detectionCount} qualifying · {last.highConfidenceCount} high / {last.nominalCount} nominal / {last.lowCount} low
              {last.maxFrpMW !== null ? ` · max FRP ${last.maxFrpMW.toFixed(1)} MW` : ''}
            </span>
          </div>
          {last.perDay.length > 0 && <DayBars perDay={last.perDay} />}
          {last.rationale && <p className="text-[10px] leading-relaxed text-dim">{last.rationale}</p>}
          {(last.daysNoDataList.length > 0 || last.daysUnchecked.length > 0) && (
            <p className="font-mono text-[9px] uppercase tracking-wide-mc text-caution">
              {last.daysNoDataList.length > 0 && `${last.daysNoDataList.length} archive-gap day(s) reported`}
              {last.daysNoDataList.length > 0 && last.daysUnchecked.length > 0 && ' · '}
              {last.daysUnchecked.length > 0 && `${last.daysUnchecked.length} unchecked day(s)`}
            </p>
          )}
        </div>
      ) : (
        <p className="telemetry text-[10px] uppercase tracking-wide-mc text-caution">
          unverified — never evaluated; run a live check
        </p>
      )}

      {/* Scheduler-run history panel (audit ledger + matched evaluations) */}
      {runsOpen && (
        <div id={`watchlist-runs-${w.id}`} className="flex flex-col gap-1.5 rounded-sm border border-edge bg-void/40 p-2.5" data-tour="watchlist-runs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">
              scheduler run history — audit ledger + matched evaluations
            </span>
            {runs.data && (
              <span className="telemetry text-[10px] text-dim">
                {runs.data.counts.ok} ok · {runs.data.counts.failed} failed · {runs.data.counts.total} ledger
                {runs.data.counts.total > runs.data.showing ? ` — showing latest ${runs.data.showing} (cap ${runs.data.cap})` : ''}
              </span>
            )}
          </div>
          {runs.isLoading && (
            <p className="telemetry px-1 py-1 text-[11px] text-faint" role="status">reading scheduler ledger…</p>
          )}
          {runs.isError && (
            <div className="flex items-center gap-2 text-[11px] text-crit" role="alert">
              ledger read failed — {runs.error instanceof ApiRequestError ? `${runs.error.code}: ${runs.error.message}` : 'unexpected error'}
              <Button variant="outline" size="sm" className="h-6 font-mono text-[10px] uppercase tracking-wide-mc" onClick={() => runs.refetch()}>
                retry
              </Button>
            </div>
          )}
          {runs.data && runs.data.runs.length === 0 && (
            <p className="text-[11px] leading-relaxed text-dim">
              No scheduled runs on record.{' '}
              {w.reevaluateIntervalMin === null
                ? 'This watchlist is evaluated manually — set “Auto re-evaluate” in Edit to arm the database-leased scheduler.'
                : `The scheduler is armed (${REEVALUATE_LABELS[w.reevaluateIntervalMin as ReevaluateIntervalMin]}; next slot ${w.nextReevaluateAt ? utcMin(w.nextReevaluateAt) : 'pending'}) but has not completed a run for this list yet.`}
            </p>
          )}
          {runs.data && runs.data.runs.length > 0 && (
            <div className="max-h-56 overflow-y-auto pr-1">
              {runs.data.runs.map((r, i) => (
                <RunEntryRow key={`${r.at}-${r.correlationId ?? i}`} r={r} />
              ))}
            </div>
          )}
          <p className="text-[9px] leading-relaxed text-faint">
            every scheduled run is ledgered by the database-leased scheduler — successes here join their evaluation event on
            correlationId; failures appear ONLY here (they wrote no status) and retry at the next claimed slot (claim-before-run).
          </p>
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div className="grid gap-2.5 rounded-sm border border-edge bg-panel-2/40 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Name" className="min-w-40 flex-1">
              <Input
                value={editForm.name ?? ''}
                maxLength={60}
                onChange={(e) => onEditChange({ name: e.target.value })}
                className="h-8 border-edge bg-panel text-xs text-ink"
                aria-label="Edit watchlist name"
              />
            </Field>
            <Field label="Radius">
              <Select value={String(editForm.radiusKm ?? w.radiusKm)} onValueChange={(v) => onEditChange({ radiusKm: Number(v) })}>
                <SelectTrigger className="h-8 w-24 border-edge bg-panel text-xs text-dim" aria-label="Edit radius">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-edge bg-popover text-dim">
                  {RADIUS_OPTIONS.map((r) => <SelectItem key={r} value={String(r)} className="text-xs">{r} km</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Center latitude">
              <Input
                type="number" step="0.0001" min={-90} max={90}
                value={editForm.lat ?? w.lat}
                onChange={(e) => onEditChange({ lat: Number(e.target.value) })}
                className="telemetry h-8 w-28 border-edge bg-panel text-xs text-dim"
                aria-label="Edit watchlist center latitude"
              />
            </Field>
            <Field label="Center longitude">
              <Input
                type="number" step="0.0001" min={-180} max={180}
                value={editForm.lon ?? w.lon}
                onChange={(e) => onEditChange({ lon: Number(e.target.value) })}
                className="telemetry h-8 w-28 border-edge bg-panel text-xs text-dim"
                aria-label="Edit watchlist center longitude"
              />
            </Field>
            <Field label="Confidence floor">
              <Select value={editForm.minConfidence ?? w.minConfidence} onValueChange={(v) => onEditChange({ minConfidence: v as WatchConfidence })}>
                <SelectTrigger className="h-8 w-32 border-edge bg-panel text-xs text-dim" aria-label="Edit confidence floor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-edge bg-popover text-dim">
                  <SelectItem value="low" className="text-xs">any confidence</SelectItem>
                  <SelectItem value="nominal" className="text-xs">nominal + high</SelectItem>
                  <SelectItem value="high" className="text-xs">high only</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Lookback">
              <Select value={String(editForm.lookbackDays ?? w.lookbackDays)} onValueChange={(v) => onEditChange({ lookbackDays: Number(v) })}>
                <SelectTrigger className="h-8 w-24 border-edge bg-panel text-xs text-dim" aria-label="Edit lookback window">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-edge bg-popover text-dim">
                  {LOOKBACK_OPTIONS.map((d) => <SelectItem key={d} value={String(d)} className="text-xs">{d} days</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Alert threshold">
              <Input
                type="number" min={1} max={500}
                value={editForm.detectionThreshold ?? w.detectionThreshold}
                onChange={(e) => onEditChange({ detectionThreshold: Math.max(1, Number(e.target.value) || 1) })}
                className="telemetry h-8 w-20 border-edge bg-panel text-xs text-dim"
                aria-label="Edit alert threshold"
              />
            </Field>
            <Field label="Auto re-evaluate">
              <Select
                value={String(editForm.reevaluateIntervalMin ?? 0)}
                onValueChange={(v) => onEditChange({ reevaluateIntervalMin: v === '0' ? null : Number(v) })}
              >
                <SelectTrigger className="h-8 w-32 border-edge bg-panel text-xs text-dim" aria-label="Scheduled re-evaluation cadence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-edge bg-popover text-dim">
                  <SelectItem value="0" className="text-xs">off (manual)</SelectItem>
                  <SelectItem value="360" className="text-xs">every 6 h</SelectItem>
                  <SelectItem value="720" className="text-xs">every 12 h</SelectItem>
                  <SelectItem value="1440" className="text-xs">every 24 h</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Notes">
            <Textarea
              value={editForm.notes ?? ''}
              maxLength={300}
              rows={2}
              onChange={(e) => onEditChange({ notes: e.target.value })}
              className="border-edge bg-panel text-xs text-ink"
              aria-label="Edit watchlist notes"
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button size="sm" className="h-8 font-mono text-[11px] uppercase tracking-wide-mc" onClick={onEditSubmit} disabled={editPending}>
              {editPending ? 'Saving…' : 'Save changes'}
            </Button>
            <Button variant="outline" size="sm" className="h-8 font-mono text-[11px] uppercase tracking-wide-mc" onClick={onEditOpen}>
              Cancel
            </Button>
            <span className="font-mono text-[9px] uppercase tracking-wide-mc text-faint">rule change → status resets to unverified · cadence runs on the database-leased scheduler (audit-trailed)</span>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={onEvaluate}
          disabled={evaluating}
          className={cn('h-8 font-mono text-[11px] uppercase tracking-wide-mc', w.lastStatus === 'alert' && 'bg-crit/90 hover:bg-crit')}
          aria-label={`Evaluate watchlist ${w.name} live from the GIBS VIIRS archive`}
        >
          {pendingKind === 'live' ? (
            <><Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> Evaluating…</>
          ) : (
            <>{statusIcon} Evaluate now</>
          )}
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={evaluating}
              className="h-8 border-edge bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink"
              aria-label={`Backtest watchlist ${w.name} against a historical window`}
            >
              <CalendarClock className="h-3.5 w-3.5" aria-hidden /> Backtest
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 border-edge bg-popover p-3">
            <div className="flex flex-col gap-2.5">
              <div>
                <p className="font-display text-[12px] font-bold uppercase tracking-wide-mc text-ink">Backtest “{w.name}”</p>
                <p className="mt-1 text-[10px] leading-relaxed text-dim">
                  Replays the exact rule over a historical window ending on the chosen date, from the real GIBS VIIRS
                  archive — the same pipeline as Evaluate, anchored to the past. Stored as a normal evaluation event
                  (trigger=backtest); nothing is simulated.
                </p>
              </div>
              <Field label="Window end date">
                <Input
                  type="date"
                  value={btEnd}
                  min={btMin}
                  max={today}
                  onChange={(e) => setBtEnd(e.target.value)}
                  className="telemetry h-8 border-edge bg-panel text-xs text-dim"
                  aria-label="Backtest window end date"
                />
              </Field>
              <p className="font-mono text-[9px] uppercase tracking-wide-mc text-faint">
                {btWindow
                  ? `window ${btWindow.start} → ${btWindow.end} · ${btWindow.days.length} day(s) · latest fully observed day is ${yesterdayIso()}`
                  : `invalid date — the ${w.lookbackDays}-day window must fit inside the archive: end dates ${btMin} → ${today}`}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8 font-mono text-[11px] uppercase tracking-wide-mc"
                  disabled={!btValid || evaluating}
                  onClick={() => onBacktest(btEnd)}
                >
                  {pendingKind === 'backtest' ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> Backtesting…</>
                  ) : (
                    <><CalendarClock className="h-3.5 w-3.5" aria-hidden /> Run backtest</>
                  )}
                </Button>
                {btEnd !== yesterdayIso() && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 border-edge bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink"
                    onClick={() => setBtEnd(yesterdayIso())}
                  >
                    Use latest day
                  </Button>
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>
        <Button
          variant="outline"
          size="sm"
          className="h-8 border-edge bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink"
          onClick={() => setRunsOpen((v) => !v)}
          aria-expanded={runsOpen}
          aria-controls={`watchlist-runs-${w.id}`}
          aria-label={`Scheduler run history for ${w.name}`}
        >
          <Timer className="h-3.5 w-3.5" aria-hidden /> {runs.data ? `Runs (${runs.data.counts.total})` : 'Runs'}
        </Button>
        <Popover open={digestOpen} onOpenChange={setDigestOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-edge bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink"
              aria-label={`Cadence-aware alert digest for ${w.name}`}
            >
              <ClipboardList className="h-3.5 w-3.5" aria-hidden /> Digest
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96 border-edge bg-popover p-3">
            <div className="flex flex-col gap-2.5">
              <div>
                <p className="font-display text-[12px] font-bold uppercase tracking-wide-mc text-ink">Alert digest — “{w.name}”</p>
                <p className="mt-1 text-[10px] leading-relaxed text-dim">
                  Cadence-aware summary of this watchlist&apos;s alert activity: the window derives from its re-evaluation
                  cadence and is compared with the equal-length window before it — status path, peak detections, alert
                  entries/exits, failed runs, archive gaps. Recorded evaluations only; nothing interpolated. On demand
                  here — and pushed live over the digest stream the moment a new fact lands.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Digest window length">
                {digestWindowOptions.map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => setDigestHours(o.hours)}
                    aria-pressed={(digestHours ?? null) === o.hours}
                    className={cn(
                      'border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide-mc transition-colors',
                      (digestHours ?? null) === o.hours
                        ? 'border-caution/60 bg-caution/10 text-caution'
                        : 'border-edge bg-panel text-faint hover:text-dim',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {digest.isLoading && (
                <p className="telemetry text-[11px] text-faint" role="status">building digest…</p>
              )}
              {digest.isError && (
                <div className="flex items-center gap-2 text-[11px] text-crit" role="alert">
                  digest failed — {digest.error instanceof ApiRequestError ? `${digest.error.code}: ${digest.error.message}` : 'unexpected error'}
                  <Button variant="outline" size="sm" className="h-6 font-mono text-[10px] uppercase tracking-wide-mc" onClick={() => digest.refetch()}>
                    retry
                  </Button>
                </div>
              )}
              {digest.data && (
                <>
                  <p className="font-mono text-[9px] uppercase tracking-wide-mc text-faint">
                    window {utcMin(digest.data.window.current.start)} → {utcMin(digest.data.window.current.end)} UTC · source{' '}
                    {digest.data.windowSource}
                    {digest.data.windowSource === 'cadence' && digest.data.cadenceMin !== null
                      ? ` (${digest.data.cadenceMin / 60} h cadence)`
                      : digest.data.windowSource === 'default'
                        ? ' (no cadence set)'
                        : ''}
                  </p>
                  {lastPush && (
                    <p
                      className="telemetry text-[9px] uppercase tracking-wide-mc text-signal"
                      title={`Pushed over the digest stream at ${utcMin(lastPush.pushedAt)}Z${lastPush.status ? ` — last status ${lastPush.status}` : ' — the window carries the failure that pushed it'}`}
                    >
                      pushed {utcMin(lastPush.pushedAt)}Z ·{' '}
                      {lastPush.reason === 'scheduled-failure'
                        ? 'scheduled failure'
                        : lastPush.trigger === 'scheduled'
                          ? 'scheduled run'
                          : lastPush.trigger === 'backtest'
                            ? 'backtest'
                            : lastPush.trigger === 'manual'
                              ? 'manual evaluation'
                              : 'evaluation'}
                    </p>
                  )}
                  <div className="flex flex-col gap-1.5 rounded-sm border border-edge bg-void/40 p-2.5">
                    {digest.data.digest.map((line, i) => (
                      <p key={i} className="text-[10.5px] leading-relaxed text-dim">{line}</p>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusPill
                      status={digest.data.current.last?.status ?? w.lastStatus}
                      pulse={(digest.data.current.last?.status ?? w.lastStatus) === 'alert'}
                      className={STATUS_TONE[digest.data.current.last?.status ?? w.lastStatus]}
                    />
                    <span className="telemetry text-[10px] text-dim">
                      peak {digest.data.current.peak?.detectionCount ?? '—'}
                      {digest.data.comparison.peakDelta !== null && digest.data.comparison.peakDelta !== 0
                        ? ` (${digest.data.comparison.peakDelta > 0 ? '+' : ''}${digest.data.comparison.peakDelta} vs prev)`
                        : ''}
                    </span>
                    <span className="telemetry text-[10px] text-dim">
                      {digest.data.current.evaluations} eval(s) · {digest.data.failures.length} failed run(s)
                    </span>
                    <span className="telemetry text-[10px] text-faint">
                      prev window peak {digest.data.previous.peak?.detectionCount ?? '—'}
                    </span>
                  </div>
                </>
              )}
            </div>
          </PopoverContent>
        </Popover>
        <Button variant="outline" size="sm" className="h-8 border-edge bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink" onClick={onEditOpen} aria-expanded={editing}>
          <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
        </Button>
        <Button variant="outline" size="sm" className="h-8 border-edge bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink" onClick={onFocus}>
          <MapPin className="h-3.5 w-3.5" aria-hidden /> Set console location
        </Button>
        <Button variant="outline" size="sm" className="h-8 border-edge bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink" onClick={onShowLedger}>
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Map region
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-crit/30 bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:border-crit/60 hover:text-crit"
              aria-label={`Delete watchlist ${w.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="border-edge bg-popover">
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display text-sm uppercase tracking-wide-mc text-ink">
                Delete “{w.name}”?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-xs leading-relaxed text-dim">
                Removes the watchlist and its {w.eventCount} recorded evaluation(s). Stored fire detections remain — they are
                shared real observations. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="font-mono text-[11px] uppercase tracking-wide-mc">Keep</AlertDialogCancel>
              <AlertDialogAction
                className="bg-crit font-mono text-[11px] uppercase tracking-wide-mc hover:bg-crit/90"
                onClick={onDelete}
                disabled={deletePending}
              >
                {deletePending ? 'Deleting…' : 'Delete watchlist'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {w.lastStatus === 'alert' && (
          <span className="telemetry flex items-center gap-1.5 text-[10px] uppercase tracking-wide-mc text-crit" role="status">
            <BellRing className="h-3 w-3 anim-blink" aria-hidden /> alerting
          </span>
        )}
      </div>
    </div>
  );
}
