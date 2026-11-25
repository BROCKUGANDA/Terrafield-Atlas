'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Map as MlMap, NavigationControl, AttributionControl, Popup, setWorkerUrl } from 'maplibre-gl';
import type { GeoJSONSource, RasterTileSource, MapLayerMouseEvent, MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useSession } from '@/components/state/store';
import type { FarmSummary, MapLayerInfo } from '@/lib/api-client';
import { farmPinCollection, selectedFarmFocus } from '@/lib/map/farm-pins';
import { latestDailyGibsDate } from '@/lib/map/gibs-availability';
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

/** Legend-chip hues per layer group (mirrors the mission palette). */
const GROUP_COLORS: Record<string, string> = {
  'satellite-imagery': '#4cc3ff', // aqua
  vegetation: '#45e39a', // signal
  'soil-moisture': '#8da2ff', // iris
};

export interface GibsMapProps {
  layers: MapLayerInfo[];
  farms: FarmSummary[];
  activeFarmId: string | null;
  height?: string;
}

export function GibsMap({ layers, farms, activeFarmId, height = '70vh' }: GibsMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const { location, mapDate, setMapDate, fireDetectionsGeoJson, farmBoundary, setFarmBoundary } = useSession();
  const initialLocationRef = useRef(location);
  const popupRef = useRef<Popup | null>(null);
  const activeRasterSourceRef = useRef<string | null>(null);
  const activeRasterLayerRef = useRef<string | null>(null);
  const imageryRequestKeyRef = useRef('');
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [opacity, setOpacity] = useState<Record<string, number>>({});
  const [drawMode, setDrawMode] = useState(false);
  const [legend, setLegend] = useState<MapLayerInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [baseReady, setBaseReady] = useState(false);
  const [imageryResult, setImageryResult] = useState<{ key: string; status: 'ready' | 'unavailable' } | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<{ requested: string; available: string; layerId: string; lat: number; lon: number } | null>(null);
  const farmFeatures = useMemo(() => farmPinCollection(farms), [farms]);
  const focus = selectedFarmFocus(farms, activeFarmId) ?? location;
  const activeRasterLayer = layers.find((layer) => visible[layer.id]);
  const activeRasterSourceId = activeRasterLayer ? `gibs-${activeRasterLayer.id}` : null;
  const imageryRequestKey = activeRasterLayer ? `${activeRasterLayer.id}|${mapDate}|${focus.lat}|${focus.lon}` : '';
  const imageryStatus = !activeRasterSourceId
    ? 'no-layer'
    : imageryResult?.key === imageryRequestKey
      ? imageryResult.status
      : 'loading';
  const showingFallback = fallbackNotice?.available === mapDate && fallbackNotice.layerId === activeRasterLayer?.id && fallbackNotice.lat === focus.lat && fallbackNotice.lon === focus.lon;

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
      center: [initialLocationRef.current.lon, initialLocationRef.current.lat],
      zoom: 8,
      attributionControl: false,
    });
    mapRef.current = map;
    map.on('load', () => setReady(true));
    map.on('sourcedata', (event) => {
      const sourceEvent = event as { sourceId?: string; sourceDataType?: string };
      if (sourceEvent.sourceId === activeRasterSourceRef.current && sourceEvent.sourceDataType === 'content') {
        setImageryResult({ key: imageryRequestKeyRef.current, status: 'ready' });
      }
    });
    map.on('idle', () => {
      const sourceId = activeRasterSourceRef.current;
      if (!sourceId || !map.getSource(sourceId) || !map.isSourceLoaded(sourceId)) return;
      const key = imageryRequestKeyRef.current;
      setImageryResult((previous) => previous?.key === key && previous.status === 'unavailable'
        ? previous
        : { key, status: 'ready' });
    });
    map.on('error', (event) => {
      const sourceError = event as unknown as { sourceId?: string; error?: { message?: string } };
      const activeLayerId = activeRasterLayerRef.current;
      const errorMessage = sourceError.error?.message ?? '';
      if (activeLayerId && (sourceError.sourceId === activeRasterSourceRef.current || errorMessage.includes(activeLayerId))) {
        const key = imageryRequestKeyRef.current;
        setImageryResult((previous) => previous?.key === key && previous.status === 'ready'
          ? previous
          : { key, status: 'unavailable' });
      }
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      popupRef.current?.remove();
      popupRef.current = null;
      map.remove();
      mapRef.current = null;
      setReady(false);
      setBaseReady(false);
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
    setVisible((v) => (Object.keys(v).length === 0 ? { [first.id]: true } : v));
     
    setOpacity((o) => (Object.keys(o).length === 0 ? Object.fromEntries(layers.map((l) => [l.id, 0.9])) : o));
     
    setBaseReady(true);
     
  // Date changes are applied by the source-update effect below; recreating the
  // whole map on every date pick would discard user pan/zoom state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  useEffect(() => {
    activeRasterSourceRef.current = activeRasterSourceId;
    activeRasterLayerRef.current = activeRasterLayer?.id ?? null;
    imageryRequestKeyRef.current = imageryRequestKey;
    if (!ready || !baseReady || !activeRasterSourceId) return;
    const timer = window.setTimeout(() => {
      setImageryResult((previous) => previous?.key === imageryRequestKey
        ? previous
        : { key: imageryRequestKey, status: 'unavailable' });
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [activeRasterLayer, activeRasterSourceId, baseReady, imageryRequestKey, ready]);

  useEffect(() => {
    if (!ready || activeRasterLayer?.id !== 'MODIS_Terra_CorrectedReflectance_TrueColor') return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    void latestDailyGibsDate(activeRasterLayer, mapDate, focus.lat, focus.lon, controller.signal).then((availableDate) => {
      if (controller.signal.aborted) return;
      if (!availableDate) {
        setImageryResult({ key: imageryRequestKey, status: 'unavailable' });
        return;
      }
      if (availableDate !== mapDate) {
        setFallbackNotice({ requested: mapDate, available: availableDate, layerId: activeRasterLayer.id, lat: focus.lat, lon: focus.lon });
        setMapDate(availableDate);
      }
    }).catch(() => undefined);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [activeRasterLayer, focus.lat, focus.lon, imageryRequestKey, mapDate, ready, setMapDate]);

  // Centre on the selected farm when available; otherwise use the free coordinate.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !baseReady) return;
    const marker = map.getSource('centre-marker') as GeoJSONSource | undefined;
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
          geometry: { type: 'Point', coordinates: [focus.lon, focus.lat] },
        },
      ],
    });
    map.flyTo({ center: [focus.lon, focus.lat], zoom: Math.max(map.getZoom(), 8), duration: 900 });
  }, [focus.lat, focus.lon, ready, baseReady]);

  // Public and owner-visible farm pins come from the account-filtered farms API.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !baseReady) return;
    if (!map.getSource('farm-pins')) {
      map.addSource('farm-pins', { type: 'geojson', data: farmFeatures });
      map.addLayer({
        id: 'farm-pins',
        type: 'circle',
        source: 'farm-pins',
        paint: {
          'circle-radius': 7,
          'circle-color': '#4cc3ff',
          'circle-stroke-color': '#f8fafc',
          'circle-stroke-width': 2,
          'circle-opacity': 0.95,
        },
      });
    }
    (map.getSource('farm-pins') as GeoJSONSource).setData(farmFeatures);
    map.setPaintProperty('farm-pins', 'circle-radius', ['case', ['==', ['get', 'farmId'], activeFarmId ?? ''], 10, 7]);
    map.setPaintProperty('farm-pins', 'circle-color', ['case', ['==', ['get', 'farmId'], activeFarmId ?? ''], '#fbbf24', '#4cc3ff']);
    const onFarmClick = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature || feature.geometry.type !== 'Point') return;
      const [lon, lat] = feature.geometry.coordinates;
      popupRef.current?.remove();
      popupRef.current = new Popup({ closeOnClick: true }).setLngLat([lon, lat]).setText(String(feature.properties?.name ?? 'Farm')).addTo(map);
    };
    const onFarmEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const onFarmLeave = () => { map.getCanvas().style.cursor = ''; };
    map.on('click', 'farm-pins', onFarmClick);
    map.on('mouseenter', 'farm-pins', onFarmEnter);
    map.on('mouseleave', 'farm-pins', onFarmLeave);
    return () => {
      map.off('click', 'farm-pins', onFarmClick);
      map.off('mouseenter', 'farm-pins', onFarmEnter);
      map.off('mouseleave', 'farm-pins', onFarmLeave);
    };
  }, [activeFarmId, farmFeatures, ready, baseReady]);

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
    return () => {
      map.off('click', onClick);
    };
  }, [drawMode, farmBoundary, setFarmBoundary, ready, baseReady]);

  const boundaryComplete = (farmBoundary?.length ?? 0) >= 3;

  return (
    <div className="relative">
      <div ref={containerRef} style={{ height }} className="w-full overflow-hidden rounded-lg border border-edge" role="application" aria-label="Interactive NASA satellite imagery map" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-void/85" role="status" aria-live="polite">
          <div className="hud hud-calm relative w-64 overflow-hidden p-4">
            <div className="sweep-mc" aria-hidden />
            <div className="flex items-center gap-3">
              <span className="anim-blink h-2 w-2 rounded-full bg-aqua" aria-hidden />
              <p className="font-mono text-[10px] uppercase tracking-wide-mc text-dim">Initialising MapLibre / GIBS…</p>
            </div>
          </div>
        </div>
      )}

      {ready && baseReady && (imageryStatus !== 'ready' || showingFallback) && (
        <div
          className="absolute bottom-12 left-1/2 z-10 w-max max-w-[calc(100%-1rem)] -translate-x-1/2 rounded-sm border border-edge bg-void/95 px-3 py-2 text-center font-mono text-[10px] uppercase tracking-wide-mc text-dim shadow-lg"
          role={imageryStatus === 'unavailable' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {showingFallback
            ? `No imagery for ${fallbackNotice.requested} here; showing latest available tile from ${fallbackNotice.available}.`
            : imageryStatus === 'loading'
            ? 'Loading real NASA GIBS imagery…'
            : imageryStatus === 'no-layer'
              ? 'Select an imagery layer to display satellite tiles.'
              : `No NASA GIBS tiles loaded for ${mapDate} here. Try another date or layer; no imagery is fabricated.`}
        </div>
      )}

      {ready && (
        <Button
          size="sm"
          variant="outline"
          className="absolute left-3 top-3 z-20 h-11 border-edge bg-panel/95 font-mono text-[11px] uppercase tracking-wide-mc text-dim sm:hidden"
          onClick={() => setLayersOpen(true)}
          aria-expanded={layersOpen}
          aria-controls="map-layer-panel"
        >
          <Layers className="h-4 w-4" aria-hidden /> Layers
        </Button>
      )}

      {/* Desktop layer panel / mobile bottom sheet. */}
      <div
        id="map-layer-panel"
        className={cn(
          'absolute left-3 top-3 z-10 w-64 max-w-[calc(100%-1.5rem)] hidden sm:block',
          layersOpen && 'bottom-3 left-3 right-3 top-auto block max-h-[70%] w-auto max-w-none overflow-y-auto rounded-sm border border-edge bg-panel/95 p-2 shadow-xl',
        )}
      >
        <div className="hud p-3 text-xs" style={{ background: 'rgba(11, 19, 34, 0.94)' }}>
          <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide-mc text-ink">
            <Layers className="h-3.5 w-3.5 text-signal" aria-hidden /> Layers
            <span className="telemetry text-faint">· {mapDate}</span>
            <button type="button" className="ml-auto h-11 px-2 text-dim sm:hidden" onClick={() => setLayersOpen(false)} aria-label="Close map layers">×</button>
          </div>
          <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide-mc text-ink">
            <Layers className="h-3.5 w-3.5 text-signal" aria-hidden /> Layers
            <span className="telemetry text-faint">· {mapDate}</span>
          </div>
          <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
            {layers.map((layer) => (
              <div key={layer.id} className="rounded-sm border border-edge bg-panel-2/60 p-2">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-signal"
                    checked={visible[layer.id] ?? false}
                    onChange={(e) => setVisible((v) => ({ ...v, [layer.id]: e.target.checked }))}
                    aria-label={`Toggle ${layer.name}`}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium leading-tight text-ink">{layer.name}</span>
                    <span className="block text-[10px] text-faint">
                      <span style={{ color: GROUP_COLORS[layer.group] ?? '#9aaacd' }} aria-hidden>●</span> {layer.resolution} · {layer.cadence}
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
                    <span className="telemetry w-8 text-right text-[10px] text-dim">{Math.round((opacity[layer.id] ?? 0.9) * 100)}%</span>
                    <button
                      className="font-mono text-[10px] uppercase tracking-wide-mc text-dim underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
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
            <div className="mt-2 rounded-sm border border-edge bg-panel-2/90 p-2 text-[10px] leading-relaxed text-dim">
              <div className="font-semibold text-ink">{legend.name}</div>
              <div>Product: {legend.productSource}</div>
              <div>Coverage: {legend.temporalCoverage}</div>
              <div className="mt-1 text-faint">{legend.limitations}</div>
            </div>
          )}
        </div>
      </div>

      {/* Boundary drawing toolbar (offset below the top-right zoom control) */}
      <div className="absolute right-3 top-[4.5rem] z-10 flex flex-col gap-1.5">
        {!drawMode ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 border-edge bg-panel/95 font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink"
            onClick={() => setDrawMode(true)}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden /> Draw boundary
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant={boundaryComplete ? 'default' : 'outline'}
              className={cn('h-8 font-mono text-[11px] uppercase tracking-wide-mc', boundaryComplete ? '' : 'border-edge bg-panel/95 text-dim hover:text-ink')}
              disabled={!boundaryComplete}
              onClick={() => setDrawMode(false)}
              title="Finish boundary (leaves the ring stored in session; save it in Farm Workspace)"
            >
              <Check className="h-3.5 w-3.5" aria-hidden /> Finish ({farmBoundary?.length ?? 0})
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 border-edge bg-panel/95 font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink"
              onClick={() => {
                setDrawMode(false);
                setFarmBoundary(null);
              }}
            >
              <X className="h-3.5 w-3.5" aria-hidden /> Cancel
            </Button>
            {(farmBoundary?.length ?? 0) > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 border-edge bg-panel/95 font-mono text-[11px] uppercase tracking-wide-mc text-dim hover:text-ink"
                onClick={() => setFarmBoundary((farmBoundary ?? []).slice(0, -1))}
                aria-label="Remove last vertex"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Undo point
              </Button>
            )}
          </>
        )}
      </div>

      <div className="absolute bottom-3 left-3 z-10 max-w-[60%] rounded-sm border border-edge bg-void/90 px-2 py-1 font-mono text-[10px] tracking-wide text-faint">
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
