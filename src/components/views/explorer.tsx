'use client';

import dynamic from 'next/dynamic';
import React from 'react';
import { motion } from 'framer-motion';
import { useSession } from '@/components/state/store';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionHeader, HudPanel, CoordReadout } from '@/components/ui-mc/kit';
import { QueryState, EmptyState } from '@/components/system/query-state';
import { SkeletonBlock } from '@/components/system/skeletons';
import { Crosshair } from 'lucide-react';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** Mission-frame placeholder used while MapLibre + GIBS module streams in. */
function MapModuleLoader() {
  return (
    <div className="hud hud-calm relative h-[72vh] overflow-hidden" role="status" aria-live="polite">
      <div className="sweep-mc" aria-hidden />
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-3">
          <span className="anim-blink h-2 w-2 rounded-full bg-aqua" aria-hidden />
          <p className="font-mono text-xs uppercase tracking-wide-mc text-dim">
            Initialising MapLibre + NASA GIBS…
          </p>
        </div>
      </div>
    </div>
  );
}

const GibsMap = dynamic(
  () => import('@/components/map/gibs-map').then((m) => m.GibsMap),
  { ssr: false, loading: () => <MapModuleLoader /> },
);

/** Staggered section entrance (y 12→0, 0.35 s, ~60 ms stagger, once). */
function Reveal({ i = 0, className, children }: { i?: number; className?: string; children: React.ReactNode }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-24px' }}
      transition={{ duration: 0.35, delay: i * 0.06, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[9px] uppercase tracking-wide-mc text-faint">{label}</span>
      {children}
    </label>
  );
}

/** Geospatial Explorer: map + layers + date + fire overlay + boundary drawing. */
export function ExplorerView() {
  const { mapDate, setMapDate, location, setLocation } = useSession();
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.sources });

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      {/* View header — flight controls live in the actions rail */}
      <Reveal>
        <SectionHeader
          kicker="Mission console · Orbital imagery"
          title="Geospatial Explorer"
          description="NASA GIBS WMTS · live tiles. NDVI dates snap to 16-day MOD13Q1 composite starts automatically. Fire points appear once ingested in Fire Intelligence."
          actions={
            <div className="flex flex-wrap items-end gap-2.5">
              <Field label="Observation date">
                <Input
                  type="date"
                  value={mapDate}
                  max={new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}
                  min="2000-03-01"
                  onChange={(e) => setMapDate(e.target.value)}
                  className="telemetry h-9 w-44 border-edge bg-panel text-xs text-dim"
                  aria-label="Observation date for GIBS layers"
                />
              </Field>
              <Field label="Latitude">
                <Input
                  type="number"
                  step="0.01"
                  min={-90}
                  max={90}
                  value={location.lat}
                  onChange={(e) => setLocation({ ...location, lat: Number(e.target.value) })}
                  className="telemetry h-9 w-24 border-edge bg-panel text-xs text-dim"
                  aria-label="Latitude of the target coordinate"
                />
              </Field>
              <Field label="Longitude">
                <Input
                  type="number"
                  step="0.01"
                  min={-180}
                  max={180}
                  value={location.lon}
                  onChange={(e) => setLocation({ ...location, lon: Number(e.target.value) })}
                  className="telemetry h-9 w-24 border-edge bg-panel text-xs text-dim"
                  aria-label="Longitude of the target coordinate"
                />
              </Field>
              <Button
                variant="outline"
                className="h-9 border-edge bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink"
                onClick={() => setLocation({ ...location, label: 'Custom coordinate' })}
              >
                <Crosshair className="h-3.5 w-3.5 text-aqua" aria-hidden />
                Fly to coordinate
              </Button>
              <span className="hidden items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide-mc text-faint xl:flex">
                <span className="h-1 w-1 rounded-full bg-aqua anim-blink" aria-hidden />
                WMTS · EPSG:3857
              </span>
            </div>
          }
        />
      </Reveal>

      {/* Map console — registry-gated so overlays never render half-initialised */}
      <Reveal i={1}>
        <QueryState
          isLoading={sources.isLoading}
          isError={sources.isError}
          error={sources.error}
          onRetry={() => sources.refetch()}
          label="Layer registry"
          skeleton={
            <div className="hud hud-calm relative h-[72vh] overflow-hidden p-5">
              <div className="sweep-mc" aria-hidden />
              <SkeletonBlock className="h-2 w-28" />
              <SkeletonBlock className="mt-3 h-4 w-2/5" />
              <SkeletonBlock className="mt-4 h-64 max-w-full" />
              <SkeletonBlock className="mt-3 h-3 w-3/5 max-w-full" />
              <p className="mt-4 font-mono text-[10px] uppercase tracking-wide-mc text-faint">
                Loading GIBS layer registry…
              </p>
            </div>
          }
          isEmpty={sources.data ? sources.data.mapLayers.length === 0 : false}
          empty={
            <EmptyState
              label="Layer registry"
              hint="No GIBS layers are registered for this console build. The explorer renders real imagery only — it will not fall back to a synthetic basemap."
              action={
                <Button
                  variant="outline"
                  onClick={() => sources.refetch()}
                  className="mt-2 h-8 border-edge bg-transparent font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink"
                >
                  Re-request registry
                </Button>
              }
            />
          }
        >
          <div data-tour="explorer-map">
            {sources.data ? <GibsMap layers={sources.data.mapLayers} height="72vh" /> : null}
          </div>
        </QueryState>
      </Reveal>

      {/* Coordinate readout strip */}
      <Reveal i={2}>
        <HudPanel calm className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <CoordReadout lat={location.lat} lon={location.lon} />
            <span className="font-mono text-[11px] text-faint">{location.label}</span>
          </div>
          <p className="max-w-md text-[11px] leading-relaxed text-faint">
            Draw a boundary directly on the map, then save it in the Farm Workspace. Layer metadata and limitations
            are attached to every product.
          </p>
        </HudPanel>
      </Reveal>
    </div>
  );
}
