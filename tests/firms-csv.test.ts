import { expect, test } from 'bun:test';
import { parseFirmsCsv } from '@/lib/adapters/firms';

const header = 'latitude,longitude,acq_date,acq_time,satellite,instrument,confidence,daynight,frp,bright_ti4';
test('FIRMS rejects non-CSV success pages instead of claiming no detections', () => {
  expect(() => parseFirmsCsv('<html>Temporarily unavailable</html>')).toThrow('valid CSV header');
  expect(parseFirmsCsv('Invalid MAP_KEY').invalidKey).toBe(true);
  expect(parseFirmsCsv(header).rows).toHaveLength(0);
});
test('FIRMS preserves missing numeric fields and valid zeros, rejecting invalid positions', () => {
  const { rows } = parseFirmsCsv(`${header}\n0,0,2026-11-18,0000,N,VIIRS,n,D,,\n1,2,2026-11-18,1200,N,VIIRS,h,D,0,0\n91,2,2026-11-18,1200,N,VIIRS,h,D,1,1\n,2,2026-11-18,1200,N,VIIRS,h,D,1,1`);
  expect(rows).toHaveLength(2);
  expect(rows[0].latitude).toBe(0);
  expect(rows[0].frp).toBeNull();
  expect(rows[1].frp).toBe(0);
  expect(rows[1].brightTi4).toBe(0);
});