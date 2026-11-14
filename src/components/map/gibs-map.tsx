'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Map as MlMap, NavigationControl, AttributionControl, setWorkerUrl } from 'maplibre-gl';
import type { GeoJSONSource, RasterTileSource, MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useSession } from '@/components/state/store';
import type { MapLayerInfo } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { Layers, Pencil, Trash2, Check, X } from 'lucide-react';

/**
 * Interactive geospatial explorer: real NASA GIBS WMTS layers (EPSG:3857),
 * farm-boundary drawing, fire-detection overlay (real stored detections),
 * per-layer opacity + resolution + limitation metadata.
 */

/** Snap to MOD13Q1 16-day composite starts (Jan 1 + 16k). */
function snap16(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const days = Math.floor((d.getTime() - jan1) / 86_400_000);
  let snapped = jan1 + Math.floor(days / 16) * 16 * 86_400_000;
  if (new Date(snapped).toISOString().slice(0, 10) > date) snapped -= 16 * 86_400_000;
  return new Date(snapped).toISOString().slice(0, 10);
}

const GROUP_COLORS: Record<string, string> = {
  'satellite-imagery': '#60a5fa',
  vegetation: '#34d399',
  'soil-moisture': '#38bdf8',
};

export interface GibsMapProps {
  layers: MapLayerInfo[];
  height?: string;
}

export function GibsMap({ layers, height = '70vh' }: GibsMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const { location, mapDate, fireDetectionsGeoJson, farmBoundary, setFarmBoundary } = useSession();

  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [opacity, setOpacity] = useState<Record<string, number>>({});
  const [drawMode, setDrawMode] = useState(false);
  const [legend, setLegend] = useState<MapLayerInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [baseReady, setBaseReady] = useState(false);

  // initialise map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    // MapLibre v6 derives its worker URL from import.meta.url, which breaks
    // under the Turbopack dev bundler; serve the shipped worker from /public.
    try {
      setWorkerUrl('/maplibre-gl-worker.mjs');
    } catch {
      // already set or unsupported — MapLibre falls back to its own resolution
    }
    const map = new MlMap({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#060b14' } }],
      },
      center: [location.lon, location.lat],
      zoom: 8,
      attributionControl: false,
    });
    mapRef.current = map;
    map.on('load', () => setReady(true));
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
    return () => {
      map.remove();
      mapRef.current = null;
    };
     
  }, []);

  // when the layer registry arrives: add all raster sources/layers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || layers.length === 0) return;
    for (const layer of layers) {
      const srcId = `gibs-${layer.id}`;
      if (map.getSource(srcId)) continue;
      const maxzoom = Number(layer.tileMatrixSet.replace('GoogleMapsCompatible_Level', ''));
      map.addSource(srcId, {
        type: 'raster',
        tiles: [expandTemplate(layer, mapDate)],
        tileSize: 256,
        maxzoom: Number.isFinite(maxzoom) ? maxzoom : 9,
        attribution: layer.productSource.includes('SMAP') ? 'NASA SMAP via EOSDIS GIBS' : 'Imagery courtesy of NASA EOSDIS GIBS',
      });
      map.addLayer({
        id: `layer-${layer.id}`,
        type: 'raster',
        source: srcId,
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 100 },
      });
    }
    // default: show the first satellite-imagery layer
    // (state is initialized here because the layer registry arrives asynchronously
    // from a query — a documented external-system synchronization)
    const first = layers.find((l) => l.group === 'satellite-imagery') ?? layers[0];
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible((v) => (Object.keys(v).length === 0 ? { [first.id]: true } : v));
     
    setOpacity((o) => (Object.keys(o).length === 0 ? Object.fromEntries(layers.map((l) => [l.id, 0.9])) : o));
     
    setBaseReady(true);
     
  }, [ready, layers]);

  // when date changes: setTiles on every raster source
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || layers.length === 0) return;
    for (const layer of layers) {
      const src = map.getSource(`gibs-${layer.id}`) as RasterTileSource | undefined;
      src?.setTiles([expandTemplate(layer, mapDate)]);
    }
  }, [mapDate, ready, layers]);

  // visibility/opacity
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const layer of layers) {
      const layerId = `layer-${layer.id}`;
      if (!map.getLayer(layerId)) continue;
      map.setLayoutProperty(layerId, 'visibility', visible[layer.id] ? 'visible' : 'none');
      map.setPaintProperty(layerId, 'raster-opacity', opacity[layer.id] ?? 0.9);
    }
  }, [visible, opacity, layers, ready]);

  // centre marker + fly-to (requires base layers so overlays stay on top)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !baseReady) return;
    let marker = map.getSource('centre-marker') as GeoJSONSource | undefined;
    if (!marker) {
      map.addSource('centre-marker', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'centre-marker-pin',
        type: 'circle',
        source: 'centre-marker',
        paint: {
          'circle-radius': 6,
          'circle-color': '#fbbf24',
          'circle-stroke-color': '#fff7ed',
          'circle-stroke-width': 2,
        },
      });
    }
    (map.getSource('centre-marker') as GeoJSONSource)?.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [location.lon, location.lat] },
        },
      ],
    });
    map.flyTo({ center: [location.lon, location.lat], zoom: Math.max(map.getZoom(), 8), duration: 900 });
  }, [location, ready, baseReady]);

  // fire detections overlay (kept above raster layers)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !baseReady) return;
    if (!map.getSource('fire-detections')) {
      map.addSource('fire-detections', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'fire-detections-pts',
        type: 'circle',
        source: 'fire-detections',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3, 10, 9],
          'circle-color': [
            'match',
            ['get', 'confidence'],
            'high', '#ef4444',
            'nominal', '#f59e0b',
            'low', '#78716c',
            '#f59e0b',
          ],
          'circle-stroke-width': 1,
          'circle-stroke-color': 'rgba(0,0,0,0.6)',
        },
      });
    }
    (map.getSource('fire-detections') as GeoJSONSource)?.setData(
      fireDetectionsGeoJson ?? { type: 'FeatureCollection', features: [] },
    );
  }, [fireDetectionsGeoJson, ready, baseReady]);

  // boundary drawing render
  const drawData = useCallback((): GeoJSON.FeatureCollection => {
    const ring = farmBoundary ?? [];
    const features: GeoJSON.Feature[] = [];
    if (ring.length >= 1) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: ring },
      });
      for (const c of ring) {
        features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } });
      }
    }
    return { type: 'FeatureCollection', features };
  }, [farmBoundary]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !baseReady) return;
    if (!map.getSource('boundary-draft')) {
      map.addSource('boundary-draft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'boundary-draft-line',
        type: 'line',
        source: 'boundary-draft',
        paint: { 'line-color': '#34d399', 'line-width': 2, 'line-dasharray': [2, 1] },
      });
      map.addLayer({
        id: 'boundary-draft-pts',
        type: 'circle',
        source: 'boundary-draft',
        filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 4, 'circle-color': '#34d399', 'circle-stroke-color': '#060b14' },
      });
    }
    (map.getSource('boundary-draft') as GeoJSONSource)?.setData(drawData());
  }, [drawData, ready, baseReady]);

  // click to draw
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !baseReady) return;
    const onClick = (e: MapMouseEvent) => {
      if (!drawMode) return;
      setFarmBoundary([...(farmBoundary ?? []), [Number(e.lngLat.lng.toFixed(6)), Number(e.lngLat.lat.toFixed(6))]]);
    };
    map.on('click', onClick);
    return () => map.off('click', onClick);
  }, [drawMode, farmBoundary, setFarmBoundary, ready, baseReady]);

  const boundaryComplete = (farmBoundary?.length ?? 0) >= 3;

  return (
    <div className="relative">
      <div ref={containerRef} style={{ height }} className="w-full rounded-lg border border-slate-800 overflow-hidden" role="application" aria-label="Interactive NASA satellite imagery map" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#060b14]/80 text-slate-400 text-sm rounded-lg" role="status">
          <span className="animate-pulse motion-reduce:animate-none">Loading map…</span>
        </div>
      )}

      {/* Layer control panel */}
      <div className="absolute left-3 top-3 z-10 w-64 max-w-[calc(100%-1.5rem)] rounded-lg border border-slate-700 bg-[#0a101c]/95 backdrop-blur p-3 text-xs">
        <div className="flex items-center gap-1.5 font-semibold text-slate-200 mb-2">
          <Layers className="h-3.5 w-3.5 text-emerald-400" aria-hidden /> Layers · {mapDate}
        </div>
        <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
          {layers.map((layer) => (
            <div key={layer.id} className="rounded border border-slate-800 bg-slate-900/60 p-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-emerald-500"
                  checked={visible[layer.id] ?? false}
                  onChange={(e) => setVisible((v) => ({ ...v, [layer.id]: e.target.checked }))}
                  aria-label={`Toggle ${layer.name}`}
                />
                <span className="min-w-0">
                  <span className="block font-medium text-slate-200 leading-tight">{layer.name}</span>
                  <span className="block text-[10px] text-slate-500">
                    <span style={{ color: GROUP_COLORS[layer.group] ?? '#94a3b8' }}>●</span> {layer.resolution} · {layer.cadence}
                  </span>
                </span>
              </label>
              {visible[layer.id] && (
                <div className="mt-1.5 flex items-center gap-2">
                  <Slider
                    value={[Math.round((opacity[layer.id] ?? 0.9) * 100)]}
                    min={0}
                    max={100}
                    step={5}
                    onValueChange={(v) => setOpacity((o) => ({ ...o, [layer.id]: v[0] / 100 }))}
                    className="flex-1"
                    aria-label={`Opacity for ${layer.name}`}
                  />
                  <span className="w-8 text-right text-[10px] text-slate-400">{Math.round((opacity[layer.id] ?? 0.9) * 100)}%</span>
                  <button
                    className="text-[10px] underline text-slate-400 hover:text-slate-200"
                    onClick={() => setLegend(legend?.id === layer.id ? null : layer)}
                    aria-label={`Show details for ${layer.name}`}
                  >
                    info
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {legend && (
          <div className="mt-2 rounded border border-slate-700 bg-slate-900 p-2 text-[10px] leading-relaxed text-slate-400">
            <div className="font-semibold text-slate-200">{legend.name}</div>
            <div>Product: {legend.productSource}</div>
            <div>Coverage: {legend.temporalCoverage}</div>
            <div className="mt-1 text-slate-500">{legend.limitations}</div>
          </div>
        )}
      </div>

      {/* Boundary drawing toolbar */}
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1.5">
        {!drawMode ? (
          <Button
            size="sm"
            variant="outline"
            className="bg-[#0a101c]/95 border-slate-700 text-slate-200 hover:bg-slate-800 h-8 text-xs"
            onClick={() => setDrawMode(true)}
          >
            <Pencil className="h-3.5 w-3.5 mr-1" aria-hidden /> Draw boundary
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant={boundaryComplete ? 'default' : 'outline'}
              className={cn('bg-[#0a101c]/95 border-slate-700 text-xs h-8', boundaryComplete ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'text-slate-200 hover:bg-slate-800')}
              disabled={!boundaryComplete}
              onClick={() => setDrawMode(false)}
              title="Finish boundary (leaves the ring stored in session; save it in Farm Workspace)"
            >
              <Check className="h-3.5 w-3.5 mr-1" aria-hidden /> Finish ({farmBoundary?.length ?? 0})
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="bg-[#0a101c]/95 border-slate-700 text-slate-200 hover:bg-slate-800 h-8 text-xs"
              onClick={() => {
                setDrawMode(false);
                setFarmBoundary(null);
              }}
            >
              <X className="h-3.5 w-3.5 mr-1" aria-hidden /> Cancel
            </Button>
            {(farmBoundary?.length ?? 0) > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="bg-[#0a101c]/95 border-slate-700 text-slate-300 hover:bg-slate-800 h-8 text-xs"
                onClick={() => setFarmBoundary((farmBoundary ?? []).slice(0, -1))}
                aria-label="Remove last vertex"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Undo point
              </Button>
            )}
          </>
        )}
      </div>

      <div className="absolute bottom-3 left-3 z-10 rounded border border-slate-800 bg-[#0a101c]/90 px-2 py-1 text-[10px] text-slate-400 max-w-[60%]">
        Basemap + overlays: NASA EOSDIS GIBS · WMTS · draw a boundary, then save it in Farm Workspace
      </div>
    </div>
  );
}

function expandTemplate(layer: MapLayerInfo, date: string): string {
  const fmt = layer.format === 'image/jpeg' ? 'jpg' : 'png';
  const level = layer.tileMatrixSet.replace('GoogleMapsCompatible_Level', '');
  const effDate = layer.id.includes('NDVI_16Day') ? snap16(date) : date;
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer.id}/default/${effDate}/GoogleMapsCompatible_Level${level}/{z}/{y}/{x}.${fmt}`;
}
