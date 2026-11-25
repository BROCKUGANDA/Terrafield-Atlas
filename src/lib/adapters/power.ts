import { resilientFetch } from '@/lib/http';
import { cacheGet, cacheSet, canonicalKey } from '@/lib/cache';
import { redisRuntime } from '@/lib/redis';
import { isPrivateProvider } from '@/lib/ingest/provider-context';
import { POWER_VARIABLES, type PowerFetchResult, type VariableKey, type VariableMeta } from '@/lib/types';

/**
 * NASA POWER Daily API adapter (point requests).
 *
 * Provider: NASA Langley Research Center (LaRC) POWER Project
 * Endpoint:  https://power.larc.nasa.gov/api/temporal/daily/point
 * Auth:      none (public)
 * Rate:      documented guidance ~1 request/sec sustained, burst tolerated
 * Data:      MERRA-2 assimilated observations; satellite-era reanalysis
 * Time:      LST (local solar time) — NOT UTC; we surface this prominently
 * Coverage:  1981-01-01 → ~3 days before present
 * Resolution: 0.5° × 0.625° grid — explicitly NOT farm microclimate
 * License:   NASA open data; attribution: "NASA POWER, NASA LaRC"
 *
 * Important honesty rules enforced here:
 * - fill values (-999 / -999.0) become null (missing), never 0 and never dropped silently
 * - the MERRA-2 grid cell is a regional estimate; we label it as such downstream
 */

const POWER_BASE = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const FILL = -999;
const MAX_SPAN_DAYS = 366 * 15; // cap per request; longer ranges are chunked upstream
const DATA_LAG_DAYS = 5; // conservative availability lag buffer
export const POWER_EARLIEST = '1981-01-02';

const VAR_MAP = new Map<string, VariableMeta>(
  POWER_VARIABLES.map((v) => [v.key, v]),
);

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function compact(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export class PowerValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PowerValidationError';
  }
}

export interface PowerRequestInput {
  lat: number;
  lon: number;
  start: string; // YYYY-MM-DD
  end: string;
  variables: VariableKey[];
  correlationId?: string;
  /** Aborts the provider request when the job deadline passes. */
  signal?: AbortSignal;
}

export function validatePowerRequest(input: PowerRequestInput): void {
  if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90)
    throw new PowerValidationError('latitude must be within [-90, 90]');
  if (!Number.isFinite(input.lon) || input.lon < -180 || input.lon > 180)
    throw new PowerValidationError('longitude must be within [-180, 180]');
  const start = new Date(`${input.start}T00:00:00Z`);
  const end = new Date(`${input.end}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    throw new PowerValidationError('start/end must be YYYY-MM-DD');
  if (start >= end) throw new PowerValidationError('start must precede end');
  if (start < new Date(`${POWER_EARLIEST}T00:00:00Z`))
    throw new PowerValidationError(`start earlier than POWER coverage (${POWER_EARLIEST})`);
  const maxEnd = new Date();
  maxEnd.setUTCDate(maxEnd.getUTCDate() - DATA_LAG_DAYS);
  if (end > maxEnd)
    throw new PowerValidationError(
      `end is beyond available data (POWER lags ~3 days; use ≤ ${ymd(maxEnd)})`,
    );
  const spanDays = (end.getTime() - start.getTime()) / 86_400_000;
  if (spanDays > MAX_SPAN_DAYS)
    throw new PowerValidationError(
      `range spans ${Math.round(spanDays)} days; max supported per request is ${MAX_SPAN_DAYS} days`,
    );
  if (input.variables.length === 0) throw new PowerValidationError('no variables requested');
  for (const v of input.variables) {
    if (!VAR_MAP.has(v))
      throw new PowerValidationError(`unsupported variable: ${v}`);
  }
}

interface RawPowerResponse {
  type: string;
  geometry?: { type: string; coordinates: number[] };
  properties?: {
    parameter?: Record<string, Record<string, number | string>>;
    parameterinformation?: Record<string, unknown>;
  };
  header?: {
    api?: { version?: string; name?: string };
    sources?: string[];
    fill_value?: number;
    time_standard?: string;
    start?: string;
    end?: string;
  };
  messages?: { text?: string }[];
}

export async function fetchPowerDaily(
  input: PowerRequestInput,
): Promise<PowerFetchResult> {
  validatePowerRequest(input);
  const variables = [...input.variables].sort();
  const cacheKey = `NASA_POWER:daily:v2:${canonicalKey({ lat: input.lat, lon: input.lon, start: input.start, end: input.end, variables })}`;
  const refresh = () => refreshPowerDaily(input, cacheKey);
  return isPrivateProvider() ? refresh() : redisRuntime().singleFlight(`refresh:${cacheKey}`, refresh, { ttlMs: 60_000, lockMs: 90_000 });
}

async function refreshPowerDaily(input: PowerRequestInput, cacheKey: string): Promise<PowerFetchResult> {
  const cached = await cacheGet<PowerFetchResult>(cacheKey);
  if (cached) return cached;

  const url =
    `${POWER_BASE}?parameters=${input.variables.join(',')}` +
    `&community=AG&longitude=${input.lon.toFixed(4)}` +
    `&latitude=${input.lat.toFixed(4)}` +
    `&start=${compact(new Date(`${input.start}T00:00:00Z`))}` +
    `&end=${compact(new Date(`${input.end}T00:00:00Z`))}` +
    `&format=JSON`;

  const outcome = await resilientFetch(url, {
    provider: 'NASA_POWER',
    datasetId: 'POWER Daily API v2 (MERRA-2)',
    operation: 'daily-point',
    correlationId: input.correlationId,
    signal: input.signal,
    longRunning: true,
  });

  let parsed: RawPowerResponse;
  try {
    parsed = JSON.parse(new TextDecoder().decode(outcome.body));
  } catch {
    throw new Error('POWER response is not valid JSON');
  }
  if (parsed.header?.api?.name !== 'POWER Daily API' || !parsed.properties?.parameter) {
    throw new Error(
      `POWER response failed structural validation: ${parsed.messages?.map((m) => m.text).join('; ') ?? 'unexpected schema'}`,
    );
  }

  const fillValue = parsed.header.fill_value ?? FILL;
  const timeStandard = parsed.header.time_standard ?? 'LST';
  const apiVersion = parsed.header.api?.version ?? 'unknown';
  const sources = (parsed.header.sources ?? []).join(', ');

  const series = input.variables.map((variable) => {
    const raw = parsed.properties?.parameter?.[variable] ?? {};
    const dates = Object.keys(raw).sort();
    const points = dates.map((yyyymmdd) => {
      const dateStr = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
      const rawVal = raw[yyyymmdd];
      let num: number | null = null;
      if (typeof rawVal === 'number') num = rawVal;
      else if (typeof rawVal === 'string' && rawVal.trim() !== '' && !/^\*+$/.test(rawVal))
        num = Number(rawVal);
      if (num !== null && (num === fillValue || num === FILL || !Number.isFinite(num))) num = null;
      // physical plausibility guard: flag, do not silently clamp
      const meta = VAR_MAP.get(variable);
      if (
        num !== null &&
        meta?.plausibleMin !== undefined &&
        meta.plausibleMax !== undefined &&
        (num < meta.plausibleMin || num > meta.plausibleMax)
      )
        num = null;
      return { date: dateStr, value: num };
    });
    return { variable, unit: VAR_MAP.get(variable)!.unit, points };
  });

  const requestedPoints = series[0]?.points.length ?? 0;
  const totalValid = series.reduce((acc, s) => acc + s.points.filter((p) => p.value !== null).length, 0);
  const totalMissing = series.reduce(
    (acc, s) => acc + s.points.filter((p) => p.value === null).length, 0,
  );

  const result: PowerFetchResult = {
    lat: input.lat,
    lon: input.lon,
    start: input.start,
    end: input.end,
    series: series.map((s) => ({ variable: s.variable, unit: s.unit, points: s.points })),
    meta: {
      apiVersion,
      timeStandard,
      sources,
      fillValue,
      requestedPoints,
      validPoints: totalValid,
      missingPoints: totalMissing,
      retrievedAt: new Date().toISOString(),
      url,
    },
  };

  await cacheSet(cacheKey, result, 6 * 60 * 60 * 1000);
  return result;
}
