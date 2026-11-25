import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { createEventLayer, eventPosition, locatedEvents } from './live-globe-events';

const event = { id: 'test', title: 'Test fixture', lat: 0, lon: 0, source: null, startedAt: null };

describe('live globe event layer', () => {
  test('rejects missing, nonfinite and out-of-range positions without treating zero as absent', () => {
    expect(locatedEvents([
      event, { ...event, lat: null }, { ...event, lon: null },
      { ...event, lat: NaN }, { ...event, lon: Infinity },
      { ...event, lat: 91 }, { ...event, lon: -181 },
      { ...event, lat: -90, lon: 180 },
    ])).toHaveLength(2);
  });

  test('matches globe orientation at cardinal coordinates and the poles', () => {
    for (const [lat, lon, expected] of [
      [0, 0, [1.018, 0, 0]], [0, 90, [0, 0, -1.018]],
      [0, -90, [0, 0, 1.018]], [90, 0, [0, 1.018, 0]],
      [-90, 180, [0, -1.018, 0]], [0, 180, [-1.018, 0, 0]],
    ] as const) {
      expect(eventPosition(lat, lon).distanceTo(new THREE.Vector3(...expected))).toBeLessThan(1e-10);
    }
  });

  test('replaces markers, clears empty responses and releases shared resources once', () => {
    const layer = createEventLayer();
    const parent = new THREE.Group();
    parent.add(layer.group);
    layer.update([event]);
    const mesh = layer.group.children[0] as THREE.Mesh;
    let geometriesDisposed = 0;
    let materialsDisposed = 0;
    mesh.geometry.addEventListener('dispose', () => geometriesDisposed++);
    (mesh.material as THREE.Material).addEventListener('dispose', () => materialsDisposed++);
    layer.update([{ ...event, lat: 45 }, { ...event, lon: -120 }]);
    expect(layer.group.children).toHaveLength(2);
    expect((layer.group.children[0] as THREE.Mesh).geometry).toBe(mesh.geometry);
    layer.update([]);
    expect(layer.group.children).toHaveLength(0);
    layer.dispose();
    expect(parent.children).toHaveLength(0);
    expect(geometriesDisposed).toBe(1);
    expect(materialsDisposed).toBe(1);
  });
});