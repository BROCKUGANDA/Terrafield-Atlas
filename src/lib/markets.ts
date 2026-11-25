import { db } from '@/lib/db';
import { createManyIdempotent } from '@/lib/db-write';
import {
  fetchWfpUgandaPrices,
  HDX_DATASET_ID,
  MARKET_ATTRIBUTION,
  MARKET_COUNTRY_CODE,
  MARKET_DATASET_NAME,
  MARKET_LICENCE,
  MARKET_SOURCE_PROVIDER,
  MARKET_SOURCE_URL,
  MARKET_DEFAULT_WINDOW_MONTHS,
  type WfpPriceCounts,
} from '@/lib/adapters/marketPrices';

/**
 * Market-price persistence and aggregation.
 *
 * Stored rows are market-survey observations downloaded from HDX/WFP, never
 * modeled or interpolated values. Aggregation is deliberately median-first:
 * a handful of extreme market quotes must not move a commodity's headline
 * price, and `min`/`max` expose the dispersion instead of hiding it.
 */

export const MARKET_QUERY_ROW_CAP = 100_000;

export interface MonthlyPriceAggregate {
  month: string; // YYYY-MM
  median: number;
  min: number;
  max: number;
  sampleCount: number;
}

/**
 * Monthly median/min/max over positive prices. Rows are grouped by UTC month,
 * which is the observation month in the provider CSV (dates have no time).
 */
export function aggregateMonthlyPrices(
  rows: readonly { priceDate: Date | string; price: number }[],
): MonthlyPriceAggregate[] {
  const buckets = new Map<string, number[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.price) || row.price <= 0) continue;
    const date = row.priceDate instanceof Date ? row.priceDate : new Date(row.priceDate);
    if (!Number.isFinite(date.getTime())) continue;
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const bucket = buckets.get(month);
    if (bucket) bucket.push(row.price);
    else buckets.set(month, [row.price]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, values]) => {
      values.sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      const median = values.length % 2 === 1
        ? values[middle]
        : (values[middle - 1] + values[middle]) / 2;
      return {
        month,
        median,
        min: values[0],
        max: values[values.length - 1],
        sampleCount: values.length,
      };
    });
}

export interface MarketQueryInput {
  commodityId?: string;
  marketId?: string;
  unit?: string;
  currency?: string;
  from?: string;
  to?: string;
}

export interface MarketIngestionRecord {
  id: string;
  datasetId: string;
  resourceUrl: string;
  resourceUpdatedAt: string | null;
  rowCount: number;
  accepted: number;
  skipped: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorDetail: string | null;
}

export interface MarketQueryResult {
  countryCode: string;
  range: { from: string; to: string };
  selection: {
    commodityId: string | null;
    marketId: string | null;
    unit: string | null;
    currency: string | null;
  };
  coverage: {
    storedRows: number;
    firstDate: string | null;
    lastDate: string | null;
    monthsWithData: number;
    truncated: boolean;
    commodities: { id: string; name: string; observations: number }[];
    markets: { id: string; name: string; observations: number }[];
  };
  series: MonthlyPriceAggregate[];
  provenance: {
    provider: string;
    datasetId: string;
    datasetName: string;
    countryCode: string;
    licence: string;
    attribution: string;
    sourceUrl: string;
    retrievedAt: string | null;
    resourceUrl: string | null;
    resourceUpdatedAt: string | null;
    latestIngestion: MarketIngestionRecord | null;
    note: string;
  };
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function serializeIngestion(row: {
  id: string; datasetId: string; resourceUrl: string; resourceUpdatedAt: Date | null;
  rowCount: number; accepted: number; skipped: number; status: string;
  startedAt: Date; finishedAt: Date | null; errorDetail: string | null;
}): MarketIngestionRecord {
  return {
    id: row.id,
    datasetId: row.datasetId,
    resourceUrl: row.resourceUrl,
    resourceUpdatedAt: iso(row.resourceUpdatedAt),
    rowCount: row.rowCount,
    accepted: row.accepted,
    skipped: row.skipped,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    errorDetail: row.errorDetail,
  };
}

/** Read-only monthly series + coverage + provenance for the stored feed. */
export async function queryMarketPrices(input: MarketQueryInput = {}): Promise<MarketQueryResult> {
  const totals = await db.marketPrice.aggregate({
    where: { countryCode: MARKET_COUNTRY_CODE },
    _count: true,
    _min: { priceDate: true },
    _max: { priceDate: true },
  });
  const storedRows = totals._count;
  const firstDate = totals._min.priceDate ?? null;
  const lastDate = totals._max.priceDate ?? null;

  const anchor = input.to ? new Date(`${input.to}T00:00:00.000Z`) : lastDate ?? new Date();
  const defaultTo = Number.isFinite(anchor.getTime()) ? anchor : new Date();
  const to = input.to ?? defaultTo.toISOString().slice(0, 10);
  const from = input.from ?? new Date(Date.UTC(defaultTo.getUTCFullYear(), defaultTo.getUTCMonth() - (MARKET_DEFAULT_WINDOW_MONTHS - 1), 1)).toISOString().slice(0, 10);
  const validRange = from <= to;
  const range = { from, to };
  const priceDate = {
    gte: validRange ? new Date(`${from}T00:00:00.000Z`) : new Date(0),
    lte: validRange ? new Date(`${to}T23:59:59.999Z`) : new Date(0),
  };

  const [commodityGroups, marketGroups, latestIngestion] = await Promise.all([
    db.marketPrice.groupBy({
      by: ['commodityId', 'commodityName'],
      where: { countryCode: MARKET_COUNTRY_CODE, priceDate },
      _count: { _all: true },
      orderBy: { commodityId: 'asc' },
      take: 500,
    }),
    db.marketPrice.groupBy({
      by: ['marketId', 'marketName'],
      where: { countryCode: MARKET_COUNTRY_CODE, priceDate },
      _count: { _all: true },
      orderBy: { marketId: 'asc' },
      take: 500,
    }),
    db.marketIngestion.findFirst({
      where: { datasetId: HDX_DATASET_ID },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    }),
  ]);

  const commodities = commodityGroups
    .map((group) => ({ id: group.commodityId, name: group.commodityName, observations: group._count._all }))
    .sort((a, b) => b.observations - a.observations || a.name.localeCompare(b.name));
  const markets = marketGroups
    .map((group) => ({ id: group.marketId, name: group.marketName, observations: group._count._all }))
    .sort((a, b) => b.observations - a.observations || a.name.localeCompare(b.name));

  const commodityId = input.commodityId ?? commodities[0]?.id ?? null;
  const marketId = input.marketId ?? null;
  const baseWhere = commodityId
    ? {
      countryCode: MARKET_COUNTRY_CODE,
      priceDate,
      commodityId,
      ...(marketId ? { marketId } : {}),
    }
    : null;

  let unit = input.unit ?? null;
  let currency = input.currency ?? null;
  if (baseWhere && (!unit || !currency)) {
    const unitGroups = await db.marketPrice.groupBy({
      by: ['unit', 'currency'],
      where: { ...baseWhere, ...(unit ? { unit } : {}), ...(currency ? { currency } : {}) },
      _count: { _all: true },
      orderBy: { unit: 'asc' },
      take: 100,
    });
    const dominant = unitGroups.sort((a, b) => b._count._all - a._count._all)[0];
    unit ??= dominant?.unit ?? null;
    currency ??= dominant?.currency ?? null;
  }

  let truncated = false;
  let series: MonthlyPriceAggregate[] = [];
  if (baseWhere && unit && currency) {
    const rows = await db.marketPrice.findMany({
      where: { ...baseWhere, unit, currency },
      select: { priceDate: true, price: true },
      orderBy: [{ priceDate: 'asc' }],
      take: MARKET_QUERY_ROW_CAP + 1,
    });
    truncated = rows.length > MARKET_QUERY_ROW_CAP;
    series = aggregateMonthlyPrices(rows.slice(0, MARKET_QUERY_ROW_CAP));
  }

  return {
    countryCode: MARKET_COUNTRY_CODE,
    range,
    selection: { commodityId, marketId, unit, currency },
    coverage: {
      storedRows,
      firstDate: iso(firstDate),
      lastDate: iso(lastDate),
      monthsWithData: series.length,
      truncated,
      commodities,
      markets,
    },
    series,
    provenance: {
      provider: MARKET_SOURCE_PROVIDER,
      datasetId: HDX_DATASET_ID,
      datasetName: MARKET_DATASET_NAME,
      countryCode: MARKET_COUNTRY_CODE,
      licence: MARKET_LICENCE,
      attribution: MARKET_ATTRIBUTION,
      sourceUrl: MARKET_SOURCE_URL,
      retrievedAt: iso(latestIngestion?.finishedAt ?? latestIngestion?.startedAt),
      resourceUrl: latestIngestion?.resourceUrl || null,
      resourceUpdatedAt: iso(latestIngestion?.resourceUpdatedAt),
      latestIngestion: latestIngestion ? serializeIngestion(latestIngestion) : null,
      note: 'Nominal retail market-survey prices in local currency per stated unit, aggregated as a monthly median with min/max and sample count. Missing market-months are not zero, and these observations are not forecasts, farm-gate contract prices or a basis for yield/profit claims.',
    },
  };
}

export interface MarketIngestCounts extends WfpPriceCounts {
  /** Rows newly stored by this run. */
  accepted: number;
  /** Unique, valid, in-window rows the CSV yielded before the database upsert. */
  eligible: number;
  inserted: number;
  alreadyStored: number;
  skipped: number;
}

export interface MarketIngestionOutcome {
  ingestion: MarketIngestionRecord;
  counts: MarketIngestCounts;
  dataset: { title: string; licence: string };
  resource: { name: string | null; url: string; updatedAt: string | null };
  window: { months: number; cutoff: string };
  retrievedAt: string;
}

/**
 * Download and persist the latest HDX/WFP Uganda feed.
 *
 * The MarketIngestion row is written before the provider call, so a timeout or
 * provider failure leaves an auditable `failed` record and NO price rows from
 * that attempt. Existing rows are untouched (natural-key skipDuplicates).
 */
export async function ingestMarketPrices(options: {
  signal?: AbortSignal;
  correlationId?: string;
} = {}): Promise<MarketIngestionOutcome> {
  const startedAt = new Date();
  const run = await db.marketIngestion.create({
    data: {
      datasetId: HDX_DATASET_ID,
      resourceUrl: '',
      rowCount: 0,
      accepted: 0,
      skipped: 0,
      status: 'running',
      startedAt,
    },
  });

  try {
    const fetched = await fetchWfpUgandaPrices({
      signal: options.signal,
      correlationId: options.correlationId,
    });
    const data = fetched.rows.map((row) => ({
      sourceProvider: MARKET_SOURCE_PROVIDER,
      datasetId: HDX_DATASET_ID,
      countryCode: MARKET_COUNTRY_CODE,
      marketId: row.marketId,
      marketName: row.marketName,
      commodityId: row.commodityId,
      commodityName: row.commodityName,
      unit: row.unit,
      currency: row.currency,
      price: row.price,
      priceDate: row.priceDate,
      category: row.category,
      retrievedAt: fetched.retrievedAt,
    }));
    if (options.signal?.aborted) {
      const aborted = new Error('market ingestion aborted before persistence');
      aborted.name = 'AbortError';
      throw aborted;
    }
    // Persist the feed and its success record atomically: a failure part-way
    // through the natural-key upsert cannot publish a partial dataset under a
    // failed ingestion run.
    const { inserted, ingestion } = await db.$transaction(async (tx) => {
      const written = data.length > 0 ? await createManyIdempotent(tx.marketPrice, data) : 0;
      const skipped = fetched.counts.rowsRead - written;
      const record = await tx.marketIngestion.update({
        where: { id: run.id },
        data: {
          resourceUrl: fetched.resource.url,
          resourceUpdatedAt: fetched.resource.updatedAt,
          rowCount: fetched.counts.rowsRead,
          accepted: written,
          skipped,
          status: 'succeeded',
          finishedAt: new Date(),
          errorDetail: fetched.counts.truncated
            ? `row cap applied: retained the ${fetched.counts.accepted} most recent rows; ${fetched.counts.reasons.rowCap} older rows not stored`
            : null,
        },
      });
      return { inserted: written, ingestion: record };
    }, { maxWait: 10_000, timeout: 45_000 });

    const skipped = fetched.counts.rowsRead - inserted;
    return {
      ingestion: serializeIngestion(ingestion),
      counts: {
        ...fetched.counts,
        accepted: inserted,
        eligible: fetched.counts.accepted,
        inserted,
        alreadyStored: Math.max(0, fetched.counts.accepted - inserted),
        skipped,
      },
      dataset: fetched.dataset,
      resource: {
        name: fetched.resource.name,
        url: fetched.resource.url,
        updatedAt: iso(fetched.resource.updatedAt),
      },
      window: fetched.window,
      retrievedAt: fetched.retrievedAt.toISOString(),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown market ingestion failure';
    await db.marketIngestion.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        rowCount: 0,
        accepted: 0,
        skipped: 0,
        finishedAt: new Date(),
        errorDetail: detail.slice(0, 300),
      },
    }).catch(() => undefined);
    throw error;
  }
}
