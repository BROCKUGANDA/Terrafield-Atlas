'use client';

import { useQuery } from '@tanstack/react-query';
import { RadioTower, Satellite } from 'lucide-react';
import { api, type SourceSign, type SourceSignState } from '@/lib/api-client';
import { useSession } from '@/components/state/store';
import { cn } from '@/lib/utils';

/**
 * LIVE source signs — chips backed by real reachability probes
 * (GET /api/v1/system/sources, 60 s probe cache, 60 s UI poll).
 *
 * The FIRMS story is told honestly, in real time:
 *   - FIRMS API chip: the actual host, red when the network blocks it;
 *   - FIRMS STREAM chip (via GIBS): the path fire detections actually serve
 *     from — green when a real tile request proves the stream is flowing;
 *   - every other upstream gets the same treatment. Latency shown per chip.
 */

const STATE_TONE: Record<SourceSignState, { dot: string; text: string; label: string }> = {
  live: { dot: 'bg-signal', text: 'text-signal', label: 'LIVE' },
  degraded: { dot: 'bg-caution', text: 'text-caution', label: 'DEGRADED' },
  unreachable: { dot: 'bg-crit', text: 'text-crit', label: 'UNREACHABLE' },
  checking: { dot: 'bg-aqua anim-blink', text: 'text-faint', label: 'CHECKING' },
};

export const SOURCE_SIGN_POLL_MS = 60_000;

export function useSourceSigns() {
  return useQuery({
    queryKey: ['system-sources'],
    queryFn: () => api.systemSources(),
    refetchInterval: SOURCE_SIGN_POLL_MS,
    staleTime: 55_000,
    retry: 1,
  });
}

export function SourceSignChip({ sign, short }: { sign: SourceSign; short?: boolean }) {
  const tone = STATE_TONE[sign.state] ?? STATE_TONE.checking;
  const name = short
    ? sign.key === 'FIRMS_API'
      ? 'FIRMS API'
      : sign.key === 'FIRMS_STREAM'
        ? 'FIRMS stream · GIBS'
        : sign.key === 'NASA_POWER'
          ? 'POWER'
          : sign.key === 'SOILGRIDS'
            ? 'SoilGrids'
            : sign.key
    : sign.label;
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-wide-mc',
        sign.state === 'live' ? 'border-signal/40 bg-signal/5 text-dim' : 'border-edge bg-panel-2/60 text-dim',
      )}
      title={`${sign.label} — ${sign.state.toUpperCase()} · ${sign.detail} · probed ${sign.checkedAt}`}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', tone.dot, sign.state === 'live' && 'anim-pulse-soft')} aria-hidden />
      <span className="truncate">{name}</span>
      <span className={cn('shrink-0', tone.text)}>
        {tone.label}
        {sign.latencyMs !== null && sign.state === 'live' ? ` ${sign.latencyMs}ms` : ''}
      </span>
    </span>
  );
}

/** Full chip strip — Fire Intelligence + System Health. */
export function SourceSignsStrip({ signs, probeMs, checkedAt }: { signs?: SourceSign[]; probeMs?: number; checkedAt?: string }) {
  if (!signs || signs.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
        {['FIRMS stream · GIBS', 'FIRMS API', 'EONET', 'GIBS', 'POWER', 'SoilGrids'].map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5 rounded-sm border border-edge bg-panel-2/60 px-2 py-1 font-mono text-[10px] uppercase tracking-wide-mc text-faint">
            <span className="h-1.5 w-1.5 rounded-full bg-aqua anim-blink" aria-hidden />
            {k} — checking
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Live data-source reachability signs">
      {signs.map((s) => (
        <SourceSignChip key={s.key} sign={s} short />
      ))}
      <span className="font-mono text-[9px] uppercase tracking-wide-mc text-faint" title={checkedAt}>
        probes {probeMs ?? '—'} ms · cached 60 s
      </span>
    </div>
  );
}

/** Compact header chip: aggregate live count + FIRMS-stream state. */
export function SourceSignsSummaryChip() {
  const setView = useSession((s) => s.setView);
  const { data, isFetching } = useSourceSigns();
  const signs = data?.signs ?? [];
  const stream = signs.find((s) => s.key === 'FIRMS_STREAM');
  const live = data?.summary.live;
  const total = signs.length;

  const state: SourceSignState = signs.length === 0 ? 'checking' : !stream ? 'checking' : stream.state === 'live' ? (live === total ? 'live' : 'degraded') : 'unreachable';
  const tone = STATE_TONE[state];
  const label =
    signs.length === 0
      ? 'src chk···'
      : state === 'live'
        ? `src ${live}/${total} live`
        : state === 'degraded'
          ? `src ${live}/${total} live · fallback path`
          : state === 'unreachable'
            ? 'src fire stream down'
            : 'src chk···';

  return (
    <button
      type="button"
      onClick={() => setView('settings')}
      data-tour="hdr-sources"
      className={cn(
        'hidden items-center gap-1.5 rounded-sm px-1.5 py-1 transition-colors hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-offset-2 sm:flex',
        isFetching && 'opacity-80',
      )}
      style={{ outlineColor: 'var(--nasa)' }}
      aria-label={`Live data sources: ${label}. Open System Health for the full probe table.`}
      title={data ? `${data.note}\n\n${signs.map((s) => `${s.label}: ${s.state.toUpperCase()} (${s.detail})`).join('\n')}` : 'Probing data sources…'}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot, state === 'live' && 'anim-pulse-soft', state === 'unreachable' && 'anim-blink')} aria-hidden />
      <span className="font-mono text-[10px] uppercase tracking-wide-mc text-dim">{isFetching ? 'src chk···' : label}</span>
    </button>
  );
}

/** EONET live wildfire events mini-panel (event-level context, honestly labeled). */
export function EonetEventsPanel({ className }: { className?: string }) {
  const { data, isPending, isError, error, refetch } = useSourceSigns();
  if (isPending) {
    return (
      <div className={cn('hud p-4', className)} role="status" aria-live="polite">
        <p className="kicker text-nasa">Regional wildfire events · NASA EONET</p>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-wide-mc text-faint">
          <span className="anim-blink">querying eonet v3···</span>
        </p>
      </div>
    );
  }
  if (isError) {
    return (
      <div className={cn('hud p-4', className)} role="alert">
        <p className="kicker" style={{ color: 'var(--caution)' }}>EONET events unavailable</p>
        <p className="mt-2 font-mono text-[10px] text-faint">{error instanceof Error ? error.message : 'request failed'}</p>
        <button type="button" onClick={() => refetch()} className="mt-2 font-mono text-[10px] uppercase tracking-wide-mc text-aqua underline-offset-2 hover:underline">
          Retry request
        </button>
      </div>
    );
  }
  const eonet = data?.eonet;
  if (!eonet) return null;
  return (
    <div className={cn('hud p-4', className)} role="group" aria-label="Live wildfire events from NASA EONET">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Satellite className="h-4 w-4 text-caution" aria-hidden />
          <p className="kicker text-nasa">Regional wildfire events · NASA EONET v3</p>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide-mc',
            eonet.fresh ? 'border-signal/40 bg-signal/5 text-signal' : 'border-caution/40 bg-caution/5 text-caution',
          )}
          title={eonet.note}
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', eonet.fresh ? 'bg-signal anim-pulse-soft' : 'bg-caution')} aria-hidden />
          {eonet.fresh ? `LIVE · ${eonet.count} open` : eonet.count > 0 ? `STALE +${Math.round((eonet.staleMs ?? 0) / 1000)}s` : 'NO SNAPSHOT'}
        </span>
      </div>
      {eonet.events.length === 0 ? (
        <p className="mt-3 text-[11px] leading-relaxed text-faint">{eonet.note}</p>
      ) : (
        <ul className="mt-3 grid gap-1.5">
          {eonet.events.slice(0, 6).map((e) => (
            <li key={e.id} className="flex min-w-0 items-baseline gap-2 font-mono text-[11px]">
              <span className="shrink-0 text-faint">{e.startedAt ? e.startedAt.slice(0, 10) : '—'}</span>
              <span className="truncate text-dim" title={e.title}>{e.title}</span>
              <span className="ml-auto shrink-0 text-faint">
                {e.lat !== null && e.lon !== null ? `${Math.abs(e.lat).toFixed(1)}°${e.lat >= 0 ? 'N' : 'S'} ${Math.abs(e.lon as number).toFixed(1)}°${(e.lon as number) >= 0 ? 'E' : 'W'}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-faint">
        <RadioTower className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        Event-level NASA curation (name, latest position) — context signal only, never counted as detections.
      </p>
    </div>
  );
}
