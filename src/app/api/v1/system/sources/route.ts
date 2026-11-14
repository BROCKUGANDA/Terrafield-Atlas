import { apiHandler, jsonResponse } from '@/lib/api/helpers';
import { sourceSigns } from '@/lib/source-health';
import { fetchEonetWildfires } from '@/lib/adapters/eonet';

/**
 * GET /api/v1/system/sources — LIVE data-source signs + wildfire-event context.
 *
 * This is the endpoint the console's source-sign chips poll (60 s): it runs
 * real reachability probes against every upstream (FIRMS host, the FIRMS
 * detection stream via GIBS, EONET, GIBS, POWER, SoilGrids) and reports
 * state + latency for each, alongside the latest NASA EONET open wildfire
 * events. `?force=1` bypasses the 60 s probe cache.
 */

export const GET = apiHandler(async (req, { correlationId }) => {
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';
  const signs = await sourceSigns(force);
  const eonet = await fetchEonetWildfires({ days: 10, correlationId });
  return jsonResponse(
    {
      checkedAt: signs.checkedAt,
      probeMs: signs.probeMs,
      signs: signs.signs,
      summary: signs.summary,
      eonet: {
        ok: eonet.ok,
        fresh: eonet.fresh,
        staleMs: eonet.staleMs,
        days: eonet.days,
        count: eonet.events.length,
        events: eonet.events.slice(0, 12),
        note: eonet.note,
      },
      note: signs.note,
      correlationId,
    },
    { correlationId },
  );
});
