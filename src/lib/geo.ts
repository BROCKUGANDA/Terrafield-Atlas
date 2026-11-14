/**
 * Safe GeoJSON handling: parsing, validation, measurement.
 * All farmer-supplied boundary geometry passes through here before storage.
 */

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface ParsedBoundary {
  ok: true;
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  centroid: { lat: number; lon: number };
  bbox: BoundingBox;
  areaHa: number;
  vertices: number;
}

export interface BoundaryRejection {
  ok: false;
  reason: string;
}

const MAX_VERTICES = 64;
const MAX_AREA_HA = 50_000; // 500 km² sanity ceiling for the demo
const EARTH_R = 6_378_137; // WGS84 equatorial radius (m)

export function parseBoundaryGeoJson(raw: string): ParsedBoundary | BoundaryRejection {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'GeoJSON is not valid JSON' };
  }
  if (typeof obj !== 'object' || obj === null) return { ok: false, reason: 'GeoJSON must be an object' };
  const o = obj as Record<string, unknown>;
  const type = o.type;
  // Accept a bare geometry or a Feature whose geometry is a Polygon
  let geometry: { type: unknown; coordinates: unknown } | undefined;
  if (type === 'Feature') {
    const g = o.geometry;
    if (typeof g === 'object' && g !== null) geometry = g as { type: unknown; coordinates: unknown };
  } else if (type === 'Polygon') {
    geometry = o as { type: unknown; coordinates: unknown };
  }
  if (!geometry || geometry.type !== 'Polygon') {
    return { ok: false, reason: 'boundary must be a GeoJSON Polygon (or a Feature containing one)' };
  }
  const rings = geometry.coordinates;
  if (!Array.isArray(rings) || rings.length === 0 || !Array.isArray(rings[0])) {
    return { ok: false, reason: 'polygon must have at least one ring array' };
  }
  // Use the exterior ring only; ignore holes (rejected if present for a farm field)
  if (rings.length > 1) return { ok: false, reason: 'farm boundaries cannot contain holes (multiple rings)' };
  const ring = rings[0] as unknown;
  if (!Array.isArray(ring)) return { ok: false, reason: 'ring must be an array of positions' };
  if (ring.length < 4) return { ok: false, reason: `polygon ring needs ≥ 4 positions (got ${ring.length})` };
  if (ring.length - 1 > MAX_VERTICES) {
    return { ok: false, reason: `too many vertices (${ring.length - 1}); maximum is ${MAX_VERTICES} for the demo` };
  }
  const pts: { lat: number; lon: number }[] = [];
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) return { ok: false, reason: 'each position must be [lon, lat] or [lon, lat, z]' };
    const lon = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { ok: false, reason: 'non-numeric coordinates rejected' };
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return { ok: false, reason: `out-of-range coordinate (${lon.toFixed(4)}, ${lat.toFixed(4)})` };
    }
    pts.push({ lat, lon });
  }
  // ring closure
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first.lat !== last.lat || first.lon !== last.lon) {
    return { ok: false, reason: 'ring is not closed (first and last positions must match)' };
  }
  // self-intersection (segment sweep, O(n²), n ≤ 64)
  if (hasSelfIntersection(pts)) {
    return { ok: false, reason: 'boundary self-intersects; draw a simple (non-crossing) polygon' };
  }
  const areaHa = polygonAreaHa(pts);
  if (areaHa <= 0) return { ok: false, reason: 'polygon has zero area' };
  if (areaHa > MAX_AREA_HA) {
    return { ok: false, reason: `polygon area ${(areaHa / 1000).toFixed(1)} km² exceeds the ${(MAX_AREA_HA / 1000).toFixed(0)} km² demo ceiling` };
  }
  const centroid = centroidOf(pts);
  const bbox = bboxOf(pts);
  return {
    ok: true,
    geometry: { type: 'Polygon', coordinates: [ring.map((p) => [Number(p[0]), Number(p[1])] as number[])] },
    centroid,
    bbox,
    areaHa: Number(areaHa.toFixed(2)),
    vertices: pts.length - 1,
  };
}

function hasSelfIntersection(pts: { lat: number; lon: number }[]): boolean {
  const n = pts.length - 1; // excluding closing point
  const seg = (i: number) => ({ a: pts[i], b: pts[(i + 1) % n] });
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue; // adjacent edges may share endpoints
      if (segmentsIntersect(seg(i), seg(j))) return true;
    }
  }
  return false;
}

function segmentsIntersect(
  s1: { a: { lat: number; lon: number }; b: { lat: number; lon: number } },
  s2: { a: { lat: number; lon: number }; b: { lat: number; lon: number } },
): boolean {
  const ccw = (a: { lat: number; lon: number }, b: { lat: number; lon: number }, c: { lat: number; lon: number }) =>
    (c.lat - a.lat) * (b.lon - a.lon) > (b.lat - a.lat) * (c.lon - a.lon);
  return (
    ccw(s1.a, s1.b, s2.a) !== ccw(s1.a, s1.b, s2.b) &&
    ccw(s2.a, s2.b, s1.a) !== ccw(s2.a, s2.b, s1.b)
  );
}

/** Planar approximation of polygon area (shoelace, degrees → metres at centroid latitude). */
function polygonAreaHa(pts: { lat: number; lon: number }[]): number {
  const c = centroidOf(pts);
  const mPerDegLat = (Math.PI / 180) * EARTH_R;
  const mPerDegLon = (Math.PI / 180) * EARTH_R * Math.cos((c.lat * Math.PI) / 180);
  let sum = 0;
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) {
    const x1 = pts[i].lon * mPerDegLon;
    const y1 = pts[i].lat * mPerDegLat;
    const x2 = pts[(i + 1) % n].lon * mPerDegLon;
    const y2 = pts[(i + 1) % n].lat * mPerDegLat;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2) / 10_000;
}

function centroidOf(pts: { lat: number; lon: number }[]): { lat: number; lon: number } {
  const n = pts.length - 1;
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < n; i++) {
    lat += pts[i].lat;
    lon += pts[i].lon;
  }
  return { lat: Number((lat / n).toFixed(6)), lon: Number((lon / n).toFixed(6)) };
}

function bboxOf(pts: { lat: number; lon: number }[]): BoundingBox {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const p of pts) {
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  return { west, south, east, north };
}

/** bbox (~0.25° ≈ 28 km) around a point — used for fire-observation queries. */
export function regionBboxAround(lat: number, lon: number, padDeg = 0.125): BoundingBox {
  return {
    west: Number((lon - padDeg).toFixed(3)),
    east: Number((lon + padDeg).toFixed(3)),
    south: Number((lat - padDeg).toFixed(3)),
    north: Number((lat + padDeg).toFixed(3)),
  };
}

export function regionKeyFor(lat: number, lon: number): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}
