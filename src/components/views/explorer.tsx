'use client';

import dynamic from 'next/dynamic';
import { useSession } from '@/components/state/store';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

const GibsMap = dynamic(
  () => import('@/components/map/gibs-map').then((m) => m.GibsMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-[70vh] rounded-lg border border-slate-800 bg-slate-900/30 text-sm text-slate-500" role="status">
        <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> Loading MapLibre + NASA GIBS…
      </div>
    ),
  },
);

/** Geospatial Explorer: map + layers + date + fire overlay + boundary drawing. */
export function ExplorerView() {
  const { mapDate, setMapDate, location, setLocation } = useSession();
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.sources });

  return (
    <div className="flex flex-col gap-4">
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>Geospatial Explorer</span>
            <span className="text-xs font-normal text-slate-500">NASA GIBS WMTS · live tiles</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">Observation date</span>
              <Input
                type="date"
                value={mapDate}
                max={new Date(Date.now() - 86400000).toISOString().slice(0, 10)}
                min="2000-03-01"
                onChange={(e) => setMapDate(e.target.value)}
                className="w-44 bg-slate-900 border-slate-700"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">Latitude</span>
              <Input
                type="number" step="0.01" min={-90} max={90}
                value={location.lat}
                onChange={(e) => setLocation({ ...location, lat: Number(e.target.value) })}
                className="w-28 bg-slate-900 border-slate-700"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">Longitude</span>
              <Input
                type="number" step="0.01" min={-180} max={180}
                value={location.lon}
                onChange={(e) => setLocation({ ...location, lon: Number(e.target.value) })}
                className="w-28 bg-slate-900 border-slate-700"
              />
            </label>
            <Button
              variant="outline"
              className="border-slate-700 text-slate-200 h-9"
              onClick={() => setLocation({ ...location, label: 'Custom coordinate' })}
            >
              Fly to coordinate
            </Button>
            <p className="text-[11px] text-slate-600 max-w-md">
              NDVI dates snap to 16-day MOD13Q1 composite starts automatically. Fire points appear once ingested in
              Fire Intelligence.
            </p>
          </div>
        </CardContent>
      </Card>

      {sources.data ? (
        <GibsMap layers={sources.data.mapLayers} height="72vh" />
      ) : (
        <div className="flex items-center justify-center h-[70vh] rounded-lg border border-slate-800 bg-slate-900/30 text-sm text-slate-500" role="status">
          <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> loading layer registry…
        </div>
      )}
    </div>
  );
}
