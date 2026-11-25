'use client';

import * as THREE from 'three';
import type { SourcesLiveResponse } from '@/lib/api-client';
import type { useSourceSigns } from '@/components/system/source-signs';

type Event = SourcesLiveResponse['eonet']['events'][number];
export type LocatedEvent = Event & { lat: number; lon: number };

export function locatedEvents(events: Event[]): LocatedEvent[] {
  return events.filter((event): event is LocatedEvent =>
    typeof event.lat === 'number' && Number.isFinite(event.lat) && Math.abs(event.lat) <= 90 &&
    typeof event.lon === 'number' && Number.isFinite(event.lon) && Math.abs(event.lon) <= 180,
  );
}

export function eventPosition(lat: number, lon: number): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(-Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)).multiplyScalar(1.018);
}

/** A replaceable layer: shared GPU resources are disposed exactly once. */
export function createEventLayer() {
  const group = new THREE.Group();
  const geometry = new THREE.OctahedronGeometry(0.024);
  const material = new THREE.MeshBasicMaterial({ color: 0xffb454 });
  return {
    group,
    update(events: LocatedEvent[]) {
      group.clear();
      for (const event of events) {
        const marker = new THREE.Mesh(geometry, material);
        marker.position.copy(eventPosition(event.lat, event.lon));
        marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), marker.position.clone().normalize());
        group.add(marker);
      }
    },
    dispose() {
      group.removeFromParent();
      group.clear();
      geometry.dispose();
      material.dispose();
    },
  };
}

export function LiveGlobeEvents({ failed, query }: { failed: boolean; query: ReturnType<typeof useSourceSigns> }) {
  const { data, dataUpdatedAt, isPending, isError, isFetching, refetch } = query;
  const feed = data?.eonet;
  const events = feed?.ok ? locatedEvents(feed.events) : [];
  return (
    <details className="hud absolute right-2.5 top-2.5 z-20 max-h-[60%] max-w-[min(22rem,85%)] overflow-auto bg-void/95 px-3 py-2 font-mono text-[10px] text-dim">
      <summary className="cursor-pointer text-caution" aria-live="polite">
        NASA EONET · {isPending ? 'loading' : isError ? 'refresh failed · previous data' : !feed?.ok ? 'unavailable' : !feed.fresh ? 'STALE snapshot' : 'polled snapshot'} · {events.length} {failed ? 'listed' : 'mapped'}
      </summary>
      <p className="mt-2">Orange diamonds: open wildfire events · green: demo stations. Orbit and links are illustrative. Not per-pixel detections.</p>
      <p className="mt-1">Poll: 60 s · provider cache: up to 15 min · window: {feed?.days ?? '—'} days.</p>
      <p>Browser received: {dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : 'not yet'}. Provider retrieval time not supplied.</p>
      {feed && <p className="mt-1">{events.length} valid positions from {feed.events.length} returned / {feed.count} total events. {feed.note}</p>}
      {!isPending && !events.length && <p className="mt-1">{feed?.ok ? 'No mappable events in this response; this does not establish that no fires exist.' : 'No event positions available.'}</p>}
      {isError && <p className="mt-1 text-caution">Request failed; any retained positions are not a current refresh.</p>}
      {failed && <p className="mt-1 text-caution">3D unavailable; event details remain below.</p>}
      <button type="button" className="mt-2 text-aqua underline" disabled={isFetching} onClick={() => void refetch()}>{isFetching ? 'Checking…' : 'Retry / refresh'}</button>
      <ul className="mt-2 space-y-2">
        {events.map((event) => <li key={event.id}>
          <a className="text-caution underline" href={`https://eonet.gsfc.nasa.gov/api/v3/events/${encodeURIComponent(event.id)}`} target="_blank" rel="noreferrer">{event.title}</a>
          <p>{event.lat.toFixed(3)}°, {event.lon.toFixed(3)}° · source: {event.source ?? 'not supplied'}</p>
          <p>Reported geometry time: {event.startedAt ?? 'not supplied'} (not detection or retrieval time).</p>
        </li>)}
      </ul>
    </details>
  );
}