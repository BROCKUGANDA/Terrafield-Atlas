import { describe, expect, test } from 'bun:test';
import { stacGeometrySchema } from '@/lib/adapters/stac';

describe('STAC GeoJSON validation', () => {
  test('accepts a closed, bounded polygon', () => {
    expect(stacGeometrySchema.safeParse({
      type: 'Polygon',
      coordinates: [[[32.5, 0.2], [32.6, 0.2], [32.6, 0.3], [32.5, 0.2]]],
    }).success).toBe(true);
  });

  test('rejects empty, unclosed, out-of-range and malformed geometries', () => {
    const invalid = [
      { type: 'Polygon', coordinates: [] },
      { type: 'Polygon', coordinates: [[]] },
      { type: 'Polygon', coordinates: [[[32.5, 0.2], [32.6, 0.2], [32.6, 0.3], [32.7, 0.4]]] },
      { type: 'Polygon', coordinates: [[[181, 0.2], [32.6, 0.2], [32.6, 91], [181, 0.2]]] },
      { type: 'Polygon', coordinates: [[[32.5, 0.2], [32.6, 0.2], [32.5, 0.2]]] },
      { type: 'Polygon', coordinates: [[[32.5, 0.2], [32.6, 0.2], [32.6, 0.3], [32.5, 0.2]], []] },
      { type: 'MultiPolygon', coordinates: [[[[32.5, 0.2], [32.6, 0.2], [32.6, 0.3], [32.5, 0.2]]], []] },
    ];
    for (const geometry of invalid) expect(stacGeometrySchema.safeParse(geometry).success, JSON.stringify(geometry)).toBe(false);
  });
});
