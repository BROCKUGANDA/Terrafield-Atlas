'use client';

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession, type ViewKey } from '@/components/state/store';
import { api } from '@/lib/api-client';
import { logEvent } from '@/components/state/log-store';

/**
 * Deep-linkable console state.
 *
 * The single-route console mirrors its state into the URL fragment so a
 * judge or farmer can bookmark or share an exact console position:
 *
 *   #view=rotation&farm=<id>&region=nakuru
 *
 * The hash is applied once on load (view + farm immediately, region once the
 * preset catalogue resolves) and then kept in sync with history.replaceState —
 * no history pollution while the operator moves through modules.
 */

const VALID_VIEWS = new Set<ViewKey>([
  'landing', 'dashboard', 'explorer', 'analysis', 'farm', 'rotation', 'provenance', 'fire', 'reports', 'settings',
]);

function readHash(): URLSearchParams | null {
  if (typeof window === 'undefined') return null;
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return null;
  return new URLSearchParams(raw);
}

export function useConsoleUrlSync(enabled: boolean): void {
  const { view, setView, activeFarmId, setActiveFarmId, location, setLocation } = useSession();
  const regions = useQuery({ queryKey: ['regions'], queryFn: api.regions, staleTime: 600_000, retry: 1 });

  const baseAppliedRef = useRef(false);
  const regionAppliedRef = useRef(false);

  // 1a. Apply view + farm from the incoming hash exactly once.
  useEffect(() => {
    if (!enabled || baseAppliedRef.current) return;
    baseAppliedRef.current = true;
    const params = readHash();
    if (!params) return;

    const viewParam = params.get('view') as ViewKey | null;
    const farm = params.get('farm');

    if (viewParam && VALID_VIEWS.has(viewParam)) setView(viewParam);
    if (farm && farm !== 'none') setActiveFarmId(farm);

    if ((viewParam && VALID_VIEWS.has(viewParam)) || (farm && farm !== 'none')) {
      logEvent({
        severity: 'info',
        category: 'SYSTEM',
        title: 'Console state restored from link',
        detail: `Deep link applied — view=${viewParam ?? '—'}${farm ? ` · farm=${farm}` : ''}${params.get('region') ? ` · region=${params.get('region')}` : ''}.`,
        view: viewParam ?? 'landing',
      });
    }
  }, [enabled]);

  // 1b. Apply the region preset once the catalogue is available.
  useEffect(() => {
    if (!enabled || regionAppliedRef.current || !regions.isSuccess) return;
    regionAppliedRef.current = true;
    const region = readHash()?.get('region');
    if (!region) return;
    const preset = (regions.data?.regions ?? []).find((r) => r.key === region);
    if (!preset) return;
    setLocation({
      lat: preset.lat,
      lon: preset.lon,
      label: preset.name,
      country: preset.country,
      context: preset.croppingContext,
    });
  }, [enabled, regions.isSuccess]);

  // 2. Mirror store state back into the URL (replace, not push).
  //    Gated until region presets settle so the mirror can never race ahead
  //    of the region-apply effect above and destroy an incoming `region=` param.
  const regionsSettled = regions.isSuccess || regions.isError;
  useEffect(() => {
    if (!enabled || !baseAppliedRef.current || !regionsSettled) return;
    const params = new URLSearchParams();
    if (view) params.set('view', view);
    if (activeFarmId) params.set('farm', activeFarmId);
    const preset = (regions.data?.regions ?? []).find(
      (r) => Math.abs(r.lat - location.lat) < 0.01 && Math.abs(r.lon - location.lon) < 0.01,
    );
    if (preset) {
      params.set('region', preset.key);
    } else {
      params.set('at', `${location.lat.toFixed(3)},${location.lon.toFixed(3)}`);
    }
    const hash = `#${params.toString()}`;
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', hash);
    }
  }, [view, activeFarmId, location.lat, location.lon, regions.data, regionsSettled]);
}
