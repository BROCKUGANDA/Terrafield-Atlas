import { resilientFetch } from '@/lib/http';

/**
 * HDX / WFP Uganda food-price adapter.
 *
 * Provider:  United Nations OCHA Humanitarian Data Exchange (HDX) CKAN
 * Dataset:   wfp-food-prices-for-uganda — "Uganda - Food Prices"
 * Upstream:  WFP VAM, FIT Uganda and partners (FAO GIEWS/FPMA, Infotrade,
 *            RATIN, UBOS, UGCO, WFP UGCO) via HDX
 * Licence:   CC BY-IGO (Creative Commons Attribution for Intergovernmental
 *            Organisations)
 *
 * The CKAN package JSON is fetched first; the CSV resource with the latest
 * `last_modified` is then downloaded (HDX redirects the download to signed S3
 * object storage, so the transport follows validated public redirects while
 * provenance keeps only the stable HDX URL). Nothing is cached: an ingest
 * either stores what the provider actually returned or fails without rows.
 *
 * Honesty rules enforced here:
 * - only positive, finite prices inside the requested 24-month window;
 * - only Retail observations when the dataset labels price types (Retail and
 *   Wholesale must never be mixed in one natural-key series);
 * - missing identifiers fall back to a name slug, never to invented codes;
 * - malformed / short rows are counted and skipped, never repaired with zeros;
 * - the row cap is reported (`truncated`) instead of silently dropping rows.
 */

export const HDX_DATASET_ID = 'wfp-food-prices-for-uganda';
export const HDX_PACKAGE_URL = `https://data.humdata.org/api/3/action/package_show?id=${HDX_DATASET_ID}`;
export const MARKET_SOURCE_PROVIDER = 'HDX_WFP';
export const MARKET_COUNTRY_CODE = 'UGA';
export const MARKET_DATASET_NAME = 'Uganda - Food Prices';
export const MARKET_LICENCE = 'CC BY-IGO';
export const MARKET_ATTRIBUTION = 'WFP VAM / FIT Uganda via HDX (data.humdata.org)';
export const MARKET_SOURCE_URL = 'https://data.humdata.org/dataset/wfp-food-prices-for-uganda';
export const MARKET_DEFAULT_WINDOW_MONTHS = 24;
export const MARKET_MAX_ROWS = 50_000;

const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
const MAX_CSV_BYTES = 25 * 1024 * 1024;

export class MarketFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketFeedError';
  }
}

export interface HdxResource {
  id: string | null;
  name: string | null;
  url: string;
  updatedAt: Date | null;
}

export interface WfpPriceRow {
  marketId: string;
  marketName: string;
  commodityId: string;
  commodityName: string;
  unit: string;
  currency: string;
  price: number;
  priceDate: Date;
  category: string | null;
  admin1: string | null;
}

export type WfpSkipReason =
  | 'shortRow'
  | 'invalidDate'
  | 'outsideWindow'
  | 'invalidPrice'
  | 'missingFields'
  | 'priceType'
  | 'duplicate'
  | 'rowCap';

export type WfpSkipCounts = Record<WfpSkipReason, number>;

export interface WfpPriceCounts {
  /** Data rows read from the CSV (excluding the header). */
  rowsRead: number;
  /** Unique, valid, in-window rows passed to the database layer. */
  accepted: number;
  skipped: number;
  truncated: boolean;
  reasons: WfpSkipCounts;
}

export interface WfpPriceFetchResult {
  rows: WfpPriceRow[];
  counts: WfpPriceCounts;
  resource: HdxResource;
  dataset: { title: string; licence: string };
  window: { months: number; cutoff: string };
  retrievedAt: Date;
}

/** RFC 4180 parser: quoted fields, doubled quotes, CRLF/LF and embedded newlines. */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < input.length) {
    const char = input[index];
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      if (input[index + 1] === '\n') index += 1;
      endRow();
      index += 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (field.length > 0 || row.length > 0) endRow();
  // A trailing newline (or blank CRLF) is not a data row.
  return rows.filter((line) => line.length > 1 || (line[0] ?? '').trim().length > 0);
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\ufeff/, '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

type HeaderKey =
  | 'date' | 'admin1' | 'market' | 'marketId' | 'commodity' | 'commodityId'
  | 'unit' | 'currency' | 'price' | 'category' | 'priceType';

const HEADER_ALIASES: Record<HeaderKey, string[]> = {
  date: ['date', 'price_date', 'pricedate', 'observation_date'],
  admin1: ['admin1', 'admin_1', 'admin', 'region'],
  market: ['market', 'market_name', 'marketname'],
  marketId: ['market_id', 'marketid'],
  commodity: ['commodity', 'commodity_name', 'commodityname'],
  commodityId: ['commodity_id', 'commodityid'],
  unit: ['unit', 'unit_name', 'unitname'],
  currency: ['currency', 'currency_code', 'currencycode'],
  price: ['price', 'price_value', 'pricevalue'],
  category: ['category', 'commodity_category'],
  priceType: ['pricetype', 'price_type', 'pricetypename'],
};

function mapHeaders(header: string[]): Record<HeaderKey, number> {
  const normalized = header.map(normalizeHeader);
  const lookup = new Map<string, number>();
  normalized.forEach((name, index) => {
    if (name && !lookup.has(name)) lookup.set(name, index);
  });
  const result = {} as Record<HeaderKey, number>;
  for (const key of Object.keys(HEADER_ALIASES) as HeaderKey[]) {
    const found = HEADER_ALIASES[key].map((alias) => lookup.get(normalizeHeader(alias))).find((index) => index !== undefined);
    result[key] = found ?? -1;
  }
  return result;
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/** First day of the month `months - 1` months before `now` (inclusive window). */
export function marketWindowCutoff(now: Date, months = MARKET_DEFAULT_WINDOW_MONTHS): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
}

function naturalId(explicit: string, name: string, max: number): string {
  const direct = clip(explicit, max);
  if (direct) return direct;
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

function parsePrice(value: string): number | null {
  const cleaned = value.replace(/[,\s]/g, '');
  if (!cleaned) return null;
  const price = Number(cleaned);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export interface WfpParseOptions {
  now?: Date;
  months?: number;
  maxRows?: number;
}

export interface WfpParseResult {
  rows: WfpPriceRow[];
  counts: WfpPriceCounts;
  window: { months: number; cutoff: string };
}

/**
 * Pure, defensive CSV → rows mapping. Exported so the parser contract can be
 * tested without any network or database access.
 */
export function parseWfpCsv(text: string, options: WfpParseOptions = {}): WfpParseResult {
  const now = options.now ?? new Date();
  const months = Math.min(Math.max(options.months ?? MARKET_DEFAULT_WINDOW_MONTHS, 1), 120);
  const maxRows = Math.min(Math.max(options.maxRows ?? MARKET_MAX_ROWS, 1), 500_000);
  const cutoff = marketWindowCutoff(now, months);

  const table = parseCsv(text);
  if (table.length === 0) throw new MarketFeedError('HDX CSV response is empty');
  const header = mapHeaders(table[0]);
  const missing = (['date', 'price'] as HeaderKey[]).filter((key) => header[key] < 0);
  if (!header.market && !header.marketId) missing.push('market');
  if (!header.commodity && !header.commodityId) missing.push('commodity');
  if (header.unit < 0) missing.push('unit');
  if (header.currency < 0) missing.push('currency');
  if (missing.length > 0) {
    throw new MarketFeedError(`HDX CSV header is missing required columns: ${missing.join(', ')}`);
  }

  const reasons: WfpSkipCounts = {
    shortRow: 0, invalidDate: 0, outsideWindow: 0, invalidPrice: 0,
    missingFields: 0, priceType: 0, duplicate: 0, rowCap: 0,
  };
  const rowsRead = Math.max(0, table.length - 1);
  const byKey = new Map<string, WfpPriceRow>();
  const cell = (row: string[], index: number) => (index >= 0 ? row[index] ?? '' : '');

  for (let index = 1; index < table.length; index++) {
    const row = table[index];
    const widestRequired = Math.max(header.date, header.price, header.market, header.marketId, header.commodity, header.commodityId, header.unit, header.currency);
    if (row.length <= widestRequired) {
      reasons.shortRow += 1;
      continue;
    }

    if (header.priceType >= 0) {
      const priceType = normalizeHeader(cell(row, header.priceType));
      if (priceType && priceType !== 'retail') {
        reasons.priceType += 1;
        continue;
      }
    }

    const priceDate = parseDate(cell(row, header.date));
    if (!priceDate) {
      reasons.invalidDate += 1;
      continue;
    }
    if (priceDate.getTime() < cutoff.getTime()) {
      reasons.outsideWindow += 1;
      continue;
    }

    const price = parsePrice(cell(row, header.price));
    if (price === null) {
      reasons.invalidPrice += 1;
      continue;
    }

    const marketName = clip(cell(row, header.market), 200);
    const commodityName = clip(cell(row, header.commodity), 200);
    const marketId = naturalId(cell(row, header.marketId), marketName, 64);
    const commodityId = naturalId(cell(row, header.commodityId), commodityName, 64);
    const unit = clip(cell(row, header.unit), 32);
    const currency = clip(cell(row, header.currency), 8).toUpperCase();
    if (!marketId || !commodityId || !marketName || !commodityName || !unit || !currency) {
      reasons.missingFields += 1;
      continue;
    }

    const category = clip(cell(row, header.category), 120) || null;
    const admin1 = clip(cell(row, header.admin1), 120) || null;
    const key = [marketId, commodityId, priceDate.toISOString().slice(0, 10), unit, currency].join('|');
    if (byKey.has(key)) {
      reasons.duplicate += 1;
      continue;
    }
    byKey.set(key, {
      marketId, marketName, commodityId, commodityName, unit, currency,
      price, priceDate, category, admin1,
    });
  }

  // Keep the most recent unique observations when a feed exceeds the cap.
  const unique = [...byKey.values()].sort((a, b) => b.priceDate.getTime() - a.priceDate.getTime());
  const truncated = unique.length > maxRows;
  const kept = unique.slice(0, maxRows);
  reasons.rowCap = unique.length - kept.length;
  kept.sort((a, b) => a.priceDate.getTime() - b.priceDate.getTime() || a.marketId.localeCompare(b.marketId));
  const skipped = Object.values(reasons).reduce((sum, count) => sum + count, 0);

  return {
    rows: kept,
    counts: { rowsRead, accepted: kept.length, skipped, truncated, reasons },
    window: { months, cutoff: cutoff.toISOString().slice(0, 10) },
  };
}

interface HdxPackageResource {
  id?: unknown;
  name?: unknown;
  format?: unknown;
  url?: unknown;
  last_modified?: unknown;
  created?: unknown;
}

interface CsvCandidate extends HdxPackageResource {
  url: string;
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

function resourceTimestamp(resource: HdxPackageResource): number {
  for (const value of [resource.last_modified, resource.created]) {
    if (typeof value === 'string') {
      // CKAN `last_modified` values are UTC but frequently omit the zone
      // designator; Date.parse would otherwise read them in the server's
      // local timezone and shift provenance timestamps.
      const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim()) ? value.trim() : `${value.trim()}Z`;
      const parsed = Date.parse(zoned);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

/** Select the CSV resource with the latest modification timestamp. */
export function pickLatestCsvResource(packageJson: unknown): HdxResource {
  const result = field(packageJson, 'result');
  const resources = field(result, 'resources');
  if (!Array.isArray(resources)) throw new MarketFeedError('HDX package response has no resource list');

  const csv = resources
    .filter((resource): resource is HdxPackageResource => Boolean(resource) && typeof resource === 'object')
    .filter((resource): resource is CsvCandidate => typeof resource.url === 'string'
      && (String(resource.format ?? '').toLowerCase() === 'csv' || /\.csv(\?|$)/i.test(resource.url)));
  if (csv.length === 0) {
    throw new MarketFeedError('HDX package contains no CSV resource; refusing to ingest another format');
  }

  const latest = [...csv].sort((a, b) => resourceTimestamp(b) - resourceTimestamp(a))[0];
  return {
    id: typeof latest.id === 'string' ? latest.id : null,
    name: typeof latest.name === 'string' ? latest.name : null,
    url: latest.url,
    updatedAt: resourceTimestamp(latest) > 0 ? new Date(resourceTimestamp(latest)) : null,
  };
}

export interface FetchWfpOptions {
  now?: Date;
  months?: number;
  maxRows?: number;
  signal?: AbortSignal;
  correlationId?: string;
}

/** Download and map the latest HDX Uganda food-price CSV. Throws on any failure. */
export async function fetchWfpUgandaPrices(options: FetchWfpOptions = {}): Promise<WfpPriceFetchResult> {
  const now = options.now ?? new Date();
  const packageOutcome = await resilientFetch(HDX_PACKAGE_URL, {
    provider: 'HDX',
    datasetId: HDX_DATASET_ID,
    operation: 'ckan-package-show',
    timeoutMs: 20_000,
    maxAttempts: 3,
    maxResponseBytes: MAX_PACKAGE_BYTES,
    signal: options.signal,
    correlationId: options.correlationId,
  });
  if (!packageOutcome.ok) {
    throw new MarketFeedError(`HDX package request failed with HTTP ${packageOutcome.status}`);
  }
  if (packageOutcome.body.byteLength > MAX_PACKAGE_BYTES) {
    throw new MarketFeedError(`HDX package response exceeds ${MAX_PACKAGE_BYTES} bytes`);
  }

  let packageJson: unknown;
  try {
    packageJson = JSON.parse(new TextDecoder().decode(packageOutcome.body));
  } catch {
    throw new MarketFeedError('HDX package response is not valid JSON');
  }
  if (field(packageJson, 'success') === false) {
    throw new MarketFeedError('HDX package request was rejected by the CKAN API');
  }

  const resource = pickLatestCsvResource(packageJson);
  const csvOutcome = await resilientFetch(resource.url, {
    provider: 'HDX',
    datasetId: HDX_DATASET_ID,
    operation: 'csv-download',
    timeoutMs: 45_000,
    maxAttempts: 3,
    maxResponseBytes: MAX_CSV_BYTES,
    signal: options.signal,
    correlationId: options.correlationId,
    followRedirects: true,
  });
  if (!csvOutcome.ok) {
    throw new MarketFeedError(`HDX CSV download failed with HTTP ${csvOutcome.status}`);
  }
  if (csvOutcome.body.byteLength > MAX_CSV_BYTES) {
    throw new MarketFeedError(`HDX CSV response exceeds ${MAX_CSV_BYTES} bytes`);
  }

  const parsed = parseWfpCsv(new TextDecoder().decode(csvOutcome.body), {
    now,
    months: options.months,
    maxRows: options.maxRows,
  });

  const result = field(packageJson, 'result');
  const titleValue = field(result, 'title');
  const licenceValue = field(result, 'license_title');
  const licenceIdValue = field(result, 'license_id');
  const title = typeof titleValue === 'string' ? titleValue : MARKET_DATASET_NAME;
  const licence = typeof licenceValue === 'string'
    ? licenceValue
    : typeof licenceIdValue === 'string' ? licenceIdValue : MARKET_LICENCE;

  return {
    rows: parsed.rows,
    counts: parsed.counts,
    resource,
    dataset: { title, licence },
    window: parsed.window,
    retrievedAt: new Date(),
  };
}
