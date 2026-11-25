/**
 * Live source-probe registry — the "signs" behind every data-source status
 * chip in the console.
 *
 * Why this exists: until now the provider list in /api/v1/system/status was a
 * STATIC string ('operational (public, no auth)'). The operator asked for
 * signs that are genuinely LIVE — so this module actively probes each
 * upstream endpoint (cheap single-attempt requests, short timeouts) and
 * reports real reachability + latency, refreshed on demand with a 60 s TTL.
 *
 * Design rules:
 *  - Probes NEVER throw and NEVER open circuits or write ApiRequestLog rows
 *    (a health poll must not spam the provenance ledger or trip breakers —
 *    the real data paths do that already).
 *  - FIRMS is probed in two distinct ways, because both facts matter:
 *      1. FIRMS_API      — the FIRMS host itself (blocked by this sandbox's
 *                          egress policy → honest UNREACHABLE here, and LIVE
 *                          wherever full egress exists).
 *      2. FIRMS_STREAM   — the VIIRS 375 m detection stream FIRMS
 *                          distributes, read via NASA GIBS vector tiles
 *                          (the path fire features actually use). One real
 *                          MVT tile over the Congo basin is requested.
 *                          A sparse-tile HTTP 404 proves the host answered but
 *                          does not prove data availability; other errors are
 *                          degraded.
 *  - Every probe result is mirrored into the DataSource table (status:
 *    'live' | 'degraded' | 'unreachable') best-effort, so /api/v1/health and
 *    the provenance view agree with the live signs.
 */

import { db } from '@/lib/db';
import { redisRuntime } from '@/lib/redis';

export type SourceLiveState = 'live' | 'degraded' | 'unreachable' | 'checking';

export interface SourceSign {
  key: string;
  label: string;
  state: SourceLiveState;
  latencyMs: number | null;
  checkedAt: string;
  detail: string;
  /** True when this sign is the path fire features actually serve from. */
  servingFireDetections?: boolean;
}

export interface SourceSignsReport {
  checkedAt: string;
  probeMs: number;
  signs: SourceSign[];
  summary: { live: number; degraded: number; unreachable: number };
  note: string;
}

const PROBE_TTL_MS = 60_000;
/** 8 s: GIBS tile responses occasionally exceed 5 s under load; a probe that
 *  times out on a healthy host would flap the sign. Failures still read as
 *  DEGRADED (not UNREACHABLE) for 5 min after any success. */
const PROBE_TIMEOUT_MS = 8_000;

interface ProbeOutcome {
  state: SourceLiveState;
  latencyMs: number | null;
  detail: string;
}

async function probe(url: string, init?: RequestInit): Promise<ProbeOutcome> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
      headers: { accept: '*/*', ...(init?.headers ?? {}) },
    });
    const latencyMs = Date.now() - started;
    await res.body?.cancel();
    return { state: res.ok ? 'live' : 'degraded', latencyMs, detail: `HTTP ${res.status} in ${latencyMs} ms${res.ok ? '' : ' — endpoint did not return usable data; reachability alone is not operational health'}` };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const detail =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `timeout after ${PROBE_TIMEOUT_MS} ms`
          : err.message
        : 'network error';
    return { state: 'unreachable', latencyMs, detail };
  } finally {
    clearTimeout(timer);
  }
}

/** VIIRS thermal-anomaly tile over the Congo basin (row 40, col 80) — a day back. */
function gibsFireTileUrl(): string {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return (
    'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/VIIRS_SNPP_Thermal_Anomalies_375m_All' +
    `/default/${yesterday}/500m/7/40/80.mvt`
  );
}

async function probeFirmsApi(): Promise<ProbeOutcome> {
  // HEAD on the FIRMS host root — proves DNS+TCP+TLS+HTTP without pulling CSVs.
  const out = await probe('https://firms.modaps.eosdis.nasa.gov/', { method: 'HEAD' });
  if (out.state === 'live') return out;
  const msg = `FIRMS host check failed (${out.detail}); MAP_KEY ${process.env.FIRMS_MAP_KEY ? 'configured' : 'not configured'}. GIBS fallback availability is reported separately.`;
  return { state: out.state, latencyMs: out.latencyMs, detail: msg };
}

async function probeFirmsStreamViaGibs(): Promise<ProbeOutcome> {
  const out = await probe(gibsFireTileUrl());
  if (out.state === 'degraded' && out.detail.startsWith('HTTP 404')) {
    return {
      state: 'live',
      latencyMs: out.latencyMs,
      detail: `HTTP 404 in ${out.latencyMs ?? 0} ms — GIBS host responded; no data established for this sampled tile/date (not evidence of an outage or zero detections)`,
    };
  }
  return out;
}

async function probeGibs(): Promise<ProbeOutcome> {
  // Probe imagery independently of the sparse thermal-anomaly layer.
  const date = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  return probe(
    `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${date}/250m/0/0/0.jpg`,
  );
}

async function probeEonet(): Promise<ProbeOutcome> {
  return probe('https://eonet.gsfc.nasa.gov/api/v3/events?limit=1&days=1');
}

async function probePower(): Promise<ProbeOutcome> {
  const date = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
  return probe(`https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M&community=AG&longitude=36.07&latitude=-0.28&start=${date}&end=${date}&format=JSON`);
}

async function probeSoilGrids(): Promise<ProbeOutcome> {
  // Same host the real adapter queries (rest.isric.org, not api.isric.org).
  return probe('https://rest.isric.org/soilgrids/v2.0/properties/query?lon=27.8&lat=-13.1&property=phh2o&depth=0-5cm&value=mean');
}

interface ProbeDef {
  key: string;
  label: string;
  run: () => Promise<ProbeOutcome>;
  servingFireDetections?: boolean;
}

const PROBES: ProbeDef[] = [
  { key: 'FIRMS_STREAM', label: 'FIRMS detection stream · GIBS VIIRS 375 m', run: probeFirmsStreamViaGibs, servingFireDetections: true },
  { key: 'FIRMS_API', label: 'FIRMS API · firms.modaps.eosdis.nasa.gov', run: probeFirmsApi },
  { key: 'EONET', label: 'NASA EONET v3 · wildfire events', run: probeEonet },
  { key: 'GIBS', label: 'NASA GIBS EOSDIS · WMTS', run: probeGibs },
  { key: 'NASA_POWER', label: 'NASA POWER (LaRC) · daily record', run: probePower },
  { key: 'SOILGRIDS', label: 'ISRIC SoilGrids 2.0 · soil properties', run: probeSoilGrids },
];

interface ProbeMemory {
  lastLiveAt: number;
  lastDetail: string;
}

/** A failure within 5 min of a success reads as DEGRADED, not UNREACHABLE —
 *  one dropped probe packet is not an outage; honesty still holds because
 *  the detail names the transient failure and the age of the last success. */
const GRACE_MS = 5 * 60_000;

async function classify(key: string, out: ProbeOutcome): Promise<ProbeOutcome> {
  const runtime = redisRuntime();
  const stateKey = `source-probe:${key}`;
  const prev = await runtime.getJson<ProbeMemory>(stateKey);
  const now = Date.now();
  if (out.state === 'live') {
    await runtime.setJson(stateKey, { lastLiveAt: now, lastDetail: out.detail }, { ttlMs: GRACE_MS });
    return out;
  }
  if (prev && now - prev.lastLiveAt < GRACE_MS) {
    return {
      state: 'degraded',
      latencyMs: out.latencyMs,
      detail: `transient: ${out.detail} — last success ${Math.round((now - prev.lastLiveAt) / 1000)}s ago (${prev.lastDetail})`,
    };
  }
  return out;
}

async function syncDataSourceStatus(sign: SourceSign): Promise<void> {
  const name =
    sign.key === 'FIRMS_API' ? 'NASA FIRMS (MODIS + VIIRS active fires)' :
    sign.key === 'FIRMS_STREAM' ? 'NASA GIBS VIIRS Thermal Anomalies (fire detections)' :
    sign.key === 'EONET' ? 'NASA EONET v3' :
    sign.key === 'GIBS' ? 'NASA GIBS' :
    sign.key === 'NASA_POWER' ? 'NASA POWER' :
    'ISRIC SoilGrids';
  const status = sign.state === 'live' ? 'live' : sign.state === 'degraded' ? 'degraded' : 'unreachable';
  await db.dataSource.updateMany({
    where: { OR: [{ datasetName: name }, { provider: name }] },
    data: { status },
  });
}

/**
 * Probe every source (60 s cache). Never throws — a probing failure of ONE
 * source is that source's state; the registry itself always answers.
 */
export async function sourceSigns(force = false): Promise<SourceSignsReport> {
  const runtime = redisRuntime();
  const cacheKey = 'source-signs:report';
  if (!force) {
    const cached = await runtime.getJson<SourceSignsReport>(cacheKey);
    if (cached) return cached;
  }
  // A forced refresh must probe now, so it uses its own single-flight lane
  // with no result caching: concurrent refreshes share one probe set, but the
  // next click probes again.
  if (force) {
    return runtime.singleFlight('source-signs:refresh:force', () => collectSourceSigns(cacheKey), { ttlMs: 0, lockMs: 30_000 });
  }
  return runtime.singleFlight(`source-signs:refresh:${force ? 'force' : 'cached'}`, async () => {
    if (!force) {
      const cached = await runtime.getJson<SourceSignsReport>(cacheKey);
      if (cached) return cached;
    }
    return collectSourceSigns(cacheKey);
  }, { ttlMs: PROBE_TTL_MS, lockMs: 30_000 });
}

async function collectSourceSigns(cacheKey: string): Promise<SourceSignsReport> {
  const started = Date.now();
  const settled = await Promise.all(
    PROBES.map(async (p): Promise<SourceSign> => {
      try {
        const raw = await p.run();
        const out = await classify(p.key, raw);
        const sign: SourceSign = {
          key: p.key,
          label: p.label,
          state: out.state,
          latencyMs: out.latencyMs,
          checkedAt: new Date().toISOString(),
          detail: out.detail,
          ...(p.servingFireDetections ? { servingFireDetections: true } : {}),
        };
        await syncDataSourceStatus(sign).catch(() => undefined);
        return sign;
      } catch (err) {
        return {
          key: p.key,
          label: p.label,
          state: 'unreachable',
          latencyMs: null,
          checkedAt: new Date().toISOString(),
          detail: err instanceof Error ? err.message : 'probe failed',
          ...(p.servingFireDetections ? { servingFireDetections: true } : {}),
        };
      }
    }),
  );

  const report: SourceSignsReport = {
    checkedAt: new Date().toISOString(),
    probeMs: Date.now() - started,
    signs: settled,
    summary: {
      live: settled.filter((s) => s.state === 'live').length,
      degraded: settled.filter((s) => s.state === 'degraded').length,
      unreachable: settled.filter((s) => s.state === 'unreachable').length,
    },
    note:
      'Endpoint probes (single attempt, 8 s timeout, 60 s cache). Successful HTTP responses are LIVE; the sparse FIRMS tile probe also treats HTTP 404 as host reachability only and explicitly does not establish data availability. Other HTTP errors read as DEGRADED. Network failures read as UNREACHABLE, or DEGRADED within 5 minutes of a success. FIRMS_API tests host reachability only, not authenticated ingestion. Consult each retrieval’s provenance and no-data status for data completeness.',
  };
  await redisRuntime().setJson(cacheKey, report, { ttlMs: PROBE_TTL_MS, maxBytes: 64 * 1024 });
  return report;
}
