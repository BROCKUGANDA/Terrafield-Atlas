import type { ObservationPoint } from '@/lib/types';

/**
 * Deterministic synthetic inputs for the benchmarks. A fixed-seed generator
 * keeps every run on identical data, so results stay comparable.
 */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Daily series shaped like a NASA POWER record: seasonal cycle, slow trend,
 * noise, and about 1% missing (null) days.
 */
export function dailySeries(opts: {
  years: number;
  startYear?: number;
  base: number;
  amplitude: number;
  trendPerYear: number;
  noise: number;
  nonNegative?: boolean;
  seed: number;
}): ObservationPoint[] {
  const rand = seededRandom(opts.seed);
  const startYear = opts.startYear ?? 2013;
  const start = Date.UTC(startYear, 0, 1);
  const end = Date.UTC(startYear + opts.years, 0, 1);
  const points: ObservationPoint[] = [];
  for (let t = start, day = 0; t < end; t += 86_400_000, day++) {
    if (rand() < 0.01) {
      points.push({ date: isoDate(t), value: null });
      continue;
    }
    const season = Math.sin((2 * Math.PI * day) / 365.25);
    let value =
      opts.base +
      opts.amplitude * season +
      (opts.trendPerYear * day) / 365.25 +
      opts.noise * (rand() - 0.5);
    if (opts.nonNegative) value = Math.max(0, value);
    points.push({ date: isoDate(t), value: Number(value.toFixed(2)) });
  }
  return points;
}

/** 12 years of daily precipitation (the default ingest length). */
export const PRECIP_12Y = dailySeries({
  years: 12, base: 3, amplitude: 4, trendPerYear: 0.05, noise: 8, nonNegative: true, seed: 1,
});

/** 12 years of daily mean temperature. */
export const T2M_12Y = dailySeries({
  years: 12, base: 18, amplitude: 3, trendPerYear: 0.03, noise: 4, seed: 2,
});

/** 30 years of daily mean temperature (long-record analysis). */
export const T2M_30Y = dailySeries({
  years: 30, startYear: 1995, base: 18, amplitude: 3, trendPerYear: 0.03, noise: 4, seed: 3,
});

/** Monthly values grouped by calendar month, as fed to seasonal Mann-Kendall. */
export function seasonalSeries(years: number, seed: number): number[][] {
  const rand = seededRandom(seed);
  return Array.from({ length: 12 }, (_, month) =>
    Array.from({ length: years }, (_, y) => 20 + 3 * Math.sin(month / 2) + 0.04 * y + 2 * (rand() - 0.5)),
  );
}

/** Flat monthly series for the non-seasonal Mann-Kendall test. */
export function monthlySeries(n: number, seed: number): number[] {
  const rand = seededRandom(seed);
  return Array.from({ length: n }, (_, i) => 10 + 0.02 * i + 3 * (rand() - 0.5));
}

export const FIRMS_HEADER =
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';

/** A FIRMS area CSV with `rows` VIIRS detections spread over `days` days. */
export function firmsCsv(rows: number, days: number, seed: number): string {
  const rand = seededRandom(seed);
  const confidences = ['l', 'n', 'h'];
  const lines = [FIRMS_HEADER];
  const start = Date.UTC(2026, 6, 1);
  for (let i = 0; i < rows; i++) {
    const lat = (-15 + rand() * 4).toFixed(5);
    const lon = (27 + rand() * 4).toFixed(5);
    const date = isoDate(start + Math.floor(rand() * days) * 86_400_000);
    const time = String(Math.floor(rand() * 24)).padStart(2, '0') + String(Math.floor(rand() * 60)).padStart(2, '0');
    const conf = confidences[Math.floor(rand() * 3)];
    const frp = (rand() * 40).toFixed(2);
    const ti4 = (300 + rand() * 60).toFixed(2);
    lines.push(`${lat},${lon},${ti4},0.39,0.36,${date},${time},N,VIIRS,${conf},2.0NRT,290.11,${frp},${rand() < 0.5 ? 'D' : 'N'}`);
  }
  return lines.join('\n');
}
