import type { MapLayerInfo } from '@/lib/api-client';

type DailyGibsLayer = Pick<MapLayerInfo, 'id' | 'format' | 'tileMatrixSet'>;
type TileProbe = (url: string, signal?: AbortSignal) => Promise<boolean>;

export function dailyGibsTileUrl(layer: DailyGibsLayer, date: string, lat: number, lon: number): string | null {
  const zoom = Number(layer.tileMatrixSet.replace('GoogleMapsCompatible_Level', ''));
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22) return null;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;

  const tileCount = 2 ** zoom;
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  const x = Math.min(tileCount - 1, Math.floor(((lon + 180) / 360) * tileCount));
  const y = Math.min(tileCount - 1, Math.max(0, Math.floor(((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2) * tileCount)));
  const extension = layer.format === 'image/jpeg' ? 'jpg' : 'png';
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer.id}/default/${date}/GoogleMapsCompatible_Level${zoom}/${zoom}/${y}/${x}.${extension}`;
}

export async function latestDailyGibsDate(
  layer: DailyGibsLayer,
  startDate: string,
  lat: number,
  lon: number,
  signal?: AbortSignal,
  probe: TileProbe = gibsTileHasVisiblePixels,
  maxLookbackDays = 7,
): Promise<string | null> {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isInteger(maxLookbackDays) || maxLookbackDays < 0) return null;

  for (let offset = 0; offset <= maxLookbackDays; offset++) {
    if (signal?.aborted) return null;
    const date = new Date(start - offset * 86_400_000).toISOString().slice(0, 10);
    const url = dailyGibsTileUrl(layer, date, lat, lon);
    if (url && await probe(url, signal)) return date;
  }
  return null;
}

async function gibsTileHasVisiblePixels(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(url, { signal, credentials: 'omit' });
    if (!response.ok) return false;
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return false;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      for (let index = 0; index < pixels.length; index += 64) {
        if (pixels[index] > 5 || pixels[index + 1] > 5 || pixels[index + 2] > 5) return true;
      }
      return false;
    } finally {
      bitmap.close();
    }
  } catch {
    return false;
  }
}