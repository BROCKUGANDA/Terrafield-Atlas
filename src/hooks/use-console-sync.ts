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
 * preset catalogue resolves). Module navigation creates browser history entries;
 * coordinate and farm updates replace the current entry.
 */

const VALID_VIEWS = new Set<ViewKey>([
  'landing', 'dashboard', 'explorer', 'sources', 'analysis', 'farm', 'rotation', 'provenance', 'fire', 'reports', 'organizations', 'billing', 'intelligence', 'admin', 'settings',
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

  useEffect(() => {
    if (!enabled) return;
    const restore = () => {
      const params = readHash();
      const target = params?.get('view') as ViewKey | null;
      if (target && VALID_VIEWS.has(target)) setView(target);
      const farm = params?.get('farm');
      setActiveFarmId(farm && farm !== 'none' ? farm : null);
      const region = (regions.data?.regions ?? []).find((r) => r.key === params?.get('region'));
      if (region) {
        setLocation({ lat: region.lat, lon: region.lon, label: region.name, country: region.country, context: region.croppingContext });
      } else {
        const coordinate = params?.get('at')?.split(',').map(Number);
        if (coordinate?.length === 2 && coordinate.every(Number.isFinite) && Math.abs(coordinate[0]) <= 90 && Math.abs(coordinate[1]) <= 180) {
          setLocation({ lat: coordinate[0], lon: coordinate[1], label: 'Custom coordinate' });
        }
      }
    };
    window.addEventListener('hashchange', restore);
    window.addEventListener('popstate', restore);
    return () => {
      window.removeEventListener('hashchange', restore);
      window.removeEventListener('popstate', restore);
    };
  }, [enabled, regions.data, setView, setActiveFarmId, setLocation]);

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
    const params = readHash();
    const region = params?.get('region');
    if (!region) {
      const coordinate = params?.get('at')?.split(',').map(Number);
      if (coordinate?.length === 2 && coordinate.every(Number.isFinite) && Math.abs(coordinate[0]) <= 90 && Math.abs(coordinate[1]) <= 180) {
        setLocation({ lat: coordinate[0], lon: coordinate[1], label: 'Custom coordinate' });
      }
      return;
    }
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

  // 2. Mirror current store state after incoming link effects have run.
  //    Gated until region presets settle so the mirror can never race ahead
  //    of the region-apply effect above and destroy an incoming `region=` param.
  const regionsSettled = regions.isSuccess || regions.isError;
  useEffect(() => {
    if (!enabled || !baseAppliedRef.current || !regionsSettled) return;
    const current = useSession.getState();
    const params = new URLSearchParams();
    params.set('view', current.view);
    if (current.activeFarmId) params.set('farm', current.activeFarmId);
    const preset = (regions.data?.regions ?? []).find(
      (r) => Math.abs(r.lat - current.location.lat) < 0.000001 && Math.abs(r.lon - current.location.lon) < 0.000001,
    );
    if (preset) {
      params.set('region', preset.key);
    } else {
      params.set('at', `${current.location.lat.toFixed(6)},${current.location.lon.toFixed(6)}`);
    }
    const hash = `#${params.toString()}`;
    if (window.location.hash !== hash) {
      const previousView = readHash()?.get('view');
      if (previousView && previousView !== current.view) window.history.pushState(null, '', hash);
      else window.history.replaceState(null, '', hash);
    }
  }, [enabled, view, activeFarmId, location.lat, location.lon, regions.data, regionsSettled]);
}
