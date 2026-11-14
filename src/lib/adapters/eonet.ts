import { resilientFetch } from '@/lib/http';
import { cacheGet, cacheGetStale, cacheSet } from '@/lib/cache';

/**
 * NASA EONET v3 wildfire-events adapter.
 *
 * Provider: NASA Earth Observatory Natural Event Tracker (EONET) v3.
 * Endpoint: https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=open&days=<N>&limit=<M>
 * Auth: none. Reachability verified live this session (HTTP 200 from this
 * deployment sandbox, unlike the FIRMS host which egress policy blocks).
 *
 * What this data IS: curated, real wildfire EVENT records (name, start date,
 * latest point geometry) from NASA's Earth Observatory — used as a LIVE
 * fallback signal when the FIRMS host is unreachable, and as the
 * "regional wildfire events" context panel. It is event-level information,
 * NOT per-pixel detections — the panel says exactly that, honestly.
 *
 * Reliability: single provider fetch with the shared retry/backoff policy,
 * in-memory TTL cache (15 min fresh), and stale-while-revalidate serving —
 * a dead EONET degrades to the last good snapshot labeled `stale`, never to
 * fabricated data.
 */

export interface EonetWildfire {
  id: string;
  title: string;
  /** Event open date (ISO date or null when EONET omits it). */
  startedAt: string | null;
  /** Latest known position (lon, lat) from the newest geometry. */
  lon: number | null;
  lat: number | null;
  /** Human-readable source (e.g. 'InciWeb', 'Copernicus-GWIS'). */
  source: string | null;
  categories: string[];
}

export interface EonetResult {
  ok: boolean;
  /** true when the payload came from the LIVE provider (not a stale cache). */
  fresh: boolean;
  staleMs: number | null;
  days: number;
  events: EonetWildfire[];
  note: string;
}

interface EonetApiGeometry {
  date: string | null;
  type: string;
  coordinates: unknown;
}

interface EonetApiEvent {
  id: string;
  title: string;
  closed: string | null;
  categories: { id: string; title: string }[];
  sources?: { id: string; url: string }[];
  geometry: EonetApiGeometry[];
}

function extractLatestPoint(event: EonetApiEvent): { lon: number | null; lat: number | null; date: string | null } {
  // geometry entries are ordered; the last Point is the latest known position
  for (let i = event.geometry.length - 1; i >= 0; i--) {
    const g = event.geometry[i];
    if (g.type !== 'Point') continue;
    const c = g.coordinates;
    if (Array.isArray(c) && c.length >= 2 && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1]))) {
      return { lon: Number(c[0]), lat: Number(c[1]), date: g.date };
    }
  }
  return { lon: null, lat: null, date: null };
}

export async function fetchEonetWildfires(
  opts: { days?: number; limit?: number; correlationId?: string } = {},
): Promise<EonetResult> {
  const days = Math.min(Math.max(opts.days ?? 10, 1), 30);
  const limit = Math.min(Math.max(opts.limit ?? 120, 1), 300);
  const cacheKey = `EONET:wildfires:${days}:${limit}`;
  const cached = cacheGet<EonetResult>(cacheKey);
  if (cached) return { ...cached, fresh: true, staleMs: 0 };

  const url = `https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=open&days=${days}&limit=${limit}`;
  try {
    const outcome = await resilientFetch(url, {
      provider: 'EONET',
      datasetId: 'events-v3',
      operation: 'wildfire-events',
      maxAttempts: 2,
      timeoutMs: 12_000,
      correlationId: opts.correlationId,
    });
    if (!outcome.ok) {
      return staleOrEmpty(cacheKey, `EONET responded with HTTP ${outcome.status}.`);
    }
    const parsed = JSON.parse(new TextDecoder().decode(outcome.body)) as { events?: EonetApiEvent[] };
    const raw = Array.isArray(parsed.events) ? parsed.events : [];
    const events: EonetWildfire[] = raw
      .map((e) => {
        const pos = extractLatestPoint(e);
        return {
          id: e.id,
          title: e.title,
          startedAt: pos.date ?? e.closed ?? null,
          lon: pos.lon,
          lat: pos.lat,
          source: e.sources?.[0]?.id ?? null,
          categories: (e.categories ?? []).map((c) => c.title),
        };
      })
      .filter((e) => e.lat !== null && e.lon !== null);
    const result: EonetResult = {
      ok: true,
      fresh: true,
      staleMs: 0,
      days,
      events,
      note: `NASA EONET v3: ${events.length} open wildfire event(s) in the last ${days} day(s), latest known positions. Event-level curation — not per-pixel detections.`,
    };
    cacheSet(cacheKey, result, 15 * 60 * 1000);
    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return staleOrEmpty(cacheKey, `EONET unreachable (${detail}).`);
  }
}

/** Serve the last good snapshot labeled stale; otherwise an honest empty result. */
function staleOrEmpty(cacheKey: string, reason: string): EonetResult {
  const stale = cacheGetStale<EonetResult>(cacheKey);
  if (stale) {
    return {
      ...stale.value,
      fresh: false,
      staleMs: stale.staleMs,
      note: `${reason} Serving the last good EONET snapshot, labeled STALE (${Math.round(stale.staleMs / 1000)}s past its freshness window). Nothing fabricated.`,
    };
  }
  return {
    ok: false,
    fresh: false,
    staleMs: null,
    days: 0,
    events: [],
    note: `${reason} No cached EONET snapshot exists yet; the panel reports an honest empty state instead of substituting data.`,
  };
}
