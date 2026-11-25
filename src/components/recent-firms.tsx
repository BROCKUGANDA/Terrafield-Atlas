'use client';

import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/components/state/store';
import type { FirmsFetchResult } from '@/lib/adapters/firms';

type RecentFeed = FirmsFetchResult & { retrievedAt: string; window: string };

export function RecentFirms() {
  const { location, setFireDetectionsGeoJson, setView } = useSession();
  const query = useQuery({
    queryKey: ['firms-recent', location.lat, location.lon], enabled: false,
    queryFn: async ({ signal }): Promise<RecentFeed> => {
      const response = await fetch(`/api/v1/fires/recent?lat=${location.lat}&lon=${location.lon}`, { signal });
      if (!response.ok) throw new Error('Recent FIRMS feed unavailable; historical GIBS ingestion remains separate.');
      return response.json();
    },
  });
  return (
    <section className="rounded border border-edge bg-panel p-4 sm:p-6" aria-label="Recent authenticated FIRMS feed">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-lg font-semibold">Recent FIRMS observations</h2><p className="mt-1 text-xs text-muted-foreground">Provider’s latest 24-hour product. Separate from historical archive coverage; not an emergency warning.</p></div>
        <button type="button" className="min-h-11 rounded border border-edge px-4 text-xs" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? 'Contacting NASA…' : 'Fetch recent FIRMS'}</button>
      </div>
      {query.isError && <p role="alert" className="mt-4 text-sm text-caution">{query.error.message} Any previously returned rows below are not a successful refresh.</p>}
      {query.data && <div className="mt-4 space-y-3 text-xs">
        <p>{query.data.rows.length} observations returned · source: {query.data.served} · retrieved {query.data.retrievedAt}</p>
        <p className="text-muted-foreground">{query.data.note}</p>
        {!query.data.rows.length && <p>No rows returned in this request. This does not establish that no fires exist.</p>}
        {!!query.data.rows.length && <>
          <button type="button" className="min-h-11 rounded border border-edge px-4" onClick={() => {
            setFireDetectionsGeoJson({ type: 'FeatureCollection', features: query.data.rows.map(row => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] }, properties: { source: query.data.served, confidence: row.confidence, date: row.acqDate, frp: row.frp } })) });
            setView('explorer');
          }}>Map recent observations</button>
          <div className="max-h-64 overflow-auto"><table className="w-full text-left"><caption className="sr-only">First 20 recent FIRMS observations</caption><thead><tr><th className="p-2">UTC observation</th><th className="p-2">Position</th><th className="p-2">FRP (MW)</th></tr></thead><tbody>{query.data.rows.slice(0, 20).map((row, index) => <tr key={index} className="border-t border-edge"><td className="p-2">{row.acqDate} {row.acqTime}</td><td className="p-2">{row.latitude.toFixed(3)}, {row.longitude.toFixed(3)}</td><td className="p-2">{row.frp ?? 'not supplied'}</td></tr>)}</tbody></table></div>
        </>}
      </div>}
    </section>
  );
}