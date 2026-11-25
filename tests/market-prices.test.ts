import { expect, test } from 'bun:test';
import { db } from '@/lib/db';
import {
  fetchWfpUgandaPrices,
  pickLatestCsvResource,
  parseWfpCsv,
} from '@/lib/adapters/marketPrices';
import { aggregateMonthlyPrices } from '@/lib/markets';
import { createFetchMock } from './fetch-mock';

/**
 * Market-price contracts: the CSV parser must survive real WFP/HDX quirks,
 * aggregation must be median-first, and a package with no CSV resource must be
 * rejected instead of ingesting some other file.
 */

const NOW = new Date('2026-11-25T00:00:00.000Z');
const HEADER = 'date,admin1,market,market_id,commodity,commodity_id,unit,pricetype,currency,price,category\r\n';

test('CSV parser handles quoted commas, doubled quotes, CRLF and short rows', () => {
  const csv = HEADER
    + '2026-01-15,Kampala,"Owino, Central",258,Maize,51,KG,Retail,UGX,"1,200.50",cereals and tubers\r\n'
    + '2026-02-15,Kampala,"Owino ""Main"" Market",258,Maize,51,KG,Retail,UGX,1300,cereals and tubers\r\n'
    + '2026-02-15,Kampala,Owino,258\r\n'
    + '2026-02-15,Kampala,Owino,258,Maize,51,KG,Wholesale,UGX,900,cereals and tubers\r\n';

  const parsed = parseWfpCsv(csv, { now: NOW });

  expect(parsed.rows).toHaveLength(2);
  expect(parsed.rows[0].marketName).toBe('Owino, Central');
  expect(parsed.rows[0].price).toBe(1200.5);
  expect(parsed.rows[1].marketName).toBe('Owino "Main" Market');
  expect(parsed.rows[1].priceDate.toISOString()).toBe('2026-02-15T00:00:00.000Z');
  expect(parsed.counts.rowsRead).toBe(4);
  expect(parsed.counts.accepted).toBe(2);
  expect(parsed.counts.skipped).toBe(2);
  expect(parsed.counts.reasons.shortRow).toBe(1);
  expect(parsed.counts.reasons.priceType).toBe(1);
});

test('CSV parser keeps only the most recent 24 months and positive prices', () => {
  const csv = HEADER
    + '2024-11-15,Kampala,Owino,258,Maize,51,KG,Retail,UGX,1000,cereals\r\n'
    + '2024-12-15,Kampala,Owino,258,Maize,51,KG,Retail,UGX,1100,cereals\r\n'
    + '2026-03-15,Kampala,Owino,258,Maize,51,KG,Retail,UGX,0,cereals\r\n'
    + '2026-03-15,Kampala,Owino,258,Maize,51,KG,Retail,UGX,-5,cereals\r\n'
    + '2026-03-15,Kampala,Owino,258,Maize,51,KG,Retail,UGX,not-a-number,cereals\r\n';

  const parsed = parseWfpCsv(csv, { now: NOW });

  expect(parsed.rows.map((row) => row.price)).toEqual([1100]);
  expect(parsed.counts.reasons.outsideWindow).toBe(1);
  expect(parsed.counts.reasons.invalidPrice).toBe(3);
});

test('aggregation returns monthly median, min, max and sample count', () => {
  const series = aggregateMonthlyPrices([
    { priceDate: new Date('2026-01-05T00:00:00.000Z'), price: 10 },
    { priceDate: new Date('2026-01-20T00:00:00.000Z'), price: 20 },
    { priceDate: new Date('2026-01-28T00:00:00.000Z'), price: 100 },
    { priceDate: new Date('2026-02-02T00:00:00.000Z'), price: 5 },
    { priceDate: new Date('2026-02-03T00:00:00.000Z'), price: 15 },
  ]);

  expect(series).toEqual([
    { month: '2026-01', median: 20, min: 10, max: 100, sampleCount: 3 },
    { month: '2026-02', median: 10, min: 5, max: 15, sampleCount: 2 },
  ]);
});

test('resource selection picks the latest CSV and never a non-CSV file', () => {
  const resource = pickLatestCsvResource({
    success: true,
    result: {
      title: 'Uganda - Food Prices',
      resources: [
        { id: 'a', name: 'older', format: 'CSV', url: 'https://data.humdata.org/a.csv', last_modified: '2026-01-01T00:00:00' },
        { id: 'b', name: 'newer', format: 'CSV', url: 'https://data.humdata.org/b.csv', last_modified: '2026-11-15T09:32:46' },
        { id: 'c', name: 'metadata', format: 'JSON', url: 'https://data.humdata.org/c.json', last_modified: '2026-12-01T00:00:00' },
      ],
    },
  });

  expect(resource.id).toBe('b');
  expect(resource.url).toBe('https://data.humdata.org/b.csv');
});

test('a dataset with no CSV resource is rejected before any download', async () => {
  const original = globalThis.fetch;
  const originalCreate = db.apiRequestLog.create;
  let calls = 0;
  db.apiRequestLog.create = (async () => ({})) as unknown as typeof originalCreate;
  globalThis.fetch = createFetchMock(async () => {
    calls += 1;
    return new Response(JSON.stringify({
      success: true,
      result: {
        title: 'Uganda - Food Prices',
        resources: [
          { id: 'json', name: 'metadata', format: 'JSON', url: 'https://data.humdata.org/package.json', last_modified: '2026-11-15T00:00:00' },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  try {
    await expect(fetchWfpUgandaPrices({ now: NOW })).rejects.toThrow(/no CSV resource/);
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = original;
    db.apiRequestLog.create = originalCreate;
  }
});
