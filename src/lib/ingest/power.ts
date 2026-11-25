import { db } from '@/lib/db';
import { fetchPowerDaily } from '@/lib/adapters/power';
import { createManyIdempotent } from '@/lib/db-write';
import type { VariableKey } from '@/lib/types';
import { AccountAccessError } from '@/lib/account-access';
import { withPrivateProvider } from '@/lib/ingest/provider-context';

/**
 * POWER ingestion orchestrator.
 *
 * - Idempotent: rows use the natural key (namespace, lat, lon, variable, date)
 *   so re-running an ingest never duplicates observations (request dedup).
 * - Provenance: public fetches are logged to ApiRequestLog by the resilient
 *   client; private fetches bypass shared provider logs and caches.
 * - Chunking: requests are capped at 15 years; longer windows are split.
 */

export const DEFAULT_INGEST_YEARS = 12;

function chunkRange(start: string, end: string, maxDays: number): { start: string; end: string }[] {
  const chunks: { start: string; end: string }[] = [];
  let s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  while (s < e) {
    const c = new Date(s);
    c.setUTCDate(c.getUTCDate() + maxDays);
    const chunkEnd = c > e ? e : new Date(c.getTime() - 86_400_000);
    chunks.push({ start: s.toISOString().slice(0, 10), end: chunkEnd.toISOString().slice(0, 10) });
    s = c;
  }
  return chunks;
}

export interface IngestOutcome {
  lat: number;
  lon: number;
  start: string;
  end: string;
  rowsWritten: number;
  validPoints: number;
  missingPoints: number;
  chunks: number;
  firstError?: string;
}

export interface IngestOptions {
  /** Aborts the provider request when the job deadline passes. */
  signal?: AbortSignal;
  /** Cooperative checkpoint executed before every provider chunk. */
  checkpoint?: () => void | Promise<void>;
  /** Shared organization boundary for organization-owned farms. */
  organizationId?: string | null;
}

export async function ingestPowerForLocation(
  lat: number,
  lon: number,
  years: number = DEFAULT_INGEST_YEARS,
  variables: VariableKey[] = ['PRECTOTCORR', 'T2M', 'T2M_MAX', 'T2M_MIN', 'ALLSKY_SFC_SW_DWN', 'RH2M', 'GWETROOT'],
  farmId?: string,
  correlationId?: string,
  options: IngestOptions = {},
): Promise<IngestOutcome> {
  let ownerId: string | null = null;
  let organizationId: string | null = options.organizationId ?? null;
  if (farmId) {
    const farm = await db.farm.findUnique({ where: { id: farmId }, select: { ownerId: true, organizationId: true } });
    if (!farm) throw new AccountAccessError(404, 'NOT_FOUND', 'record not found');
    ownerId = farm.ownerId;
    organizationId = farm.organizationId;
  }
  const namespace = ownerId ? `farm:${farmId}` : 'public';
  const today = new Date();
  today.setUTCDate(today.getUTCDate() - 6);
  const end = today.toISOString().slice(0, 10);
  const startD = new Date(today);
  startD.setUTCFullYear(startD.getUTCFullYear() - years);
  const start = startD.toISOString().slice(0, 10);

  const chunks = chunkRange(start, end, 366 * 5); // 5-year chunks per request
  let rowsWritten = 0;
  let validPoints = 0;
  let missingPoints = 0;
  let firstError: string | undefined;

  for (const chunk of chunks) {
    try {
      // Cooperative checkpoint: never start a new provider request after the
      // job was cancelled or its overall deadline passed.
      await options.checkpoint?.();
      const fetchChunk = () => fetchPowerDaily({
        lat, lon, start: chunk.start, end: chunk.end, variables, correlationId, signal: options.signal,
      });
      const res = await (ownerId || organizationId ? withPrivateProvider(fetchChunk, organizationId) : fetchChunk());
      const rows: {
        ownerId: string | null;
        organizationId: string | null;
        namespace: string;
        farmId: string | null;
        lat: number;
        lon: number;
        variable: string;
        obsDate: Date;
        value: number;
        unit: string;
        sourceProvider: string;
        datasetVersion: string;
      }[] = [];
      for (const s of res.series) {
        for (const p of s.points) {
          if (p.value === null) {
            missingPoints++;
            continue;
          }
          validPoints++;
          rows.push({
            ownerId,
            organizationId,
            namespace,
            farmId: farmId ?? null,
            lat,
            lon,
            variable: s.variable,
            obsDate: new Date(`${p.date}T12:00:00Z`),
            value: p.value,
            unit: s.unit,
            sourceProvider: 'NASA_POWER',
            datasetVersion: `POWER ${res.meta.apiVersion} (${res.meta.sources})`,
          });
        }
      }
      // PostgreSQL natural-key upsert: (namespace, lat, lon, variable, date)
      // is enforced by a unique index, so a concurrent ingest of the same
      // observation can never duplicate or fail this chunk.
      for (let i = 0; i < rows.length; i += 500) {
        const slice = rows.slice(i, i + 500);
        const written = await createManyIdempotent(db.environmentalObservation, slice);
        rowsWritten += written;
      }
    } catch (err) {
      firstError = firstError ?? (err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  return { lat, lon, start, end, rowsWritten, validPoints, missingPoints, chunks: chunks.length, firstError };
}

// ---------------------------------------------------------------------------
// Climatology for the rotation engine + charts, from stored observations
// ---------------------------------------------------------------------------

export interface RainfallMonthlyAgg {
  p25: number[];
  p50: number[];
  p75: number[];
  years: number;
}

export interface ThermalMonthlyAgg {
  meanT: number[];
  years: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

export async function rainfallMonthlyStats(lat: number, lon: number, farmId?: string): Promise<RainfallMonthlyAgg | null> {
  const rows = await db.environmentalObservation.findMany({
    where: { lat, lon, variable: 'PRECTOTCORR', ...(farmId ? { farmId } : { ownerId: null }) },
    select: { obsDate: true, value: true },
    orderBy: { obsDate: 'asc' },
  });
  if (rows.length === 0) return null;
  // aggregate daily → monthly totals
  const perMonth = new Map<string, number>();
  for (const r of rows) {
    const key = r.obsDate.toISOString().slice(0, 7);
    perMonth.set(key, (perMonth.get(key) ?? 0) + r.value);
  }
  const bySeason: number[][] = Array.from({ length: 12 }, () => []);
  const yearsSeen = new Set<string>();
  for (const [key, total] of perMonth) {
    const [y, m] = key.split('-').map(Number);
    bySeason[m - 1].push(total);
    yearsSeen.add(String(y));
  }
  const usable = bySeason.filter((s) => s.length > 0).length;
  if (usable < 12) return null; // full calendar coverage required
  const p25 = bySeason.map((s) => quantile([...s].sort((a, b) => a - b), 0.25));
  const p50 = bySeason.map((s) => quantile([...s].sort((a, b) => a - b), 0.5));
  const p75 = bySeason.map((s) => quantile([...s].sort((a, b) => a - b), 0.75));
  return { p25, p50, p75, years: yearsSeen.size };
}

export async function thermalMonthlyStats(lat: number, lon: number, farmId?: string): Promise<ThermalMonthlyAgg | null> {
  const rows = await db.environmentalObservation.findMany({
    where: { lat, lon, variable: 'T2M', ...(farmId ? { farmId } : { ownerId: null }) },
    select: { obsDate: true, value: true },
    orderBy: { obsDate: 'asc' },
  });
  if (rows.length === 0) return null;
  const perMonth = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const key = r.obsDate.toISOString().slice(0, 7);
    const b = perMonth.get(key) ?? { sum: 0, n: 0 };
    b.sum += r.value;
    b.n++;
    perMonth.set(key, b);
  }
  const bySeason: number[][] = Array.from({ length: 12 }, () => []);
  const yearsSeen = new Set<string>();
  for (const [key, b] of perMonth) {
    const [y, m] = key.split('-').map(Number);
    if (b.n >= 20) bySeason[m - 1].push(b.sum / b.n); // complete months only
    yearsSeen.add(String(y));
  }
  if (bySeason.filter((s) => s.length > 0).length < 12) return null;
  const meanT = bySeason.map((s) => (s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0));
  return { meanT, years: yearsSeen.size };
}
