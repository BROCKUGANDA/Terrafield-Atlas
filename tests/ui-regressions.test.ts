import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCropHistory } from '@/components/views/farm-workspace';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('farm editor regressions', () => {
  test('malformed stored crop history cannot crash an editor', () => {
    expect(parseCropHistory('{bad json')).toEqual([]);
    expect(parseCropHistory('{"not":"an array"}')).toEqual([]);
    expect(parseCropHistory(JSON.stringify([null, { season: 1, crop: 'maize' }]))).toEqual([]);
  });

  test('valid crop history is bounded and normalized', () => {
    expect(parseCropHistory(JSON.stringify([{ season: '2025 long rains', crop: 'maize', family: 'Poaceae' }]))).toEqual([
      { season: '2025 long rains', crop: 'maize', family: 'Poaceae' },
    ]);
    const long = parseCropHistory(JSON.stringify([{ season: 'x'.repeat(500), crop: 'maize' }]));
    expect(long[0].season).toHaveLength(120);
  });

  test('crop and soil editors are keyed by farm id', () => {
    const farm = source('src/components/views/farm-workspace.tsx');
    expect(farm).toContain('key={`crop:${activeFarmId}`}');
    expect(farm).toContain('key={`soil:${activeFarmId}`}');
  });
});

describe('mobile and accessibility regressions', () => {
  test('wide source registry scrolls inside its own region', () => {
    const landing = source('src/components/views/landing.tsx');
    expect(landing).toContain('overflow-x-auto overflow-y-auto');
    expect(landing).toContain('aria-label="Data source registry table"');
  });

  test('day bars wrap and expose per-day text alternatives', () => {
    const fire = source('src/components/views/fire-watchlists.tsx');
    expect(fire).toContain('flex flex-wrap items-end gap-1');
    expect(fire).toContain('role="listitem"');
    expect(fire).toContain('qualifying`}');
  });

  test('map layers use a mobile bottom sheet instead of covering zoom controls', () => {
    const map = source('src/components/map/gibs-map.tsx');
    expect(map).toContain('aria-controls="map-layer-panel"');
    expect(map).toContain('bottom-3 left-3 right-3 top-auto');
    expect(map).toContain('sm:hidden');
  });

  test('coarse-pointer primary actions meet the 44px target floor', () => {
    const css = source('src/app/globals.css');
    expect(css).toContain('.console-shell main button');
    expect(css).toMatch(/min-height:\s*44px/);
  });

  test('global shortcuts yield to modal dialogs', () => {
    const hotkeys = source('src/hooks/use-console-hotkeys.ts');
    expect(hotkeys).toContain('document.querySelector(\'[role="dialog"][aria-modal="true"]\')');
  });

  test('guided tour traps Tab and restores focus', () => {
    const tour = source('src/components/system/guided-tour.tsx');
    expect(tour).toContain("if (e.key === 'Tab')");
    expect(tour).toContain('previous?.isConnected');
    expect(tour).toContain('last.focus()');
  });

  test('only one footer is visible on console surfaces', () => {
    expect(source('src/app/layout.tsx')).toContain('marketing-footer');
    expect(source('src/app/globals.css')).toContain('body:has(.console-shell) .marketing-footer');
  });
});
