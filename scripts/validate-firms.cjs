require('@next/env').loadEnvConfig(process.cwd());
(async () => {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) throw new Error('FIRMS key not configured');
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/-90,30,-88,32/1`;
  const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  const header = body.split(/\r?\n/, 1)[0].toLowerCase();
  console.log(JSON.stringify({ authenticatedRequest: true, httpStatus: response.status, keyAccepted: response.ok && header.includes('latitude') && header.includes('acq_date'), invalidKey: /invalid.*(?:key|map)/i.test(body), csvRows: header.includes('latitude') ? Math.max(0, body.trim().split(/\r?\n/).length - 1) : null }));
})().catch(error => { console.error(error.name === 'TimeoutError' ? 'FIRMS timed out' : 'FIRMS validation failed'); process.exitCode = 1; });