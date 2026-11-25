import type { FarmSummary } from '@/lib/api-client';

export type FarmMapRecord = Pick<FarmSummary, 'id' | 'name' | 'centroidLat' | 'centroidLon'>;

export interface FarmMapFocus {
  lat: number;
  lon: number;
  label: string;
}

export function farmPinCollection(farms: readonly FarmMapRecord[]): GeoJSON.FeatureCollection<
  GeoJSON.Point,
  { farmId: string; name: string }
> {
  return {
    type: 'FeatureCollection',
    features: farms.flatMap((farm) => {
      if (!Number.isFinite(farm.centroidLat) || farm.centroidLat < -90 || farm.centroidLat > 90) return [];
      if (!Number.isFinite(farm.centroidLon) || farm.centroidLon < -180 || farm.centroidLon > 180) return [];
      return [{
        type: 'Feature' as const,
        id: farm.id,
        properties: { farmId: farm.id, name: farm.name },
        geometry: { type: 'Point' as const, coordinates: [farm.centroidLon, farm.centroidLat] },
      }];
    }),
  };
}

export function selectedFarmFocus(farms: readonly FarmMapRecord[], activeFarmId: string | null): FarmMapFocus | null {
  if (!activeFarmId) return null;
  const farm = farms.find((candidate) => candidate.id === activeFarmId);
  if (!farm || !farmPinCollection([farm]).features.length) return null;
  return { lat: farm.centroidLat, lon: farm.centroidLon, label: farm.name };
}